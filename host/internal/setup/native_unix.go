// Copyright (C) 2026 Wade J. Beckett
// This file is part of MCP for Thunderbird, free software: you can redistribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
// SPDX-License-Identifier: GPL-3.0-or-later
//go:build !windows

package setup

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// manifestDir is where Thunderbird looks for a per-user native manifest:
// ~/.mozilla/native-messaging-hosts on Linux, and on macOS
// ~/Library/Mozilla/NativeMessagingHosts. That is not Firefox's macOS
// folder (~/Library/Application Support/Mozilla/NativeMessagingHosts):
// Thunderbird keeps its user data in ~/Library, not in Application Support.
// Thunderbird 157 on macOS reported ~/Library/Mozilla as its
// XREUserNativeManifests folder and did not find a manifest in the Firefox
// folder (CI run 39360260848).
func manifestDir(home string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Mozilla", "NativeMessagingHosts")
	}
	return filepath.Join(home, ".mozilla", "native-messaging-hosts")
}

// legacyManifestDirs are folders earlier builds wrote to; unregistering
// cleans them up.
func legacyManifestDirs(home string) []string {
	if runtime.GOOS == "darwin" {
		return []string{filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")}
	}
	return nil
}

func manifestPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(manifestDir(home), HostName+".json"), nil
}

func registerNative(binPath string) error {
	p, err := manifestPath()
	if err != nil {
		return err
	}
	if err := writeAtomic(p, ManifestJSON(binPath), 0o644); err != nil {
		return err
	}
	// writeAtomic keeps an existing file's mode; the manifest is always 0644.
	return os.Chmod(p, 0o644)
}

func unregisterNative() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	for _, dir := range append([]string{manifestDir(home)}, legacyManifestDirs(home)...) {
		if err := os.Remove(filepath.Join(dir, HostName+".json")); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}
