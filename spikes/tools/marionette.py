#!/usr/bin/env python3
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
"""THROWAWAY spike (Task 2): minimal Marionette client. Used only as a test
harness (store the GreenMail test password, take UI actions), never by the
add-on.

usage: marionette.py <port> <chrome-script-file-or-'-'>
"""
import json, socket, sys

def recv(s):
    n = b""
    while not n.endswith(b":"):
        n += s.recv(1)
    n = int(n[:-1])
    b = b""
    while len(b) < n:
        b += s.recv(n - len(b))
    return json.loads(b)

def call(s, mid, name, params):
    b = json.dumps([0, mid, name, params]).encode()
    s.sendall(str(len(b)).encode() + b":" + b)
    r = recv(s)
    if r[2]:
        raise SystemExit(json.dumps(r[2]))
    return r[3]

s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
recv(s)
call(s, 1, "WebDriver:NewSession", {"capabilities": {}})
call(s, 2, "Marionette:SetContext", {"value": "chrome"})
script = sys.stdin.read() if sys.argv[2] == "-" else open(sys.argv[2]).read()
r = call(s, 3, "WebDriver:ExecuteAsyncScript" if "resolve" in script else "WebDriver:ExecuteScript",
         {"script": script, "args": [], "scriptTimeout": 120000})
print(json.dumps(r, indent=1))
call(s, 4, "WebDriver:DeleteSession", {})
