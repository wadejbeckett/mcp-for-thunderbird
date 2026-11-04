#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
# THROWAWAY spike (Task 2): start Thunderbird on a throwaway profile under a
# fresh Xvfb display, detached. Writes <spikedir>/xvfb-run.pid.
# usage: run-tb.sh <profile-dir> <spike-dir> <ping-seconds> [thunderbird args...]
set -eu
prof=$1; dir=$2; ping=$3; shift 3
mkdir -p "$dir"
MFT_SPIKE_DIR=$dir MFT_SPIKE_PING=$ping setsid xvfb-run -a -s "-screen 0 1600x1000x24" \
  thunderbird --profile "$prof" --no-remote "$@" >"$dir/tb.out" 2>&1 &
echo $! >"$dir/xvfb-run.pid"
echo "xvfb-run pid $(cat "$dir/xvfb-run.pid")"
