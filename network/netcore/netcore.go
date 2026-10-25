// Package netcore embeds app-scoped Tailscale networking. It installs no VPN interface
// and carries only Workbench traffic; the companion's pinned TLS and pairing remain required.
package netcore

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

var state struct {
	sync.Mutex
	server   *tsnet.Server
	listener net.Listener
	port     int
	name     string
}
var hostname = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$`)
var endpoint = regexp.MustCompile(`^(pair|message|snapshot(\?since=[0-9]+)?)$`)

// Start creates an independent, persistent node owned by this application.
func Start(dir, name, controlURL string) error {
	if dir == "" || !hostname.MatchString(name) || strings.Contains(name, ".") {
		return errors.New("Choose a device name using letters, digits and hyphens")
	}
	if controlURL != "" && !strings.HasPrefix(controlURL, "https://") {
		return errors.New("Coordination server must use HTTPS")
	}
	state.Lock()
	defer state.Unlock()
	if state.server != nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := preparePlatform(dir); err != nil {
		return err
	}
	server := &tsnet.Server{Dir: dir, Hostname: name, ControlURL: controlURL, UserLogf: func(string, ...any) {}, Logf: func(string, ...any) {}}
	if err := server.Start(); err != nil {
		server.Close()
		return err
	}
	state.server = server
	state.name = name
	return nil
}
func server() (*tsnet.Server, error) {
	state.Lock()
	defer state.Unlock()
	if state.server == nil {
		return nil, errors.New("Enable built-in remote access and sign in first")
	}
	return state.server, nil
}

// Stop disconnects the app node but preserves its device identity for the next start.
func Stop() error {
	state.Lock()
	s := state.server
	l := state.listener
	state.server = nil
	state.listener = nil
	state.port = 0
	state.Unlock()
	if l != nil {
		l.Close()
	}
	if s != nil {
		return s.Close()
	}
	return nil
}
func Login() error {
	s, err := server()
	if err != nil {
		return err
	}
	lc, err := s.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return lc.StartLoginInteractive(ctx)
}
func Logout() error {
	s, err := server()
	if err != nil {
		return err
	}
	lc, err := s.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return lc.Logout(ctx)
}

// Status returns public node metadata and the interactive login URL, never private keys.
func Status() (string, error) {
	s, err := server()
	if err != nil {
		return `{"enabled":false}`, nil
	}
	lc, err := s.LocalClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := lc.Status(ctx)
	if err != nil {
		return "", err
	}
	type peer struct {
		Name   string `json:"name"`
		Host   string `json:"host"`
		Online bool   `json:"online"`
	}
	peers := []peer{}
	for _, p := range st.Peer {
		if !strings.HasPrefix(p.HostName, "workbench-") {
			continue
		}
		host := strings.TrimSuffix(p.DNSName, ".")
		if host == "" && len(p.TailscaleIPs) > 0 {
			host = p.TailscaleIPs[0].String()
		}
		peers = append(peers, peer{p.HostName, host, p.Online})
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].Name < peers[j].Name })
	host := ""
	if st.Self != nil {
		host = strings.TrimSuffix(st.Self.DNSName, ".")
	}
	if host == "" {
		for _, ip := range st.TailscaleIPs {
			if ip.Is4() {
				host = ip.String()
				break
			}
		}
	}
	state.Lock()
	port := state.port
	name := state.name
	state.Unlock()
	out, err := json.Marshal(map[string]any{"enabled": true, "state": st.BackendState, "authUrl": st.AuthURL, "host": host, "name": name, "port": port, "peers": peers, "health": st.Health, "systemVpn": st.TUN})
	return string(out), err
}

// Forward exposes only the desktop's loopback TLS companion port inside this tailnet.
func Forward(port int) error {
	if port < 0 || port > 65535 {
		return errors.New("Invalid companion port")
	}
	s, err := server()
	if err != nil {
		return err
	}
	state.Lock()
	defer state.Unlock()
	if port == 0 {
		if state.listener != nil {
			state.listener.Close()
		}
		state.listener = nil
		state.port = 0
		return nil
	}
	if state.listener != nil {
		if state.port == port {
			return nil
		}
		return errors.New("Disable remote access before changing the companion port")
	}
	listener, err := s.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		return err
	}
	state.listener = listener
	state.port = port
	go forward(listener, port)
	return nil
}
func forward(listener net.Listener, port int) {
	slots := make(chan struct{}, 32)
	for {
		incoming, err := listener.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
		default:
			incoming.Close()
			continue
		}
		go func() {
			defer func() { <-slots }()
			defer incoming.Close()
			local, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
			if err != nil {
				return
			}
			defer local.Close()
			// Bound abandoned sessions without interfering with 20-second snapshot waits.
			deadline := time.Now().Add(45 * time.Second)
			incoming.SetDeadline(deadline)
			local.SetDeadline(deadline)
			done := make(chan struct{})
			go func() {
				io.Copy(local, incoming)
				if c, ok := local.(*net.TCPConn); ok {
					c.CloseWrite()
				}
				close(done)
			}()
			io.Copy(incoming, local)
			incoming.Close()
			<-done
		}()
	}
}

type call struct {
	Host     string          `json:"host"`
	Port     int             `json:"port"`
	Cert     string          `json:"cert"`
	Token    string          `json:"token"`
	Endpoint string          `json:"endpoint"`
	Body     json.RawMessage `json:"body"`
}

func validate(c call) ([]byte, error) {
	if !hostname.MatchString(c.Host) || c.Port < 1 || c.Port > 65535 || !endpoint.MatchString(c.Endpoint) {
		return nil, errors.New("Invalid Workbench destination")
	}
	if len(c.Cert) > 32768 {
		return nil, errors.New("Certificate too large")
	}
	cert, err := hex.DecodeString(c.Cert)
	if err != nil || len(cert) == 0 {
		return nil, errors.New("Invalid paired certificate")
	}
	if len(c.Token) > 256 || strings.ContainsAny(c.Token, "\r\n") {
		return nil, errors.New("Invalid credential")
	}
	if len(c.Body) > 65536 {
		return nil, errors.New("Message is too large")
	}
	return cert, nil
}
func pinnedTLS(expected []byte) *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, // Exact pinned leaf verification replaces public-CA hostname trust.
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 || subtle.ConstantTimeCompare(cs.PeerCertificates[0].Raw, expected) != 1 {
				return errors.New("Computer certificate changed; pair it again")
			}
			cert := cs.PeerCertificates[0]
			now := time.Now()
			if now.Before(cert.NotBefore) || now.After(cert.NotAfter) {
				return errors.New("Computer certificate has expired or is not yet valid")
			}
			return nil
		}}
}

// Request performs one pinned HTTPS request using only this app's embedded network.
func Request(encoded string) (string, error) {
	var c call
	if err := json.Unmarshal([]byte(encoded), &c); err != nil {
		return "", errors.New("Invalid remote request")
	}
	expected, err := validate(c)
	if err != nil {
		return "", err
	}
	if _, err = x509.ParseCertificate(expected); err != nil {
		return "", errors.New("Invalid paired certificate")
	}
	s, err := server()
	if err != nil {
		return "", err
	}
	transport := &http.Transport{DialContext: s.Dial, TLSClientConfig: pinnedTLS(expected), DisableKeepAlives: true, ForceAttemptHTTP2: false}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Workbench redirects are not allowed") }}
	method := "GET"
	var body io.Reader
	if len(c.Body) > 0 && string(c.Body) != "null" {
		method = "POST"
		body = bytes.NewReader(c.Body)
	}
	req, err := http.NewRequest(method, "https://"+net.JoinHostPort(c.Host, strconv.Itoa(c.Port))+"/"+c.Endpoint, body)
	if err != nil {
		return "", err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	value, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
	if err != nil {
		return "", err
	}
	if len(value) > 8*1024*1024 {
		return "", errors.New("Snapshot too large")
	}
	if !json.Valid(value) {
		return "", errors.New("Invalid response from Workbench")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var fail struct {
			Error string `json:"error"`
		}
		json.Unmarshal(value, &fail)
		if fail.Error == "" {
			fail.Error = fmt.Sprintf("Computer returned HTTP %d", response.StatusCode)
		}
		return "", errors.New(fail.Error)
	}
	return string(value), nil
}

//go:embed notices.txt
var notices string

// Notices returns the licenses shipped with this networking library.
func Notices() string { return notices }
