#!/usr/bin/env python3
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
"""THROWAWAY spike (Task 2): write the same synthetic bulk messages as
seed.py into an mbox file (fallback when GreenMail cannot serve the folder).

usage: mkmbox.py <out-mbox> <count>
"""
import sys
from seed import bulk_msg  # same content as the IMAP seeding

out, count = sys.argv[1], int(sys.argv[2])
with open(out, "wb") as f:
    for i in range(1, count + 1):
        raw, d = bulk_msg(i, "big")
        f.write(b"From - " + d.strftime("%a %b %d %H:%M:%S %Y").encode() + b"\n")
        f.write(raw.replace(b"\r\n", b"\n").replace(b"\nFrom ", b"\n>From ") + b"\n")
print(out)
