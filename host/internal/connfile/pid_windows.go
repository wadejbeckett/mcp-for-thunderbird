// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build windows

package connfile

import (
	"strconv"

	"golang.org/x/sys/windows"
)

// stillActive is the exit code GetExitCodeProcess reports for a running
// process (STILL_ACTIVE).
const stillActive = 259

// nameLimit is how many bytes of a program name processName reports;
// 0 means all of it.
const nameLimit = 0

// pidAlive reports whether a process with this PID is running and can be
// queried by the current user. A process of another user (access denied)
// cannot be our host.
func pidAlive(pid int) bool {
	if pid <= 0 || pid > 0xFFFFFFFF {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

// processName is the full path of the program pid runs.
func processName(pid int) (string, bool) {
	if pid <= 0 || pid > 0xFFFFFFFF {
		return "", false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil || n == 0 {
		return "", false
	}
	return windows.UTF16ToString(buf[:n]), true
}

// processStart marks pid's start with its creation time (GetProcessTimes),
// in 100-nanosecond intervals since 1601, which Windows stores once per
// process.
func processStart(pid int) (string, bool) {
	if pid <= 0 || pid > 0xFFFFFFFF {
		return "", false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	// An exited process stays queryable while any handle to it is open
	// (its parent's, for one), but it has no start any more that a live
	// PID could match.
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil || code != stillActive {
		return "", false
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return "", false
	}
	t := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if t == 0 {
		return "", false
	}
	return strconv.FormatUint(t, 10), true
}
