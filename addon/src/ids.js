/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Opaque message ids: "m1." + base64url(JSON [accountId, folderPath,
// headerMessageId]), no padding. Thunderbird's numeric ids do not survive a
// restart, so they are only a per-session cache.

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
  if (page.id) await m.messages.abortList(page.id);
  if (!found) notFound();
  cache.set(id, found.id);
  return found;
}
