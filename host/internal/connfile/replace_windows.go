// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build windows

package connfile

import (
	"errors"
	"io"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// replaceWait bounds how long replace retries while another process has
// the connection file open.
const replaceWait = 2 * time.Second

// replace renames tmp over path. Windows refuses to replace a file that
// another process has open without FILE_SHARE_DELETE (Go's os.Open, a
// virus scanner, a connect-mode proxy of an older version polling the
// file), with "Access is denied" or a sharing violation; those are retried
// briefly.
func replace(tmp, path string) error {
	deadline := time.Now().Add(replaceWait)
	for {
		err := os.Rename(tmp, path)
		if err == nil || !transient(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func transient(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}

// readFile reads path with FILE_SHARE_DELETE, so a reader never stops the
// writer from replacing the file.
func readFile(path string) ([]byte, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	return io.ReadAll(f)
}
