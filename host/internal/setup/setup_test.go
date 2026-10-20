// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/bridge"
)

// sandbox points every home and configuration directory at a fresh temp
// directory and PATH at an empty temp bin directory, so no test can read
// or change the real ~/.mozilla, ~/.config, ~/.claude*, ~/.codex or
// ~/.cursor, or run the real claude binary (ruling R24).
func sandbox(t *testing.T) (home, bin string) {
	t.Helper()
	home = t.TempDir()
	bin = t.TempDir()
	cfg := filepath.Join(home, ".config")
	appdata := filepath.Join(home, "AppData", "Roaming")
	for k, v := range map[string]string{
		"HOME":              home,
		"USERPROFILE":       home,
		"XDG_CONFIG_HOME":   cfg,
		"APPDATA":           appdata,
		"LOCALAPPDATA":      filepath.Join(home, "AppData", "Local"),
		"CODEX_HOME":        "",
		"CLAUDE_CONFIG_DIR": "",
		"PATH":              bin,
	} {
		t.Setenv(k, v)
	}
	if h, err := os.UserHomeDir(); err != nil || h != home {
		t.Fatalf("home not sandboxed: %q %v", h, err)
	}
	return home, bin
}

// fakeClaude installs a claude script on the sandbox PATH that appends its
// arguments (one per line, then "--end--") to a log file and exits with
// code. It returns the log path.
func fakeClaude(t *testing.T, bin string, code int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake claude is a shell script")
	}
	logf := filepath.Join(t.TempDir(), "claude-args.log")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >>'" + logf + "'; done\n" +
		"printf -- '--end--\\n' >>'" + logf + "'\nexit " + itoa(code) + "\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return logf
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("%s: %v\n%s", path, err, b)
	}
	return m
}

func backups(t *testing.T, file string) []string {
	t.Helper()
	m, err := filepath.Glob(file + ".bak-*")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func status(t *testing.T, st []bridge.ClientStatus, name string) bridge.ClientStatus {
	t.Helper()
	for _, s := range st {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no status for %s in %+v", name, st)
	return bridge.ClientStatus{}
}

// binPath is an absolute path on this OS (Configure refuses a relative
// one, and "/opt/..." is relative on Windows); binJSON and binTOML are
// how it is written in the JSON and TOML files.
var binPath, binJSON, binTOML = "/opt/mft/mcp-for-thunderbird", `"/opt/mft/mcp-for-thunderbird"`, `"/opt/mft/mcp-for-thunderbird"`

func init() {
	if runtime.GOOS == "windows" {
		binPath, binJSON, binTOML = `C:\mft\mcp-for-thunderbird.exe`, `"C:\\mft\\mcp-for-thunderbird.exe"`, `"C:\\mft\\mcp-for-thunderbird.exe"`
	}
}

func TestBinPathIsAbsolute(t *testing.T) {
	if !filepath.IsAbs(binPath) {
		t.Fatalf("test binary path %q is not absolute on %s", binPath, runtime.GOOS)
	}
}

func TestNativeManifestContent(t *testing.T) {
	got := ManifestJSON("/opt/mft/mcp-for-thunderbird")
	want := `{
  "name": "mcp_for_thunderbird",
  "description": "MCP for Thunderbird host",
  "path": "/opt/mft/mcp-for-thunderbird",
  "type": "stdio",
  "allowed_extensions": [
    "mcp-for-thunderbird@wadejbeckett.github.io"
  ]
}
`
	if string(got) != want {
		t.Fatalf("manifest:\n%s\nwant:\n%s", got, want)
	}
	// A path that needs escaping stays valid JSON with the exact value.
	odd := `C:\Program Files\"MFT"\mcp-for-thunderbird.exe`
	var m struct{ Path string }
	if err := json.Unmarshal(ManifestJSON(odd), &m); err != nil || m.Path != odd {
		t.Fatalf("escaped path: %q %v", m.Path, err)
	}
}

func TestRegisterLinuxPath(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux path")
	}
	home, _ := sandbox(t)
	if err := RegisterNative(binPath); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(home, ".mozilla", "native-messaging-hosts", "mcp_for_thunderbird.json")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != string(ManifestJSON(binPath)) {
		t.Fatalf("content: %s", b)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	// Registering again (a moved binary) replaces it.
	if err := RegisterNative("/new/place/mcp-for-thunderbird"); err != nil {
		t.Fatal(err)
	}
	if m := readJSON(t, p); m["path"] != "/new/place/mcp-for-thunderbird" {
		t.Fatalf("not replaced: %v", m)
	}
	if err := UnregisterNative(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("manifest not removed: %v", err)
	}
	if err := UnregisterNative(); err != nil {
		t.Fatalf("second unregister: %v", err)
	}
}

func TestRegisterRelativePathRefused(t *testing.T) {
	sandbox(t)
	if err := RegisterNative("mcp-for-thunderbird"); err == nil {
		t.Fatal("relative binary path accepted")
	}
}

// claudeDesktopConfig creates the Claude Desktop configuration directory
// for this OS (on Linux, the file itself) and returns the file path.
func claudeDesktopConfig(t *testing.T, home, content string) string {
	t.Helper()
	var dir string
	switch runtime.GOOS {
	case "darwin":
		dir = filepath.Join(home, "Library", "Application Support", "Claude")
	case "windows":
		dir = filepath.Join(os.Getenv("APPDATA"), "Claude")
	default:
		dir = filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "Claude")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "claude_desktop_config.json")
	if content != "" {
		if err := os.WriteFile(p, []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func TestClaudeDesktopMergeKeepsOthers(t *testing.T) {
	home, _ := sandbox(t)
	orig := `{"zeta": 1, "mcpServers": {"other": {"command": "x", "args": ["y"], "env": {"K": "V"}}}, "alpha": {"deep": [1, 2]}}`
	p := claudeDesktopConfig(t, home, orig)
	if s := status(t, detect(binPath), "claude-desktop"); !s.Found || s.Configured {
		t.Fatalf("detect before: %+v", s)
	}
	st := Configure([]string{"claude-desktop"}, binPath)
	if s := status(t, st, "claude-desktop"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	m := readJSON(t, p)
	if m["zeta"] != float64(1) || !reflect.DeepEqual(m["alpha"], map[string]any{"deep": []any{float64(1), float64(2)}}) {
		t.Fatalf("other keys lost: %v", m)
	}
	servers := m["mcpServers"].(map[string]any)
	if !reflect.DeepEqual(servers["other"], map[string]any{"command": "x", "args": []any{"y"}, "env": map[string]any{"K": "V"}}) {
		t.Fatalf("other server changed: %v", servers["other"])
	}
	want := map[string]any{"command": binPath, "args": []any{"connect"}}
	if !reflect.DeepEqual(servers["mcp-for-thunderbird"], want) {
		t.Fatalf("entry: %v", servers["mcp-for-thunderbird"])
	}
	// Key order is kept: zeta, mcpServers, alpha; other before ours.
	b, _ := os.ReadFile(p)
	s := string(b)
	if !(strings.Index(s, `"zeta"`) < strings.Index(s, `"mcpServers"`) &&
		strings.Index(s, `"mcpServers"`) < strings.Index(s, `"alpha"`) &&
		strings.Index(s, `"other"`) < strings.Index(s, `"mcp-for-thunderbird"`)) {
		t.Fatalf("key order changed:\n%s", s)
	}
	if fi, _ := os.Stat(p); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode not kept: %v", fi.Mode().Perm())
	}
	if s := status(t, detect(binPath), "claude-desktop"); !s.Configured {
		t.Fatalf("detect after: %+v", s)
	}
	// Uninstall removes ours only.
	for _, s := range Uninstall() {
		if s.Error != "" {
			t.Fatalf("uninstall: %+v", s)
		}
	}
	servers = readJSON(t, p)["mcpServers"].(map[string]any)
	if _, ok := servers["mcp-for-thunderbird"]; ok || servers["other"] == nil {
		t.Fatalf("uninstall result: %v", servers)
	}
}

func TestClaudeDesktopLinuxNeedsConfigFile(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux rule")
	}
	home, _ := sandbox(t)
	claudeDesktopConfig(t, home, "") // directory only
	if s := status(t, detect(binPath), "claude-desktop"); s.Found {
		t.Fatalf("found without a config file: %+v", s)
	}
	s := status(t, Configure([]string{"claude-desktop"}, binPath), "claude-desktop")
	if s.Configured || s.Error == "" {
		t.Fatalf("configured without a config file: %+v", s)
	}
}

func TestBackupWritten(t *testing.T) {
	home, _ := sandbox(t)
	dir := filepath.Join(home, ".cursor")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "mcp.json")
	orig := `{"mcpServers": {"a": {"command": "a"}}}`
	os.WriteFile(p, []byte(orig), 0o600)
	Configure([]string{"cursor"}, binPath)
	bk := backups(t, p)
	if len(bk) != 1 {
		t.Fatalf("backups: %v", bk)
	}
	if !regexp.MustCompile(`\.bak-\d{8}-\d{6}$`).MatchString(bk[0]) {
		t.Fatalf("backup name: %s", bk[0])
	}
	if b, _ := os.ReadFile(bk[0]); string(b) != orig {
		t.Fatalf("backup content: %s", b)
	}
	// Configured already: no change, no new backup.
	Configure([]string{"cursor"}, binPath)
	if bk := backups(t, p); len(bk) != 1 {
		t.Fatalf("backup on a no-op: %v", bk)
	}
	// A second change in the same second does not overwrite the first backup.
	Uninstall()
	bk = backups(t, p)
	if len(bk) != 2 {
		t.Fatalf("backups after uninstall: %v", bk)
	}
	found := false
	for _, f := range bk {
		if b, _ := os.ReadFile(f); string(b) == orig {
			found = true
		}
	}
	if !found {
		t.Fatal("original backup overwritten")
	}
	// A file created by setup gets no backup.
	codex := filepath.Join(home, ".codex")
	os.MkdirAll(codex, 0o755)
	Configure([]string{"codex"}, binPath)
	if bk := backups(t, filepath.Join(codex, "config.toml")); len(bk) != 0 {
		t.Fatalf("backup of a new file: %v", bk)
	}
}

func TestCursorMerge(t *testing.T) {
	home, _ := sandbox(t)
	dir := filepath.Join(home, ".cursor")
	if s := status(t, detect(binPath), "cursor"); s.Found {
		t.Fatalf("found before install: %+v", s)
	}
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "mcp.json")
	// No mcp.json yet: created.
	if s := status(t, Configure([]string{"cursor"}, binPath), "cursor"); !s.Configured || s.Error != "" {
		t.Fatalf("configure new: %+v", s)
	}
	m := readJSON(t, p)
	want := map[string]any{"mcpServers": map[string]any{"mcp-for-thunderbird": map[string]any{"command": binPath, "args": []any{"connect"}}}}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("new file: %v", m)
	}
	// Existing with another server and a stale entry of ours: merged, ours replaced.
	os.WriteFile(p, []byte(`{"mcpServers":{"mcp-for-thunderbird":{"command":"/old"},"b":{"url":"http://x"}},"x":true}`), 0o600)
	if s := status(t, detect(binPath), "cursor"); !s.Found || s.Configured {
		t.Fatalf("stale entry reported configured: %+v", s)
	}
	Configure([]string{"cursor"}, binPath)
	m = readJSON(t, p)
	servers := m["mcpServers"].(map[string]any)
	if m["x"] != true || servers["b"] == nil || !reflect.DeepEqual(servers["mcp-for-thunderbird"], want["mcpServers"].(map[string]any)["mcp-for-thunderbird"]) {
		t.Fatalf("merge: %v", m)
	}
	// Broken JSON is left alone with an error.
	os.WriteFile(p, []byte(`{"mcpServers": {`), 0o600)
	s := status(t, Configure([]string{"cursor"}, binPath), "cursor")
	if s.Error == "" || s.Configured {
		t.Fatalf("broken JSON: %+v", s)
	}
	if b, _ := os.ReadFile(p); string(b) != `{"mcpServers": {` {
		t.Fatalf("broken file changed: %s", b)
	}
	// mcpServers of the wrong type is left alone with an error.
	os.WriteFile(p, []byte(`{"mcpServers": []}`), 0o600)
	if s := status(t, Configure([]string{"cursor"}, binPath), "cursor"); s.Error == "" {
		t.Fatalf("array mcpServers: %+v", s)
	}
}

func codexSetup(t *testing.T, home, content string) string {
	t.Helper()
	dir := filepath.Join(home, ".codex")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "config.toml")
	if content != "" {
		os.WriteFile(p, []byte(content), 0o600)
	}
	return p
}

func TestCodexAppendOnce(t *testing.T) {
	home, _ := sandbox(t)
	orig := "# my settings\nmodel = \"o3\" # inline comment\n\n[mcp_servers.other]\ncommand = \"x\"\n"
	p := codexSetup(t, home, orig)
	if s := status(t, detect(binPath), "codex"); !s.Found || s.Configured {
		t.Fatalf("detect: %+v", s)
	}
	if s := status(t, Configure([]string{"codex"}, binPath), "codex"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	b, _ := os.ReadFile(p)
	want := orig + "\n[mcp_servers.mcp-for-thunderbird]\ncommand = " + binTOML + "\nargs = [\"connect\"]\n"
	if string(b) != want {
		t.Fatalf("config.toml:\n%s\nwant:\n%s", b, want)
	}
	fi1, _ := os.Stat(p)
	if s := status(t, Configure([]string{"codex"}, binPath), "codex"); !s.Configured || s.Error != "" {
		t.Fatalf("second configure: %+v", s)
	}
	b2, _ := os.ReadFile(p)
	fi2, _ := os.Stat(p)
	if string(b2) != want || !fi1.ModTime().Equal(fi2.ModTime()) {
		t.Fatalf("second run changed the file:\n%s", b2)
	}
	if bk := backups(t, p); len(bk) != 1 {
		t.Fatalf("backups: %v", bk)
	}
	if s := status(t, detect(binPath), "codex"); !s.Configured {
		t.Fatalf("detect after: %+v", s)
	}
	// Uninstall removes our table only and keeps the comments.
	Uninstall()
	if b, _ := os.ReadFile(p); string(b) != orig {
		t.Fatalf("after uninstall:\n%q\nwant:\n%q", b, orig)
	}
	// A file without a trailing newline still gets a well-formed table.
	os.WriteFile(p, []byte("model = \"o3\""), 0o600)
	Configure([]string{"codex"}, binPath)
	if s := status(t, detect(binPath), "codex"); !s.Configured {
		b, _ := os.ReadFile(p)
		t.Fatalf("no trailing newline:\n%s", b)
	}
}

func TestCodexPathQuoted(t *testing.T) {
	home, _ := sandbox(t)
	p := codexSetup(t, home, "")
	win := filepath.Join(home, `A "B"\C`, "mcp-for-thunderbird")
	if s := status(t, Configure([]string{"codex"}, win), "codex"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	cmd, args, ok, err := codexEntry(p)
	if err != nil || !ok || cmd != win || !reflect.DeepEqual(args, []string{"connect"}) {
		t.Fatalf("round trip: %q %v %v %v", cmd, args, ok, err)
	}
}

func TestCodexConflictReported(t *testing.T) {
	home, _ := sandbox(t)
	orig := "[mcp_servers.mcp-for-thunderbird]\ncommand = \"/somewhere/else\"\nargs = [\"connect\"]\n"
	p := codexSetup(t, home, orig)
	if s := status(t, detect(binPath), "codex"); s.Configured {
		t.Fatalf("different entry reported configured: %+v", s)
	}
	s := status(t, Configure([]string{"codex"}, binPath), "codex")
	if s.Error == "" || s.Configured {
		t.Fatalf("conflict not reported: %+v", s)
	}
	if b, _ := os.ReadFile(p); string(b) != orig {
		t.Fatalf("file changed:\n%s", b)
	}
	if bk := backups(t, p); len(bk) != 0 {
		t.Fatalf("backup on refusal: %v", bk)
	}
	// An inline mcp_servers table cannot take an appended table: error, unchanged.
	inline := "mcp_servers = { other = { command = \"x\" } }\n"
	os.WriteFile(p, []byte(inline), 0o600)
	if s := status(t, Configure([]string{"codex"}, binPath), "codex"); s.Error == "" {
		t.Fatalf("inline table: %+v", s)
	}
	if b, _ := os.ReadFile(p); string(b) != inline {
		t.Fatalf("inline file changed:\n%s", b)
	}
}

func TestClaudeCodeRunsClaudeOnPath(t *testing.T) {
	home, bin := sandbox(t)
	if s := status(t, detect(binPath), "claude-code"); s.Found {
		t.Fatalf("found without claude on PATH: %+v", s)
	}
	logf := fakeClaude(t, bin, 0)
	if s := status(t, detect(binPath), "claude-code"); !s.Found || s.Configured {
		t.Fatalf("detect: %+v", s)
	}
	cj := filepath.Join(home, ".claude.json")
	os.WriteFile(cj, []byte(`{"numStartups": 3}`), 0o600)
	if s := status(t, Configure([]string{"claude-code"}, binPath), "claude-code"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	b, _ := os.ReadFile(logf)
	want := "mcp\nadd\n--scope\nuser\nmcp-for-thunderbird\n--\n" + binPath + "\nconnect\n--end--\n"
	if string(b) != want {
		t.Fatalf("claude args:\n%s\nwant:\n%s", b, want)
	}
	if bk := backups(t, cj); len(bk) != 1 {
		t.Fatalf("~/.claude.json backup: %v", bk)
	}
	// Once ~/.claude.json lists our entry, configure is a no-op and
	// uninstall runs claude mcp remove.
	os.WriteFile(cj, []byte(`{"mcpServers":{"mcp-for-thunderbird":{"type":"stdio","command":"`+binPath+`","args":["connect"],"env":{}}}}`), 0o600)
	os.Remove(logf)
	if s := status(t, detect(binPath), "claude-code"); !s.Configured {
		t.Fatalf("detect configured: %+v", s)
	}
	Configure([]string{"claude-code"}, binPath)
	if _, err := os.Stat(logf); !os.IsNotExist(err) {
		b, _ := os.ReadFile(logf)
		t.Fatalf("claude ran on a no-op: %s", b)
	}
	Uninstall()
	b, _ = os.ReadFile(logf)
	if string(b) != "mcp\nremove\n--scope\nuser\nmcp-for-thunderbird\n--end--\n" {
		t.Fatalf("remove args:\n%s", b)
	}
}

func TestClaudeCodeFailureReported(t *testing.T) {
	_, bin := sandbox(t)
	fakeClaude(t, bin, 3)
	s := status(t, Configure([]string{"claude-code"}, binPath), "claude-code")
	if s.Error == "" || s.Configured {
		t.Fatalf("failure not reported: %+v", s)
	}
}

func TestDetectMissing(t *testing.T) {
	sandbox(t)
	st := Detect()
	names := []string{}
	for _, s := range st {
		names = append(names, s.Name)
		if s.Found || s.Configured || s.Error != "" {
			t.Fatalf("empty home: %+v", s)
		}
	}
	if !reflect.DeepEqual(names, []string{"claude-desktop", "claude-code", "codex", "cursor"}) {
		t.Fatalf("names: %v", names)
	}
	for _, s := range Configure([]string{"cursor", "nonsense"}, binPath) {
		if s.Configured || s.Error == "" {
			t.Fatalf("configure missing: %+v", s)
		}
	}
	// Detect checks entries against the running binary.
	if exe, err := Executable(); err != nil || !filepath.IsAbs(exe) {
		t.Fatalf("executable: %q %v", exe, err)
	}
	// Nothing was created.
	home, _ := os.UserHomeDir()
	if ents, _ := os.ReadDir(home); len(ents) != 0 {
		t.Fatalf("home not empty: %v", ents)
	}
}

func TestCodexRemoveMiddleKeepsNeighbours(t *testing.T) {
	home, _ := sandbox(t)
	orig := "model = \"o3\"\n\n[mcp_servers.mcp-for-thunderbird]\ncommand = \"/x\"\nargs = [\"connect\"]\n\n[mcp_servers.mcp-for-thunderbird.env]\nA = \"1\"\n\n# the next table\n[profiles.fast]\nmodel = \"o4\" # keep\n"
	p := codexSetup(t, home, orig)
	for _, s := range Uninstall() {
		if s.Error != "" {
			t.Fatalf("uninstall: %+v", s)
		}
	}
	b, _ := os.ReadFile(p)
	want := "model = \"o3\"\n\n\n# the next table\n[profiles.fast]\nmodel = \"o4\" # keep\n"
	if string(b) != want {
		t.Fatalf("after remove:\n%q\nwant:\n%q", b, want)
	}
	if bk := backups(t, p); len(bk) != 1 {
		t.Fatalf("backups: %v", bk)
	}
}

func TestJSONMergeExactBytesWithKeyAfterServers(t *testing.T) {
	home, _ := sandbox(t)
	dir := filepath.Join(home, ".cursor")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "mcp.json")
	os.WriteFile(p, []byte(`{"a":1,"mcpServers":{"o":{"command":"x"}},"z":[1,{"b":2}]}`), 0o600)
	Configure([]string{"cursor"}, binPath)
	b, _ := os.ReadFile(p)
	want := `{
  "a": 1,
  "mcpServers": {
    "o": {
      "command": "x"
    },
    "mcp-for-thunderbird": {
      "command": ` + binJSON + `,
      "args": [
        "connect"
      ]
    }
  },
  "z": [
    1,
    {
      "b": 2
    }
  ]
}
`
	if string(b) != want {
		t.Fatalf("merged:\n%s\nwant:\n%s", b, want)
	}
	Uninstall()
	b, _ = os.ReadFile(p)
	want = "{\n  \"a\": 1,\n  \"mcpServers\": {\n    \"o\": {\n      \"command\": \"x\"\n    }\n  },\n  \"z\": [\n    1,\n    {\n      \"b\": 2\n    }\n  ]\n}\n"
	if string(b) != want {
		t.Fatalf("after uninstall:\n%s", b)
	}
	// An object emptied by uninstall stays valid.
	os.WriteFile(p, []byte(`{"mcpServers":{}, "k": true}`), 0o600)
	Configure([]string{"cursor"}, binPath)
	Uninstall()
	if b, _ := os.ReadFile(p); string(b) != "{\n  \"mcpServers\": {},\n  \"k\": true\n}\n" {
		t.Fatalf("empty servers:\n%s", b)
	}
}

func TestNullServersTreatedAsAbsent(t *testing.T) {
	home, _ := sandbox(t)
	dir := filepath.Join(home, ".cursor")
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "mcp.json")
	os.WriteFile(p, []byte(`{"mcpServers": null, "k": 1}`), 0o600)
	if s := status(t, Configure([]string{"cursor"}, binPath), "cursor"); !s.Configured || s.Error != "" {
		t.Fatalf("null mcpServers: %+v", s)
	}
	m := readJSON(t, p)
	if m["k"] != float64(1) || m["mcpServers"].(map[string]any)["mcp-for-thunderbird"] == nil {
		t.Fatalf("result: %v", m)
	}
}

func TestSymlinkedConfigKeepsLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	home, _ := sandbox(t)
	dir := filepath.Join(home, ".cursor")
	os.MkdirAll(dir, 0o755)
	target := filepath.Join(home, "dotfiles", "cursor-mcp.json")
	os.MkdirAll(filepath.Dir(target), 0o755)
	os.WriteFile(target, []byte(`{"mcpServers":{}}`), 0o600)
	link := filepath.Join(dir, "mcp.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if s := status(t, Configure([]string{"cursor"}, binPath), "cursor"); !s.Configured {
		t.Fatalf("configure: %+v", s)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link replaced: %v %v", fi.Mode(), err)
	}
	if m := readJSON(t, target); m["mcpServers"].(map[string]any)["mcp-for-thunderbird"] == nil {
		t.Fatalf("target not updated: %v", m)
	}
	if bk := backups(t, target); len(bk) != 1 {
		t.Fatalf("target backup: %v", bk)
	}
}

func TestClaudeCodeRemoveWithoutClaudeReported(t *testing.T) {
	home, _ := sandbox(t)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"mcpServers":{"mcp-for-thunderbird":{"command":"/x","args":["connect"]}}}`), 0o600)
	s := status(t, Uninstall(), "claude-code")
	if !strings.Contains(s.Error, "claude mcp remove --scope user mcp-for-thunderbird") {
		t.Fatalf("missing claude not reported: %+v", s)
	}
}

func TestClaudeCodeArgsWithSpacesAndQuote(t *testing.T) {
	home, bin := sandbox(t)
	logf := fakeClaude(t, bin, 0)
	odd := filepath.Join(home, `My Apps`, `it's "here"`, "mcp-for-thunderbird")
	if s := status(t, Configure([]string{"claude-code"}, odd), "claude-code"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	b, _ := os.ReadFile(logf)
	want := "mcp\nadd\n--scope\nuser\nmcp-for-thunderbird\n--\n" + odd + "\nconnect\n--end--\n"
	if string(b) != want {
		t.Fatalf("args:\n%s\nwant:\n%s", b, want)
	}
}

func TestWindowsShimMetacharactersRefused(t *testing.T) {
	args := []string{"mcp", "add", "--", `C:\A&B\mcp-for-thunderbird.exe`, "connect"}
	for _, shim := range []string{`C:\npm\claude.cmd`, `C:\npm\claude.BAT`} {
		if err := checkShim("windows", shim, args); err == nil {
			t.Fatalf("%s accepted &", shim)
		}
	}
	for _, c := range []string{"^", "|", "<", ">", "%"} {
		a := []string{`C:\A` + c + `B\x.exe`}
		if err := checkShim("windows", `C:\npm\claude.cmd`, a); err == nil {
			t.Fatalf("%q accepted", c)
		}
	}
	if err := checkShim("windows", `C:\npm\claude.exe`, args); err != nil {
		t.Fatalf(".exe refused: %v", err)
	}
	if err := checkShim("windows", `C:\npm\claude.cmd`, []string{`C:\Program Files\MFT\x.exe`}); err != nil {
		t.Fatalf("plain path refused: %v", err)
	}
	if err := checkShim("linux", "/usr/bin/claude.cmd", args); err != nil {
		t.Fatalf("non-Windows refused: %v", err)
	}
}
