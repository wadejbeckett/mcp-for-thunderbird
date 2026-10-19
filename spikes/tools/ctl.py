#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""THROWAWAY spike (Task 2): send one JSON request to the echo host's control
socket and print the add-on's result frame.

usage: ctl.py <spike-dir> '<json>'
"""
import json, socket, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1] + "/ctl.sock")
s.sendall(sys.argv[2].encode() + b"\n")
buf = b""
while not buf.endswith(b"\n"):
    chunk = s.recv(1 << 20)
    if not chunk:
        break
    buf += chunk
print(json.dumps(json.loads(buf), indent=1))
