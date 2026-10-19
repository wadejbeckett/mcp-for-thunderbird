/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Compose handlers: mail_draft, mail_compose and mail_send.
//
// mail_draft never sends. A new draft goes through messages.saveMessage.
// Replies and forwards are built here as an RFC 5322 message and imported
// into the account's Drafts folder with messages.import, because
// saveMessage drops In-Reply-To and References (ruling R8, recipe C in
// docs/SPIKES.md §2). mail_compose opens a compose window for the user
// and never sends.
//
// mail_send sends only when every recipient in to, cc and bcc passes the
// user's allowlist (Review Focus 5). Each entry is parsed with
// Thunderbird's own header parser and only the addr-spec counts; the
// addresses Thunderbird is given are exactly the ones checked. The
// optional messages.send permission is checked before any send (ruling R7).
//
// The body is plain text from the client; it becomes minimal HTML. Body,
// subject, recipients and attachment names lose invisible characters
// (ruling R21), and line breaks in header values become spaces, so a value
// cannot add a header of its own.
//
// Every Thunderbird call goes through read.js's call(), with one 30 s
// budget (COMPOSE.budgetMs) for the whole tool call.

import { HANDLERS } from "../rpc.js";
import { encodeId } from "../ids.js";
import { isPlainAddress } from "../address.js";
import { assertFolderAllowed, enabledAccountIds } from "../policy.js";
import { fail, ToolError } from "../errors.js";
import { htmlToText, stripInvisible } from "../clean.js";
import { call, newRun, answered, message, bodyParts, base64, realFolder, ATTACHMENT, TIMEOUT } from "./read.js";

// COMPOSE.budgetMs is the time budget of one compose tool call. Exported
// so tests can shorten it.
export const COMPOSE = { budgetMs: 30_000 };

const KINDS = ["new", "reply", "reply_all", "forward"];
const MAX_RECIPIENTS = 100;
const MAX_FIELD = 998;
const MAX_NAME = 255;
const MAX_REFERENCES = 50;
const TOO_LARGE = "The attachments are larger than 50 MiB in total.";
const NO_SEND = "Thunderbird has not granted MCP for Thunderbird permission to send mail. Turn on direct send in the add-on's options.";
// A new draft is looked up in Drafts among the messages dated from a
// minute before the call, newest first, a few at a time.
const LOOKUP_SLACK_MS = 60_000;
const LOOKUP_CANDIDATES = 25;
const POLL_MS = 500;
// The lookup uses at most this much of the call's budget.
export const LOOKUP = { maxMs: 10_000 };

const tb = () => globalThis.messenger;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- allowlist ----

// isPlainAddress (src/address.js) is the one rule for a sendable address,
// shared with the options page's allowlist check.
export { isPlainAddress };

// isAllowed says whether an addr-spec passes the allowlist. Only a plain
// address can pass. Entries are an exact address, or a domain
// (`@example.com` or `example.com`) equal to the address's domain; never a
// suffix match. Case-insensitive.
export function isAllowed(address, allow) {
  const a = String(address ?? "").trim().toLowerCase();
  if (!isPlainAddress(a)) return false;
  const at = a.lastIndexOf("@");
  if (at <= 0 || at === a.length - 1) return false;
  const domain = a.slice(at + 1);
  return (Array.isArray(allow) ? allow : []).some((entry) => {
    const e = String(entry ?? "").trim().toLowerCase();
    if (e.startsWith("@")) return e.length > 1 && e.slice(1) === domain;
    if (e === "") return false;
    if (!e.includes("@")) return e === domain;
    return e === a;
  });
}

// ---- arguments ----

// oneLine cleans a header value: no invisible characters, no control
// characters, and no line breaks.
const oneLine = (v) =>
  stripInvisible(String(v ?? ""))
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();

function listArg(args, k) {
  const v = args[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail("invalid_argument", `${k} must be a list of addresses.`);
  if (v.length > MAX_RECIPIENTS) fail("invalid_argument", `At most ${MAX_RECIPIENTS} addresses in ${k}.`);
  return v.map(oneLine).filter((x) => x !== "").map((x) => x.slice(0, MAX_FIELD));
}

function textArg(args, k, required) {
  const v = args[k];
  if (v === undefined) {
    if (required) fail("invalid_argument", `${k} is required.`);
    return undefined;
  }
  if (typeof v !== "string") fail("invalid_argument", `${k} must be text.`);
  return v;
}

function kindArg(args) {
  const kind = args.kind;
  if (!KINDS.includes(kind)) fail("invalid_argument", "kind must be new, reply, reply_all or forward.");
  if (kind === "new" && args.id !== undefined) fail("invalid_argument", "id is only for reply, reply_all and forward.");
  if (kind !== "new" && args.id === undefined) fail("invalid_argument", `kind ${kind} needs the id of the original message.`);
  return kind;
}

const baseName = (n) => oneLine(n).split(/[/\\]/).pop().slice(0, MAX_NAME) || "attachment";

// attachmentsArg checks attachments resolved by the background page from
// the host's blobs ({name, data: Uint8Array}).
function attachmentsArg(args) {
  const v = args.attachments;
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail("invalid_argument", "attachments must be a list.");
  let total = 0;
  const out = v.map((a) => {
    if (!a || typeof a.name !== "string" || !(a.data instanceof Uint8Array)) fail("invalid_argument", "Attachment data did not arrive.");
    total += a.data.byteLength;
    return { name: baseName(a.name), data: a.data, contentType: "application/octet-stream" };
  });
  if (total > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
  return out;
}

function common(args, { needTo = false } = {}) {
  const to = listArg(args, "to");
  if (needTo && (!to || to.length === 0)) fail("invalid_argument", "to must list at least one recipient.");
  return {
    to,
    cc: listArg(args, "cc"),
    bcc: listArg(args, "bcc"),
    subject: textArg(args, "subject", needTo),
    body: textArg(args, "body", true),
    attachments: attachmentsArg(args),
  };
}

// ---- HTML ----

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// textToHtml turns plain text into paragraphs; single line breaks become
// <br>.
export function textToHtml(text) {
  return stripInvisible(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const quoteHtml = (text) => esc(text.replace(/\r\n?/g, "\n").replace(/\s+$/, "")).replace(/\n/g, "<br>");

const htmlDoc = (inner) =>
  '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>' + inner + "</body></html>";

const files = (atts) => atts.map((a) => ({ file: new File([a.data], a.name, { type: a.contentType }), name: a.name }));

// ---- Thunderbird lookups ----

// accountFor picks the account to write from: the original message's, the
// `account` argument (policy has checked it is enabled), or the only
// enabled account.
function accountFor(args, s, original) {
  if (original) return original.folder.accountId;
  if (args.account !== undefined) return args.account;
  const enabled = enabledAccountIds(s);
  if (enabled.length !== 1) fail("invalid_argument", "Name the account to write from.");
  return enabled[0];
}

// identityOf returns the account's default identity (listed first) and the
// addresses of all its identities.
async function identityOf(run, accountId) {
  const a = answered(await call(run, () => tb().accounts.get(accountId, false)));
  const ids = a && Array.isArray(a.identities) ? a.identities : [];
  if (!ids[0] || typeof ids[0].id !== "string") fail("refused", "This account has no identity to write from.");
  return { identity: ids[0], own: new Set(ids.map((i) => String(i.email || "").toLowerCase()).filter(Boolean)) };
}

async function draftsFolder(run, accountId, s) {
  const list = answered(await call(run, () => tb().folders.query({ accountId, specialUse: ["drafts"] })));
  const f = (Array.isArray(list) ? list : []).find((x) => realFolder(x, accountId) && Array.isArray(x.specialUse) && x.specialUse.includes("drafts"));
  if (!f) fail("refused", "This account has no Drafts folder.");
  assertFolderAllowed(accountId, f.path, s);
  return f;
}

// mailboxes parses address entries with Thunderbird's header parser.
// An entry that yields no mailbox gives one with an empty address.
async function mailboxes(run, list) {
  const out = [];
  for (const entry of list || []) {
    const parsed = answered(await call(run, () => tb().messengerUtilities.parseMailboxString(entry)));
    const boxes = Array.isArray(parsed) ? parsed : [];
    if (boxes.length === 0) out.push({ name: "", email: "", raw: entry });
    for (const p of boxes) {
      out.push({ name: p && typeof p.name === "string" ? oneLine(p.name) : "", email: p && typeof p.email === "string" ? oneLine(p.email) : "", raw: entry });
    }
  }
  return out;
}

const formatMailbox = ({ name, email }) => (name && name !== email ? `"${name.replace(/["\\]/g, "\\$&")}" <${email}>` : email);

// done fails a write that timed out; it may still have taken effect.
function done(v, what) {
  if (v === TIMEOUT) {
    const e = new ToolError("thunderbird_error", `Thunderbird did not answer in time; ${what}.`);
    e.mayHaveCompleted = true;
    throw e;
  }
  return v;
}

function headerValues(full, name) {
  const v = full && full.headers ? full.headers[name] : undefined;
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x) => typeof x === "string");
}

// original reads what a reply or forward needs from the message.
async function original(run, h) {
  const full = answered(await call(run, () => tb().messages.getFull(h.id)));
  const parts = bodyParts(full);
  const text = stripInvisible(parts.plain.trim() !== "" ? parts.plain : htmlToText(parts.html));
  let replyTo = "";
  const raw = headerValues(full, "reply-to")[0];
  if (raw) {
    const dec = answered(await call(run, () => tb().messengerUtilities.decodeMimeHeader("reply-to", raw)));
    replyTo = oneLine(Array.isArray(dec) ? dec[0] : dec);
  }
  const references = headerValues(full, "references").join(" ").match(/<[^<>\s]+>/g) || [];
  return { full, text, replyTo, references };
}

const stripRe = (s) => String(s ?? "").replace(/^\s*re:\s*/i, "");

// ---- RFC 5322 ----

function rfcDate(d = new Date()) {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

// encodeHeader RFC 2047-encodes a header value with Thunderbird's encoder
// (only display names in address headers). Folded lines are kept as
// CRLF + whitespace; any other line break becomes a space.
async function encodeHeader(run, name, value) {
  const out = answered(await call(run, () => tb().messengerUtilities.encodeMimeHeader(name, value)));
  const v = String(Array.isArray(out) ? out[0] : out ?? value);
  return v
    .split(/\r?\n/)
    .map((l, i) => (i === 0 || /^[ \t]/.test(l) ? l : " " + l))
    .join("\r\n");
}

const pct = (s) => encodeURIComponent(s).replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// param is a MIME parameter: quoted when plain ASCII, else RFC 2231.
const param = (k, v) => (/^[\x20-\x7e]*$/.test(v) && !/["\\]/.test(v) ? `${k}="${v}"` : `${k}*=UTF-8''${pct(v)}`);

const TOKEN_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const mimeType = (ct) => {
  const t = String(ct || "").split(";")[0].trim();
  return TOKEN_TYPE.test(t) ? t : "application/octet-stream";
};

// b64lines base64-encodes bytes in lines of 76 characters.
function b64lines(bytes) {
  const b = base64(bytes);
  const lines = [];
  for (let i = 0; i < b.length; i += 76) lines.push(b.slice(i, i + 76));
  return lines.join("\r\n") + "\r\n";
}

const utf8 = (s) => new TextEncoder().encode(s);

// buildMessage returns the parts of an RFC 5322 message (strings, ready
// for new File([...])): headers, then an HTML body in base64, and a
// multipart/mixed with base64 attachments when there are any.
function buildMessage(headerLines, html, atts) {
  const out = [];
  const bodyHeaders = "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n";
  if (atts.length === 0) {
    out.push(headerLines.join("\r\n") + "\r\n" + bodyHeaders + "\r\n", b64lines(utf8(html)));
    return out;
  }
  const boundary = "------------mft" + globalThis.crypto.randomUUID().replaceAll("-", "");
  out.push(headerLines.join("\r\n") + "\r\n" + `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\nThis is a multi-part message in MIME format.\r\n`);
  out.push(`--${boundary}\r\n${bodyHeaders}\r\n`, b64lines(utf8(html)));
  for (const a of atts) {
    out.push(
      `--${boundary}\r\nContent-Type: ${mimeType(a.contentType)}; ${param("name", a.name)}\r\n` +
        `Content-Disposition: attachment; ${param("filename", a.name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
      b64lines(a.data),
    );
  }
  out.push(`--${boundary}--\r\n`);
  return out;
}

// ---- mail_draft ----

// forwardedAttachments reads the original's attachments, refusing before
// any byte is read when the listed sizes are over the limit.
async function forwardedAttachments(run, h, already) {
  const list = answered(await call(run, () => tb().messages.listAttachments(h.id)));
  const atts = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.partName === "string");
  let total = already + atts.reduce((n, a) => n + (Number.isFinite(a.size) ? a.size : 0), 0);
  if (total > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
  total = already;
  const out = [];
  for (const a of atts) {
    const file = answered(await call(run, () => tb().messages.getAttachmentFile(h.id, a.partName)));
    if (!file || typeof file.size !== "number") fail("thunderbird_error", "Thunderbird did not return an attachment.");
    total += file.size;
    if (total > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
    const buf = answered(await call(run, () => file.arrayBuffer()));
    out.push({ name: baseName(a.name), data: new Uint8Array(buf), contentType: a.contentType });
  }
  return out;
}

// replyDraft builds a reply, reply-all or forward and imports it into
// Drafts (recipe C, docs/SPIKES.md §2).
async function replyDraft(run, kind, h, a, who, drafts) {
  const { identity, own } = who;
  const o = await original(run, h);
  const domain = oneLine(identity.email).split("@").pop().replace(/[^A-Za-z0-9.-]/g, "");
  const mid = `${globalThis.crypto.randomUUID()}@${domain || "mcp-for-thunderbird.invalid"}`;
  const tag = globalThis.crypto.randomUUID();
  const origMid = oneLine(h.headerMessageId).replace(/[<>\s]/g, "");

  let to = a.to;
  let cc = a.cc;
  if (kind !== "forward") {
    if (to === undefined) to = (await mailboxes(run, [o.replyTo || h.author])).filter((m) => m.email).map(formatMailbox);
    if (cc === undefined && kind === "reply_all") {
      const toSet = new Set((await mailboxes(run, to)).map((m) => m.email.toLowerCase()));
      const seen = new Set();
      const others = [...(Array.isArray(h.recipients) ? h.recipients : []), ...(Array.isArray(h.ccList) ? h.ccList : [])].map(oneLine);
      cc = (await mailboxes(run, others))
        .filter((m) => {
          const e = m.email.toLowerCase();
          if (!e || own.has(e) || toSet.has(e) || seen.has(e)) return false;
          seen.add(e);
          return true;
        })
        .map(formatMailbox);
    }
  }
  // Recipients the client gave are parsed and written back in one form.
  const norm = async (list) => (list && list.length ? (await mailboxes(run, list)).filter((m) => m.email).map(formatMailbox) : []);
  to = a.to !== undefined ? await norm(a.to) : to || [];
  cc = a.cc !== undefined ? await norm(a.cc) : cc || [];
  const bcc = await norm(a.bcc);

  const subject = a.subject !== undefined ? oneLine(a.subject) : kind === "forward" ? `Fwd: ${oneLine(h.subject)}` : `Re: ${stripRe(oneLine(h.subject))}`;
  const author = oneLine(h.author);
  const when = new Date(h.date);
  const whenText = Number.isNaN(when.getTime()) ? "" : when.toUTCString();

  let quoted;
  if (kind === "forward") {
    const row = (k, v) => `<tr><th valign="BASELINE" nowrap="nowrap" align="RIGHT">${k}: </th><td>${esc(v)}</td></tr>`;
    const recips = (Array.isArray(h.recipients) ? h.recipients : []).map(oneLine).join(", ");
    quoted =
      '<div class="moz-forward-container"><br><br>-------- Forwarded Message --------' +
      '<table class="moz-email-headers-table" cellspacing="0" cellpadding="0" border="0"><tbody>' +
      row("Subject", oneLine(h.subject)) +
      row("Date", whenText) +
      row("From", author) +
      (recips ? row("To", recips) : "") +
      "</tbody></table><br>" +
      `<div class="moz-text-plain">${quoteHtml(o.text)}</div></div>`;
  } else {
    quoted =
      `<div class="moz-cite-prefix">On ${esc(whenText)}, ${esc(author)} wrote:<br></div>` +
      `<blockquote type="cite" cite="mid:${esc(origMid)}">${quoteHtml(o.text)}</blockquote>`;
  }
  const html = htmlDoc(textToHtml(a.body) + quoted);

  const atts = kind === "forward" ? [...a.attachments, ...(await forwardedAttachments(run, h, a.attachments.reduce((n, x) => n + x.data.byteLength, 0)))] : a.attachments;

  const enc = (name, value) => encodeHeader(run, name, value);
  const lines = [
    `Message-ID: <${mid}>`,
    `Date: ${rfcDate()}`,
    "MIME-Version: 1.0",
    "User-Agent: MCP for Thunderbird",
    `From: ${await enc("From", formatMailbox({ name: oneLine(identity.name), email: oneLine(identity.email) }))}`,
  ];
  if (to.length) lines.push(`To: ${await enc("To", to.join(", "))}`);
  if (cc.length) lines.push(`Cc: ${await enc("Cc", cc.join(", "))}`);
  if (bcc.length) lines.push(`Bcc: ${await enc("Bcc", bcc.join(", "))}`);
  lines.push(`Subject: ${await enc("Subject", subject)}`);
  if (kind !== "forward" && origMid) {
    const refs = [...o.references.filter((r) => r !== `<${origMid}>`), `<${origMid}>`].slice(-MAX_REFERENCES);
    lines.push(`In-Reply-To: <${origMid}>`, `References: ${refs.join("\r\n ")}`);
  }
  lines.push(
    "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0;\r\n attachmentreminder=0; deliveryformat=0",
    `X-Identity-Key: ${oneLine(identity.id)}`,
    `X-MFT-Draft: ${tag}`,
  );

  const file = new File(buildMessage(lines, html, atts), "draft.eml", { type: "message/rfc822" });
  done(await call(run, () => tb().messages.import(file, drafts.id, { read: true })), "the draft may have been saved");
  // The opaque id names the draft by the Message-ID set here; it resolves
  // through messages.query({headerMessageId}) like any other id.
  return { draftId: encodeId(drafts.accountId, drafts.path, mid) };
}

// findDraft looks for the draft saveMessage stored (IMAP returns no
// header, docs/SPIKES.md §2) by its X-MFT-Draft header, until the budget
// is nearly spent.
async function findDraft(outer, drafts, tag, since) {
  const run = { ...outer, deadline: Math.min(outer.deadline, Date.now() + LOOKUP.maxMs) };
  const checked = new Set();
  for (;;) {
    const page = await call(run, () => tb().messages.query({ accountId: drafts.accountId, folderId: drafts.id, fromDate: new Date(since - LOOKUP_SLACK_MS), messagesPerPage: 100 }));
    if (page === TIMEOUT) return null;
    if (page && page.id) await call(run, () => tb().messages.abortList(page.id)).catch(() => {});
    const candidates = (page && Array.isArray(page.messages) ? page.messages : [])
      .filter((h) => !checked.has(h.id))
      .sort((x, y) => new Date(y.date) - new Date(x.date) || y.id - x.id)
      .slice(0, LOOKUP_CANDIDATES);
    for (const h of candidates) {
      checked.add(h.id);
      const full = await call(run, () => tb().messages.getFull(h.id));
      if (full === TIMEOUT) return null;
      if (headerValues(full, "x-mft-draft").some((v) => v.trim() === tag)) return h;
    }
    if (run.deadline - Date.now() < 2 * POLL_MS) return null;
    await sleep(POLL_MS);
  }
}

async function newDraft(run, a, identity, drafts) {
  const tag = globalThis.crypto.randomUUID();
  // Recipients are parsed and written back in one form, as for replies;
  // an entry that yields no address is kept as given.
  const norm = async (list) => {
    const boxes = await mailboxes(run, list || []);
    return boxes.map((m) => (m.email ? formatMailbox(m) : m.raw)).filter((x, i, all) => all.indexOf(x) === i);
  };
  const details = {
    identityId: identity.id,
    to: await norm(a.to),
    cc: await norm(a.cc),
    bcc: await norm(a.bcc),
    subject: oneLine(a.subject ?? ""),
    body: textToHtml(a.body),
    customHeaders: [{ name: "X-MFT-Draft", value: tag }],
  };
  if (a.attachments.length) details.attachments = files(a.attachments);
  const since = Date.now();
  const res = done(await call(run, () => tb().messages.saveMessage(details, { mode: "draft" })), "the draft may have been saved");
  let h = res && Array.isArray(res.messages) ? res.messages.find((m) => m && m.folder && m.headerMessageId) : null;
  // The draft is saved: a failed lookup gives no id rather than an error,
  // so the client does not save it again.
  if (!h) h = await findDraft(run, drafts, tag, since).catch(() => null);
  return { draftId: h ? encodeId(h.folder.accountId, h.folder.path, h.headerMessageId) : null };
}

async function mailDraft(args, ctx) {
  const s = ctx.settings;
  const kind = kindArg(args);
  const a = common(args);
  const run = newRun(COMPOSE.budgetMs);
  const h = kind === "new" ? null : await message(run, args.id, s);
  const accountId = accountFor(args, s, h);
  const who = await identityOf(run, accountId);
  const drafts = await draftsFolder(run, accountId, s);
  if (kind === "new") return newDraft(run, a, who.identity, drafts);
  return replyDraft(run, kind, h, a, who, drafts);
}

// ---- mail_compose ----

async function mailCompose(args, ctx) {
  const s = ctx.settings;
  const kind = kindArg(args);
  const a = common(args);
  const run = newRun(COMPOSE.budgetMs);
  const h = kind === "new" ? null : await message(run, args.id, s);
  const { identity } = await identityOf(run, accountFor(args, s, h));
  const html = textToHtml(a.body);
  const subject = a.subject === undefined ? undefined : oneLine(a.subject);

  if (kind === "new") {
    const details = { identityId: identity.id, to: a.to || [], cc: a.cc || [], bcc: a.bcc || [], subject: subject ?? "", body: html };
    if (a.attachments.length) details.attachments = files(a.attachments);
    answered(await call(run, () => tb().compose.beginNew(details)));
    return { opened: true };
  }

  // Thunderbird fills in recipients, subject and the quote; only what the
  // client gave is passed, and the body goes above the quote.
  const details = { identityId: identity.id };
  for (const k of ["to", "cc", "bcc"]) if (a[k] !== undefined) details[k] = a[k];
  if (subject !== undefined) details.subject = subject;
  if (a.attachments.length) details.attachments = files(a.attachments);
  const tab = answered(
    await call(run, () =>
      kind === "forward"
        ? tb().compose.beginForward(h.id, "forwardInline", details)
        : tb().compose.beginReply(h.id, kind === "reply_all" ? "replyToAll" : "replyToSender", details),
    ),
  );
  if (html && tab && tab.id !== undefined) {
    const d = answered(await call(run, () => tb().compose.getComposeDetails(tab.id)));
    let upd;
    if (d && d.isPlainText) {
      upd = { plainTextBody: stripInvisible(a.body) + "\n\n" + (d.plainTextBody || "") };
    } else {
      const cur = String((d && d.body) || "");
      upd = { body: /<body[^>]*>/i.test(cur) ? cur.replace(/<body([^>]*)>/i, (m, attrs) => `<body${attrs}>${html}`) : html + cur };
    }
    answered(await call(run, () => tb().compose.setComposeDetails(tab.id, upd)));
  }
  return { opened: true };
}

// ---- mail_send ----

async function mailSend(args, ctx) {
  const s = ctx.settings;
  const a = common(args, { needTo: true });
  const run = newRun(COMPOSE.budgetMs);
  const granted = answered(await call(run, () => tb().permissions.contains({ permissions: ["messages.send"] })));
  if (granted !== true || typeof tb().messages.sendMessage !== "function") fail("refused", NO_SEND);

  const allow = s.send && Array.isArray(s.send.allow) ? s.send.allow : [];
  const checked = {};
  for (const k of ["to", "cc", "bcc"]) {
    const boxes = await mailboxes(run, a[k] || []);
    for (const m of boxes) {
      if (!isAllowed(m.email, allow)) fail("refused", `Recipient not in the allowed list: ${m.email || m.raw}`);
      // The address Thunderbird is given must parse back to itself, alone.
      const again = await mailboxes(run, [m.email]);
      if (again.length !== 1 || again[0].email !== m.email) fail("refused", `Recipient not in the allowed list: ${m.email}`);
      // ... and RFC 2047 decoding, as MessageSend applies to recipients,
      // must leave it unchanged.
      const decoded = answered(await call(run, () => tb().messengerUtilities.decodeMimeHeader("to", [m.email], true)));
      if (!Array.isArray(decoded) || decoded.length !== 1 || decoded[0] !== m.email) fail("refused", `Recipient not in the allowed list: ${m.email}`);
    }
    checked[k] = boxes.map((m) => m.email);
  }

  const { identity } = await identityOf(run, accountFor(args, s, null));
  const details = { identityId: identity.id, to: checked.to, cc: checked.cc, bcc: checked.bcc, subject: oneLine(a.subject), body: textToHtml(a.body) };
  if (a.attachments.length) details.attachments = files(a.attachments);
  done(await call(run, () => tb().messages.sendMessage(details, { mode: "sendNow" })), "the message may have been sent");
  return { sent: true };
}

HANDLERS.mail_draft = mailDraft;
HANDLERS.mail_compose = mailCompose;
HANDLERS.mail_send = mailSend;
