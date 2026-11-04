/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// Excluded folders follow their folder. An exclusion is stored by path, so
// the background rewrites it when Thunderbird reports a rename, move or
// copy (followFolder). A rename made elsewhere, such as in webmail, reaches
// Thunderbird as a new folder and a deleted one, with nothing to link the
// two and in no fixed order: the old folder can stay listed for minutes
// after the new one appears. So each account with exclusions also keeps
// the folder paths the user has seen (settings.knownFolders: path -> 0),
// and policy.isExcluded treats a folder that is not in that list as
// excluded. The list starts with the folders there at the first look, and
// a new folder joins it only when the user saves the options with it
// listed; nothing is adopted on a timer. No function here removes an
// exclusion, except forgetAccount for an account that was deleted.

const trim = (p) => String(p ?? "").replace(/\/+$/, "");
const under = (path, base) => path === base || path.startsWith(base + "/");
const rebase = (path, from, to) => to + path.slice(from.length);

// isRealFolder says whether a folder holds mail of its own: not an
// account's root, and not a saved search, tag or unified folder, whose
// messages live in real folders (and are excluded or not there).
export function isRealFolder(f) {
  return Boolean(f) && typeof f.path === "string" && !f.isRoot && !f.isVirtual && !f.isTag && !f.isUnified;
}

const exclusionsOf = (s, accountId) => (s.excludedFolders || []).filter((ex) => ex && ex.accountId === accountId).map((ex) => trim(ex.path));

// tracked says whether the account has exclusions, and so a list of the
// folders seen.
export const tracked = (s, accountId) => exclusionsOf(s, accountId).length > 0;

// followFolder returns the settings patch for a folder that Thunderbird
// renamed, moved or (keep true) copied from one {accountId, path} to
// another: exclusions of the folder and of its subfolders, and the folders
// seen there, move with it. A copy keeps the originals and is excluded
// too. targetFolders, the real folders of the target account, starts its
// list of folders seen when the target had none. Returns null when
// nothing changes.
export function followFolder(s, from, to, { keep = false, targetFolders = null } = {}) {
  if (!from || !to || typeof from.path !== "string" || typeof to.path !== "string") return null;
  const fa = from.accountId;
  const ta = to.accountId;
  const fp = trim(from.path);
  const tp = trim(to.path);
  if (fp === "" || (fa === ta && fp === tp)) return null;

  let changed = false;
  const seen = new Set();
  const excludedFolders = [];
  const push = (ex) => {
    const k = `${ex.accountId}\u0000${ex.path}`;
    if (seen.has(k)) return;
    seen.add(k);
    excludedFolders.push(ex);
  };
  for (const ex of s.excludedFolders || []) {
    const p = trim(ex && ex.path);
    if (ex && ex.accountId === fa && p !== "" && under(p, fp)) {
      changed = true;
      if (keep) push({ accountId: ex.accountId, path: p });
      push({ accountId: ta, path: rebase(p, fp, tp) });
    } else push(ex);
  }

  const known = { ...(s.knownFolders || {}) };
  const src = known[fa] && typeof known[fa] === "object" ? { ...known[fa] } : null;
  let dst = fa === ta ? src : known[ta] && typeof known[ta] === "object" ? { ...known[ta] } : null;
  if (!dst && fa !== ta && changed && Array.isArray(targetFolders)) {
    dst = {};
    for (const f of targetFolders) if (isRealFolder(f) && f.accountId === ta) dst[trim(f.path)] = 0;
  }
  if (src) {
    for (const [p, t] of Object.entries(src)) {
      if (!under(p, fp)) continue;
      if (!keep) delete src[p];
      if (dst) dst[rebase(p, fp, tp)] = t;
      changed = true;
    }
    known[fa] = src;
  }
  if (dst) known[ta] = dst;
  if (!changed) return null;
  return { excludedFolders, knownFolders: known };
}

// presentPaths lists every folder of the account except its root, saved
// searches, tag and unified folders included: an exclusion naming one of
// them (the picker listed saved searches before) still names a folder.
const presentPaths = (folders, accountId) => (folders || []).filter((f) => f && typeof f.path === "string" && !f.isRoot && f.accountId === accountId).map((f) => trim(f.path));
const realPaths = (folders, accountId) => (folders || []).filter((f) => isRealFolder(f) && f.accountId === accountId).map((f) => trim(f.path));

// reconcile compares an account's exclusions and folders seen with its
// folders now (folders, from folders.query). Returns {patch, missing,
// unseen}: the settings patch or null, the excluded paths that name no
// folder, and the new real folders that stay hidden until the user has
// seen them in the options (none under an excluded folder, which is
// hidden anyway).
export function reconcile(s, accountId, folders) {
  const out = { patch: null, missing: [], unseen: [] };
  const known = s.knownFolders || {};
  const ex = exclusionsOf(s, accountId);
  if (ex.length === 0) {
    if (Object.hasOwn(known, accountId)) {
      const next = { ...known };
      delete next[accountId];
      out.patch = { knownFolders: next };
    }
    return out;
  }
  const paths = realPaths(folders, accountId);
  // No folders at all means the list is not there yet: change nothing.
  if (paths.length === 0) return out;
  const present = new Set(presentPaths(folders, accountId));
  out.missing = ex.filter((p) => p !== "" && !present.has(p));

  const before = known[accountId] && typeof known[accountId] === "object" ? known[accountId] : null;
  const next = {};
  if (!before) {
    // First look at this account: every folder there now was already
    // shown to AI apps before the list existed, so hiding it protects
    // nothing, also when an exclusion is already missing.
    for (const p of paths) next[p] = 0;
  } else {
    // Folders no longer there are forgotten: one that comes back under the
    // same name is new again.
    const real = new Set(paths);
    for (const [p, t] of Object.entries(before)) if (real.has(p)) next[p] = t;
  }
  out.unseen = paths.filter((p) => !Object.hasOwn(next, p) && !ex.some((e) => e !== "" && under(p, e)));
  if (!sameKnown(before, next)) out.patch = { knownFolders: { ...known, [accountId]: next } };
  return out;
}

function sameKnown(a, b) {
  if (!a) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

// mergeExclusions applies the ticks and unticks made in the options (page,
// against base, the exclusions the page started from) to the exclusions
// stored now, so a change the background made meanwhile, such as
// following a rename, is kept.
export function mergeExclusions(stored, base, page) {
  const key = (e) => `${e.accountId}\u0000${trim(e.path)}`;
  const baseKeys = new Set((base || []).filter(Boolean).map(key));
  const pageKeys = new Set((page || []).filter(Boolean).map(key));
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const k = key(e);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const e of stored || []) if (e && !(baseKeys.has(key(e)) && !pageKeys.has(key(e)))) push(e);
  for (const e of page || []) if (e && !baseKeys.has(key(e))) push(e);
  return out;
}

// reviewed returns the folders-seen list for an account whose folders the
// user has just seen in the options and saved: every one of them, as seen
// by the user.
export function reviewed(folders, accountId) {
  const out = {};
  for (const f of folders || []) if (isRealFolder(f) && f.accountId === accountId) out[trim(f.path)] = 0;
  return out;
}

// forgetAccount returns the settings patch that removes a deleted
// account: whether it was enabled, its exclusions and its folders seen.
// Thunderbird does not normally reuse an account id, but a reused one
// starts as a new account, not enabled.
export function forgetAccount(s, accountId) {
  const accounts = { ...(s.accounts || {}) };
  const knownFolders = { ...(s.knownFolders || {}) };
  const had = Object.hasOwn(accounts, accountId) || Object.hasOwn(knownFolders, accountId) || tracked(s, accountId);
  if (!had) return null;
  delete accounts[accountId];
  delete knownFolders[accountId];
  return { accounts, knownFolders, excludedFolders: (s.excludedFolders || []).filter((ex) => ex && ex.accountId !== accountId) };
}

// missingExclusions lists an account's excluded paths that name none of
// its folders; an empty folder list (not loaded) gives none.
export function missingExclusions(s, accountId, folders) {
  if (realPaths(folders, accountId).length === 0) return [];
  const paths = new Set(presentPaths(folders, accountId));
  return exclusionsOf(s, accountId).filter((p) => p !== "" && !paths.has(p));
}
