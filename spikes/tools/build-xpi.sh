#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
# THROWAWAY spike (Task 2): zip the spike add-on. usage: build-xpi.sh <out.xpi>
set -eu
out=$(realpath -m "$1")
cd "$(dirname "$0")/../addon"
rm -f "$out"
zip -q -X "$out" manifest.json background.js options.html options.js
echo "$out"
