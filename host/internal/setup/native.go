// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

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
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
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

// Executable returns the absolute path of the running binary with
// symlinks resolved, except when it was reached through a link in a
// package manager's bin folder (Homebrew's, for example): that link is
// returned instead, so the recorded path keeps working after an upgrade
// moves the binary to a new versioned folder.
func Executable() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	arg0 := ""
	if len(os.Args) > 0 {
		arg0 = os.Args[0]
	}
	return executable(p, arg0, stableBinDirs())
}

// stableBinDirs are folders whose links package managers keep pointing at
// the current version.
func stableBinDirs() []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"}
	if p := os.Getenv("HOMEBREW_PREFIX"); filepath.IsAbs(p) {
		dirs = append(dirs, filepath.Join(p, "bin"))
	}
	return dirs
}

// executable resolves exe, the running binary as the system reports it.
// exe itself (macOS reports the path it was started by) or arg0 found on
// PATH is returned instead when it is a symlink in one of bins that
// resolves to the same binary.
func executable(exe, arg0 string, bins []string) (string, error) {
	real := exe
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		real = r
	}
	real, err := filepath.Abs(real)
	if err != nil {
		return "", err
	}
	cands := []string{exe}
	if arg0 != "" && !strings.ContainsAny(arg0, `/\`) {
		if lp, err := exec.LookPath(arg0); err == nil {
			cands = append(cands, lp)
		}
	} else if arg0 != "" {
		cands = append(cands, arg0)
	}
	for _, c := range cands {
		c, err := filepath.Abs(c)
		if err != nil || c == real || !slices.Contains(bins, filepath.Dir(c)) {
			continue
		}
		fi, err := os.Lstat(c)
		if err != nil || fi.Mode()&fs.ModeSymlink == 0 {
			continue
		}
		if r, err := filepath.EvalSymlinks(c); err == nil && r == real {
			return c, nil
		}
	}
	return real, nil
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
		// The umask may have narrowed the mode given to OpenFile; the
		// backup keeps the original's mode exactly.
		if err := f.Chmod(fi.Mode().Perm()); err != nil {
			f.Close()
			os.Remove(name)
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
