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
import { isAllowed, baseName, insertAtTop, textToHtml, cleanHtml, asMessage, listPost, COMPOSE, OFFLINE } from "../src/handlers/compose.js";

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

// drafted is the i-th imported draft: its headers and its HTML body (the
// first part of a multipart message).
function drafted(i) {
  const { headers, body } = parse(mock.calls.import[i].raw);
  const m = /boundary="([^"]+)"/.exec(headers["content-type"] || "");
  const first = m ? parse(body.split(`--${m[1]}`)[1].replace(/^\r\n/, "")).body : body;
  return { headers, html: b64text(first) };
}

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
  mock.messenger.accounts.list = async () => [{ id: "a1", type: "imap", identities: [{ id: "id1", email: "me@exa mple\r\n.com>", name: "Me" }] }];
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

test("mail_draft new imports the draft into the account's Drafts folder", async () => {
  const r = await call("mail_draft", { kind: "new", to: ["x@example.test"], subject: "Plan\u200b", body: "a\nb", attachments: [{ name: "f.txt", data: new TextEncoder().encode("hi") }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.saveMessage.length, 0);
  assert.equal(mock.calls.import.length, 1);
  const imp = mock.calls.import[0];
  assert.equal(imp.folderId, "a1:/Drafts");
  assert.deepEqual(imp.props, { read: true });
  const { headers: h, html } = drafted(0);
  assert.equal(h.from, '"Me Myself" <me@allowed.com>');
  assert.equal(h.to, "x@example.test");
  assert.equal(h.subject, "Plan");
  assert.equal(h["x-identity-key"], "id1");
  assert.match(h["x-mozilla-draft-info"], /^internal\/draft;/);
  assert.equal(h["in-reply-to"], undefined);
  assert.equal(h.references, undefined);
  assert.match(html, /<body><p>a<br>b<\/p><\/body>/);
  assert.match(imp.raw, /Content-Disposition: attachment; filename="f\.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGk=\r\n/);
  // the id is the imported draft's, known without a lookup
  const mid = h["message-id"].replace(/^<|>$/g, "");
  assert.match(mid, /@allowed\.com$/);
  assert.deepEqual(decodeId(r.content.draftId), { accountId: "a1", folderPath: "Drafts", headerMessageId: mid });
  assert.equal(mock.calls.query.length + mock.calls.getHeaders.length + mock.calls.getFull.length, 0);
  const read = await call("mail_read", { id: r.content.draftId });
  assert.equal(read.ok, true, JSON.stringify(read));
});

test("mail_draft new normalises recipients", async () => {
  const r = await call("mail_draft", { kind: "new", to: ['Alice A <alice@example.test>, "Bob, B" <bob@example.test>'], cc: ["nobody-here"], body: "a" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { headers: h } = drafted(0);
  assert.equal(h.to, '"Alice A" <alice@example.test>, "Bob, B" <bob@example.test>');
  assert.equal(h.cc, "nobody-here");
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
  // the ids of the tab and window Thunderbird opened
  assert.deepEqual(r.content, { opened: true, tabId: 101, windowId: 201 });
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
  let ret;
  inDocument(doc, () => (ret = insertAtTop(ins[1][0].args[0])));
  assert.equal(ret, true, "insertAtTop reports that the text went in");
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
    // a new message reads its account, a reply the enabled accounts
    const undo = spendBudgetIn(mock.messenger.accounts, args.kind === "new" ? "get" : "list");
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
  assert.match(drafted(0).html, /<body><ol><li>a<\/li><li>b<\/li><\/ol><\/body>/);
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
  assert.match(drafted(0).html, /<body><p>Hi<\/p><table border="1"/);
  assert.doesNotMatch(drafted(0).html, /script/);

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

// ---- the identity to write from ----

test("replies and forwards go out from the identity the original was addressed to", async () => {
  const o = original({ recipients: ["Alias <ALIAS@allowed.com>"], ccList: ["Me Myself <me@allowed.com>"] });
  let r = await call("mail_draft", { kind: "reply", id: o.id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  let h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h.from, '"Alias" <alias@allowed.com>');
  assert.equal(h["x-identity-key"], "id9");
  assert.match(h["message-id"], /@allowed\.com>$/);

  for (const kind of ["reply", "reply_all", "forward"]) {
    mock.calls.compose.length = 0;
    r = await call("mail_compose", { kind, id: o.id, body: "x" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [, args] = mock.calls.compose.find(([f]) => f === "beginReply" || f === "beginForward");
    assert.equal(args[2].identityId, "id9", kind);
  }

  // To comes before Cc; with no own address, the default identity
  const o2 = original({ headerMessageId: "cc-only@seed.test", recipients: ["Carol <carol@example.test>"], ccList: ["alias@allowed.com"] });
  r = await call("mail_draft", { kind: "reply_all", id: o2.id, body: "x" });
  assert.equal(parse(mock.calls.import[1].raw).headers["x-identity-key"], "id9");
  const o3 = original({ headerMessageId: "none@seed.test", recipients: ["Carol <carol@example.test>"], ccList: [] });
  r = await call("mail_draft", { kind: "reply", id: o3.id, body: "x" });
  assert.equal(parse(mock.calls.import[2].raw).headers["x-identity-key"], "id1");
});

test("from picks the identity by address or id, for new messages, replies and sends", async () => {
  let r = await call("mail_draft", { kind: "new", from: "Alias@Allowed.com", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(0).headers["x-identity-key"], "id9");

  r = await call("mail_compose", { kind: "new", from: "id9", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.compose[0][1][0].identityId, "id9");

  // from overrides the identity the original was addressed to
  const o = original({ recipients: ["alias@allowed.com"] });
  r = await call("mail_draft", { kind: "reply", id: o.id, from: "me@allowed.com", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(parse(mock.calls.import[1].raw).headers["x-identity-key"], "id1");

  r = await send({ from: "alias@allowed.com" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.sendMessage[0][0].identityId, "id9");
});

test("from finds the account to write from among the enabled accounts only", async () => {
  await save({ accounts: { a1: true, a2: true } });
  // two accounts enabled and no account named: from decides
  let r = await call("mail_draft", { kind: "new", from: "me@home.test", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(0).headers["x-identity-key"], "id2");
  assert.equal(mock.calls.import[0].folderId, "a2:/Drafts");
  assert.equal(decodeId(r.content.draftId).accountId, "a2");
  r = await call("mail_draft", { kind: "new", body: "x" });
  assert.equal(r.error.code, "invalid_argument");
  assert.equal(r.error.message, "Name the account to write from.");

  // an identity of an account that is not enabled is unknown
  await save({ accounts: { a1: true } });
  r = await call("mail_draft", { kind: "new", from: "me@home.test", body: "x" });
  assert.equal(r.error.code, "invalid_argument");
  assert.equal(r.error.message, "No enabled account has the identity me@home.test.");
  r = await send({ from: "id2" });
  assert.equal(r.error.code, "invalid_argument");

  // with account given, from must be one of its identities
  r = await call("mail_compose", { kind: "new", account: "a1", from: "me@home.test", body: "x" });
  assert.equal(r.error.code, "invalid_argument");
  assert.equal(r.error.message, "from is not an identity of this account: me@home.test");
  // for a reply, from must be an identity of an enabled account
  const o = original();
  r = await call("mail_draft", { kind: "reply", id: o.id, from: "nobody@allowed.com", body: "x" });
  assert.equal(r.error.message, "No enabled account has the identity nobody@allowed.com.");
  r = await call("mail_compose", { kind: "reply", id: o.id, from: "me@home.test", body: "x" });
  assert.equal(r.error.message, "No enabled account has the identity me@home.test.");
  for (const from of [5, "", " \r\n"]) {
    r = await call("mail_draft", { kind: "new", from, body: "x" });
    assert.equal(r.error.code, "invalid_argument", JSON.stringify(from));
    assert.equal(r.error.message, "from must be an identity id or address.");
  }
  // only the first draft above was saved
  assert.equal(mock.calls.saveMessage.length + mock.calls.import.length + mock.calls.compose.length + mock.calls.sendMessage.length, 1);
});

// ---- replies to one's own mail and to lists ----

test("a reply to mail the user sent goes to that mail's recipients", async () => {
  const o = mock.addMessage("a1", "Sent", {
    headerMessageId: "mine-1@allowed.com",
    author: "Alias <alias@allowed.com>",
    recipients: ["Carol <carol@example.test>", "me@allowed.com"],
    ccList: ["Dave <dave@example.test>"],
    subject: "Plan",
    body: "My plan.",
  });
  const id = encodeId("a1", "Sent", o.headerMessageId);
  let r = await call("mail_draft", { kind: "reply", id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  let h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h.to, '"Carol" <carol@example.test>');
  assert.equal(h.cc, undefined);
  // me@allowed.com is among the recipients, so the reply is from id1
  assert.equal(h["x-identity-key"], "id1");

  r = await call("mail_draft", { kind: "reply_all", id, body: "x" });
  h = parse(mock.calls.import[1].raw).headers;
  assert.equal(h.to, '"Carol" <carol@example.test>');
  assert.equal(h.cc, '"Dave" <dave@example.test>');

  // a message the user sent only to themselves is answered to themselves
  const self = mock.addMessage("a1", "Sent", { headerMessageId: "self@allowed.com", author: "me@allowed.com", recipients: ["me@allowed.com"], subject: "Note" });
  r = await call("mail_draft", { kind: "reply", id: encodeId("a1", "Sent", self.headerMessageId), body: "x" });
  assert.equal(parse(mock.calls.import[2].raw).headers.to, "me@allowed.com");
});

test("a reply to mail the user sent from an alias to others goes out from that alias", async () => {
  const o = mock.addMessage("a1", "Sent", {
    headerMessageId: "alias-sent@allowed.com",
    author: "Alias <alias@allowed.com>",
    recipients: ["Carol <carol@example.test>"],
    ccList: [],
    subject: "From the alias",
    body: "Sent from the alias.",
  });
  const id = encodeId("a1", "Sent", o.headerMessageId);
  let r = await call("mail_draft", { kind: "reply", id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h["x-identity-key"], "id9");
  assert.equal(h.from, '"Alias" <alias@allowed.com>');
  assert.equal(h.to, '"Carol" <carol@example.test>');
  r = await call("mail_compose", { kind: "reply", id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [, args] = mock.calls.compose.find(([f]) => f === "beginReply");
  assert.equal(args[2].identityId, "id9");
});

test("a reply draft uses Reply-To as Thunderbird decoded it, without decoding it again", async () => {
  // getFull gives decoded headers; text that looks like an encoded word is
  // a name, and decoding it again would add the address inside it
  const word = `=?UTF-8?B?${Buffer.from("x@evil.test, ").toString("base64")}?=`;
  const o = original({ headers: { "reply-to": [`${word} <desk@example.test>`] } });
  let decodes = 0;
  const decode = mock.messenger.messengerUtilities.decodeMimeHeader;
  mock.messenger.messengerUtilities.decodeMimeHeader = async (...args) => (decodes++, decode(...args));
  const r = await call("mail_draft", { kind: "reply", id: o.id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(decodes, 0);
  const h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h.to, `"${word}" <desk@example.test>`);
  assert.doesNotMatch(h.to, /evil/);
});

test("listPost reads the mailto address of a List-Post header", () => {
  assert.equal(listPost(["<mailto:list@lists.example.test>"]), "list@lists.example.test");
  assert.equal(listPost(["<mailto:dev%2Bpost@example.test?subject=hi>, <https://example.test/post>"]), "dev+post@example.test");
  assert.equal(listPost(["<https://example.test/post>", " < MAILTO:b@example.test>"]), "b@example.test");
  assert.equal(listPost(["NO"]), "");
  assert.equal(listPost(["<mailto:%E0%A4%A>"]), "");
  assert.equal(listPost([]), "");
});

test("kind reply_list answers the list in the original's List-Post header", async () => {
  const o = original({ headers: { "list-post": ["<mailto:hosting@lists.example.test>"], references: ["<root-1@seed.test>"] } });
  let r = await call("mail_draft", { kind: "reply_list", id: o.id, body: "To the list." });
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = parse(mock.calls.import[0].raw).headers;
  assert.equal(h.to, "hosting@lists.example.test");
  assert.equal(h.cc, undefined);
  assert.equal(h["in-reply-to"], "<child-2@seed.test>");
  assert.equal(h.subject, "Re: Quarterly hosting review");

  r = await call("mail_compose", { kind: "reply_list", id: o.id, body: "To the list." });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [, args] = mock.calls.compose.find(([f]) => f === "beginReply");
  assert.equal(args[0], o.num);
  assert.equal(args[1], "replyToList");
  // the headers came from getHeaders, which reads no body
  assert.equal(mock.calls.getHeaders.length, 1);
});

test("kind reply_list without a list is refused before anything is written or opened", async () => {
  for (const headers of [{}, { "list-post": ["NO"] }]) {
    const o = original({ headerMessageId: `nolist-${Object.keys(headers).length}@seed.test`, headers });
    for (const tool of ["mail_draft", "mail_compose"]) {
      const r = await call(tool, { kind: "reply_list", id: o.id, to: ["x@example.test"], body: "x" });
      assert.equal(r.ok, false, tool);
      assert.equal(r.error.code, "invalid_argument", tool);
      assert.equal(r.error.message, "This message has no List-Post header, so there is no list to reply to. Use kind reply or reply_all.", tool);
    }
  }
  assert.equal(mock.calls.import.length + mock.calls.compose.length, 0);
  const r = await call("mail_draft", { kind: "reply_list", body: "x" });
  assert.equal(r.error.message, "kind reply_list needs the id of the original message.");
});

test("mail_compose reply_list reads the headers with getFull on Thunderbird 140", async () => {
  mock = install({ accounts: ACCOUNTS, release: 140 });
  await save({ accounts: { a1: true }, groups: { compose: true } });
  const o = original({ headers: { "list-post": ["<mailto:hosting@lists.example.test>"] } });
  const r = await call("mail_compose", { kind: "reply_list", id: o.id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.getHeaders.length, 0);
  assert.equal(mock.calls.getFull.length, 1);
});

// ---- forwards ----

test("forward_as attachment forwards the whole original as an attached message", async () => {
  const o = original();
  let r = await call("mail_compose", { kind: "forward", id: o.id, forward_as: "attachment", to: ["y@example.test"], body: "FYI" });
  assert.equal(r.ok, true, JSON.stringify(r));
  let fwd = mock.calls.compose.find(([f]) => f === "beginForward");
  assert.equal(fwd[1][1], "forwardAsAttachment");
  mock.calls.compose.length = 0;
  r = await call("mail_compose", { kind: "forward", id: o.id, forward_as: "inline", body: "FYI" });
  fwd = mock.calls.compose.find(([f]) => f === "beginForward");
  assert.equal(fwd[1][1], "forwardInline");

  r = await call("mail_draft", { kind: "forward", id: o.id, forward_as: "attachment", to: ["carol@example.test"], body: "FYI", attachments: [{ name: "mine.bin", data: new Uint8Array([1]) }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { headers: h, body } = parse(mock.calls.import[0].raw);
  assert.equal(h.subject, "Fwd: Quarterly hosting review");
  const m = /boundary="([^"]+)"/.exec(h["content-type"]);
  const parts = body.split(`--${m[1]}`).slice(1, -1).map((p) => p.replace(/^\r\n/, ""));
  assert.equal(parts.length, 3);
  const html = b64text(parse(parts[0]).body);
  assert.match(html, /<p>FYI<\/p>/);
  assert.doesNotMatch(html, /Forwarded Message|Thursday works/);
  const att = parts[2];
  const cut = att.indexOf("\r\n\r\n");
  const head = parse(att).headers;
  assert.equal(head["content-type"], 'message/rfc822; name="Quarterly hosting review.eml"');
  assert.equal(head["content-disposition"], 'attachment; filename="Quarterly hosting review.eml"');
  assert.equal(head["content-transfer-encoding"], "7bit");
  // the original's source, with CRLF line ends
  assert.equal(att.slice(cut + 4), "Message-ID: <child-2@seed.test>\r\nFrom: Bob Example <bob@example.test>\r\nSubject: Quarterly hosting review\r\n\r\nThursday works for me.\r\n<b>Bob</b>\r\n");
  assert.equal(mock.calls.listAttachments.length, 0);
});

test("forward_as is checked", async () => {
  const o = original();
  for (const [args, message] of [
    [{ kind: "forward", id: o.id, forward_as: "eml" }, "forward_as must be inline or attachment."],
    [{ kind: "reply", id: o.id, forward_as: "attachment" }, "forward_as is only for kind forward."],
    [{ kind: "new", forward_as: "inline" }, "forward_as is only for kind forward."],
  ]) {
    for (const tool of ["mail_draft", "mail_compose"]) {
      const r = await call(tool, { ...args, body: "x" });
      assert.equal(r.error && r.error.code, "invalid_argument", `${tool} ${JSON.stringify(args)}`);
      assert.equal(r.error.message, message);
    }
  }
  assert.equal(mock.calls.import.length + mock.calls.compose.length, 0);
});

test("mail_draft forward as attachment refuses an original over 50 MiB", async () => {
  const o = original({ size: 50 * 1024 * 1024 + 1 });
  const r = await call("mail_draft", { kind: "forward", id: o.id, forward_as: "attachment", body: "x" });
  assert.equal(r.error.code, "too_large");
  assert.equal(mock.calls.getRaw.length + mock.calls.import.length, 0);
});

test("mail_draft forward as attachment refuses a raw message over 50 MiB that its header calls small", async () => {
  const o = original({ size: 1000 });
  const big = { size: 50 * 1024 * 1024 + 1, arrayBuffer: async () => assert.fail("the bytes must not be read") };
  mock.messenger.messages.getRaw = async (id) => {
    mock.calls.getRaw.push(id);
    return big;
  };
  const r = await call("mail_draft", { kind: "forward", id: o.id, forward_as: "attachment", body: "x" });
  assert.equal(r.error && r.error.code, "too_large", JSON.stringify(r));
  assert.equal(mock.calls.getRaw.length, 1);
  assert.equal(mock.calls.import.length, 0);
});

test("asMessage writes an attached message unencoded, with CRLF line ends", () => {
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (r) => new TextDecoder().decode(r.data);
  let r = asMessage(enc("Subject: a\nFrom: b\r\n\r\nbody"));
  assert.equal(r.encoding, "7bit");
  assert.equal(dec(r), "Subject: a\r\nFrom: b\r\n\r\nbody\r\n");
  r = asMessage(enc("Subject: ü\r\n\r\nGrüße\r\n"));
  assert.equal(r.encoding, "8bit");
  assert.equal(dec(r), "Subject: ü\r\n\r\nGrüße\r\n");
  // bytes only binary could carry
  assert.equal(asMessage(enc("a\x00b")), null);
  assert.equal(asMessage(enc("a\rb")), null);
  assert.equal(asMessage(enc("x".repeat(999))), null);
  assert.notEqual(asMessage(enc("x".repeat(998))), null);
});

test("a forwarded attached message is written unencoded, or as a plain .eml file", async () => {
  const inner = "Subject: inner\nFrom: x@example.test\n\nInner body";
  const o = original({
    attachments: [
      { name: "inner.eml", partName: "1.2", contentType: "message/rfc822", size: inner.length, content: inner },
      { name: "odd.eml", partName: "1.3", contentType: "message/rfc822", size: 3, content: "a\x00b" },
    ],
  });
  const r = await call("mail_draft", { kind: "forward", id: o.id, body: "FYI" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { headers: h, body } = parse(mock.calls.import[0].raw);
  const m = /boundary="([^"]+)"/.exec(h["content-type"]);
  const parts = body.split(`--${m[1]}`).slice(1, -1).map((p) => p.replace(/^\r\n/, ""));
  const msg = parse(parts[1]);
  assert.equal(msg.headers["content-type"], 'message/rfc822; name="inner.eml"');
  assert.equal(msg.headers["content-transfer-encoding"], "7bit");
  assert.equal(parts[1].slice(parts[1].indexOf("\r\n\r\n") + 4), "Subject: inner\r\nFrom: x@example.test\r\n\r\nInner body\r\n");
  const odd = parse(parts[2]);
  assert.equal(odd.headers["content-type"], 'application/octet-stream; name="odd.eml"');
  assert.equal(odd.headers["content-transfer-encoding"], "base64");
  assert.equal(Buffer.from(odd.body.replace(/\r\n/g, ""), "base64").toString("latin1"), "a\x00b");
});

test("a forward refuses FileLink, linked, detached and deleted attachments", async () => {
  const cases = [
    [{ type: "cloudFile", contentType: "application/pdf" }, "a FileLink, stored online"],
    [{ type: "linked", contentType: "application/pdf" }, "linked to a file online"],
    [{ type: "detached", contentType: "application/pdf" }, "detached and saved outside the message"],
    [{ type: "deleted", contentType: "text/x-moz-deleted" }, "deleted from the message"],
    [{ contentType: "text/x-moz-deleted; name=\"Deleted: report.pdf\"" }, "deleted from the message"],
    // Thunderbird 153.6 calls its own placeholders normal; the part's
    // headers say what they are, as in mail_attachment.
    [{ type: "normal", contentType: "text/plain", headers: { "x-mozilla-altered": ['AttachmentDeleted; date="Mon Nov 02 10:00:00 2026"'] } }, "deleted from the message"],
    [{ type: "normal", contentType: "application/pdf", headers: { "x-mozilla-altered": ['AttachmentDetached; date="Mon Nov 02 10:00:00 2026"'], "x-mozilla-external-attachment-url": ["file:///home/u/report.pdf"] } }, "detached and saved outside the message"],
    // 140 ESR gives no type; the headers still tell.
    [{ contentType: "application/pdf", headers: { "x-mozilla-cloud-part": ["cloudFile; url=https://files.test/report.pdf"] } }, "a FileLink, stored online"],
  ];
  for (const [i, [extra, why]] of cases.entries()) {
    const o = original({ headerMessageId: `placeholder-${i}@seed.test`, attachments: [{ name: "report.pdf", partName: "1.2", size: 300, content: "placeholder", ...extra }] });
    const r = await call("mail_draft", { kind: "forward", id: o.id, body: "FYI" });
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.error.code, "refused");
    assert.equal(r.error.message, `The attachment report.pdf is ${why}, so the message holds only a placeholder for it and it cannot be forwarded as a file. Forward the whole message with forward_as attachment instead.`);
  }
  assert.equal(mock.calls.getAttachmentFile.length + mock.calls.import.length, 0);
  // a normal attachment forwards
  const o = original({ headerMessageId: "normal@seed.test", attachments: [{ name: "a.pdf", partName: "1.2", type: "normal", contentType: "application/pdf", size: 3, content: "pdf" }] });
  const r = await call("mail_draft", { kind: "forward", id: o.id, body: "FYI" });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ---- Drafts in another account ----

const ELSEWHERE = [
  {
    id: "a3",
    name: "Shop",
    type: "imap",
    identities: [{ id: "id3", accountId: "a3", email: "shop@shop.test", name: "Shop" }],
    folders: ["INBOX", "Sent"],
    specialUse: { INBOX: ["inbox"], Sent: ["sent"] },
    draftsIn: "lf",
  },
  { id: "lf", name: "Local Folders", type: "local", identities: [], folders: ["Drafts", "Trash"], specialUse: { Drafts: ["drafts"], Trash: ["trash"] } },
  ...ACCOUNTS,
];

test("mail_draft uses an enabled Local Folders' Drafts for an account without one", async () => {
  mock = install({ accounts: ELSEWHERE });
  await save({ accounts: { a3: true, lf: true, a1: true }, groups: { compose: true } });
  const h = mock.addMessage("a3", "INBOX", { headerMessageId: "order-7@shop.test", recipients: ["shop@shop.test"], subject: "Order 7" });
  let r = await call("mail_draft", { kind: "reply", id: encodeId("a3", "INBOX", h.headerMessageId), body: "Shipped." });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.import[0].folderId, "lf:/Drafts");
  assert.equal(parse(mock.calls.import[0].raw).headers["x-identity-key"], "id3");
  assert.equal(decodeId(r.content.draftId).accountId, "lf");

  // a new draft goes to the same folder, with its id
  r = await call("mail_draft", { kind: "new", account: "a3", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { headers } = drafted(1);
  assert.equal(mock.calls.import[1].folderId, "lf:/Drafts");
  assert.equal(headers["x-identity-key"], "id3");
  assert.deepEqual(decodeId(r.content.draftId), { accountId: "lf", folderPath: "Drafts", headerMessageId: headers["message-id"].replace(/^<|>$/g, "") });
  assert.equal(mock.calls.saveMessage.length, 0);
});

const NO_DRAFTS =
  "This account has no Drafts folder of its own. Drafts of such an account are saved only in Local Folders, on this computer: enable Local Folders in MCP for Thunderbird, or save the draft in Thunderbird.";

test("mail_draft never puts a draft of an account without Drafts into another server account", async () => {
  mock = install({ accounts: ELSEWHERE });
  await save({ accounts: { a3: true }, groups: { compose: true } });
  let r = await call("mail_draft", { kind: "new", body: "x" });
  assert.equal(r.error.code, "refused");
  assert.equal(r.error.message, NO_DRAFTS);

  // a1's Drafts is the only other enabled one, on another server: a3's
  // mail must not be copied there
  await save({ accounts: { a3: true, a1: true } });
  const h = mock.addMessage("a3", "INBOX", { headerMessageId: "private-1@shop.test", recipients: ["shop@shop.test"], subject: "Private" });
  const id = encodeId("a3", "INBOX", h.headerMessageId);
  for (const args of [
    { kind: "forward", id, forward_as: "attachment", to: ["x@example.test"], body: "x" },
    { kind: "reply", id, body: "x" },
    { kind: "new", account: "a3", body: "x" },
  ]) {
    r = await call("mail_draft", args);
    assert.equal(r.error && r.error.code, "refused", JSON.stringify(args));
    assert.equal(r.error.message, NO_DRAFTS);
  }
  await save({ accounts: { a3: true, a1: true, a2: true } });
  r = await call("mail_draft", { kind: "new", account: "a3", body: "x" });
  assert.equal(r.error.message, NO_DRAFTS);

  // the Local Folders' Drafts is excluded
  await save({ accounts: { a3: true, lf: true }, excludedFolders: [{ accountId: "lf", path: "Drafts" }] });
  r = await call("mail_draft", { kind: "new", account: "a3", body: "x" });
  assert.equal(r.error.code, "excluded");
  assert.equal(mock.calls.saveMessage.length + mock.calls.import.length + mock.calls.getRaw.length, 0);
});

test("a new draft goes into the Drafts folder the policy checked, wherever the identity keeps its drafts", async () => {
  // a1's identities keep their drafts in a2, which is not enabled; there
  // saveMessage would have written it
  mock = install({ accounts: ACCOUNTS.map((a) => (a.id === "a1" ? { ...a, draftsIn: "a2" } : a)) });
  await save({ accounts: { a1: true }, groups: { compose: true } });
  const r = await call("mail_draft", { kind: "new", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.saveMessage.length, 0);
  assert.equal(mock.calls.import[0].folderId, "a1:/Drafts");
  assert.equal(decodeId(r.content.draftId).accountId, "a1");
  assert.equal([...mock.store.values()].filter((m) => m.folder.accountId === "a2").length, 0);

  // an excluded Drafts folder refuses it before anything is written
  await save({ excludedFolders: [{ accountId: "a1", path: "Drafts" }] });
  const r2 = await call("mail_draft", { kind: "new", body: "x" });
  assert.equal(r2.error.code, "excluded");
  assert.equal(mock.calls.import.length, 1);
});

// ---- identities of other accounts ----

test("a reply or forward goes out from an identity of another enabled account the original was addressed to", async () => {
  await save({ accounts: { a1: true, a2: true } });
  const o = original({ recipients: ["Me <me@home.test>", "Carol <carol@example.test>"], ccList: ["Dave <dave@example.test>"] });
  let r = await call("mail_draft", { kind: "reply_all", id: o.id, body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { headers: h } = drafted(0);
  assert.equal(h["x-identity-key"], "id2");
  assert.equal(h.from, '"Me" <me@home.test>');
  // saved in the identity's account
  assert.equal(mock.calls.import[0].folderId, "a2:/Drafts");
  assert.equal(decodeId(r.content.draftId).accountId, "a2");
  // every enabled account's addresses are the user's own
  assert.equal(h.cc, '"Carol" <carol@example.test>, "Dave" <dave@example.test>');
  for (const kind of ["reply", "forward"]) {
    mock.calls.compose.length = 0;
    r = await call("mail_compose", { kind, id: o.id, body: "x" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [, args] = mock.calls.compose.find(([f]) => f === "beginReply" || f === "beginForward");
    assert.equal(args[2].identityId, "id2", kind);
  }

  // the original's own account comes first, even for an address in Cc
  const both = original({ headerMessageId: "both@seed.test", recipients: ["me@home.test"], ccList: ["alias@allowed.com"] });
  r = await call("mail_draft", { kind: "reply", id: both.id, body: "x" });
  assert.equal(drafted(1).headers["x-identity-key"], "id9");

  // an identity of an account that is not enabled is not used
  await save({ accounts: { a1: true } });
  r = await call("mail_draft", { kind: "reply", id: o.id, body: "x" });
  assert.equal(drafted(2).headers["x-identity-key"], "id1");
  assert.equal(mock.calls.import[2].folderId, "a1:/Drafts");
});

test("from may name an identity of another enabled account for a reply or forward", async () => {
  await save({ accounts: { a1: true, a2: true } });
  const o = original();
  let r = await call("mail_draft", { kind: "reply", id: o.id, from: "ME@home.test", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(0).headers["x-identity-key"], "id2");
  assert.equal(mock.calls.import[0].folderId, "a2:/Drafts");
  r = await call("mail_compose", { kind: "forward", id: o.id, from: "id2", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.compose.find(([f]) => f === "beginForward")[1][2].identityId, "id2");
});

test("account names the account a reply or forward is written from and saved in", async () => {
  await save({ accounts: { a1: true, a2: true } });
  // with from: another account than the original's is no move of mail
  const o = original();
  let r = await call("mail_draft", { kind: "reply", id: o.id, account: "a2", from: "me@home.test", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(0).headers["x-identity-key"], "id2");
  assert.equal(mock.calls.import[0].folderId, "a2:/Drafts");
  r = await call("mail_compose", { kind: "forward", id: o.id, account: "a2", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.compose.find(([f]) => f === "beginForward")[1][2].identityId, "id2");
  // from must be one of that account's identities
  r = await call("mail_draft", { kind: "reply", id: o.id, account: "a2", from: "me@allowed.com", body: "x" });
  assert.equal(r.error.code, "invalid_argument");
  assert.equal(r.error.message, "from is not an identity of this account: me@allowed.com");

  // without from: addressed to a2's identity, but account a1 is named, so
  // a1 writes it, from its default identity, into a1's Drafts
  const home = original({ headerMessageId: "home@seed.test", recipients: ["Me <me@home.test>"], ccList: [] });
  r = await call("mail_draft", { kind: "reply", id: home.id, account: "a1", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(1).headers["x-identity-key"], "id1");
  assert.equal(mock.calls.import[1].folderId, "a1:/Drafts");
  // the named account's identity the original was addressed to comes first
  const alias = original({ headerMessageId: "alias@seed.test", recipients: ["me@home.test"], ccList: ["alias@allowed.com"] });
  r = await call("mail_draft", { kind: "reply", id: alias.id, account: "a1", body: "x" });
  assert.equal(drafted(2).headers["x-identity-key"], "id9");
  r = await call("mail_compose", { kind: "reply", id: home.id, account: "a1", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(mock.calls.compose.filter(([f]) => f === "beginReply").at(-1)[1][2].identityId, "id1");
});

const LOCAL_ORIGINAL = [
  { id: "lf", name: "Local Folders", type: "local", identities: [], folders: ["Drafts", "Archive"], specialUse: { Drafts: ["drafts"] } },
  ...ACCOUNTS,
];

test("a reply to mail filed in Local Folders goes out from an identity of another enabled account", async () => {
  mock = install({ accounts: LOCAL_ORIGINAL });
  await save({ accounts: { lf: true, a1: true }, groups: { compose: true } });
  const kept = mock.addMessage("lf", "Archive", { headerMessageId: "kept@seed.test", author: "Bob <bob@example.test>", recipients: ["alias@allowed.com"], subject: "Kept" });
  let r = await call("mail_draft", { kind: "reply", id: encodeId("lf", "Archive", kept.headerMessageId), body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(0).headers["x-identity-key"], "id9");
  assert.equal(mock.calls.import[0].folderId, "a1:/Drafts");

  // addressed to no identity: from names one; without it, refused
  const other = mock.addMessage("lf", "Archive", { headerMessageId: "other@seed.test", author: "Bob <bob@example.test>", recipients: ["carol@example.test"], subject: "Other" });
  const id = encodeId("lf", "Archive", other.headerMessageId);
  r = await call("mail_draft", { kind: "reply", id, from: "info@allowed.com", body: "x" });
  assert.equal(r.error.message, "No enabled account has the identity info@allowed.com.");
  r = await call("mail_draft", { kind: "reply", id, from: "me@allowed.com", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(1).headers["x-identity-key"], "id1");
  r = await call("mail_compose", { kind: "reply", id, body: "x" });
  assert.equal(r.error.code, "refused");
  assert.equal(r.error.message, "This account has no identity to write from. Name an identity of another enabled account with from.");
});

test("an identity address two enabled accounts share is refused unless the account is known", async () => {
  const shared = { id: "id7", accountId: "a2", email: "Shared@other.test", name: "Shared" };
  const accounts = [
    ...ACCOUNTS.map((a) => (a.id === "a2" ? { ...a, identities: [...a.identities, shared] } : a)),
    { id: "a4", name: "Third", type: "imap", identities: [{ id: "id8", accountId: "a4", email: "shared@other.test", name: "Shared" }], folders: ["INBOX", "Drafts"], specialUse: { INBOX: ["inbox"], Drafts: ["drafts"] } },
  ];
  mock = install({ accounts });
  await save({ accounts: { a1: true, a2: true, a4: true }, groups: { compose: true } });
  let r = await call("mail_draft", { kind: "new", from: "shared@other.test", body: "x" });
  assert.equal(r.error.code, "invalid_argument");
  assert.equal(r.error.message, "Several enabled accounts have the identity shared@other.test. Name the account to write from.");
  r = await call("mail_compose", { kind: "new", from: "shared@other.test", body: "x" });
  assert.equal(r.error.message, "Several enabled accounts have the identity shared@other.test. Name the account to write from.");
  // a reply from a1's mail: neither account is the original's
  const o = original();
  r = await call("mail_draft", { kind: "reply", id: o.id, from: "shared@other.test", body: "x" });
  assert.equal(r.error.code, "invalid_argument");
  assert.equal(r.error.message, "Several enabled accounts have the identity shared@other.test. Name the account to write from, or the identity by its id.");
  assert.equal(mock.calls.import.length + mock.calls.compose.length, 0);

  // with the account named, or the identity by its id, it is settled
  r = await call("mail_draft", { kind: "new", account: "a2", from: "shared@other.test", body: "x" });
  assert.equal(drafted(0).headers["x-identity-key"], "id7");
  r = await call("mail_draft", { kind: "reply", id: o.id, from: "id8", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(1).headers["x-identity-key"], "id8");
  r = await call("mail_draft", { kind: "reply", id: o.id, account: "a4", from: "shared@other.test", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(2).headers["x-identity-key"], "id8");
  // a reply from the account that has it uses that account's
  const h = mock.addMessage("a2", "INBOX", { headerMessageId: "home-1@seed.test", author: "Bob <bob@example.test>", recipients: ["carol@example.test"], subject: "Home" });
  r = await call("mail_draft", { kind: "reply", id: encodeId("a2", "INBOX", h.headerMessageId), from: "shared@other.test", body: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(drafted(3).headers["x-identity-key"], "id7");
});

// ---- the text goes into the window ----

test("mail_compose fails when the script that puts the text in the window did not run through", async () => {
  for (const result of [[], [{ frameId: 0, error: { message: "no body" } }], [{ frameId: 0, result: undefined }], undefined]) {
    mock.messenger.scripting.executeScript = async (...args) => {
      mock.calls.compose.push(["executeScript", args]);
      return result;
    };
    mock.calls.compose.length = 0;
    const e = await composeDirect({ kind: "new", body: "Hi" });
    assert.equal(e.code, "thunderbird_error", JSON.stringify(result));
    assert.equal(e.message, "The compose window opened, but Thunderbird could not put the text in it. Check the window before trying again.");
    assert.equal(e.mayHaveCompleted, true);
    assert.equal(composeCalls("beginNew"), 1);
  }
});

test("mail_compose returns the tab and window it opened for a plain-text window and without a body", async () => {
  mock.messenger.compose.getComposeDetails = async () => ({ isPlainText: true, plainTextBody: "" });
  let r = await call("mail_compose", { kind: "new", body: "Hello" });
  assert.deepEqual(r.content, { opened: true, tabId: 101, windowId: 201 });
  r = await call("mail_compose", { kind: "new", body: "" });
  assert.deepEqual(r.content, { opened: true, tabId: 102, windowId: 202 });
  mock.messenger.compose.beginNew = async () => ({});
  r = await call("mail_compose", { kind: "new", body: "" });
  assert.deepEqual(r.content, { opened: true });
});

// ---- offline ----

// asOffline runs fn while the background page's navigator says offline.
async function asOffline(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else delete globalThis.navigator;
  }
}

test("mail_send while Thunderbird is offline sends nothing and says so", async () => {
  const r = await asOffline(() => send({}));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "thunderbird_error");
  assert.equal(r.error.message, OFFLINE);
  assert.equal(mock.calls.sendMessage.length, 0);
  // the allowlist still comes first
  refusedNoSend(await asOffline(() => send({ to: ["x@evil.com"] })), "x@evil.com");
  // online again, it sends
  assert.equal((await send({})).ok, true);
});

test("a send that fails because Thunderbird went offline names the offline state", async () => {
  mock.messenger.messages.sendMessage = async (details, options) => {
    mock.calls.sendMessage.push([details, options]);
    globalThis.navigator = { onLine: false };
    throw new Error("messages.sendMessage failed: NS_ERROR_OFFLINE");
  };
  const r = await asOffline(async () => {
    globalThis.navigator = { onLine: true };
    return send({});
  });
  assert.equal(r.error.code, "thunderbird_error");
  assert.equal(r.error.message, OFFLINE);
  assert.equal(mock.calls.sendMessage.length, 1);
});

test("any other failure while Thunderbird is offline says it is offline", async () => {
  mock.messenger.compose.beginNew = async () => {
    throw new Error("NS_ERROR_OFFLINE");
  };
  let r = await asOffline(() => call("mail_compose", { kind: "new", body: "x" }));
  assert.equal(r.error.code, "thunderbird_error");
  assert.equal(r.error.message, "Thunderbird could not complete the request. Thunderbird is offline; turn off Work Offline in Thunderbird and try again.");
  r = await call("mail_compose", { kind: "new", body: "x" });
  assert.equal(r.error.message, "Thunderbird could not complete the request.");
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
