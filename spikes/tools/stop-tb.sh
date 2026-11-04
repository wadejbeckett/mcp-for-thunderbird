#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
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
