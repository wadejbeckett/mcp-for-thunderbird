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
	"os/exec"

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
	a := &connfile.Conn{Instance: "a", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
	b := &connfile.Conn{Instance: "b", Port: 47111, Token: connfile.NewToken(), PID: os.Getpid()}
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

// deadPID is the PID of a child process that has already exited.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

// R33: a connection file is used only while the host that wrote it is
// alive and its port is in 47110-47119; anything else may be a stale port
// that another program now owns.
func TestUsable(t *testing.T) {
	tok := connfile.NewToken()
	dead := deadPID(t)
	cases := []struct {
		name string
		c    connfile.Conn
		ok   bool
	}{
		{"live", connfile.Conn{Instance: "x", Port: 47110, Token: tok, PID: os.Getpid()}, true},
		{"top of range", connfile.Conn{Instance: "x", Port: 47119, Token: tok, PID: os.Getpid()}, true},
		{"dead pid", connfile.Conn{Instance: "x", Port: 47110, Token: tok, PID: dead}, false},
		{"no pid", connfile.Conn{Instance: "x", Port: 47110, Token: tok}, false},
		{"negative pid", connfile.Conn{Instance: "x", Port: 47110, Token: tok, PID: -1}, false},
		{"cleared port", connfile.Conn{Instance: "x", Port: 0, Token: tok, PID: os.Getpid()}, false},
		{"below range", connfile.Conn{Instance: "x", Port: 47109, Token: tok, PID: os.Getpid()}, false},
		{"above range", connfile.Conn{Instance: "x", Port: 47120, Token: tok, PID: os.Getpid()}, false},
		{"other port", connfile.Conn{Instance: "x", Port: 8080, Token: tok, PID: os.Getpid()}, false},
		{"cleared token", connfile.Conn{Instance: "x", Port: 47110, PID: os.Getpid()}, false},
	}
	for _, c := range cases {
		err := connfile.Usable(&c.c)
		if (err == nil) != c.ok {
			t.Errorf("%s: Usable = %v, want ok %v", c.name, err, c.ok)
		}
	}
}

func TestNewestSkipsUnusableFiles(t *testing.T) {
	isolate(t)
	live := &connfile.Conn{Instance: "live", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
	connfile.Save(live)
	time.Sleep(5 * time.Millisecond)
	// Newer, but written by a host that has gone.
	connfile.Save(&connfile.Conn{Instance: "dead", Port: 47111, Token: connfile.NewToken(), PID: deadPID(t)})
	time.Sleep(5 * time.Millisecond)
	// Newer, but on a port outside the range.
	connfile.Save(&connfile.Conn{Instance: "far", Port: 8080, Token: connfile.NewToken(), PID: os.Getpid()})
	got, err := connfile.Newest()
	if err != nil || got.Instance != "live" {
		t.Fatalf("got %+v %v, want the live file", got, err)
	}
	live.Port = 0 // the host cleared its port on exit
	connfile.Save(live)
	if got, err := connfile.Newest(); err == nil {
		t.Fatalf("got %+v, want no usable file", got)
	}
}

func TestPickPortBindsLoopbackOnly(t *testing.T) {
	ln, _, err := connfile.PickPort(0)
	if err != nil {
		t.Skipf("no free port: %v", err)
	}
	defer ln.Close()
	addr := ln.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("listening on %v, want 127.0.0.1 only", addr)
	}
}
