# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Sourced by run.sh (and workdir-selftest.sh): the end-to-end work
# directory on Linux.
#
# e2e_new_workdir prints a new directory made by mktemp -d, named
# mft-e2e.XXXXXXXX, under $TMPDIR, else $XDG_RUNTIME_DIR, else /tmp.
# mktemp makes it with mode 0700 and a name no other user can guess ahead.
e2e_new_workdir() {
  mktemp -d "${TMPDIR:-${XDG_RUNTIME_DIR:-/tmp}}/mft-e2e.XXXXXXXX"
}

# e2e_private <dir> succeeds only when <dir> is a directory, not a
# symlink, owned by the current user, with mode 0700; otherwise it says why
# on stderr and returns 1.
e2e_private() {
  local owner mode
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    echo "run.sh: refusing $1 (not a directory)" >&2
    return 1
  fi
  owner=$(stat -c %u "$1") && mode=$(stat -c %a "$1") || return 1
  if [ "$owner" != "$(id -u)" ] || [ "$mode" != 700 ]; then
    echo "run.sh: refusing $1 (owner uid $owner, mode $mode; want uid $(id -u), mode 700)" >&2
    return 1
  fi
}
