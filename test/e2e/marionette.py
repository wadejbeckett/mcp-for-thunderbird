#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Minimal Marionette client for the end-to-end harness (after the Task 2
spike tool). It runs one chrome-context script in the throwaway Thunderbird
the harness started, and prints the result as JSON. Test harness only:
it stores the GreenMail test login and reads add-on state; the add-on never
uses Marionette.

usage: marionette.py <port> <script-file | -> | marionette.py <port> --quit
A script that mentions `resolve` runs as an async script whose last
argument is the callback. --quit asks Thunderbird to quit cleanly, so it
writes its stores (logins, extension storage) before exiting.
"""
import json, socket, sys


def recv(s):
    n = b""
    while not n.endswith(b":"):
        c = s.recv(1)
        if not c:
            raise ConnectionError("marionette closed the connection")
        n += c
    n = int(n[:-1])
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise ConnectionError("marionette closed the connection")
        b += c
    return json.loads(b)


def call(s, mid, name, params):
    b = json.dumps([0, mid, name, params]).encode()
    s.sendall(str(len(b)).encode() + b":" + b)
    r = recv(s)
    if r[2]:
        raise SystemExit(json.dumps(r[2]))
    return r[3]


s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=150)
recv(s)
call(s, 1, "WebDriver:NewSession", {"capabilities": {}})
if sys.argv[2] == "--quit":
    try:
        call(s, 2, "Marionette:Quit", {"flags": ["eForceQuit"]})
    except (ConnectionError, OSError):
        pass
    sys.exit(0)
call(s, 2, "Marionette:SetContext", {"value": "chrome"})
script = sys.stdin.read() if sys.argv[2] == "-" else open(sys.argv[2]).read()
r = call(s, 3, "WebDriver:ExecuteAsyncScript" if "resolve" in script else "WebDriver:ExecuteScript",
         {"script": script, "args": [], "scriptTimeout": 120000})
print(json.dumps(r.get("value") if isinstance(r, dict) else r))
try:
    call(s, 4, "WebDriver:DeleteSession", {})
except (ConnectionError, OSError):
    pass
