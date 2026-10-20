// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http/httptest"
	"runtime"
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
}

// upstream is a Task 8 server with a fake add-on behind it.
type upstream struct {
	srv *server.Server
	hs  *httptest.Server

	mu      sync.Mutex
	clients []string
	failing bool // answer calls with an add-on error
	pipes   []io.Closer
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
	conn := &connfile.Conn{Instance: instance, Port: port, Token: connfile.NewToken()}
	if err := connfile.Save(conn); err != nil {
		t.Fatal(err)
	}
	s := server.New(b, conn, func() string { return t.TempDir() })
	s.Log = log.New(io.Discard, "", 0)
	s.SetTools(tools)
	u.srv = s
	hs := httptest.NewUnstartedServer(s.Handler())
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
	if got := cs.InitializeResult().Instructions; got != "Thunderbird is not running. Start Thunderbird to use MCP for Thunderbird." {
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
	if got := cs.InitializeResult().Instructions; got != "" {
		t.Fatalf("instructions = %q, want empty", got)
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
	if got := cs.InitializeResult().Instructions; got != ClosedMessage {
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
