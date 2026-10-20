// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
