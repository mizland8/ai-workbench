// Workbench's private helper: configuration and API token arrive only on stdin.
package main

import (
	"aiworkbench/network/netcore"
	"bufio"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	var config struct {
		Dir        string `json:"dir"`
		Name       string `json:"name"`
		ControlURL string `json:"controlUrl"`
		Token      string `json:"token"`
		Port       int    `json:"port"`
	}
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 65536)).Decode(&config); err != nil || len(config.Token) < 32 {
		fmt.Fprintln(os.Stderr, "Invalid private network configuration")
		os.Exit(1)
	}
	if err := netcore.Start(config.Dir, config.Name, config.ControlURL); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer netcore.Stop()
	if config.Port > 0 {
		if err := netcore.Forward(config.Port); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(1)
	}
	// The address is public process metadata; the API secret is never printed.
	json.NewEncoder(os.Stdout).Encode(map[string]string{"address": listener.Addr().String()})
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+config.Token)) != 1 {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":"Unauthorized"}`)
			return
		}
		var value string
		var err error
		switch {
		case r.Method == "GET" && r.URL.Path == "/licenses":
			encoded, _ := json.Marshal(map[string]string{"text": netcore.Notices()})
			value = string(encoded)
		case r.Method == "GET" && r.URL.Path == "/status":
			value, err = netcore.Status()
		case r.Method == "POST" && r.URL.Path == "/login":
			err = netcore.Login()
			value = `{"requested":true}`
		case r.Method == "POST" && r.URL.Path == "/forward":
			var config struct {
				Port int `json:"port"`
			}
			err = json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&config)
			if err == nil {
				err = netcore.Forward(config.Port)
			}
			value = `{"updated":true}`
		case r.Method == "POST" && r.URL.Path == "/logout":
			err = netcore.Logout()
			value = `{"signedOut":true}`
		case r.Method == "POST" && r.URL.Path == "/request":
			var body []byte
			body, err = io.ReadAll(io.LimitReader(r.Body, 131073))
			if len(body) > 131072 {
				err = fmt.Errorf("Request too large")
			}
			if err == nil {
				value, err = netcore.Request(string(body))
			}
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"Unknown endpoint"}`)
			return
		}
		if err != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		io.WriteString(w, value)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 40 * time.Second, MaxHeaderBytes: 8192}
	// Parent exit closes stdin, which shuts down networking even after an unexpected desktop exit.
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
		}
		server.Close()
		netcore.Stop()
		os.Exit(0)
	}()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		os.Exit(1)
	}
}
