/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Excluded folders follow their folder. An exclusion is stored by path, so
// the background rewrites it when Thunderbird reports a rename, move or
// copy (followFolder). A rename made elsewhere, such as in webmail, reaches
// Thunderbird as a new folder and a deleted one, with nothing to link the
// two, so each account with exclusions also keeps the folder paths the
// add-on has seen (settings.knownFolders: path -> when it was adopted, 0
// for a folder the user saw in the options). policy.isExcluded treats a
// folder that is not in that list as excluded. reconcile adopts a new
// folder after GRACE_MS, and only while every exclusion of the account
// still names a folder that exists; while one is missing, new folders stay
// hidden until the user saves the options, and folders adopted in the last
// RECENT_MS are hidden again, in case the missing folder came back under
// one of their names before Thunderbird reported the old one gone. No
// function here removes an exclusion, except forgetAccount for an account
// that was deleted.

export const GRACE_MS = 30_000;
export const RECENT_MS = 10 * 60_000;

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

// reconcile compares an account's exclusions and folders seen with its
// real folders now (folders, from folders.query). firstSeen (a Map of
// "account\0path" -> ms) remembers when each new folder was first seen;
// it is updated in place. Returns {patch, missing, due}: the settings
// patch or null, the excluded paths that name no folder, and the time the
// next new folder may be adopted, or null.
export function reconcile(s, accountId, folders, now, firstSeen) {
  const out = { patch: null, missing: [], due: null };
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
  const paths = (folders || []).filter((f) => isRealFolder(f) && f.accountId === accountId).map((f) => trim(f.path));
  // No folders at all means the list is not there yet: change nothing.
  if (paths.length === 0) return out;
  const present = new Set(paths);
  out.missing = ex.filter((p) => p !== "" && !present.has(p));

  const before = known[accountId] && typeof known[accountId] === "object" ? known[accountId] : null;
  const next = {};
  if (!before) {
    // First look at this account: everything there now was there when the
    // exclusions were chosen, unless one is already missing. Then nothing
    // is adopted, and the user decides in the options.
    if (out.missing.length === 0) for (const p of paths) next[p] = 0;
  } else {
    // Folders no longer there are forgotten: one that comes back under the
    // same name is new again.
    for (const [p, t] of Object.entries(before)) if (present.has(p)) next[p] = t;
    if (out.missing.length > 0) {
      for (const [p, t] of Object.entries(next)) if (t > 0 && now - t < RECENT_MS) delete next[p];
    }
  }
  for (const p of paths) {
    const k = `${accountId}\u0000${p}`;
    if (Object.hasOwn(next, p)) {
      firstSeen.delete(k);
      continue;
    }
    if (!firstSeen.has(k)) firstSeen.set(k, now);
    const at = firstSeen.get(k) + GRACE_MS;
    if (out.missing.length === 0 && now >= at) {
      next[p] = now;
      firstSeen.delete(k);
    } else if (out.missing.length === 0 && (out.due === null || at < out.due)) out.due = at;
  }
  for (const k of [...firstSeen.keys()]) {
    if (k.startsWith(`${accountId}\u0000`) && !present.has(k.slice(accountId.length + 1))) firstSeen.delete(k);
  }
  if (!sameKnown(before, next)) out.patch = { knownFolders: { ...known, [accountId]: next } };
  return out;
}

function sameKnown(a, b) {
  if (!a) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
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
// its real folders; an empty folder list (not loaded) gives none.
export function missingExclusions(s, accountId, folders) {
  const paths = new Set((folders || []).filter((f) => isRealFolder(f) && f.accountId === accountId).map((f) => trim(f.path)));
  if (paths.size === 0) return [];
  return exclusionsOf(s, accountId).filter((p) => p !== "" && !paths.has(p));
}
