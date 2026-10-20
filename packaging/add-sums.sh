#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# add-sums.sh <dist-dir> <file>...
#
# Adds artefacts built after GoReleaser (the Windows installers and the
# macOS pkg, built on their own CI runners) to <dist-dir>/SHA256SUMS. Each
# file must already be in <dist-dir>; one that is listed already is
# refused, so a stale sum can never stay behind. The whole file is then
# verified.
set -eu

[ $# -ge 2 ] || { echo "usage: add-sums.sh <dist-dir> <file>..." >&2; exit 2; }
dist=$(cd "$1" && pwd)
shift
[ -f "$dist/SHA256SUMS" ] || { echo "add-sums: no $dist/SHA256SUMS" >&2; exit 1; }
cd "$dist"
for f in "$@"; do
  name=$(basename "$f")
  [ -f "$name" ] || { echo "add-sums: $name is not in $dist" >&2; exit 1; }
  if awk -v f="$name" '$2 == f { found = 1 } END { exit !found }' SHA256SUMS; then
    echo "add-sums: $name is already listed" >&2
    exit 1
  fi
  sha256sum "$name" >>SHA256SUMS
done
sha256sum --check --strict --quiet SHA256SUMS
for f in "$@"; do
  awk -v f="$(basename "$f")" '$2 == f { found = 1 } END { exit !found }' SHA256SUMS ||
    { echo "add-sums: $(basename "$f") not listed" >&2; exit 1; }
done
echo OK
