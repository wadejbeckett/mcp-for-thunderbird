/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { install, fetchFrom, COMPOSE_NEW_BODY } from "./mocks/messenger.js";
import { dispatch, HANDLERS } from "../src/rpc.js";
import { load, save } from "../src/settings.js";
import { encodeId, decodeId, clearIdCache } from "../src/ids.js";
import { isAllowed, baseName, insertAtTop, textToHtml, cleanHtml, COMPOSE, LOOKUP } from "../src/handlers/compose.js";

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
  // No body goes to beginNew (it would replace the document and lose the
  // signature); the text is put at the top of the open window instead.
  assert.deepEqual(args[0], { identityId: "id1", to: ["x@example.test"], cc: [], bcc: [], subject: "S" });
  // The text is inserted at the top of the open document, which keeps the
  // signature's elements (and its remote images) as Thunderbird loaded
  // them; the body is never set anew.
  assert.equal(composeCalls("setComposeDetails"), 0);
  const ins = mock.calls.compose.find(([f]) => f === "executeScript");
  assert.deepEqual(ins[1][0].target, { tabId: 101 });
  assert.equal(ins[1][0].func, insertAtTop);
  assert.deepEqual(ins[1][0].args, ["<p>Hello<br>there</p>"]);
  const doc = new DOMParser().parseFromString(`<html><head></head><body>${COMPOSE_NEW_BODY}</body></html>`, "text/html");
  const sig = doc.querySelector(".moz-signature");
  inDocument(doc, () => insertAtTop(ins[1][0].args[0]));
  assert.equal(doc.body.innerHTML, `<p>Hello<br>there</p>${COMPOSE_NEW_BODY}`);
  assert.equal(doc.querySelector(".moz-signature"), sig);

  const o = original();
  r = await call("mail_compose", { kind: "reply_all", id: o.id, body: "Yes" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const reply = mock.calls.compose.find(([f]) => f === "beginReply");
  assert.equal(reply[1][0], o.num);
  assert.equal(reply[1][1], "replyToAll");
  assert.deepEqual(reply[1][2], { identityId: "id1" });
  const replyAt = mock.calls.compose.findIndex(([f]) => f === "beginReply");
  const set = mock.calls.compose.slice(replyAt).find(([f]) => f === "executeScript");
  assert.deepEqual(set[1][0].args, ["<p>Yes</p>"]);

  r = await call("mail_compose", { kind: "forward", id: o.id, to: ["y@example.test"], body: "FYI" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const fwd = mock.calls.compose.find(([f]) => f === "beginForward");
  assert.equal(fwd[1][1], "forwardInline");
  assert.deepEqual(fwd[1][2].to, ["y@example.test"]);

  assert.equal(mock.calls.sendMessage.length + mock.calls.saveMessage.length + mock.calls.import.length, 0);
});

// inDocument runs fn with doc as the global document, as a script that
// executeScript puts in a compose window sees it.
function inDocument(doc, fn) {
  const had = Object.hasOwn(globalThis, "document");
  const before = globalThis.document;
  globalThis.document = doc;
  try {
    fn();
  } finally {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  }
}

test("mail_compose puts the text above a plain-text window's signature", async () => {
  mock.messenger.compose.getComposeDetails = async () => ({ isPlainText: true, plainTextBody: "-- \nMe Myself" });
  const r = await call("mail_compose", { kind: "new", body: "Hello" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const set = mock.calls.compose.find(([f]) => f === "setComposeDetails");
  assert.deepEqual(set[1][1], { plainTextBody: "Hello\n\n-- \nMe Myself" });
  assert.equal(composeCalls("executeScript"), 0);
});

// composeDirect calls the handler itself, so the test sees the error the
// handler throws, mayHaveCompleted included.
async function composeDirect(args) {
  try {
    await HANDLERS.mail_compose(args, { client: "test", settings: await load(), tool: "mail_compose" });
  } catch (e) {
    return e;
  }
  assert.fail("mail_compose did not fail");
}

const composeCalls = (name) => mock.calls.compose.filter(([f]) => f === name).length;

test("mail_compose: a failure after the window opened says so and may have completed", async () => {
  const o = original();
  const cases = [
    ["getComposeDetails rejects", () => (mock.messenger.compose.getComposeDetails = async () => Promise.reject(new Error("gone"))), /could not put the text in it/],
    ["executeScript rejects", () => (mock.messenger.scripting.executeScript = async () => Promise.reject(new Error("gone"))), /could not put the text in it/],
    ["getComposeDetails never answers", () => (mock.messenger.compose.getComposeDetails = () => new Promise(() => {})), /did not answer in time; the compose window is open, but the text may not be in it/],
    ["executeScript never answers", () => (mock.messenger.scripting.executeScript = () => new Promise(() => {})), /did not answer in time; the compose window is open, but the text may not be in it/],
  ];
  const budget = COMPOSE.budgetMs;
  COMPOSE.budgetMs = 300;
  try {
    const working = { ...mock.messenger.compose };
    const workingScripting = { ...mock.messenger.scripting };
    for (const [what, breakIt, message] of cases) {
      for (const args of [{ kind: "new", body: "Hi" }, { kind: "reply", id: o.id, body: "Hi" }]) {
        Object.assign(mock.messenger.compose, working);
        Object.assign(mock.messenger.scripting, workingScripting);
        mock.calls.compose.length = 0;
        breakIt();
        const e = await composeDirect(args);
        assert.equal(e.code, "thunderbird_error", what);
        assert.match(e.message, message, what);
        assert.equal(e.mayHaveCompleted, true, what);
        // the window was opened once and is not opened again
        assert.equal(composeCalls("beginNew") + composeCalls("beginReply"), 1, what);
        // through dispatch the client is told the same
        mock.calls.compose.length = 0;
        const r = await call("mail_compose", args);
        assert.equal(r.ok, false);
        assert.match(r.error.message, message, what);
      }
    }
  } finally {
    COMPOSE.budgetMs = budget;
  }
});

test("mail_compose fails when Thunderbird opens the window without reporting its tab", async () => {
  for (const ret of [undefined, null, {}, { windowId: 3 }]) {
    mock.messenger.compose.beginNew = async (...args) => {
      mock.calls.compose.push(["beginNew", args]);
      return ret;
    };
    const e = await composeDirect({ kind: "new", body: "Hi" });
    assert.equal(e.code, "thunderbird_error", JSON.stringify(ret));
    assert.match(e.message, /^The compose window opened, but Thunderbird did not report the window it opened, so the text was not put in it\./);
    assert.equal(e.mayHaveCompleted, true);
  }
  assert.equal(composeCalls("setComposeDetails") + composeCalls("executeScript"), 0);
});

test("mail_compose: a timeout of the call that opens the window may have completed", async () => {
  const budget = COMPOSE.budgetMs;
  COMPOSE.budgetMs = 300;
  try {
    mock.messenger.compose.beginNew = () => new Promise(() => {});
    const e = await composeDirect({ kind: "new", body: "Hi" });
    assert.equal(e.code, "thunderbird_error");
    assert.match(e.message, /the compose window may have opened/);
    assert.equal(e.mayHaveCompleted, true);
  } finally {
    COMPOSE.budgetMs = budget;
  }
});

// spendBudgetIn makes the mock method obj[name] answer and then move the
// clock past the call's budget, so the next Thunderbird call finds the
// budget spent before it starts. It returns a function that undoes both.
function spendBudgetIn(obj, name) {
  const real = obj[name];
  const now = Date.now;
  obj[name] = async (...args) => {
    const v = await real(...args);
    const at = now() + COMPOSE.budgetMs + 1000;
    Date.now = () => at;
    return v;
  };
  return () => {
    obj[name] = real;
    Date.now = now;
  };
}

test("mail_compose with the budget spent before the window is asked for opens nothing and says so", async () => {
  const o = original();
  for (const args of [{ kind: "new", body: "Hi" }, { kind: "reply", id: o.id, body: "Hi" }]) {
    mock.calls.compose.length = 0;
    const undo = spendBudgetIn(mock.messenger.accounts, "get");
    let e;
    try {
      e = await composeDirect(args);
    } finally {
      undo();
    }
    assert.equal(e.code, "thunderbird_error", args.kind);
    assert.doesNotMatch(e.message, /may have opened/, args.kind);
    assert.notEqual(e.mayHaveCompleted, true, args.kind);
    assert.equal(mock.calls.compose.length, 0, args.kind);
  }
});

test("mail_send with the budget spent before the send sends nothing and says so", async () => {
  await save({ send: { enabled: true, allow: ["@allowed.com"] } });
  const undo = spendBudgetIn(mock.messenger.accounts, "get");
  let e;
  try {
    await HANDLERS.mail_send({ to: ["a@allowed.com"], subject: "s", body: "b" }, { client: "test", settings: await load(), tool: "mail_send" });
  } catch (err) {
    e = err;
  } finally {
    undo();
  }
  assert.ok(e, "mail_send did not fail");
  assert.equal(e.code, "thunderbird_error");
  assert.doesNotMatch(e.message, /may have been sent/);
  assert.notEqual(e.mayHaveCompleted, true);
  assert.equal(mock.calls.sendMessage.length, 0);
});

// ---- attachment names ----

test("baseName cuts long names on code points and keeps the extension", () => {
  const emoji = "\u{1F600}"; // two UTF-16 units
  const long = "ab" + emoji.repeat(300) + ".pdf";
  const n = baseName(long);
  assert.equal([...n].length, 255);
  assert.ok(n.endsWith(emoji + ".pdf"), n.slice(-10));
  assert.doesNotThrow(() => encodeURIComponent(n));
  // a cut at 255 UTF-16 units would have split a pair
  assert.throws(() => encodeURIComponent(long.slice(0, 255)));
  // no extension, or one too long to be one: a plain cut
  assert.equal(baseName("x".repeat(300)), "x".repeat(255));
  assert.equal(baseName("x".repeat(280) + "." + "y".repeat(40)), "x".repeat(255));
  // path segments go and short names stay; a lone surrogate becomes U+FFFD
  assert.equal(baseName("C:\\dir/sub\\report.pdf"), "report.pdf");
  assert.equal(baseName("a\ud800b.txt"), "a\ufffdb.txt");
  assert.equal(baseName("dir/"), "attachment");
});

test("mail_draft forward with a long non-ASCII attachment name saves", async () => {
  const o = original();
  const name = "\u{1F600}".repeat(200) + ".txt";
  const r = await call("mail_draft", { kind: "forward", id: o.id, to: ["c@example.test"], body: "FYI", attachments: [{ name, data: new Uint8Array([1]) }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const raw = mock.calls.import[0].raw;
  assert.match(raw, /filename\*=UTF-8''(%F0%9F%98%80)+\.txt/);
});

// ---- recipients of replies and forwards ----

test("mail_draft reply, reply_all and forward refuse a recipient that is not an address", async () => {
  const o = original();
  for (const kind of ["reply", "reply_all", "forward"]) {
    for (const k of ["to", "cc", "bcc"]) {
      const r = await call("mail_draft", { kind, id: o.id, [k]: ["good@example.test", "Nobody <>"], body: "x" });
      assert.equal(r.ok, false, `${kind} ${k}`);
      assert.equal(r.error.code, "invalid_argument", `${kind} ${k}`);
      assert.equal(r.error.message, `Not an address in ${k}: Nobody <>`, `${kind} ${k}`);
    }
  }
  assert.equal(mock.calls.import.length, 0);
});

// ---- lists in the body ----

test("textToHtml turns '- ' and '* ' paragraphs into a bulleted list", () => {
  assert.equal(textToHtml("Prices:\n\n- Basic R99\n* Pro R199\n\nThanks"), "<p>Prices:</p><ul><li>Basic R99</li><li>Pro R199</li></ul><p>Thanks</p>");
  // a trailing line break or blank line around the list changes nothing
  assert.equal(textToHtml("\n- a\n- b\n"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(textToHtml("- a\r\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("textToHtml turns '1. ' paragraphs into a numbered list, starting at the first number", () => {
  assert.equal(textToHtml("1. One\n2. Two\n10. Ten"), "<ol><li>One</li><li>Two</li><li>Ten</li></ol>");
  assert.equal(textToHtml("3. Three\n4. Four"), '<ol start="3"><li>Three</li><li>Four</li></ol>');
});

test("textToHtml joins an indented line to the item above it", () => {
  assert.equal(textToHtml("- First item\n  wraps here\n- Second\n\tand tab"), "<ul><li>First item<br>wraps here</li><li>Second<br>and tab</li></ul>");
  assert.equal(textToHtml("1. Step\n   more\n2. Next"), "<ol><li>Step<br>more</li><li>Next</li></ol>");
});

test("textToHtml keeps a paragraph as text unless every line is a list line", () => {
  // a lead-in line in the same paragraph, a mixed list, or a marker
  // without its space leaves the paragraph as typed
  assert.equal(textToHtml("Prices:\n- Basic\n- Pro"), "<p>Prices:<br>- Basic<br>- Pro</p>");
  assert.equal(textToHtml("- a\nb"), "<p>- a<br>b</p>");
  assert.equal(textToHtml("- a\n1. b"), "<p>- a<br>1. b</p>");
  assert.equal(textToHtml("1. a\n- b"), "<p>1. a<br>- b</p>");
  assert.equal(textToHtml("-5 degrees\n*bold*"), "<p>-5 degrees<br>*bold*</p>");
  assert.equal(textToHtml("2026. A year"), '<ol start="2026"><li>A year</li></ol>');
  assert.equal(textToHtml("1.5 litres"), "<p>1.5 litres</p>");
  assert.equal(textToHtml(" - indented first line"), "<p> - indented first line</p>");
});

test("textToHtml escapes list items and strips invisible characters from them", () => {
  assert.equal(textToHtml('- <b>x</b> & "y"\n  <i>z</i>'), "<ul><li>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;<br>&lt;i&gt;z&lt;/i&gt;</li></ul>");
  assert.equal(textToHtml("- a​b\n- ‮c"), "<ul><li>ab</li><li>c</li></ul>");
  // an invisible character cannot hide a list marker or forge one
  assert.equal(textToHtml("​- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("mail_compose and mail_draft send a list body as HTML lists", async () => {
  let r = await call("mail_compose", { kind: "new", to: ["x@example.test"], subject: "S", body: "Hi\n\n- one\n- two" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ins = mock.calls.compose.find(([f]) => f === "executeScript");
  assert.deepEqual(ins[1][0].args, ["<p>Hi</p><ul><li>one</li><li>two</li></ul>"]);

  r = await call("mail_draft", { kind: "new", to: ["x@example.test"], subject: "S", body: "1. a\n2. b" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.saveMessage[0][0].body, "<ol><li>a</li><li>b</li></ol>");
});

// ---- HTML bodies ----

const TABLE = ' border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; border: 1px solid #999999; margin: 0 0 1em 0;"';
const TH = ' style="border: 1px solid #999999; padding: 6px 10px; text-align: left; font-weight: bold;"';
const TD = ' style="border: 1px solid #999999; padding: 6px 10px; text-align: left;"';

test("cleanHtml keeps the allowed elements and gives tables a border and padding", () => {
  assert.equal(
    cleanHtml("<p>Hi <strong>A</strong> <em>b</em><br>c</p><ul><li>one</li></ul><ol start=\"3\"><li>x</li></ol>"),
    '<p>Hi <strong>A</strong> <em>b</em><br>c</p><ul><li>one</li></ul><ol start="3"><li>x</li></ol>',
  );
  assert.equal(
    cleanHtml("<table><thead><tr><th>Mailbox</th><th>Size</th></tr></thead><tbody><tr><td colspan=2>a@b 2 GB</td></tr></tbody></table>"),
    `<table${TABLE}><thead><tr><th${TH}>Mailbox</th><th${TH}>Size</th></tr></thead><tbody><tr><td${TD} colspan="2">a@b 2 GB</td></tr></tbody></table>`,
  );
  assert.equal(cleanHtml("<b>x</b><i>y</i>"), "<strong>x</strong><em>y</em>");
});

test("cleanHtml drops scripts, styles, images, unknown elements and attributes", () => {
  assert.equal(cleanHtml('<script>alert(1)</script><style>p{}</style><img src="https://x/y.png"><p>t</p>'), "<p>t</p>");
  assert.equal(cleanHtml('<div class="x"><span style="color:red" onclick="z()">kept</span></div>'), "kept");
  assert.equal(cleanHtml('<p style="display:none" id="a">p</p>'), "<p>p</p>");
  assert.equal(cleanHtml("<ol start=\"x\"><li>a</li></ol>"), "<ol><li>a</li></ol>");
  assert.equal(cleanHtml('<table><tbody><tr><td colspan="1 onclick">b</td></tr></tbody></table>'), `<table${TABLE}><tbody><tr><td${TD}>b</td></tr></tbody></table>`);
});

test("cleanHtml keeps only http, https and mailto links", () => {
  assert.equal(cleanHtml('<a href="https://noiz.co.za/?a=1&b=2">s</a>'), '<a href="https://noiz.co.za/?a=1&amp;b=2">s</a>');
  assert.equal(cleanHtml('<a href="mailto:info@noiz.co.za">m</a>'), '<a href="mailto:info@noiz.co.za">m</a>');
  assert.equal(cleanHtml('<a href="javascript:alert(1)">j</a><a href=" data:text/html,x">d</a><a>n</a>'), "<a>j</a><a>d</a><a>n</a>");
});

test("cleanHtml escapes text again and strips invisible characters", () => {
  assert.equal(cleanHtml("<p>a &lt;b&gt; &amp; \"c\"</p>"), "<p>a &lt;b&gt; &amp; &quot;c&quot;</p>");
  assert.equal(cleanHtml("<p>a\u200bb\u202ec</p>"), "<p>abc</p>");
  assert.equal(cleanHtml("plain 1 < 2 &amp; 3"), "plain 1 &lt; 2 &amp; 3");
});

test("mail_compose, mail_draft and mail_send take an HTML body with html: true", async () => {
  const body = "<p>Hi</p><table><tbody><tr><td>a</td></tr></tbody></table><script>x()</script>";
  const want = `<p>Hi</p><table${TABLE}><tbody><tr><td${TD}>a</td></tr></tbody></table>`;
  let r = await call("mail_compose", { kind: "new", to: ["x@example.test"], subject: "S", body, html: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ins = mock.calls.compose.find(([f]) => f === "executeScript");
  assert.deepEqual(ins[1][0].args, [want]);

  r = await call("mail_draft", { kind: "new", to: ["x@example.test"], subject: "S", body, html: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(mock.calls.saveMessage[0][0].body, /^<p>Hi<\/p><table border="1"/);
  assert.doesNotMatch(mock.calls.saveMessage[0][0].body, /script/);

  // without html the same body is text, escaped
  r = await call("mail_compose", { kind: "new", to: ["x@example.test"], subject: "S", body: "<p>Hi</p>" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ins2 = mock.calls.compose.filter(([f]) => f === "executeScript").at(-1);
  assert.deepEqual(ins2[1][0].args, ["<p>&lt;p&gt;Hi&lt;/p&gt;</p>"]);

  r = await call("mail_compose", { kind: "new", to: ["x@example.test"], subject: "S", body, html: "yes" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid_argument");
});

test("mail_compose reply with html: true puts the HTML above the quote", async () => {
  const o = original();
  const r = await call("mail_compose", { kind: "reply", id: o.id, body: "<ul><li>one</li></ul>", html: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(mock.calls.compose.find(([f]) => f === "beginReply"));
  const ins = mock.calls.compose.find(([f]) => f === "executeScript");
  assert.deepEqual(ins[1][0].args, ["<ul><li>one</li></ul>"]);
});

test("mail_draft reply with html: true imports the HTML above the quote", async () => {
  const o = original();
  const r = await call("mail_draft", { kind: "reply", id: o.id, body: "<p>Hi</p><table><tbody><tr><td>a</td></tr></tbody></table>", html: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { body: b } = parse(mock.calls.import[0].raw);
  const html = Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8");
  assert.match(html, /<body><p>Hi<\/p><table border="1"[^>]*>.*<td style="border: 1px solid #999999;[^>]*>a<\/td>.*<blockquote type="cite"/);
});

// ---- long runs of white space and deep nesting ----

test("mail_draft reply quotes an original with a long run of spaces in linear time", async () => {
  const o = original({ body: "a" + " ".repeat(300000) + "b" });
  const t0 = performance.now();
  const r = await call("mail_draft", { kind: "reply", id: o.id, body: "x" });
  const ms = performance.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(ms < 5000, `took ${ms} ms`);
  const html = b64text(parse(mock.calls.import[0].raw).body);
  assert.ok(html.includes(">a" + " ".repeat(300000) + "b</blockquote>"));
});

test("textToHtml handles a long run of tabs in linear time, and trims a list's trailing white space", () => {
  const body = "a" + "\t".repeat(160000) + "b";
  const t0 = performance.now();
  const html = textToHtml(body);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.equal(html, `<p>${body}</p>`);
  assert.equal(textToHtml("- a\n- b \t "), "<ul><li>a</li><li>b</li></ul>");
});

test("cleanHtml keeps the text of 10,000 nested elements without overflowing the stack", () => {
  const n = 10000;
  assert.equal(cleanHtml("<div>".repeat(n) + "x" + "</div>".repeat(n)), "x");
  assert.equal(cleanHtml("<p>" + "<span><b>".repeat(n / 2) + "x" + "</b></span>".repeat(n / 2) + "</p>"), "<p>" + "<strong>".repeat(n / 2) + "x" + "</strong>".repeat(n / 2) + "</p>");
});
