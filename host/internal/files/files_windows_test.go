// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build windows

package files_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/acl"
	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/files"
)

// On Windows a 0700/0600 mode does nothing; Save makes the folders it
// creates and the file owner-only through the DACL instead.
func TestSavePrivateWindows(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "new", "sub")
	p, err := files.Save(dir, "report.pdf", []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range []string{filepath.Join(base, "new"), dir, p} {
		if err := acl.Check(x); err != nil {
			t.Errorf("%s: %v", x, err)
		}
	}
	// The folder that already existed is left alone.
	if err := acl.Check(base); err == nil {
		t.Errorf("existing folder %s was made owner-only", base)
	}
}

// A name that reaches an NTFS alternate data stream or a device is
// refused before anything is opened.
func TestReadRefusesStreamsAndDevicesWindows(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("main"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Writing the stream may fail on a file system without streams; the
	// read must be refused either way.
	os.WriteFile(filepath.Join(dir, "a.txt:hidden"), []byte("stream"), 0o600)
	for _, n := range []string{"a.txt:hidden", "a.txt::$DATA", "CON", "NUL", "CONIN$", "nul.txt", ".. ", "..."} {
		if _, _, err := files.ReadForDraft(dir, n); !errors.Is(err, files.ErrOutside) {
			t.Errorf("%q: %v", n, err)
		}
	}
	if b, _, err := files.ReadForDraft(dir, "a.txt"); err != nil || string(b) != "main" {
		t.Fatalf("a.txt: %q %v", b, err)
	}
}
