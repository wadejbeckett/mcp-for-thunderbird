// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build windows

package connfile_test

import (
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/connfile"
)

// Cannot be run on the Linux development machine; compile-checked with
// GOOS=windows go vet.
func TestWindowsACLOwnerOnly(t *testing.T) {
	isolate(t)
	if err := connfile.Save(&connfile.Conn{Instance: "w", Port: 47110, Token: connfile.NewToken()}); err != nil {
		t.Fatal(err)
	}
	dir, _ := connfile.Dir()
	path := filepath.Join(dir, "connection-w.json")
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	ctl, _, _ := sd.Control()
	if ctl&windows.SE_DACL_PROTECTED == 0 {
		t.Error("DACL inheritance not disabled")
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		t.Fatalf("no DACL: %v", err)
	}
	if dacl.AceCount != 1 {
		t.Fatalf("want 1 ACE, got %d", dacl.AceCount)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		t.Fatal(err)
	}
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := (*windows.SID)(unsafePointer(&ace.SidStart))
	if !sid.Equals(tu.User.Sid) {
		t.Errorf("ACE SID %s is not the current user %s", sid, tu.User.Sid)
	}
}

func unsafePointer(p *uint32) unsafe.Pointer { return unsafe.Pointer(p) }
