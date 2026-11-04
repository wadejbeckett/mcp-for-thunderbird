/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// Test helpers: read a fixture, and split a small single-part .eml into
// Thunderbird-style headers ({lower-case name: [values]}) and its body.

import { readFileSync } from "node:fs";

export function fixture(name) {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

export function loadEml(name) {
  const raw = fixture(name);
  const cut = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, cut).replace(/\r\n[ \t]/g, " ");
  const headers = {};
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    const k = line.slice(0, i).trim().toLowerCase();
    (headers[k] ||= []).push(line.slice(i + 1).trim());
  }
  return { headers, body: raw.slice(cut + 4) };
}
