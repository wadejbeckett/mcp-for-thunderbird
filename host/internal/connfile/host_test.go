// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

package connfile

import "testing"

func TestHostName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"/usr/bin/mcp-for-thunderbird", true},
		{"/usr/bin/mcp-for-thunderbird (deleted)", true}, // upgraded while running
		{"mcp-for-thunderbird.exe", true},
		{"MCP-FOR-THUNDERBIRD.EXE", false},
		{"/usr/bin/python3", false},
		{"/usr/bin/mcp-for-thunderbird-old", nameLimit > 0 && nameLimit < len("mcp-for-thunderbird-old")},
		{"", false},
		{"/", false},
	}
	for _, c := range cases {
		if got := hostName(c.name); got != c.ok {
			t.Errorf("hostName(%q) = %v, want %v", c.name, got, c.ok)
		}
	}
}
