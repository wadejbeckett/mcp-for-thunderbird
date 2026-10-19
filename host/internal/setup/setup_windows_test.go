// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build windows

package setup

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows/registry"
)

func TestWindowsRegistry(t *testing.T) {
	sandbox(t)
	// A test key path, never the real Mozilla one.
	old := regBase
	regBase = `Software\mcp-for-thunderbird-test\NativeMessagingHosts`
	t.Cleanup(func() {
		regBase = old
		registry.DeleteKey(registry.CURRENT_USER, `Software\mcp-for-thunderbird-test\NativeMessagingHosts\`+HostName)
		registry.DeleteKey(registry.CURRENT_USER, `Software\mcp-for-thunderbird-test\NativeMessagingHosts`)
		registry.DeleteKey(registry.CURRENT_USER, `Software\mcp-for-thunderbird-test`)
	})
	dir := t.TempDir()
	bin := filepath.Join(dir, "mcp-for-thunderbird.exe")
	if err := RegisterNative(bin); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, HostName+".json")
	b, err := os.ReadFile(manifest)
	if err != nil || string(b) != string(ManifestJSON(bin)) {
		t.Fatalf("manifest: %s %v", b, err)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, regBase+`\`+HostName, registry.QUERY_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	v, _, err := k.GetStringValue("")
	k.Close()
	if err != nil || v != manifest {
		t.Fatalf("default value %q %v, want %q", v, err, manifest)
	}
	if err := UnregisterNative(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(manifest); !os.IsNotExist(err) {
		t.Fatalf("manifest not removed: %v", err)
	}
	if k, err := registry.OpenKey(registry.CURRENT_USER, regBase+`\`+HostName, registry.QUERY_VALUE); err == nil {
		k.Close()
		t.Fatal("registry key not removed")
	}
}
