#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
export GOTOOLCHAIN="${MFT_GOTOOLCHAIN:-go1.25.14}"

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
