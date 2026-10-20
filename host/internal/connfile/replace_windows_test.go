// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build windows

package connfile

import (
	"os"
	"testing"
	"time"
)

func isolateInternal(t *testing.T) {
	t.Helper()
	d := t.TempDir()
	t.Setenv("APPDATA", d)
}

// Save replaces the file while another process holds it open the way
// os.Open does (no FILE_SHARE_DELETE): it waits for the reader to close.
// A connect-mode proxy polling every 20 ms made this fail on CI.
func TestSaveWhileOpenElsewhere(t *testing.T) {
	isolateInternal(t)
	c := &Conn{Instance: "busy", Port: 47110, Token: NewToken()}
	if err := Save(c); err != nil {
		t.Fatal(err)
	}
	p, _ := pathFor("busy")
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p, p+".x"); !transient(err) {
		f.Close()
		t.Fatalf("rename over an os.Open'ed file: %v; this test no longer exercises the retry", err)
	}
	go func() { time.Sleep(200 * time.Millisecond); f.Close() }()
	c.Token = NewToken()
	if err := Save(c); err != nil {
		t.Fatalf("save while open: %v", err)
	}
	got, err := Load("busy")
	if err != nil || got.Token != c.Token {
		t.Fatalf("load: %v", err)
	}
}
