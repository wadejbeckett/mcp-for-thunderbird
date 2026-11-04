// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package acl makes a file or folder private to the current user: mode
// 0600 or 0700 on Unix, and a protected DACL with a single entry for the
// current user on Windows, where Unix modes have no effect.
package acl
