// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
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
