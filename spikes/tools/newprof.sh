#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
# THROWAWAY spike (Task 2): new profile from mkprofile.py plus the stored
# GreenMail test logins (key4.db, logins.db) copied from a base profile.
# usage: newprof.sh <base-profile> <new-profile> <imap-user> <xpi> [pref=value ...]
set -eu
base=$1; new=$2; user=$3; xpi=$4; shift 4
python3 "$(dirname "$0")/mkprofile.py" "$new" "$user" "$xpi" "$@"
cp "$base/key4.db" "$base/logins.db" "$new/"
[ -f "$base/logins.json" ] && cp "$base/logins.json" "$new/" || true
