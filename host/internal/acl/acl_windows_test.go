// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build windows

package acl_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/acl"
)

func TestOwnerOnlyWindows(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "d")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, "f")
	os.WriteFile(f, nil, 0o644)
	if err := acl.Check(f); err == nil {
		t.Fatal("Check passed before OwnerOnly: the temp folder's inherited DACL looks owner-only")
	}
	for _, p := range []string{dir, f} {
		if err := acl.OwnerOnly(p); err != nil {
			t.Fatal(err)
		}
		if err := acl.Check(p); err != nil {
			t.Errorf("%s: %v", filepath.Base(p), err)
		}
	}
}
