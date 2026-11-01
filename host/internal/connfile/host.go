// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package connfile

import (
	"os"
	"path/filepath"
	"strings"
)

// HostName is the program name of MCP for Thunderbird's host.
const HostName = "mcp-for-thunderbird"

// HostRunning reports whether pid is a running process of the current user
// whose program is MCP for Thunderbird's host: named mcp-for-thunderbird,
// or the same program as the caller (connect is the same binary as the
// host, whatever it was renamed to). A PID left in a file by a host that
// crashed may have been reused by another program, which must never be
// sent the token (ruling R33). Whenever the program cannot be identified
// the answer is false, so a doubtful file counts as stale.
func HostRunning(pid int) bool {
	if !pidAlive(pid) {
		return false
	}
	name, ok := processName(pid)
	if !ok {
		return false
	}
	return hostName(name)
}

// StartMark returns a mark of when process pid started, as the platform
// records it, or "" when it cannot be read. Two marks are only ever
// compared for equality, on the same computer: a PID that names a
// process with another mark has been reused since the mark was taken.
func StartMark(pid int) string {
	if pid <= 0 {
		return ""
	}
	m, ok := processStart(pid)
	if !ok {
		return ""
	}
	return m
}

// sameStart reports whether pid is known to have started at mark; a
// start that cannot be read is not the same.
func sameStart(pid int, mark string) bool {
	m := StartMark(pid)
	return m != "" && m == mark
}

// PIDReused reports whether c's PID is known to belong to a process that
// started at another time than the host that wrote c: the file records a
// start, and pid's start can be read and differs. Whenever that is in
// doubt (no recorded start, as in files of hosts before 0.2.0, or a start
// that cannot be read) the answer is false, so a takeover decision falls
// back to its other checks rather than treating a live host as gone.
func PIDReused(c *Conn) bool {
	if c == nil || c.Started == "" {
		return false
	}
	m := StartMark(c.PID)
	return m != "" && m != c.Started
}

// hostName reports whether name, a process's program name as the platform
// reports it, is the host's. Both sides are cut to the length the platform
// keeps, so a full name and a kernel-truncated one compare alike.
func hostName(name string) bool {
	name = truncateName(normaliseName(name))
	if name == "" {
		return false
	}
	if name == truncateName(HostName) {
		return true
	}
	if self, err := os.Executable(); err == nil {
		if own := truncateName(normaliseName(self)); own != "" && name == own {
			return true
		}
	}
	return false
}

// normaliseName reduces a program path to its base name, without a
// Windows ".exe" and without the " (deleted)" Linux appends once the
// binary has been replaced, as an upgrade does while the host runs.
func normaliseName(p string) string {
	p = strings.TrimSuffix(p, " (deleted)")
	p = filepath.Base(filepath.Clean(p))
	if p == "." || p == string(filepath.Separator) {
		return ""
	}
	if ext := filepath.Ext(p); strings.EqualFold(ext, ".exe") {
		p = p[:len(p)-len(ext)]
	}
	return p
}

// truncateName cuts name to the length the platform keeps (macOS reports
// at most 16 bytes of a program name).
func truncateName(name string) string {
	if nameLimit > 0 && len(name) > nameLimit {
		return name[:nameLimit]
	}
	return name
}
