/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Compose handlers: mail_draft, mail_compose and mail_send.
//
// mail_draft never sends. Every draft is built here as an RFC 5322
// message and imported with messages.import into the Drafts folder the
// policy checked: the account's own, else an enabled Local Folders'
// (draftsFolder). messages.saveMessage drops In-Reply-To and References
// (ruling R8, recipe C in docs/SPIKES.md §2), and it saves where the
// identity's settings say, which add-ons cannot see. mail_compose opens a
// compose window for the user and never sends, and returns the window's
// tab and window ids.
//
// Every tool writes from one identity of an enabled account: the one
// `from` names (an identity id or address), else for a reply or forward
// the one the original was addressed to, in any enabled account (writer),
// else the account's default identity. kind reply_list answers the list in the original's
// List-Post header; forward_as attachment forwards the whole original as
// an attached message.
//
// mail_send sends only when every recipient in to, cc and bcc passes the
// user's allowlist (Review Focus 5). Each entry is parsed with
// Thunderbird's own header parser and only the addr-spec counts; the
// addresses Thunderbird is given are exactly the ones checked. The
// optional messages.send permission is checked before any send (ruling R7),
// and nothing is sent while Thunderbird is offline.
//
// The body is plain text from the client; it becomes minimal HTML, with
// "- ", "* " and "1. " paragraphs as lists (textToHtml). With html: true
// the body is HTML, rebuilt from an allowlist of elements and attributes
// (cleanHtml), with tables given a border and cell padding inline. Body,
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
import { fail, isToolError, ToolError } from "../errors.js";
import { htmlToText, stripInvisible } from "../clean.js";
import { call, newRun, answered, message, bodyParts, base64, realFolder, attachmentType, ATTACHMENT, TIMEOUT } from "./read.js";

// COMPOSE.budgetMs is the time budget of one compose tool call. Exported
// so tests can shorten it.
export const COMPOSE = { budgetMs: 30_000 };

const KINDS = ["new", "reply", "reply_all", "reply_list", "forward"];
const MAX_RECIPIENTS = 100;
const MAX_FIELD = 998;
const MAX_NAME = 255;
const MAX_REFERENCES = 50;
const TOO_LARGE = "The attachments are larger than 50 MiB in total.";
const NO_SEND = "Thunderbird has not granted MCP for Thunderbird permission to send mail. Turn on direct send in the add-on's options.";
export const OFFLINE = "Thunderbird is offline, so the message was not sent. Turn off Work Offline in Thunderbird and try again, or save it with mail_draft.";
const NO_DRAFTS = "This account has no Drafts folder of its own. Drafts of such an account are saved only in Local Folders, on this computer: enable Local Folders in MCP for Thunderbird, or save the draft in Thunderbird.";

const tb = () => globalThis.messenger;

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
  if (!KINDS.includes(kind)) fail("invalid_argument", "kind must be new, reply, reply_all, reply_list or forward.");
  if (kind === "new" && args.id !== undefined) fail("invalid_argument", "id is only for reply, reply_all, reply_list and forward.");
  if (kind !== "new" && args.id === undefined) fail("invalid_argument", `kind ${kind} needs the id of the original message.`);
  return kind;
}

// forwardAsArg is how a forward carries the original: inline (quoted in
// the body, the default) or attachment (the whole message attached).
function forwardAsArg(args, kind) {
  const v = args.forward_as;
  if (v === undefined) return "inline";
  if (v !== "inline" && v !== "attachment") fail("invalid_argument", "forward_as must be inline or attachment.");
  if (kind !== "forward") fail("invalid_argument", "forward_as is only for kind forward.");
  return v;
}

// fromArg is the identity to write from: an identity id or address.
function fromArg(args) {
  const v = args.from;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || oneLine(v) === "") fail("invalid_argument", "from must be an identity id or address.");
  return oneLine(v).slice(0, MAX_FIELD);
}

// baseName keeps the last path segment of an attachment name, at most
// MAX_NAME characters counted in code points, so a cut never splits a
// surrogate pair (encodeURIComponent throws on half of one). A long name
// loses the end of its stem and keeps its extension. A lone surrogate in
// the name becomes U+FFFD.
const MAX_EXT = 16;
export function baseName(n) {
  let name = [...oneLine(n).split(/[/\\]/).pop().toWellFormed()];
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= MAX_EXT ? name.slice(dot) : [];
    name = [...name.slice(0, MAX_NAME - ext.length), ...ext];
  }
  return name.join("") || "attachment";
}

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

function htmlArg(args) {
  const v = args.html;
  if (v !== undefined && typeof v !== "boolean") fail("invalid_argument", "html must be true or false.");
  return v === true;
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
    html: htmlArg(args),
    from: fromArg(args),
    attachments: attachmentsArg(args),
  };
}

// ---- HTML ----

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BULLET = /^[-*] /;
const NUMBER = /^(\d{1,9})\. /;

// listHtml returns a paragraph as a list when every line is an item ("- "
// or "* " for <ul>, "1. " for <ol>) or an indented line that continues the
// item above it (joined with <br>); otherwise null. An <ol> starts at the
// first item's number.
function listHtml(p) {
  const lines = p.replace(/^\n+|\s+$/g, "").split("\n");
  const marker = BULLET.test(lines[0]) ? BULLET : NUMBER.test(lines[0]) ? NUMBER : null;
  if (!marker) return null;
  const items = [];
  for (const line of lines) {
    if (marker.test(line)) items.push([line.replace(marker, "")]);
    else if (/^\s/.test(line)) line.trim() !== "" && items[items.length - 1].push(line.trim());
    else return null;
  }
  const lis = items.map((it) => `<li>${it.map(esc).join("<br>")}</li>`).join("");
  if (marker === BULLET) return `<ul>${lis}</ul>`;
  const start = Number(NUMBER.exec(lines[0])[1]);
  return `<ol${start === 1 ? "" : ` start="${start}"`}>${lis}</ol>`;
}

// textToHtml turns plain text into paragraphs; single line breaks become
// <br>, and a paragraph made only of list lines becomes a list (listHtml).
export function textToHtml(text) {
  return stripInvisible(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => listHtml(p) ?? `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ALLOWED maps each element an HTML body may keep to the attributes it may
// keep; b and i become strong and em. DROPPED elements go with everything
// inside them; any other element is replaced by its contents.
const ALLOWED = {
  p: [], br: [], ul: [], ol: ["start"], li: [], strong: [], em: [], a: ["href"],
  table: [], thead: [], tbody: [], tr: [], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
};
const RENAMED = { b: "strong", i: "em" };
const DROPPED = new Set(["script", "style", "head", "title", "template", "iframe", "object", "embed", "noscript", "svg", "math", "select", "textarea"]);
const VOID = new Set(["br"]);
// Inline, so the table shows ruled in Thunderbird and in the recipient's
// client; border and cellpadding also for clients that drop styles.
const TABLE_STYLE = {
  table: ' border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; border: 1px solid #999999; margin: 0 0 1em 0;"',
  th: ' style="border: 1px solid #999999; padding: 6px 10px; text-align: left; font-weight: bold;"',
  td: ' style="border: 1px solid #999999; padding: 6px 10px; text-align: left;"',
};

function attrValue(tag, name, v) {
  v = stripInvisible(v).trim();
  if (name === "href") return /^(https?:|mailto:)/i.test(v) ? v : null;
  return /^\d{1,4}$/.test(v) ? v : null;
}

function cleanNode(node) {
  if (node.nodeType === 3) return esc(stripInvisible(node.nodeValue));
  if (node.nodeType !== 1) return "";
  const raw = node.localName.toLowerCase();
  if (DROPPED.has(raw)) return "";
  const inner = Array.from(node.childNodes, cleanNode).join("");
  const tag = RENAMED[raw] ?? raw;
  if (!Object.hasOwn(ALLOWED, tag)) return inner;
  let attrs = TABLE_STYLE[tag] ?? "";
  for (const name of ALLOWED[tag]) {
    const v = node.getAttribute(name);
    const ok = v === null ? null : attrValue(tag, name, v);
    if (ok !== null) attrs += ` ${name}="${esc(ok)}"`;
  }
  return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner}</${tag}>`;
}

// cleanHtml rebuilds an HTML body from the elements and attributes in
// ALLOWED: text is escaped again and loses invisible characters, a link
// keeps only an http, https or mailto address, and nothing else (styles,
// classes, event handlers, images) is kept. The document is parsed inert
// (see clean.js).
export function cleanHtml(src) {
  const doc = new globalThis.DOMParser().parseFromString(`<!DOCTYPE html><html><body>${src}</body></html>`, "text/html");
  return Array.from(doc.body.childNodes, cleanNode).join("").trim();
}

// bodyHtml is the HTML of the client's body: cleaned HTML or converted text.
const bodyHtml = (a) => (a.html ? cleanHtml(a.body) : textToHtml(a.body));

const quoteHtml = (text) => esc(text.replace(/\r\n?/g, "\n").replace(/\s+$/, "")).replace(/\n/g, "<br>");

const htmlDoc = (inner) =>
  '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>' + inner + "</body></html>";

const files = (atts) => atts.map((a) => ({ file: new File([a.data], a.name, { type: a.contentType }), name: a.name }));

// ---- Thunderbird lookups ----

const emailOf = (i) => oneLine(i && i.email).toLowerCase();

const identitiesIn = (a) => (a && Array.isArray(a.identities) ? a.identities : []).filter((i) => i && typeof i.id === "string");

// named finds the identity `from` names among ids: by id, else by address.
const named = (ids, from) => ids.find((i) => i.id === from) || ids.find((i) => emailOf(i) !== "" && emailOf(i) === from.toLowerCase());

// enabledAccounts lists the enabled accounts, with their identities, in
// Thunderbird's order.
async function enabledAccounts(run, s) {
  const enabled = new Set(enabledAccountIds(s));
  const list = answered(await call(run, () => tb().accounts.list(false)));
  return (Array.isArray(list) ? list : []).filter((a) => a && enabled.has(a.id));
}

// accountOf finds the enabled account, among accounts, that has the
// identity `from` names. `name` says how to settle a tie.
function accountOf(accounts, from, name) {
  const hits = accounts.filter((a) => named(identitiesIn(a), from));
  if (hits.length === 0) fail("invalid_argument", `No enabled account has the identity ${from}.`);
  if (hits.length > 1) fail("invalid_argument", `Several enabled accounts have the identity ${from}. ${name}`);
  return hits[0];
}

// accountFor picks the account a new message is written from: the
// `account` argument (policy has checked it is enabled), the enabled
// account with the identity `from` names, or the only enabled account.
async function accountFor(run, args, s, from) {
  if (args.account !== undefined) return args.account;
  if (from !== undefined) return accountOf(await enabledAccounts(run, s), from, "Name the account to write from.").id;
  const enabled = enabledAccountIds(s);
  if (enabled.length !== 1) fail("invalid_argument", "Name the account to write from.");
  return enabled[0];
}

// addressedTo returns the first identity among ids whose address is in
// the address entries, in their order.
async function addressedTo(run, ids, entries) {
  const list = entries.filter((x) => typeof x === "string").map(oneLine).filter(Boolean);
  for (const m of await mailboxes(run, list)) {
    const e = m.email.toLowerCase();
    const hit = e && ids.find((i) => emailOf(i) === e);
    if (hit) return hit;
  }
  return undefined;
}

// ownAddresses are the addresses of every identity in accounts.
const ownAddresses = (accounts) => new Set(accounts.flatMap((a) => identitiesIn(a).map(emailOf)).filter(Boolean));

// writer returns the account and identity to write from, and `own`, the
// user's own addresses. The identity is always passed to Thunderbird:
// given none, it would write from the default account's identity, which
// can be another account's.
//
// A new message is written from the account accountFor picks: from the
// identity `from` names, which must be one of that account's, else from
// its default identity (listed first).
//
// A reply or forward may go out from any enabled account's identity, as
// in Thunderbird (MailUtils.getIdentityForHeader), and is then saved in
// that identity's account: `from` names it, else it is the first identity
// whose address is in the original's To or Cc, else, for mail the user
// sent, the identity that sent it, looked for first in the original's
// account and then in every enabled account; else the original account's
// default identity. `own` holds every enabled account's identities.
async function writer(run, args, s, h, from) {
  if (!h) {
    const accountId = await accountFor(run, args, s, from);
    const a = answered(await call(run, () => tb().accounts.get(accountId, false)));
    const ids = identitiesIn(a);
    if (ids.length === 0) fail("refused", "This account has no identity to write from.");
    const identity = from === undefined ? ids[0] : named(ids, from);
    if (!identity) fail("invalid_argument", `from is not an identity of this account: ${from}`);
    return { accountId, identity, own: ownAddresses([a]) };
  }
  const accounts = await enabledAccounts(run, s);
  const home = accounts.find((a) => a.id === h.folder.accountId);
  const order = home ? [home, ...accounts.filter((a) => a !== home)] : accounts;
  const own = ownAddresses(accounts);
  if (from !== undefined) {
    const a = home && named(identitiesIn(home), from) ? home : accountOf(accounts, from, "Name the identity by its id.");
    return { accountId: a.id, identity: named(identitiesIn(a), from), own };
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const entries of [[...list(h.recipients), ...list(h.ccList)], [h.author]]) {
    for (const a of order) {
      const identity = await addressedTo(run, identitiesIn(a), entries);
      if (identity) return { accountId: a.id, identity, own };
    }
  }
  const ids = identitiesIn(home);
  if (ids.length === 0) fail("refused", "This account has no identity to write from. Name an identity of another enabled account with from.");
  return { accountId: home.id, identity: ids[0], own };
}

const isDrafts = (f) => f && realFolder(f, f.accountId) && Array.isArray(f.specialUse) && f.specialUse.includes("drafts");

// draftsFolder finds the Drafts folder a draft of the account goes to: the
// account's own, else the Drafts folder of an enabled Local Folders, which
// is on this computer. Thunderbird does not tell add-ons which folder an
// identity saves drafts in, so the draft never goes to another server
// account on a guess: it would copy the mail it quotes or forwards onto
// that account's server. An excluded Drafts folder refuses the draft.
async function draftsFolder(run, accountId, s) {
  const list = answered(await call(run, () => tb().folders.query({ specialUse: ["drafts"] })));
  const all = (Array.isArray(list) ? list : []).filter(isDrafts);
  let f = all.find((x) => x.accountId === accountId);
  if (!f) {
    const local = new Set((await enabledAccounts(run, s)).filter((a) => a.type === "local").map((a) => a.id));
    f = all.find((x) => local.has(x.accountId));
    if (!f) fail("refused", NO_DRAFTS);
  }
  assertFolderAllowed(f.accountId, f.path, s);
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

// changing runs fn, a call that changes something in Thunderbird (opens a
// window, saves or sends). If the budget was already spent when its turn
// came, call answers TIMEOUT without running fn: nothing was changed, so the
// failure is the plain one, without mayHaveCompleted. A timeout once fn has
// started may have completed (done, with what).
async function changing(run, fn, what) {
  let started = false;
  const v = await call(run, () => {
    started = true;
    return fn();
  });
  return done(started ? v : answered(v), what);
}

// headerValues lists the values of one header in a headers dictionary
// (lower-case names, each with a list of values).
function headerValues(headers, name) {
  const v = headers ? headers[name] : undefined;
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x) => typeof x === "string");
}

// headersOf reads a message's headers: with messages.getHeaders where this
// Thunderbird has it (147 and later), which reads no body, else from
// getFull. It answers TIMEOUT when the budget ran out.
async function headersOf(run, id) {
  const m = tb().messages;
  if (typeof m.getHeaders === "function") return call(run, () => m.getHeaders(id));
  const full = await call(run, () => m.getFull(id));
  return full === TIMEOUT ? TIMEOUT : full && full.headers;
}

// listPost returns the address in a List-Post header ("<mailto:list@x>",
// RFC 2369), or "" when there is none, as for a list that takes no posts
// ("NO").
export function listPost(values) {
  for (const v of values) {
    const m = /<\s*mailto:([^>?\s]+)/i.exec(v);
    if (!m) continue;
    try {
      const addr = oneLine(decodeURIComponent(m[1]));
      if (addr) return addr;
    } catch {
      // not a valid percent-encoding; try the next value
    }
  }
  return "";
}

// listAddress returns the list address a reply_list goes to, from the
// original's headers; a message without one has no list to reply to.
async function listAddress(run, headers) {
  const addr = listPost(headerValues(headers, "list-post"));
  const boxes = addr ? (await mailboxes(run, [addr])).filter((m) => m.email) : [];
  if (boxes.length !== 1) fail("invalid_argument", "This message has no List-Post header, so there is no list to reply to. Use kind reply or reply_all.");
  return formatMailbox(boxes[0]);
}

// original reads what a reply or forward needs from the message. getFull
// gives headers already decoded (RFC 2047), so Reply-To is used as it
// comes: decoding it again could turn text in a display name into an
// address.
async function original(run, h) {
  const full = answered(await call(run, () => tb().messages.getFull(h.id)));
  const parts = bodyParts(full);
  const text = stripInvisible(parts.plain.trim() !== "" ? parts.plain : htmlToText(parts.html));
  const headers = full && full.headers;
  const replyTo = oneLine(headerValues(headers, "reply-to")[0] || "");
  const references = headerValues(headers, "references").join(" ").match(/<[^<>\s]+>/g) || [];
  return { full, headers, text, replyTo, references };
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

// asMessage returns an attached message's bytes as RFC 2046 section 5.2.1
// allows them in a message/rfc822 part, unencoded: lines end in CRLF, and
// the transfer encoding is 7bit or 8bit. It returns null for bytes only
// binary could carry (a NUL, a lone CR or a line over 998 bytes); such a
// message is attached as a plain .eml file in base64 instead.
export function asMessage(bytes) {
  let bare = 0;
  let line = 0;
  let high = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0 || (b === 13 && bytes[i + 1] !== 10)) return null;
    if (b === 13) continue;
    if (b === 10) {
      if (bytes[i - 1] !== 13) bare++;
      line = 0;
      continue;
    }
    if (++line > 998) return null;
    if (b > 127) high = true;
  }
  const out = new Uint8Array(bytes.length + bare + (line > 0 ? 2 : 0));
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i - 1] !== 13) out[j++] = 13;
    out[j++] = bytes[i];
  }
  if (line > 0) {
    out[j++] = 13;
    out[j++] = 10;
  }
  return { data: out, encoding: high ? "8bit" : "7bit" };
}

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);

// buildMessage returns the parts of an RFC 5322 message (strings and
// bytes, ready for new File([...])): headers, then an HTML body in base64,
// and a multipart/mixed with the attachments when there are any. An
// attached message (message/rfc822) is written unencoded (asMessage);
// every other attachment in base64. The boundary is one no unencoded part
// contains.
function buildMessage(headerLines, html, atts) {
  const out = [];
  const bodyHeaders = "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n";
  if (atts.length === 0) {
    out.push(headerLines.join("\r\n") + "\r\n" + bodyHeaders + "\r\n", b64lines(utf8(html)));
    return out;
  }
  const parts = atts.map((a) => {
    const type = mimeType(a.contentType);
    const msg = type.toLowerCase() === "message/rfc822" ? asMessage(a.data) : null;
    return { a, msg, type: msg ? "message/rfc822" : type.toLowerCase() === "message/rfc822" ? "application/octet-stream" : type };
  });
  const plain = parts.filter((p) => p.msg).map((p) => latin1(p.msg.data));
  let boundary;
  do boundary = "------------mft" + globalThis.crypto.randomUUID().replaceAll("-", "");
  while (plain.some((t) => t.includes(boundary)));
  out.push(headerLines.join("\r\n") + "\r\n" + `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\nThis is a multi-part message in MIME format.\r\n`);
  out.push(`--${boundary}\r\n${bodyHeaders}\r\n`, b64lines(utf8(html)));
  for (const { a, msg, type } of parts) {
    const head = `--${boundary}\r\nContent-Type: ${type}; ${param("name", a.name)}\r\nContent-Disposition: attachment; ${param("filename", a.name)}\r\n`;
    if (msg) out.push(head + `Content-Transfer-Encoding: ${msg.encoding}\r\n\r\n`, msg.data);
    else out.push(head + "Content-Transfer-Encoding: base64\r\n\r\n", b64lines(a.data));
  }
  out.push(`--${boundary}--\r\n`);
  return out;
}

// ---- mail_draft ----

// PLACEHOLDER says why an attachment that is not of type normal holds
// only a placeholder in the message. The type is read.js's attachmentType,
// the rule mail_read and mail_attachment use: the part's own headers
// first, since Thunderbird 153.6's MessageAttachment.type misses the
// deleted and detached placeholders it writes itself.
const PLACEHOLDER = {
  cloudFile: "a FileLink, stored online",
  linked: "linked to a file online",
  detached: "detached and saved outside the message",
  deleted: "deleted from the message",
};

// forwardedAttachments reads the original's attachments, refusing before
// any byte is read when the listed sizes are over the limit, or when an
// attachment's file is not in the message, so its bytes are only a
// placeholder.
async function forwardedAttachments(run, h, already) {
  const list = answered(await call(run, () => tb().messages.listAttachments(h.id)));
  const atts = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.partName === "string");
  for (const a of atts) {
    const type = attachmentType(a);
    if (type !== "normal") {
      const why = PLACEHOLDER[type] ?? "not stored in the message";
      fail("refused", `The attachment ${baseName(a.name)} is ${why}, so the message holds only a placeholder for it and it cannot be forwarded as a file. Forward the whole message with forward_as attachment instead.`);
    }
  }
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

// attachedOriginal reads the whole original message for a forward as an
// attachment, named after its subject as Thunderbird names it.
async function attachedOriginal(run, h, already) {
  if (already + (Number.isFinite(h.size) ? h.size : 0) > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
  const raw = answered(await call(run, () => tb().messages.getRaw(h.id)));
  if (!raw || typeof raw.size !== "number" || typeof raw.arrayBuffer !== "function") fail("thunderbird_error", "Thunderbird did not return the message.");
  if (already + raw.size > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
  const buf = answered(await call(run, () => raw.arrayBuffer()));
  const name = baseName((oneLine(h.subject) || "Forwarded message").replace(/[/\\]/g, "_") + ".eml");
  return { name, data: new Uint8Array(buf), contentType: "message/rfc822" };
}

// replyRecipients works out To and Cc of a reply the client gave none
// for. A reply goes to the original's Reply-To, else its author; a reply
// to mail the user sent goes to that mail's recipients, as in Thunderbird.
// A reply_all adds the original's To and Cc to Cc, without the user's
// own addresses (every enabled account's) and those already in To. A
// reply_list goes to the list.
async function replyRecipients(run, kind, h, o, own) {
  const listOf = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === "string").map(oneLine);
  if (kind === "reply_list") return { to: [await listAddress(run, o.headers)], cc: [] };
  const fromMe = (await mailboxes(run, [oneLine(h.author)])).some((m) => own.has(m.email.toLowerCase()));
  let to;
  if (fromMe) {
    const boxes = (await mailboxes(run, listOf(h.recipients))).filter((m) => m.email);
    const others = boxes.filter((m) => !own.has(m.email.toLowerCase()));
    to = (others.length ? others : boxes).map(formatMailbox);
  } else {
    to = (await mailboxes(run, [o.replyTo || h.author])).filter((m) => m.email).map(formatMailbox);
  }
  if (kind !== "reply_all") return { to, cc: [] };
  const toSet = new Set((await mailboxes(run, to)).map((m) => m.email.toLowerCase()));
  const seen = new Set();
  const cc = (await mailboxes(run, [...listOf(h.recipients), ...listOf(h.ccList)]))
    .filter((m) => {
      const e = m.email.toLowerCase();
      if (!e || own.has(e) || toSet.has(e) || seen.has(e)) return false;
      seen.add(e);
      return true;
    })
    .map(formatMailbox);
  return { to, cc };
}

// replyDraft builds a reply, reply-all, reply to the list or forward and
// imports it into Drafts (recipe C, docs/SPIKES.md §2).
async function replyDraft(run, kind, h, a, who, drafts, forwardAs) {
  const { identity, own } = who;
  const o = await original(run, h);
  const origMid = oneLine(h.headerMessageId).replace(/[<>\s]/g, "");

  // A reply_list without a list is refused even when the client gave
  // recipients, as mail_compose refuses it.
  const defaults = kind === "forward" ? { to: [], cc: [] } : await replyRecipients(run, kind, h, o, own);
  // Recipients the client gave are parsed and written back in one form;
  // an entry that yields no address is refused rather than dropped.
  const norm = async (list, k) => {
    const boxes = await mailboxes(run, list || []);
    const bad = boxes.find((m) => !m.email);
    if (bad) fail("invalid_argument", `Not an address in ${k}: ${bad.raw}`);
    return boxes.map(formatMailbox);
  };
  const to = a.to !== undefined ? await norm(a.to, "to") : defaults.to;
  const cc = a.cc !== undefined ? await norm(a.cc, "cc") : defaults.cc;
  const bcc = await norm(a.bcc, "bcc");

  const subject = a.subject !== undefined ? oneLine(a.subject) : kind === "forward" ? `Fwd: ${oneLine(h.subject)}` : `Re: ${stripRe(oneLine(h.subject))}`;
  const author = oneLine(h.author);
  const when = new Date(h.date);
  const whenText = Number.isNaN(when.getTime()) ? "" : when.toUTCString();

  let quoted;
  if (kind === "forward" && forwardAs === "attachment") {
    quoted = "";
  } else if (kind === "forward") {
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
  const html = htmlDoc(bodyHtml(a) + quoted);

  const given = a.attachments.reduce((n, x) => n + x.data.byteLength, 0);
  let atts = a.attachments;
  if (kind === "forward") atts = [...atts, ...(forwardAs === "attachment" ? [await attachedOriginal(run, h, given)] : await forwardedAttachments(run, h, given))];

  const threading = [];
  if (kind !== "forward" && origMid) {
    const refs = [...o.references.filter((r) => r !== `<${origMid}>`), `<${origMid}>`].slice(-MAX_REFERENCES);
    threading.push(`In-Reply-To: <${origMid}>`, `References: ${refs.join("\r\n ")}`);
  }
  return importDraft(run, { identity, to, cc, bcc, subject, html, atts, threading }, drafts);
}

// importDraft writes a draft as an RFC 5322 message from the identity and
// imports it into the Drafts folder draftsFolder checked, so the draft
// lands exactly there, and its id is known from the Message-ID set here.
// X-Identity-Key tells Thunderbird which identity to send it from when the
// user opens it.
async function importDraft(run, { identity, to, cc, bcc, subject, html, atts, threading = [] }, drafts) {
  const domain = oneLine(identity.email).split("@").pop().replace(/[^A-Za-z0-9.-]/g, "");
  const mid = `${globalThis.crypto.randomUUID()}@${domain || "mcp-for-thunderbird.invalid"}`;
  const tag = globalThis.crypto.randomUUID();
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
  lines.push(`Subject: ${await enc("Subject", subject)}`, ...threading);
  lines.push(
    "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0;\r\n attachmentreminder=0; deliveryformat=0",
    `X-Identity-Key: ${oneLine(identity.id)}`,
    `X-MFT-Draft: ${tag}`,
  );

  const file = new File(buildMessage(lines, html, atts), "draft.eml", { type: "message/rfc822" });
  await changing(run, () => tb().messages.import(file, drafts.id, { read: true }), "the draft may have been saved");
  // The opaque id names the draft by the Message-ID set here; it resolves
  // through messages.query({headerMessageId}) like any other id.
  return { draftId: encodeId(drafts.accountId, drafts.path, mid) };
}

// newDraft imports a new message into Drafts, as replyDraft does. Thunderbird's
// messages.saveMessage would save it where the identity's settings say, a
// folder add-ons cannot see beforehand, so it could land in an account
// that is not enabled or in an excluded folder.
async function newDraft(run, a, identity, drafts) {
  // Recipients are parsed and written back in one form, as for replies;
  // an entry that yields no address is kept as given.
  const norm = async (list) => {
    const boxes = await mailboxes(run, list || []);
    return boxes.map((m) => (m.email ? formatMailbox(m) : m.raw)).filter((x, i, all) => all.indexOf(x) === i);
  };
  const [to, cc, bcc] = [await norm(a.to), await norm(a.cc), await norm(a.bcc)];
  return importDraft(run, { identity, to, cc, bcc, subject: oneLine(a.subject ?? ""), html: htmlDoc(bodyHtml(a)), atts: a.attachments }, drafts);
}

async function mailDraft(args, ctx) {
  const s = ctx.settings;
  const kind = kindArg(args);
  const forwardAs = forwardAsArg(args, kind);
  const a = common(args);
  const run = newRun(COMPOSE.budgetMs);
  const h = kind === "new" ? null : await message(run, args.id, s);
  const who = await writer(run, args, s, h, a.from);
  const drafts = await draftsFolder(run, who.accountId, s);
  if (kind === "new") return newDraft(run, a, who.identity, drafts);
  return replyDraft(run, kind, h, a, who, drafts, forwardAs);
}

// ---- mail_compose ----

// openedWithoutText is the error for a compose window that opened but did
// not get the client's text. It may have completed: the window is there.
function openedWithoutText(why) {
  const e = new ToolError("thunderbird_error", `The compose window opened, but ${why}. Check the window before trying again.`);
  e.mayHaveCompleted = true;
  return e;
}

// intoOpenWindow runs a call on the open compose window; a timeout or an
// error says the window is open and may lack the text.
async function intoOpenWindow(run, fn) {
  let v;
  try {
    v = await call(run, fn);
  } catch {
    throw openedWithoutText("Thunderbird could not put the text in it");
  }
  return done(v, "the compose window is open, but the text may not be in it. Check the window before trying again");
}

// insertAtTop runs in the compose window's document (scripting
// executeScript) and puts the text's HTML at the top of the body, above
// the signature or quote, leaving the elements already there as they are.
// It returns true, so the caller can tell the text went in.
export function insertAtTop(html) {
  document.body.insertAdjacentHTML("afterbegin", html);
  return true;
}

const REPLY_TYPES = { reply: "replyToSender", reply_all: "replyToAll", reply_list: "replyToList" };

async function mailCompose(args, ctx) {
  const s = ctx.settings;
  const kind = kindArg(args);
  const forwardAs = forwardAsArg(args, kind);
  const a = common(args);
  const run = newRun(COMPOSE.budgetMs);
  const h = kind === "new" ? null : await message(run, args.id, s);
  const { identity } = await writer(run, args, s, h, a.from);
  // Thunderbird answers the list itself; a message without one is refused
  // here, so no window opens addressed some other way.
  if (kind === "reply_list") await listAddress(run, answered(await headersOf(run, h.id)));
  const html = bodyHtml(a);
  const subject = a.subject === undefined ? undefined : oneLine(a.subject);

  // The body is never passed to beginNew, beginReply or beginForward: a
  // body given there replaces the whole document, so the window would open
  // without the identity's signature (and a reply without its quote). The
  // window is opened with recipients, subject and attachments only,
  // Thunderbird lays out the signature and the quote, and the text is then
  // put at the top of the document, above both. For a new message every
  // field is passed; for a reply or forward only what the client gave, so
  // Thunderbird fills in the rest from the original.
  const details = { identityId: identity.id };
  if (kind === "new") {
    Object.assign(details, { to: a.to || [], cc: a.cc || [], bcc: a.bcc || [], subject: subject ?? "" });
  } else {
    for (const k of ["to", "cc", "bcc"]) if (a[k] !== undefined) details[k] = a[k];
    if (subject !== undefined) details.subject = subject;
  }
  if (a.attachments.length) details.attachments = files(a.attachments);
  // Once Thunderbird may have opened the window, a failure carries
  // mayHaveCompleted, so a client does not open a second window by trying
  // again. A budget spent before the window was asked for opens nothing
  // and says so plainly (changing).
  const tab = await changing(
    run,
    () =>
      kind === "new"
        ? tb().compose.beginNew(details)
        : kind === "forward"
          ? tb().compose.beginForward(h.id, forwardAs === "attachment" ? "forwardAsAttachment" : "forwardInline", details)
          : tb().compose.beginReply(h.id, REPLY_TYPES[kind], details),
    "the compose window may have opened",
  );
  if (html) {
    if (!tab || tab.id === undefined) throw openedWithoutText("Thunderbird did not report the window it opened, so the text was not put in it");
    const d = await intoOpenWindow(run, () => tb().compose.getComposeDetails(tab.id));
    if (d && d.isPlainText) {
      const text = a.html ? htmlToText(html) : stripInvisible(a.body);
      const upd = { plainTextBody: text + "\n\n" + (d.plainTextBody || "") };
      await intoOpenWindow(run, () => tb().compose.setComposeDetails(tab.id, upd));
    } else {
      // An HTML text is inserted into the open document, not set as a new
      // body: setComposeDetails rebuilds the whole document, and Thunderbird
      // does not load the remote images of the rebuilt signature again, so
      // they show broken in the window. The script's result says whether
      // the text went in: a script that threw, or found no document, gives
      // no true.
      const res = await intoOpenWindow(run, () => tb().scripting.executeScript({ target: { tabId: tab.id }, func: insertAtTop, args: [html] }));
      const first = Array.isArray(res) ? res[0] : undefined;
      if (!first || first.error !== undefined || first.result !== true) throw openedWithoutText("Thunderbird could not put the text in it");
    }
  }
  // The ids name the window for the client (tabs and windows); a window
  // Thunderbird did not report has none.
  const out = { opened: true };
  if (tab && Number.isInteger(tab.id)) out.tabId = tab.id;
  if (tab && Number.isInteger(tab.windowId)) out.windowId = tab.windowId;
  return out;
}

// ---- mail_send ----

// offline says whether Thunderbird is in Work Offline mode: the background
// page's navigator.onLine follows Thunderbird's offline state.
const offline = () => globalThis.navigator?.onLine === false;

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

  const { identity } = await writer(run, args, s, null, a.from);
  const details = { identityId: identity.id, to: checked.to, cc: checked.cc, bcc: checked.bcc, subject: oneLine(a.subject), body: bodyHtml(a) };
  if (a.attachments.length) details.attachments = files(a.attachments);
  // sendNow fails while Thunderbird is offline (only a send without a mode
  // would be queued for later), so an offline Thunderbird sends nothing and
  // says so, and a send that failed because Thunderbird went offline says
  // that too.
  if (offline()) fail("thunderbird_error", OFFLINE);
  try {
    await changing(run, () => tb().messages.sendMessage(details, { mode: "sendNow" }), "the message may have been sent");
  } catch (e) {
    if (!isToolError(e) && offline()) fail("thunderbird_error", OFFLINE);
    throw e;
  }
  return { sent: true };
}

HANDLERS.mail_draft = mailDraft;
HANDLERS.mail_compose = mailCompose;
HANDLERS.mail_send = mailSend;
