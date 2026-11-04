// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
package files

import "testing"

// On Windows a name with a colon reaches a drive or an NTFS alternate data
// stream, a device name opens the device, and a name of only dots and
// spaces is trimmed to the folder or its parent.
func TestLocalNameWindows(t *testing.T) {
	for _, n := range []string{
		"report.pdf:hidden", "report.pdf::$DATA", "C:secret", "::$DATA",
		"CON", "nul.txt", "CONIN$", "conout$", "COM1", "aux:stream",
		".. ", ". ", "...", "  ", "",
		"a/b", `a\b`, "..", ".",
	} {
		if localName("windows", n) {
			t.Errorf("windows accepted %q", n)
		}
	}
	for _, n := range []string{"report.pdf", "a..b", "CONSOLE.txt", "com10", ".bashrc", "x.", "con-notes.txt"} {
		if !localName("windows", n) {
			t.Errorf("windows refused %q", n)
		}
	}
	// Elsewhere a colon and these names are ordinary file names.
	for _, n := range []string{"report.pdf:hidden", "CON", "...", "CONIN$"} {
		if !localName("linux", n) {
			t.Errorf("linux refused %q", n)
		}
	}
	for _, n := range []string{"", ".", "..", "a/b", `a\b`, "a\x00b"} {
		if localName("linux", n) {
			t.Errorf("linux accepted %q", n)
		}
	}
}
