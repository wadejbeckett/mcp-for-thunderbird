// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package acl_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/acl"
)

func TestOwnerOnlyModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix modes; Windows is covered by TestOwnerOnlyWindows")
	}
	dir := filepath.Join(t.TempDir(), "d")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, "f")
	if err := os.WriteFile(f, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]os.FileMode{dir: 0o700, f: 0o600} {
		if err := acl.OwnerOnly(p); err != nil {
			t.Fatal(err)
		}
		if fi, _ := os.Stat(p); fi.Mode().Perm() != want {
			t.Errorf("%s: mode %o, want %o", filepath.Base(p), fi.Mode().Perm(), want)
		}
	}
	if err := acl.OwnerOnly(filepath.Join(dir, "missing")); err == nil {
		t.Error("missing path accepted")
	}
}
