// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build !windows

package connfile_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
)

func TestFileMode0600(t *testing.T) {
	isolate(t)
	if err := connfile.Save(&connfile.Conn{Instance: "m", Port: 47110, Token: connfile.NewToken()}); err != nil {
		t.Fatal(err)
	}
	dir, _ := connfile.Dir()
	st, err := os.Stat(filepath.Join(dir, "connection-m.json"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", st.Mode().Perm())
	}
	ds, _ := os.Stat(dir)
	if ds.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o", ds.Mode().Perm())
	}
}
