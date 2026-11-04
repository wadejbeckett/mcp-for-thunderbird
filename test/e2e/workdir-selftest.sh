#!/bin/bash
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# workdir-selftest.sh
#
# Proves the work directory run.sh uses (workdir.sh) is new for each run,
# lies under $TMPDIR or $XDG_RUNTIME_DIR, is private to the user, and that
# a directory that is not private is refused. Prints PASS or the first
# failure. Needs bash, mktemp and GNU stat.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=workdir.sh
. "$here/workdir.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "workdir-selftest: $*" >&2
  exit 1
}

mkdir "$scratch/tmp" "$scratch/run"
a=$(TMPDIR="$scratch/tmp" e2e_new_workdir)
b=$(TMPDIR="$scratch/tmp" e2e_new_workdir)
[ "$a" != "$b" ] || fail "two runs got the same directory $a"
for d in "$a" "$b"; do
  case "$d" in "$scratch/tmp"/mft-e2e.*) ;; *) fail "$d is not mft-e2e.* under \$TMPDIR" ;; esac
  e2e_private "$d" || fail "a new work directory is not private: $d"
done
echo "new private directories under \$TMPDIR: ${a##*/} ${b##*/}"

c=$(unset TMPDIR; XDG_RUNTIME_DIR="$scratch/run" e2e_new_workdir)
case "$c" in "$scratch/run"/mft-e2e.*) ;; *) fail "$c is not under \$XDG_RUNTIME_DIR" ;; esac
echo "without \$TMPDIR: under \$XDG_RUNTIME_DIR (${c##*/})"

refused() {
  if e2e_private "$1" 2>/dev/null; then
    fail "not refused: $2"
  fi
  echo "refused: $2"
}
mkdir "$scratch/open" && chmod 755 "$scratch/open"
refused "$scratch/open" "a directory with mode 0755"
mkdir "$scratch/group" && chmod 770 "$scratch/group"
refused "$scratch/group" "a directory with mode 0770"
ln -s "$a" "$scratch/link"
refused "$scratch/link" "a symlink to a private directory"
refused "$scratch/none" "a path that does not exist"
: >"$scratch/file" && chmod 700 "$scratch/file"
refused "$scratch/file" "a file"
if [ "$(id -u)" != 0 ] && [ -d /root ] && [ "$(stat -c %u /root)" = 0 ]; then
  refused /root "a directory owned by another user (/root)"
fi

echo PASS
