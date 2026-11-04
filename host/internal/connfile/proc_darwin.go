// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build darwin

package connfile

import (
	"bytes"
	"strconv"

	"golang.org/x/sys/unix"
)

// nameLimit is how many bytes of a program name processName reports: the
// kernel keeps the first 16 (MAXCOMLEN).
const nameLimit = 16

// processName is the program name the kernel records for pid (p_comm).
func processName(pid int) (string, bool) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || kp == nil || int(kp.Proc.P_pid) != pid {
		return "", false
	}
	comm := kp.Proc.P_comm[:]
	if i := bytes.IndexByte(comm, 0); i >= 0 {
		comm = comm[:i]
	}
	if len(comm) == 0 {
		return "", false
	}
	return string(comm), true
}

// processStart marks pid's start with the time the kernel recorded when
// it forked the process (p_starttime), in seconds and microseconds. The
// value is stored once per process, so it never changes while it runs.
func processStart(pid int) (string, bool) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || kp == nil || int(kp.Proc.P_pid) != pid {
		return "", false
	}
	st := kp.Proc.P_starttime
	if st.Sec == 0 && st.Usec == 0 {
		return "", false
	}
	return strconv.FormatInt(int64(st.Sec), 10) + "." + strconv.FormatInt(int64(st.Usec), 10), true
}
