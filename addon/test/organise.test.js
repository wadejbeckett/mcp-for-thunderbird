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
    specialUse: { INBOX: ["inbox"], Archives: ["archives"], Trash: ["trash"], Junk: ["junk"] },
    identities: [{ id: "id1", accountId: "a1", email: "work@example.org" }],
  },
  {
    id: "a2",
    name: "Home",
    type: "imap",
    folders: ["INBOX", "Trash", "OnlyA2"],
    specialUse: { INBOX: ["inbox"], Trash: ["trash"] },
    identities: [{ id: "id2", accountId: "a2", email: "home@example.org" }],
  },
  { id: "a3", name: "Bare", type: "imap", folders: ["INBOX"], specialUse: { INBOX: ["inbox"] }, identities: [{ id: "id3", accountId: "a3", email: "bare@example.org" }] },
  {
    id: "a4",
    name: "Local Folders",
    type: "none",
    folders: ["Inbox", "Unsent Messages", "Unsent Messages/Later", "Kept"],
    specialUse: { Inbox: ["inbox"], "Unsent Messages": ["outbox"] },
  },
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
  assert.deepEqual(r.content, { done: [m.id], failed: [], moved: [{ from: m.id, to: encodeId("a1", "Work", "msg1@example.org") }] });
  assert.equal(folderOf(m.num).path, "Work");
  assert.equal(mock.calls.move.length, 1);

  const m2 = add("a1", "INBOX", 2);
  const c = await call("mail_move", { ids: [m2.id], folder: "Work", copy: true });
  assert.deepEqual(c.content, { done: [m2.id], failed: [], copied: [{ from: m2.id, to: encodeId("a1", "Work", "msg2@example.org") }] });
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
  assert.deepEqual(r.content, {
    done: [m1.id, m2.id],
    failed: [],
    moved: [
      { from: m1.id, to: encodeId("a1", "Trash", "msg1@example.org") },
      { from: m2.id, to: encodeId("a2", "Trash", "msg2@example.org") },
    ],
  });
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
  assert.deepEqual(r.content, { done: [m.id], failed: [], moved: [{ from: m.id, to: m.id }] });
  assert.equal(mock.calls.move.length, 0);
  assert.equal(mock.calls.delete.length, 0);
});

test("mail_archive uses messages.archive", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_archive", { ids: [m.id] });
  assert.deepEqual(r.content, { done: [m.id], failed: [], moved: [{ from: m.id, to: encodeId("a1", "Archives", "msg1@example.org") }] });
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

test("mail_archive is refused when an excluded folder lies under the archive folder", async () => {
  const m = add("a1", "INBOX", 1);
  for (const path of ["Archives/2026", "Archives/2026/10"]) {
    await save({ excludedFolders: [{ accountId: "a1", path }] });
    const r = await call("mail_archive", { ids: [m.id] });
    assert.equal(r.error.code, "excluded", path);
    assert.equal(r.error.message, "An excluded folder is inside this account's archive folder.");
  }
  // an excluded folder elsewhere, or a sibling with the same prefix, does not block it
  await save({ excludedFolders: [{ accountId: "a1", path: "ArchivesOld" }, { accountId: "a2", path: "Archives/2026" }] });
  const ok = await call("mail_archive", { ids: [m.id] });
  assert.deepEqual(ok.content.done, [m.id]);
});

test("a timed-out change reports mayHaveCompleted", async () => {
  SEARCH.budgetMs = 60;
  const a = add("a1", "INBOX", 1);
  mock.behaviour.stall = (op) => op === "move";
  const r = await call("mail_move", { ids: [a.id], folder: "Work" });
  assert.deepEqual(r.content.failed, [{ id: a.id, code: "thunderbird_error", mayHaveCompleted: true }]);
  mock.behaviour.stall = null;
  const b = add("a1", "INBOX", 2);
  mock.behaviour.fail = () => true;
  const r2 = await call("mail_mark", { ids: [b.id], read: true });
  assert.deepEqual(r2.content.failed, [{ id: b.id, code: "thunderbird_error" }]);
});

test("mail_tag matches keys case-insensitively", async () => {
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_tag", { ids: [m.id], add: ["$LABEL4"] });
  assert.deepEqual(r.content.done, [m.id]);
  assert.deepEqual(mock.store.get(m.num).tags, ["$label4"]);
});

test("mail_move refuses the Outbox and folders below it as a target", async () => {
  await save({ accounts: { a1: true, a2: true, a3: true, a4: true } });
  const m = add("a4", "Kept", 1);
  for (const folder of ["Unsent Messages", "Unsent Messages/Later"]) {
    for (const copy of [false, true]) {
      const r = await call("mail_move", { ids: [m.id], folder, copy });
      assert.equal(r.ok, false, folder);
      assert.equal(r.error.code, "refused", folder);
      assert.match(r.error.message, /Outbox/);
    }
  }
  noOrganiseCalls();
  const ok = await call("mail_move", { ids: [m.id], folder: "Inbox" });
  assert.deepEqual(ok.content.done, [m.id]);
});

test("mail_tag calls running together on one message keep both changes", async () => {
  const m = add("a1", "INBOX", 1);
  const update = globalThis.messenger.messages.update;
  let entered = false;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  globalThis.messenger.messages.update = async (id, props) => {
    if (!entered) {
      entered = true;
      await gate;
    }
    return update(id, props);
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const first = call("mail_tag", { ids: [m.id], add: ["Important"] });
  while (!entered) await tick();
  const second = call("mail_tag", { ids: [m.id], add: ["To Do"] });
  for (let i = 0; i < 5; i++) await tick();
  release();
  const [r1, r2] = await Promise.all([first, second]);
  assert.deepEqual(r1.content.done, [m.id]);
  assert.deepEqual(r2.content.done, [m.id]);
  assert.deepEqual([...mock.store.get(m.num).tags].sort(), ["$label1", "$label4"]);
});

test("mail_tag works from the tags the message has when it is written", async () => {
  const m = add("a1", "INBOX", 1);
  const get = globalThis.messenger.messages.get;
  // a tag added in Thunderbird after the id was resolved is kept
  globalThis.messenger.messages.get = async (id) => {
    mock.store.get(m.num).tags = ["$label4"];
    return get(id);
  };
  await call("mail_tag", { ids: [m.id], add: ["Important"] });
  assert.deepEqual([...mock.store.get(m.num).tags].sort(), ["$label1", "$label4"]);
});

test("mail_archive is refused when the account has no archive folder", async () => {
  const m = add("a3", "INBOX", 1);
  const r = await call("mail_archive", { ids: [m.id] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not_enabled");
  assert.match(r.error.message, /no archive folder/);
  noOrganiseCalls();
});

test("mail_archive is refused for an account without identities", async () => {
  await save({ accounts: { a1: true, a2: true, a3: true, a4: true } });
  const m = add("a4", "Kept", 1);
  const r = await call("mail_archive", { ids: [m.id] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not_enabled");
  assert.match(r.error.message, /no identities/);
  noOrganiseCalls();
});

test("mail_archive is refused when an archive folder is in Local Folders", async () => {
  const local = { id: "a4", name: "Local Folders", type: "none", folders: ["Inbox", "Archives"], specialUse: { Inbox: ["inbox"], Archives: ["archives"] } };
  for (const ownArchive of [false, true]) {
    clearIdCache();
    const a1 = { ...ACCOUNTS[0], folders: ownArchive ? ACCOUNTS[0].folders : ["INBOX", "Trash"], specialUse: ownArchive ? ACCOUNTS[0].specialUse : { INBOX: ["inbox"] } };
    mock = install({ accounts: [a1, ACCOUNTS[1], local] });
    await save({ accounts: { a1: true, a2: true }, excludedFolders: [] });
    const m = add("a1", "INBOX", 1);
    const off = await call("mail_archive", { ids: [m.id] });
    assert.equal(off.error.code, "not_enabled", `own archive ${ownArchive}`);

    await save({ accounts: { a1: true, a2: true, a4: true }, excludedFolders: [{ accountId: "a4", path: "Archives" }] });
    const excluded = await call("mail_archive", { ids: [m.id] });
    assert.equal(excluded.error.code, ownArchive ? "excluded" : "not_enabled", `own archive ${ownArchive}`);

    await save({ excludedFolders: [] });
    const enabled = await call("mail_archive", { ids: [m.id] });
    assert.equal(enabled.error.code, ownArchive ? "refused" : "not_enabled", `own archive ${ownArchive}`);
    if (ownArchive) assert.match(enabled.error.message, /another account/);
    noOrganiseCalls();
    assert.equal(folderOf(m.num).path, "INBOX");
  }
});

test("another enabled account's own archive folder does not block archiving", async () => {
  const a2 = { ...ACCOUNTS[1], folders: [...ACCOUNTS[1].folders, "Archives"], specialUse: { ...ACCOUNTS[1].specialUse, Archives: ["archives"] } };
  mock = install({ accounts: [ACCOUNTS[0], a2, ACCOUNTS[2]] });
  await save({ accounts: { a1: true, a2: true, a3: true }, excludedFolders: [] });
  const m = add("a1", "INBOX", 1);
  const r = await call("mail_archive", { ids: [m.id] });
  assert.deepEqual(r.content.done, [m.id]);
  assert.equal(folderOf(m.num).path, "Archives");
  assert.equal(folderOf(m.num).accountId, "a1");
});

test("an archive folder in an account that is not enabled, or excluded, blocks archiving", async () => {
  // An identity of a1 may archive into a2's folder: Thunderbird does not
  // say which folder each identity uses.
  const a2 = { ...ACCOUNTS[1], folders: [...ACCOUNTS[1].folders, "Archives", "Archives/2026"], specialUse: { ...ACCOUNTS[1].specialUse, Archives: ["archives"] } };
  const feeds = { id: "a5", name: "Feeds", type: "rss", folders: ["Archives"], specialUse: { Archives: ["archives"] } };
  mock = install({ accounts: [ACCOUNTS[0], a2, ACCOUNTS[2], feeds] });
  const m = add("a1", "INBOX", 1);
  const cases = [
    [{ accounts: { a1: true, a5: true }, excludedFolders: [] }, "not_enabled", /not enabled/],
    [{ accounts: { a1: true, a2: true, a5: true }, excludedFolders: [{ accountId: "a2", path: "Archives" }] }, "excluded", /excluded/],
    [{ accounts: { a1: true, a2: true, a5: true }, excludedFolders: [{ accountId: "a2", path: "Archives/2026" }] }, "excluded", /excluded/],
    // a feed account counts too
    [{ accounts: { a1: true, a2: true }, excludedFolders: [] }, "not_enabled", /not enabled/],
  ];
  for (const [settings, code, message] of cases) {
    await save(settings);
    const r = await call("mail_archive", { ids: [m.id] });
    assert.equal(r.ok, false, JSON.stringify(settings));
    assert.equal(r.error.code, code, JSON.stringify(settings));
    assert.match(r.error.message, message);
    assert.match(r.error.message, /another account/);
  }
  noOrganiseCalls();
  assert.equal(folderOf(m.num).path, "INBOX");
  await save({ accounts: { a1: true, a2: true, a5: true }, excludedFolders: [] });
  assert.deepEqual((await call("mail_archive", { ids: [m.id] })).content.done, [m.id]);
});

test("mail_archive reports a message Thunderbird did not archive as failed", async () => {
  const kept = add("a1", "INBOX", 1);
  const gone = add("a1", "INBOX", 2);
  // archiving turned off for the identity: Thunderbird skips the message
  mock.behaviour.archiveSkip = (id) => id === kept.num;
  const r = await call("mail_archive", { ids: [kept.id, gone.id] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.content, {
    done: [gone.id],
    failed: [{ id: kept.id, code: "not_enabled" }],
    moved: [{ from: gone.id, to: encodeId("a1", "Archives", "msg2@example.org") }],
  });
  assert.equal(folderOf(kept.num).path, "INBOX");
  assert.equal(mock.calls.archive.length, 2);
});

test("mail_archive gives the new id from Thunderbird's move event, also when it comes late", async () => {
  const yearly = { ...ACCOUNTS[0], folders: [...ACCOUNTS[0].folders, "Archives/2026"] };
  mock = install({ accounts: [yearly, ...ACCOUNTS.slice(1)] });
  await save({ accounts: { a1: true, a2: true, a3: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  const m = add("a1", "INBOX", 1);
  // Thunderbird files into a year subfolder; on IMAP the event comes once
  // the message is seen there
  mock.behaviour.archiveTo = () => ({ accountId: "a1", path: "Archives/2026" });
  mock.behaviour.movedDelay = 150;
  const r = await call("mail_archive", { ids: [m.id] });
  assert.deepEqual(r.content, { done: [m.id], failed: [], moved: [{ from: m.id, to: encodeId("a1", "Archives/2026", "msg1@example.org") }] });
  assert.equal(globalThis.messenger.messages.onMoved.listeners.length, 0);
});

test("mail_archive without a move event still reports the message done, with no new id", async () => {
  SEARCH.budgetMs = 400;
  const m = add("a1", "INBOX", 1);
  mock.behaviour.movedDelay = null;
  const r = await call("mail_archive", { ids: [m.id] });
  assert.deepEqual(r.content, { done: [m.id], failed: [], moved: [] });
  assert.equal(folderOf(m.num).path, "Archives");
});

test("mail_archive gives no new id for a folder the settings do not allow", async () => {
  const m = add("a1", "INBOX", 1);
  const n = add("a1", "INBOX", 2);
  // Thunderbird filed them where the checks did not expect
  mock.behaviour.archiveTo = (h) => (h.headerMessageId === "msg1@example.org" ? { accountId: "a1", path: "Private" } : { accountId: "a4", path: "Kept" });
  const r = await call("mail_archive", { ids: [m.id, n.id] });
  assert.deepEqual(r.content, { done: [m.id, n.id], failed: [], moved: [] });
});

test("mail_move copy into the message's own folder fails; a move there changes nothing", async () => {
  const m = add("a1", "Work", 1);
  const other = add("a1", "INBOX", 2);
  const c = await call("mail_move", { ids: [m.id, other.id], folder: "Work", copy: true });
  assert.deepEqual(c.content, {
    done: [other.id],
    failed: [{ id: m.id, code: "refused" }],
    copied: [{ from: other.id, to: encodeId("a1", "Work", "msg2@example.org") }],
  });
  assert.equal(mock.calls.copy.length, 1);
  assert.deepEqual(mock.calls.copy[0][0], [other.num]);
  const mv = await call("mail_move", { ids: [m.id], folder: "Work" });
  assert.deepEqual(mv.content, { done: [m.id], failed: [], moved: [{ from: m.id, to: m.id }] });
  assert.equal(mock.calls.move.length, 0);
});

test("mail_move refuses a folder that cannot hold messages", async () => {
  const a1 = { ...ACCOUNTS[0], folders: [...ACCOUNTS[0].folders, "Clients", "Clients/Acme"], noMessages: ["Clients"] };
  mock = install({ accounts: [a1, ...ACCOUNTS.slice(1)] });
  await save({ accounts: { a1: true, a2: true, a3: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  const m = add("a1", "INBOX", 1);
  for (const copy of [false, true]) {
    const r = await call("mail_move", { ids: [m.id], folder: "Clients", copy });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_argument");
    assert.equal(r.error.message, "This folder cannot hold messages.");
  }
  noOrganiseCalls();
  const ok = await call("mail_move", { ids: [m.id], folder: "Clients/Acme" });
  assert.deepEqual(ok.content.done, [m.id]);
});

test("mail_move goes ahead when Thunderbird cannot say what a folder allows", async () => {
  const m = add("a1", "INBOX", 1);
  globalThis.messenger.folders.getFolderCapabilities = async () => {
    throw new Error("no capabilities");
  };
  assert.deepEqual((await call("mail_move", { ids: [m.id], folder: "Work" })).content.done, [m.id]);
  delete globalThis.messenger.folders.getFolderCapabilities;
  const n = add("a1", "INBOX", 2);
  assert.deepEqual((await call("mail_move", { ids: [n.id], folder: "Work" })).content.done, [n.id]);
});

test("mail_tags lists keys, labels and colours, cleaned", async () => {
  const r = await call("mail_tags", {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.content, {
    tags: [
      { key: "$label1", label: "Important", color: "#FF0000" },
      { key: "$label4", label: "To Do", color: "#3333FF" },
    ],
  });
  globalThis.messenger.messages.tags.list = async () => [
    { key: "invoices", tag: "Invo​ices", color: "red", ordinal: "" },
    { key: "", tag: "No key" },
    null,
  ];
  assert.deepEqual((await call("mail_tags", {})).content, { tags: [{ key: "invoices", label: "Invoices", color: null }] });
  assert.equal(mock.calls.update.length, 0);
});

test("mail_tags is a read tool", async () => {
  await save({ groups: { read: false, organise: true, compose: false, contacts: false } });
  assert.equal((await call("mail_tags", {})).error.code, "not_enabled");
  await save({ groups: { read: true, organise: false, compose: false, contacts: false } });
  assert.equal((await call("mail_tags", {})).ok, true);
});
