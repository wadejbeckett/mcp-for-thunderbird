// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build linux

package connfile

import (
	"os"
	"strconv"
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
