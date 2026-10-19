#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
