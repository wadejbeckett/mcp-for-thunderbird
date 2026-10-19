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
}

func (e entry) matches(binPath string) bool {
	return e.Command == binPath && reflect.DeepEqual(e.Args, []string{"connect"})
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
			raw, _ := json.Marshal(entry{Command: binPath, Args: []string{"connect"}})
			servers.set(EntryName, raw)
			doc.set("mcpServers", servers.encode(""))
			return replace(p, doc.encode(""), 0o600)
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
			if !servers.del(EntryName) {
				return nil
			}
			doc.set("mcpServers", servers.encode(""))
			return replace(p, doc.encode(""), 0o600)
		},
	}
}

// replace backs path up (if it exists) and writes data atomically.
func replace(path string, data []byte, newMode fs.FileMode) error {
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
	if _, err := dec.Token(); err == nil {
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
	if !ok {
		return nil, nil
	}
	sub, err := parseObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%q is not a JSON object; the file was left unchanged", k)
	}
	return sub, nil
}

// encode writes the object with two-space indentation, each nested level
// indented under prefix.
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
	if prefix == "" {
		b.WriteByte('\n')
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
func claudeCodeEntry() (e entry, ok bool, err error) {
	p, err := claudeJSON()
	if err != nil {
		return e, false, err
	}
	doc, err := readJSONFile(p)
	if err != nil {
		return e, false, err
	}
	servers, err := doc.object("mcpServers")
	if err != nil || servers == nil {
		return e, false, err
	}
	raw, ok := servers.get(EntryName)
	if !ok {
		return e, false, nil
	}
	_ = json.Unmarshal(raw, &e)
	return e, true, nil
}

func claudeCodeState(binPath string) (bool, bool, error) {
	if _, err := exec.LookPath("claude"); err != nil {
		return false, false, nil
	}
	e, ok, err := claudeCodeEntry()
	if err != nil {
		return true, false, err
	}
	return true, ok && e.matches(binPath), nil
}

func claudeCodeAdd(binPath string) error {
	if _, ok, err := claudeCodeEntry(); err != nil {
		return err
	} else if ok {
		return errors.New("Claude Code already has a different mcp-for-thunderbird entry; remove it with `claude mcp remove --scope user mcp-for-thunderbird` and try again")
	}
	return runClaude("mcp", "add", "--scope", "user", EntryName, "--", binPath, "connect")
}

func claudeCodeRemove() error {
	if _, err := exec.LookPath("claude"); err != nil {
		return nil
	}
	if _, ok, err := claudeCodeEntry(); err != nil || !ok {
		return err
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
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = nil
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

// codexEntry parses config.toml and returns our server's command and args.
func codexEntry(p string) (cmd string, args []string, ok bool, err error) {
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil, false, nil
	}
	if err != nil {
		return "", nil, false, err
	}
	return codexParse(b)
}

func codexParse(b []byte) (cmd string, args []string, ok bool, err error) {
	var doc struct {
		MCPServers map[string]struct {
			Command string   `toml:"command"`
			Args    []string `toml:"args"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal(b, &doc); err != nil {
		return "", nil, false, fmt.Errorf("config.toml could not be read (%v); it was left unchanged", firstLine(err.Error()))
	}
	e, ok := doc.MCPServers[EntryName]
	return e.Command, e.Args, ok, nil
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
	cmd, args, ok, err := codexEntry(p)
	if err != nil {
		return true, false, err
	}
	return true, ok && (entry{cmd, args}).matches(binPath), nil
}

const codexHeader = "[mcp_servers." + EntryName + "]"

// codexAdd appends our table as text so the user's comments and layout
// stay as they are. A different entry of ours is reported, not replaced.
func codexAdd(binPath string) error {
	_, p, err := codexPath()
	if err != nil {
		return err
	}
	_, _, ok, err := codexEntry(p)
	if err != nil {
		return err
	}
	if ok {
		return errors.New("config.toml already has a different mcp-for-thunderbird entry; it was left unchanged")
	}
	old, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
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
// comments that belong to the next table.
func codexRemove() error {
	_, p, err := codexPath()
	if err != nil {
		return err
	}
	_, _, ok, err := codexEntry(p)
	if err != nil || !ok {
		return err
	}
	old, err := os.ReadFile(p)
	if err != nil {
		return err
	}
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
	nb := []byte(strings.Join(out, ""))
	if err := checkCodex(nb, "", false); err != nil {
		return err
	}
	return replace(p, nb, 0o600)
}

// checkCodex parses new content and confirms our entry is present with
// binPath (want) or absent (!want) before anything is written.
func checkCodex(b []byte, binPath string, want bool) error {
	cmd, args, ok, err := codexParse(b)
	if err != nil || ok != want || (want && !(entry{cmd, args}).matches(binPath)) {
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
