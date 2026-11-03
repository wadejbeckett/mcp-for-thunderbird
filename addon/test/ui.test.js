/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseHTML } from "linkedom";
import { install, fetchFrom } from "./mocks/messenger.js";
import { save, load, enabledTools, LEVELS } from "../src/settings.js";
import { append } from "../src/log.js";
import { HANDLERS } from "../src/rpc.js";
import { isAllowed } from "../src/handlers/compose.js";
import { levelToGroups, parseAllowlist, renderState, isAbsolutePath, RESTART_NOTE, isAllMail, allMailAccounts, describeEntry } from "../ui/logic.js";
import { initPopup } from "../ui/popup.js";
import { initOptions, broadFolder } from "../ui/options.js";
import { initSetup } from "../ui/setup.js";

globalThis.MFT_NO_AUTOSTART = true;
const { createBackground } = await import("../src/background.js");

const TOKEN = "ab".repeat(32);
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

let mock, bg, port, clipboard;

beforeEach(async () => {
  for (const k of Object.keys(HANDLERS)) delete HANDLERS[k];
  mock = install({
    accounts: [
      { id: "a1", name: "Work", type: "imap", folders: ["INBOX", "Private", "Private/Sub"] },
      { id: "a2", name: "Home", type: "imap", folders: ["INBOX"] },
    ],
    manifest: { version: "1.2.3", manifest_version: 3 },
  });
  globalThis.fetch = fetchFrom({});
  bg = createBackground();
  await bg.start();
  port = mock.lastPort();
  port.receive({ type: "welcome", protocol: 1, version: "1.2.3", port: 47110, ok: true });
  // The host answers token requests like the real one.
  const post = port.postMessage.bind(port);
  port.postMessage = (m) => {
    post(m);
    if (m.type === "token_request") queueMicrotask(() => port.receive({ type: "token", token: TOKEN, url: "http://127.0.0.1:47110/mcp" }));
  };
  clipboard = { text: null, writeText: async (t) => void (clipboard.text = t) };
});
afterEach(() => bg.stop());

const send = async (msg) => {
  const [handler] = mock.messenger.runtime.onMessage.listeners;
  const r = handler(msg, { id: mock.messenger.runtime.id, url: mock.messenger.runtime.getURL("ui/options.html") });
  if (r === undefined) throw new Error(`no route for ${msg.type}`);
  return r;
};

function page(file) {
  const { document, window } = parseHTML(readFileSync(new URL(`../ui/${file}`, import.meta.url), "utf8"));
  const $ = (id) => document.getElementById(id);
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const click = (el) => fire(el, "click");
  const tick = (el, on = true) => {
    el.checked = on;
    fire(el, "change");
  };
  return { document, window, $, fire, click, tick };
}

const boxes = (document, sel) => [...document.querySelectorAll(sel)];

// ---- pure logic ----

test("TestLevelToGroups", () => {
  assert.deepEqual(levelToGroups("read_only"), { read: true, organise: false, compose: false, contacts: false });
  assert.deepEqual(levelToGroups("read_organise"), { read: true, organise: true, compose: false, contacts: false });
  assert.deepEqual(levelToGroups("read_organise_draft"), { read: true, organise: true, compose: true, contacts: false });
  assert.deepEqual(levelToGroups("read_organise"), LEVELS.read_organise);
  assert.throws(() => levelToGroups("everything"), /Unknown level/);
  const g = levelToGroups("read_only");
  g.read = false;
  assert.equal(LEVELS.read_only.read, true, "the result is a copy");
});

test("TestParseAllowlistAccepts", () => {
  const r = parseAllowlist("Anna@Example.com\r\n\n  @Example.org \nexample.net\nanna@example.com\n");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries, ["anna@example.com", "@example.org", "example.net"]);
  assert.deepEqual(parseAllowlist(""), { entries: [], errors: [] });
});

test("TestParseAllowlistRejectsGarbage", () => {
  const bad = [
    '"a@evil.com,b"@allowed.com',
    "a b@x.com",
    "=?utf-8?q?x=40evil=2Ecom?=@allowed.com",
    "Name <a@x.com>",
    "<a@x.com>",
    "a@@x.com",
    "@",
    "@@x.com",
    ".a@x.com",
    "a.@x.com",
    "a..b@x.com",
    "a%b@x.com",
    "a,b@x.com",
    "a;b@x.com",
    "a@x.com,b@y.com",
    "a@-x.com",
    "a@x..com",
    "a@x.com.",
    "*.example.com",
    "exa mple.com",
    "http://example.com",
    "a@x_y.com",
    "@exa mple.com",
  ];
  for (const text of bad) {
    const r = parseAllowlist(text);
    assert.equal(r.entries.length, 0, `accepted ${text}`);
    assert.equal(r.errors.length, 1, `no error for ${text}`);
    assert.equal(r.errors[0].line, 1);
  }
  const mixed = parseAllowlist("ok@example.com\nbad entry\nexample.org");
  assert.deepEqual(mixed.entries, ["ok@example.com", "example.org"]);
  assert.deepEqual(mixed.errors.map((e) => e.line), [2]);
});

test("non-ASCII entries are refused with a hint to use punycode", () => {
  for (const text of ["anna@münchen.de", "@münchen.de", "münchen.de", "ännä@example.com"]) {
    const r = parseAllowlist(text);
    assert.equal(r.entries.length, 0, text);
    assert.match(r.errors[0].message, /punycode/i, text);
  }
  assert.deepEqual(parseAllowlist("anna@xn--mnchen-3ya.de").entries, ["anna@xn--mnchen-3ya.de"]);
});

test("every accepted entry behaves as written under isAllowed", () => {
  const { entries } = parseAllowlist("anna@example.com\n@example.org\nexample.net");
  assert.equal(isAllowed("anna@example.com", entries), true);
  assert.equal(isAllowed("bob@example.org", entries), true);
  assert.equal(isAllowed("bob@example.net", entries), true);
  assert.equal(isAllowed("bob@example.com", entries), false);
  assert.equal(isAllowed("bob@example.org.evil.com", entries), false);
});

test("the list is capped", () => {
  const many = Array.from({ length: 201 }, (_, i) => `u${i}@example.com`).join("\n");
  assert.equal(parseAllowlist(many).errors.length, 1);
});

test("TestRenderStateLabels", () => {
  assert.equal(renderState("connected").label, "Connected");
  assert.equal(renderState("paused").label, "Paused");
  assert.equal(renderState("not_connected").label, "Not connected");
  assert.equal(renderState("mismatch").label, "Update needed");
  assert.equal(renderState("host_error").label, "Host program problem");
  assert.equal(renderState("not_installed").label, "Host program not installed");
  assert.equal(renderState("anything else").label, "Not connected");
});

test("isAbsolutePath", () => {
  for (const p of ["/home/u/MCP", "C:\\Users\\u\\MCP", "c:/Users/u", "\\\\server\\share\\x"]) assert.equal(isAbsolutePath(p), true, p);
  for (const p of ["", "MCP", "./MCP", "~/MCP", "..\\x", "C:", "\\\\", "/a\0b"]) assert.equal(isAbsolutePath(p), false, p);
});

// ---- popup ----

test("popup shows the state line, the last 10 entries newest first, and the options link", async () => {
  for (let i = 0; i < 12; i++) {
    await append({ time: `2026-10-19T10:00:${String(i).padStart(2, "0")}Z`, client: `app${i}`, tool: "mail_read", targets: [], outcome: i === 11 ? "paused" : "ok" });
  }
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("state").textContent, "Connected");
  assert.ok(p.$("state").classList.contains("connected"));
  assert.equal(p.$("pause").textContent, "Pause");
  const rows = boxes(p.document, "#log li");
  assert.equal(rows.length, 10);
  assert.match(rows[0].textContent, /app11/);
  assert.match(rows[9].textContent, /app2/);
  assert.equal(p.$("log-empty").hidden, true);
  p.click(p.$("open-options"));
  await flush();
  assert.equal(mock.optionsOpened(), 1);
});

test("popup with no activity says so", async () => {
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("log-empty").hidden, false);
});

test("TestPauseTogglesSetting", async () => {
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  p.click(p.$("pause"));
  await flush();
  assert.equal((await load()).paused, true);
  assert.equal(p.$("state").textContent, "Paused");
  assert.equal(p.$("pause").textContent, "Resume");
  p.click(p.$("pause"));
  await flush();
  assert.equal((await load()).paused, false);
  assert.equal(p.$("state").textContent, "Connected");
  assert.equal(p.$("pause").textContent, "Pause");
});

test("popup says when the host is not connected and when an update is needed", async () => {
  port.drop();
  let p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("state").textContent, "Not connected");
  bg.stop();
  bg = createBackground();
  await bg.start();
  mock.lastPort().receive({ type: "welcome", protocol: 2, version: "9", port: 47110, ok: false, error: "protocol mismatch" });
  p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("state").textContent, "Update needed");
  bg.stop();
  bg = createBackground();
  await bg.start();
  mock.lastPort().receive({ type: "welcome", protocol: 1, version: "9", port: 0, ok: false, error: "No free port between 47110 and 47119" });
  p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("state").textContent, "Host program problem: No free port between 47110 and 47119");
});

// ---- options ----

async function options(settings) {
  if (settings) await save(settings);
  const p = page("options.html");
  await initOptions(p.document, { send, m: mock.messenger, clipboard, confirm: () => true });
  return p;
}

test("options show the saved settings", async () => {
  await mock.messenger.permissions.request({ permissions: ["messages.send"] });
  const p = await options({
    accounts: { a1: true },
    groups: { read: true, organise: false, compose: true, contacts: true },
    send: { enabled: true, allow: ["a@example.com", "@example.org"] },
    attachmentDir: "/home/u/MCP",
    excludedFolders: [{ accountId: "a1", path: "/Private" }],
  });
  const acct = boxes(p.document, "#accounts input");
  assert.deepEqual(acct.map((a) => [a.getAttribute("data-id"), a.checked]), [["a1", true], ["a2", false]]);
  assert.deepEqual(["read", "organise", "compose", "contacts"].map((g) => p.$(`group-${g}`).checked), [true, false, true, true]);
  assert.equal(p.$("send-enabled").checked, true);
  assert.equal(p.$("send-allow").value, "a@example.com\n@example.org");
  assert.equal(p.$("attachment-dir").value, "/home/u/MCP");
  assert.equal(p.$("state").textContent, "Connected");
});

test("excluded folders: listed per enabled account, saved through settings.save", async () => {
  const p = await options({ accounts: { a1: true } });
  let folders = boxes(p.document, "#excluded input");
  assert.deepEqual(folders.map((f) => f.getAttribute("data-path")), ["INBOX", "Private", "Private/Sub"]);
  assert.ok(folders.every((f) => f.getAttribute("data-account") === "a1"));
  p.tick(folders[1]);
  // enabling the second account lists its folders too
  p.tick(boxes(p.document, "#accounts input")[1]);
  await flush();
  folders = boxes(p.document, "#excluded input");
  assert.equal(folders.length, 4);
  assert.equal(folders[1].checked, true, "ticks survive a re-list");
  p.fire(p.$("form"), "submit");
  await flush();
  const s = await load();
  assert.deepEqual(s.excludedFolders, [{ accountId: "a1", path: "Private" }]);
  assert.deepEqual(s.accounts, { a1: true, a2: true });
});

test("an exclusion for a folder not shown is kept", async () => {
  const p = await options({ accounts: { a1: true }, excludedFolders: [{ accountId: "a2", path: "Old" }] });
  p.fire(p.$("form"), "submit");
  await flush();
  assert.deepEqual((await load()).excludedFolders, [{ accountId: "a2", path: "Old" }]);
});

test("turning on direct send asks for messages.send from the click itself", async () => {
  const p = await options({ accounts: { a1: true } });
  assert.deepEqual(mock.permissionRequests, []);
  p.tick(p.$("send-enabled"));
  // the request has been made by the time the handler returns control
  assert.deepEqual(mock.permissionRequests, [["messages.send"]]);
  await flush();
  assert.equal(p.$("send-enabled").checked, true);
});

test("direct send stays off when Thunderbird refuses the permission", async () => {
  mock.denyRequests();
  const p = await options({ accounts: { a1: true } });
  p.tick(p.$("send-enabled"));
  await flush();
  assert.equal(p.$("send-enabled").checked, false);
  assert.match(p.$("save-status").textContent, /not allowed|stays off/i);
  p.fire(p.$("form"), "submit");
  await flush();
  assert.equal((await load()).send.enabled, false);
});

test("saving direct send stores a lower-cased allowlist and offers mail_send", async () => {
  const p = await options({ accounts: { a1: true } });
  p.tick(p.$("send-enabled"));
  await flush();
  p.$("send-allow").value = "Boss@Example.com\n@Example.org";
  p.fire(p.$("form"), "submit");
  await flush();
  const s = await load();
  assert.deepEqual(s.send, { enabled: true, allow: ["boss@example.com", "@example.org"] });
  assert.ok(enabledTools(s).includes("mail_send"));
  assert.equal(p.$("restart-note").hidden, false);
  assert.equal(p.$("restart-note").textContent, RESTART_NOTE);
  assert.ok(mock.lastPort().sentOfType("tools").at(-1).tools.includes("mail_send"));
});

test("a bad allowlist is not saved and each problem is shown", async () => {
  const p = await options({ accounts: { a1: true } });
  p.$("send-allow").value = "ok@example.com\nName <x@y.com>\nmünchen.de";
  p.$("attachment-dir").value = "/home/u/new";
  p.fire(p.$("form"), "submit");
  await flush();
  const err = p.$("send-allow-error").textContent;
  assert.match(err, /Line 2/);
  assert.match(err, /Line 3/);
  assert.match(err, /punycode/i);
  const s = await load();
  assert.deepEqual(s.send.allow, []);
  assert.equal(s.attachmentDir, "", "nothing is saved while a field is wrong");
});

test("the attachment folder must be an absolute path", async () => {
  const p = await options({ accounts: { a1: true } });
  p.$("attachment-dir").value = "relative/folder";
  p.fire(p.$("form"), "submit");
  await flush();
  assert.match(p.$("attachment-dir-error").textContent, /full path/i);
  assert.equal((await load()).attachmentDir, "");
  p.$("attachment-dir").value = "  /home/u/MCP  ";
  p.fire(p.$("form"), "submit");
  await flush();
  assert.equal(p.$("attachment-dir-error").textContent, "");
  assert.equal((await load()).attachmentDir, "/home/u/MCP");
  assert.deepEqual(mock.lastPort().sentOfType("config").at(-1), { type: "config", attachmentDir: "/home/u/MCP" });
});

test("broadFolder refuses roots and home folders from the path as written", () => {
  const broad = [
    "/",
    "//",
    "/.",
    "/tmp/..",
    "/home",
    "/home/anna",
    "/home/anna/",
    "/home/anna/MCP/..",
    "/Users",
    "/Users/anna",
    "/users/anna",
    "/root",
    "/var/home",
    "/var/home/anna",
    "C:\\",
    "c:/",
    "C:\\..",
    "D:\\Data\\..\\..",
    "C:\\Users",
    "C:\\Users\\Anna",
    "c:/users/anna/",
    "C:\\Documents and Settings\\Anna",
    "\\\\server\\share",
    "\\\\server\\share\\",
    "\\\\server\\share\\x\\..",
  ];
  for (const p of broad) assert.equal(broadFolder(p), true, p);
  const fine = ["/home/anna/MCP", "/Users/anna/MCP-attachments", "/root/mcp", "/var/home/anna/MCP", "/srv/mcp", "/tmp", "/home\\anna", "C:\\Users\\Anna\\MCP", "D:\\MCP", "\\\\server\\share\\MCP"];
  for (const p of fine) assert.equal(broadFolder(p), false, p);
});

test("the attachment folder cannot be a root or a home folder", async () => {
  const p = await options({ accounts: { a1: true }, attachmentDir: "/home/u/MCP" });
  for (const dir of ["/", "C:\\", "/home/u", "C:\\Users\\U\\", "/Users/u/../u"]) {
    p.$("attachment-dir").value = dir;
    p.fire(p.$("form"), "submit");
    await flush();
    assert.match(p.$("attachment-dir-error").textContent, /not the top of a drive or of the file system, and not a home folder itself/, dir);
    assert.match(p.$("save-status").textContent, /Nothing was saved/, dir);
    assert.equal((await load()).attachmentDir, "/home/u/MCP", dir);
  }
});

test("ticking accounts quickly lists each folder once", async () => {
  const p = await options({ accounts: { a1: true } });
  const accts = boxes(p.document, "#accounts input");
  // several change events before any folder list has arrived
  p.tick(accts[1]);
  p.tick(accts[1], false);
  p.tick(accts[1]);
  p.fire(accts[0], "change");
  await flush();
  const paths = boxes(p.document, "#excluded input").map((f) => `${f.getAttribute("data-account")}:${f.getAttribute("data-path")}`);
  assert.deepEqual(paths, ["a1:INBOX", "a1:Private", "a1:Private/Sub", "a2:INBOX"]);
});

test("the restart note shows only when the tool set changed", async () => {
  const p = await options({ accounts: { a1: true } });
  assert.equal(p.$("restart-note").hidden, true);
  p.$("attachment-dir").value = "/home/u/MCP";
  p.fire(p.$("form"), "submit");
  await flush();
  assert.equal(p.$("restart-note").hidden, true);
  p.tick(p.$("group-compose"));
  p.fire(p.$("form"), "submit");
  await flush();
  assert.equal(p.$("restart-note").hidden, false);
  assert.equal((await load()).groups.compose, true);
});

test("setup copy for the draft level says direct sending needs the options", () => {
  const p = page("setup.html");
  const hint = p.document.querySelector('input[value="read_organise_draft"]').parentElement.querySelector(".hint");
  assert.equal(hint.textContent, "Also write drafts and open pre-filled messages for you to review. Nothing is sent without you unless you turn on direct sending in the options.");
});

test("TestTokenNeverPersisted", async () => {
  const p = await options({ accounts: { a1: true } });
  assert.equal(p.$("endpoint").textContent, "http://127.0.0.1:47110/mcp");
  p.click(p.$("copy-token"));
  await flush();
  assert.equal(clipboard.text, TOKEN, "the token goes to the clipboard");
  assert.match(p.$("connection-status").textContent, /copied/i);
  p.fire(p.$("form"), "submit");
  p.click(p.$("rotate"));
  await flush();
  assert.equal(mock.lastPort().sentOfType("rotate_token").length, 1);
  const stored = JSON.stringify([...mock.local.values()]);
  assert.equal(/[0-9a-f]{64}/i.test(stored), false, "no storage.local value holds a 64-hex string");
  assert.equal(p.document.documentElement.outerHTML.includes(TOKEN), false, "the page never shows the token");
});

test("copy token while not connected says so and copies nothing", async () => {
  port.drop();
  const p = await options({ accounts: { a1: true } });
  assert.equal(p.$("endpoint").textContent, "Not available yet");
  p.click(p.$("copy-token"));
  await flush();
  assert.equal(clipboard.text, null);
  assert.match(p.$("connection-status").textContent, /not connected/i);
});

test("rotate asks first and does nothing when declined", async () => {
  const p = page("options.html");
  await initOptions(p.document, { send, m: mock.messenger, clipboard, confirm: () => false });
  p.click(p.$("rotate"));
  await flush();
  assert.equal(mock.lastPort().sentOfType("rotate_token").length, 0);
});

test("options list the activity log and clear it", async () => {
  await append({ time: "2026-10-19T10:00:00Z", client: "claude-code", tool: "mail_search", targets: ["x"], outcome: "ok" });
  const p = await options();
  assert.equal(boxes(p.document, "#log li").length, 1);
  assert.match(p.document.querySelector("#log li").textContent, /claude-code/);
  p.click(p.$("clear-log"));
  await flush();
  assert.equal(boxes(p.document, "#log li").length, 0);
  assert.equal(p.$("log-empty").hidden, false);
});

test("the pause button on the options page pauses", async () => {
  const p = await options();
  p.click(p.$("pause"));
  await flush();
  assert.equal((await load()).paused, true);
  assert.equal(p.$("pause").textContent, "Resume");
  assert.equal(p.$("state").textContent, "Paused");
});

// ---- setup ----

async function setup() {
  const p = page("setup.html");
  await initSetup(p.document, { send, m: mock.messenger });
  return p;
}

const levelRadios = (p) => boxes(p.document, "#levels input");

test("setup starts with every account unticked and Read and organise chosen", async () => {
  const p = await setup();
  const acct = boxes(p.document, "#accounts input");
  assert.equal(acct.length, 2);
  assert.ok(acct.every((a) => a.checked === false));
  const chosen = levelRadios(p).filter((r) => r.checked);
  assert.deepEqual(chosen.map((r) => r.value), ["read_organise"]);
});

test("setup finish saves the accounts and level and marks setup done", async () => {
  const p = await setup();
  p.tick(boxes(p.document, "#accounts input")[0]);
  const draft = levelRadios(p).find((r) => r.value === "read_organise_draft");
  levelRadios(p).forEach((r) => (r.checked = false));
  p.tick(draft);
  p.click(p.$("finish"));
  await flush();
  const s = await load();
  assert.equal(s.setupDone, true);
  assert.deepEqual(s.accounts, { a1: true, a2: false });
  assert.deepEqual(s.groups, { read: true, organise: true, compose: true, contacts: false });
  assert.match(p.$("finish-status").textContent, /finished/i);
});

test("setup with no account ticked says what that means", async () => {
  const p = await setup();
  p.click(p.$("finish"));
  await flush();
  const s = await load();
  assert.equal(s.setupDone, true);
  assert.deepEqual(s.accounts, { a1: false, a2: false });
  assert.match(p.$("finish-status").textContent, /no account/i);
});

test("setup finds AI apps through the background and sets up the ticked ones", async () => {
  const p = await setup();
  p.click(p.$("detect"));
  await flush();
  const [det] = port.sentOfType("clients_detect");
  assert.ok(det);
  port.receive({
    type: "clients_result",
    req: det.req,
    clients: [
      { name: "claude-code", found: true, configured: false },
      { name: "codex", found: true, configured: true },
      { name: "cursor", found: false, configured: false },
    ],
  });
  await flush();
  const boxesNow = boxes(p.document, "#clients input");
  assert.deepEqual(boxesNow.map((b) => b.getAttribute("data-name")), ["claude-code", "codex"], "only found apps get a box");
  assert.deepEqual(boxesNow.map((b) => b.checked), [true, false], "apps already set up are not ticked");
  assert.match(p.$("clients").textContent, /Claude Code|claude-code/);
  p.click(p.$("configure"));
  await flush();
  const [conf] = port.sentOfType("clients_configure");
  assert.deepEqual(conf.clients, ["claude-code"]);
  port.receive({ type: "clients_result", req: conf.req, clients: [{ name: "claude-code", found: true, configured: false, error: "config file is read-only" }] });
  await flush();
  assert.match(p.$("clients-status").textContent, /claude-code/);
  assert.match(p.$("clients-status").textContent, /read-only/);
});

test("setup says so when no AI app is found, and when the host is not connected", async () => {
  let p = await setup();
  p.click(p.$("detect"));
  await flush();
  port.receive({ type: "clients_result", req: port.sentOfType("clients_detect")[0].req, clients: [] });
  await flush();
  assert.match(p.$("clients-status").textContent, /no ai apps/i);
  port.drop();
  p = await setup();
  p.click(p.$("detect"));
  await flush();
  assert.match(p.$("clients-status").textContent, /not connected/i);
});

// ---- packaging ----

test("manifest wires the options page and the toolbar popup", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.options_ui, { page: "ui/options.html", open_in_tab: true });
  assert.equal(manifest.action.default_popup, "ui/popup.html");
});

test("pages load nothing remote, run no inline script and name the product correctly", () => {
  const dir = new URL("../ui/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const text = readFileSync(new URL(f, dir), "utf8");
    assert.equal(/https?:\/\/(?!127\.0\.0\.1|mozilla\.org)/.test(text.replace(/<!--[\s\S]*?-->/g, "")), false, `${f} references a remote URL`);
    assert.equal(/Thunderbird MCP/.test(text), false, f);
    if (f.endsWith(".html")) {
      assert.equal(/<script(?![^>]*\bsrc=)/.test(text), false, `${f} has an inline script`);
      assert.equal(/\son[a-z]+=/i.test(text), false, `${f} has an inline handler`);
      assert.match(text, /prefers-color-scheme|ui\.css/);
    }
  }
  assert.match(readFileSync(new URL("ui.css", dir), "utf8"), /prefers-color-scheme: dark/);
});

// ---- Gmail labels (R34) ----

test("isAllMail spots Gmail's All Mail by path", () => {
  assert.equal(isAllMail({ path: "/[Gmail]/All Mail", specialUse: ["archives"] }), true);
  assert.equal(isAllMail({ path: "/Archive", specialUse: ["archives"] }), false);
  assert.equal(isAllMail({ path: "/[Gmail]/All Mail" }), true);
  assert.equal(isAllMail({ path: "[gmail]/all mail", specialUse: [] }), true);
  assert.equal(isAllMail({ path: "/[Google Mail]/All Mail" }), true);
  assert.equal(isAllMail({ path: "/INBOX", specialUse: ["inbox"] }), false);
  assert.equal(isAllMail({ path: "/Projects/All Mail" }), false);
  assert.equal(isAllMail(null), false);
  assert.deepEqual(
    allMailAccounts([
      { name: "Gmail", folders: [{ path: "/INBOX" }, { path: "/[Gmail]/All Mail", specialUse: ["archives"] }] },
      { name: "Work", folders: [{ path: "/INBOX" }] },
      { name: "Other Gmail", folders: [{ path: "/[Gmail]/All Mail" }] },
    ]),
    ["Gmail", "Other Gmail"],
  );
});

test("options warn about Gmail labels when an enabled account has All Mail", async () => {
  const gmail = { id: "g1", name: "Gmail", type: "imap" };
  const folders = {
    g1: [{ accountId: "g1", path: "/INBOX", specialUse: ["inbox"] }, { accountId: "g1", path: "/[Gmail]/All Mail", specialUse: ["archives"] }],
    a1: [{ accountId: "a1", path: "/INBOX", specialUse: ["inbox"] }],
  };
  const m = {
    ...mock.messenger,
    accounts: { list: async () => [gmail, { id: "a1", name: "Work", type: "imap" }] },
    folders: { query: async ({ accountId }) => folders[accountId] || [] },
  };
  await save({ accounts: { a1: true } });
  const p = page("options.html");
  await initOptions(p.document, { send, m, clipboard, confirm: () => true });
  assert.equal(p.$("gmail-note").hidden, true);
  p.tick(boxes(p.document, "#accounts input")[0]);
  await flush();
  assert.equal(p.$("gmail-note").hidden, false);
  assert.match(p.$("gmail-note").textContent, /Gmail: the same message also appears in All Mail, Important and Starred/);
  assert.match(p.$("gmail-note").textContent, /exclude those too/);
  p.tick(boxes(p.document, "#accounts input")[0], false);
  await flush();
  assert.equal(p.$("gmail-note").hidden, true);
});

// ---- reopening setup ----

test("options open the setup page again from the AI apps section", async () => {
  const p = await options({ accounts: { a1: true }, setupDone: true });
  assert.ok(p.$("open-setup"), "AI apps section has a setup button");
  p.click(p.$("open-setup"));
  await flush();
  assert.deepEqual(mock.tabs, [{ url: "moz-extension://test-uuid/ui/setup.html" }]);
});

test("a reopened setup shows the current choices and Finish keeps everything else", async () => {
  const before = await save({
    setupDone: true,
    accounts: { a1: true, gone: true },
    groups: { read: true, organise: false, compose: false, contacts: true },
    send: { enabled: true, allow: ["a@example.com"] },
    attachmentDir: "/home/u/MCP",
    excludedFolders: [{ accountId: "a1", path: "Private" }],
  });
  let p = await setup();
  assert.deepEqual(boxes(p.document, "#accounts input").map((a) => a.checked), [true, false]);
  assert.deepEqual(levelRadios(p).filter((r) => r.checked).map((r) => r.value), ["read_only"]);
  assert.equal(p.$("accounts-first").hidden, true);
  p.click(p.$("finish"));
  await flush();
  // An account shown unticked is recorded as off, which it already was.
  // The folders seen in the account with an exclusion are the
  // background's (exclusions.js).
  const after = await load();
  assert.deepEqual(after, { ...before, knownFolders: after.knownFolders, accounts: { ...before.accounts, a2: false } }, "Finish with no change changes nothing");

  p = await setup();
  p.tick(boxes(p.document, "#accounts input")[1]);
  levelRadios(p).forEach((r) => (r.checked = false));
  p.tick(levelRadios(p).find((r) => r.value === "read_organise"));
  p.click(p.$("finish"));
  await flush();
  const s = await load();
  assert.deepEqual(s.accounts, { a1: true, gone: true, a2: true });
  assert.deepEqual(s.groups, { read: true, organise: true, compose: false, contacts: true });
  assert.deepEqual(s.send, before.send);
  assert.deepEqual(s.excludedFolders, before.excludedFolders);
  assert.equal(s.attachmentDir, "/home/u/MCP");
});

test("a reopened setup leaves groups alone when they match no level", async () => {
  await save({ setupDone: true, accounts: { a1: true }, groups: { read: false, organise: true, compose: true, contacts: false } });
  const p = await setup();
  assert.deepEqual(levelRadios(p).filter((r) => r.checked), []);
  p.click(p.$("finish"));
  await flush();
  assert.deepEqual((await load()).groups, { read: false, organise: true, compose: true, contacts: false });
});

test("on Thunderbird 153 direct send can be turned on before messages.send is granted", async () => {
  // messages.sendMessage exists only once the optional permission is
  // granted, so it cannot tell whether this Thunderbird can send.
  assert.equal(typeof mock.messenger.messages.sendMessage, "undefined");
  const p = await options({ accounts: { a1: true }, groups: { read: true, organise: false, compose: true, contacts: false } });
  assert.equal(p.$("draft-unsupported").hidden, true);
  assert.equal(p.$("send-unsupported").hidden, true);
  assert.equal(p.$("send-enabled").disabled, false);
  p.tick(p.$("send-enabled"));
  assert.deepEqual(mock.permissionRequests, [["messages.send"]]);
  await flush();
  assert.equal(p.$("send-enabled").checked, true);
  p.$("send-allow").value = "a@example.com";
  p.fire(p.$("form"), "submit");
  await flush();
  assert.equal((await load()).send.enabled, true);
  assert.equal(port.sentOfType("tools").at(-1).tools.includes("mail_send"), true);
});

test("on Thunderbird 140 the options say why drafts open in a window and keep direct send off", async () => {
  let p = await options({ accounts: { a1: true } });
  assert.equal(p.$("draft-unsupported").hidden, true);
  assert.equal(p.$("send-unsupported").hidden, true);
  assert.equal(p.$("send-enabled").disabled, false);

  // What Thunderbird 140 ESR lacks (mocks/messenger.js, release 140).
  bg.stop();
  mock = install({ release: 140, accounts: [{ id: "a1", name: "Work", type: "imap", folders: ["INBOX"] }], manifest: { version: "1.2.3", manifest_version: 3 } });
  bg = createBackground();
  await bg.start();
  mock.lastPort().receive({ type: "welcome", protocol: 1, version: "1.2.3", port: 47110, ok: true });
  p = await options({ accounts: { a1: true }, send: { enabled: true, allow: ["a@example.com"] } });
  assert.match(p.$("send-unsupported").textContent, /Thunderbird 153 or later/);
  assert.equal(p.$("draft-unsupported").hidden, false);
  assert.match(p.$("draft-unsupported").textContent, /Thunderbird 153 or later/);
  assert.equal(p.$("send-unsupported").hidden, false);
  assert.equal(p.$("send-enabled").disabled, true);
  assert.equal(p.$("send-enabled").checked, false);
  p.fire(p.$("form"), "submit");
  await flush();
  assert.equal((await load()).send.enabled, false);
  assert.deepEqual(mock.permissionRequests, []);
});

test("the activity log names a not_supported refusal", () => {
  assert.equal(describeEntry({ time: "", client: "c", tool: "mail_draft", outcome: "not_supported" }).outcome, "Refused: needs a newer Thunderbird");
});

// ---- excluded folders that follow their folder, and new accounts ----

test("the excluded-folder picker leaves out saved searches, tag and unified folders", async () => {
  bg.stop();
  mock = install({
    accounts: [{ id: "a1", name: "Work", type: "imap", folders: ["INBOX", { path: "Search", isVirtual: true }, { path: "Tag", isTag: true }, { path: "All", isUnified: true }] }],
    manifest: { version: "1.2.3", manifest_version: 3 },
  });
  bg = createBackground();
  await bg.start();
  const p = await options({ accounts: { a1: true } });
  assert.deepEqual(boxes(p.document, "#excluded input").map((f) => f.getAttribute("data-path")), ["INBOX"]);
});

test("the options list a folder created while the page is open", async () => {
  const p = await options({ accounts: { a1: true } });
  mock.createFolder("a1", "Projects");
  await flush();
  assert.ok(boxes(p.document, "#excluded input").some((f) => f.getAttribute("data-path") === "Projects"));
  mock.deleteFolder("a1", "Projects");
  await flush();
  assert.ok(!boxes(p.document, "#excluded input").some((f) => f.getAttribute("data-path") === "Projects"));
});

test("a folder renamed while the options are open keeps its exclusion when the page is saved", async () => {
  const p = await options({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  mock.renameFolder("a1", "Private", "Secret");
  await bg.foldersIdle();
  await flush();
  const row = boxes(p.document, "#excluded input").find((f) => f.getAttribute("data-path") === "Secret");
  assert.equal(row.checked, true);
  p.fire(p.$("form"), "submit");
  await flush();
  assert.deepEqual((await load()).excludedFolders, [{ accountId: "a1", path: "Secret" }]);
  assert.equal(p.$("missing-note").hidden, true);
});

test("an excluded folder not found is listed and explained; saving shows the new folders to AI apps", async () => {
  await save({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  await bg.foldersIdle();
  // A rename in webmail: a new folder, then the old one goes.
  mock.createFolder("a1", "Hidden");
  mock.deleteFolder("a1", "Private");
  await bg.foldersIdle();
  const p = await options();
  const rows = boxes(p.document, "#excluded label").map((l) => l.textContent.trim());
  assert.ok(rows.includes("Work: Hidden (new: hidden from AI apps until you save)"), rows.join(" | "));
  assert.ok(rows.includes("Work: Private (not found in Thunderbird)"));
  assert.equal(p.$("missing-note").hidden, false);
  assert.match(p.$("missing-note").textContent, /renamed or moved outside Thunderbird/);
  // The user ticks the new name and saves.
  p.tick(boxes(p.document, "#excluded input").find((f) => f.getAttribute("data-path") === "Hidden"));
  p.fire(p.$("form"), "submit");
  await flush();
  const s = await load();
  assert.deepEqual(s.excludedFolders, [{ accountId: "a1", path: "Private" }, { accountId: "a1", path: "Hidden" }]);
  assert.deepEqual(s.knownFolders.a1, { INBOX: 0, Hidden: 0 }, "Private and its subfolder are gone");
  // Unticking the folder that was not found forgets it.
  p.tick(boxes(p.document, "#excluded input").find((f) => f.getAttribute("data-path") === "Private"), false);
  p.fire(p.$("form"), "submit");
  await flush();
  assert.deepEqual((await load()).excludedFolders, [{ accountId: "a1", path: "Hidden" }]);
  assert.equal(p.$("missing-note").hidden, true);
});

test("the options mark a new account as not enabled yet, also one added while the page is open", async () => {
  const p = await options({ setupDone: true, accounts: { a1: true } });
  const label = (id) => boxes(p.document, "#accounts input").find((b) => b.getAttribute("data-id") === id).parentElement.textContent;
  assert.match(label("a2"), /New account: not enabled yet/);
  assert.doesNotMatch(label("a1"), /New account/);
  mock.addAccount({ id: "a3", name: "Club", type: "imap", folders: ["INBOX"] });
  await flush();
  assert.match(label("a3"), /Club.*New account: not enabled yet/);
  p.fire(p.$("form"), "submit");
  await flush();
  assert.doesNotMatch(label("a3"), /New account/, "saved, now a known account");
  mock.removeAccount("a3");
  await flush();
  assert.equal(boxes(p.document, "#accounts input").length, 2);
});

test("unticking direct send gives the messages.send permission back", async () => {
  const p = await options({ accounts: { a1: true } });
  p.tick(p.$("send-enabled"));
  await flush();
  assert.equal(await mock.messenger.permissions.contains({ permissions: ["messages.send"] }), true);
  p.tick(p.$("send-enabled"), false);
  await flush();
  assert.deepEqual(mock.permissionRemovals, [["messages.send"]]);
  assert.equal(await mock.messenger.permissions.contains({ permissions: ["messages.send"] }), false);
});

test("direct send shows as off when its permission is gone, though the settings say on", async () => {
  // Given back in Thunderbird's add-ons manager, or by an untick never saved.
  const p = await options({ accounts: { a1: true }, send: { enabled: true, allow: ["a@example.com"] } });
  assert.equal(p.$("send-enabled").checked, false);
});

test("unticking direct send and leaving without saving keeps sending off", async () => {
  await mock.messenger.permissions.request({ permissions: ["messages.send"] });
  let p = await options({ accounts: { a1: true }, send: { enabled: true, allow: ["a@example.com"] } });
  assert.equal(p.$("send-enabled").checked, true);
  p.tick(p.$("send-enabled"), false);
  await flush();
  assert.equal((await load()).send.enabled, false, "stored at once");
  assert.deepEqual((await load()).send.allow, ["a@example.com"]);
  // The page is opened again without a save.
  p = await options();
  assert.equal(p.$("send-enabled").checked, false);
});

test("a rename the background followed is kept when the page is saved, also one the page did not see", async () => {
  const p = await options({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  // Thunderbird renamed the folder before the page listened: the page saw
  // no event, the background moved the exclusion.
  mock.renameFolder("a1", "Private", "Secret", { quiet: true });
  await save({ excludedFolders: [{ accountId: "a1", path: "Secret" }] });
  await flush();
  p.tick(boxes(p.document, "#excluded input").find((f) => f.getAttribute("data-path") === "INBOX"));
  p.fire(p.$("form"), "submit");
  await flush();
  assert.deepEqual((await load()).excludedFolders, [{ accountId: "a1", path: "Secret" }, { accountId: "a1", path: "INBOX" }]);
});

test("the options save merges into the stored exclusions instead of replacing them", async () => {
  const p = await options({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  // A change the page never heard of: no storage event reaches it.
  const listeners = mock.messenger.storage.onChanged.listeners.splice(0);
  await save({ excludedFolders: [{ accountId: "a1", path: "Secret" }] });
  mock.messenger.storage.onChanged.listeners.push(...listeners);
  p.fire(p.$("form"), "submit");
  await flush();
  assert.deepEqual((await load()).excludedFolders, [{ accountId: "a1", path: "Secret" }]);
});

test("a folder event that comes while the options are loading is not missed", async () => {
  await save({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  const p = page("options.html");
  const loading = initOptions(p.document, { send, m: mock.messenger, clipboard, confirm: () => true });
  mock.createFolder("a1", "Projects");
  await loading;
  await flush();
  assert.ok(boxes(p.document, "#excluded input").some((f) => f.getAttribute("data-path") === "Projects"));
});

test("a new folder is labelled hidden until the save, and stays hidden until then", async () => {
  const p = await options({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  await bg.foldersIdle();
  mock.createFolder("a1", "Projects");
  await bg.foldersIdle();
  await flush();
  const label = () => boxes(p.document, "#excluded label").map((l) => l.textContent.trim()).find((t) => t.startsWith("Work: Projects"));
  assert.equal(label(), "Work: Projects (new: hidden from AI apps until you save)");
  assert.equal(p.$("missing-note").hidden, true, "no exclusion is missing");
  assert.match(p.document.querySelector("#excluded").parentElement.textContent, /until you save this page/);
  p.fire(p.$("form"), "submit");
  await flush();
  await bg.foldersIdle();
  assert.equal(label(), "Work: Projects");
  assert.equal((await load()).knownFolders.a1.Projects, 0);
});

test("the popup names a new folder hidden from AI apps", async () => {
  await save({ accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  await bg.foldersIdle();
  mock.createFolder("a1", "Projects");
  await bg.foldersIdle();
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  const notes = boxes(p.document, "#notes li").map((li) => li.textContent);
  assert.match(notes[0], /^New folder hidden from AI apps: Work: Projects\./);
});

test("the popup says when the host program could not be started", async () => {
  // The host that said welcome stops; then twice the program does not
  // start (the reconnects come at once, then after 1 s).
  port.drop("host exited");
  for (let i = 0; i < 2; i++) {
    const before = mock.lastPort();
    while (mock.lastPort() === before) await new Promise((r) => setTimeout(r, 50));
    mock.lastPort().drop("An unexpected error occurred");
    await flush();
  }
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("state").textContent, "Host program could not be started");
});

test("the popup names excluded folders not found and accounts not enabled yet", async () => {
  await save({ setupDone: true, accounts: { a1: true }, excludedFolders: [{ accountId: "a1", path: "Private" }] });
  await bg.foldersIdle();
  mock.deleteFolder("a1", "Private");
  await bg.foldersIdle();
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  const notes = boxes(p.document, "#notes li").map((li) => li.textContent);
  assert.equal(p.$("notes").hidden, false);
  assert.match(notes[0], /^Excluded folder not found: Work: Private\./);
  assert.match(notes[1], /^Not enabled yet: Home\./);
});

test("the popup and pages say when the host program is not installed", async () => {
  port.drop("No such native application mcp_for_thunderbird");
  await flush();
  const p = page("popup.html");
  await initPopup(p.document, { send, m: mock.messenger });
  assert.equal(p.$("state").textContent, "Host program not installed");
});
