#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# THROWAWAY spike (Task 2): zip the spike add-on. usage: build-xpi.sh <out.xpi>
set -eu
out=$(realpath -m "$1")
cd "$(dirname "$0")/../addon"
rm -f "$out"
zip -q -X "$out" manifest.json background.js options.html options.js
echo "$out"
