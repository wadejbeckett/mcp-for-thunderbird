// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build !windows

package connfile

import "os"

// replace renames tmp over path.
func replace(tmp, path string) error { return os.Rename(tmp, path) }
