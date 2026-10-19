// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
package files_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/files"
)

func TestSaveSanitises(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":   "passwd",
		`..\..\win\x.txt`:    "x.txt",
		`a:b*c?d"e<f>g|h`:    "abcdefgh",
		"tab\x00\x07\nx.pdf": "tabx.pdf",
		"":                   "attachment",
		"..":                 "attachment",
		"///":                "attachment",
	}
	for in, want := range cases {
		dir := t.TempDir()
		p, err := files.Save(dir, in, []byte("x"))
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if filepath.Base(p) != want || filepath.Dir(p) != dir {
			t.Errorf("%q saved as %s, want %s in dir", in, p, want)
		}
	}
}

func TestSaveNoOverwrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new", "sub")
	var got []string
	for i := 0; i < 3; i++ {
		p, err := files.Save(dir, "report.pdf", []byte{byte(i)})
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, filepath.Base(p))
	}
	want := []string{"report.pdf", "report (2).pdf", "report (3).pdf"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	b, _ := os.ReadFile(filepath.Join(dir, "report.pdf"))
	if !bytes.Equal(b, []byte{0}) {
		t.Fatal("original overwritten")
	}
	st, _ := os.Stat(dir)
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o", st.Mode().Perm())
	}
}

func TestSaveDoesNotFollowSymlink(t *testing.T) {
	dir, out := t.TempDir(), t.TempDir()
	if err := os.Symlink(filepath.Join(out, "victim"), filepath.Join(dir, "a.txt")); err != nil {
		t.Skip(err)
	}
	p, err := files.Save(dir, "a.txt", []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "a (2).txt" {
		t.Fatalf("saved as %s", p)
	}
	if _, err := os.Stat(filepath.Join(out, "victim")); err == nil {
		t.Fatal("wrote through symlink")
	}
}

func TestSaveRefusesBadDir(t *testing.T) {
	if _, err := files.Save("", "a", nil); !errors.Is(err, files.ErrNoDir) {
		t.Errorf("empty dir: %v", err)
	}
	if _, err := files.Save("relative/dir", "a", nil); !errors.Is(err, files.ErrNoDir) {
		t.Errorf("relative dir: %v", err)
	}
	if _, err := files.Save(t.TempDir(), "a", make([]byte, files.MaxSize+1)); !errors.Is(err, files.ErrTooLarge) {
		t.Errorf("too large: %v", err)
	}
}

func TestReadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "ok.txt"), []byte("hello"), 0o600)
	b, n, err := files.ReadForDraft(dir, "ok.txt")
	if err != nil || string(b) != "hello" || n != "ok.txt" {
		t.Fatalf("%q %q %v", b, n, err)
	}
	if _, _, err := files.ReadForDraft(dir, "missing.txt"); err == nil || errors.Is(err, files.ErrOutside) {
		t.Fatalf("missing: %v", err)
	}
}

func TestReadRejectsDotDot(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret"), []byte("s"), 0o600)
	for _, n := range []string{"../secret", "..", "sub/../../secret", `..\secret`, "a/b"} {
		if _, _, err := files.ReadForDraft(dir, n); !errors.Is(err, files.ErrOutside) {
			t.Errorf("%q: %v", n, err)
		}
	}
}

func TestReadRejectsAbsolute(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(t.TempDir(), "x")
	os.WriteFile(f, []byte("s"), 0o600)
	if _, _, err := files.ReadForDraft(dir, f); !errors.Is(err, files.ErrOutside) {
		t.Fatalf("%v", err)
	}
	// Even an absolute path that points inside the folder is refused.
	os.WriteFile(filepath.Join(dir, "in"), []byte("s"), 0o600)
	if _, _, err := files.ReadForDraft(dir, filepath.Join(dir, "in")); !errors.Is(err, files.ErrOutside) {
		t.Fatalf("%v", err)
	}
}

func TestReadRejectsSymlinkEscape(t *testing.T) {
	dir, out := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(out, "secret"), []byte("s"), 0o600)
	if err := os.Symlink(filepath.Join(out, "secret"), filepath.Join(dir, "link")); err != nil {
		t.Skip(err)
	}
	if _, _, err := files.ReadForDraft(dir, "link"); !errors.Is(err, files.ErrOutside) {
		t.Fatalf("%v", err)
	}
	// A symlink within the folder is allowed.
	os.WriteFile(filepath.Join(dir, "real"), []byte("r"), 0o600)
	os.Symlink(filepath.Join(dir, "real"), filepath.Join(dir, "alias"))
	if b, _, err := files.ReadForDraft(dir, "alias"); err != nil || string(b) != "r" {
		t.Fatalf("inside symlink: %v", err)
	}
}

func TestReadTooLarge(t *testing.T) {
	dir := t.TempDir()
	f, _ := os.Create(filepath.Join(dir, "big"))
	f.Truncate(files.MaxSize + 1)
	f.Close()
	if _, _, err := files.ReadForDraft(dir, "big"); !errors.Is(err, files.ErrTooLarge) {
		t.Fatalf("%v", err)
	}
}

func TestEmptyDirRefused(t *testing.T) {
	if _, _, err := files.ReadForDraft("", "a"); !errors.Is(err, files.ErrNoDir) {
		t.Fatalf("%v", err)
	}
	if _, err := files.Save("", "a", nil); !errors.Is(err, files.ErrNoDir) {
		t.Fatalf("%v", err)
	}
}
