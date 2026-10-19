// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package setup registers the native-messaging manifest that lets
// Thunderbird start the host, and adds the host to AI apps' MCP
// configuration (Claude Desktop, Claude Code, Codex, Cursor).
package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const (
	// HostName is the native-messaging host name.
	HostName = "mcp_for_thunderbird"
	// AddonID is the only extension allowed to start the host.
	AddonID = "mcp-for-thunderbird@wadejbeckett.github.io"
	// EntryName is the MCP server name written into each AI app.
	EntryName = "mcp-for-thunderbird"
)

// ManifestJSON returns the native-messaging manifest for binPath.
func ManifestJSON(binPath string) []byte {
	m := struct {
		Name              string   `json:"name"`
		Description       string   `json:"description"`
		Path              string   `json:"path"`
		Type              string   `json:"type"`
		AllowedExtensions []string `json:"allowed_extensions"`
	}{HostName, "MCP for Thunderbird host", binPath, "stdio", []string{AddonID}}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(m)
	return buf.Bytes()
}

// RegisterNative writes the native-messaging manifest for binPath (an
// absolute path) where Thunderbird looks for it, replacing an older one.
func RegisterNative(binPath string) error {
	if !filepath.IsAbs(binPath) {
		return fmt.Errorf("setup: binary path %q is not absolute", binPath)
	}
	return registerNative(binPath)
}

// UnregisterNative removes the manifest (and, on Windows, its registry
// key). Nothing registered is not an error.
func UnregisterNative() error { return unregisterNative() }

// Executable returns the absolute, symlink-free path of the running binary.
func Executable() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Abs(p)
}

// resolve follows symlinks of an existing path; a missing path is
// returned as it is.
func resolve(path string) (string, error) {
	r, err := filepath.EvalSymlinks(path)
	if errors.Is(err, fs.ErrNotExist) {
		return path, nil
	}
	return r, err
}

// writeAtomic replaces path with data through a temp file in the same
// directory. An existing file keeps its mode; a new one gets newMode. A
// symlinked path is resolved first, so the link survives.
func writeAtomic(path string, data []byte, newMode fs.FileMode) error {
	path, err := resolve(path)
	if err != nil {
		return err
	}
	mode := newMode
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// backup copies an existing path to <path>.bak-YYYYMMDD-HHMMSS (with a
// -N suffix if that name is taken). A missing file needs no backup.
func backup(path string) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	base := path + ".bak-" + time.Now().Format("20060102-150405")
	for i := 0; i < 100; i++ {
		name := base
		if i > 0 {
			name = fmt.Sprintf("%s-%d", base, i)
		}
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fi.Mode().Perm())
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		if _, err := f.Write(b); err != nil {
			f.Close()
			os.Remove(name)
			return err
		}
		return f.Close()
	}
	return fmt.Errorf("setup: no free backup name for %s", filepath.Base(path))
}
