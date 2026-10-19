/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { install, fetchFrom } from "./mocks/messenger.js";
import { dispatch } from "../src/rpc.js";
import { save } from "../src/settings.js";
import { encodeId, decodeId, clearIdCache } from "../src/ids.js";
import { SEARCH } from "../src/handlers/read.js";

const POINTER_KEYS = ["date", "flagged", "folder", "from", "hasAttachments", "id", "read", "subject", "tags", "toCount"].sort();
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);

let mock;
const budget = SEARCH.budgetMs;
beforeEach(async () => {
  clearIdCache();
  SEARCH.budgetMs = budget;
  mock = install({
    accounts: [
      {
        id: "a1",
        name: "Work",
        type: "imap",
        identities: [{ email: "me@work.example", name: "Me" }],
        folders: ["INBOX", "Secret", "Secret/Sub", "Archive"],
        specialUse: { INBOX: ["inbox"], Archive: ["archives"] },
      },
      { id: "a2", name: "Off", type: "imap", identities: [{ email: "off@example.org" }], folders: ["INBOX"] },
      { id: "a3", name: "Home", type: "pop3", identities: [], folders: ["INBOX"] },
    ],
  });
  globalThis.fetch = fetchFrom({});
  await save({ accounts: { a1: true, a2: false, a3: true }, excludedFolders: [{ accountId: "a1", path: "Secret" }] });
});
afterEach(() => {
  SEARCH.budgetMs = budget;
});

const call = (tool, args = {}) => dispatch({ type: "call", id: "c1", tool, args, client: "test" });
async function ok(tool, args) {
  const r = await call(tool, args);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.content;
}

test("TestSearchPointerKeysExact", async () => {
  const body = "BODY-SECRET-TEXT never returned";
  mock.addMessage("a1", "INBOX", {
    subject: "Hello zebra",
    author: '"Ann Example" <ann@example.org>',
    recipients: ["b@example.org", "c@example.org"],
    ccList: ["d@example.org"],
    bccList: ["e@example.org"],
    date: ago(1),
    read: true,
    flagged: true,
    tags: ["$label1"],
    body,
    attachments: [{ name: "a.pdf", size: 3, contentType: "application/pdf", partName: "1.2" }],
  });
  mock.addMessage("a3", "INBOX", { subject: "Other zebra", author: "plain@example.org", date: ago(2), body });
  const out = await ok("mail_search", { text: "zebra" });
  assert.deepEqual(Object.keys(out).sort(), ["messages", "truncated"]);
  assert.equal(out.messages.length, 2);
  for (const p of out.messages) {
    assert.deepEqual(Object.keys(p).sort(), POINTER_KEYS);
    assert.deepEqual(Object.keys(p.from).sort(), ["address", "name"]);
    assert.doesNotMatch(JSON.stringify(p), /BODY-SECRET/);
  }
  const [a, b] = out.messages;
  assert.deepEqual(a.from, { name: "Ann Example", address: "ann@example.org" });
  assert.equal(a.toCount, 4);
  assert.equal(a.folder, "INBOX");
  assert.equal(a.read, true);
  assert.equal(a.flagged, true);
  assert.deepEqual(a.tags, ["$label1"]);
  assert.equal(a.hasAttachments, true);
  assert.equal(a.subject, "Hello zebra");
  assert.match(a.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(decodeId(a.id), { accountId: "a1", folderPath: "INBOX", headerMessageId: "m1@example.org" });
  assert.deepEqual(b.from, { name: "", address: "plain@example.org" });
  assert.equal(b.hasAttachments, false);
  assert.equal(out.truncated, false);
});

test("search maps its arguments to messages.query with Date objects", async () => {
  await ok("mail_search", {
    account: "a1",
    folder: "INBOX",
    text: "t",
    from: "f",
    to: "r",
    subject: "s",
    since: "2026-01-02",
    until: "2026-03-04",
    unread: true,
    flagged: false,
    tag: "$label2",
    has_attachment: true,
    limit: 7,
  });
  const q = mock.calls.query[0];
  assert.equal(q.accountId, "a1");
  assert.equal(q.folderId, mock.folder("a1", "INBOX").id);
  assert.equal(q.includeSubFolders, true);
  assert.equal(q.fullText, "t");
  assert.equal(q.author, "f");
  assert.equal(q.recipients, "r");
  assert.equal(q.subject, "s");
  assert.equal(q.read, false);
  assert.equal(q.flagged, false);
  assert.deepEqual(q.tags, { tags: { $label2: true }, mode: "all" });
  assert.equal(q.attachment, true);
  assert.equal(q.messagesPerPage, 7);
  assert.equal(q.autoPaginationTimeout, 0);
  assert.equal(q.returnMessageListId, true);
  assert.ok(q.fromDate instanceof Date && q.toDate instanceof Date);
  // The first window ends at the end of `until` and the last starts at `since`.
  assert.ok(q.toDate.getTime() >= new Date(2026, 2, 4, 23, 59).getTime());
  for (const c of mock.calls.query) assert.ok(c.fromDate.getTime() >= new Date(2026, 0, 2).getTime());
  assert.equal(mock.calls.query.at(-1).fromDate.getTime(), new Date(2026, 0, 2).getTime());
});

test("search refuses malformed arguments", async () => {
  for (const args of [{ since: "2026-13-01" }, { since: "yesterday" }, { text: 5 }, { unread: "yes" }, { limit: "many" }]) {
    assert.equal((await call("mail_search", args)).error.code, "invalid_argument", JSON.stringify(args));
  }
});

test("TestSearchExcludesExcludedFolder", async () => {
  mock.addMessage("a1", "INBOX", { subject: "zebra visible", date: ago(3) });
  mock.addMessage("a1", "Secret", { subject: "zebra hidden", date: ago(1) });
  mock.addMessage("a1", "Secret/Sub", { subject: "zebra hidden sub", date: ago(2) });
  for (const args of [{ text: "zebra" }, { account: "a1", text: "zebra" }, { subject: "zebra", limit: 1 }]) {
    const out = await ok("mail_search", args);
    assert.ok(out.messages.length >= 1);
    for (const p of out.messages) {
      assert.equal(p.folder, "INBOX");
      assert.doesNotMatch(JSON.stringify(p), /hidden/);
    }
  }
  assert.equal((await call("mail_search", { account: "a1", folder: "Secret" })).error.code, "excluded");
  assert.equal((await call("mail_search", { account: "a1", folder: "Secret/Sub" })).error.code, "excluded");
});

test("a folder search leaves out excluded subfolders", async () => {
  mock = install({ accounts: [{ id: "a1", name: "Work", type: "imap", folders: ["Archive", "Archive/Private"] }] });
  await save({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Archive/Private" }] });
  mock.addMessage("a1", "Archive", { subject: "kept", date: ago(1) });
  mock.addMessage("a1", "Archive/Private", { subject: "private", date: ago(1) });
  const out = await ok("mail_search", { folder: "Archive" });
  assert.deepEqual(
    out.messages.map((p) => p.subject),
    ["kept"],
  );
});

test("TestSearchDisabledAccountInvisible", async () => {
  mock.addMessage("a2", "INBOX", { subject: "zebra off", date: ago(1) });
  mock.addMessage("a3", "INBOX", { subject: "zebra on", date: ago(1) });
  const out = await ok("mail_search", { subject: "zebra" });
  assert.deepEqual(
    out.messages.map((p) => p.subject),
    ["zebra on"],
  );
  for (const q of mock.calls.query) assert.notDeepEqual([].concat(q.accountId), ["a2"]);
  assert.equal((await call("mail_search", { account: "a2", subject: "zebra" })).error.code, "not_enabled");
});

test("TestSearchLimitClampedTo200", async () => {
  for (let i = 0; i < 300; i++) mock.addMessage("a3", "INBOX", { date: new Date(Date.now() - i * 60_000) });
  const out = await ok("mail_search", { account: "a3", limit: 1000 });
  assert.equal(out.messages.length, 200);
  assert.equal(out.truncated, true);
  for (const q of mock.calls.query) assert.ok(q.messagesPerPage <= 200);
  const def = await ok("mail_search", { account: "a3" });
  assert.equal(def.messages.length, 25);
});

test("TestSearchStopsAtLimitOn100k", async () => {
  const now = Date.now();
  for (let i = 0; i < 100_000; i++) mock.addMessage("a3", "INBOX", { date: new Date(now - i * 10_000) });
  const limit = 25;
  const t0 = Date.now();
  const out = await ok("mail_search", { account: "a3", limit });
  // Each list is read for at most ceil(limit/pageSize)+1 pages: its first
  // page plus continueList pages. A full first page with more behind it
  // makes the search split the date window (newer half first) instead of
  // reading on, so the total stays logarithmic in the window size.
  const pageSize = mock.calls.query[0].messagesPerPage;
  assert.equal(pageSize, limit);
  const perQuery = mock.pagesPerQuery();
  for (const n of perQuery) assert.ok(n <= Math.ceil(limit / pageSize) + 1, `a list read for ${n} pages`);
  const pages = perQuery.reduce((a, b) => a + b, 0);
  assert.ok(pages <= 64, `fetched ${pages} pages`);
  assert.equal(out.messages.length, limit);
  assert.equal(out.truncated, true);
  assert.ok(mock.calls.abortList.length >= 1, "open lists are aborted");
  assert.deepEqual(mock.openLists(), []);
  // the newest 25, newest first
  const dates = out.messages.map((p) => Date.parse(p.date));
  assert.deepEqual(
    dates,
    Array.from({ length: limit }, (_, i) => now - i * 10_000),
  );
  assert.ok(Date.now() - t0 < 10_000);
});

test("search walks date windows newest first and returns the newest matches", async () => {
  // oldest-first storage: an unbounded first page would return these old ones
  for (let i = 0; i < 30; i++) mock.addMessage("a3", "INBOX", { subject: `old ${i}`, date: ago(400 + i) });
  for (let i = 0; i < 3; i++) mock.addMessage("a3", "INBOX", { subject: `mid ${i}`, date: ago(45 + i) });
  for (let i = 0; i < 2; i++) mock.addMessage("a3", "INBOX", { subject: `new ${i}`, date: ago(1 + i) });
  const out = await ok("mail_search", { account: "a3", limit: 10 });
  assert.deepEqual(
    out.messages.map((p) => p.subject),
    ["new 0", "new 1", "mid 0", "mid 1", "mid 2", "old 0", "old 1", "old 2", "old 3", "old 4"],
  );
  assert.equal(out.truncated, true);
  assert.ok(Math.abs(mock.calls.query[0].fromDate.getTime() - ago(30).getTime()) < 2000, "first window starts 30 days back");
  assert.ok(mock.calls.query[0].toDate.getTime() > Date.now(), "first window includes today");
  for (let i = 1; i < mock.calls.query.length; i++) {
    assert.ok(mock.calls.query[i].toDate <= mock.calls.query[i - 1].toDate, "windows go backwards");
  }
  // nothing returned twice across overlapping windows
  assert.equal(new Set(out.messages.map((p) => p.id)).size, out.messages.length);
});

test("search with until starts from it and a reached since bound ends with truncated false", async () => {
  mock.addMessage("a3", "INBOX", { subject: "after", date: new Date(2026, 5, 10) });
  mock.addMessage("a3", "INBOX", { subject: "in", date: new Date(2026, 4, 10) });
  mock.addMessage("a3", "INBOX", { subject: "before", date: new Date(2025, 0, 1) });
  const out = await ok("mail_search", { account: "a3", since: "2026-01-01", until: "2026-05-31" });
  assert.deepEqual(
    out.messages.map((p) => p.subject),
    ["in"],
  );
  assert.equal(out.truncated, false);
  assert.ok(mock.calls.query[0].toDate.getTime() <= new Date(2026, 5, 1).getTime());
});

test("a query that never settles returns what was found with truncated true", async () => {
  SEARCH.budgetMs = 300;
  mock.addMessage("a3", "INBOX", { subject: "recent", date: ago(1) });
  mock.addMessage("a3", "INBOX", { subject: "older", date: ago(50) });
  mock.behaviour.hang = (q) => q.fromDate && q.fromDate.getTime() < ago(31).getTime();
  const t0 = Date.now();
  const out = await ok("mail_search", { account: "a3" });
  assert.ok(Date.now() - t0 < 2000, "bounded by the budget");
  assert.deepEqual(
    out.messages.map((p) => p.subject),
    ["recent"],
  );
  assert.equal(out.truncated, true);
  assert.deepEqual(mock.openLists(), [], "the hung list is aborted");
});

test("a query that answers after the budget has its list aborted", async () => {
  SEARCH.budgetMs = 150;
  mock.addMessage("a3", "INBOX", { subject: "late", date: ago(1) });
  mock.behaviour.delay = () => 400;
  const out = await ok("mail_search", { account: "a3" });
  assert.deepEqual(out, { messages: [], truncated: true });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(mock.calls.query.length, 1);
  assert.equal(mock.calls.abortList.length, 1, "the late list id is aborted");
  assert.deepEqual(mock.openLists(), []);
});

test("a rejected query aborts every open list before the error", async () => {
  // a3's list opens and hangs; a1's query fails a little later
  mock.behaviour.hang = (q) => q.accountId === "a3";
  const real = mock.messenger.messages.query;
  mock.messenger.messages.query = async (q) => {
    if (q.accountId === "a1") {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("Thunderbird failed");
    }
    return real(q);
  };
  const r = await call("mail_search", {});
  assert.equal(r.error.code, "thunderbird_error");
  assert.ok(mock.calls.abortList.length >= 1);
  assert.deepEqual(mock.openLists(), []);
});

test("hasAttachments is null when the check does not finish within the budget", async () => {
  SEARCH.budgetMs = 200;
  mock.addMessage("a3", "INBOX", { subject: "x", date: ago(1) });
  mock.messenger.messages.listAttachments = () => new Promise(() => {});
  const t0 = Date.now();
  const out = await ok("mail_search", { account: "a3" });
  assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0} ms`);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].hasAttachments, null);
  const known = await ok("mail_search", { account: "a3", has_attachment: false });
  assert.equal(known.messages[0].hasAttachments, false);
});

test("a never-settling continueList is aborted", async () => {
  SEARCH.budgetMs = 300;
  // same second: the window cannot be split further, so the list is read on
  const when = ago(1);
  for (let i = 0; i < 5; i++) mock.addMessage("a3", "INBOX", { date: when });
  mock.messenger.messages.query = ((real) => (q) => real({ ...q, messagesPerPage: 2 }))(mock.messenger.messages.query);
  const hung = [];
  const realNext = mock.messenger.messages.continueList;
  let first = true;
  mock.messenger.messages.continueList = async (id) => {
    if (first) {
      first = false;
      return realNext(id);
    }
    hung.push(id);
    return new Promise(() => {});
  };
  const t0 = Date.now();
  const out = await ok("mail_search", { account: "a3", limit: 5 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(out.truncated, true);
  assert.equal(out.messages.length, 2);
  assert.equal(hung.length, 1);
  assert.ok(mock.calls.abortList.includes(hung[0]));
});

test("search queries every enabled account with at most 4 queries in flight", async () => {
  const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
  mock = install({ accounts: ids.map((id) => ({ id, name: id, type: "imap", folders: ["INBOX"] })) });
  await save({ accounts: Object.fromEntries(ids.map((id) => [id, true])) });
  for (const id of ids) mock.addMessage(id, "INBOX", { subject: `hit ${id}`, date: ago(1) });
  const out = await ok("mail_search", { subject: "hit", limit: 3 });
  assert.ok(mock.behaviour.maxInFlight <= 4, `max in flight ${mock.behaviour.maxInFlight}`);
  assert.ok(mock.behaviour.maxInFlight >= 2);
  assert.equal(out.messages.length, 3);
  assert.equal(out.truncated, true);
  assert.deepEqual(new Set(mock.calls.query.map((q) => q.accountId)), new Set(ids));
});

test("mail_accounts lists enabled accounts only", async () => {
  const out = await ok("mail_accounts", {});
  assert.deepEqual(out, {
    accounts: [
      { id: "a1", name: "Work", address: "me@work.example", type: "imap" },
      { id: "a3", name: "Home", address: "", type: "pop3" },
    ],
  });
});

test("TestFoldersHideExcluded", async () => {
  mock.addMessage("a1", "INBOX", { read: false });
  mock.addMessage("a1", "INBOX", { read: true });
  const out = await ok("mail_folders", { account: "a1" });
  assert.deepEqual(out, {
    folders: [
      { account: "a1", path: "INBOX", name: "INBOX", unread: 1, total: 2, specialUse: ["inbox"] },
      { account: "a1", path: "Archive", name: "Archive", unread: 0, total: 0, specialUse: ["archives"] },
    ],
  });
  const all = await ok("mail_folders", {});
  assert.deepEqual(
    all.folders.map((f) => `${f.account}:${f.path}`),
    ["a1:INBOX", "a1:Archive", "a3:INBOX"],
  );
  assert.equal((await call("mail_folders", { account: "a2" })).error.code, "not_enabled");
});

function threadFixture() {
  const root = mock.addMessage("a1", "INBOX", { subject: "Plan", date: ago(5), headerMessageId: "root@x" });
  const hidden = mock.addMessage("a1", "Secret", {
    subject: "Re: Plan secret",
    date: ago(4),
    headerMessageId: "hidden@x",
    inReplyTo: "root@x",
    references: ["root@x"],
  });
  const reply = mock.addMessage("a1", "INBOX", {
    subject: "Re: Plan",
    date: ago(3),
    headerMessageId: "reply@x",
    inReplyTo: "hidden@x",
    references: ["root@x", "hidden@x"],
  });
  const later = mock.addMessage("a1", "Archive", {
    subject: "Re: Re: Plan",
    date: ago(2),
    headerMessageId: "later@x",
    inReplyTo: "reply@x",
    references: ["root@x", "hidden@x", "reply@x"],
  });
  mock.addMessage("a1", "INBOX", { subject: "Plan", date: ago(1), headerMessageId: "unrelated@x" });
  // same subject, replies to the root, but in an excluded folder
  mock.addMessage("a1", "Secret", { subject: "Re: Plan", date: ago(2), headerMessageId: "hidden2@x", references: ["root@x"] });
  mock.addMessage("a3", "INBOX", { subject: "Re: Plan", date: ago(1), headerMessageId: "other-account@x", references: ["root@x"] });
  return { root, hidden, reply, later };
}

test("TestThreadExcludesExcluded", async () => {
  const { root, reply, later } = threadFixture();
  const out = await ok("mail_thread", { id: encodeId("a1", "INBOX", reply.headerMessageId) });
  assert.deepEqual(Object.keys(out), ["messages"]);
  assert.deepEqual(
    out.messages.map((p) => decodeId(p.id).headerMessageId),
    [root.headerMessageId, reply.headerMessageId, later.headerMessageId],
  );
  for (const p of out.messages) {
    assert.deepEqual(Object.keys(p).sort(), POINTER_KEYS);
    assert.doesNotMatch(JSON.stringify(p), /secret/);
  }
  // from the root, replies are found downstream; still without the excluded one
  const fromRoot = await ok("mail_thread", { id: encodeId("a1", "INBOX", root.headerMessageId) });
  assert.deepEqual(
    fromRoot.messages.map((p) => decodeId(p.id).headerMessageId),
    [root.headerMessageId, reply.headerMessageId, later.headerMessageId],
  );
  assert.equal((await call("mail_thread", { id: encodeId("a1", "Secret", "hidden@x") })).error.code, "excluded");
  const secretIds = [...mock.store.values()].filter((h) => h.folder.path === "Secret").map((h) => h.id);
  for (const id of mock.calls.getRaw) assert.ok(!secretIds.includes(id), "no raw source read from an excluded folder");
  assert.equal("truncated" in fromRoot, false);
});

test("thread is marked truncated when its budget runs out", async () => {
  SEARCH.budgetMs = 200;
  const { reply } = threadFixture();
  mock.behaviour.hang = (q) => q.headerMessageId === "root@x";
  const out = await ok("mail_thread", { id: encodeId("a1", "INBOX", reply.headerMessageId) });
  assert.equal(out.truncated, true);
  assert.ok(out.messages.some((p) => decodeId(p.id).headerMessageId === "reply@x"));
  assert.deepEqual(mock.openLists(), []);
});

test("mail_folders gives up when Thunderbird does not answer", async () => {
  SEARCH.budgetMs = 150;
  mock.messenger.folders.query = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await call("mail_folders", {});
  assert.equal(r.error.code, "thunderbird_error");
  assert.ok(Date.now() - t0 < 1000);
});

test("thread of a vanished message is not_found", async () => {
  const r = await call("mail_thread", { id: encodeId("a1", "INBOX", "gone@x") });
  assert.deepEqual(r.error, { code: "not_found", message: "Message not found in INBOX" });
});

test("thread reads only the head of the raw source", async () => {
  const big = "x".repeat(5 * 1024 * 1024);
  const m = mock.addMessage("a1", "INBOX", { subject: "Big", date: ago(1), headerMessageId: "big@x", body: big });
  let sliced = 0;
  const realRaw = mock.messenger.messages.getRaw;
  mock.messenger.messages.getRaw = async (id, opts) => {
    const blob = await realRaw(id, opts);
    return {
      slice: (a, b) => {
        sliced = b - a;
        return blob.slice(a, b);
      },
      text: () => assert.fail("whole source read"),
    };
  };
  const out = await ok("mail_thread", { id: encodeId("a1", "INBOX", m.headerMessageId) });
  assert.equal(out.messages.length, 1);
  assert.ok(sliced > 0 && sliced <= 65536);
});
