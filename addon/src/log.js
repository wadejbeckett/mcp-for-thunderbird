/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// Activity log: the last 500 calls in storage.local under "activity".
// Entries hold only time, client (the app's self-reported name, at most 64
// characters), tool, targets (opaque ids or folder paths, at most 20 of at
// most 200 characters) and outcome; never subjects, bodies or addresses.

export const LOG_KEY = "activity";
export const LOG_SIZE = 500;
export const CLIENT_CHARS = 64;

let queue = Promise.resolve();

function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function entry({ time, client, tool, targets, outcome }) {
  return {
    time: String(time),
    client: Array.from(String(client ?? "unknown")).slice(0, CLIENT_CHARS).join(""),
    tool: String(tool ?? ""),
    targets: Array.isArray(targets)
      ? targets
          .filter((t) => typeof t === "string")
          .slice(0, 20)
          .map((t) => t.slice(0, 200))
      : [],
    outcome: String(outcome ?? ""),
  };
}

async function read() {
  const v = (await globalThis.messenger.storage.local.get(LOG_KEY))[LOG_KEY];
  return Array.isArray(v) ? v : [];
}

export function append(e) {
  return serial(async () => {
    const all = await read();
    all.push(entry(e));
    await globalThis.messenger.storage.local.set({ [LOG_KEY]: all.slice(-LOG_SIZE) });
  });
}

export function list() {
  return serial(read);
}

export function clear() {
  return serial(() => globalThis.messenger.storage.local.set({ [LOG_KEY]: [] }));
}
