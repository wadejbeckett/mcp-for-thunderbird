// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
