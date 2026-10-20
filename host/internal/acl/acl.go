// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Package acl makes a file or folder private to the current user: mode
// 0600 or 0700 on Unix, and a protected DACL with a single entry for the
// current user on Windows, where Unix modes have no effect.
package acl
