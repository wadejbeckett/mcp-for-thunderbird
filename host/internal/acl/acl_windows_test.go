// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
