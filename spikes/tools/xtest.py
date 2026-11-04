#!/usr/bin/env python3
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
"""THROWAWAY spike (Task 2): real X input on the spike's own Xvfb display via
the XTest extension (no xdotool on this machine). Uses $DISPLAY/$XAUTHORITY.

usage: xtest.py click X Y | xtest.py type TEXT | xtest.py key KEYSYM
"""
import ctypes, sys, time
x11 = ctypes.CDLL("libX11.so.6")
xt = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
if not d:
    raise SystemExit("cannot open display")

def key(sym):
    kc = x11.XKeysymToKeycode(d, x11.XStringToKeysym(sym.encode()))
    xt.XTestFakeKeyEvent(d, kc, 1, 0); xt.XTestFakeKeyEvent(d, kc, 0, 0); x11.XFlush(d); time.sleep(0.05)

op = sys.argv[1]
if op == "click":
    xt.XTestFakeMotionEvent(d, -1, int(sys.argv[2]), int(sys.argv[3]), 0); x11.XFlush(d); time.sleep(0.2)
    xt.XTestFakeButtonEvent(d, 1, 1, 0); x11.XFlush(d); time.sleep(0.05)
    xt.XTestFakeButtonEvent(d, 1, 0, 0); x11.XFlush(d)
elif op == "type":
    for ch in sys.argv[2]:
        key(ch)
elif op == "key":
    key(sys.argv[2])
