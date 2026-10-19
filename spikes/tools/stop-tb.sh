#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# THROWAWAY spike (Task 2): stop only the Thunderbird started by run-tb.sh for
# this spike dir (its own process group), never any other Thunderbird.
# usage: stop-tb.sh <spike-dir>
set -u
pid=$(cat "$1/xvfb-run.pid")
pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
[ -n "$pgid" ] || { echo "not running"; exit 0; }
[ "$pgid" = "$pid" ] || { echo "refusing: pgid $pgid != pid $pid"; exit 1; }
ps -o pid,cmd --no-headers -g "$pgid"
/bin/kill -TERM -- "-$pgid"
sleep 8
/bin/kill -KILL -- "-$pgid" 2>/dev/null || true
