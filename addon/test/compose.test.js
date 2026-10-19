/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { install, fetchFrom } from "./mocks/messenger.js";
import { dispatch } from "../src/rpc.js";
import { save } from "../src/settings.js";
import { encodeId, decodeId, clearIdCache } from "../src/ids.js";
import { isAllowed, COMPOSE, LOOKUP } from "../src/handlers/compose.js";

// Thunderbird's background page has DOMParser as a global.
globalThis.DOMParser = DOMParser;

const ACCOUNTS = [
  {
    id: "a1",
    name: "Work",
    type: "imap",
    identities: [
      { id: "id1", accountId: "a1", email: "me@allowed.com", name: "Me Myself" },
      { id: "id9", accountId: "a1", email: "alias@allowed.com", name: "Alias" },
    ],
    folders: ["INBOX", "Drafts", "Sent", "Private"],
    specialUse: { INBOX: ["inbox"], Drafts: ["drafts"], Sent: ["sent"] },
  },
  {
    id: "a2",
    name: "Home",
    type: "imap",
    identities: [{ id: "id2", accountId: "a2", email: "me@home.test", name: "Me" }],
    folders: ["INBOX", "Drafts"],
    specialUse: { INBOX: ["inbox"], Drafts: ["drafts"] },
  },
];

let mock;
beforeEach(async () => {
  clearIdCache();
  mock = install({ accounts: ACCOUNTS, granted: ["messages.send"] });
  globalThis.fetch = fetchFrom({});
  await save({
    accounts: { a1: true },
    groups: { compose: true },
    send: { enabled: true, allow: ["@allowed.com", "Boss@Partner.test"] },
    excludedFolders: [{ accountId: "a1", path: "Private" }],
  });
});

const call = (tool, args) => dispatch({ type: "call", id: "c1", tool, args, client: "test" });
const NOT_ALLOWED = (addr) => `Recipient not in the allowed list: ${addr}`;

function refusedNoSend(r, addr) {
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error.code, "refused");
  assert.equal(r.error.message, NOT_ALLOWED(addr));
  assert.equal(mock.calls.sendMessage.length, 0, "sendMessage must never be called");
}

const send = (extra) => call("mail_send", { to: ["a@allowed.com"], subject: "Hi", body: "Hello", ...extra });

// ---- isAllowed ----

test("isAllowed: exact address and domain entries, no suffix match", () => {
  const allow = ["@allowed.com", "partner.test", "Boss@Other.test"];
  assert.equal(isAllowed("a@allowed.com", allow), true);
  assert.equal(isAllowed("A@ALLOWED.COM", allow), true);
  assert.equal(isAllowed("x@partner.test", allow), true);
  assert.equal(isAllowed("boss@other.test", allow), true);
  assert.equal(isAllowed("someone@other.test", allow), false);
  assert.equal(isAllowed("a@allowed.com.evil.com", allow), false);
  assert.equal(isAllowed("a@sub.allowed.com", allow), false);
  assert.equal(isAllowed("a@evilallowed.com", allow), false);
  assert.equal(isAllowed("allowed.com", allow), false);
  assert.equal(isAllowed("@allowed.com", allow), false);
  assert.equal(isAllowed("a@", ["@", ""]), false);
  assert.equal(isAllowed("", allow), false);
  assert.equal(isAllowed("a@allowed.com", []), false);
});

// ---- Review Focus 5 ----

test("TestAllowlistDisplayNameTrick", async () => {
  refusedNoSend(await send({ to: ['"boss@allowed.com" <x@evil.com>'] }), "x@evil.com");
  refusedNoSend(await send({ to: ["boss@allowed.com <x@evil.com>"] }), "x@evil.com");
});

test("TestAllowlistSuffixDomain", async () => {
  refusedNoSend(await send({ to: ["a@allowed.com.evil.com"] }), "a@allowed.com.evil.com");
  refusedNoSend(await send({ to: ["a@sub.allowed.com"] }), "a@sub.allowed.com");
});

test("TestAllowlistCaseInsensitive", async () => {
  const r = await send({ to: ["A@ALLOWED.COM"], cc: ["boss@partner.TEST"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.content, { sent: true });
  assert.equal(mock.calls.sendMessage.length, 1);
  const [details, options] = mock.calls.sendMessage[0];
  assert.deepEqual(details.to, ["A@ALLOWED.COM"]);
  assert.deepEqual(details.cc, ["boss@partner.TEST"]);
  assert.deepEqual(options, { mode: "sendNow" });
});

test("TestAllowlistBccHidden", async () => {
  refusedNoSend(await send({ to: ["a@allowed.com"], bcc: ["x@evil.com"] }), "x@evil.com");
  refusedNoSend(await send({ to: ["a@allowed.com"], cc: ["Evil <y@evil.com>"] }), "y@evil.com");
});

test("TestAllowlistOneBadOfMany", async () => {
  refusedNoSend(await send({ to: ["a@allowed.com", "b@allowed.com", "c@evil.com", "d@allowed.com"] }), "c@evil.com");
  // several mailboxes in one entry are each checked
  refusedNoSend(await send({ to: ["a@allowed.com, z@evil.com"] }), "z@evil.com");
  refusedNoSend(await send({ to: ["a@allowed.com", "undisclosed"] }), "undisclosed");
});

test("TestAllowlistQuotedLocalPart: only plain dot-atom addresses pass (ruling R27)", async () => {
  for (const addr of ['"a@evil.com,b"@allowed.com', '"x@evil.com"@allowed.com', '"<x@evil.com>"@allowed.com', "a@b@allowed.com", "a@allowéd.com", "a..b@allowed.com", ".a@allowed.com", "a@allowed..com", "a b@allowed.com"]) {
    assert.equal(isAllowed(addr, ["@allowed.com", "allowéd.com", "a@b@allowed.com"]), false, addr);
  }
  assert.equal(isAllowed("o'brien+x@allowed.com", ["@allowed.com"]), false);
  assert.equal(isAllowed("a@xn--allowd-fya.com", ["@xn--allowd-fya.com"]), true);
  assert.equal(isAllowed("test@localhost", ["@localhost"]), true);

  await save({ send: { enabled: true, allow: ["@allowed.com", "allowéd.com"] } });
  refusedNoSend(await send({ to: ['"a@evil.com,b"@allowed.com'] }), '"a@evil.com,b"@allowed.com');
  refusedNoSend(await send({ to: ['"x@evil.com"@allowed.com'] }), '"x@evil.com"@allowed.com');
  refusedNoSend(await send({ to: ['Boss <"x@evil.com"@allowed.com>'] }), '"x@evil.com"@allowed.com');
  refusedNoSend(await send({ to: ['"<x@evil.com>"@allowed.com'] }), '"<x@evil.com>"@allowed.com');
  refusedNoSend(await send({ to: ["a@b@allowed.com"] }), "a@b@allowed.com");
  refusedNoSend(await send({ bcc: ["a@allowéd.com"] }), "a@allowéd.com");
  // a needlessly quoted plain local part is unquoted by the parser, as jsmime does
  const r = await send({ to: ['"plain"@allowed.com'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(mock.calls.sendMessage[0][0].to, ["plain@allowed.com"]);
});

test("TestAllowlistEncodedWords: only simple local parts pass (ruling R28)", async () => {
  const payloads = [
    "=?utf-8?q?x=40evil=2Ecom=2Cb?=@allowed.com",
    "=?utf-8?b?eA0KUkNQVCBUTzo8eUBldmlsLmNvbT4=?=@allowed.com",
    "=?utf-8?q?x?=.=?utf-8?q?=40evil=2Ecom?=@allowed.com",
    "a%evil.com@allowed.com",
    "a=b@allowed.com",
    "a?b@allowed.com",
    "o'brien@allowed.com",
    "a!b@allowed.com",
  ];
  for (const addr of payloads) {
    assert.equal(isAllowed(addr, ["@allowed.com"]), false, addr);
    refusedNoSend(await send({ to: [addr] }), addr);
  }
  const allow = ["@allowed.com", "@sub.allowed.com"];
  assert.equal(isAllowed("first.last+tag@allowed.com", allow), true);
  assert.equal(isAllowed("a-b_c@sub.allowed.com", allow), true);
  await save({ send: { enabled: true, allow } });
  const r = await send({ to: ["first.last+tag@allowed.com"], cc: ["a-b_c@sub.allowed.com"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(mock.calls.sendMessage[0][0].to, ["first.last+tag@allowed.com"]);
  assert.deepEqual(mock.calls.sendMessage[0][0].cc, ["a-b_c@sub.allowed.com"]);
});

test("mail_send refuses an address Thunderbird's RFC 2047 decoder changes", async () => {
  // A decoder that changes even a plain address must refuse it (defence in depth).
  mock.messenger.messengerUtilities.decodeMimeHeader = async (name, value) => [].concat(value).map((v) => v.replace("a@", "x@"));
  refusedNoSend(await send({ to: ["a@allowed.com"] }), "a@allowed.com");
});

test("mail_send sends the checked addresses only, from the default identity", async () => {
  const r = await send({ to: ['"Alice A" <alice@allowed.com>'], bcc: ["boss@partner.test"], subject: "Hi​ there\r\nBcc: x@evil.com", body: "Line <1>\n\nPara 2" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [d] = mock.calls.sendMessage[0];
  assert.equal(d.identityId, "id1");
  assert.deepEqual(d.to, ["alice@allowed.com"]);
  assert.deepEqual(d.cc, []);
  assert.deepEqual(d.bcc, ["boss@partner.test"]);
  assert.equal(d.subject, "Hi there Bcc: x@evil.com");
  assert.equal(d.body, "<p>Line &lt;1&gt;</p><p>Para 2</p>");
});

test("mail_send without the messages.send permission is refused", async () => {
  mock.revoke("messages.send");
  const r = await send({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "refused");
  assert.equal(mock.calls.sendMessage.length, 0);
});

test("mail_send needs to, subject and body", async () => {
  for (const args of [{ to: [] }, { to: "a@allowed.com" }, { subject: 3 }, { body: undefined }, { cc: [5] }]) {
    const r = await send(args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(r.error.code, "invalid_argument", JSON.stringify(args));
  }
  assert.equal(mock.calls.sendMessage.length, 0);
});

test("mail_send passes attachments as files", async () => {
  const r = await send({ attachments: [{ name: "a.txt", data: new TextEncoder().encode("abc") }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [d] = mock.calls.sendMessage[0];
  assert.equal(d.attachments.length, 1);
  assert.equal(d.attachments[0].name, "a.txt");
  assert.equal(await d.attachments[0].file.text(), "abc");
});

test("mail_send is off when direct send is off", async () => {
  await save({ send: { enabled: false, allow: ["@allowed.com"] } });
  const r = await send({});
  assert.equal(r.error.code, "not_enabled");
  assert.equal(mock.calls.sendMessage.length, 0);
});

// ---- mail_draft ----

function original(extra = {}) {
  const h = mock.addMessage("a1", "INBOX", {
    headerMessageId: "child-2@seed.test",
    author: "Bob Example <bob@example.test>",
    recipients: ["Me Myself <me@allowed.com>", "Carol <carol@example.test>"],
    ccList: ["Dave <dave@example.test>", "ALIAS@allowed.com"],
    subject: "Quarterly hosting review",
    date: new Date("2026-10-01T11:00:00Z"),
    body: "Thursday works for me.\n<b>Bob</b>",
    headers: { references: ["<root-1@seed.test>"], "reply-to": ["Bob Desk <desk@example.test>"] },
    ...extra,
  });
  return { num: h.id, id: encodeId("a1", "INBOX", h.headerMessageId) };
}

// parse splits an imported RFC 5322 message into unfolded headers and body.
function parse(raw) {
  const cut = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, cut).replace(/\r\n[ \t]/g, " ");
  const headers = {};
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: raw.slice(cut + 4), head };
}

const b64text = (s) => Buffer.from(s.replace(/\r\n/g, ""), "base64").toString("utf8");

test("TestDraftReplyThreading", async () => {
  const o = original();
  const r = await call("mail_draft", { kind: "reply_all", id: o.id, body: "Sounds good & see you.\n\nMe" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.saveMessage.length, 0);
  assert.equal(mock.calls.import.length, 1);
  const imp = mock.calls.import[0];
  assert.equal(imp.folderId, "a1:/Drafts");
  assert.deepEqual(imp.props, { read: true });
  const { headers: h, body } = parse(imp.raw);

  const mid = h["message-id"].replace(/^<|>$/g, "");
  assert.match(mid, /^[0-9a-f-]+@allowed\.com$/);
  assert.deepEqual(decodeId(r.content.draftId), { accountId: "a1", folderPath: "Drafts", headerMessageId: mid });
  assert.equal(h["in-reply-to"], "<child-2@seed.test>");
  assert.equal(h.references, "<root-1@seed.test> <child-2@seed.test>");
  assert.equal(h.subject, "Re: Quarterly hosting review");
  assert.equal(h.from, '"Me Myself" <me@allowed.com>');
  assert.equal(h.to, '"Bob Desk" <desk@example.test>');
  // reply-all: the original To and Cc without the account's own addresses
  assert.equal(h.cc, '"Carol" <carol@example.test>, "Dave" <dave@example.test>');
  assert.equal(h["x-identity-key"], "id1");
  assert.match(h["x-mozilla-draft-info"], /^internal\/draft; vcard=0;/);
  assert.match(h["x-mft-draft"], /^[0-9a-f-]{36}$/);
  assert.equal(h["mime-version"], "1.0");
  assert.match(h.date, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  assert.equal(h["content-type"], "text/html; charset=UTF-8");
  assert.equal(h["content-transfer-encoding"], "base64");

  const html = b64text(body);
  assert.match(html, /<p>Sounds good &amp; see you\.<\/p><p>Me<\/p>/);
  assert.match(html, /<div class="moz-cite-prefix">On .*, Bob Example &lt;bob@example\.test&gt; wrote:<br><\/div>/);
  assert.match(html, /<blockquote type="cite" cite="mid:child-2@seed\.test">Thursday works for me\.<br>&lt;b&gt;Bob&lt;\/b&gt;<\/blockquote>/);
  assert.ok(html.indexOf("Sounds good") < html.indexOf("moz-cite-prefix"));

  // the draft id resolves to the imported draft
  const read = await call("mail_read", { id: r.content.draftId });
  assert.equal(read.ok, true, JSON.stringify(read));
});

test("mail_draft reply goes to the author without Reply-To; given recipients replace the defaults", async () => {
  const o = original({ headers: { references: ["<root-1@seed.test>"] } });
  let r = await call("mail_draft", { kind: "reply", id: o.id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  let h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h.to, '"Bob Example" <bob@example.test>');
  assert.equal(h.cc, undefined);

  r = await call("mail_draft", { kind: "reply", id: o.id, to: ["other@example.test"], cc: ["c@example.test"], subject: "New subject", body: "x" });
  h = parse(mock.calls.import[1].raw).headers;
  assert.equal(h.to, "other@example.test");
  assert.equal(h.cc, "c@example.test");
  assert.equal(h.subject, "New subject");
});

test("mail_draft headers cannot be injected and non-ASCII is encoded", async () => {
  const o = original();
  const r = await call("mail_draft", {
    kind: "reply",
    id: o.id,
    subject: "Grüße\r\nBcc: x@evil.com",
    to: ["Zoë\r\nX-Evil: 1 <zoe@example.test>"],
    body: "ok",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { head, headers: h } = parse(mock.calls.import[0].raw);
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.doesNotMatch(head, /^X-Evil:/m);
  assert.equal(h.subject, `=?UTF-8?B?${Buffer.from("Grüße Bcc: x@evil.com").toString("base64")}?=`);
  assert.match(h.to, /^=\?UTF-8\?B\?/);
  assert.match(mock.calls.import[0].raw, /^[\x00-\x7f]*$/);
});

test("TestForwardIncludesOriginalAttachments", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
  const o = original({
    attachments: [
      { name: "invoice.pdf", partName: "1.2", contentType: "application/pdf", size: pdf.length, content: pdf },
      { name: "notes ü.txt", partName: "1.3", contentType: "text/plain", size: 5, content: "notes" },
    ],
  });
  const r = await call("mail_draft", {
    kind: "forward",
    id: o.id,
    to: ["carol@example.test"],
    body: "FYI",
    attachments: [{ name: "mine.bin", data: new Uint8Array([1, 2, 3]) }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const raw = mock.calls.import[0].raw;
  const { headers: h, body } = parse(raw);
  assert.equal(h.subject, "Fwd: Quarterly hosting review");
  assert.equal(h["in-reply-to"], undefined);
  assert.equal(h.to, "carol@example.test");
  const m = /^multipart\/mixed; boundary="([^"]+)"$/.exec(h["content-type"]);
  assert.ok(m, h["content-type"]);
  const parts = body.split(`--${m[1]}`).slice(1, -1).map((p) => parse(p.replace(/^\r\n/, "")));
  assert.equal(parts.length, 4);
  assert.match(b64text(parts[0].body), /<p>FYI<\/p>.*-------- Forwarded Message --------/s);
  assert.match(b64text(parts[0].body), /Thursday works for me\./);
  const byName = Object.fromEntries(parts.slice(1).map((p) => [p.headers["content-disposition"], p]));
  const pdfPart = byName['attachment; filename="invoice.pdf"'];
  assert.ok(pdfPart, Object.keys(byName).join(" | "));
  assert.equal(pdfPart.headers["content-type"], 'application/pdf; name="invoice.pdf"');
  assert.deepEqual([...Buffer.from(pdfPart.body.replace(/\r\n/g, ""), "base64")], [...pdf]);
  const txt = byName["attachment; filename*=UTF-8''notes%20%C3%BC.txt"];
  assert.ok(txt, Object.keys(byName).join(" | "));
  assert.equal(Buffer.from(txt.body.replace(/\r\n/g, ""), "base64").toString(), "notes");
  const mine = byName['attachment; filename="mine.bin"'];
  assert.deepEqual([...Buffer.from(mine.body.replace(/\r\n/g, ""), "base64")], [1, 2, 3]);
  assert.match(raw, /^[\x00-\x7f]*$/);
});

test("mail_draft forward without recipients, and an odd identity address, still saves", async () => {
  const o = original();
  mock.messenger.accounts.get = async () => ({ id: "a1", identities: [{ id: "id1", email: "me@exa mple\r\n.com>", name: "Me" }] });
  const r = await call("mail_draft", { kind: "forward", id: o.id, body: "FYI" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h.to, undefined);
  assert.match(h["message-id"], /^<[0-9a-f-]+@example\.com>$/);
});

test("mail_draft forward refuses attachments over 50 MiB in total", async () => {
  const o = original({ attachments: [{ name: "big.bin", partName: "1.2", contentType: "application/octet-stream", size: 50 * 1024 * 1024, content: "" }] });
  const r = await call("mail_draft", { kind: "forward", id: o.id, body: "x", attachments: [{ name: "a", data: new Uint8Array(10) }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "too_large");
  assert.equal(mock.calls.import.length, 0);
  assert.equal(mock.calls.getAttachmentFile.length, 0);
});

test("mail_draft new uses saveMessage and finds the draft by its X-MFT-Draft header", async () => {
  const r = await call("mail_draft", { kind: "new", to: ["x@example.test"], subject: "Plan​", body: "a\nb", attachments: [{ name: "f.txt", data: new TextEncoder().encode("hi") }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.import.length, 0);
  const [d, opts] = mock.calls.saveMessage[0];
  assert.deepEqual(opts, { mode: "draft" });
  assert.equal(d.identityId, "id1");
  assert.deepEqual(d.to, ["x@example.test"]);
  assert.equal(d.subject, "Plan");
  assert.equal(d.body, "<p>a<br>b</p>");
  assert.equal(d.attachments[0].name, "f.txt");
  assert.equal(await d.attachments[0].file.text(), "hi");
  const tag = d.customHeaders.find((c) => c.name === "X-MFT-Draft");
  assert.match(tag.value, /^[0-9a-f-]{36}$/);
  const saved = [...mock.store.values()].find((h) => h.folder.path === "Drafts");
  assert.deepEqual(decodeId(r.content.draftId), { accountId: "a1", folderPath: "Drafts", headerMessageId: saved.headerMessageId });
});

test("mail_draft new uses the header saveMessage returns", async () => {
  mock.behaviour.saveReturns = true;
  const r = await call("mail_draft", { kind: "new", body: "a" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(decodeId(r.content.draftId).folderPath, "Drafts");
  assert.equal(mock.calls.getFull.length, 0);
});

test("mail_draft new gives up the draft lookup after LOOKUP.maxMs (10 s) of the budget", async (t) => {
  assert.equal(LOOKUP.maxMs, 10_000);
  const max = LOOKUP.maxMs;
  LOOKUP.maxMs = 1500;
  t.after(() => {
    LOOKUP.maxMs = max;
  });
  mock.messenger.messages.saveMessage = async (details, options) => {
    mock.calls.saveMessage.push([details, options]);
    return { mode: "draft", messages: [] };
  };
  const t0 = Date.now();
  const r = await call("mail_draft", { kind: "new", body: "a" });
  const took = Date.now() - t0;
  assert.deepEqual(r.content, { draftId: null });
  // the 30 s call budget is not what ended the lookup
  assert.ok(took >= 500 && took < 3000, `took ${took} ms`);
});

test("mail_draft new normalises recipients", async () => {
  const r = await call("mail_draft", { kind: "new", to: ['Alice A <alice@example.test>, "Bob, B" <bob@example.test>'], cc: ["nobody-here"], body: "a" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [d] = mock.calls.saveMessage[0];
  assert.deepEqual(d.to, ['"Alice A" <alice@example.test>', '"Bob, B" <bob@example.test>']);
  assert.deepEqual(d.cc, ["nobody-here"]);
});

test("mail_draft new returns a null draftId when the draft does not show up in time", async () => {
  const budget = COMPOSE.budgetMs;
  COMPOSE.budgetMs = 1500;
  try {
    mock.messenger.messages.saveMessage = async (details, options) => {
      mock.calls.saveMessage.push([details, options]);
      return { mode: "draft", messages: [] };
    };
    const r = await call("mail_draft", { kind: "new", body: "a" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.content, { draftId: null });
  } finally {
    COMPOSE.budgetMs = budget;
  }
});

test("mail_draft checks kind, id and the Drafts folder", async () => {
  const o = original();
  for (const args of [{ body: "x" }, { kind: "bogus", body: "x" }, { kind: "reply", body: "x" }, { kind: "new", id: o.id, body: "x" }, { kind: "new" }]) {
    const r = await call("mail_draft", args);
    assert.equal(r.error && r.error.code, "invalid_argument", JSON.stringify(args));
  }
  await save({ excludedFolders: [{ accountId: "a1", path: "Drafts" }] });
  const r = await call("mail_draft", { kind: "new", body: "x" });
  assert.equal(r.error.code, "excluded");
  assert.equal(mock.calls.saveMessage.length + mock.calls.import.length, 0);
});

test("mail_draft is off when the compose group is off", async () => {
  await save({ groups: { compose: false } });
  const r = await call("mail_draft", { kind: "new", body: "x" });
  assert.equal(r.error.code, "not_enabled");
});

// ---- mail_compose ----

test("TestComposeOpensWindow", async () => {
  let r = await call("mail_compose", { kind: "new", to: ["x@example.test"], subject: "S", body: "Hello\nthere" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.content, { opened: true });
  const [fn, args] = mock.calls.compose[0];
  assert.equal(fn, "beginNew");
  assert.deepEqual(args[0], { identityId: "id1", to: ["x@example.test"], cc: [], bcc: [], subject: "S", body: "<p>Hello<br>there</p>" });

  const o = original();
  r = await call("mail_compose", { kind: "reply_all", id: o.id, body: "Yes" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const reply = mock.calls.compose.find(([f]) => f === "beginReply");
  assert.equal(reply[1][0], o.num);
  assert.equal(reply[1][1], "replyToAll");
  assert.deepEqual(reply[1][2], { identityId: "id1" });
  const set = mock.calls.compose.find(([f]) => f === "setComposeDetails");
  assert.match(set[1][1].body, /<body><p>Yes<\/p><div class="moz-cite-prefix">/);

  r = await call("mail_compose", { kind: "forward", id: o.id, to: ["y@example.test"], body: "FYI" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const fwd = mock.calls.compose.find(([f]) => f === "beginForward");
  assert.equal(fwd[1][1], "forwardInline");
  assert.deepEqual(fwd[1][2].to, ["y@example.test"]);

  assert.equal(mock.calls.sendMessage.length + mock.calls.saveMessage.length + mock.calls.import.length, 0);
});
