#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# THROWAWAY spike (Task 2): new profile from mkprofile.py plus the stored
# GreenMail test logins (key4.db, logins.db) copied from a base profile.
# usage: newprof.sh <base-profile> <new-profile> <imap-user> <xpi> [pref=value ...]
set -eu
base=$1; new=$2; user=$3; xpi=$4; shift 4
python3 "$(dirname "$0")/mkprofile.py" "$new" "$user" "$xpi" "$@"
cp "$base/key4.db" "$base/logins.db" "$new/"
[ -f "$base/logins.json" ] && cp "$base/logins.json" "$new/" || true
