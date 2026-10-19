// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/nativemsg"
)

func TestVersionCommand(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"version"}, &out)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	want := "mcp-for-thunderbird 0.0.0-dev\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
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

func readFrame(t *testing.T, r io.Reader) map[string]any {
	t.Helper()
	type res struct {
		raw []byte
		err error
	}
	ch := make(chan res, 1)
	go func() { raw, err := nativemsg.Read(r); ch <- res{raw, err} }()
	select {
	case got := <-ch:
		if got.err != nil {
			t.Fatalf("read frame: %v", got.err)
		}
		var m map[string]any
		if err := json.Unmarshal(got.raw, &m); err != nil {
			t.Fatalf("frame is not JSON: %v", err)
		}
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("no frame from the host within 5 s")
	}
	return nil
}

// TestNativeModeLifecycle runs the built binary as Thunderbird would.
func TestNativeModeLifecycle(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "mcp-for-thunderbird")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	home := filepath.Join(dir, "home")
	cfg := filepath.Join(dir, "config")
	cmd := exec.Command(bin, filepath.Join(dir, "mcp_for_thunderbird.json"), AddonID)
	cmd.Env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME="+cfg, "APPDATA="+cfg)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	hello, _ := json.Marshal(map[string]any{"type": "hello", "protocol": 1, "version": "1.0.0",
		"instance": "lifecycle", "tools": []string{"mail_search", "mail_read"}, "attachmentDir": ""})
	if err := nativemsg.Write(stdin, hello); err != nil {
		t.Fatal(err)
	}
	w := readFrame(t, stdout)
	if w["type"] != "welcome" || w["ok"] != true || w["protocol"] != float64(1) {
		t.Fatalf("welcome = %v", w)
	}
	port := int(w["port"].(float64))
	if port < 47110 || port > 47119 {
		t.Fatalf("port %d outside 47110-47119", port)
	}

	raw, err := os.ReadFile(filepath.Join(cfg, "mcp-for-thunderbird", "connection-lifecycle.json"))
	if err != nil {
		t.Fatalf("connection file: %v", err)
	}
	var conn struct {
		Port  int    `json:"port"`
		Token string `json:"token"`
		PID   int    `json:"pid"`
	}
	if err := json.Unmarshal(raw, &conn); err != nil {
		t.Fatal(err)
	}
	if conn.Port != port || len(conn.Token) != 64 || conn.PID != cmd.Process.Pid {
		t.Fatalf("connection file port %d token len %d pid %d; want port %d pid %d",
			conn.Port, len(conn.Token), conn.PID, port, cmd.Process.Pid)
	}

	// token_request is answered with the current token and URL.
	tr, _ := json.Marshal(map[string]any{"type": "token_request"})
	if err := nativemsg.Write(stdin, tr); err != nil {
		t.Fatal(err)
	}
	tok := readFrame(t, stdout)
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/mcp"
	if tok["type"] != "token" || tok["token"] != conn.Token || tok["url"] != url {
		t.Fatalf("token reply = %v", tok)
	}

	// clients_detect answers with an empty list until setup lands.
	cd, _ := json.Marshal(map[string]any{"type": "clients_detect", "req": "r1"})
	if err := nativemsg.Write(stdin, cd); err != nil {
		t.Fatal(err)
	}
	cr := readFrame(t, stdout)
	if cl, ok := cr["clients"].([]any); cr["type"] != "clients_result" || cr["req"] != "r1" || !ok || len(cl) != 0 {
		t.Fatalf("clients_result = %v", cr)
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "lifecycle-test", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cs, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: url,
		HTTPClient: &http.Client{Transport: bearer{conn.Token, http.DefaultTransport}}}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()
	lt, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	if len(lt.Tools) != 2 {
		t.Fatalf("got %d tools, want 2", len(lt.Tools))
	}

	// Closing stdin (Thunderbird exits) stops the host within 2 s, exit 0,
	// with the MCP client still connected.
	start := time.Now()
	stdin.Close()
	type exit struct {
		rest []byte
		err  error
	}
	done := make(chan exit, 1)
	go func() {
		rest, _ := io.ReadAll(stdout) // read to EOF before Wait closes the pipe
		done <- exit{rest, cmd.Wait()}
	}()
	var ex exit
	select {
	case ex = <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("host still running 2 s after stdin closed\nstderr:\n%s", stderr.String())
	}
	if ex.err != nil {
		t.Fatalf("exit: %v\nstderr:\n%s", ex.err, stderr.String())
	}
	for rest := ex.rest; len(rest) > 0; { // stdout carries frames only
		f, err := nativemsg.Read(bytes.NewReader(rest))
		if err != nil {
			t.Fatalf("stdout after EOF is not framed: %q", rest)
		}
		rest = rest[4+len(f):]
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("exit took %v", el)
	}
	if bytes.Contains(stderr.Bytes(), []byte(conn.Token)) {
		t.Fatal("token appears in stderr")
	}
}
