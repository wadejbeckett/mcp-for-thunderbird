/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { followFolder, reconcile, forgetAccount, missingExclusions, reviewed, isRealFolder, GRACE_MS, RECENT_MS } from "../src/exclusions.js";
import { isExcluded, isUnseen } from "../src/policy.js";

const f = (accountId, path, extra = {}) => ({ accountId, path, isRoot: false, ...extra });
const ex = (accountId, path) => ({ accountId, path });

test("isRealFolder leaves out roots, saved searches, tag and unified folders", () => {
  assert.equal(isRealFolder(f("a1", "/INBOX")), true);
  assert.equal(isRealFolder(f("a1", "/", { isRoot: true })), false);
  assert.equal(isRealFolder(f("a1", "/Search", { isVirtual: true })), false);
  assert.equal(isRealFolder(f("a1", "/tag", { isTag: true })), false);
  assert.equal(isRealFolder(f("a1", "/unified", { isUnified: true })), false);
  assert.equal(isRealFolder(null), false);
});

test("a renamed excluded folder stays excluded, with its subfolders and folders seen", () => {
  const s = {
    excludedFolders: [ex("a1", "/Legal"), ex("a1", "/Legal/Contracts"), ex("a1", "/Legal-old"), ex("a2", "/Legal")],
    knownFolders: { a1: { "/INBOX": 0, "/Legal": 0, "/Legal/Contracts": 5, "/Legal/Notes": 0, "/Legal-old": 0 } },
  };
  const p = followFolder(s, f("a1", "/Legal"), f("a1", "/Legal 2026"));
  assert.deepEqual(p.excludedFolders, [ex("a1", "/Legal 2026"), ex("a1", "/Legal 2026/Contracts"), ex("a1", "/Legal-old"), ex("a2", "/Legal")]);
  assert.deepEqual(p.knownFolders.a1, { "/INBOX": 0, "/Legal-old": 0, "/Legal 2026": 0, "/Legal 2026/Contracts": 5, "/Legal 2026/Notes": 0 });
  const after = { ...s, ...p };
  assert.equal(isExcluded("a1", "/Legal 2026", after), true);
  assert.equal(isExcluded("a1", "/Legal 2026/Notes", after), true, "a subfolder of an excluded folder");
  assert.equal(isExcluded("a1", "/INBOX", after), false);
});

test("an excluded folder under a renamed parent follows it", () => {
  const s = { excludedFolders: [ex("a1", "/Clients/Acme")], knownFolders: { a1: { "/Clients": 0, "/Clients/Acme": 0, "/Clients/Other": 0 } } };
  const p = followFolder(s, f("a1", "/Clients"), f("a1", "/Customers"));
  assert.deepEqual(p.excludedFolders, [ex("a1", "/Customers/Acme")]);
  const after = { ...s, ...p };
  assert.equal(isExcluded("a1", "/Customers/Acme", after), true);
  assert.equal(isExcluded("a1", "/Customers/Other", after), false, "a seen sibling stays visible");
});

test("a move to another account keeps the folder excluded there", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } };
  const target = [f("a2", "/INBOX"), f("a2", "/Old/Legal"), f("a2", "/", { isRoot: true })];
  const p = followFolder(s, f("a1", "/Legal"), f("a2", "/Old/Legal"), { targetFolders: target });
  assert.deepEqual(p.excludedFolders, [ex("a2", "/Old/Legal")]);
  assert.deepEqual(p.knownFolders.a1, { "/INBOX": 0 });
  assert.deepEqual(p.knownFolders.a2, { "/INBOX": 0, "/Old/Legal": 0 });
  assert.equal(isExcluded("a2", "/Old/Legal", { ...s, ...p }), true);
});

test("a copy of an excluded folder is excluded too, and the original stays", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/Legal": 0 } } };
  const p = followFolder(s, f("a1", "/Legal"), f("a1", "/Legal copy"), { keep: true });
  assert.deepEqual(p.excludedFolders, [ex("a1", "/Legal"), ex("a1", "/Legal copy")]);
  assert.deepEqual(p.knownFolders.a1, { "/Legal": 0, "/Legal copy": 0 });
});

test("a rename that touches no exclusion or seen folder changes nothing", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: {} };
  assert.equal(followFolder(s, f("a1", "/Other"), f("a1", "/Else")), null);
  assert.equal(followFolder(s, f("a1", "/Legal"), f("a1", "/Legal")), null);
  assert.equal(followFolder(s, f("a1", "/Legalese"), f("a1", "/X")), null, "a name that only starts the same");
  assert.equal(followFolder(s, null, f("a1", "/X")), null);
});

test("first look at an account adopts every folder there", () => {
  const seen = new Map();
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: {} };
  const r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal"), f("a1", "/S", { isVirtual: true })], 1000, seen);
  assert.deepEqual(r.patch, { knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } });
  assert.deepEqual(r.missing, []);
  assert.equal(r.due, null);
});

test("first look with an exclusion already missing adopts nothing", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: {} };
  const r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal 2026")], 1000, new Map());
  assert.deepEqual(r.missing, ["/Legal"]);
  assert.deepEqual(r.patch, { knownFolders: { a1: {} } });
  const after = { ...s, ...r.patch };
  assert.equal(isExcluded("a1", "/Legal 2026", after), true);
  assert.equal(isExcluded("a1", "/INBOX", after), true);
});

test("a new folder is hidden for the grace period, then adopted", () => {
  const seen = new Map();
  let s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } };
  const folders = [f("a1", "/INBOX"), f("a1", "/Legal"), f("a1", "/Projects")];
  let r = reconcile(s, "a1", folders, 1000, seen);
  assert.equal(r.patch, null);
  assert.equal(r.due, 1000 + GRACE_MS);
  assert.equal(isUnseen("a1", "/Projects", s), true);
  r = reconcile(s, "a1", folders, 1000 + GRACE_MS - 1, seen);
  assert.equal(r.patch, null, "not yet");
  r = reconcile(s, "a1", folders, 1000 + GRACE_MS, seen);
  assert.deepEqual(r.patch.knownFolders.a1, { "/INBOX": 0, "/Legal": 0, "/Projects": 1000 + GRACE_MS });
  s = { ...s, ...r.patch };
  assert.equal(isExcluded("a1", "/Projects", s), false);
  assert.equal(seen.size, 0);
});

test("a rename made in webmail arrives as a new folder, then the old one goes: the new one stays hidden", () => {
  const seen = new Map();
  let s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } };
  // Thunderbird's folder discovery adds the new name first...
  let r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal"), f("a1", "/Legal 2026")], 1000, seen);
  assert.equal(r.patch, null);
  assert.equal(isExcluded("a1", "/Legal 2026", s), true, "hidden while new");
  // ...then drops the old one.
  r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal 2026")], 2000, seen);
  assert.deepEqual(r.missing, ["/Legal"]);
  s = { ...s, ...(r.patch || {}) };
  // Long after the grace period it is still hidden, while /Legal is missing.
  r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal 2026")], 2000 + 10 * GRACE_MS, seen);
  assert.equal(r.due, null);
  s = { ...s, ...(r.patch || {}) };
  assert.equal(isExcluded("a1", "/Legal 2026", s), true);
  assert.equal(isExcluded("a1", "/INBOX", s), false);
});

test("when an exclusion goes missing, folders adopted lately are hidden again", () => {
  const now = 100 * RECENT_MS;
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0, "/Late": now - 1000, "/Older": now - RECENT_MS - 1 } } };
  const r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Late"), f("a1", "/Older")], now, new Map());
  assert.deepEqual(r.missing, ["/Legal"]);
  assert.deepEqual(r.patch.knownFolders.a1, { "/INBOX": 0, "/Older": now - RECENT_MS - 1 });
});

test("a folder that is gone is forgotten, so one coming back under its name is new", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0, "/Old": 0 } } };
  const r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal")], 1000, new Map());
  assert.deepEqual(r.patch.knownFolders.a1, { "/INBOX": 0, "/Legal": 0 });
  assert.equal(isUnseen("a1", "/Old", { ...s, ...r.patch }), true);
});

test("no folder list changes nothing; an account without exclusions drops its list", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/Legal": 0 }, a2: { "/INBOX": 0 } } };
  assert.deepEqual(reconcile(s, "a1", [], 1000, new Map()), { patch: null, missing: [], due: null });
  assert.deepEqual(reconcile(s, "a2", [f("a2", "/INBOX")], 1000, new Map()).patch, { knownFolders: { a1: { "/Legal": 0 } } });
  assert.equal(reconcile({ excludedFolders: [], knownFolders: {} }, "a3", [f("a3", "/INBOX")], 1000, new Map()).patch, null);
});

test("an account without a folders-seen list hides nothing extra", () => {
  assert.equal(isUnseen("a1", "/Anything", { excludedFolders: [ex("a1", "/Legal")] }), false);
  assert.equal(isUnseen("a1", "/", { knownFolders: { a1: {} } }), false, "never the root");
  assert.equal(isUnseen("a1", "/INBOX/", { knownFolders: { a1: { "/INBOX": 0 } } }), false, "trailing slash");
});

test("forgetAccount removes a deleted account's settings", () => {
  const s = { accounts: { a1: true, a2: true }, excludedFolders: [ex("a1", "/Legal"), ex("a2", "/X")], knownFolders: { a1: { "/Legal": 0 } } };
  assert.deepEqual(forgetAccount(s, "a1"), { accounts: { a2: true }, excludedFolders: [ex("a2", "/X")], knownFolders: {} });
  assert.equal(forgetAccount(s, "a9"), null);
});

test("missingExclusions and reviewed", () => {
  const s = { excludedFolders: [ex("a1", "/Legal"), ex("a1", "/INBOX"), ex("a2", "/Gone")] };
  const folders = [f("a1", "/INBOX"), f("a1", "/New"), f("a1", "/S", { isVirtual: true })];
  assert.deepEqual(missingExclusions(s, "a1", folders), ["/Legal"]);
  assert.deepEqual(missingExclusions(s, "a1", []), [], "no list, nothing flagged");
  assert.deepEqual(reviewed(folders, "a1"), { "/INBOX": 0, "/New": 0 });
});
