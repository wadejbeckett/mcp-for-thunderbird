/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { install } from "./mocks/messenger.js";
import { encodeId, decodeId, resolveId, clearIdCache, endList, END } from "../src/ids.js";

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

let mock;
beforeEach(() => {
  clearIdCache();
  mock = install({
    accounts: [{ id: "account1", name: "Work", type: "imap", folders: ["INBOX", "Ärchiv/Übersicht 📁", "Other"] }],
  });
});

async function rejectsWith(p, code, message) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code);
    if (message !== undefined) assert.equal(e.message, message);
    return true;
  });
}

test("encode and decode round trip with unicode folder paths", () => {
  const id = encodeId("account1", "Ärchiv/Übersicht 📁", "<x@y>");
  assert.match(id, /^m1\.[A-Za-z0-9_-]+$/);
  assert.equal(id.slice(3), b64url(JSON.stringify(["account1", "Ärchiv/Übersicht 📁", "<x@y>"])));
  assert.deepEqual(decodeId(id), { accountId: "account1", folderPath: "Ärchiv/Übersicht 📁", headerMessageId: "<x@y>" });
});

test("a tampered prefix is invalid_argument", () => {
  const id = encodeId("account1", "INBOX", "a@b");
  assert.throws(() => decodeId("m2." + id.slice(3)), { code: "invalid_argument" });
  assert.throws(() => decodeId(id.slice(3)), { code: "invalid_argument" });
});

test("a payload that is not a three-string array is invalid_argument", () => {
  for (const payload of [
    b64url(JSON.stringify({ a: 1 })),
    b64url(JSON.stringify(["a", "b"])),
    b64url(JSON.stringify(["a", "b", 3])),
    b64url(JSON.stringify(["a", "b", "c", "d"])),
    b64url(JSON.stringify("abc")),
    b64url("not json"),
    "!!!",
    "",
    b64url(JSON.stringify(["a", "b", "c"])) + "=",
  ]) {
    assert.throws(() => decodeId("m1." + payload), { code: "invalid_argument" }, payload);
  }
  assert.throws(() => decodeId(42), { code: "invalid_argument" });
});

test("resolveId finds the message by Message-ID after a restart reshuffles numeric ids", async () => {
  const a = mock.addMessage("account1", "Ärchiv/Übersicht 📁");
  const b = mock.addMessage("account1", "INBOX");
  const id = encodeId("account1", a.folder.path, a.headerMessageId);

  const first = await resolveId(id);
  assert.equal(first.id, a.id);
  assert.equal(first.headerMessageId, a.headerMessageId);

  // Cached: no second query in the same session.
  const queries = mock.calls.query.length;
  assert.equal((await resolveId(id)).id, a.id);
  assert.equal(mock.calls.query.length, queries);

  mock.restart();
  // The old numeric id now names the other message.
  assert.equal((await mock.messenger.messages.get(a.id)).headerMessageId, b.headerMessageId);
  const after = await resolveId(id);
  assert.equal(after.headerMessageId, a.headerMessageId);
  assert.notEqual(after.headerMessageId, b.headerMessageId);
  assert.notEqual(after.id, a.id);
  assert.deepEqual(mock.calls.query.at(-1), { accountId: "account1", folderId: a.folder.id, headerMessageId: a.headerMessageId });
});

test("resolveId keeps reading pages until it finds the message, then aborts the list", async () => {
  const a = mock.addMessage("account1", "INBOX");
  const real = mock.messenger.messages.query;
  mock.messenger.messages.query = (q) => real({ ...q, emptyFirstPage: true });
  const h = await resolveId(encodeId("account1", "INBOX", a.headerMessageId));
  assert.equal(h.id, a.id);
  assert.equal(mock.openLists().length, 0);
});

test("a missing message gives not_found with the exact message", async () => {
  const a = mock.addMessage("account1", "INBOX");
  const id = encodeId("account1", "INBOX", a.headerMessageId);
  await resolveId(id);
  mock.removeMessage(a.id);
  await rejectsWith(resolveId(id), "not_found", "Message not found in INBOX");
  await rejectsWith(resolveId(encodeId("account1", "Other", a.headerMessageId)), "not_found", "Message not found in Other");
  await rejectsWith(resolveId(encodeId("account1", "Gone/Folder", "x@y")), "not_found", "Message not found in Gone/Folder");
});

test("a message moved to another folder is not found in the old one", async () => {
  const a = mock.addMessage("account1", "INBOX");
  const id = encodeId("account1", "Other", a.headerMessageId);
  await rejectsWith(resolveId(id), "not_found", "Message not found in Other");
});

test("endList aborts a list and reads it to its last page, so Thunderbird forgets it", async () => {
  for (let i = 0; i < 7; i++) mock.addMessage("account1", "INBOX");
  const m = mock.messenger.messages;
  const listId = await m.query({ accountId: "account1", messagesPerPage: 2, returnMessageListId: true });
  await m.continueList(listId);
  assert.equal(mock.openLists().length, 1);
  const open = mock.openLists()[0];
  await endList(open);
  assert.deepEqual(mock.calls.abortList, [open]);
  assert.ok(mock.calls.continueList.includes(open));
  assert.deepEqual(mock.openLists(), []);
});

test("endList ignores a list that is gone and gives up on one that never answers", async () => {
  await endList("no-such-list");
  const m = mock.messenger.messages;
  const was = END.waitMs;
  END.waitMs = 50;
  try {
    m.abortList = () => new Promise(() => {});
    const t0 = Date.now();
    await endList("x");
    m.abortList = async () => {};
    m.continueList = () => new Promise(() => {});
    await endList("y");
    assert.ok(Date.now() - t0 < 500);
  } finally {
    END.waitMs = was;
  }
});
