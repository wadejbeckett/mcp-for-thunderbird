/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { install, fetchFrom } from "./mocks/messenger.js";
import { dispatch } from "../src/rpc.js";
import { save } from "../src/settings.js";
import { encodeId, clearIdCache } from "../src/ids.js";
import { SEARCH } from "../src/handlers/read.js";
import "../src/handlers/organise.js";

const ACCOUNTS = [
  {
    id: "a1",
    name: "Work",
    type: "imap",
    folders: ["INBOX", "Archives", "Trash", "Junk", "Trash/Old", "Work", "Private", "OnlyA1"],
    specialUse: { INBOX: ["inbox"], Archives: ["archive"], Trash: ["trash"], Junk: ["junk"] },
  },
  { id: "a2", name: "Home", type: "imap", folders: ["INBOX", "Trash", "OnlyA2"], specialUse: { INBOX: ["inbox"], Trash: ["trash"] } },
  { id: "a3", name: "Bare", type: "imap", folders: ["INBOX"], specialUse: { INBOX: ["inbox"] } },
];

let mock;
let budget;
beforeEach(async () => {
  clearIdCache();
  budget = SEARCH.budgetMs;
  mock = install({ accounts: ACCOUNTS });
  globalThis.fetch = fetchFrom({});
  await save({ accounts: { a1: true, a2: true, a3: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
});
afterEach(() => {
  SEARCH.budgetMs = budget;
});

const call = (tool, args) => dispatch({ type: "call", id: "c1", tool, args, client: "test" });

// add puts a message in a folder and returns its opaque id.
function add(account, path, n, extra = {}) {
  const h = mock.addMessage(account, path, { headerMessageId: `msg${n}@example.org`, ...extra });
  return { num: h.id, id: encodeId(account, path, h.headerMessageId) };
}
const folderOf = (num) => mock.store.get(num).folder;
const noOrganiseCalls = () =>
  assert.deepEqual([mock.calls.update, mock.calls.move, mock.calls.copy, mock.calls.archive, mock.calls.delete].map((c) => c.length), [0, 0, 0, 0, 0]);

test("mail_mark sets read and flagged", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_mark", { ids: [m.id], read: true, flagged: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.content, { done: [m.id], failed: [] });
  assert.equal(mock.store.get(m.num).read, true);
  assert.equal(mock.store.get(m.num).flagged, true);
  const r2 = await call("mail_mark", { ids: [m.id], read: false });
  assert.deepEqual(r2.content.done, [m.id]);
  assert.equal(mock.store.get(m.num).read, false);
  assert.equal(mock.store.get(m.num).flagged, true);
});

test("mail_mark without read or flagged is invalid_argument", async () => {
  const m = add("a1", "INBOX", 1);
  for (const args of [{ ids: [m.id] }, { ids: [m.id], read: "yes" }, { ids: [] }, {}]) {
    const r = await call("mail_mark", args);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_argument");
  }
  noOrganiseCalls();
});

test("TestMoveCrossAccountRefused", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_move", { account: "a2", ids: [m.id], folder: "INBOX" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "refused");
  assert.equal(r.error.message, "Moving mail between accounts is not allowed.");
  noOrganiseCalls();
  assert.equal(folderOf(m.num).accountId, "a1");
});

test("TestMoveMixedAccountsRefused", async () => {
  const m1 = add("a1", "INBOX", 1);
  const m2 = add("a2", "INBOX", 2);
  const r = await call("mail_move", { ids: [m1.id, m2.id], folder: "INBOX" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "refused");
  assert.equal(r.error.message, "Moving mail between accounts is not allowed.");
  noOrganiseCalls();
});

test("mail_move to a folder that exists only in another account is not_found", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_move", { ids: [m.id], folder: "OnlyA2" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not_found");
  noOrganiseCalls();
  assert.equal(folderOf(m.num).accountId, "a1");
});

test("TestMoveIntoExcludedRefused", async () => {
  const m = add("a1", "INBOX", 1);
  for (const folder of ["Private", "Private/Sub"]) {
    const r = await call("mail_move", { ids: [m.id], folder });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "excluded");
  }
  // copy is no way round it
  const c = await call("mail_move", { ids: [m.id], folder: "Private", copy: true });
  assert.equal(c.error.code, "excluded");
  noOrganiseCalls();
});

test("moving mail out of an excluded folder is refused", async () => {
  const m = add("a1", "Private", 1);
  const r = await call("mail_move", { ids: [m.id], folder: "INBOX" });
  assert.equal(r.error.code, "excluded");
  const t = await call("mail_trash", { ids: [m.id] });
  assert.equal(t.error.code, "excluded");
  noOrganiseCalls();
});

test("TestMoveToTrashRefused", async () => {
  const m = add("a1", "INBOX", 1);
  for (const folder of ["Trash", "Junk", "Trash/Old"]) {
    for (const copy of [false, true]) {
      const r = await call("mail_move", { ids: [m.id], folder, copy });
      assert.equal(r.ok, false, folder);
      assert.equal(r.error.code, "refused", folder);
      assert.match(r.error.message, /mail_trash/);
    }
  }
  noOrganiseCalls();
});

test("mail_move moves within the account and mail_move copy copies", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_move", { ids: [m.id], folder: "Work" });
  assert.deepEqual(r.content, { done: [m.id], failed: [] });
  assert.equal(folderOf(m.num).path, "Work");
  assert.equal(mock.calls.move.length, 1);

  const m2 = add("a1", "INBOX", 2);
  const c = await call("mail_move", { ids: [m2.id], folder: "Work", copy: true });
  assert.deepEqual(c.content, { done: [m2.id], failed: [] });
  assert.equal(folderOf(m2.num).path, "INBOX");
  assert.equal(mock.calls.copy.length, 1);
  assert.equal([...mock.store.values()].filter((h) => h.headerMessageId === "msg2@example.org").length, 2);
  assert.equal(mock.calls.delete.length, 0);
});

test("mail_move needs a folder and a boolean copy", async () => {
  const m = add("a1", "INBOX", 1);
  for (const args of [{ ids: [m.id] }, { ids: [m.id], folder: "" }, { ids: [m.id], folder: "Work", copy: "yes" }]) {
    const r = await call("mail_move", args);
    assert.equal(r.error.code, "invalid_argument");
  }
  noOrganiseCalls();
});

test("TestTrashUsesMoveNotDelete", async () => {
  const m1 = add("a1", "INBOX", 1);
  const m2 = add("a2", "INBOX", 2);
  const r = await call("mail_trash", { ids: [m1.id, m2.id] });
  assert.deepEqual(r.content, { done: [m1.id, m2.id], failed: [] });
  assert.equal(folderOf(m1.num).path, "Trash");
  assert.equal(folderOf(m1.num).accountId, "a1");
  assert.equal(folderOf(m2.num).path, "Trash");
  assert.equal(folderOf(m2.num).accountId, "a2");
  assert.equal(mock.calls.delete.length, 0);
  assert.equal(mock.calls.move.length, 2);
  assert.ok(mock.store.has(m1.num) && mock.store.has(m2.num));
});

test("mail_trash with no Trash folder is refused", async () => {
  const m = add("a3", "INBOX", 1);
  const r = await call("mail_trash", { ids: [m.id] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "refused");
  assert.equal(r.error.message, "This account has no Trash folder.");
  noOrganiseCalls();
});

test("mail_trash leaves a message already in Trash where it is", async () => {
  const m = add("a1", "Trash", 1);
  const r = await call("mail_trash", { ids: [m.id] });
  assert.deepEqual(r.content, { done: [m.id], failed: [] });
  assert.equal(mock.calls.move.length, 0);
  assert.equal(mock.calls.delete.length, 0);
});

test("mail_archive uses messages.archive", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_archive", { ids: [m.id] });
  assert.deepEqual(r.content, { done: [m.id], failed: [] });
  assert.equal(folderOf(m.num).path, "Archives");
  assert.equal(mock.calls.archive.length, 1);
  assert.equal(mock.calls.delete.length, 0);
});

test("mail_archive is refused when the account's archive folder is excluded", async () => {
  await save({ excludedFolders: [{ accountId: "a1", path: "Archives" }] });
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_archive", { ids: [m.id] });
  assert.equal(r.error.code, "excluded");
  noOrganiseCalls();
});

test("mail_trash is refused when the account's Trash is excluded", async () => {
  await save({ excludedFolders: [{ accountId: "a1", path: "Trash" }] });
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_trash", { ids: [m.id] });
  assert.equal(r.error.code, "excluded");
  noOrganiseCalls();
});

test("mail_tag adds and removes by key or by label", async () => {
  const m = add("a1", "INBOX", 1, { tags: ["$label4"] });
  const r = await call("mail_tag", { ids: [m.id], add: ["important"], remove: ["To Do"] });
  assert.deepEqual(r.content, { done: [m.id], failed: [] });
  assert.deepEqual(mock.store.get(m.num).tags, ["$label1"]);
  const r2 = await call("mail_tag", { ids: [m.id], add: ["$label4", "Important"] });
  assert.deepEqual(r2.content.done, [m.id]);
  assert.deepEqual([...mock.store.get(m.num).tags].sort(), ["$label1", "$label4"]);
});

test("TestTagUnknownRefused", async () => {
  const m = add("a1", "INBOX", 1);
  for (const args of [{ ids: [m.id], add: ["Nonexistent"] }, { ids: [m.id], remove: ["Nonexistent"] }, { ids: [m.id] }, { ids: [m.id], add: [5] }]) {
    const r = await call("mail_tag", args);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_argument");
  }
  noOrganiseCalls();
});

test("TestPartialFailureReported", async () => {
  const good = add("a1", "INBOX", 1);
  const gone = add("a1", "INBOX", 2);
  const broken = add("a1", "INBOX", 3);
  const good2 = add("a1", "INBOX", 4);
  mock.removeMessage(gone.num);
  mock.behaviour.fail = (op, id) => id === broken.num;
  const r = await call("mail_mark", { ids: [good.id, gone.id, broken.id, good2.id], read: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.content.done, [good.id, good2.id]);
  assert.deepEqual(r.content.failed, [
    { id: gone.id, code: "not_found" },
    { id: broken.id, code: "thunderbird_error" },
  ]);
  assert.equal(mock.store.get(good2.num).read, true);
});

test("a Thunderbird call that never answers fails that id with thunderbird_error", async () => {
  SEARCH.budgetMs = 60;
  const a = add("a1", "INBOX", 1);
  const b = add("a1", "INBOX", 2);
  mock.behaviour.stall = (op, id) => id === a.num;
  const r = await call("mail_mark", { ids: [a.id, b.id], read: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.content.failed.map((f) => f.code), ["thunderbird_error", "thunderbird_error"]);
  assert.deepEqual(r.content.done, []);
});

test("too many ids and duplicate ids", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_mark", { ids: [m.id, m.id], read: true });
  assert.deepEqual(r.content.done, [m.id]);
  assert.equal(mock.calls.update.length, 1);
  const many = Array.from({ length: 101 }, (_, i) => encodeId("a1", "INBOX", `x${i}@example.org`));
  const big = await call("mail_mark", { ids: many, read: true });
  assert.equal(big.error.code, "invalid_argument");
});

test("organise tools are off when the group is off", async () => {
  await save({ groups: { read: true, organise: false, compose: false, contacts: false } });
  const m = add("a1", "INBOX", 1);
  for (const tool of ["mail_mark", "mail_tag", "mail_move", "mail_archive", "mail_trash"]) {
    const r = await call(tool, { ids: [m.id], read: true, add: ["Important"], folder: "Work" });
    assert.equal(r.error.code, "not_enabled", tool);
  }
  noOrganiseCalls();
});
