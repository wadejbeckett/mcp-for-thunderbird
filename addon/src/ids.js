/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// Opaque message ids: "m1." + base64url(JSON [accountId, folderPath,
// headerMessageId]), no padding. Thunderbird's numeric ids do not survive a
// restart, so they are only a per-session cache.
//
// endList, shared by every handler that stops reading a message list
// early, also lives here: resolveId is its first user.

import { fail } from "./errors.js";

const PREFIX = "m1.";
const B64URL = /^[A-Za-z0-9_-]+$/;
const cache = new Map();
// MAX_CACHE bounds the cache; the oldest entries go first.
const MAX_CACHE = 5000;

function remember(id, num) {
  if (!cache.has(id) && cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(id, num);
}

function toB64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeId(accountId, folderPath, headerMessageId) {
  return PREFIX + toB64url(JSON.stringify([accountId, folderPath, headerMessageId]));
}

export function decodeId(id) {
  const bad = () => fail("invalid_argument", "Not a valid message id.");
  if (typeof id !== "string" || !id.startsWith(PREFIX)) bad();
  const payload = id.slice(PREFIX.length);
  if (!B64URL.test(payload) || payload.length % 4 === 1) bad();
  let v;
  try {
    v = JSON.parse(fromB64url(payload));
  } catch {
    bad();
  }
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "string" && x !== "")) bad();
  return { accountId: v[0], folderPath: v[1], headerMessageId: v[2] };
}

// END bounds endList: each Thunderbird call waits at most waitMs, and at
// most maxPages pages are read. Exported so tests can shorten it.
export const END = { waitMs: 1000, maxPages: 1000 };
const LATE = Symbol("late");

function bounded(fn) {
  let timer;
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(LATE), END.waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// endList ends a message list the caller no longer reads. abortList stops
// the search, but Thunderbird keeps the list, with every header it has
// collected, until its last page (id null) is read; so the pages left are
// read too. They come at once, since an aborted list adds nothing more.
// Errors are ignored: the list is gone already.
export async function endList(listId) {
  const m = globalThis.messenger;
  try {
    if ((await bounded(() => m.messages.abortList(listId))) === LATE) return;
    let id = listId;
    for (let i = 0; i < END.maxPages && id; i++) {
      const page = await bounded(() => m.messages.continueList(id));
      if (page === LATE || !page || typeof page !== "object") return;
      id = typeof page.id === "string" ? page.id : null;
    }
  } catch {
    // the list is gone already
  }
}

export function clearIdCache() {
  cache.clear();
}

// primeFromEvent, a listener for messages.onMoved and messages.onCopied,
// keeps the cache abreast of Thunderbird's own word on moved and copied
// messages. The header such an event gives for a message's new place
// carries the numeric id under which Thunderbird knows the message at
// once, while a search of the folder (messages.query, which resolveId
// falls back to) can miss it until Thunderbird has synchronised the
// folder with the server, on IMAP until its next check of that folder.
// Only the first page of each list is read; a list with more pages is
// ended, as Thunderbird keeps it until its last page is read.
export function primeFromEvent(from, to) {
  for (const list of [from, to]) {
    if (list && typeof list.id === "string") endList(list.id);
  }
  const dst = to && Array.isArray(to.messages) ? to.messages : [];
  for (const h of dst) {
    if (!h || typeof h.id !== "number" || typeof h.headerMessageId !== "string" || h.headerMessageId === "") continue;
    if (!h.folder || typeof h.folder.accountId !== "string" || typeof h.folder.path !== "string") continue;
    remember(encodeId(h.folder.accountId, h.folder.path, h.headerMessageId), h.id);
  }
}

function matches(h, accountId, folderPath, headerMessageId) {
  return (
    h &&
    h.headerMessageId === headerMessageId &&
    h.folder &&
    h.folder.accountId === accountId &&
    h.folder.path === folderPath
  );
}

// resolveId returns the MessageHeader an opaque id names, or throws
// not_found. A cached numeric id is used only when the message it points at
// still has the same account, folder and Message-ID.
export async function resolveId(id) {
  const { accountId, folderPath, headerMessageId } = decodeId(id);
  const notFound = () => fail("not_found", `Message not found in ${folderPath}`);
  const m = globalThis.messenger;

  const cached = cache.get(id);
  if (cached !== undefined) {
    try {
      const h = await m.messages.get(cached);
      if (matches(h, accountId, folderPath, headerMessageId)) return h;
    } catch {
      // gone or renumbered: look it up again
    }
    cache.delete(id);
  }

  const folders = await m.folders.query({ accountId, path: folderPath });
  const folder = (folders || []).find((f) => f.accountId === accountId && f.path === folderPath);
  if (!folder) notFound();

  let page = await m.messages.query({ accountId, folderId: folder.id, headerMessageId });
  let found = null;
  for (;;) {
    found = (page.messages || []).find((h) => matches(h, accountId, folderPath, headerMessageId)) || null;
    if (found || !page.id) break;
    page = await m.messages.continueList(page.id);
  }
  if (page.id) await endList(page.id);
  if (!found) notFound();
  remember(id, found.id);
  return found;
}
