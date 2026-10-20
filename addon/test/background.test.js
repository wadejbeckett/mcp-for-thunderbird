/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { install, fetchFrom } from "./mocks/messenger.js";
import { save, load } from "../src/settings.js";
import { HANDLERS } from "../src/rpc.js";

globalThis.MFT_NO_AUTOSTART = true;
const { createBackground, BACKOFF_SECONDS } = await import("../src/background.js");

let mock, timers, bg;
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const fakeTimers = () => {
  const list = [];
  return {
    list,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false, fired: false };
      list.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    pending: () => list.filter((t) => !t.cleared && !t.fired),
    fire() {
      const t = list.find((x) => !x.cleared && !x.fired);
      t.fired = true;
      t.fn();
      return t.ms;
    },
  };
};

beforeEach(async () => {
  for (const k of Object.keys(HANDLERS)) delete HANDLERS[k];
  mock = install({
    accounts: [{ id: "a1", name: "Work", type: "imap", folders: ["INBOX"] }],
    manifest: { version: "1.2.3", manifest_version: 3 },
  });
  globalThis.fetch = fetchFrom({});
  timers = fakeTimers();
  await save({ accounts: { a1: true }, attachmentDir: "/home/u/MCP" });
  bg = createBackground({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
});
afterEach(() => bg.stop());

const welcome = (port, extra = {}) => port.receive({ type: "welcome", protocol: 1, version: "1.2.3", port: 47110, ok: true, ...extra });

test("hello carries protocol 1, version, instance, enabled tools and attachmentDir", async () => {
  await bg.start();
  const port = mock.lastPort();
  assert.equal(port.name, "mcp_for_thunderbird");
  const [hello] = port.sentOfType("hello");
  const s = await load();
  assert.deepEqual(hello, {
    type: "hello",
    protocol: 1,
    version: "1.2.3",
    instance: s.instance,
    tools: ["mail_accounts", "mail_folders", "mail_search", "mail_read", "mail_thread", "mail_attachment", "mail_filter_suggest", "mail_mark", "mail_tag", "mail_move", "mail_archive", "mail_trash"],
    attachmentDir: "/home/u/MCP",
  });
});

test("mail_send is offered only while the messages.send permission is granted", async () => {
  await save({ send: { enabled: true, allow: ["x@y.test"] } });
  await bg.start();
  const port = mock.lastPort();
  assert.equal(port.sentOfType("hello")[0].tools.includes("mail_send"), false);
  mock.grant("messages.send");
  await flush();
  assert.equal(port.sentOfType("tools").at(-1).tools.at(-1), "mail_send");
  mock.revoke("messages.send");
  await flush();
  assert.equal(port.sentOfType("tools").at(-1).tools.includes("mail_send"), false);
});

test("reconnect backoff: immediate, then 1, 2, 4 ... capped at 25 s (R17), reset by a welcome", async () => {
  assert.deepEqual(BACKOFF_SECONDS, [0, 1, 2, 4, 8, 16, 25]);
  await bg.start();
  const delays = [];
  for (let i = 0; i < 10; i++) {
    mock.lastPort().drop();
    await flush();
    assert.equal(timers.pending().length, 1);
    delays.push(timers.fire());
    await flush();
  }
  assert.deepEqual(delays, [0, 1000, 2000, 4000, 8000, 16000, 25000, 25000, 25000, 25000]);
  assert.equal(mock.ports.length, 11);

  welcome(mock.lastPort());
  await flush();
  mock.lastPort().drop();
  await flush();
  assert.equal(timers.fire(), 0);
});

test("tools are re-sent when settings change in storage", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  await save({ groups: { compose: true } });
  await flush();
  const t = port.sentOfType("tools").at(-1);
  assert.ok(t.tools.includes("mail_draft"));
  await save({ attachmentDir: "/elsewhere" });
  await flush();
  assert.deepEqual(port.sentOfType("config").at(-1), { type: "config", attachmentDir: "/elsewhere" });
});

test("blobs are reassembled into call.args.attachments[i].data and freed after the call", async () => {
  await save({ groups: { compose: true } });
  let got;
  HANDLERS.mail_draft = async (args) => {
    got = args.attachments;
    return { ok: 1 };
  };
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  await flush();

  const one = Buffer.from("hello, ");
  const two = Buffer.from([0, 1, 2, 255]);
  const three = Buffer.from("second file");
  port.receive({ type: "blob", blob: "b1", seq: 0, last: false, data: one.toString("base64") });
  port.receive({ type: "blob", blob: "b2", seq: 0, last: true, data: three.toString("base64") });
  port.receive({ type: "blob", blob: "b1", seq: 1, last: true, data: two.toString("base64") });
  assert.equal(bg.blobCount(), 2);
  port.receive({
    type: "call",
    id: "c9",
    tool: "mail_draft",
    client: "cli",
    blobs: ["b1", "b2"],
    args: { kind: "new", body: "x", attachments: [{ name: "b.txt", blob: 1 }, { name: "a.bin", blob: 0 }] },
  });
  await flush();
  assert.deepEqual(port.sentOfType("result").at(-1), { type: "result", id: "c9", ok: true, content: { ok: 1 } });
  assert.equal(got.length, 2);
  assert.deepEqual(Object.keys(got[0]).sort(), ["data", "name"]);
  assert.equal(got[0].name, "b.txt");
  assert.ok(got[0].data instanceof Uint8Array);
  assert.equal(Buffer.from(got[0].data).toString(), "second file");
  assert.deepEqual([...got[1].data], [...one, ...two]);
  assert.equal(bg.blobCount(), 0);
});

test("a call naming a missing blob is invalid_argument and frees its blobs", async () => {
  await save({ groups: { compose: true } });
  HANDLERS.mail_draft = async () => ({});
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  port.receive({ type: "blob", blob: "b1", seq: 0, last: false, data: "AA==" });
  port.receive({ type: "call", id: "c1", tool: "mail_draft", client: "x", blobs: ["b1"], args: { kind: "new", body: "x", attachments: [{ name: "a", blob: 0 }] } });
  port.receive({ type: "call", id: "c2", tool: "mail_draft", client: "x", args: { kind: "new", body: "x", attachments: [{ name: "a", blob: 3 }] } });
  await flush();
  const results = port.sentOfType("result");
  assert.equal(results.find((r) => r.id === "c1").error.code, "invalid_argument");
  assert.equal(results.find((r) => r.id === "c2").error.code, "invalid_argument");
  assert.equal(bg.blobCount(), 0);
});

test("toolbar shows connected, paused, not connected and mismatch", async () => {
  await bg.start();
  await flush();
  assert.equal(bg.state(), "not_connected");
  assert.equal(mock.actionState.title, "MCP for Thunderbird: not connected");
  const port = mock.lastPort();
  welcome(port);
  await flush();
  assert.equal(bg.state(), "connected");
  assert.equal(mock.actionState.title, "MCP for Thunderbird: connected");
  assert.equal(mock.actionState.badgeText, "");
  await save({ paused: true });
  await flush();
  assert.equal(bg.state(), "paused");
  assert.equal(mock.actionState.title, "MCP for Thunderbird: paused");
  await save({ paused: false });
  await flush();
  assert.equal(bg.state(), "connected");
  port.drop();
  await flush();
  assert.equal(bg.state(), "not_connected");
  assert.equal(mock.actionState.badgeText, "!");
});

test("a welcome with another protocol shows Update needed, keeps the port and refuses calls", async () => {
  HANDLERS.mail_accounts = async () => ({});
  await bg.start();
  const port = mock.lastPort();
  welcome(port, { protocol: 2, ok: false, error: "protocol mismatch" });
  await flush();
  assert.equal(bg.state(), "mismatch");
  assert.equal(mock.actionState.title, "Update needed");
  assert.equal(port.disconnected, false);
  assert.equal(timers.pending().length, 0);
  port.receive({ type: "call", id: "c1", tool: "mail_accounts", client: "x", args: {} });
  await flush();
  assert.equal(port.sentOfType("result")[0].error.code, "refused");
});

test("first install opens the setup page; updates do not", async () => {
  await bg.start();
  mock.messenger.runtime.onInstalled.fire({ reason: "update" });
  await flush();
  assert.equal(mock.tabs.length, 0);
  mock.messenger.runtime.onInstalled.fire({ reason: "install" });
  await flush();
  assert.deepEqual(mock.tabs, [{ url: "moz-extension://test-uuid/ui/setup.html" }]);
});

test("requestToken resolves with the host's token reply", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  const p = bg.requestToken();
  await flush();
  assert.equal(port.sentOfType("token_request").length, 1);
  port.receive({ type: "token", token: "t".repeat(64), url: "http://127.0.0.1:47110/mcp" });
  assert.deepEqual(await p, { token: "t".repeat(64), url: "http://127.0.0.1:47110/mcp" });
  assert.equal(JSON.stringify([...mock.local.values()]).includes("tttt"), false);
});

test("detectClients and configureClients match replies by req", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  const d = bg.detectClients();
  const c = bg.configureClients(["claude-code"]);
  await flush();
  const [det] = port.sentOfType("clients_detect");
  const [conf] = port.sentOfType("clients_configure");
  assert.deepEqual(conf.clients, ["claude-code"]);
  assert.notEqual(det.req, conf.req);
  port.receive({ type: "clients_result", req: conf.req, clients: [{ name: "claude-code", found: true, configured: true }] });
  port.receive({ type: "clients_result", req: det.req, clients: [{ name: "codex", found: false, configured: false }] });
  assert.equal((await c)[0].name, "claude-code");
  assert.equal((await d)[0].name, "codex");
});

test("UI requests through runtime messaging, and pending requests fail on disconnect", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const me = { id: mock.messenger.runtime.id, url: mock.messenger.runtime.getURL("ui/popup.html") };
  const p = handler({ type: "requestToken" }, me);
  await flush();
  port.drop();
  await assert.rejects(p, /not connected/i);
  const st = await handler({ type: "getState" }, me);
  assert.equal(st.state, "not_connected");
  assert.equal(st.paused, false);
});

test("message router: getState, setPaused, log and unknown types", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const me = { id: mock.messenger.runtime.id, url: mock.messenger.runtime.getURL("ui/options.html") };
  assert.deepEqual(await handler({ type: "getState" }, me), { state: "connected", paused: false });
  assert.deepEqual(await handler({ type: "setPaused", paused: true }, me), { paused: true });
  assert.equal((await load()).paused, true);
  assert.deepEqual(await handler({ type: "getState" }, me), { state: "paused", paused: true });
  await handler({ type: "setPaused", paused: false }, me);
  assert.equal((await load()).paused, false);
  await assert.rejects(handler({ type: "setPaused", paused: "yes" }, me), /true or false/);

  const { append } = await import("../src/log.js");
  for (let i = 0; i < 15; i++) await append({ time: `2026-10-19T10:00:${String(i).padStart(2, "0")}Z`, client: "c", tool: "mail_read", targets: [], outcome: "ok" });
  const last = await handler({ type: "listLog", limit: 10 }, me);
  assert.equal(last.length, 10);
  assert.equal(last[0].time, "2026-10-19T10:00:14Z", "newest first");
  assert.equal((await handler({ type: "listLog" }, me)).length, 15);
  await handler({ type: "clearLog" }, me);
  assert.deepEqual(await handler({ type: "listLog" }, me), []);

  assert.equal(handler({ type: "nope" }, me), undefined);
  assert.equal(handler({ type: "getState" }, { id: "other@addon" }), undefined, "other senders are ignored");
});

test("message router fails closed on a missing or foreign sender", async () => {
  await bg.start();
  welcome(mock.lastPort());
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const rt = mock.messenger.runtime;
  const msg = { type: "getState" };
  assert.equal(handler(msg), undefined, "no sender");
  assert.equal(handler(msg, null), undefined, "null sender");
  assert.equal(handler(msg, {}), undefined, "sender without an id");
  assert.equal(handler(msg, { id: rt.id }), undefined, "sender without a url");
  assert.equal(handler(msg, { id: rt.id, url: "https://evil.test/ui/options.html" }), undefined, "web page url");
  assert.equal(handler(msg, { id: rt.id, url: "moz-extension://other-uuid/ui/options.html" }), undefined, "another extension's url");
  assert.equal(handler(msg, { id: "other@addon", url: rt.getURL("ui/options.html") }), undefined, "another id");
  assert.deepEqual(await handler(msg, { id: rt.id, url: rt.getURL("ui/popup.html") }), { state: "connected", paused: false });
});

test("message router: rotateToken, detectClients, configureClients and getEndpoint", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port);
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const me = { id: mock.messenger.runtime.id, url: mock.messenger.runtime.getURL("ui/options.html") };
  assert.equal(await handler({ type: "rotateToken" }, me), true);
  assert.equal(port.sentOfType("rotate_token").length, 1);

  const d = handler({ type: "detectClients" }, me);
  const c = handler({ type: "configureClients", clients: ["claude-code"] }, me);
  await flush();
  const [det] = port.sentOfType("clients_detect");
  const [conf] = port.sentOfType("clients_configure");
  assert.deepEqual(conf.clients, ["claude-code"]);
  port.receive({ type: "clients_result", req: det.req, clients: [{ name: "codex", found: false, configured: false }] });
  port.receive({ type: "clients_result", req: conf.req, clients: [{ name: "claude-code", found: true, configured: true }] });
  assert.equal((await d)[0].name, "codex");
  assert.equal((await c)[0].configured, true);

  assert.deepEqual(await handler({ type: "getEndpoint" }, me), { url: "http://127.0.0.1:47110/mcp" }, "the endpoint reply never carries the token");
  assert.equal(port.sentOfType("token_request").length, 0, "getEndpoint never asks the host for the token");
});

test("getEndpoint comes from the welcome port and fails while not connected", async () => {
  await bg.start();
  const port = mock.lastPort();
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const me = { id: mock.messenger.runtime.id, url: mock.messenger.runtime.getURL("ui/options.html") };
  await assert.rejects(handler({ type: "getEndpoint" }, me), /not connected/);
  welcome(port, { port: 47113 });
  assert.deepEqual(await handler({ type: "getEndpoint" }, me), { url: "http://127.0.0.1:47113/mcp" });
  port.drop();
  await flush();
  await assert.rejects(handler({ type: "getEndpoint" }, me), /not connected/);
  assert.equal(port.sentOfType("token_request").length, 0);
});

test("a refused call during a mismatch still frees its blobs", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port, { protocol: 2, ok: false, error: "protocol mismatch" });
  port.receive({ type: "blob", blob: "b1", seq: 0, last: true, data: "AA==" });
  port.receive({ type: "call", id: "c1", tool: "mail_draft", client: "x", blobs: ["b1"], args: { attachments: [{ name: "a", blob: 0 }] } });
  await flush();
  assert.equal(port.sentOfType("result")[0].error.code, "refused");
  assert.equal(bg.blobCount(), 0);
});

test("hello is always the first message on a new port", async () => {
  const local = mock.messenger.storage.local;
  const realGet = local.get;
  let release;
  const gate = new Promise((r) => (release = r));
  local.get = async (k) => {
    await gate;
    return realGet(k);
  };
  const started = bg.start();
  await flush();
  const port = mock.lastPort();
  // load() is serialised behind the gated call, so read storage directly.
  const s = (await realGet("settings")).settings;
  mock.messenger.storage.onChanged.fire({ settings: { oldValue: s, newValue: { ...s, groups: { ...s.groups, compose: true } } } }, "local");
  await flush();
  release();
  await started;
  await flush();
  assert.equal(port.sent[0].type, "hello");
});

test("calls before a welcome ok:true are refused with Not connected yet", async () => {
  HANDLERS.mail_accounts = async () => ({ ran: true });
  await bg.start();
  const port = mock.lastPort();
  port.receive({ type: "call", id: "c0", tool: "mail_accounts", client: "x", args: {} });
  await flush();
  assert.deepEqual(port.sentOfType("result")[0].error, { code: "refused", message: "Not connected yet" });
  welcome(port);
  port.receive({ type: "call", id: "c1", tool: "mail_accounts", client: "x", args: {} });
  await flush();
  assert.equal(port.sentOfType("result")[1].ok, true);
});

test("Update needed survives the host closing; only a matching welcome clears it", async () => {
  await bg.start();
  let port = mock.lastPort();
  welcome(port, { protocol: 2, ok: false, error: "protocol mismatch" });
  await flush();
  port.drop(); // an older host exits after the mismatch
  await flush();
  assert.equal(bg.state(), "mismatch");
  assert.equal(mock.actionState.title, "Update needed");
  timers.fire();
  await flush();
  port = mock.lastPort();
  assert.equal(bg.state(), "mismatch");
  welcome(port);
  await flush();
  assert.equal(bg.state(), "connected");
});

test("a host failure on the same protocol is not Update needed", async () => {
  HANDLERS.mail_accounts = async () => ({});
  await bg.start();
  const port = mock.lastPort();
  welcome(port, { ok: false, port: 0, error: "No free port between 47110 and 47119" });
  await flush();
  assert.equal(bg.state(), "host_error");
  assert.equal(mock.actionState.title, "MCP for Thunderbird: No free port between 47110 and 47119");
  assert.equal(mock.actionState.badgeText, "!");
  port.receive({ type: "call", id: "c1", tool: "mail_accounts", client: "x", args: {} });
  await flush();
  assert.equal(port.sentOfType("result")[0].error.code, "refused");
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const me = { id: mock.messenger.runtime.id, url: mock.messenger.runtime.getURL("ui/options.html") };
  assert.deepEqual(await handler({ type: "getState" }, me), { state: "host_error", paused: false, error: "No free port between 47110 and 47119" });
  // The host exits after such a welcome; the add-on keeps the reason and
  // tries again with backoff.
  port.drop();
  await flush();
  assert.equal(bg.state(), "host_error");
  assert.equal(timers.pending().length, 1);
  timers.fire();
  await flush();
  welcome(mock.lastPort());
  await flush();
  assert.equal(bg.state(), "connected");
});

test("a host error message is kept short and printable", async () => {
  await bg.start();
  welcome(mock.lastPort(), { ok: false, port: 0, error: `bad\u0000\n${"x".repeat(500)}` });
  await flush();
  assert.equal(bg.state(), "host_error");
  assert.ok(mock.actionState.title.length <= 21 + 120, mock.actionState.title);
  assert.equal(/[\u0000-\u001f]/.test(mock.actionState.title), false);
});

test("token and app requests are refused while an update is needed", async () => {
  await bg.start();
  const port = mock.lastPort();
  welcome(port, { protocol: 2, ok: false, error: "protocol mismatch" });
  await flush();
  await assert.rejects(bg.requestToken(), /updating/);
  await assert.rejects(bg.detectClients(), /updating/);
  assert.equal(port.sentOfType("token_request").length, 0);
  assert.equal(port.sentOfType("clients_detect").length, 0);
});
