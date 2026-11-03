/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { followFolder, reconcile, forgetAccount, missingExclusions, reviewed, isRealFolder, mergeExclusions } from "../src/exclusions.js";
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
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: {} };
  const r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal"), f("a1", "/S", { isVirtual: true })]);
  assert.deepEqual(r.patch, { knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unseen, []);
});

test("first look with an exclusion already missing still adopts the folders there, and flags the exclusion", () => {
  // An upgrade: /Legal was deleted long ago, and the old version never
  // removed its exclusion. The folders there now were shown to AI apps
  // already; hiding them protects nothing.
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: {} };
  const r = reconcile(s, "a1", [f("a1", "/", { isRoot: true }), f("a1", "/INBOX"), f("a1", "/Legal 2026")]);
  assert.deepEqual(r.missing, ["/Legal"]);
  assert.deepEqual(r.patch, { knownFolders: { a1: { "/INBOX": 0, "/Legal 2026": 0 } } });
  const after = { ...s, ...r.patch };
  assert.equal(isExcluded("a1", "/INBOX", after), false);
  // A folder that appears later is new.
  const r2 = reconcile(after, "a1", [f("a1", "/INBOX"), f("a1", "/Legal 2026"), f("a1", "/Later")]);
  assert.deepEqual(r2.unseen, ["/Later"]);
  assert.equal(isExcluded("a1", "/Later", after), true);
});

test("an exclusion naming a saved search is not missing, and its account stays visible", () => {
  // The picker listed saved searches before; such an exclusion names a
  // folder that exists.
  const s = { excludedFolders: [ex("a1", "/Saved Search")], knownFolders: {} };
  const folders = [f("a1", "/", { isRoot: true }), f("a1", "/INBOX"), f("a1", "/Saved Search", { isVirtual: true })];
  const r = reconcile(s, "a1", folders);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.patch, { knownFolders: { a1: { "/INBOX": 0 } } });
  assert.equal(isExcluded("a1", "/INBOX", { ...s, ...r.patch }), false);
  assert.deepEqual(missingExclusions(s, "a1", folders), []);
  assert.deepEqual(missingExclusions({ excludedFolders: [ex("a1", "/Tag")] }, "a1", [f("a1", "/INBOX"), f("a1", "/Tag", { isTag: true })]), []);
  assert.deepEqual(missingExclusions({ excludedFolders: [ex("a1", "/All")] }, "a1", [f("a1", "/INBOX"), f("a1", "/All", { isUnified: true })]), []);
});

test("a new folder stays hidden until the user has seen it, however long it waits", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } };
  const folders = [f("a1", "/INBOX"), f("a1", "/Legal"), f("a1", "/Projects"), f("a1", "/Legal/Sub")];
  const r = reconcile(s, "a1", folders);
  assert.equal(r.patch, null, "nothing is adopted");
  assert.deepEqual(r.unseen, ["/Projects"], "a subfolder of an excluded folder is hidden anyway, not flagged");
  assert.equal(isUnseen("a1", "/Projects", s), true);
  assert.equal(reconcile(s, "a1", folders).patch, null, "nor on a later check");
  assert.deepEqual(reviewed(folders, "a1"), { "/INBOX": 0, "/Legal": 0, "/Projects": 0, "/Legal/Sub": 0 });
});

test("a rename made in webmail, the old folder still listed for a while, keeps the new one hidden", () => {
  let s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0 } } };
  // Thunderbird's folder discovery adds the new name; the old one stays
  // listed, so no exclusion is missing...
  let r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal"), f("a1", "/Legal 2026")]);
  assert.equal(r.patch, null);
  assert.deepEqual(r.missing, []);
  assert.equal(isExcluded("a1", "/Legal 2026", s), true, "hidden while new");
  // ...and only later drops the old one.
  r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal 2026")]);
  assert.deepEqual(r.missing, ["/Legal"]);
  s = { ...s, ...(r.patch || {}) };
  assert.equal(isExcluded("a1", "/Legal 2026", s), true);
  assert.equal(isExcluded("a1", "/INBOX", s), false);
});

test("a folder that is gone is forgotten, so one coming back under its name is new", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/INBOX": 0, "/Legal": 0, "/Old": 0 } } };
  const r = reconcile(s, "a1", [f("a1", "/INBOX"), f("a1", "/Legal")]);
  assert.deepEqual(r.patch.knownFolders.a1, { "/INBOX": 0, "/Legal": 0 });
  assert.equal(isUnseen("a1", "/Old", { ...s, ...r.patch }), true);
});

test("no folder list changes nothing; an account without exclusions drops its list", () => {
  const s = { excludedFolders: [ex("a1", "/Legal")], knownFolders: { a1: { "/Legal": 0 }, a2: { "/INBOX": 0 } } };
  assert.deepEqual(reconcile(s, "a1", []), { patch: null, missing: [], unseen: [] });
  assert.deepEqual(reconcile(s, "a2", [f("a2", "/INBOX")]).patch, { knownFolders: { a1: { "/Legal": 0 } } });
  assert.equal(reconcile({ excludedFolders: [], knownFolders: {} }, "a3", [f("a3", "/INBOX")]).patch, null);
});

test("mergeExclusions applies the page's ticks and unticks to what is stored now", () => {
  const base = [ex("a1", "/Secret"), ex("a1", "/Old")];
  // The background followed a rename the page did not see.
  const stored = [ex("a1", "/Secret2"), ex("a1", "/Old")];
  // The page unticked /Old and ticked /New.
  const page = [ex("a1", "/Secret"), ex("a1", "/New")];
  assert.deepEqual(mergeExclusions(stored, base, page), [ex("a1", "/Secret2"), ex("a1", "/New")]);
  assert.deepEqual(mergeExclusions(stored, base, base), stored, "no change on the page keeps what is stored");
  assert.deepEqual(mergeExclusions([ex("a1", "/X")], [], [ex("a1", "/X")]), [ex("a1", "/X")], "no duplicate");
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
