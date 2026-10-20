// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//go:build unix

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// Thunderbird may end the host with SIGTERM when it quits (and the e2e
// harness does): the host still clears its port and token first (R33).
func TestSIGTERMClearsConnectionFile(t *testing.T) {
	dir := t.TempDir()
	bin := buildHost(t, dir)
	h := startHost(t, bin, dir)
	h.send(t, hello("sigterm", 1))
	if w := readFrame(t, h.stdout); w["ok"] != true {
		t.Fatalf("welcome = %v", w)
	}
	if err := h.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- h.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("host still running 2 s after SIGTERM")
	}
	raw, err := os.ReadFile(filepath.Join(userConfigDir(filepath.Join(dir, "home"), filepath.Join(dir, "config")),
		"mcp-for-thunderbird", "connection-sigterm.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if c.Port != 0 || c.Token != "" {
		t.Fatalf("after SIGTERM: port %d, token set %v", c.Port, c.Token != "")
	}
}
