// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build !windows

package main

import (
	"path/filepath"
	"runtime"
	"testing"
)

func sandboxRegistry(*testing.T) {}

// nativeManifest is where setup writes the per-user manifest.
func nativeManifest(t *testing.T, home string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Mozilla", "NativeMessagingHosts", "mcp_for_thunderbird.json")
	}
	return filepath.Join(home, ".mozilla", "native-messaging-hosts", "mcp_for_thunderbird.json")
}

func checkRegistered(*testing.T, string) {}
