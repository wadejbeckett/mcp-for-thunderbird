#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
