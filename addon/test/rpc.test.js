/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { install, fetchFrom } from "./mocks/messenger.js";
import { HANDLERS, dispatch, withSave } from "../src/rpc.js";
import { save } from "../src/settings.js";
import { list, clear, append } from "../src/log.js";
import { ToolError } from "../src/errors.js";
import { encodeId } from "../src/ids.js";

let mock;
beforeEach(async () => {
  for (const k of Object.keys(HANDLERS)) delete HANDLERS[k];
  mock = install({ accounts: [{ id: "a1", name: "Work", type: "imap", folders: ["INBOX"] }] });
  globalThis.fetch = fetchFrom({});
  await save({ accounts: { a1: true } });
  await clear();
});

const call = (tool, args = {}, extra = {}) => ({ type: "call", id: "c1", tool, args, client: "test-client", ...extra });

test("an unknown tool gives invalid_argument", async () => {
  const r = await dispatch(call("mail_bogus"));
  assert.equal(r.type, "result");
  assert.equal(r.id, "c1");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_argument");
  // A catalogue tool with no handler registered yet is also refused.
  assert.equal((await dispatch(call("mail_search"))).error.code, "invalid_argument");
});

test("a handler result becomes ok:true content", async () => {
  HANDLERS.mail_accounts = async (args, ctx) => ({ accounts: [], client: ctx.client });
  const r = await dispatch(call("mail_accounts"));
  assert.deepEqual(r, { type: "result", id: "c1", ok: true, content: { accounts: [], client: "test-client" } });
});

test("withSave adds the save field", async () => {
  HANDLERS.mail_attachment = async () => withSave({ saved: true }, { name: "a.txt", data: "aGk=" });
  const r = await dispatch(call("mail_attachment", { id: encodeId("a1", "INBOX", "x@y"), name: "a.txt" }));
  assert.deepEqual(r, { type: "result", id: "c1", ok: true, content: { saved: true }, save: { name: "a.txt", data: "aGk=" } });
});

test("a thrown ToolError maps to ok:false with its code and message", async () => {
  HANDLERS.mail_folders = async () => {
    throw new ToolError("too_large", "Too big.");
  };
  const r = await dispatch(call("mail_folders"));
  assert.deepEqual(r, { type: "result", id: "c1", ok: false, error: { code: "too_large", message: "Too big." } });
});

test("a handler throwing TypeError gives thunderbird_error with no stack in the message", async () => {
  HANDLERS.mail_folders = async () => {
    null.boom;
  };
  const r = await dispatch(call("mail_folders"));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "thunderbird_error");
  assert.doesNotMatch(r.error.message, /TypeError|null|boom|at |\.js/);
  assert.deepEqual(Object.keys(r.error).sort(), ["code", "message"]);
});

test("an object with an unknown code is not trusted", async () => {
  HANDLERS.mail_folders = async () => {
    throw { code: "weird", message: "secret subject line" };
  };
  const r = await dispatch(call("mail_folders"));
  assert.equal(r.error.code, "thunderbird_error");
  assert.doesNotMatch(r.error.message, /secret/);
});

test("policy runs before the handler", async () => {
  let ran = false;
  HANDLERS.mail_draft = async () => {
    ran = true;
  };
  assert.equal((await dispatch(call("mail_draft"))).error.code, "not_enabled");
  await save({ paused: true });
  const r = await dispatch(call("mail_draft"));
  assert.deepEqual(r.error, { code: "paused", message: "Paused by the user in Thunderbird" });
  assert.equal(ran, false);
});

test("an account given by name is resolved to its id", async () => {
  let seen;
  HANDLERS.mail_folders = async (args) => {
    seen = args.account;
    return {};
  };
  assert.equal((await dispatch(call("mail_folders", { account: "Work" }))).ok, true);
  assert.equal(seen, "a1");
  assert.equal((await dispatch(call("mail_folders", { account: "Nope" }))).error.code, "not_enabled");
});

test("each call appends exactly one log entry with no subject or body fields", async () => {
  HANDLERS.mail_read = async () => ({ subject: "Secret subject", text: "Secret body" });
  HANDLERS.mail_folders = async () => {
    throw new TypeError("x");
  };
  const id = encodeId("a1", "INBOX", "x@y");
  await dispatch(call("mail_read", { id, max_chars: 10 }));
  await dispatch(call("mail_folders", { account: "a1", folder: "INBOX" }));
  await dispatch(call("mail_bogus", { body: "Secret body", subject: "Secret subject" }));
  const entries = await list();
  assert.equal(entries.length, 3);
  for (const e of entries) {
    assert.deepEqual(Object.keys(e).sort(), ["client", "outcome", "targets", "time", "tool"]);
    assert.doesNotMatch(JSON.stringify(e), /Secret/);
    assert.equal(e.client, "test-client");
    assert.match(e.time, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(entries[0].targets, [id]);
  assert.equal(entries[0].outcome, "ok");
  assert.deepEqual(entries[1].targets, ["INBOX"]);
  assert.equal(entries[1].outcome, "thunderbird_error");
  assert.equal(entries[2].outcome, "invalid_argument");
});

test("the activity log is a ring of 500 and clearable", async () => {
  for (let i = 0; i < 503; i++) await append({ time: new Date().toISOString(), client: "c", tool: `t${i}`, targets: [], outcome: "ok", subject: "x" });
  const entries = await list();
  assert.equal(entries.length, 500);
  assert.equal(entries[0].tool, "t3");
  assert.equal(entries.at(-1).tool, "t502");
  assert.equal("subject" in entries[0], false);
  await clear();
  assert.deepEqual(await list(), []);
});

test("concurrent appends are not lost", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => append({ time: "t", client: "c", tool: `t${i}`, targets: [], outcome: "ok" })));
  assert.equal((await list()).length, 20);
});

test("paused is checked before the unknown-tool check and before any accounts lookup", async () => {
  await save({ paused: true });
  let looked = false;
  mock.messenger.accounts.list = async () => {
    looked = true;
    return [];
  };
  assert.equal((await dispatch(call("mail_bogus"))).error.code, "paused");
  assert.equal((await dispatch(call("mail_folders", { account: "Work" }))).error.code, "paused");
  assert.equal(looked, false);
});

test("non-object args are invalid_argument", async () => {
  HANDLERS.mail_accounts = async () => ({});
  assert.equal((await dispatch(call("mail_accounts", ["x"]))).error.code, "invalid_argument");
  assert.equal((await dispatch(call("mail_accounts", "x"))).error.code, "invalid_argument");
});

test("log targets keep only decodable ids, at most 20 of at most 200 characters", async () => {
  const good = encodeId("a1", "INBOX", "x@y");
  const ids = [good, "m1.!!", "Secret subject", ...Array.from({ length: 30 }, (_, i) => encodeId("a1", "INBOX", `n${i}@y`))];
  await dispatch(call("mail_mark", { ids, folder: "F".repeat(500) }));
  const [e] = await list();
  assert.equal(e.targets.length, 20);
  assert.equal(e.targets[0], good);
  assert.equal(e.targets[1], "<invalid>");
  assert.equal(e.targets[2], "<invalid>");
  assert.doesNotMatch(JSON.stringify(e), /Secret/);
  for (const t of e.targets) assert.ok(t.length <= 200);
  await clear();
  await dispatch(call("mail_folders", { account: "a1", folder: "F".repeat(500) }));
  assert.equal((await list())[0].targets[0].length, 200);
});

test("an argument sent as null counts as absent", async () => {
  // Some MCP clients send null for every optional argument they omit.
  let seen;
  HANDLERS.mail_search = async (args) => {
    seen = args;
    return { messages: [] };
  };
  const r = await dispatch(call("mail_search", { text: "invoice", account: null, folder: null, id: null, ids: null, limit: null }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen, { text: "invoice" });
  // A null inside a value is the handler's to judge; only top-level nulls go.
  await dispatch(call("mail_search", { tags: ["a", null] }));
  assert.deepEqual(seen, { tags: ["a", null] });
});
