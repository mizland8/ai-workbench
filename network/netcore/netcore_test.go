package netcore

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"net/http/httptest"
	"testing"
)

func TestPairedCertificateIsRequired(t *testing.T) {
	a := httptest.NewTLSServer(nil)
	defer a.Close()
	b := httptest.NewTLSServer(nil)
	defer b.Close()
	cert := a.Certificate()
	config := pinnedTLS(cert.Raw)
	if err := config.VerifyConnection(tls.ConnectionState{PeerCertificates: []*x509.Certificate{cert}}); err != nil {
		t.Fatal(err)
	}
	if err := config.VerifyConnection(tls.ConnectionState{}); err == nil {
		t.Fatal("accepted no certificate")
	}
	changed := *cert
	changed.Raw = append([]byte(nil), cert.Raw...)
	changed.Raw[0] ^= 1
	if err := config.VerifyConnection(tls.ConnectionState{PeerCertificates: []*x509.Certificate{&changed}}); err == nil {
		t.Fatal("accepted a different certificate")
	}
}
func TestRequestsCannotBecomeAnOpenProxy(t *testing.T) {
	for _, c := range []call{{Host: "example.com/path", Port: 443, Endpoint: "snapshot", Cert: "00"}, {Host: "pc", Port: 0, Endpoint: "snapshot", Cert: "00"}, {Host: "pc", Port: 443, Endpoint: "admin", Cert: "00"}, {Host: "pc", Port: 443, Endpoint: "snapshot?since=1&other=2", Cert: "00"}, {Host: "pc", Port: 443, Endpoint: "message", Cert: "00", Token: "a\r\nheader"}} {
		if _, err := validate(c); err == nil {
			t.Fatal("accepted invalid destination")
		}
	}
	if _, err := validate(call{Host: "workbench-pc.example.ts.net", Port: 47931, Endpoint: "snapshot?since=12", Cert: hex.EncodeToString([]byte{1, 2})}); err != nil {
		t.Fatal(err)
	}
}
func TestInvalidNamesCannotStartNetwork(t *testing.T) {
	for _, name := range []string{"", "pc/name", "pc.example", "pc name"} {
		if err := Start(t.TempDir(), name, ""); err == nil {
			t.Fatal("accepted invalid name")
		}
	}
}
