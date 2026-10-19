// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
package connfile_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"net"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
)

func isolate(t *testing.T) {
	t.Helper()
	d := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", d)
	t.Setenv("HOME", d)
	t.Setenv("AppData", d)
}

func TestTokenIs64Hex(t *testing.T) {
	a, b := connfile.NewToken(), connfile.NewToken()
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(a) {
		t.Fatalf("bad token %q", a)
	}
	if a == b {
		t.Fatal("tokens repeat")
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	isolate(t)
	c := &connfile.Conn{Instance: "abc-123_X", Port: 47111, Token: connfile.NewToken(), PID: 42}
	if err := connfile.Save(c); err != nil {
		t.Fatal(err)
	}
	got, err := connfile.Load("abc-123_X")
	if err != nil {
		t.Fatal(err)
	}
	if got.Instance != c.Instance || got.Port != c.Port || got.Token != c.Token || got.PID != 42 || got.UpdatedAt.IsZero() {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	dir, _ := connfile.Dir()
	if _, err := os.Stat(filepath.Join(dir, "connection-abc-123_X.json")); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Fatalf("temp files left behind: %v", ents)
	}
}

func TestRejectsBadInstance(t *testing.T) {
	isolate(t)
	for _, bad := range []string{"", "../x", "a/b", "a.b", "a b", strings.Repeat("a", 65)} {
		if err := connfile.Save(&connfile.Conn{Instance: bad, Port: 1}); err == nil {
			t.Errorf("Save accepted %q", bad)
		}
		if _, err := connfile.Load(bad); err == nil {
			t.Errorf("Load accepted %q", bad)
		}
	}
}

func TestRotateChangesToken(t *testing.T) {
	isolate(t)
	c := &connfile.Conn{Instance: "i1", Port: 47110, Token: connfile.NewToken()}
	if err := connfile.Save(c); err != nil {
		t.Fatal(err)
	}
	old := c.Token
	if err := connfile.Rotate(c); err != nil {
		t.Fatal(err)
	}
	got, _ := connfile.Load("i1")
	if got.Token == old || got.Token != c.Token || len(got.Token) != 64 {
		t.Fatal("token not rotated on disk")
	}
}

func TestPickPortReusesPreferred(t *testing.T) {
	ln, p, err := connfile.PickPort(47115)
	if err != nil {
		t.Skipf("47115 unavailable: %v", err)
	}
	defer ln.Close()
	if p != 47115 {
		t.Fatalf("got %d", p)
	}
}

func TestPickPortSkipsBusy(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:47110")
	if err != nil {
		t.Skipf("47110 unavailable: %v", err)
	}
	defer busy.Close()
	ln, p, err := connfile.PickPort(47110)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if p != 47111 {
		t.Fatalf("got %d, want 47111", p)
	}
}

func TestNewestPicksLatest(t *testing.T) {
	isolate(t)
	if _, err := connfile.Newest(); err == nil {
		t.Fatal("expected error with no files")
	}
	a := &connfile.Conn{Instance: "a", Port: 47110, Token: connfile.NewToken()}
	b := &connfile.Conn{Instance: "b", Port: 47111, Token: connfile.NewToken()}
	connfile.Save(a)
	time.Sleep(5 * time.Millisecond)
	connfile.Save(b)
	got, err := connfile.Newest()
	if err != nil || got.Instance != "b" {
		t.Fatalf("got %+v %v", got, err)
	}
	time.Sleep(5 * time.Millisecond)
	connfile.Rotate(a)
	got, _ = connfile.Newest()
	if got.Instance != "a" {
		t.Fatalf("rotate should make a newest, got %s", got.Instance)
	}
}
