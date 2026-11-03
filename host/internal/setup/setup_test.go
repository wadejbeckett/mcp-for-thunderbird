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

// Thunderbird on macOS reads per-user manifests from ~/Library/Mozilla,
// not Firefox's ~/Library/Application Support/Mozilla. Unregistering also
// removes a manifest an earlier build left in the Firefox folder.
func TestRegisterMacPath(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS path")
	}
	home, _ := sandbox(t)
	if err := RegisterNative(binPath); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(home, "Library", "Mozilla", "NativeMessagingHosts", "mcp_for_thunderbird.json")
	if b, err := os.ReadFile(p); err != nil || string(b) != string(ManifestJSON(binPath)) {
		t.Fatalf("manifest: %s %v", b, err)
	}
	legacy := filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "mcp_for_thunderbird.json")
	if _, err := os.Stat(legacy); err == nil {
		t.Fatal("manifest written to the Firefox folder")
	}
	os.MkdirAll(filepath.Dir(legacy), 0o755)
	os.WriteFile(legacy, ManifestJSON(binPath), 0o644)
	if err := UnregisterNative(); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{p, legacy} {
		if _, err := os.Stat(f); !os.IsNotExist(err) {
			t.Fatalf("%s not removed: %v", f, err)
		}
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
	// Existing with another server and a stale entry of ours (an older
	// copy of the program): merged, ours replaced.
	os.WriteFile(p, []byte(`{"mcpServers":{"mcp-for-thunderbird":{"command":"/old/mcp-for-thunderbird","args":["connect"]},"b":{"url":"http://x"}},"x":true}`), 0o600)
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
	e, ok, err := codexEntry(p)
	if err != nil || !ok || e.Command != win || !reflect.DeepEqual(e.Args, []string{"connect"}) || e.other {
		t.Fatalf("round trip: %+v %v %v", e, ok, err)
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
	// codexWithout drops the table with its sub-tables. (Uninstall does
	// not reach it with a sub-table: an env table makes the entry
	// hand-edited, as TestHandEditedEntryKept checks.)
	withSub := "model = \"o3\"\n\n[mcp_servers.mcp-for-thunderbird]\ncommand = \"/x/mcp-for-thunderbird\"\nargs = [\"connect\"]\n\n[mcp_servers.mcp-for-thunderbird.env]\nA = \"1\"\n\n# the next table\n[profiles.fast]\nmodel = \"o4\" # keep\n"
	if got, want := string(codexWithout([]byte(withSub))), "model = \"o3\"\n\n\n# the next table\n[profiles.fast]\nmodel = \"o4\" # keep\n"; got != want {
		t.Fatalf("codexWithout:\n%q\nwant:\n%q", got, want)
	}
	home, _ := sandbox(t)
	orig := "model = \"o3\"\n\n[mcp_servers.mcp-for-thunderbird]\ncommand = \"/x/mcp-for-thunderbird\"\nargs = [\"connect\"]\n\n# the next table\n[profiles.fast]\nmodel = \"o4\" # keep\n"
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
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"mcpServers":{"mcp-for-thunderbird":{"command":"/x/mcp-for-thunderbird","args":["connect"]}}}`), 0o600)
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

// oldBin is where an earlier version of the program lived, as a package
// manager with versioned folders (Homebrew's Cellar) leaves it.
var oldBin = filepath.Join(string(filepath.Separator)+"opt", "homebrew", "Cellar", "mcp-for-thunderbird", "1.0.0", "bin", "mcp-for-thunderbird")

// After an upgrade into a new folder, setting up again replaces the
// table setup wrote for the old folder and keeps everything else.
func TestCodexUpgradeReplacesOwnEntry(t *testing.T) {
	home, _ := sandbox(t)
	old := "model = \"o3\"\n\n[mcp_servers.mcp-for-thunderbird]\ncommand = " + tomlString(oldBin) + "\nargs = [\"connect\"]\n\n# next\n[mcp_servers.other]\ncommand = \"x\"\n"
	p := codexSetup(t, home, old)
	if s := status(t, Configure([]string{"codex"}, binPath), "codex"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	b, _ := os.ReadFile(p)
	want := "model = \"o3\"\n\n\n# next\n[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.mcp-for-thunderbird]\ncommand = " + binTOML + "\nargs = [\"connect\"]\n"
	if string(b) != want {
		t.Fatalf("config.toml:\n%s\nwant:\n%s", b, want)
	}
	if bk := backups(t, p); len(bk) != 1 {
		t.Fatalf("backups: %v", bk)
	}
	if s := status(t, detect(binPath), "codex"); !s.Configured {
		t.Fatalf("detect after: %+v", s)
	}
}

func TestClaudeCodeUpgradeReplacesOwnEntry(t *testing.T) {
	home, bin := sandbox(t)
	logf := fakeClaude(t, bin, 0)
	cj := filepath.Join(home, ".claude.json")
	old, _ := json.Marshal(oldBin)
	os.WriteFile(cj, []byte(`{"mcpServers":{"mcp-for-thunderbird":{"type":"stdio","command":`+string(old)+`,"args":["connect"],"env":{}}}}`), 0o600)
	if s := status(t, Configure([]string{"claude-code"}, binPath), "claude-code"); !s.Configured || s.Error != "" {
		t.Fatalf("configure: %+v", s)
	}
	b, _ := os.ReadFile(logf)
	want := "mcp\nremove\n--scope\nuser\nmcp-for-thunderbird\n--end--\n" +
		"mcp\nadd\n--scope\nuser\nmcp-for-thunderbird\n--\n" + binPath + "\nconnect\n--end--\n"
	if string(b) != want {
		t.Fatalf("claude args:\n%s\nwant:\n%s", b, want)
	}
}

// fakeClaudeFailingAdd is fakeClaude whose "mcp add" exits 1, the first
// time only or every time; other runs succeed. (The sandbox PATH has no
// other programs, so the script uses shell built-ins only.)
func fakeClaudeFailingAdd(t *testing.T, bin string, always bool) string {
	t.Helper()
	logf := fakeClaude(t, bin, 0)
	failed := filepath.Join(t.TempDir(), "failed")
	fail := "[ -e '" + failed + "' ] || { : >'" + failed + "'; echo 'add refused' >&2; exit 1; }\n"
	if always {
		fail = "echo 'add refused' >&2; exit 1\n"
	}
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >>'" + logf + "'; done\n" +
		"printf -- '--end--\\n' >>'" + logf + "'\n" +
		"[ \"$2\" = add ] || exit 0\n" + fail
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return logf
}

// When the new Claude Code entry cannot be added after the old one was
// removed, the old one is added back and the failure is reported.
func TestClaudeCodeUpgradeAddFailurePutsOldBack(t *testing.T) {
	removeOld := "mcp\nremove\n--scope\nuser\nmcp-for-thunderbird\n--end--\n"
	addNew := "mcp\nadd\n--scope\nuser\nmcp-for-thunderbird\n--\n" + binPath + "\nconnect\n--end--\n"
	addOld := "mcp\nadd\n--scope\nuser\nmcp-for-thunderbird\n--\n" + oldBin + "\nconnect\n--end--\n"
	for _, c := range []struct {
		always bool
		error  string
	}{
		{false, "the old one was put back"},
		{true, "the earliest of the copies of .claude.json"},
	} {
		home, bin := sandbox(t)
		logf := fakeClaudeFailingAdd(t, bin, c.always)
		cj := filepath.Join(home, ".claude.json")
		old, _ := json.Marshal(oldBin)
		os.WriteFile(cj, []byte(`{"mcpServers":{"mcp-for-thunderbird":{"type":"stdio","command":`+string(old)+`,"args":["connect"],"env":{}}}}`), 0o600)
		s := status(t, Configure([]string{"claude-code"}, binPath), "claude-code")
		if s.Configured || !strings.Contains(s.Error, c.error) || !strings.Contains(s.Error, "add refused") {
			t.Errorf("always %v: %+v", c.always, s)
		}
		if b, _ := os.ReadFile(logf); string(b) != removeOld+addNew+addOld {
			t.Errorf("always %v: claude args:\n%s\nwant:\n%s", c.always, b, removeOld+addNew+addOld)
		}
		if bk := backups(t, cj); len(bk) == 0 {
			t.Errorf("always %v: no backup of .claude.json", c.always)
		}
	}
}

// A check that would make the new add fail runs before the old entry is
// removed, so a refused add leaves the old entry in place.
func TestClaudeCodeUpgradeCheckedBeforeRemove(t *testing.T) {
	home, bin := sandbox(t)
	logf := fakeClaude(t, bin, 0)
	// Pretend claude is a Windows .cmd shim, which cannot take an &.
	orig := claudeShim
	claudeShim = func(path string, args []string) error { return checkShim("windows", path+".cmd", args) }
	t.Cleanup(func() { claudeShim = orig })
	cj := filepath.Join(home, ".claude.json")
	old, _ := json.Marshal(oldBin)
	content := `{"mcpServers":{"mcp-for-thunderbird":{"type":"stdio","command":` + string(old) + `,"args":["connect"],"env":{}}}}`
	os.WriteFile(cj, []byte(content), 0o600)
	amp := filepath.Join(filepath.Dir(binPath)+"&x", "mcp-for-thunderbird")
	s := status(t, Configure([]string{"claude-code"}, amp), "claude-code")
	if s.Configured || !strings.Contains(s.Error, "cannot be passed to claude safely") {
		t.Fatalf("configure: %+v", s)
	}
	if _, err := os.Stat(logf); !os.IsNotExist(err) {
		b, _ := os.ReadFile(logf)
		t.Fatalf("claude ran: %s", b)
	}
	if b, _ := os.ReadFile(cj); string(b) != content {
		t.Fatalf(".claude.json changed:\n%s", b)
	}
}

// An entry a person wrote (here the HTTP address form, or connect pinned
// to one profile) is never replaced or removed by setup, in any app.
func TestHandWrittenEntryKept(t *testing.T) {
	handJSON := `{"mcpServers":{"mcp-for-thunderbird":{"url":"http://127.0.0.1:47110/mcp","headers":{"Authorization":"Bearer k"}}}}`
	pinned := `{"mcpServers":{"mcp-for-thunderbird":{"command":` + binJSON + `,"args":["connect","--instance","abc"]}}}`
	for _, content := range []string{handJSON, pinned} {
		home, bin := sandbox(t)
		logf := filepath.Join(t.TempDir(), "none")
		if runtime.GOOS != "windows" {
			logf = fakeClaude(t, bin, 0)
		}
		files := map[string]string{
			"claude-desktop": claudeDesktopConfig(t, home, content),
			"cursor":         filepath.Join(home, ".cursor", "mcp.json"),
			"claude-code":    filepath.Join(home, ".claude.json"),
			"codex":          filepath.Join(home, ".codex", "config.toml"),
		}
		os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
		os.WriteFile(files["cursor"], []byte(content), 0o600)
		os.WriteFile(files["claude-code"], []byte(content), 0o600)
		toml := "[mcp_servers.mcp-for-thunderbird]\nurl = \"http://127.0.0.1:47110/mcp\"\n"
		if content == pinned {
			toml = "[mcp_servers.mcp-for-thunderbird]\ncommand = " + binTOML + "\nargs = [\"connect\", \"--instance\", \"abc\"]\n"
		}
		codexSetup(t, home, toml)
		names := []string{"claude-desktop", "cursor", "codex"}
		if runtime.GOOS != "windows" {
			names = append(names, "claude-code")
		}
		for _, n := range names {
			if s := status(t, Configure([]string{n}, binPath), n); s.Error == "" || s.Configured {
				t.Errorf("%s: hand-written entry replaced: %+v", n, s)
			}
			if s := status(t, Uninstall(), n); !strings.Contains(s.Error, "left in place") {
				t.Errorf("%s: uninstall did not report the kept entry: %+v", n, s)
			}
		}
		for n, f := range files {
			b, _ := os.ReadFile(f)
			want := content
			if n == "codex" {
				want = toml
			}
			if string(b) != want {
				t.Errorf("%s changed:\n%s", n, b)
			}
			if bk := backups(t, f); len(bk) != 0 {
				t.Errorf("%s backed up on refusal: %v", n, bk)
			}
		}
		if _, err := os.Stat(logf); !os.IsNotExist(err) {
			b, _ := os.ReadFile(logf)
			t.Errorf("claude ran: %s", b)
		}
	}
}

// An entry of setup's shape that a person has added keys to (env,
// disabled, enabled = false, a timeout, an env sub-table) is hand-edited:
// setup after an upgrade neither replaces it (which would drop those
// keys) nor removes it, and reports it.
func TestHandEditedEntryKept(t *testing.T) {
	old, _ := json.Marshal(oldBin)
	jsonCases := []string{
		`{"command":` + string(old) + `,"args":["connect"],"env":{"A":"1"}}`,
		`{"command":` + string(old) + `,"args":["connect"],"disabled":true}`,
		`{"command":` + string(old) + `,"args":["connect"],"env":{}}`,
	}
	claudeCases := []string{
		`{"type":"stdio","command":` + string(old) + `,"args":["connect"],"env":{"A":"1"}}`,
		`{"type":"stdio","command":` + string(old) + `,"args":["connect"],"env":{},"disabled":true}`,
		`{"type":"http","command":` + string(old) + `,"args":["connect"],"env":{}}`,
	}
	tomlHead := "[mcp_servers.mcp-for-thunderbird]\ncommand = " + tomlString(oldBin) + "\nargs = [\"connect\"]\n"
	codexCases := []string{
		tomlHead + "enabled = false\n",
		tomlHead + "tool_timeout_sec = 30\n",
		tomlHead + "startup_timeout_sec = 20\n",
		tomlHead + "\n[mcp_servers.mcp-for-thunderbird.env]\nA = \"1\"\n",
		"[mcp_servers]\nmcp-for-thunderbird = { command = " + tomlString(oldBin) + ", args = [\"connect\"], enabled = false }\n",
	}
	type file struct{ name, path, content string }
	check := func(t *testing.T, fs []file, logf string) {
		t.Helper()
		for _, f := range fs {
			if s := status(t, Configure([]string{f.name}, binPath), f.name); s.Error == "" || s.Configured {
				t.Errorf("%s: hand-edited entry replaced: %+v", f.name, s)
			}
			if s := status(t, Uninstall(), f.name); !strings.Contains(s.Error, "left in place") {
				t.Errorf("%s: uninstall did not report the kept entry: %+v", f.name, s)
			}
			if b, _ := os.ReadFile(f.path); string(b) != f.content {
				t.Errorf("%s changed:\n%s\nwas:\n%s", f.name, b, f.content)
			}
			if bk := backups(t, f.path); len(bk) != 0 {
				t.Errorf("%s backed up on refusal: %v", f.name, bk)
			}
		}
		if _, err := os.Stat(logf); !os.IsNotExist(err) {
			b, _ := os.ReadFile(logf)
			t.Errorf("claude ran: %s", b)
		}
	}
	for _, e := range jsonCases {
		home, _ := sandbox(t)
		content := `{"mcpServers":{"mcp-for-thunderbird":` + e + `}}`
		os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
		cursor := filepath.Join(home, ".cursor", "mcp.json")
		os.WriteFile(cursor, []byte(content), 0o600)
		check(t, []file{
			{"claude-desktop", claudeDesktopConfig(t, home, content), content},
			{"cursor", cursor, content},
		}, filepath.Join(t.TempDir(), "none"))
	}
	if runtime.GOOS != "windows" {
		for _, e := range claudeCases {
			home, bin := sandbox(t)
			logf := fakeClaude(t, bin, 0)
			content := `{"mcpServers":{"mcp-for-thunderbird":` + e + `}}`
			cj := filepath.Join(home, ".claude.json")
			os.WriteFile(cj, []byte(content), 0o600)
			check(t, []file{{"claude-code", cj, content}}, logf)
		}
	}
	for _, content := range codexCases {
		home, _ := sandbox(t)
		check(t, []file{{"codex", codexSetup(t, home, content), content}}, filepath.Join(t.TempDir(), "none"))
	}
}

// Text after the closing brace would be dropped when the file is written
// back, so such a file is refused and left as it is.
func TestTrailingDataRefused(t *testing.T) {
	for _, in := range []string{`{} x`, `{"a":1}}`, `{"a":1} {"b":2}`, `{"a":1}]`} {
		if _, err := parseObject(json.RawMessage(in)); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	for _, in := range []string{`{}`, "{\"a\":1}\n\n", " \t{ }\r\n"} {
		if _, err := parseObject(json.RawMessage(in)); err != nil {
			t.Errorf("%q refused: %v", in, err)
		}
	}
	home, _ := sandbox(t)
	os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
	p := filepath.Join(home, ".cursor", "mcp.json")
	orig := `{"mcpServers":{}} {"keep":"me"}`
	os.WriteFile(p, []byte(orig), 0o600)
	if s := status(t, Configure([]string{"cursor"}, binPath), "cursor"); s.Error == "" || s.Configured {
		t.Fatalf("trailing data accepted: %+v", s)
	}
	if b, _ := os.ReadFile(p); string(b) != orig {
		t.Fatalf("file changed:\n%s", b)
	}
}

// Started through a package manager's bin link, the program records the
// link, which survives upgrades; elsewhere it records the resolved path.
func TestExecutableKeepsPackageManagerLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	_, bin := sandbox(t)
	root := resolvedDir(t, t.TempDir())
	cellar := filepath.Join(root, "Cellar", "mcp-for-thunderbird", "1.1.0", "bin")
	os.MkdirAll(cellar, 0o755)
	real := filepath.Join(cellar, "mcp-for-thunderbird")
	os.WriteFile(real, []byte("#!/bin/sh\n"), 0o755)
	brewBin := filepath.Join(root, "bin")
	os.MkdirAll(brewBin, 0o755)
	link := filepath.Join(brewBin, "mcp-for-thunderbird")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", brewBin+string(os.PathListSeparator)+bin)
	bins := []string{brewBin}
	for _, c := range []struct{ exe, arg0, want string }{
		{link, link, link},                  // macOS: the path it was started by
		{real, "mcp-for-thunderbird", link}, // Linux: /proc/self/exe, started from PATH
		{real, link, link},                  // Thunderbird starts the recorded link
		{real, real, real},                  // started from the versioned folder
		{link, link, link},
	} {
		if got, err := executable(c.exe, c.arg0, bins); err != nil || got != c.want {
			t.Errorf("executable(%s, %s) = %s %v, want %s", c.exe, c.arg0, got, err, c.want)
		}
	}
	// A link outside the package manager's bin folders is resolved.
	if got, _ := executable(link, link, nil); got != real {
		t.Errorf("unlisted folder: %s", got)
	}
	// A link in the bin folder that points at another binary is ignored.
	other := filepath.Join(root, "other")
	os.WriteFile(other, nil, 0o755)
	os.Remove(link)
	os.Symlink(other, link)
	if got, _ := executable(real, "mcp-for-thunderbird", bins); got != real {
		t.Errorf("foreign link used: %s", got)
	}
}

func resolvedDir(t *testing.T, d string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(d)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// A copy of the program under another file name still recognises the
// entries it wrote.
func TestRenamedProgramOwnsItsEntry(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if !(entry{Command: filepath.Join(filepath.Dir(binPath), filepath.Base(self)), Args: []string{"connect"}}).ourShape() {
		t.Fatalf("%s not recognised", filepath.Base(self))
	}
	for _, e := range []entry{
		{Command: oldBin, Args: []string{"connect"}},
		{Command: `C:\Program Files\MCP\MCP-for-Thunderbird.EXE`, Args: []string{"connect"}},
	} {
		if !e.ourShape() {
			t.Errorf("%+v not recognised", e)
		}
	}
	for _, e := range []entry{
		{Command: "mcp-for-thunderbird", Args: []string{"connect"}},
		{Command: oldBin, Args: []string{"connect", "--instance", "x"}},
		{Command: oldBin},
		{Command: "/usr/bin/other", Args: []string{"connect"}},
	} {
		if e.ourShape() {
			t.Errorf("%+v recognised", e)
		}
	}
}

// A backup keeps the original's mode exactly, whatever the umask.
func TestBackupKeepsMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file modes")
	}
	for _, mode := range []os.FileMode{0o664, 0o666} {
		p := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(p, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		if err := backup(p); err != nil {
			t.Fatal(err)
		}
		bk := backups(t, p)
		if len(bk) != 1 {
			t.Fatalf("backups: %v", bk)
		}
		fi, err := os.Stat(bk[0])
		if err != nil {
			t.Fatal(err)
		}
		if m := fi.Mode().Perm(); m != mode {
			t.Errorf("backup of a %o file has mode %o", mode, m)
		}
	}
}

// A line inside another table's multi-line string that looks like our
// table header is not our table: setup refuses rather than cut the
// string, both on an upgrade and on removal.
func TestCodexHeaderInsideStringRefused(t *testing.T) {
	home, _ := sandbox(t)
	orig := "[mcp_servers.mcp-for-thunderbird]\ncommand = \"/old/mcp-for-thunderbird\"\nargs = [\"connect\"]\n\n[notes]\ntext = \"\"\"\nline one\n[mcp_servers.mcp-for-thunderbird]\nSECRET PART\n[end]\n\"\"\"\n"
	p := codexSetup(t, home, orig)
	if s := status(t, Configure([]string{"codex"}, binPath), "codex"); s.Error == "" {
		t.Fatalf("upgrade not refused: %+v", s)
	}
	if b, _ := os.ReadFile(p); string(b) != orig {
		t.Fatalf("upgrade changed the file:\n%s", b)
	}
	if err := codexRemove(); err == nil {
		t.Fatal("removal not refused")
	}
	if b, _ := os.ReadFile(p); string(b) != orig {
		t.Fatalf("removal changed the file:\n%s", b)
	}
}

// A TOML nan decodes to a NaN float, which never equals itself; a file
// holding one must still be upgraded and cleaned like any other.
func TestCodexNaNValueAllowed(t *testing.T) {
	home, _ := sandbox(t)
	other := "[floats]\nx = nan\ny = [1.5, nan]\n"
	orig := "[mcp_servers.mcp-for-thunderbird]\ncommand = " + tomlString(oldBin) + "\nargs = [\"connect\"]\n\n" + other
	p := codexSetup(t, home, orig)
	if s := status(t, Configure([]string{"codex"}, binPath), "codex"); !s.Configured || s.Error != "" {
		t.Fatalf("upgrade: %+v", s)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), other) || !strings.Contains(string(b), "command = "+binTOML+"\n") {
		t.Fatalf("upgrade wrote:\n%s", b)
	}
	if err := codexRemove(); err != nil {
		t.Fatalf("removal: %v", err)
	}
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), other) || strings.Contains(string(b), EntryName) {
		t.Fatalf("removal left:\n%s", b)
	}
}
