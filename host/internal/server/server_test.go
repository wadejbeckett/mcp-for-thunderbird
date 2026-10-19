// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
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
	want := filepath.Join(h.attDir, "report.pdf")
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
