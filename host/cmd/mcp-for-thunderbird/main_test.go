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
	"reflect"
	"runtime"
	"strconv"
	"strings"
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
	if runtime.GOOS == "windows" {
		bin += ".exe" // without it exec cannot start the file
	}
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	// The host records its own resolved path (macOS /var -> /private/var,
	// Windows short names such as RUNNER~1).
	realBin, err := filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatal(err)
	}

	home := filepath.Join(dir, "home")
	cfg := filepath.Join(dir, "config")
	cmd := exec.Command(bin, filepath.Join(dir, "mcp_for_thunderbird.json"), AddonID)
	// Every home and config directory is a temp one, and PATH is empty, so
	// clients_detect/clients_configure never see the real AI apps (R24).
	emptyPath := filepath.Join(dir, "path")
	os.MkdirAll(emptyPath, 0o755)
	cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home, "XDG_CONFIG_HOME="+cfg,
		"APPDATA="+cfg, "LOCALAPPDATA="+cfg, "CODEX_HOME=", "CLAUDE_CONFIG_DIR=", "PATH="+emptyPath)
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

	raw, err := os.ReadFile(filepath.Join(userConfigDir(home, cfg), "mcp-for-thunderbird", "connection-lifecycle.json"))
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

	// clients_detect lists the four apps; only Cursor (its folder exists)
	// is found. clients_configure writes our entry with this binary.
	if err := os.MkdirAll(filepath.Join(home, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	cd, _ := json.Marshal(map[string]any{"type": "clients_detect", "req": "r1"})
	if err := nativemsg.Write(stdin, cd); err != nil {
		t.Fatal(err)
	}
	cr := readFrame(t, stdout)
	want := []any{
		map[string]any{"name": "claude-desktop", "found": false, "configured": false},
		map[string]any{"name": "claude-code", "found": false, "configured": false},
		map[string]any{"name": "codex", "found": false, "configured": false},
		map[string]any{"name": "cursor", "found": true, "configured": false},
	}
	if cr["type"] != "clients_result" || cr["req"] != "r1" || !reflect.DeepEqual(cr["clients"], want) {
		t.Fatalf("clients_result = %v", cr)
	}
	cc, _ := json.Marshal(map[string]any{"type": "clients_configure", "req": "r2", "clients": []string{"cursor"}})
	if err := nativemsg.Write(stdin, cc); err != nil {
		t.Fatal(err)
	}
	cr = readFrame(t, stdout)
	if cr["req"] != "r2" || !reflect.DeepEqual(cr["clients"], []any{map[string]any{"name": "cursor", "found": true, "configured": true}}) {
		t.Fatalf("clients_result = %v", cr)
	}
	var cursor struct {
		MCPServers map[string]struct {
			Command string
			Args    []string
		}
	}
	raw, err = os.ReadFile(filepath.Join(home, ".cursor", "mcp.json"))
	if err != nil || json.Unmarshal(raw, &cursor) != nil {
		t.Fatalf("mcp.json: %s %v", raw, err)
	}
	if e := cursor.MCPServers["mcp-for-thunderbird"]; e.Command != realBin || !reflect.DeepEqual(e.Args, []string{"connect"}) {
		t.Fatalf("cursor entry %+v, want command %s", e, realBin)
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
	// A clean exit clears the port and token from the connection file, so
	// no proxy sends the token to whatever binds that port next (R33).
	raw, err = os.ReadFile(filepath.Join(userConfigDir(home, cfg), "mcp-for-thunderbird", "connection-lifecycle.json"))
	if err != nil {
		t.Fatalf("connection file after exit: %v", err)
	}
	conn.Port, conn.Token = -1, "x"
	if err := json.Unmarshal(raw, &conn); err != nil {
		t.Fatal(err)
	}
	if conn.Port != 0 || conn.Token != "" {
		t.Fatalf("after exit: port %d token len %d, want port 0 and no token", conn.Port, len(conn.Token))
	}
}

// hostProc is the built binary running in native mode.
type hostProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.Reader
	stderr *bytes.Buffer
}

// buildHost builds the binary into dir.
func buildHost(t *testing.T, dir string) string {
	t.Helper()
	bin := filepath.Join(dir, "mcp-for-thunderbird")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// startHost starts bin as Thunderbird would, sandboxed under dir (R24).
func startHost(t *testing.T, bin, dir string) *hostProc {
	t.Helper()
	home, cfg := filepath.Join(dir, "home"), filepath.Join(dir, "config")
	emptyPath := filepath.Join(dir, "path")
	os.MkdirAll(emptyPath, 0o755)
	cmd := exec.Command(bin, filepath.Join(dir, "mcp_for_thunderbird.json"), AddonID)
	cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home, "XDG_CONFIG_HOME="+cfg,
		"APPDATA="+cfg, "LOCALAPPDATA="+cfg, "CODEX_HOME=", "CLAUDE_CONFIG_DIR=", "PATH="+emptyPath)
	h := &hostProc{cmd: cmd, stderr: &bytes.Buffer{}}
	var err error
	if h.stdin, err = cmd.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	if h.stdout, err = cmd.StdoutPipe(); err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = h.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return h
}

func (h *hostProc) send(t *testing.T, m map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(m)
	if err := nativemsg.Write(h.stdin, raw); err != nil {
		t.Fatal(err)
	}
}

// stop closes stdin and waits up to 2 s for exit code 0.
func (h *hostProc) stop(t *testing.T) {
	t.Helper()
	h.stdin.Close()
	done := make(chan error, 1)
	go func() { _, _ = io.Copy(io.Discard, h.stdout); done <- h.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("exit: %v\nstderr:\n%s", err, h.stderr.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("host still running 2 s after stdin closed\nstderr:\n%s", h.stderr.String())
	}
}

func hello(instance string, protocol int) map[string]any {
	return map[string]any{"type": "hello", "protocol": protocol, "version": "1.0.0",
		"instance": instance, "tools": []string{"mail_search"}, "attachmentDir": ""}
}

// R33: every start mints a new token; a token copied before a restart no
// longer works after it.
func TestFreshTokenEveryStart(t *testing.T) {
	dir := t.TempDir()
	bin := buildHost(t, dir)
	tokens := map[string]bool{}
	for i := 0; i < 2; i++ {
		h := startHost(t, bin, dir)
		h.send(t, hello("fresh", 1))
		if w := readFrame(t, h.stdout); w["ok"] != true {
			t.Fatalf("welcome = %v", w)
		}
		h.send(t, map[string]any{"type": "token_request"})
		tok := readFrame(t, h.stdout)
		token, _ := tok["token"].(string)
		if len(token) != 64 {
			t.Fatalf("token reply = %v", tok)
		}
		tokens[token] = true
		h.stop(t)
	}
	if len(tokens) != 2 {
		t.Fatal("the second start reused the first start's token")
	}
}

// After a protocol mismatch the host refuses everything but stays running
// until Thunderbird closes the pipe, so the add-on keeps showing "Update
// needed" instead of reconnecting every 25 s.
func TestProtocolMismatchWaitsForEOF(t *testing.T) {
	dir := t.TempDir()
	bin := buildHost(t, dir)
	h := startHost(t, bin, dir)
	h.send(t, hello("mismatch", 2))
	w := readFrame(t, h.stdout)
	if w["type"] != "welcome" || w["ok"] != false || w["protocol"] != float64(1) {
		t.Fatalf("welcome = %v", w)
	}
	h.send(t, hello("mismatch", 1)) // a second hello is not served
	h.send(t, map[string]any{"type": "token_request"})
	if tok := readFrame(t, h.stdout); tok["type"] != "token" || (tok["token"] != nil && tok["token"] != "") {
		t.Fatalf("token reply after a mismatch = %v", tok)
	}
	h.send(t, map[string]any{"type": "clients_detect", "req": "r1"})
	if cr := readFrame(t, h.stdout); cr["type"] != "clients_result" || len(cr["clients"].([]any)) != 0 {
		t.Fatalf("clients_result after a mismatch = %v", cr)
	}
	time.Sleep(300 * time.Millisecond)
	h.send(t, map[string]any{"type": "token_request"}) // still running and answering
	if tok := readFrame(t, h.stdout); tok["type"] != "token" || (tok["token"] != nil && tok["token"] != "") {
		t.Fatalf("second token reply = %v", tok)
	}
	if _, err := os.Stat(filepath.Join(userConfigDir(filepath.Join(dir, "home"), filepath.Join(dir, "config")),
		"mcp-for-thunderbird", "connection-mismatch.json")); err == nil {
		t.Fatal("a connection file was written after a mismatch")
	}
	h.stop(t)
}

// userConfigDir is os.UserConfigDir under the test's HOME, APPDATA and
// XDG_CONFIG_HOME: the connection file lives there.
func userConfigDir(home, cfg string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support")
	default: // XDG_CONFIG_HOME on Linux, APPDATA on Windows
		return cfg
	}
}

// setupEnv sandboxes every home and config directory and PATH for an
// in-process run of the setup subcommand (R24), and on Windows the HKCU
// registration key.
func setupEnv(t *testing.T) string {
	t.Helper()
	sandboxRegistry(t)
	home := t.TempDir()
	for k, v := range map[string]string{"HOME": home, "USERPROFILE": home,
		"XDG_CONFIG_HOME": filepath.Join(home, ".config"), "APPDATA": filepath.Join(home, "AppData"),
		"LOCALAPPDATA": filepath.Join(home, "Local"), "CODEX_HOME": "", "CLAUDE_CONFIG_DIR": "",
		"PATH": t.TempDir()} {
		t.Setenv(k, v)
	}
	return home
}

func TestSetupNativeOnly(t *testing.T) {
	home := setupEnv(t)
	os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
	var out bytes.Buffer
	if code := run([]string{"setup", "--native-only"}, &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	m := nativeManifest(t, home)
	checkRegistered(t, m)
	raw, err := os.ReadFile(m)
	if err != nil {
		t.Fatal(err)
	}
	var man struct{ Path string }
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)
	if json.Unmarshal(raw, &man) != nil || man.Path != exe {
		t.Fatalf("manifest path %q, want %q", man.Path, exe)
	}
	if strings.Contains(out.String(), "cursor") {
		t.Fatalf("--native-only listed apps: %s", out.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".cursor", "mcp.json")); err == nil {
		t.Fatal("--native-only configured an app")
	}
}

func TestSetupDetectsAndConfiguresOnlyNamedClients(t *testing.T) {
	home := setupEnv(t)
	os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
	os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
	var out bytes.Buffer
	if code := run([]string{"setup"}, &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	if !strings.Contains(out.String(), "cursor: found") || !strings.Contains(out.String(), "claude-code: not found") {
		t.Fatalf("output: %s", out.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".cursor", "mcp.json")); err == nil {
		t.Fatal("plain setup configured an app")
	}
	out.Reset()
	if code := run([]string{"setup", "--clients=cursor"}, &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".cursor", "mcp.json")); err != nil {
		t.Fatalf("cursor not configured: %v\n%s", err, out.String())
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "config.toml")); err == nil {
		t.Fatal("codex configured without being named")
	}
	// A failure gives exit 1.
	out.Reset()
	if code := run([]string{"setup", "--clients=claude-code"}, &out); code != 1 {
		t.Fatalf("missing app exit %d: %s", code, out.String())
	}
	// --uninstall removes the manifest and our cursor entry.
	out.Reset()
	if code := run([]string{"setup", "--uninstall"}, &out); code != 0 {
		t.Fatalf("uninstall exit %d: %s", code, out.String())
	}
	if _, err := os.Stat(nativeManifest(t, home)); err == nil {
		t.Fatal("manifest left after uninstall")
	}
	checkRegistered(t, "")
	raw, _ := os.ReadFile(filepath.Join(home, ".cursor", "mcp.json"))
	if strings.Contains(string(raw), "mcp-for-thunderbird") {
		t.Fatalf("cursor entry left: %s", raw)
	}
	if code := run([]string{"setup", "--uninstall", "--clients=cursor"}, &out); code != 2 {
		t.Fatalf("conflicting flags exit %d", code)
	}
}
