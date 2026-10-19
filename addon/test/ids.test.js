/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { install } from "./mocks/messenger.js";
import { encodeId, decodeId, resolveId, clearIdCache } from "../src/ids.js";

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
