// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build !linux && !darwin && !windows

package connfile

// nameLimit is how many bytes of a program name processName reports;
// 0 means all of it.
const nameLimit = 0

// processName cannot identify a process's program on this platform, which
// release builds do not target; a live PID of the current user is then
// taken as the host's.
func processName(int) (string, bool) { return HostName, true }
