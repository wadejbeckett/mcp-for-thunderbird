// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build windows

package files_test

import (
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
