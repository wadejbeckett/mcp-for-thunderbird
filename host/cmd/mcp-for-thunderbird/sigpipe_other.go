// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//go:build !unix

package main

// ignoreSIGPIPE is a no-op where there is no SIGPIPE.
func ignoreSIGPIPE() {}
