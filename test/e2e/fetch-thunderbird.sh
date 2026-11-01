#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Download one Linux x86-64 en-US Thunderbird release from Mozilla, check
# it against Mozilla's published SHA256SUMS (and against the pinned hash,
# when one is given), and unpack it. Prints the path of the thunderbird
# program it unpacked, for run.sh as MFT_E2E_THUNDERBIRD:
#
#   tb=$(test/e2e/fetch-thunderbird.sh 140.17.0esr "$TMPDIR/mft-e2e-tb")
#   MFT_E2E_THUNDERBIRD=$tb test/e2e/run.sh
#
# It only reads from download.mozilla.org and archive.mozilla.org and
# writes only under <dir>/<version>; it installs nothing and never touches
# a Thunderbird profile. An existing <dir>/<version> whose tarball passes
# the check again is reused.
#
# usage: fetch-thunderbird.sh <version, e.g. 140.17.0esr or 159.0> <dir> [sha256]
set -euo pipefail

version=${1:-}
dir=${2:-}
want=${3:-}
if [ -z "$version" ] || [ -z "$dir" ]; then
  echo "usage: fetch-thunderbird.sh <version> <dir> [sha256]" >&2
  exit 2
fi
if ! [[ "$version" =~ ^[0-9]+(\.[0-9]+){1,2}(esr)?$ ]]; then
  echo "fetch-thunderbird.sh: $version is not a release version such as 140.17.0esr or 159.0" >&2
  exit 2
fi
if [ -n "$want" ] && ! [[ "$want" =~ ^[0-9a-f]{64}$ ]]; then
  echo "fetch-thunderbird.sh: the pinned hash must be 64 lower-case hex digits" >&2
  exit 2
fi

out=$dir/$version
tarball=thunderbird-$version.tar.xz
mkdir -p "$out"
cd "$out"
get() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$1" "$2"; }

get SHA256SUMS "https://archive.mozilla.org/pub/thunderbird/releases/$version/SHA256SUMS"
published=$(awk -v f="linux-x86_64/en-US/$tarball" '$2 == f {print $1}' SHA256SUMS)
if ! [[ "$published" =~ ^[0-9a-f]{64}$ ]]; then
  echo "fetch-thunderbird.sh: SHA256SUMS for $version lists no linux-x86_64/en-US/$tarball" >&2
  exit 1
fi
if [ -n "$want" ] && [ "$want" != "$published" ]; then
  echo "fetch-thunderbird.sh: Mozilla's SHA256SUMS gives $published for $tarball, not the pinned $want" >&2
  exit 1
fi
check() { echo "$published  $tarball" | sha256sum -c --status; }
if ! [ -f "$tarball" ] || ! check; then
  rm -rf "$tarball" thunderbird
  get "$tarball" "https://download.mozilla.org/?product=thunderbird-$version-SSL&os=linux64&lang=en-US"
  if ! check; then
    echo "fetch-thunderbird.sh: $tarball does not match Mozilla's SHA256SUMS" >&2
    exit 1
  fi
fi
if ! [ -x thunderbird/thunderbird ]; then
  rm -rf thunderbird
  tar -xJf "$tarball"
fi
echo "$PWD/thunderbird/thunderbird"
