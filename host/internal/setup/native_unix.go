// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build !windows

package setup

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// manifestPath is where Thunderbird looks for a per-user native manifest:
// ~/.mozilla/native-messaging-hosts on Linux, the Mozilla folder under
// Application Support on macOS.
func manifestPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".mozilla", "native-messaging-hosts")
	if runtime.GOOS == "darwin" {
		dir = filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
	}
	return filepath.Join(dir, HostName+".json"), nil
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
	p, err := manifestPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
