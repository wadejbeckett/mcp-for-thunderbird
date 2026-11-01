// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build unix

package files

import "syscall"

// openFlags opens a FIFO without waiting for a writer; it has no effect
// on a regular file.
const openFlags = syscall.O_NONBLOCK
