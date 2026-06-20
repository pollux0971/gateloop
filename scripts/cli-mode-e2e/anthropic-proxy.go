// Static HTTP CONNECT forward-proxy (STORY-034.5 Layer-1 hardening).
//
// Allowlist is EXACTLY api.anthropic.com. Runs as a container straddling a no-gateway
// `--internal` cage network (where the cage reaches it) and a network with external route
// (so it can reach Anthropic). The cage has NO other egress, so the proxy is the only way
// out — and it refuses every host except the allowlist. Built CGO-free → a static binary
// in a FROM-scratch image (no pull). It tunnels TLS via CONNECT, so it never sees the token.
package main

import (
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

var allow = map[string]bool{
	"api.anthropic.com:443": true,
	"api.anthropic.com:80":  true,
}

func handleConnect(w http.ResponseWriter, r *http.Request) {
	if !allow[r.Host] {
		log.Printf("CONNECT %s -> DENIED (not on allowlist api.anthropic.com)", r.Host)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	dest, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
	if err != nil {
		log.Printf("CONNECT %s -> upstream error: %v", r.Host, err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	log.Printf("CONNECT %s -> ALLOWED", r.Host)
	hj, ok := w.(http.Hijacker)
	if !ok {
		dest.Close()
		http.Error(w, "no hijack", http.StatusInternalServerError)
		return
	}
	client, _, err := hj.Hijack()
	if err != nil {
		dest.Close()
		return
	}
	client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	go func() { io.Copy(dest, client); dest.Close() }()
	io.Copy(client, dest)
	client.Close()
}

func main() {
	port := "8889"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			handleConnect(w, r)
			return
		}
		// Plain HTTP is not used by Claude (HTTPS only); refuse.
		log.Printf("HTTP %s %s -> DENIED (https-only proxy)", r.Method, r.Host)
		http.Error(w, "forbidden: CONNECT api.anthropic.com only", http.StatusForbidden)
	})
	log.Printf("PROXY_LISTENING %s allowlist=[api.anthropic.com:443]", port)
	if err := http.ListenAndServe("0.0.0.0:"+port, h); err != nil {
		log.Fatal(err)
	}
}
