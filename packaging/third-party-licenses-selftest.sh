#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# third-party-licenses-selftest.sh
#
# Proves packaging/third-party-licenses.sh lists what it claims to, on a
# small module of its own made in a temporary directory (no network): a
# module that go.mod replaces with a local path is listed with its
# replacement and its licence, every licence file of a module is embedded
# (LICENSE and COPYING both), the main module is left out, and --check
# tells a current file from a changed one. Prints PASS or the first failure.
# Needs sh, go and grep.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/packaging/third-party-licenses.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "third-party-licenses-selftest: $*" >&2
  exit 1
}

# app requires example.test/dep v1.2.3 and example.test/two v0.1.0; both
# are replaced with local directories that no module proxy has.
mkdir -p "$work/app/cmd/mcp-for-thunderbird" "$work/dep" "$work/two"
cat >"$work/app/go.mod" <<'MOD'
module example.test/app

go 1.25.0

require (
	example.test/dep v1.2.3
	example.test/two v0.1.0
)

replace example.test/dep v1.2.3 => ../dep

replace example.test/two => ../two
MOD
cat >"$work/app/cmd/mcp-for-thunderbird/main.go" <<'GO'
package main

import (
	"example.test/dep"
	"example.test/two"
)

func main() { dep.F(); two.F() }
GO
printf 'module example.test/dep\n\ngo 1.25.0\n' >"$work/dep/go.mod"
printf 'package dep\n\nfunc F() {}\n' >"$work/dep/dep.go"
echo "Licence text of the replaced dep module." >"$work/dep/LICENSE"
printf 'module example.test/two\n\ngo 1.25.0\n' >"$work/two/go.mod"
printf 'package two\n\nfunc F() {}\n' >"$work/two/two.go"
echo "First licence of module two." >"$work/two/LICENSE"
echo "Second licence of module two." >"$work/two/COPYING"
echo "Licence of the main module, never listed." >"$work/app/LICENSE"

out="$work/THIRD_PARTY_LICENSES"
MFT_LICENSES_MODULE="$work/app" MFT_LICENSES_OUT="$out" GOFLAGS=-mod=mod GOPROXY=off \
  sh "$script" >/dev/null || fail "the script failed on a module with local replacements"

grep -qxF "example.test/dep v1.2.3 => ../dep" "$out" || fail "the replaced module is not listed with its replacement"
grep -qxF "Licence text of the replaced dep module." "$out" || fail "the replaced module's licence is missing"
echo "listed: example.test/dep v1.2.3 => ../dep, with its licence"
grep -qxF "example.test/two v0.1.0 => ../two" "$out" || fail "module two is not listed with its replacement"
for want in "--- COPYING ---" "--- LICENSE ---" "First licence of module two." "Second licence of module two."; do
  grep -qxF -- "$want" "$out" || fail "module two lacks: $want"
done
echo "embedded: both licence files of example.test/two"
if grep -qF "example.test/app" "$out" || grep -qF "Licence of the main module" "$out"; then
  fail "the main module is listed"
fi
echo "left out: the main module"

MFT_LICENSES_MODULE="$work/app" MFT_LICENSES_OUT="$out" GOFLAGS=-mod=mod GOPROXY=off \
  sh "$script" --check >/dev/null || fail "--check fails on a current file"
echo "changed" >>"$out"
if MFT_LICENSES_MODULE="$work/app" MFT_LICENSES_OUT="$out" GOFLAGS=-mod=mod GOPROXY=off \
  sh "$script" --check >/dev/null 2>&1; then
  fail "--check passes a changed file"
fi
echo "--check: passes a current file, fails a changed one"

echo PASS
