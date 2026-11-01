// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/bridge"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/files"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/nativemsg"
)

// fakeAddon plays Thunderbird on the far side of the native-messaging pipes.
// reply builds the result frame for each call; blobs are collected by id.
type fakeAddon struct {
	t      *testing.T
	toHost *io.PipeWriter
	wmu    sync.Mutex

	mu    sync.Mutex
	calls []map[string]any
	blobs map[string][]byte
	reply func(call map[string]any) map[string]any
}

func (f *fakeAddon) send(m map[string]any) {
	raw, _ := json.Marshal(m)
	f.wmu.Lock()
	defer f.wmu.Unlock()
	_ = nativemsg.Write(f.toHost, raw)
}

func (f *fakeAddon) loop(from io.Reader) {
	for {
		raw, err := nativemsg.Read(from)
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m["type"] {
		case "blob":
			data, _ := base64.StdEncoding.DecodeString(m["data"].(string))
			f.mu.Lock()
			f.blobs[m["blob"].(string)] = append(f.blobs[m["blob"].(string)], data...)
			f.mu.Unlock()
		case "call":
			f.mu.Lock()
			f.calls = append(f.calls, m)
			reply := f.reply
			f.mu.Unlock()
			out := map[string]any{"ok": true, "content": map[string]any{"echo": m["tool"]}}
			if reply != nil {
				out = reply(m)
			}
			out["type"] = "result"
			out["id"] = m["id"]
			go f.send(out)
		}
	}
}

func (f *fakeAddon) setReply(r func(map[string]any) map[string]any) {
	f.mu.Lock()
	f.reply = r
	f.mu.Unlock()
}

func (f *fakeAddon) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeAddon) lastCall() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return nil
	}
	return f.calls[len(f.calls)-1]
}

type harness struct {
	srv    *Server
	addon  *fakeAddon
	url    string
	token  string
	attDir string
}

func newHarness(t *testing.T, enabled []string) *harness {
	t.Helper()
	inR, inW := io.Pipe()   // add-on -> host
	outR, outW := io.Pipe() // host -> add-on
	b := bridge.New(inR, outW, "9.9.9")
	b.SetCallTimeout(5 * time.Second)
	f := &fakeAddon{t: t, toHost: inW, blobs: map[string][]byte{}}
	go f.loop(outR)
	b.Start()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	conn := &connfile.Conn{Instance: "test", Port: port, Token: connfile.NewToken()}
	att := t.TempDir()
	s := New(b, conn, func() string { return att })
	s.Log = log.New(io.Discard, "", 0)
	s.SetTools(enabled)
	b.OnTools(s.SetTools) // as main wires it

	hs := httptest.NewUnstartedServer(s.Handler())
	hs.Listener.Close()
	hs.Listener = ln
	hs.Start()
	t.Cleanup(func() {
		hs.CloseClientConnections()
		hs.Close()
		inW.Close()
		outR.Close()
	})
	return &harness{srv: s, addon: f, url: "http://127.0.0.1:" + strconv.Itoa(port) + "/mcp", token: conn.Token, attDir: att}
}

type bearer struct {
	token string
	next  http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.next.RoundTrip(r)
}

func (h *harness) connect(t *testing.T, opts *mcp.ClientOptions) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "1.0"}, opts)
	tr := &mcp.StreamableClientTransport{
		Endpoint:   h.url,
		HTTPClient: &http.Client{Transport: bearer{h.token, http.DefaultTransport}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cs, err := c.Connect(ctx, tr, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func toolNames(t *testing.T, cs *mcp.ClientSession) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	var names []string
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
	}
	sort.Strings(names)
	return names
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args any) (*mcp.CallToolResult, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
}

func text(res *mcp.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

func TestListToolsMatchesEnabled(t *testing.T) {
	h := newHarness(t, []string{"mail_search", "mail_read"})
	cs := h.connect(t, nil)
	got := toolNames(t, cs)
	if strings.Join(got, ",") != "mail_read,mail_search" {
		t.Fatalf("tools = %v, want [mail_read mail_search]", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tl := range res.Tools {
		if tl.Annotations == nil || !tl.Annotations.ReadOnlyHint || !tl.Annotations.IdempotentHint {
			t.Errorf("%s annotations = %+v, want read-only and idempotent", tl.Name, tl.Annotations)
		}
		if tl.Annotations != nil && (tl.Annotations.DestructiveHint == nil || *tl.Annotations.DestructiveHint) {
			t.Errorf("%s destructiveHint should be explicitly false", tl.Name)
		}
	}
}

func TestToolsChangedNotifies(t *testing.T) {
	h := newHarness(t, []string{"mail_search", "mail_read"})
	changed := make(chan struct{}, 4)
	cs := h.connect(t, &mcp.ClientOptions{
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) {
			changed <- struct{}{}
		},
	})
	if n := len(toolNames(t, cs)); n != 2 {
		t.Fatalf("before: %d tools, want 2", n)
	}
	// A `tools` message from the add-on reaches SetTools through the bridge.
	h.addon.send(map[string]any{"type": "tools", "tools": []string{"mail_search", "mail_read", "mail_mark"}})
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("no notifications/tools/list_changed within 5 s")
	}
	got := toolNames(t, cs)
	if strings.Join(got, ",") != "mail_mark,mail_read,mail_search" {
		t.Fatalf("after: tools = %v", got)
	}
}

func TestSendAbsentByDefault(t *testing.T) {
	h := newHarness(t, []string{"mail_search", "mail_read", "mail_draft"})
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_send", map[string]any{"to": []string{"a@example.com"}, "subject": "s", "body": "b"})
	if err == nil && (res == nil || !res.IsError) {
		t.Fatalf("mail_send succeeded: %+v", res)
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	} else {
		msg = text(res)
	}
	if !strings.Contains(msg, "unknown tool") {
		t.Fatalf("error = %q, want unknown tool", msg)
	}
	if h.addon.callCount() != 0 {
		t.Fatal("mail_send reached the add-on")
	}
}

func TestCallPassesArgsAndClient(t *testing.T) {
	h := newHarness(t, []string{"mail_search"})
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_search", map[string]any{"text": "hello", "limit": 5})
	if err != nil || res.IsError {
		t.Fatalf("call: %v %+v", err, res)
	}
	c := h.addon.lastCall()
	if c["tool"] != "mail_search" || c["client"] != "test-client" {
		t.Fatalf("call frame = %v", c)
	}
	args, _ := c["args"].(map[string]any)
	if args["text"] != "hello" || args["limit"] != float64(5) {
		t.Fatalf("args = %v", args)
	}
	var content map[string]any
	if err := json.Unmarshal([]byte(text(res)), &content); err != nil || content["echo"] != "mail_search" {
		t.Fatalf("content = %q (%v)", text(res), err)
	}
}

func TestCallErrorSurfaces(t *testing.T) {
	h := newHarness(t, []string{"mail_search"})
	h.addon.setReply(func(map[string]any) map[string]any {
		return map[string]any{"ok": false, "error": map[string]any{"code": "paused", "message": "Paused by the user in Thunderbird"}}
	})
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_search", map[string]any{})
	if err != nil {
		t.Fatalf("protocol error: %v", err)
	}
	if !res.IsError || text(res) != "paused: Paused by the user in Thunderbird" {
		t.Fatalf("result isError=%v text=%q", res.IsError, text(res))
	}
}

func TestSaveWritesFile(t *testing.T) {
	h := newHarness(t, []string{"mail_attachment"})
	h.addon.setReply(func(map[string]any) map[string]any {
		return map[string]any{"ok": true, "content": map[string]any{"name": "report.pdf", "size": 5},
			"save": map[string]any{"name": "report.pdf", "data": base64.StdEncoding.EncodeToString([]byte("%PDF-"))}}
	})
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_attachment", map[string]any{"id": "m1.x", "name": "report.pdf"})
	if err != nil || res.IsError {
		t.Fatalf("call: %v %q", err, text(res))
	}
	var content map[string]any
	if err := json.Unmarshal([]byte(text(res)), &content); err != nil {
		t.Fatalf("content %q: %v", text(res), err)
	}
	// The saved path is the resolved one (macOS /var -> /private/var,
	// Windows short names).
	real, err := filepath.EvalSymlinks(h.attDir)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(real, "report.pdf")
	if content["saved"] != want || content["name"] != "report.pdf" {
		t.Fatalf("content = %v, want saved %s", content, want)
	}
	data, err := os.ReadFile(want)
	if err != nil || string(data) != "%PDF-" {
		t.Fatalf("file = %q, %v", data, err)
	}
}

func TestDraftAttachmentResolved(t *testing.T) {
	h := newHarness(t, []string{"mail_draft"})
	if err := os.WriteFile(filepath.Join(h.attDir, "notes.txt"), []byte("attached text"), 0o600); err != nil {
		t.Fatal(err)
	}
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_draft", map[string]any{"kind": "new", "body": "hi", "attachments": []string{"notes.txt"}})
	if err != nil || res.IsError {
		t.Fatalf("call: %v %q", err, text(res))
	}
	c := h.addon.lastCall()
	ids, _ := c["blobs"].([]any)
	if len(ids) != 1 {
		t.Fatalf("blobs = %v", c["blobs"])
	}
	h.addon.mu.Lock()
	got := string(h.addon.blobs[ids[0].(string)])
	h.addon.mu.Unlock()
	if got != "attached text" {
		t.Fatalf("blob = %q", got)
	}
	args := c["args"].(map[string]any)
	atts, _ := args["attachments"].([]any)
	if len(atts) != 1 {
		t.Fatalf("attachments = %v", args["attachments"])
	}
	a := atts[0].(map[string]any)
	if a["name"] != "notes.txt" || a["blob"] != float64(0) {
		t.Fatalf("attachment = %v, want name notes.txt blob 0", a)
	}
	if args["body"] != "hi" || args["kind"] != "new" {
		t.Fatalf("other args lost: %v", args)
	}

	// A path outside the folder is refused before anything reaches Thunderbird.
	before := h.addon.callCount()
	res, err = call(t, cs, "mail_draft", map[string]any{"kind": "new", "body": "hi", "attachments": []string{"../x"}})
	if err != nil {
		t.Fatalf("protocol error: %v", err)
	}
	if !res.IsError || !strings.HasPrefix(text(res), "refused: ") {
		t.Fatalf("result isError=%v text=%q, want refused", res.IsError, text(res))
	}
	if h.addon.callCount() != before {
		t.Fatal("refused draft reached the add-on")
	}

	// A missing file is a not_found tool error, also without a call.
	res, err = call(t, cs, "mail_draft", map[string]any{"kind": "new", "body": "hi", "attachments": []string{"missing.txt"}})
	if err != nil || !res.IsError || !strings.HasPrefix(text(res), "not_found: ") {
		t.Fatalf("missing: %v %+v %q", err, res, text(res))
	}
	if h.addon.callCount() != before {
		t.Fatal("missing-file draft reached the add-on")
	}
}

func TestEndpointIsMCPOnly(t *testing.T) {
	h := newHarness(t, []string{"mail_search"})
	req, _ := http.NewRequest(http.MethodGet, strings.TrimSuffix(h.url, "/mcp")+"/other", nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
}

func TestAttachmentsBounded(t *testing.T) {
	h := newHarness(t, []string{"mail_draft"})
	big := filepath.Join(h.attDir, "big.bin")
	if err := os.WriteFile(big, make([]byte, 20<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.attDir, "small.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cs := h.connect(t, nil)

	// The same 20 MiB file three times passes 50 MiB in total.
	res, err := call(t, cs, "mail_draft", map[string]any{"kind": "new", "body": "hi",
		"attachments": []string{"big.bin", "big.bin", "big.bin"}})
	if err != nil {
		t.Fatalf("protocol error: %v", err)
	}
	if !res.IsError || text(res) != "too_large: Attachments exceed 50 MiB in total" {
		t.Fatalf("repeated: isError=%v text=%q", res.IsError, text(res))
	}

	// 21 entries are too many, whatever their size. The schema says
	// maxItems 20, so bypass client-side checks by calling the handler.
	names := make([]string, 21)
	for i := range names {
		names[i] = "small.txt"
	}
	args, _ := json.Marshal(map[string]any{"kind": "new", "body": "hi", "attachments": names})
	_, _, rerr := h.srv.resolveAttachments(args)
	var ce bridge.CallError
	if !errors.As(rerr, &ce) || ce.Code != "too_large" || ce.Message != "Too many attachments (max 20)" {
		t.Fatalf("21 entries: err = %v", rerr)
	}
	res, err = call(t, cs, "mail_draft", map[string]any{"kind": "new", "body": "hi", "attachments": names})
	if err == nil && (res == nil || !res.IsError) {
		t.Fatal("21 attachments accepted")
	}
	if h.addon.callCount() != 0 {
		t.Fatal("an over-limit draft reached the add-on")
	}

	// Exactly 20 small entries pass.
	if _, blobs, err := h.srv.resolveAttachments(mustJSON(map[string]any{"attachments": names[:20]})); err != nil || len(blobs) != 20 {
		t.Fatalf("20 entries: %v, %d blobs", err, len(blobs))
	}
}

func mustJSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

func TestUnknownErrorCodeMapped(t *testing.T) {
	h := newHarness(t, []string{"mail_search"})
	h.addon.setReply(func(map[string]any) map[string]any {
		return map[string]any{"ok": false, "error": map[string]any{"code": "evil\nINJECTED log line", "message": "boom"}}
	})
	var logBuf strings.Builder
	var lmu sync.Mutex
	h.srv.Log = log.New(writerFunc(func(p []byte) (int, error) {
		lmu.Lock()
		defer lmu.Unlock()
		return logBuf.Write(p)
	}), "", 0)
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_search", map[string]any{})
	if err != nil || !res.IsError || text(res) != "thunderbird_error: boom" {
		t.Fatalf("err=%v text=%q", err, text(res))
	}
	lmu.Lock()
	defer lmu.Unlock()
	if strings.Contains(logBuf.String(), "INJECTED") || !strings.Contains(logBuf.String(), "error thunderbird_error") {
		t.Fatalf("log = %q", logBuf.String())
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestClientLogBounded(t *testing.T) {
	var buf strings.Builder
	s := &Server{Log: log.New(&buf, "", 0), clients: map[string]bool{}}
	for i := 0; i < 300; i++ {
		s.noteClient("client-" + strconv.Itoa(i))
	}
	s.noteClient("client-0") // already seen: no line
	lines := strings.Count(buf.String(), "\n")
	if lines != maxClientNames+1 {
		t.Fatalf("%d log lines, want %d names plus one overflow line", lines, maxClientNames)
	}
	if strings.Contains(buf.String(), "client-299") {
		t.Fatal("logged a name after the table was full")
	}
}

// Switching a group off in the add-on removes its tools from the list.
func TestSetToolsRemovesDisabledGroup(t *testing.T) {
	h := newHarness(t, []string{"mail_search", "mail_read", "mail_mark", "mail_move", "mail_draft"})
	changed := make(chan struct{}, 4)
	cs := h.connect(t, &mcp.ClientOptions{
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) { changed <- struct{}{} },
	})
	if got := strings.Join(toolNames(t, cs), ","); got != "mail_draft,mail_mark,mail_move,mail_read,mail_search" {
		t.Fatalf("before: %s", got)
	}
	// organise and compose switched off
	h.addon.send(map[string]any{"type": "tools", "tools": []string{"mail_search", "mail_read"}})
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("no notifications/tools/list_changed within 5 s")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := strings.Join(toolNames(t, cs), ",")
		if got == "mail_read,mail_search" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after: %s", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// An empty list removes everything.
	h.addon.send(map[string]any{"type": "tools", "tools": []string{}})
	deadline = time.Now().Add(3 * time.Second)
	for len(toolNames(t, cs)) != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("tools left: %v", toolNames(t, cs))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A rotate_token that arrives while the host stops must not put a fresh
// token back into the connection file Clear has just emptied.
func TestRotateRefusedAfterClear(t *testing.T) {
	d := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", d)
	t.Setenv("HOME", d)
	t.Setenv("AppData", d)
	conn := &connfile.Conn{Instance: "stop", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
	if err := connfile.Save(conn); err != nil {
		t.Fatal(err)
	}
	s := New(nil, conn, func() string { return "" })
	s.Log = log.New(io.Discard, "", 0)
	if err := s.Rotate(); err != nil {
		t.Fatalf("rotate while running: %v", err)
	}
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if err := s.Rotate(); !errors.Is(err, ErrStopped) {
		t.Fatalf("rotate after Clear = %v, want ErrStopped", err)
	}
	got, err := connfile.Load("stop")
	if err != nil || got.Port != 0 || got.Token != "" || s.Token() != "" {
		t.Fatalf("after a late rotate: file %+v %v, token in memory %q", got, err, s.Token())
	}
}

// A call that changes mail and reached Thunderbird without an answer says
// the action may have happened, so it is not simply repeated; a read says
// only what went wrong.
func TestUnansweredWriteSaysItMayHaveHappened(t *testing.T) {
	h := newHarness(t, []string{"mail_move", "mail_search"})
	h.srv.b.SetCallTimeout(100 * time.Millisecond)
	h.addon.setReply(func(m map[string]any) map[string]any {
		time.Sleep(300 * time.Millisecond) // answers after the timeout
		return map[string]any{"ok": true, "content": "late"}
	})
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_move", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if want := "thunderbird_error: Thunderbird did not answer in 60 s" + MaybeSuffix; !res.IsError || text(res) != want {
		t.Fatalf("mail_move: isError=%v text=%q, want %q", res.IsError, text(res), want)
	}
	res, err = call(t, cs, "mail_search", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if want := "thunderbird_error: Thunderbird did not answer in 60 s"; !res.IsError || text(res) != want {
		t.Fatalf("mail_search: isError=%v text=%q, want %q", res.IsError, text(res), want)
	}
	// A cancelled write is worded the same way.
	r := h.srv.toolError("mail_send", bridge.CallError{Code: "thunderbird_error", Message: "The request was cancelled", MayHaveCompleted: true})
	if got := text(r); got != "thunderbird_error: The request was cancelled"+MaybeSuffix {
		t.Fatalf("cancelled send: %q", got)
	}
}

// A session that sends nothing for sessionTimeout is closed, so abandoned
// sessions do not build up for the host's life.
func TestIdleSessionClosed(t *testing.T) {
	old := sessionTimeout
	sessionTimeout = 200 * time.Millisecond
	t.Cleanup(func() { sessionTimeout = old })
	h := newHarness(t, []string{"mail_search"})
	cs := h.connect(t, nil)
	if _, err := call(t, cs, "mail_search", map[string]any{}); err != nil {
		t.Fatalf("call while active: %v", err)
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := call(t, cs, "mail_search", map[string]any{}); err == nil {
		t.Fatal("an idle session was still served")
	}
}

// An add-on on a Thunderbird that lacks a tool's interface (Thunderbird
// 140 ESR and mail_draft) answers not_supported; the code reaches the
// client as it is.
func TestNotSupportedErrorCodeKept(t *testing.T) {
	h := newHarness(t, []string{"mail_search"})
	h.addon.setReply(func(map[string]any) map[string]any {
		return map[string]any{"ok": false, "error": map[string]any{"code": "not_supported", "message": "Needs Thunderbird 153 or later."}}
	})
	cs := h.connect(t, nil)
	res, err := call(t, cs, "mail_search", map[string]any{})
	if err != nil || !res.IsError || text(res) != "not_supported: Needs Thunderbird 153 or later." {
		t.Fatalf("err=%v text=%q", err, text(res))
	}
}

// An attachment-folder entry that is not an ordinary file (a FIFO, a
// folder, a device) is refused with its own message, not the generic one.
func TestFileErrorNotRegular(t *testing.T) {
	err := fileError(files.ErrNotRegular, "pipe")
	var ce bridge.CallError
	if !errors.As(err, &ce) || ce.Code != "refused" || !strings.Contains(ce.Message, "not an ordinary file") {
		t.Fatalf("fileError(ErrNotRegular) = %#v", err)
	}
}
