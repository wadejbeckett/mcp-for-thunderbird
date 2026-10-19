/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings live in storage.local under "settings". They are changed only
// from the add-on's own pages, never over MCP.

import { fail } from "./errors.js";

export const STORAGE_KEY = "settings";

// Tool groups, in catalogue order (Shared contracts).
export const GROUPS = Object.freeze({
  read: Object.freeze(["mail_accounts", "mail_folders", "mail_search", "mail_read", "mail_thread", "mail_attachment", "mail_filter_suggest"]),
  contacts: Object.freeze(["mail_contacts"]),
  organise: Object.freeze(["mail_mark", "mail_tag", "mail_move", "mail_archive", "mail_trash"]),
  compose: Object.freeze(["mail_draft", "mail_compose"]),
  send: Object.freeze(["mail_send"]),
});

// Catalogue order of the groups, as the host lists the tools.
const ORDER = ["read", "contacts", "organise", "compose", "send"];

export function groupOf(tool) {
  return ORDER.find((g) => GROUPS[g].includes(tool)) || null;
}

export const DEFAULTS = Object.freeze({
  accounts: Object.freeze({}),
  groups: Object.freeze({ read: true, organise: true, compose: false, contacts: false }),
  send: Object.freeze({ enabled: false, allow: Object.freeze([]) }),
  attachmentDir: "",
  excludedFolders: Object.freeze([]),
  paused: false,
  setupDone: false,
  instance: "",
});

// Setup levels (spec §6).
export const LEVELS = Object.freeze({
  read_only: Object.freeze({ read: true, organise: false, compose: false, contacts: false }),
  read_organise: Object.freeze({ read: true, organise: true, compose: false, contacts: false }),
  read_organise_draft: Object.freeze({ read: true, organise: true, compose: true, contacts: false }),
});

export function sendEnabled(s) {
  return Boolean(s.send && s.send.enabled && Array.isArray(s.send.allow) && s.send.allow.length > 0);
}

// enabledTools lists the tools the settings allow, in catalogue order.
// mail_send needs direct send on and a non-empty allowlist; the background
// also drops it while the messages.send permission is not granted.
export function enabledTools(s) {
  const out = [];
  for (const g of ORDER) {
    const on = g === "send" ? sendEnabled(s) : Boolean(s.groups && s.groups[g]);
    if (on) out.push(...GROUPS[g]);
  }
  return out;
}

function newInstance() {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

// merge applies a patch: top-level fields replace, groups and send merge.
function merge(base, patch = {}) {
  const out = { ...plain(base), ...plain(patch) };
  out.groups = { ...base.groups, ...(patch.groups || {}) };
  out.send = { ...base.send, ...(patch.send || {}) };
  return out;
}

// e2eSettings reads e2e-settings.json from the add-on package. Release
// builds never contain it (ruling R2), so this returns null there.
async function e2eSettings() {
  try {
    const res = await globalThis.fetch(globalThis.messenger.runtime.getURL("e2e-settings.json"));
    if (!res || !res.ok) return null;
    const v = await res.json();
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// load and save run one at a time, so concurrent first loads agree on
// one instance id and concurrent saves do not lose each other's changes.
let queue = Promise.resolve();

function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// normaliseExcluded strips trailing slashes and refuses entries that name
// no folder (an empty or root path) or no account.
export function normaliseExcluded(list) {
  if (!Array.isArray(list)) fail("invalid_argument", "Excluded folders must be a list.");
  return list.map((ex) => {
    const accountId = ex && ex.accountId;
    const path = ex && typeof ex.path === "string" ? ex.path.replace(/\/+$/, "") : "";
    if (typeof accountId !== "string" || accountId === "" || path === "") {
      fail("invalid_argument", "An excluded folder needs an account and a folder path.");
    }
    return { accountId, path };
  });
}

async function loadNow() {
  const local = globalThis.messenger.storage.local;
  const stored = (await local.get(STORAGE_KEY))[STORAGE_KEY];
  let s;
  let dirty = false;
  if (stored && typeof stored === "object") {
    s = merge(DEFAULTS, stored);
  } else {
    s = merge(DEFAULTS, (await e2eSettings()) || {});
    dirty = true;
  }
  if (typeof s.instance !== "string" || !/^[0-9a-f]{32}$/.test(s.instance)) {
    s.instance = newInstance();
    dirty = true;
  }
  if (dirty) await local.set({ [STORAGE_KEY]: s });
  return s;
}

export function load() {
  return serial(loadNow);
}

export function save(patch) {
  return serial(async () => {
    const current = await loadNow();
    const s = merge(current, patch);
    if (patch && "excludedFolders" in patch) s.excludedFolders = normaliseExcluded(patch.excludedFolders);
    s.instance = current.instance;
    await globalThis.messenger.storage.local.set({ [STORAGE_KEY]: s });
    return s;
  });
}
