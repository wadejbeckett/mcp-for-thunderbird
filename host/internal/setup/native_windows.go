// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build windows

package setup

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// regBase is the HKCU key under which Mozilla applications look up native
// hosts; tests point it at a test key.
var regBase = `Software\Mozilla\NativeMessagingHosts`

// registerNative writes the manifest next to the binary and points
// HKCU\<regBase>\mcp_for_thunderbird (default value) at it.
func registerNative(binPath string) error {
	manifest := filepath.Join(filepath.Dir(binPath), HostName+".json")
	if err := writeAtomic(manifest, ManifestJSON(binPath), 0o644); err != nil {
		return err
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, regBase+`\`+HostName, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("", manifest)
}

// unregisterNative removes the manifest the registry key names (only if it
// is our manifest file name) and then the key.
func unregisterNative() error {
	key := regBase + `\` + HostName
	k, err := registry.OpenKey(registry.CURRENT_USER, key, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	manifest, _, err := k.GetStringValue("")
	k.Close()
	if err == nil && strings.EqualFold(filepath.Base(manifest), HostName+".json") {
		if err := os.Remove(manifest); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, key); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

// SetRegistryBaseForTest points registration at another HKCU key and
// returns a function that restores the real one, so tests outside this
// package never touch HKCU\Software\Mozilla.
func SetRegistryBaseForTest(base string) (restore func()) {
	old := regBase
	regBase = base
	return func() { regBase = old }
}

// RegistryValueForTest returns the manifest path registered under the
// current base, or "" if there is none.
func RegistryValueForTest() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, regBase+`\`+HostName, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue("")
	return v
}
