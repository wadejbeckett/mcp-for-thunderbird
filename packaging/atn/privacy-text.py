#!/usr/bin/env python3
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later

"""privacy-text.py [PRIVACY.md]

Prints PRIVACY.md as the plain text that addons.thunderbird.net's privacy
policy field takes: no Markdown markup. Headings become lines of their
own, bold and code marks are dropped, links keep their text with the
address in brackets (a link to a file in the repository gets the file's
address on GitHub), and the permissions table becomes a list. Run it from
the repository root before each submission and paste the output in full.
"""

import re
import sys
from pathlib import Path

REPO = "https://github.com/wadejbeckett/mcp-for-thunderbird/blob/main/"


def link(m):
    text, target = m.group(1), m.group(2)
    if not re.match(r"^[a-z]+://", target):
        target = REPO + target
    return f"{text} ({target})"


def inline(s):
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, s)
    s = s.replace("**", "").replace("`", "")
    return s


def main(path):
    out = []
    table = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(set(c) <= set("-: ") for c in cells):
                continue  # the rule under the header row
            table.append(cells)
            continue
        if table:
            header, rows = table[0], table[1:]
            for row in rows:
                out.append("- " + inline(row[0]) + ": " + inline(row[1]))
            table = []
        m = re.match(r"^(#+)\s+(.*)$", line)
        if m:
            out.append(inline(m.group(2)).upper() if len(m.group(1)) == 1 else inline(m.group(2)))
            continue
        out.append(inline(line))
    if table:
        for row in table[1:]:
            out.append("- " + inline(row[0]) + ": " + inline(row[1]))
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
    sys.stdout.write(text)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "PRIVACY.md")
