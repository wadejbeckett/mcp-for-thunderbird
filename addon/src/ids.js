/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
  cache.set(id, found.id);
  return found;
}
