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

// hostName reports whether name, a process's program name as the platform
// reports it, is the host's.
func hostName(name string) bool {
	name = normaliseName(name)
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
