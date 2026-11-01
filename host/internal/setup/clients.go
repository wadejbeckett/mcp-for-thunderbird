// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package setup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/bridge"
)

// client is one AI app setup knows how to configure.
type client struct {
	name string
	// state reports whether the app is on this computer and whether our
	// entry is already there with this binary.
	state func(binPath string) (found, configured bool, err error)
	// add writes our entry; it is called only when found and not configured.
	add func(binPath string) error
	// remove deletes our entry (only ours) if it is there.
	remove func() error
}

func clients() []client {
	return []client{
		jsonClient("claude-desktop", claudeDesktopPath),
		{name: "claude-code", state: claudeCodeState, add: claudeCodeAdd, remove: claudeCodeRemove},
		{name: "codex", state: codexState, add: codexAdd, remove: codexRemove},
		jsonClient("cursor", cursorPath),
	}
}

// Detect reports every supported AI app: whether it is on this computer
// and whether it already has our entry for the running binary.
func Detect() []bridge.ClientStatus {
	bin, err := Executable()
	if err != nil {
		bin = ""
	}
	return detect(bin)
}

func detect(binPath string) []bridge.ClientStatus {
	out := []bridge.ClientStatus{}
	for _, c := range clients() {
		found, configured, err := c.state(binPath)
		s := bridge.ClientStatus{Name: c.name, Found: found, Configured: configured}
		if err != nil && found {
			s.Error = err.Error()
		}
		out = append(out, s)
	}
	return out
}

// Configure adds our entry (command binPath, args ["connect"]) to each
// named app, backing up a file before changing it. Unknown or missing apps
// and failures are reported per app.
func Configure(names []string, binPath string) []bridge.ClientStatus {
	out := []bridge.ClientStatus{}
	all := clients()
	for _, name := range names {
		s := bridge.ClientStatus{Name: name}
		var c *client
		for i := range all {
			if all[i].name == name {
				c = &all[i]
			}
		}
		switch {
		case c == nil:
			s.Error = "not an app MCP for Thunderbird can set up"
		case !filepath.IsAbs(binPath):
			s.Error = "the host program's location is unknown"
		default:
			found, configured, err := c.state(binPath)
			s.Found = found
			switch {
			case !found:
				s.Error = "not found on this computer"
			case err != nil:
				s.Error = err.Error()
			case configured:
				s.Configured = true
			default:
				if err := c.add(binPath); err != nil {
					s.Error = err.Error()
				} else {
					s.Configured = true
				}
			}
		}
		out = append(out, s)
	}
	return out
}

// Uninstall removes our entry from every app that has it, with backups,
// and leaves every other entry alone.
func Uninstall() []bridge.ClientStatus {
	out := []bridge.ClientStatus{}
	for _, c := range clients() {
		s := bridge.ClientStatus{Name: c.name}
		if err := c.remove(); err != nil {
			s.Error = err.Error()
		}
		out = append(out, s)
	}
	return out
}

func home() (string, error) { return os.UserHomeDir() }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// --- JSON files (Claude Desktop, Cursor) ---

// claudeDesktopPath returns the config file and whether Claude Desktop is
// installed. Linux has no official Claude Desktop: it counts only when its
// config file already exists.
func claudeDesktopPath() (string, bool, error) {
	var dir string
	switch runtime.GOOS {
	case "darwin":
		h, err := home()
		if err != nil {
			return "", false, err
		}
		dir = filepath.Join(h, "Library", "Application Support", "Claude")
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			return "", false, errors.New("APPDATA is not set")
		}
		dir = filepath.Join(appdata, "Claude")
	default:
		cfg, err := os.UserConfigDir()
		if err != nil {
			return "", false, err
		}
		p := filepath.Join(cfg, "Claude", "claude_desktop_config.json")
		return p, exists(p), nil
	}
	return filepath.Join(dir, "claude_desktop_config.json"), exists(dir), nil
}

func cursorPath() (string, bool, error) {
	h, err := home()
	if err != nil {
		return "", false, err
	}
	dir := filepath.Join(h, ".cursor")
	return filepath.Join(dir, "mcp.json"), exists(dir), nil
}

type entry struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	// other is set when the entry has a key setup does not write (env,
	// disabled, a timeout, or any other).
	other bool
}

func (e entry) matches(binPath string) bool {
	return e.Command == binPath && reflect.DeepEqual(e.Args, []string{"connect"})
}

// ourCommand reports whether cmd is a path to the host program (any
// folder), as setup writes it: named mcp-for-thunderbird, or named as the
// running program is.
func ourCommand(cmd string) bool {
	i := strings.LastIndexAny(cmd, `/\`)
	if i < 0 {
		return false
	}
	base := cmd[i+1:]
	names := []string{EntryName, EntryName + ".exe"}
	if self, err := os.Executable(); err == nil {
		names = append(names, filepath.Base(self))
	}
	for _, n := range names {
		if strings.EqualFold(base, n) {
			return true
		}
	}
	return false
}

// ourShape reports whether e is exactly what setup writes, perhaps for
// another copy of the host program: command is the host program in any
// folder, args ["connect"], and no other key. Any other entry (an HTTP
// address, other arguments such as --instance, or one with env, disabled,
// a timeout or any other key added) was written or edited by hand, and
// setup neither replaces nor removes it.
func (e entry) ourShape() bool {
	return !e.other && ourCommand(e.Command) && reflect.DeepEqual(e.Args, []string{"connect"})
}

// ourJSONEntry reports whether raw is an entry of our shape. For Claude
// Code (claudeCode set) the "type": "stdio" and empty "env" that `claude
// mcp add` records are part of that shape.
func ourJSONEntry(raw json.RawMessage, claudeCode bool) bool {
	o, err := parseObject(raw)
	if err != nil {
		return false
	}
	var e entry
	if json.Unmarshal(raw, &e) != nil {
		return false
	}
	for _, k := range o.keys {
		var v bytes.Buffer
		if json.Compact(&v, o.vals[k]) != nil {
			return false
		}
		switch {
		case k == "command" || k == "args":
		case claudeCode && k == "type" && v.String() == `"stdio"`:
		case claudeCode && k == "env" && v.String() == "{}":
		default:
			e.other = true
		}
	}
	return e.ourShape()
}

func jsonClient(name string, path func() (string, bool, error)) client {
	return client{
		name: name,
		state: func(binPath string) (bool, bool, error) {
			p, found, err := path()
			if err != nil || !found {
				return false, false, err
			}
			doc, err := readJSONFile(p)
			if err != nil {
				return true, false, err
			}
			servers, err := doc.object("mcpServers")
			if err != nil || servers == nil {
				return true, false, err
			}
			raw, ok := servers.get(EntryName)
			var e entry
			if !ok || json.Unmarshal(raw, &e) != nil {
				return true, false, nil
			}
			return true, e.matches(binPath), nil
		},
		add: func(binPath string) error {
			p, _, err := path()
			if err != nil {
				return err
			}
			doc, err := readJSONFile(p)
			if err != nil {
				return err
			}
			servers, err := doc.object("mcpServers")
			if err != nil {
				return err
			}
			if servers == nil {
				servers = &object{}
			}
			if old, ok := servers.get(EntryName); ok && !ourJSONEntry(old, false) {
				return fmt.Errorf("%s already has an mcp-for-thunderbird entry that setup did not write, or one with settings added to it; it was left unchanged (remove that entry and set up again to replace it)", filepath.Base(p))
			}
			raw, _ := json.Marshal(entry{Command: binPath, Args: []string{"connect"}})
			servers.set(EntryName, raw)
			doc.set("mcpServers", servers.encode(""))
			return replace(p, append(doc.encode(""), '\n'), 0o600)
		},
		remove: func() error {
			p, _, err := path()
			if err != nil || !exists(p) {
				return err
			}
			doc, err := readJSONFile(p)
			if err != nil {
				return err
			}
			servers, err := doc.object("mcpServers")
			if err != nil || servers == nil {
				return err
			}
			old, ok := servers.get(EntryName)
			if !ok {
				return nil
			}
			if !ourJSONEntry(old, false) {
				return fmt.Errorf("the mcp-for-thunderbird entry in %s was not written by setup, or has settings added to it; it was left in place", filepath.Base(p))
			}
			servers.del(EntryName)
			doc.set("mcpServers", servers.encode(""))
			return replace(p, append(doc.encode(""), '\n'), 0o600)
		},
	}
}

// replace backs path up (if it exists) and writes data atomically.
// A symlinked file is resolved first, so the link survives and its target
// is backed up and updated.
func replace(path string, data []byte, newMode fs.FileMode) error {
	path, err := resolve(path)
	if err != nil {
		return err
	}
	if err := backup(path); err != nil {
		return fmt.Errorf("backing up %s: %w", filepath.Base(path), err)
	}
	return writeAtomic(path, data, newMode)
}

// object is a JSON object that keeps its keys' order and raw values.
type object struct {
	keys []string
	vals map[string]json.RawMessage
}

func readJSONFile(p string) (*object, error) {
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return &object{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return &object{}, nil
	}
	o, err := parseObject(b)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON; it was left unchanged", filepath.Base(p))
	}
	return o, nil
}

func parseObject(b json.RawMessage) (*object, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("not a JSON object")
	}
	o := &object{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, _ := tok.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		o.set(k, v)
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	// Only white space may follow the object: anything else would be
	// dropped when the file is written back.
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON object")
	}
	return o, nil
}

func (o *object) get(k string) (json.RawMessage, bool) {
	v, ok := o.vals[k]
	return v, ok
}

func (o *object) set(k string, v json.RawMessage) {
	if o.vals == nil {
		o.vals = map[string]json.RawMessage{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *object) del(k string) bool {
	if _, ok := o.vals[k]; !ok {
		return false
	}
	delete(o.vals, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
	return true
}

// object returns the member k as an object, nil if absent, or an error if
// it is something else.
func (o *object) object(k string) (*object, error) {
	raw, ok := o.get(k)
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return nil, nil
	}
	sub, err := parseObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%q is not a JSON object; the file was left unchanged", k)
	}
	return sub, nil
}

// encode writes the object with two-space indentation, each nested level
// indented under prefix, with no trailing newline (it may be embedded as a
// raw member value).
func (o *object) encode(prefix string) []byte {
	var b bytes.Buffer
	if len(o.keys) == 0 {
		b.WriteString("{}")
	} else {
		b.WriteString("{\n")
		for i, k := range o.keys {
			kb, _ := json.Marshal(k)
			b.WriteString(prefix + "  ")
			b.Write(kb)
			b.WriteString(": ")
			var v bytes.Buffer
			if json.Indent(&v, o.vals[k], prefix+"  ", "  ") != nil {
				v.Reset()
				v.Write(o.vals[k])
			}
			b.Write(v.Bytes())
			if i < len(o.keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(prefix + "}")
	}
	return b.Bytes()
}

// --- Claude Code ---

const commandTimeout = 60 * time.Second

// claudeJSON is Claude Code's user configuration, where `claude mcp add
// --scope user` records servers.
func claudeJSON() (string, error) {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, ".claude.json"), nil
	}
	h, err := home()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".claude.json"), nil
}

// claudeCodeEntry reads our entry from ~/.claude.json, if any.
func claudeCodeEntry() (e entry, raw json.RawMessage, ok bool, err error) {
	p, err := claudeJSON()
	if err != nil {
		return e, nil, false, err
	}
	doc, err := readJSONFile(p)
	if err != nil {
		return e, nil, false, err
	}
	servers, err := doc.object("mcpServers")
	if err != nil || servers == nil {
		return e, nil, false, err
	}
	raw, ok = servers.get(EntryName)
	if !ok {
		return e, nil, false, nil
	}
	_ = json.Unmarshal(raw, &e)
	return e, raw, true, nil
}

func claudeCodeState(binPath string) (bool, bool, error) {
	if _, err := exec.LookPath("claude"); err != nil {
		return false, false, nil
	}
	e, _, ok, err := claudeCodeEntry()
	if err != nil {
		return true, false, err
	}
	return true, ok && e.matches(binPath), nil
}

// claudeCodeAdd adds our entry. An entry setup wrote for another copy of
// the host program (an upgrade into a new folder) is replaced; any other
// entry is reported and left alone.
func claudeCodeAdd(binPath string) error {
	_, raw, ok, err := claudeCodeEntry()
	if err != nil {
		return err
	}
	if ok {
		if !ourJSONEntry(raw, true) {
			return errors.New("Claude Code already has an mcp-for-thunderbird entry that setup did not write, or one with settings added to it; it was left unchanged (remove it with `claude mcp remove --scope user mcp-for-thunderbird` and set up again to replace it)")
		}
		if err := runClaude("mcp", "remove", "--scope", "user", EntryName); err != nil {
			return err
		}
	}
	if err := runClaude("mcp", "add", "--scope", "user", EntryName, "--", binPath, "connect"); err != nil {
		if ok {
			return fmt.Errorf("the old entry was removed but the new one could not be added: %w", err)
		}
		return err
	}
	return nil
}

func claudeCodeRemove() error {
	_, raw, ok, err := claudeCodeEntry()
	if err != nil || !ok {
		return err
	}
	if !ourJSONEntry(raw, true) {
		return errors.New("Claude Code's mcp-for-thunderbird entry was not written by setup, or has settings added to it; it was left in place")
	}
	if _, err := exec.LookPath("claude"); err != nil {
		return errors.New("claude was not found on PATH; remove the entry with: claude mcp remove --scope user mcp-for-thunderbird")
	}
	return runClaude("mcp", "remove", "--scope", "user", EntryName)
}

// runClaude backs up ~/.claude.json and runs the claude found on PATH.
// Its output is captured, never passed to our stdout (which may carry
// native-messaging frames).
func runClaude(args ...string) error {
	path, err := exec.LookPath("claude")
	if err != nil {
		return errors.New("claude was not found on PATH")
	}
	if p, err := claudeJSON(); err == nil {
		if err := backup(p); err != nil {
			return fmt.Errorf("backing up .claude.json: %w", err)
		}
	}
	if err := checkShim(runtime.GOOS, path, args); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = nil
	// A child that leaves the output pipes open cannot hold us past this.
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if i := strings.IndexByte(msg, '\n'); i >= 0 {
			msg = msg[:i]
		}
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg != "" {
			return fmt.Errorf("claude mcp %s failed: %v: %s", args[1], err, msg)
		}
		return fmt.Errorf("claude mcp %s failed: %v", args[1], err)
	}
	return nil
}

// checkShim refuses arguments cmd.exe would interpret when claude is a
// .cmd or .bat shim on Windows (npm installs one): Go cannot quote & ^ | <
// > % safely for cmd.exe.
func checkShim(goos, path string, args []string) error {
	if goos != "windows" {
		return nil
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".cmd" && ext != ".bat" {
		return nil
	}
	for _, a := range args {
		if strings.ContainsAny(a, "&^|<>%") {
			return errors.New("the program's folder name contains one of & ^ | < > %, which cannot be passed to claude safely; move MCP for Thunderbird to another folder or run: claude mcp add --scope user mcp-for-thunderbird -- <path> connect")
		}
	}
	return nil
}

// --- Codex ---

func codexPath() (string, string, error) {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		h, err := home()
		if err != nil {
			return "", "", err
		}
		dir = filepath.Join(h, ".codex")
	}
	return dir, filepath.Join(dir, "config.toml"), nil
}

// codexEntry parses config.toml and returns our server's entry.
func codexEntry(p string) (e entry, ok bool, err error) {
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return e, false, nil
	}
	if err != nil {
		return e, false, err
	}
	return codexParse(b)
}

func codexParse(b []byte) (e entry, ok bool, err error) {
	var doc struct {
		MCPServers map[string]struct {
			Command string   `toml:"command"`
			Args    []string `toml:"args"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal(b, &doc); err != nil {
		return e, false, fmt.Errorf("config.toml could not be read (%v); it was left unchanged", firstLine(err.Error()))
	}
	// The same table with every key, to see whether it has any key setup
	// does not write (enabled, a timeout, an env sub-table).
	var keys struct {
		MCPServers map[string]map[string]any `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal(b, &keys); err != nil {
		return e, false, fmt.Errorf("config.toml could not be read (%v); it was left unchanged", firstLine(err.Error()))
	}
	s, ok := doc.MCPServers[EntryName]
	e = entry{Command: s.Command, Args: s.Args}
	for k := range keys.MCPServers[EntryName] {
		if k != "command" && k != "args" {
			e.other = true
		}
	}
	return e, ok, nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func codexState(binPath string) (bool, bool, error) {
	dir, p, err := codexPath()
	if err != nil {
		return false, false, err
	}
	_, lookErr := exec.LookPath("codex")
	if !exists(dir) && lookErr != nil {
		return false, false, nil
	}
	e, ok, err := codexEntry(p)
	if err != nil {
		return true, false, err
	}
	return true, ok && e.matches(binPath), nil
}

const codexHeader = "[mcp_servers." + EntryName + "]"

// codexAdd appends our table as text so the user's comments and layout
// stay as they are. A table setup wrote for another copy of the host
// program (an upgrade into a new folder) is removed first; any other
// entry of that name is reported, not replaced.
func codexAdd(binPath string) error {
	_, p, err := codexPath()
	if err != nil {
		return err
	}
	e, ok, err := codexEntry(p)
	if err != nil {
		return err
	}
	old, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if ok {
		if !e.ourShape() {
			return errors.New("config.toml already has an mcp-for-thunderbird entry that setup did not write, or one with settings added to it; it was left unchanged (remove that table and set up again to replace it)")
		}
		old = codexWithout(old)
	}
	var b bytes.Buffer
	b.Write(old)
	if len(old) > 0 {
		if old[len(old)-1] != '\n' {
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	fmt.Fprintf(&b, "%s\ncommand = %s\nargs = [\"connect\"]\n", codexHeader, tomlString(binPath))
	if err := checkCodex(b.Bytes(), binPath, true); err != nil {
		return err
	}
	return replace(p, b.Bytes(), 0o600)
}

// codexRemove deletes our table (and its sub-tables) as text, keeping
// comments that belong to the next table. A table setup did not write is
// left in place.
func codexRemove() error {
	_, p, err := codexPath()
	if err != nil {
		return err
	}
	e, ok, err := codexEntry(p)
	if err != nil || !ok {
		return err
	}
	if !e.ourShape() {
		return errors.New("the mcp-for-thunderbird entry in config.toml was not written by setup, or has settings added to it; it was left in place")
	}
	old, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	nb := codexWithout(old)
	if err := checkCodex(nb, "", false); err != nil {
		return err
	}
	return replace(p, nb, 0o600)
}

// codexWithout returns old with our table and its sub-tables removed as
// text.
func codexWithout(old []byte) []byte {
	lines := strings.SplitAfter(string(old), "\n")
	ours := func(l string) bool {
		h := strings.TrimSpace(l)
		if i := strings.Index(h, "#"); i >= 0 {
			h = strings.TrimSpace(h[:i])
		}
		for _, name := range []string{EntryName, `"` + EntryName + `"`} {
			if h == "[mcp_servers."+name+"]" || strings.HasPrefix(h, "[mcp_servers."+name+".") {
				return true
			}
		}
		return false
	}
	header := func(l string) bool { return strings.HasPrefix(strings.TrimSpace(l), "[") }
	var out []string
	for i := 0; i < len(lines); {
		if !ours(lines[i]) {
			out = append(out, lines[i])
			i++
			continue
		}
		j := i + 1
		for j < len(lines) && !header(lines[j]) {
			j++
		}
		// Comments and blank lines just above another table belong to it.
		k := j
		if j < len(lines) && !ours(lines[j]) {
			for k > i+1 {
				t := strings.TrimSpace(lines[k-1])
				if t != "" && !strings.HasPrefix(t, "#") {
					break
				}
				k--
			}
		}
		// At the end of the file, also drop the blank line codexAdd put
		// in front of the table.
		if j == len(lines) && len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
			out = out[:len(out)-1]
		}
		out = append(out, lines[k:j]...)
		i = j
	}
	return []byte(strings.Join(out, ""))
}

// checkCodex parses new content and confirms our entry is present with
// binPath (want) or absent (!want) before anything is written.
func checkCodex(b []byte, binPath string, want bool) error {
	e, ok, err := codexParse(b)
	if err != nil || ok != want || (want && (e.other || !e.matches(binPath))) {
		return errors.New("config.toml has a layout setup cannot change safely; it was left unchanged")
	}
	return nil
}

// tomlString quotes s as a TOML basic string.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
