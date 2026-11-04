#!/usr/bin/env python3
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
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
