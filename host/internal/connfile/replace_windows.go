// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build windows

package connfile

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// replaceWait bounds how long replace retries while another process has
// the connection file open.
const replaceWait = 2 * time.Second

// replace renames tmp over path. Windows (MoveFileEx) refuses to replace
// a file while any process has it open (a connect-mode proxy reading it,
// a virus scanner), with "Access is denied" or a sharing violation; those
// are retried briefly. Readers hold the file only for a moment.
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
