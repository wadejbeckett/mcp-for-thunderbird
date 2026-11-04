// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows/registry"

	"github.com/wadejbeckett/mcp-for-thunderbird/host/internal/setup"
)

const testRegRoot = `Software\mcp-for-thunderbird-cmd-test`

// sandboxRegistry points native registration at a test key under HKCU
// for in-process setup runs; the real Mozilla key is never touched.
func sandboxRegistry(t *testing.T) {
	t.Helper()
	restore := setup.SetRegistryBaseForTest(testRegRoot + `\NativeMessagingHosts`)
	t.Cleanup(func() {
		restore()
		registry.DeleteKey(registry.CURRENT_USER, testRegRoot+`\NativeMessagingHosts\`+setup.HostName)
		registry.DeleteKey(registry.CURRENT_USER, testRegRoot+`\NativeMessagingHosts`)
		registry.DeleteKey(registry.CURRENT_USER, testRegRoot)
	})
}

// nativeManifest is where setup writes the manifest on Windows: next to
// the running binary, named by the HKCU key.
func nativeManifest(t *testing.T, home string) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	return filepath.Join(filepath.Dir(exe), setup.HostName+".json")
}

// checkRegistered checks that the HKCU key names manifest ("" = no key).
func checkRegistered(t *testing.T, manifest string) {
	t.Helper()
	if got := setup.RegistryValueForTest(); got != manifest {
		t.Fatalf("registry value %q, want %q", got, manifest)
	}
}
