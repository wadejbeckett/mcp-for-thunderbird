// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build unix

package files_test

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/files"
)

// A FIFO in the attachment folder is refused at once; opening it for
// reading would wait for a writer and block the host.
func TestReadRefusesFIFO(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe.pdf")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skip(err)
	}
	os.Symlink(fifo, filepath.Join(dir, "alias.pdf"))
	for _, name := range []string{"pipe.pdf", "alias.pdf"} {
		done := make(chan error, 1)
		go func() { _, _, err := files.ReadForDraft(dir, name); done <- err }()
		select {
		case err := <-done:
			if !errors.Is(err, files.ErrNotRegular) {
				t.Errorf("%s: %v", name, err)
			}
		case <-time.After(3 * time.Second):
			// Unblock the reader so the test can end.
			if w, err := os.OpenFile(fifo, os.O_WRONLY, 0); err == nil {
				w.Close()
			}
			t.Fatalf("%s: ReadForDraft blocked on a FIFO", name)
		}
	}
}

// A folder or a device is refused the same way.
func TestReadRefusesSpecialFiles(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "sub"), 0o700)
	os.Symlink("/dev/null", filepath.Join(dir, "null"))
	for _, name := range []string{"sub"} {
		if _, _, err := files.ReadForDraft(dir, name); !errors.Is(err, files.ErrNotRegular) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// /dev/null is outside the folder, so the link is refused before that.
	if _, _, err := files.ReadForDraft(dir, "null"); !errors.Is(err, files.ErrOutside) {
		t.Errorf("null: %v", err)
	}
}
