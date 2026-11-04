// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build linux

package connfile

import (
	"os"
	"strconv"
	"strings"
)

// nameLimit is how many bytes of a program name processName reports;
// 0 means all of it.
const nameLimit = 0

// processName is the path of the program pid runs, from /proc/<pid>/exe,
// which only the process's own user (or root) may read.
func processName(pid int) (string, bool) {
	p, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if err != nil || p == "" {
		return "", false
	}
	return p, true
}

// processStart marks pid's start with this boot's id and the start time
// in clock ticks since boot (field 22 of /proc/<pid>/stat). The tick
// count never changes for a process, unlike a wall-clock time derived
// from the boot time, which moves when the clock is set; the boot id
// tells a PID and tick count reused after a restart apart.
func processStart(pid int) (string, bool) {
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", false
	}
	id := strings.TrimSpace(string(boot))
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil || id == "" {
		return "", false
	}
	ticks, ok := statStart(string(stat))
	if !ok {
		return "", false
	}
	return id + ":" + ticks, true
}

// statStart returns field 22 (starttime) of a /proc/<pid>/stat line. The
// program name, field 2, is in parentheses and may itself hold spaces and
// parentheses, so the fields are counted from the last ")".
func statStart(stat string) (string, bool) {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return "", false
	}
	f := strings.Fields(stat[i+1:]) // f[0] is field 3
	if len(f) < 20 {
		return "", false
	}
	if _, err := strconv.ParseUint(f[19], 10, 64); err != nil {
		return "", false
	}
	return f[19], true
}
