// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
