// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
