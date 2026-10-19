/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/settings.js";
import { check, assertFolderAllowed, isExcluded } from "../src/policy.js";
import { encodeId } from "../src/ids.js";

const base = {
  ...DEFAULTS,
  accounts: { a1: true, a2: true, off: false },
  excludedFolders: [{ accountId: "a1", path: "Private" }],
  instance: "0".repeat(32),
};
const s = (patch = {}) => ({ ...base, ...patch });

test("paused beats everything", () => {
  const paused = s({ paused: true, groups: { read: false, organise: false, compose: false, contacts: false } });
  for (const [tool, args] of [
    ["mail_search", { account: "off", folder: "Private" }],
    ["mail_read", { id: encodeId("a1", "Private", "x@y") }],
    ["mail_send", {}],
    ["mail_bogus", {}],
  ]) {
    assert.throws(() => check(tool, args, paused), { code: "paused", message: "Paused by the user in Thunderbird" });
  }
});

test("a disabled account gives not_enabled", () => {
  assert.throws(() => check("mail_folders", { account: "off" }, s()), { code: "not_enabled" });
  assert.throws(() => check("mail_folders", { account: "unknown" }, s()), { code: "not_enabled" });
  assert.throws(() => check("mail_read", { id: encodeId("off", "INBOX", "x@y") }, s()), { code: "not_enabled" });
  assert.throws(() => check("mail_mark", { ids: [encodeId("a1", "INBOX", "x@y"), encodeId("off", "INBOX", "z@y")] }, s()), {
    code: "not_enabled",
  });
  check("mail_folders", { account: "a1" }, s());
  check("mail_read", { id: encodeId("a2", "INBOX", "x@y") }, s());
});

test("a folder excluded by exact path and by subfolder gives excluded", () => {
  assert.equal(isExcluded("a1", "Private", s()), true);
  assert.equal(isExcluded("a1", "Private/Sub/Deeper", s()), true);
  assert.equal(isExcluded("a1", "PrivateNot", s()), false);
  assert.equal(isExcluded("a2", "Private", s()), false);
  assert.throws(() => assertFolderAllowed("a1", "Private", s()), { code: "excluded" });
  assert.throws(() => assertFolderAllowed("a1", "Private/Sub", s()), { code: "excluded" });
  assertFolderAllowed("a1", "INBOX", s());

  assert.throws(() => check("mail_read", { id: encodeId("a1", "Private/Sub", "x@y") }, s()), { code: "excluded" });
  assert.throws(() => check("mail_search", { account: "a1", folder: "Private" }, s()), { code: "excluded" });
  assert.throws(() => check("mail_move", { account: "a1", ids: [encodeId("a1", "INBOX", "x@y")], folder: "Private/Sub" }, s()), {
    code: "excluded",
  });
  check("mail_search", { account: "a2", folder: "Private" }, s());
});

test("with one enabled account a bare folder is checked against it", () => {
  const one = s({ accounts: { a1: true } });
  assert.throws(() => check("mail_search", { folder: "Private" }, one), { code: "excluded" });
});

test("a bare folder with two or more enabled accounts is invalid_argument", () => {
  assert.throws(() => check("mail_search", { folder: "INBOX" }, s()), {
    code: "invalid_argument",
    message: "Name the account for this folder.",
  });
});

test("an account that differs from an id's account is refused", () => {
  const msg = "Moving mail between accounts is not allowed.";
  assert.throws(() => check("mail_move", { account: "a2", ids: [encodeId("a1", "INBOX", "x@y")], folder: "INBOX" }, s()), {
    code: "refused",
    message: msg,
  });
  assert.throws(() => check("mail_read", { account: "a2", id: encodeId("a1", "INBOX", "x@y") }, s()), { code: "refused", message: msg });
  assert.throws(
    () => check("mail_move", { ids: [encodeId("a1", "INBOX", "x@y"), encodeId("a2", "INBOX", "z@y")], folder: "INBOX" }, s()),
    { code: "refused", message: msg },
  );
  check("mail_move", { account: "a1", ids: [encodeId("a1", "INBOX", "x@y")], folder: "Archive" }, s());
});

test("a target folder is checked against the ids' account even with no account given", () => {
  assert.throws(() => check("mail_move", { ids: [encodeId("a1", "INBOX", "x@y")], folder: "Private/Sub" }, s()), { code: "excluded" });
  check("mail_move", { ids: [encodeId("a2", "INBOX", "x@y")], folder: "Private" }, s());
});

test("wrong-typed id, ids, folder or account fail closed", () => {
  for (const args of [
    { id: 5 },
    { id: null },
    { ids: "m1.abc" },
    { ids: [5] },
    { ids: {} },
    { folder: 3, account: "a1" },
    { folder: ["Private"], account: "a1" },
    { account: 1 },
  ]) {
    assert.throws(() => check("mail_read", args, s()), { code: "invalid_argument" }, JSON.stringify(args));
  }
});

test("exclusion paths are compared without trailing slashes; a root exclusion excludes the account", () => {
  const t = s({ excludedFolders: [{ accountId: "a1", path: "Private/" }, { accountId: "a2", path: "/" }] });
  assert.equal(isExcluded("a1", "Private", t), true);
  assert.equal(isExcluded("a1", "Private/", t), true);
  assert.equal(isExcluded("a1", "Private/x", t), true);
  assert.equal(isExcluded("a2", "INBOX", t), true);
});

test("a disabled group gives not_enabled", () => {
  assert.throws(() => check("mail_draft", {}, s()), { code: "not_enabled" });
  assert.throws(() => check("mail_contacts", { query: "x" }, s()), { code: "not_enabled" });
  assert.throws(() => check("mail_mark", { ids: [] }, s({ groups: { ...DEFAULTS.groups, organise: false } })), { code: "not_enabled" });
  assert.throws(() => check("mail_search", {}, s({ groups: { ...DEFAULTS.groups, read: false } })), { code: "not_enabled" });
  check("mail_draft", {}, s({ groups: { ...DEFAULTS.groups, compose: true } }));
});

test("mail_send needs direct send on and a non-empty allowlist", () => {
  assert.throws(() => check("mail_send", {}, s()), { code: "not_enabled" });
  assert.throws(() => check("mail_send", {}, s({ send: { enabled: true, allow: [] } })), { code: "not_enabled" });
  check("mail_send", {}, s({ send: { enabled: true, allow: ["x@y.test"] } }));
});

test("a forged id is invalid_argument", () => {
  assert.throws(() => check("mail_read", { id: "m2.abc" }, s()), { code: "invalid_argument" });
  assert.throws(() => check("mail_mark", { ids: ["m1.!!"] }, s()), { code: "invalid_argument" });
});
