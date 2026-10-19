/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
