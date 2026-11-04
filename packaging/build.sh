#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# build.sh [goreleaser release flags]
#
# Checks that THIRD_PARTY_LICENSES matches host/go.mod, runs the pinned
# GoReleaser with packaging/goreleaser.yaml, then packaging/check.sh and its
# self-test. With no flags it makes a local snapshot:
#   sh packaging/build.sh                -> release --snapshot --clean
#   sh packaging/build.sh --clean        -> a tagged release (CI, Task 21)
# Tools run through `go run` at pinned versions; nothing is installed.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
GORELEASER=github.com/goreleaser/goreleaser/v2@v2.13.3
export GOTOOLCHAIN="${MFT_GOTOOLCHAIN:-go1.26.10}"

[ $# -gt 0 ] || set -- --snapshot --clean

# GoReleaser reads the remote URL; a local clone without a remote gets the
# project URL for this process only (the repository config is untouched).
if ! git ls-remote --get-url >/dev/null 2>&1; then
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=remote.origin.url
  export GIT_CONFIG_VALUE_0=https://github.com/wadejbeckett/mcp-for-thunderbird.git
fi

sh packaging/third-party-licenses.sh --check
go run "$GORELEASER" release --config packaging/goreleaser.yaml "$@"
sh packaging/check.sh dist
sh packaging/check-selftest.sh dist
