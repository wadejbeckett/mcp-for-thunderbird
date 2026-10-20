// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
package files_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

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
		// Save returns the resolved path: macOS temp folders live under the
		// /var -> /private/var symlink, and Windows ones may use a short
		// (8.3) name such as RUNNER~1.
		if filepath.Base(p) != want || filepath.Dir(p) != resolved(t, dir) {
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
	// Unix modes; on Windows (no modes) TestSavePrivateWindows checks the DACL.
	if runtime.GOOS != "windows" {
		for _, d := range []string{dir, filepath.Dir(dir)} {
			if st, _ := os.Stat(d); st.Mode().Perm() != 0o700 {
				t.Fatalf("%s mode %o", d, st.Mode().Perm())
			}
		}
		if st, _ := os.Stat(filepath.Join(dir, "report.pdf")); st.Mode().Perm() != 0o600 {
			t.Fatalf("file mode %o", st.Mode().Perm())
		}
	}
}

// resolved is dir with symlinks (and Windows short names) resolved.
func resolved(t *testing.T, dir string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestSaveReturnsResolvedPath(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	p, err := files.Save(link, "a.txt", []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(resolved(t, real), "a.txt"); p != want {
		t.Fatalf("saved as %s, want %s", p, want)
	}
}

func TestSaveLeavesExistingDirMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix modes")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := files.Save(dir, "a.txt", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(dir); st.Mode().Perm() != 0o755 {
		t.Fatalf("existing folder changed to %o", st.Mode().Perm())
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

func TestSaveShortensLongNames(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("é", 1000) + strings.Repeat("n", 1000) + ".pdf" // 2004 characters
	for i := 0; i < 2; i++ {
		p, err := files.Save(dir, long, []byte("x"))
		if err != nil {
			t.Fatal(err)
		}
		base := filepath.Base(p)
		if len(base) > 200 || !utf8.ValidString(base) || !strings.HasSuffix(base, ".pdf") || !strings.HasPrefix(base, "éé") {
			t.Errorf("save %d: name %q (%d bytes), want valid UTF-8 of at most 200 bytes ending .pdf", i, base, len(base))
		}
		if i == 1 && !strings.HasSuffix(base, " (2).pdf") {
			t.Errorf("second save %q lacks (2)", base)
		}
	}
	// a long "extension" is not kept whole
	p, err := files.Save(dir, "a."+strings.Repeat("x", 2000), []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	if b := filepath.Base(p); len(b) > 200 || !utf8.ValidString(b) {
		t.Errorf("long extension: %q (%d bytes)", b, len(b))
	}
}

// Windows reserved device names, with any extension and in any case, are
// prefixed on every platform so a saved file never opens a device.
func TestSaveReservedNames(t *testing.T) {
	cases := map[string]string{
		"CON":         "_CON",
		"con.txt":     "_con.txt",
		"Prn.tar.gz":  "_Prn.tar.gz",
		"aux":         "_aux",
		"NUL.pdf":     "_NUL.pdf",
		"com1":        "_com1",
		"COM9.log":    "_COM9.log",
		"lpt1.txt":    "_lpt1.txt",
		"LPT9":        "_LPT9",
		"nul .txt":    "_nul .txt",
		"CONSOLE.txt": "CONSOLE.txt",
		"com10.txt":   "com10.txt",
		"com0.txt":    "com0.txt",
		"icon.png":    "icon.png",
		"x/AUX.doc":   "_AUX.doc",
		"lpt.txt":     "lpt.txt",
		"notes.con":   "notes.con",
	}
	for in, want := range cases {
		dir := t.TempDir()
		p, err := files.Save(dir, in, []byte("x"))
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if filepath.Base(p) != want {
			t.Errorf("%q saved as %s, want %s", in, filepath.Base(p), want)
		}
	}
}
