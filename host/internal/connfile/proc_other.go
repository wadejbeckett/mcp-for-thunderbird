// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build !linux && !darwin && !windows

package connfile

// nameLimit is how many bytes of a program name processName reports;
// 0 means all of it.
const nameLimit = 0

// processName cannot identify a process's program on this platform, which
// release builds do not target; a live PID of the current user is then
// taken as the host's.
func processName(int) (string, bool) { return HostName, true }

// processStart cannot read a process's start on this platform: files
// record no start, and PIDs are compared as before 0.2.0.
func processStart(int) (string, bool) { return "", false }
