// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//go:build unix

package main

import (
	"os/signal"
	"syscall"
)

// ignoreSIGPIPE makes a write after Thunderbird closes the pipe return an
// error instead of killing the host.
func ignoreSIGPIPE() { signal.Ignore(syscall.SIGPIPE) }
