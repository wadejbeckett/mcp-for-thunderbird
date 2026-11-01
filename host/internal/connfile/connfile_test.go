// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
package connfile_test

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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

// TestHelperSleep is not a test: run as a child with MFT_HELPER_SLEEP=1
// it stays alive until killed, standing in for another program.
func TestHelperSleep(t *testing.T) {
	if os.Getenv("MFT_HELPER_SLEEP") != "1" {
		return
	}
	time.Sleep(time.Minute)
	os.Exit(0)
}

// runAs copies this test binary to a file called name and runs it as a
// live child, whose PID it returns.
func runAs(t *testing.T, name string) int {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	bin := filepath.Join(t.TempDir(), name)
	src, err := os.Open(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	dst, err := os.OpenFile(bin, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		t.Fatal(err)
	}
	if err := dst.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "-test.run=^TestHelperSleep$")
	cmd.Env = append(os.Environ(), "MFT_HELPER_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd.Process.Pid
}

// After a host crash its PID may be reused by another program of the same
// user, perhaps one listening on the old port: the file is then stale, and
// the token must not be sent there (R33).
func TestUsableNeedsTheHostProgram(t *testing.T) {
	tok := connfile.NewToken()
	other := runAs(t, "other-program")
	host := runAs(t, "mcp-for-thunderbird")
	for _, c := range []struct {
		name string
		pid  int
		ok   bool
	}{
		{"another program", other, false},
		{"a host", host, true},
		{"this program", os.Getpid(), true},
	} {
		err := connfile.Usable(&connfile.Conn{Instance: "x", Port: 47110, Token: tok, PID: c.pid})
		if (err == nil) != c.ok {
			t.Errorf("%s: Usable = %v, want ok %v", c.name, err, c.ok)
		}
		if got := connfile.HostRunning(c.pid); got != c.ok {
			t.Errorf("%s: HostRunning = %v, want %v", c.name, got, c.ok)
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

// Two hosts sharing an instance id (a copied profile, or an add-on reload
// racing the old host's exit) must not wipe each other's port and token:
// a host clears or rotates the file only while it names its PID and port.
func TestClearAndRotateOnlyOwnFile(t *testing.T) {
	isolate(t)
	mine := &connfile.Conn{Instance: "dup", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
	if err := connfile.Save(mine); err != nil {
		t.Fatal(err)
	}
	theirs := &connfile.Conn{Instance: "dup", Port: 47111, Token: connfile.NewToken(), PID: os.Getpid() + 1}
	if err := connfile.Save(theirs); err != nil {
		t.Fatal(err)
	}
	if err := connfile.Rotate(mine); !errors.Is(err, connfile.ErrNotOwner) {
		t.Fatalf("Rotate = %v, want ErrNotOwner", err)
	}
	if err := connfile.Clear(mine); !errors.Is(err, connfile.ErrNotOwner) {
		t.Fatalf("Clear = %v, want ErrNotOwner", err)
	}
	if mine.Port != 0 || mine.Token != "" {
		t.Fatal("Clear left the port and token in memory")
	}
	got, err := connfile.Load("dup")
	if err != nil || got.Port != theirs.Port || got.Token != theirs.Token || got.PID != theirs.PID {
		t.Fatalf("the other host's file was changed: %+v %v", got, err)
	}
	// The other host clears its own file.
	if err := connfile.Clear(theirs); err != nil {
		t.Fatal(err)
	}
	if got, _ := connfile.Load("dup"); got.Port != 0 || got.Token != "" {
		t.Fatalf("own file not cleared: %+v", got)
	}
}

func TestClearWithoutFile(t *testing.T) {
	isolate(t)
	c := &connfile.Conn{Instance: "none", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
	if err := connfile.Clear(c); err != nil {
		t.Fatal(err)
	}
	if _, err := connfile.Load("none"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Clear created a file: %v", err)
	}
}

// A rotation the user asked for must replace the token even when the file
// has gone missing or cannot be read: the host writes a fresh file.
func TestRotateRewritesMissingOrCorruptFile(t *testing.T) {
	for _, tc := range []struct {
		name  string
		spoil func(path string) error
	}{
		{"missing", os.Remove},
		{"corrupt", func(p string) error { return os.WriteFile(p, []byte("{not json"), 0o600) }},
		{"bad instance", func(p string) error { return os.WriteFile(p, []byte(`{"instance":"../x"}`), 0o600) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolate(t)
			c := &connfile.Conn{Instance: "rot", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
			if err := connfile.Save(c); err != nil {
				t.Fatal(err)
			}
			dir, _ := connfile.Dir()
			if err := tc.spoil(filepath.Join(dir, "connection-rot.json")); err != nil {
				t.Fatal(err)
			}
			old := c.Token
			if err := connfile.Rotate(c); err != nil {
				t.Fatalf("Rotate = %v", err)
			}
			if c.Token == old || len(c.Token) != 64 {
				t.Fatalf("token in memory not rotated: %q", c.Token)
			}
			got, err := connfile.Load("rot")
			if err != nil || got.Token != c.Token || got.Port != 47110 || got.PID != os.Getpid() {
				t.Fatalf("file not rewritten: %+v %v", got, err)
			}
		})
	}
}

// When another host has taken the file over, Rotate leaves it alone but
// forgets the old token, so the key the user asked to replace stops working.
func TestRotateRefusedForgetsOldToken(t *testing.T) {
	isolate(t)
	mine := &connfile.Conn{Instance: "dup", Port: 47110, Token: connfile.NewToken(), PID: os.Getpid()}
	if err := connfile.Save(mine); err != nil {
		t.Fatal(err)
	}
	theirs := &connfile.Conn{Instance: "dup", Port: 47111, Token: connfile.NewToken(), PID: os.Getpid() + 1}
	if err := connfile.Save(theirs); err != nil {
		t.Fatal(err)
	}
	if err := connfile.Rotate(mine); !errors.Is(err, connfile.ErrNotOwner) {
		t.Fatalf("Rotate = %v, want ErrNotOwner", err)
	}
	if mine.Token != "" {
		t.Fatalf("old token still in memory: %q", mine.Token)
	}
	if got, _ := connfile.Load("dup"); got.Token != theirs.Token || got.PID != theirs.PID {
		t.Fatalf("the other host's file was changed: %+v", got)
	}
}
