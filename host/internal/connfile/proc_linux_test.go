// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build linux

package connfile

import "testing"

func TestStatStart(t *testing.T) {
	rest := " S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21"
	for _, c := range []struct {
		stat, want string
		ok         bool
	}{
		{"123 (mcp-for-thunderbird)" + rest, "987654", true},
		{"123 (a) b (c))" + rest, "987654", true}, // a name with spaces and parentheses
		{"123 (short) S 1 2", "", false},
		{"123 no parenthesis" + rest, "", false},
		{"123 (x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 -5 20", "", false},
	} {
		got, ok := statStart(c.stat)
		if got != c.want || ok != c.ok {
			t.Errorf("statStart(%q) = %q, %v, want %q, %v", c.stat, got, ok, c.want, c.ok)
		}
	}
}
