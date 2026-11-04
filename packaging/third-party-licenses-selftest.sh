#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# third-party-licenses-selftest.sh
#
# Proves packaging/third-party-licenses.sh lists what it claims to, on a
# small module of its own made in a temporary directory (no network): a
# module that go.mod replaces with a local path is listed with its
# replacement and its licence, every licence and notice file of a module is
# embedded (LICENSE, COPYING and NOTICE), the main module is left out,
# --check tells a current file from a changed one, and a module under a
# copyleft licence makes the script fail. Prints PASS or the first failure.
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
echo "Attribution notice of module two." >"$work/two/NOTICE"
echo "Licence of the main module, never listed." >"$work/app/LICENSE"

out="$work/THIRD_PARTY_LICENSES"
MFT_LICENSES_MODULE="$work/app" MFT_LICENSES_OUT="$out" GOFLAGS=-mod=mod GOPROXY=off \
  sh "$script" >/dev/null || fail "the script failed on a module with local replacements"

grep -qxF "example.test/dep v1.2.3 => ../dep" "$out" || fail "the replaced module is not listed with its replacement"
grep -qxF "Licence text of the replaced dep module." "$out" || fail "the replaced module's licence is missing"
echo "listed: example.test/dep v1.2.3 => ../dep, with its licence"
grep -qxF "example.test/two v0.1.0 => ../two" "$out" || fail "module two is not listed with its replacement"
for want in "--- COPYING ---" "--- LICENSE ---" "--- NOTICE ---" "First licence of module two." "Second licence of module two." "Attribution notice of module two."; do
  grep -qxF -- "$want" "$out" || fail "module two lacks: $want"
done
echo "embedded: both licence files and the notice of example.test/two"
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

# A dependency under the GPL must stop the build, whatever its version.
printf '                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n' >"$work/dep/LICENSE"
if MFT_LICENSES_MODULE="$work/app" MFT_LICENSES_OUT="$out" GOFLAGS=-mod=mod GOPROXY=off \
  sh "$script" >/dev/null 2>&1; then
  fail "a module under the GPL was accepted"
fi
grep -qxF "Licence text of the replaced dep module." "$out" || fail "a refused run changed the output file"
echo "refused: a module under the GPL, with the output file left as it was"

echo PASS
