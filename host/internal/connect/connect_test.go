// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/bridge"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/nativemsg"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/server"
)

func isolate(t *testing.T) {
	t.Helper()
	d := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", d)
	t.Setenv("HOME", d)
	t.Setenv("AppData", d)
	// Test upstreams serve on ephemeral ports, outside 47110-47119.
	t.Cleanup(connfile.AllowPortsForTesting(func(p int) bool { return p > 0 && p < 65536 }))
}

// upstream is a Task 8 server with a fake add-on behind it.
type upstream struct {
	srv *server.Server
	hs  *httptest.Server

	mu      sync.Mutex
	clients []string
	tools   []string // tool of each call that reached the add-on
	failing bool     // answer calls with an add-on error
	pipes   []io.Closer
	// cut, when set, picks POSTs whose connection is closed after the
	// call has run, before any response is written.
	cut func(body []byte) bool
}

func (u *upstream) calls(tool string) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	n := 0
	for _, t := range u.tools {
		if t == tool {
			n++
		}
	}
	return n
}

func (u *upstream) setCut(f func([]byte) bool) { u.mu.Lock(); u.cut = f; u.mu.Unlock() }

// handler serves s, but for a request cut picks it runs the request to
// completion and then drops the connection without an answer: to the
// client the request was sent and the reply lost (a non-dial failure).
func (u *upstream) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		cut := u.cut
		u.mu.Unlock()
		if cut == nil || r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		if !cut(body) {
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(httptest.NewRecorder(), r)
		if c, _, err := w.(http.Hijacker).Hijack(); err == nil {
			c.Close()
		}
	})
}

func (u *upstream) setFailing(v bool) { u.mu.Lock(); u.failing = v; u.mu.Unlock() }

func (u *upstream) stop() {
	u.hs.CloseClientConnections()
	u.hs.Close()
	for _, c := range u.pipes {
		c.Close()
	}
}

func (u *upstream) lastClient() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.clients) == 0 {
		return ""
	}
	return u.clients[len(u.clients)-1]
}

// startUpstream serves on a free port, writes the connection file and
// answers every call with {"echo": tool}.
func startUpstream(t *testing.T, instance string, tools []string) *upstream {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	b := bridge.New(inR, outW, "9.9.9")
	b.SetCallTimeout(5 * time.Second)
	u := &upstream{}
	var wmu sync.Mutex
	go func() {
		for {
			raw, err := nativemsg.Read(outR)
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(raw, &m) != nil || m["type"] != "call" {
				continue
			}
			u.mu.Lock()
			u.clients = append(u.clients, m["client"].(string))
			u.tools = append(u.tools, m["tool"].(string))
			failing := u.failing
			u.mu.Unlock()
			reply := map[string]any{"type": "result", "id": m["id"], "ok": true,
				"content": map[string]any{"echo": m["tool"]}}
			if failing {
				reply = map[string]any{"type": "result", "id": m["id"], "ok": false,
					"error": map[string]any{"code": "not_found", "message": "Message not found in INBOX"}}
			}
			out, _ := json.Marshal(reply)
			go func() { wmu.Lock(); defer wmu.Unlock(); _ = nativemsg.Write(inW, out) }()
		}
	}()
	b.Start()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	conn := &connfile.Conn{Instance: instance, Port: port, Token: connfile.NewToken(), PID: os.Getpid()}
	if err := connfile.Save(conn); err != nil {
		t.Fatal(err)
	}
	s := server.New(b, conn, func() string { return t.TempDir() })
	s.Log = log.New(io.Discard, "", 0)
	s.SetTools(tools)
	u.srv = s
	hs := httptest.NewUnstartedServer(u.handler(s.Handler()))
	hs.Listener.Close()
	hs.Listener = ln
	hs.Start()
	u.hs = hs
	u.pipes = []io.Closer{inW, outR}
	t.Cleanup(u.stop)
	return u
}

// stdioClient runs Run on pipes and connects an MCP client to it.
func stdioClient(t *testing.T, instance string, poll time.Duration, opts *mcp.ClientOptions) *mcp.ClientSession {
	t.Helper()
	return stdioClientVersion(t, instance, poll, opts, "")
}

// stdioClientVersion pins the protocol version the client asks for; an
// older one uses the initialize handshake instead of server/discover.
func stdioClientVersion(t *testing.T, instance string, poll time.Duration, opts *mcp.ClientOptions, version string) *mcp.ClientSession {
	t.Helper()
	cs, _, _ := stdioClientCapture(t, instance, poll, opts, version)
	return cs
}

// syncBuf is a goroutine-safe buffer for captured output.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// stdioClientCapture also returns everything the proxy wrote to stdout and
// to its log.
func stdioClientCapture(t *testing.T, instance string, poll time.Duration, opts *mcp.ClientOptions, version string) (*mcp.ClientSession, *syncBuf, *syncBuf) {
	t.Helper()
	cs, _, stdout, logs := stdioProxy(t, instance, poll, opts, version)
	return cs, stdout, logs
}

// stdioProxy also returns the proxy itself, for tests that reach into its
// state.
func stdioProxy(t *testing.T, instance string, poll time.Duration, opts *mcp.ClientOptions, version string) (*mcp.ClientSession, *proxy, *syncBuf, *syncBuf) {
	t.Helper()
	stdout, logs := &syncBuf{}, &syncBuf{}
	old := logOutput
	logOutput = logs
	t.Cleanup(func() { logOutput = old })
	p := newProxy(instance, poll)
	cr, sw0 := io.Pipe() // proxy -> client
	sw := io.MultiWriter(sw0, stdout)
	sr, cw := io.Pipe() // client -> proxy
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = p.serve(ctx, sr, sw)
	}()
	c := mcp.NewClient(&mcp.Implementation{Name: "Claude Desktop", Version: "1"}, opts)
	cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer ccancel()
	cs, err := c.Connect(cctx, &mcp.IOTransport{Reader: cr, Writer: cw}, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() {
		cs.Close()
		cw.Close()
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return")
		}
	})
	return cs, p, stdout, logs
}

func listNames(t *testing.T, cs *mcp.ClientSession) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
	}
	return names
}

func callTool(t *testing.T, cs *mcp.ClientSession, name string) *mcp.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: map[string]any{}})
	if err != nil {
		t.Fatalf("call %s: %v", name, err)
	}
	return res
}

func resultText(res *mcp.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

func TestNotRunningMessage(t *testing.T) {
	isolate(t)
	cs := stdioClient(t, "", time.Hour, nil)
	if got := cs.InitializeResult().Instructions; got != "MCP for Thunderbird gives access to mail in Thunderbird. If no mail tools are listed, start Thunderbird; they appear automatically." {
		t.Fatalf("instructions = %q", got)
	}
	if names := listNames(t, cs); len(names) != 0 {
		t.Fatalf("tools = %v, want none", names)
	}
	res := callTool(t, cs, "mail_accounts")
	if !res.IsError || resultText(res) != ClosedMessage {
		t.Fatalf("call = error %v %q", res.IsError, resultText(res))
	}
}

func TestProxiesTools(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "inst1", []string{"mail_accounts", "mail_search"})
	cs := stdioClient(t, "", time.Hour, nil)
	// The instructions stay true once tools appear.
	if got := cs.InitializeResult().Instructions; got != Instructions {
		t.Fatalf("instructions = %q", got)
	}
	names := listNames(t, cs)
	if len(names) != 2 {
		t.Fatalf("tools = %v", names)
	}
	// Definitions mirror upstream.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, _ := cs.ListTools(ctx, nil)
	for _, tl := range res.Tools {
		if tl.Description == "" || tl.InputSchema == nil || tl.Annotations == nil || !tl.Annotations.ReadOnlyHint {
			t.Fatalf("tool %s not mirrored: %+v", tl.Name, tl)
		}
	}
	out := callTool(t, cs, "mail_accounts")
	if out.IsError || !strings.Contains(resultText(out), `"echo":"mail_accounts"`) {
		t.Fatalf("result = %v %q", out.IsError, resultText(out))
	}
	if got := u.lastClient(); got != "Claude Desktop" {
		t.Fatalf("upstream saw client %q, want Claude Desktop", got)
	}
}

func TestInstanceFlagSelectsFile(t *testing.T) {
	isolate(t)
	startUpstream(t, "first", []string{"mail_accounts"})
	time.Sleep(20 * time.Millisecond)
	startUpstream(t, "second", []string{"mail_search"})
	cs := stdioClient(t, "first", time.Hour, nil)
	if names := listNames(t, cs); len(names) != 1 || names[0] != "mail_accounts" {
		t.Fatalf("tools = %v", names)
	}
}

func TestUpstreamAppearsNotifies(t *testing.T) {
	isolate(t)
	changed := make(chan struct{}, 4)
	cs := stdioClient(t, "", 200*time.Millisecond, &mcp.ClientOptions{
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) { changed <- struct{}{} },
	})
	if names := listNames(t, cs); len(names) != 0 {
		t.Fatalf("tools = %v", names)
	}
	time.AfterFunc(time.Second, func() { startUpstream(t, "late", []string{"mail_accounts"}) })
	select {
	case <-changed:
	case <-time.After(6 * time.Second):
		t.Fatal("no list_changed within 6 s")
	}
	if names := listNames(t, cs); len(names) != 1 {
		t.Fatalf("tools after = %v", names)
	}
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("call failed: %q", resultText(res))
	}
}

func TestUpstreamDisappearsNotifies(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "gone", []string{"mail_accounts"})
	changed := make(chan struct{}, 4)
	cs := stdioClient(t, "", 200*time.Millisecond, &mcp.ClientOptions{
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) { changed <- struct{}{} },
	})
	if names := listNames(t, cs); len(names) != 1 {
		t.Fatalf("tools = %v", names)
	}
	u.hs.CloseClientConnections()
	u.hs.Close()
	select {
	case <-changed:
	case <-time.After(6 * time.Second):
		t.Fatal("no list_changed within 6 s")
	}
	if names := listNames(t, cs); len(names) != 0 {
		t.Fatalf("tools after = %v", names)
	}
	if res := callTool(t, cs, "mail_accounts"); !res.IsError || resultText(res) != ClosedMessage {
		t.Fatalf("call = %v %q", res.IsError, resultText(res))
	}
}

func TestTokenRotationRecovers(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "rot", []string{"mail_accounts"})
	cs := stdioClient(t, "", time.Hour, nil) // polling never fires: recovery is on the 401
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first call: %q", resultText(res))
	}
	if err := u.srv.Rotate(); err != nil {
		t.Fatal(err)
	}
	res := callTool(t, cs, "mail_accounts")
	if res.IsError || !strings.Contains(resultText(res), `"echo":"mail_accounts"`) {
		t.Fatalf("call after rotation: %v %q", res.IsError, resultText(res))
	}
}

func TestLegacyInitializeHandshake(t *testing.T) {
	isolate(t)
	cs := stdioClientVersion(t, "", time.Hour, nil, "2025-06-18")
	if got := cs.InitializeResult().Instructions; got != Instructions {
		t.Fatalf("instructions = %q", got)
	}
	u := startUpstream(t, "legacy", []string{"mail_accounts"})
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("call: %q", resultText(res))
	}
	if got := u.lastClient(); got != "Claude Desktop" {
		t.Fatalf("upstream client %q", got)
	}
}

func waitFor(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestForwardsUpstreamListChanged(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "fwd", []string{"mail_accounts"})
	changed := make(chan struct{}, 4)
	cs := stdioClient(t, "", time.Hour, &mcp.ClientOptions{ // polling never fires
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) { changed <- struct{}{} },
	})
	if n := len(listNames(t, cs)); n != 1 {
		t.Fatalf("tools = %d", n)
	}
	u.srv.SetTools([]string{"mail_accounts", "mail_search"})
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream list_changed not forwarded")
	}
	waitFor(t, "two tools", 3*time.Second, func() bool { return len(listNames(t, cs)) == 2 })
}

func TestTokenNeverOnStdoutOrLogs(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "secret", []string{"mail_accounts"})
	cs, stdout, logs := stdioClientCapture(t, "", time.Hour, nil, "")
	callTool(t, cs, "mail_accounts")
	old := u.srv.Token()
	if err := u.srv.Rotate(); err != nil {
		t.Fatal(err)
	}
	callTool(t, cs, "mail_accounts") // exercises the 401 path and its logging
	u.stop()
	callTool(t, cs, "mail_accounts") // exercises the failure path
	for _, tok := range []string{old, u.srv.Token()} {
		if strings.Contains(stdout.String(), tok) || strings.Contains(logs.String(), tok) {
			t.Fatal("token leaked to stdout or logs")
		}
	}
}

// A tool the proxy has not (or no longer) mirrored is still forwarded
// while an upstream session exists. A background re-sync can remove the
// mirrored tools just before the upstream goes away (seen on CI after a
// token rotation): the call must then get the upstream's answer or the
// closed copy, never an unknown-tool protocol error.
func TestCallForwardedWhenToolNotMirrored(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "unmirrored", []string{"mail_accounts"})
	cs, p, _, _ := stdioProxy(t, "", time.Hour, nil, "")
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first call: %q", resultText(res))
	}
	unmirror := func() {
		p.syncMu.Lock()
		defer p.syncMu.Unlock()
		p.mu.Lock()
		delete(p.registered, "mail_accounts")
		p.mu.Unlock()
		p.srv.RemoveTools("mail_accounts")
	}
	unmirror()
	res := callTool(t, cs, "mail_accounts")
	if res.IsError || !strings.Contains(resultText(res), `"echo":"mail_accounts"`) {
		t.Fatalf("unmirrored call: %v %q", res.IsError, resultText(res))
	}
	// Upstream gone with the mirror empty: the closed copy.
	unmirror()
	u.stop()
	if res := callTool(t, cs, "mail_accounts"); !res.IsError || resultText(res) != ClosedMessage {
		t.Fatalf("after stop: %v %q", res.IsError, resultText(res))
	}
}

// A call on a session whose upstream stopped listening fails to dial. The
// SDK reports that as a JSON-RPC "rejected by transport" error; it is a
// transport failure (drop, re-read, retry once, then the closed copy), not
// an upstream answer to pass through.
func TestDialFailureOnLiveSessionGivesClosedCopy(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "refused", []string{"mail_accounts"})
	// Every request after its response closes its connection, so no
	// pooled connection can carry the call below.
	u.hs.Config.SetKeepAlivesEnabled(false)
	cs := stdioClient(t, "", time.Hour, nil)
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first call: %q", resultText(res))
	}
	// Stop accepting connections but keep the open event stream, so the
	// session stays up; the next request must dial and is refused.
	u.hs.Listener.Close()
	if res := callTool(t, cs, "mail_accounts"); !res.IsError || resultText(res) != ClosedMessage {
		t.Fatalf("call to a refused port: %v %q", res.IsError, resultText(res))
	}
}

func TestRestartOnNewPortAndToken(t *testing.T) {
	isolate(t)
	u1 := startUpstream(t, "restart", []string{"mail_accounts"})
	cs := stdioClient(t, "", time.Hour, nil)
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first: %q", resultText(res))
	}
	u1.stop()
	u2 := startUpstream(t, "restart", []string{"mail_accounts"}) // new port, new token, same file
	if u1.srv.Token() == u2.srv.Token() || u1.srv.URL() == u2.srv.URL() {
		t.Fatal("restart did not change port and token")
	}
	res := callTool(t, cs, "mail_accounts")
	if res.IsError || !strings.Contains(resultText(res), `"echo":"mail_accounts"`) {
		t.Fatalf("after restart: %v %q", res.IsError, resultText(res))
	}
}

func TestRejectedTokenMessage(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "badkey", []string{"mail_accounts"})
	cs := stdioClient(t, "", time.Hour, nil)
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first: %q", resultText(res))
	}
	// The file keeps a token the server no longer accepts.
	if err := u.srv.Rotate(); err != nil {
		t.Fatal(err)
	}
	conn, _ := connfile.Load("badkey")
	conn.Token = connfile.NewToken()
	if err := connfile.Save(conn); err != nil {
		t.Fatal(err)
	}
	res := callTool(t, cs, "mail_accounts")
	if !res.IsError || resultText(res) != RejectedMessage {
		t.Fatalf("got %v %q", res.IsError, resultText(res))
	}
}

func TestErrorResultPassesThrough(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "err", []string{"mail_accounts"})
	cs := stdioClient(t, "", time.Hour, nil)
	u.setFailing(true)
	res := callTool(t, cs, "mail_accounts")
	if !res.IsError || resultText(res) != "not_found: Message not found in INBOX" {
		t.Fatalf("got %v %q", res.IsError, resultText(res))
	}
}

func TestNoGoroutineLeakAcrossReconnects(t *testing.T) {
	isolate(t)
	cs := stdioClient(t, "", 20*time.Millisecond, nil)
	cycle := func() {
		u := startUpstream(t, "cycle", []string{"mail_accounts"})
		waitFor(t, "tool appears", 5*time.Second, func() bool { return len(listNames(t, cs)) == 1 })
		u.stop()
		waitFor(t, "tool disappears", 5*time.Second, func() bool { return len(listNames(t, cs)) == 0 })
	}
	// Count the proxy's side only: goroutines in the upstream test server
	// (its HTTP sessions outlive a vanished client by design) are excluded.
	settle := func() int {
		time.Sleep(300 * time.Millisecond)
		runtime.GC()
		buf := make([]byte, 4<<20)
		stacks := strings.Split(string(buf[:runtime.Stack(buf, true)]), "\n\n")
		n := 0
		for _, st := range stacks {
			if strings.Contains(st, "streamableClientConn") || strings.Contains(st, "mcp.(*ClientSession)") ||
				strings.Contains(st, "connect.(*proxy)") || strings.Contains(st, "authRT") {
				n++
			}
		}
		return n
	}
	cycle() // warm up
	base := settle()
	for i := 0; i < 20; i++ {
		cycle()
	}
	if got := settle(); got > base+10 {
		t.Fatalf("proxy goroutines grew from %d to %d over 20 reconnects", base, got)
	}
}

// deadPID is the PID of a child process that has already exited.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

// squatter is a server another local user could run on a port the
// connection file names. It records every request's Authorization header.
type squatter struct {
	hs   *httptest.Server
	mu   sync.Mutex
	auth []string
}

func newSquatter(t *testing.T, ln net.Listener) *squatter {
	t.Helper()
	sq := &squatter{}
	sq.hs = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sq.mu.Lock()
		sq.auth = append(sq.auth, r.Header.Get("Authorization"))
		sq.mu.Unlock()
		http.Error(w, "nothing here", http.StatusNotFound)
	}))
	if ln != nil {
		sq.hs.Listener.Close()
		sq.hs.Listener = ln
	}
	sq.hs.Start()
	t.Cleanup(sq.hs.Close)
	return sq
}

func (sq *squatter) port() int { return sq.hs.Listener.Addr().(*net.TCPAddr).Port }

// tokenSeen reports whether any request carried tok (or any request at
// all, for tok == "").
func (sq *squatter) tokenSeen(tok string) bool {
	sq.mu.Lock()
	defer sq.mu.Unlock()
	for _, a := range sq.auth {
		if tok == "" || strings.Contains(a, tok) {
			return true
		}
	}
	return false
}

// I1/R33: Thunderbird exited without clearing its file (a crash), and
// another program now listens on its port. The proxy, polling every
// 50 ms, must never send that program a request.
func TestStaleFileNeverReachesSquatter(t *testing.T) {
	isolate(t)
	sq := newSquatter(t, nil)
	tok := connfile.NewToken()
	if err := connfile.Save(&connfile.Conn{Instance: "stale", Port: sq.port(), Token: tok, PID: deadPID(t)}); err != nil {
		t.Fatal(err)
	}
	cs := stdioClient(t, "", 50*time.Millisecond, nil)
	if res := callTool(t, cs, "mail_accounts"); !res.IsError || resultText(res) != ClosedMessage {
		t.Fatalf("call = %v %q", res.IsError, resultText(res))
	}
	time.Sleep(500 * time.Millisecond) // about ten polls
	if sq.tokenSeen("") {
		t.Fatal("the proxy sent a request to the stale port")
	}
	// The same with --instance naming the stale file.
	cs2 := stdioClient(t, "stale", 50*time.Millisecond, nil)
	callTool(t, cs2, "mail_accounts")
	time.Sleep(300 * time.Millisecond)
	if sq.tokenSeen("") {
		t.Fatal("the proxy sent a request to the stale port (--instance)")
	}
}

// A live session whose host has gone: the next requests must not follow
// the session's old port to the program that took it over.
func TestLiveSessionNeverReachesSquatter(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "takeover", []string{"mail_accounts"})
	cs := stdioClient(t, "", 50*time.Millisecond, nil)
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first call: %q", resultText(res))
	}
	tok := u.srv.Token()
	port := u.hs.Listener.Addr().(*net.TCPAddr).Port
	// The host dies without clearing its file; the file still names the
	// port and token, with a PID that is gone.
	conn, err := connfile.Load("takeover")
	if err != nil {
		t.Fatal(err)
	}
	conn.PID = deadPID(t)
	if err := connfile.Save(conn); err != nil {
		t.Fatal(err)
	}
	u.stop()
	var ln net.Listener
	for i := 0; i < 50; i++ {
		if ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port))); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if ln == nil {
		t.Skipf("could not take over port %d: %v", port, err)
	}
	sq := newSquatter(t, ln)
	callTool(t, cs, "mail_accounts")
	time.Sleep(500 * time.Millisecond)
	if sq.tokenSeen(tok) {
		t.Fatal("the token was sent to the program that took over the port")
	}
}

// With the real port rule, a live file naming a port outside 47110-47119
// is never used.
func TestPortOutsideRangeRefused(t *testing.T) {
	isolate(t)
	restore := connfile.AllowPortsForTesting(func(p int) bool { return p >= connfile.PortMin && p <= connfile.PortMax })
	defer restore()
	sq := newSquatter(t, nil)
	if err := connfile.Save(&connfile.Conn{Instance: "far", Port: sq.port(), Token: connfile.NewToken(), PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	cs := stdioClient(t, "far", 50*time.Millisecond, nil)
	if res := callTool(t, cs, "mail_accounts"); !res.IsError || resultText(res) != ClosedMessage {
		t.Fatalf("call = %v %q", res.IsError, resultText(res))
	}
	time.Sleep(300 * time.Millisecond)
	if sq.tokenSeen("") {
		t.Fatal("the proxy sent a request to a port outside 47110-47119")
	}
}

// The token goes to the connection file's address only: a redirect is
// never followed.
func TestRedirectNotFollowed(t *testing.T) {
	isolate(t)
	target := newSquatter(t, nil)
	tok := connfile.NewToken()
	redir := httptest.NewServer(http.RedirectHandler(target.hs.URL+"/mcp", http.StatusTemporaryRedirect))
	t.Cleanup(redir.Close)
	port := redir.Listener.Addr().(*net.TCPAddr).Port
	if err := connfile.Save(&connfile.Conn{Instance: "redir", Port: port, Token: tok, PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	cs := stdioClient(t, "", 50*time.Millisecond, nil)
	callTool(t, cs, "mail_accounts")
	time.Sleep(300 * time.Millisecond)
	if target.tokenSeen("") {
		t.Fatal("the proxy followed a redirect")
	}
}

// Connect mode forwards any tool name; the upstream refuses one it has
// not registered, and the add-on is never asked.
func TestUnregisteredToolRefusedUpstream(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "unreg", []string{"mail_accounts"})
	cs := stdioClient(t, "", time.Hour, nil)
	for _, name := range []string{"mail_send", "mail_bogus"} {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: map[string]any{}})
		cancel()
		if err == nil && !res.IsError {
			t.Fatalf("%s: call succeeded: %q", name, resultText(res))
		}
		if n := u.calls(name); n != 0 {
			t.Fatalf("%s reached the add-on %d times", name, n)
		}
	}
}

func isCall(tool string) func([]byte) bool {
	return func(b []byte) bool {
		return bytes.Contains(b, []byte(`"tools/call"`)) && bytes.Contains(b, []byte(`"`+tool+`"`))
	}
}

// A write whose reply is lost after it was sent is never retried: it may
// have happened.
func TestWriteNotRetriedAfterLostReply(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "lost", []string{"mail_accounts", "mail_move"})
	cs := stdioClient(t, "", time.Hour, nil)
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first call: %q", resultText(res))
	}
	u.setCut(isCall("mail_move"))
	res := callTool(t, cs, "mail_move")
	if !res.IsError || resultText(res) != "thunderbird_error: Connection lost; the action may or may not have happened" {
		t.Fatalf("call = %v %q", res.IsError, resultText(res))
	}
	if n := u.calls("mail_move"); n != 1 {
		t.Fatalf("mail_move reached the add-on %d times, want 1", n)
	}
}

// A read whose reply is lost is safe to repeat and is retried once.
func TestReadRetriedAfterLostReply(t *testing.T) {
	isolate(t)
	u := startUpstream(t, "lostread", []string{"mail_accounts"})
	cs := stdioClient(t, "", time.Hour, nil)
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("first call: %q", resultText(res))
	}
	var once sync.Once
	u.setCut(func(b []byte) bool {
		hit := false
		if isCall("mail_accounts")(b) {
			once.Do(func() { hit = true })
		}
		return hit
	})
	if res := callTool(t, cs, "mail_accounts"); res.IsError {
		t.Fatalf("retried read: %q", resultText(res))
	}
	if n := u.calls("mail_accounts"); n != 3 {
		t.Fatalf("mail_accounts reached the add-on %d times, want 3", n)
	}
}

func TestDialErrorDetection(t *testing.T) {
	dial := &url.Error{Op: "Post", URL: "http://127.0.0.1:1/mcp", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}}
	read := &url.Error{Op: "Post", URL: "http://127.0.0.1:1/mcp", Err: &net.OpError{Op: "read", Net: "tcp", Err: errors.New("reset")}}
	if !dialFailed(fmt.Errorf("wrapped: %w", dial)) {
		t.Fatal("dial error not detected")
	}
	if dialFailed(read) || dialFailed(io.EOF) || dialFailed(&url.Error{Op: "Post", URL: "x", Err: io.ErrUnexpectedEOF}) {
		t.Fatal("non-dial error taken as dial")
	}
}
