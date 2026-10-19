// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/nativemsg"
)

// fakeAddon is the Thunderbird side of the pipe pair.
type fakeAddon struct {
	t      *testing.T
	toHost *io.PipeWriter // add-on writes here; the bridge reads
	fromHo *io.PipeReader // bridge writes; the add-on reads
	b      *Bridge
}

func newPair(t *testing.T) (*Bridge, *fakeAddon) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	b := New(inR, outW, "9.9.9")
	b.SetCallTimeout(5 * time.Second)
	f := &fakeAddon{t: t, toHost: inW, fromHo: outR, b: b}
	t.Cleanup(func() { inW.Close(); outR.Close() })
	return b, f
}

func (f *fakeAddon) send(m map[string]any) {
	f.t.Helper()
	raw, _ := json.Marshal(m)
	if err := nativemsg.Write(f.toHost, raw); err != nil {
		f.t.Fatalf("fake send: %v", err)
	}
}

func (f *fakeAddon) recv() map[string]any {
	f.t.Helper()
	raw, err := nativemsg.Read(f.fromHo)
	if err != nil {
		f.t.Fatalf("fake recv: %v", err)
	}
	if len(raw) > nativemsg.MaxOutgoing {
		f.t.Fatalf("frame of %d bytes exceeds 1 MiB", len(raw))
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		f.t.Fatal(err)
	}
	return m
}

func (f *fakeAddon) hello(protocol int) {
	f.send(map[string]any{"type": "hello", "protocol": protocol, "version": "1.2.3",
		"instance": "inst-1", "tools": []string{"mail_search"}, "attachmentDir": "/tmp/att"})
}

func TestHelloWelcome(t *testing.T) {
	b, f := newPair(t)
	go f.hello(1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	h, err := b.WaitHello(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if h.Protocol != 1 || h.Version != "1.2.3" || h.Instance != "inst-1" ||
		len(h.Tools) != 1 || h.Tools[0] != "mail_search" || h.AttachmentDir != "/tmp/att" {
		t.Fatalf("hello = %+v", h)
	}
	go func() { _ = b.SendWelcome(47110, "") }()
	w := f.recv()
	if w["type"] != "welcome" || w["ok"] != true || w["port"] != float64(47110) ||
		w["protocol"] != float64(1) || w["version"] != "9.9.9" {
		t.Fatalf("welcome = %v", w)
	}
	if _, has := w["error"]; has {
		t.Fatal("welcome ok must not carry error")
	}
	go func() { _ = b.SendWelcome(0, "port range busy") }()
	w = f.recv()
	if w["ok"] != false || w["error"] != "port range busy" {
		t.Fatalf("welcome = %v", w)
	}
}

func TestProtocolMismatch(t *testing.T) {
	b, f := newPair(t)
	go f.hello(2)
	w := make(chan map[string]any, 1)
	go func() { w <- f.recv() }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := b.WaitHello(ctx); err == nil {
		t.Fatal("WaitHello should fail on protocol 2")
	}
	got := <-w
	if got["type"] != "welcome" || got["ok"] != false || got["error"] == "" || got["error"] == nil {
		t.Fatalf("welcome = %v", got)
	}
}

func TestConcurrentCallsMatchIds(t *testing.T) {
	b, f := newPair(t)
	const n = 50
	// Fake: collect all calls, then answer in reverse order.
	go func() {
		var ids []string
		var args []string
		for i := 0; i < n; i++ {
			m := f.recv()
			if m["type"] != "call" || m["tool"] != "mail_read" || m["client"] != "tester" {
				t.Errorf("call = %v", m)
			}
			ids = append(ids, m["id"].(string))
			args = append(args, string(mustJSON(m["args"])))
		}
		for i := n - 1; i >= 0; i-- {
			f.send(map[string]any{"type": "result", "id": ids[i], "ok": true,
				"content": map[string]any{"echo": json.RawMessage(args[i])}})
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := b.Call(context.Background(), "mail_read",
				json.RawMessage(fmt.Sprintf(`{"n":%d}`, i)), "tester", nil)
			if err != nil {
				t.Errorf("call %d: %v", i, err)
				return
			}
			want := fmt.Sprintf(`{"echo":{"n":%d}}`, i)
			if string(res.Content) != want {
				t.Errorf("call %d got %s want %s", i, res.Content, want)
			}
		}(i)
	}
	wg.Wait()
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestCallError(t *testing.T) {
	b, f := newPair(t)
	go func() {
		m := f.recv()
		f.send(map[string]any{"type": "result", "id": m["id"], "ok": false,
			"error": map[string]any{"code": "paused", "message": "Paused by the user in Thunderbird"}})
	}()
	_, err := b.Call(context.Background(), "mail_search", json.RawMessage(`{}`), "x", nil)
	var ce CallError
	if !errors.As(err, &ce) || ce.Code != "paused" || ce.Message != "Paused by the user in Thunderbird" {
		t.Fatalf("err = %#v", err)
	}
}

func TestCallTimeout(t *testing.T) {
	b, f := newPair(t)
	b.SetCallTimeout(50 * time.Millisecond)
	go f.recv() // swallow the call, never answer
	start := time.Now()
	_, err := b.Call(context.Background(), "mail_search", json.RawMessage(`{}`), "x", nil)
	var ce CallError
	if !errors.As(err, &ce) || ce.Code != "thunderbird_error" || ce.Message != "Thunderbird did not answer in 60 s" {
		t.Fatalf("err = %#v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("timeout took too long")
	}
	// A late answer for the timed-out id must not break anything.
	f.send(map[string]any{"type": "result", "id": "gone", "ok": true, "content": 1})
}

func TestContextCancel(t *testing.T) {
	b, f := newPair(t)
	go f.recv()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	_, err := b.Call(ctx, "mail_search", json.RawMessage(`{}`), "x", nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestBlobChunking(t *testing.T) {
	b, f := newPair(t)
	blob := make([]byte, 2<<20)
	for i := range blob {
		blob[i] = byte(i * 7)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		var got []byte
		var blobID string
		chunks := 0
		for {
			m := f.recv()
			if m["type"] == "call" {
				ids, _ := m["blobs"].([]any)
				if len(ids) != 1 || ids[0] != blobID {
					t.Errorf("call blobs = %v, blob id %q", m["blobs"], blobID)
				}
				f.send(map[string]any{"type": "result", "id": m["id"], "ok": true, "content": "done"})
				break
			}
			if m["type"] != "blob" {
				t.Errorf("unexpected %v", m["type"])
				return
			}
			if int(m["seq"].(float64)) != chunks {
				t.Errorf("seq = %v, want %d", m["seq"], chunks)
			}
			blobID = m["blob"].(string)
			piece, err := base64.StdEncoding.DecodeString(m["data"].(string))
			if err != nil {
				t.Error(err)
			}
			got = append(got, piece...)
			chunks++
			if last := m["last"].(bool); last != (chunks == 3) {
				t.Errorf("chunk %d last = %v", chunks, last)
			}
		}
		if chunks != 3 {
			t.Errorf("chunks = %d, want 3", chunks)
		}
		if !bytes.Equal(got, blob) {
			t.Error("reassembled blob differs")
		}
	}()
	if _, err := b.Call(context.Background(), "mail_compose", json.RawMessage(`{}`), "x", [][]byte{blob}); err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestEOFFailsPending(t *testing.T) {
	b, f := newPair(t)
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() {
			_, err := b.Call(context.Background(), "mail_search", json.RawMessage(`{}`), "x", nil)
			errs <- err
		}()
	}
	for i := 0; i < 3; i++ {
		f.recv()
	}
	f.toHost.Close()
	for i := 0; i < 3; i++ {
		var ce CallError
		if err := <-errs; !errors.As(err, &ce) || ce.Code != "thunderbird_error" || ce.Message != "Thunderbird closed" {
			t.Fatalf("err = %#v", err)
		}
	}
	// New calls after close fail at once.
	_, err := b.Call(context.Background(), "mail_search", json.RawMessage(`{}`), "x", nil)
	var ce CallError
	if !errors.As(err, &ce) || ce.Message != "Thunderbird closed" {
		t.Fatalf("post-close err = %#v", err)
	}
}

func TestToolsUpdateCallback(t *testing.T) {
	b, f := newPair(t)
	got := make(chan []string, 1)
	b.OnTools(func(t []string) { got <- t })
	cfg := make(chan string, 1)
	b.OnConfig(func(d string) { cfg <- d })
	rot := make(chan struct{}, 1)
	b.OnRotate(func() { rot <- struct{}{} })
	b.OnTokenRequest(func() (string, string) { return "tok", "http://127.0.0.1:47110/mcp" })
	b.OnClients(func(configure []string) []ClientStatus {
		if configure != nil {
			return []ClientStatus{{Name: configure[0], Found: true, Configured: true}}
		}
		return []ClientStatus{{Name: "cursor", Found: true, Error: "boom"}}
	})
	b.Start()

	f.send(map[string]any{"type": "tools", "tools": []string{"mail_read", "mail_mark"}})
	if v := <-got; len(v) != 2 || v[0] != "mail_read" || v[1] != "mail_mark" {
		t.Fatalf("tools = %v", v)
	}
	f.send(map[string]any{"type": "config", "attachmentDir": "/x"})
	if v := <-cfg; v != "/x" {
		t.Fatalf("config = %q", v)
	}
	f.send(map[string]any{"type": "rotate_token"})
	<-rot

	f.send(map[string]any{"type": "token_request"})
	m := f.recv()
	if m["type"] != "token" || m["token"] != "tok" || m["url"] != "http://127.0.0.1:47110/mcp" {
		t.Fatalf("token msg = %v", m)
	}
	f.send(map[string]any{"type": "clients_detect", "req": "r1"})
	m = f.recv()
	cl := m["clients"].([]any)[0].(map[string]any)
	if m["type"] != "clients_result" || m["req"] != "r1" || cl["name"] != "cursor" ||
		cl["found"] != true || cl["configured"] != false || cl["error"] != "boom" {
		t.Fatalf("clients_result = %v", m)
	}
	f.send(map[string]any{"type": "clients_configure", "req": "r2", "clients": []string{"claude"}})
	m = f.recv()
	cl = m["clients"].([]any)[0].(map[string]any)
	if m["req"] != "r2" || cl["name"] != "claude" || cl["configured"] != true {
		t.Fatalf("clients_result = %v", m)
	}
	if _, has := cl["error"]; has {
		t.Fatal("empty error must be omitted")
	}
}

func TestResultWithSave(t *testing.T) {
	b, f := newPair(t)
	payload := []byte("%PDF-1.4 hello")
	go func() {
		m := f.recv()
		f.send(map[string]any{"type": "result", "id": m["id"], "ok": true,
			"content": map[string]any{"saved": true},
			"save":    map[string]any{"name": "a.pdf", "data": base64.StdEncoding.EncodeToString(payload)}})
	}()
	res, err := b.Call(context.Background(), "mail_attachment", json.RawMessage(`{}`), "x", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Save == nil || res.Save.Name != "a.pdf" || !bytes.Equal(res.Save.Data, payload) {
		t.Fatalf("save = %+v", res.Save)
	}
	if string(res.Content) != `{"saved":true}` {
		t.Fatalf("content = %s", res.Content)
	}
}
