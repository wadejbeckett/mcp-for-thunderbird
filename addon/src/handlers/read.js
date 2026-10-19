/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Read handlers: mail_accounts, mail_folders, mail_search, mail_thread,
// mail_read, mail_attachment and mail_filter_suggest.
// The thread lookup (References, In-Reply-To and a same-subject pass for
// replies), the concurrency limit and the walk over a message's parts
// (bodyParts, after extractParts) follow the vitalio-sh "thunderbird-cli"
// extension (seed commit 465613d), MIT licence, see NOTICE.
//
// Every message a handler returns passes `visible`: its account is enabled
// and its folder is not excluded (Review Focus 2). Search and thread
// results carry Pointers only; message text comes only from mail_read and
// mail_attachment, cleaned and wrapped as untrusted content.
//
// Search (ruling R9, docs/SPIKES.md §3): Thunderbird returns matches
// oldest first, and some queries never settle. So the search walks date
// windows newest first, with Date objects, a page size of what is still
// wanted, and one time budget per call. The lookback doubles each step
// (30, 60, 120 … days back, so the windows span 30, 30, 60, 120 … days)
// until `since`. A window whose first page is full with more behind it is
// split in two and the newer half searched first, so the newest matches
// are found without draining a large window (ruling R19).
//
// Every query asks for its list id (returnMessageListId) and reads pages
// with continueList, so every list can be aborted: on a split, when
// enough is found, on timeout, on error, and when an answer arrives after
// its timeout.

import { HANDLERS, withSave } from "../rpc.js";
import { encodeId, resolveId } from "../ids.js";
import { isExcluded, enabledAccountIds, assertFolderAllowed } from "../policy.js";
import { fail } from "../errors.js";
import { buildThreadIds, normalizeSubject, stripAngleBrackets, createLimiter } from "../thread-utils.js";
import { htmlToText, stripInvisible, wrapUntrusted, authResults, cleanLine } from "../clean.js";

// SEARCH.budgetMs is the time budget of one mail_search or mail_thread
// call. Exported so tests can shorten it.
export const SEARCH = { budgetMs: 10_000 };

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
const DAY = 86_400_000;
const FIRST_SPAN = 30 * DAY;
// Windows overlap by a second (results are de-duplicated), so a message
// on a boundary is found whether Thunderbird's bounds are inclusive or not.
const OVERLAP = 1000;
// A window this short is not split further; its list is read on.
const MIN_SPAN = 4000;
// Without `since`, the window that would start before this has no lower
// bound and is the last.
const FLOOR = Date.UTC(1980, 0, 1);
const HEAD_BYTES = 65_536;
const THREAD_MAX = 200;
const THREAD_IDS_MAX = 100;
const THREAD_CANDIDATES = 50;
const ABORT_WAIT_MS = 1000;

// At most 4 Thunderbird calls in flight, across all calls.
const limiter = createLimiter(4);
export const TIMEOUT = Symbol("timeout");

const tb = () => globalThis.messenger;

// A run is one handler call: its deadline, the message lists it has open,
// and whether it ran out of time or failed.
export function newRun(budgetMs = SEARCH.budgetMs) {
  return { deadline: Date.now() + budgetMs, open: new Set(), timedOut: false, failed: false };
}

const listIdOf = (v) => (typeof v === "string" ? v : v && typeof v.id === "string" ? v.id : null);

// call runs fn through the limiter and gives up at the run's deadline,
// freeing its slot even when Thunderbird never answers. With list: true, a
// message list that arrives after the timeout is aborted.
export function call(run, fn, { list = false } = {}) {
  return limiter.run(() => {
    const left = run.deadline - Date.now();
    if (left <= 0) {
      run.timedOut = true;
      return TIMEOUT;
    }
    let timer;
    const work = Promise.resolve().then(fn);
    const expire = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), left);
    });
    return Promise.race([work, expire])
      .then((v) => {
        if (v === TIMEOUT) {
          run.timedOut = true;
          if (list) {
            work.then(
              (late) => {
                const id = listIdOf(late);
                if (id) abort(id);
              },
              () => {},
            );
          }
        }
        return v;
      })
      .finally(() => clearTimeout(timer));
  });
}

async function abort(listId) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => tb().messages.abortList(listId)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ABORT_WAIT_MS);
      }),
    ]);
  } catch {
    // the list is gone already
  } finally {
    clearTimeout(timer);
  }
}

async function closeList(run, listId) {
  run.open.delete(listId);
  await abort(listId);
}

async function closeAll(run) {
  await Promise.all([...run.open].map((id) => closeList(run, id)));
}

// nextPage reads the next page of an open list. On timeout the list is
// aborted; a list the run no longer wants (it failed) is closed.
async function nextPage(run, listId) {
  const page = await call(run, () => tb().messages.continueList(listId), { list: true });
  if (page === TIMEOUT) {
    await closeList(run, listId);
    return TIMEOUT;
  }
  const p = page && typeof page === "object" ? page : { id: null, messages: [] };
  if (p.id !== listId) run.open.delete(listId);
  if (p.id) run.open.add(p.id);
  if (run.failed && p.id) {
    await closeList(run, p.id);
    return TIMEOUT;
  }
  return p;
}

// openList starts a query and returns its first page, or TIMEOUT.
async function openList(run, query) {
  const listId = await call(run, () => tb().messages.query({ ...query, returnMessageListId: true }), { list: true });
  if (listId === TIMEOUT) return TIMEOUT;
  if (typeof listId !== "string") {
    // an older Thunderbird answered with the first page itself
    const p = listId && typeof listId === "object" ? listId : { id: null, messages: [] };
    if (p.id) run.open.add(p.id);
    return p;
  }
  run.open.add(listId);
  if (run.failed) {
    await closeList(run, listId);
    return TIMEOUT;
  }
  return nextPage(run, listId);
}

// ---- arguments ----

function optString(args, k) {
  const v = args[k];
  if (v == null || v === "") return undefined;
  if (typeof v !== "string") fail("invalid_argument", `${k} must be a string.`);
  return v;
}

function optBool(args, k) {
  const v = args[k];
  if (v == null) return undefined;
  if (typeof v !== "boolean") fail("invalid_argument", `${k} must be true or false.`);
  return v;
}

// optDay parses YYYY-MM-DD as local midnight (Thunderbird shows local
// dates); `after` gives the next midnight, the end of that day.
function optDay(args, k, after = false) {
  const v = args[k];
  if (v == null || v === "") return null;
  const m = typeof v === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const bad = () => fail("invalid_argument", `${k} must be a date as YYYY-MM-DD.`);
  if (!m) bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(y, mo - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) bad();
  return after ? new Date(y, mo - 1, d + 1).getTime() : t.getTime();
}

export function limitArg(v, def, max, name = "limit") {
  if (v == null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) fail("invalid_argument", `${name} must be a number.`);
  return Math.min(max, Math.max(1, Math.floor(v)));
}

// ---- pointers ----

function visible(h, s) {
  const f = h && h.folder;
  return Boolean(
    f &&
      typeof f.accountId === "string" &&
      typeof f.path === "string" &&
      typeof h.headerMessageId === "string" &&
      h.headerMessageId !== "" &&
      s.accounts &&
      s.accounts[f.accountId] === true &&
      !isExcluded(f.accountId, f.path, s),
  );
}

// mailbox splits `"Name" <addr>` into {name, address}.
export function mailbox(text) {
  const s = String(text ?? "").trim();
  const m = /^(.*?)\s*<([^<>]*)>\s*$/.exec(s);
  if (m) return { name: m[1].trim().replace(/^"(.*)"$/, "$1").trim(), address: m[2].trim() };
  return { name: "", address: s };
}

const count = (v) => (Array.isArray(v) ? v.length : 0);

function iso(d) {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? new Date(0).toISOString() : t.toISOString();
}

// Sender and subject are the sender's own text, shown outside any wrapper:
// they are cleaned like mail_read's headers (clip).
function pointer(h, hasAttachments) {
  return {
    id: encodeId(h.folder.accountId, h.folder.path, h.headerMessageId),
    date: iso(h.date),
    from: mailbox(clip(h.author)),
    toCount: count(h.recipients) + count(h.ccList) + count(h.bccList),
    subject: clip(h.subject),
    folder: h.folder.path,
    read: Boolean(h.read),
    flagged: Boolean(h.flagged),
    tags: Array.isArray(h.tags) ? h.tags.map(String) : [],
    hasAttachments,
  };
}

// pointers adds hasAttachments: known from the query when it filtered on
// attachments, else from messages.listAttachments within the run's budget;
// null when the check did not finish in time or failed (ruling R20).
async function pointers(headers, known, run) {
  if (typeof known === "boolean") return headers.map((h) => pointer(h, known));
  const flags = await Promise.all(
    headers.map((h) =>
      call(run, () => tb().messages.listAttachments(h.id)).then(
        (list) => (Array.isArray(list) ? list.length > 0 : null),
        () => null,
      ),
    ),
  );
  return headers.map((h, i) => pointer(h, flags[i]));
}

// answered fails the call when Thunderbird did not answer in time.
export function answered(v) {
  if (v === TIMEOUT) fail("thunderbird_error", "Thunderbird did not answer in time.");
  return v;
}

const newestFirst = (a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id;

// ---- mail_accounts ----

async function mailAccounts(args, ctx) {
  const s = ctx.settings;
  const accounts = (await tb().accounts.list(false)) || [];
  return {
    accounts: accounts
      .filter((a) => a && s.accounts && s.accounts[a.id] === true)
      .map((a) => ({
        id: a.id,
        name: String(a.name ?? ""),
        address: String((Array.isArray(a.identities) && a.identities[0] && a.identities[0].email) || ""),
        type: String(a.type ?? ""),
      })),
  };
}

// ---- mail_folders ----

export const realFolder = (f, accountId) =>
  f && f.accountId === accountId && typeof f.path === "string" && !f.isRoot && !f.isVirtual && !f.isTag && !f.isUnified;

const countOf = (v) => (Number.isInteger(v) ? v : null);

async function mailFolders(args, ctx) {
  const s = ctx.settings;
  const accounts = args.account ? [args.account] : enabledAccountIds(s);
  const run = newRun();
  const out = [];
  for (const accountId of accounts) {
    const all = answered(await call(run, () => tb().folders.query({ accountId }))) || [];
    const keep = all.filter((f) => realFolder(f, accountId) && !isExcluded(accountId, f.path, s));
    const infos = await Promise.all(
      keep.map((f) =>
        call(run, () => tb().folders.getFolderInfo(f.id)).then(
          (i) => (i && i !== TIMEOUT ? i : {}),
          () => ({}),
        ),
      ),
    );
    keep.forEach((f, i) => {
      out.push({
        account: accountId,
        path: f.path,
        name: String(f.name ?? ""),
        unread: countOf(infos[i].unreadMessageCount),
        total: countOf(infos[i].totalMessageCount),
        specialUse: Array.isArray(f.specialUse) ? f.specialUse.map(String) : [],
      });
    });
  }
  return { folders: out };
}

// ---- mail_search ----

// searchScope finds up to `limit` visible messages for one query scope
// (an account, or a folder with its subfolders), newest windows first.
// truncated is true unless every window was searched to its end.
async function searchScope(base, { limit, untilMs, sinceMs, run, s }) {
  const found = new Map();
  const full = () => found.size >= limit;
  const anchor = Math.min(untilMs, Date.now());
  let prevFrom = null;
  for (let k = 0; ; k++) {
    let from = anchor - FIRST_SPAN * 2 ** k;
    const to = k === 0 ? untilMs : prevFrom + OVERLAP;
    let last = false;
    if (sinceMs != null && from <= sinceMs) {
      from = sinceMs;
      last = true;
    } else if (sinceMs == null && from <= FLOOR) {
      from = null;
      last = true;
    }
    const stack = [[from, to]];
    while (stack.length > 0) {
      if (full() || run.failed) return { headers: [...found.values()], truncated: true };
      const [f, t] = stack.pop();
      const per = limit - found.size;
      const q = { ...base, toDate: new Date(t), messagesPerPage: per, autoPaginationTimeout: 0 };
      if (f != null) q.fromDate = new Date(f);
      let page = await openList(run, q);
      if (page === TIMEOUT) return { headers: [...found.values()], truncated: true };
      let msgs = page.messages || [];
      const low = f == null ? FLOOR : f;
      if (page.id && msgs.length >= per && t - low > MIN_SPAN) {
        // Full first page with more behind it: these are the window's
        // oldest. Search the newer half first instead.
        await closeList(run, page.id);
        const mid = Math.floor((low + t) / 2);
        stack.push([f, mid + OVERLAP]);
        stack.push([mid, t]);
        continue;
      }
      for (;;) {
        for (const h of msgs) {
          if (full()) break;
          if (visible(h, s) && !found.has(h.id)) found.set(h.id, h);
        }
        if (!page.id) break;
        const listId = page.id;
        if (full() || run.failed) {
          await closeList(run, listId);
          return { headers: [...found.values()], truncated: true };
        }
        page = await nextPage(run, listId);
        if (page === TIMEOUT) return { headers: [...found.values()], truncated: true };
        msgs = page.messages || [];
      }
    }
    if (last) return { headers: [...found.values()], truncated: false };
    prevFrom = from;
  }
}

export async function folderByPath(run, accountId, path) {
  const list = answered(await call(run, () => tb().folders.query({ accountId, path }))) || [];
  const f = list.find((x) => realFolder(x, accountId) && x.path === path);
  if (!f) fail("not_found", `Folder not found: ${path}`);
  return f;
}

async function mailSearch(args, ctx) {
  const s = ctx.settings;
  const limit = limitArg(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const base = {};
  const map = { text: "fullText", from: "author", to: "recipients", subject: "subject" };
  for (const [k, q] of Object.entries(map)) {
    const v = optString(args, k);
    if (v !== undefined) base[q] = v;
  }
  const unread = optBool(args, "unread");
  if (unread !== undefined) base.read = !unread;
  const flagged = optBool(args, "flagged");
  if (flagged !== undefined) base.flagged = flagged;
  const attachment = optBool(args, "has_attachment");
  if (attachment !== undefined) base.attachment = attachment;
  const tags = [];
  const tag = optString(args, "tag");
  if (tag !== undefined) tags.push(tag);
  if (args.tags != null) {
    if (!Array.isArray(args.tags) || !args.tags.every((x) => typeof x === "string")) fail("invalid_argument", "tags must be a list of strings.");
    tags.push(...args.tags);
  }
  const sinceMs = optDay(args, "since");
  const untilArg = optDay(args, "until", true);
  const untilMs = untilArg ?? Date.now() + DAY;
  if (sinceMs != null && sinceMs >= untilMs) return { messages: [], truncated: false };

  const run = newRun();
  if (tags.length > 0) {
    const list = await tagList(run);
    base.tags = { tags: Object.fromEntries(tags.map((t) => [tagKeyOf(list, t), true])), mode: "all" };
  }
  let scopes;
  const folder = optString(args, "folder");
  if (folder !== undefined) {
    // policy has checked the folder and that the account is known
    const accountId = args.account || enabledAccountIds(s)[0];
    assertFolderAllowed(accountId, folder, s);
    const f = await folderByPath(run, accountId, folder);
    scopes = [{ accountId, folderId: f.id, includeSubFolders: true }];
  } else {
    scopes = (args.account ? [args.account] : enabledAccountIds(s)).map((accountId) => ({ accountId }));
  }

  let results;
  try {
    results = await Promise.all(scopes.map((scope) => searchScope({ ...base, ...scope }, { limit, untilMs, sinceMs, run, s })));
  } catch (e) {
    run.failed = true;
    await closeAll(run);
    throw e;
  }
  const all = results.flatMap((r) => r.headers).sort(newestFirst);
  const truncated = results.some((r) => r.truncated) || all.length > limit;
  const top = all.slice(0, limit);
  return { messages: await pointers(top, attachment, run), truncated };
}

// ---- mail_thread ----

// headOf reads the first 64 KiB of a message's raw source: enough for the
// headers, never the whole of a large message.
async function headOf(run, id) {
  try {
    const raw = await call(run, () => tb().messages.getRaw(id, { data_format: "File" }));
    if (raw === TIMEOUT || raw == null) return "";
    if (typeof raw === "string") return raw.slice(0, HEAD_BYTES);
    return await raw.slice(0, HEAD_BYTES).text();
  } catch {
    return "";
  }
}

// firstPage returns a query's first page and closes its list. A thread is
// best effort: a failed query adds nothing.
async function firstPage(run, query) {
  try {
    const page = await openList(run, { ...query, autoPaginationTimeout: 0 });
    if (page === TIMEOUT) return [];
    if (page.id) await closeList(run, page.id);
    return page.messages || [];
  } catch {
    return [];
  }
}

async function mailThread(args, ctx) {
  const s = ctx.settings;
  const run = newRun();
  const msg = await resolveId(args.id);
  const accountId = msg.folder.accountId;
  assertFolderAllowed(accountId, msg.folder.path, s);
  const own = stripAngleBrackets(msg.headerMessageId);
  const ids = buildThreadIds(await headOf(run, msg.id));
  ids.delete(own);
  const upstream = [...ids].slice(0, THREAD_IDS_MAX);
  const inAccount = (h) => h && h.folder && h.folder.accountId === accountId;

  const found = new Map([[msg.id, msg]]);
  const pages = await Promise.all(upstream.map((headerMessageId) => firstPage(run, { accountId, headerMessageId, messagesPerPage: 20 })));
  for (const h of pages.flat()) if (inAccount(h)) found.set(h.id, h);

  // Replies: later messages of the same subject whose References or
  // In-Reply-To name a message of the thread. Only visible candidates are
  // read, so no raw source is opened in an excluded folder.
  const norm = normalizeSubject(msg.subject || "");
  if (norm) {
    const query = { accountId, subject: norm, messagesPerPage: THREAD_CANDIDATES };
    const since = new Date(msg.date);
    if (!Number.isNaN(since.getTime())) query.fromDate = since;
    const candidates = (await firstPage(run, query)).filter(
      (h) => inAccount(h) && visible(h, s) && !found.has(h.id) && normalizeSubject(h.subject || "").toLowerCase() === norm.toLowerCase(),
    );
    const heads = await Promise.all(candidates.map(async (h) => [h, buildThreadIds(await headOf(run, h.id))]));
    const known = new Set([own, ...upstream, ...[...found.values()].map((h) => stripAngleBrackets(h.headerMessageId))]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [h, refs] of heads) {
        if (found.has(h.id)) continue;
        const self = stripAngleBrackets(h.headerMessageId);
        if ([...refs].some((r) => r !== self && known.has(r))) {
          found.set(h.id, h);
          known.add(self);
          changed = true;
        }
      }
    }
  }
  await closeAll(run);

  const truncated = run.timedOut;
  const thread = [...found.values()]
    .filter((h) => inAccount(h) && visible(h, s))
    .sort((a, b) => new Date(a.date) - new Date(b.date) || a.id - b.id)
    .slice(0, THREAD_MAX);
  const out = { messages: await pointers(thread, undefined, run) };
  if (truncated) out.truncated = true;
  return out;
}

// ---- mail_read ----

export const DEFAULT_MAX_CHARS = 8000;
export const MAX_CHARS = 50_000;
// A body part is read up to this many characters; HTML is parsed only up
// to it (Review Focus 4).
const BODY_CAP = 2 * 1024 * 1024;
const HEADER_CHARS = 2000;
const HEADER_LIST = 200;
const ATTACHMENT_LIST = 200;

function isAttachmentPart(p) {
  if (p.name) return true;
  const cd = p.headers && p.headers["content-disposition"];
  const v = Array.isArray(cd) ? cd[0] : cd;
  return typeof v === "string" && /^\s*attachment/i.test(v);
}

// bodyParts collects the plain and HTML text of a message's parts (not
// its attachments), each capped at BODY_CAP; plainOver/htmlOver say a cap
// was hit. Iterative, so a deeply nested message cannot overflow the stack.
// After vitalio-sh extractParts (MIT, see NOTICE).
export function bodyParts(root) {
  const out = { plain: "", html: "", plainOver: false, htmlOver: false };
  const add = (key, body) => {
    const room = BODY_CAP - out[key].length;
    if (body.length > room) {
      out[key] += body.slice(0, Math.max(0, room));
      out[key + "Over"] = true;
    } else {
      out[key] += body;
    }
  };
  const stack = [root];
  while (stack.length > 0) {
    const p = stack.pop();
    if (!p || typeof p !== "object") continue;
    const ct = String(p.contentType || "").toLowerCase();
    if (typeof p.body === "string" && !isAttachmentPart(p)) {
      if (ct === "text/plain") add("plain", p.body);
      else if (ct === "text/html") add("html", p.body);
    }
    if (Array.isArray(p.parts)) for (let i = p.parts.length - 1; i >= 0; i--) stack.push(p.parts[i]);
  }
  return out;
}

// truncate cuts s to n characters without splitting a surrogate pair.
function truncate(s, n) {
  if (s.length <= n) return { text: s, cut: false };
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return { text: s.slice(0, end), cut: true };
}

// clip cleans a header value shown outside the wrapper: invisible
// characters removed, wrapper markers defused, at most HEADER_CHARS.
const clip = (v) => cleanLine(String(v ?? "")).slice(0, HEADER_CHARS);
const clipList = (v) => (Array.isArray(v) ? v.slice(0, HEADER_LIST).map(clip) : []);

function firstHeader(full, name) {
  const v = full && full.headers ? full.headers[name] : undefined;
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" ? x : "";
}

// message resolves an id to a visible message within the run's budget.
export async function message(run, id, s) {
  const msg = answered(await call(run, () => resolveId(id)));
  assertFolderAllowed(msg.folder.accountId, msg.folder.path, s);
  if (!visible(msg, s)) fail("not_found", `Message not found in ${msg.folder.path}`);
  return msg;
}

async function mailRead(args, ctx) {
  const s = ctx.settings;
  const maxChars = limitArg(args.max_chars, DEFAULT_MAX_CHARS, MAX_CHARS, "max_chars");
  const run = newRun();
  const msg = await message(run, args.id, s);
  const [full, atts] = await Promise.all([
    call(run, () => tb().messages.getFull(msg.id)),
    call(run, () => tb().messages.listAttachments(msg.id)),
  ]);
  answered(full);
  answered(atts);

  const parts = bodyParts(full);
  const plainFirst = parts.plain.trim() !== "";
  const source = plainFirst ? parts.plain : htmlToText(parts.html);
  const { text, cut } = truncate(stripInvisible(source), maxChars);
  const over = plainFirst ? parts.plainOver : parts.htmlOver;
  return {
    id: args.id,
    headers: {
      date: iso(msg.date),
      from: clip(msg.author),
      to: clipList(msg.recipients),
      cc: clipList(msg.ccList),
      subject: clip(msg.subject),
      replyTo: clip(firstHeader(full, "reply-to")),
    },
    auth: authResults(full && full.headers),
    text: wrapUntrusted(text),
    truncated: cut || over,
    attachments: (Array.isArray(atts) ? atts : []).slice(0, ATTACHMENT_LIST).map((a) => ({
      name: clip(a && a.name),
      size: a && Number.isFinite(a.size) ? a.size : null,
      contentType: clip(a && a.contentType),
    })),
  };
}

// ---- mail_attachment ----

// ATTACHMENT.maxBytes is the largest attachment returned (Review Focus 4).
export const ATTACHMENT = { maxBytes: 50 * 1024 * 1024 };
const ATTACHMENT_TEXT = 20_000;
const NO_DIR = "Choose an attachment folder in MCP for Thunderbird's options first.";
const TOO_LARGE = "The attachment is larger than 50 MiB.";
// base64 is built in pieces of whole 3-byte groups.
const B64_PIECE = 3 * 16_384;

export function base64(buf) {
  const bytes = new Uint8Array(buf);
  const out = [];
  for (let i = 0; i < bytes.length; i += B64_PIECE) {
    out.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + B64_PIECE))));
  }
  return out.join("");
}

function decoderFor(contentType) {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  try {
    return new TextDecoder(m ? m[1] : "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

// mailAttachment returns a text attachment's text inline, or asks the
// host to save any other attachment in the user's attachment folder. The
// size Thunderbird lists is checked before any byte is read, and the
// file's own size again before it is read.
async function mailAttachment(args, ctx) {
  const s = ctx.settings;
  const name = optString(args, "name");
  if (name === undefined) fail("invalid_argument", "name is required.");
  const run = newRun();
  const msg = await message(run, args.id, s);
  const list = answered(await call(run, () => tb().messages.listAttachments(msg.id)));
  // Match the name as mail_read lists it (invisible characters stripped,
  // at most 2000 characters), else the name exactly as Thunderbird has it.
  const atts = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.name === "string");
  const att = atts.find((a) => clip(a.name) === name) || atts.find((a) => a.name === name);
  if (!att) fail("not_found", "No attachment of that name in this message.");
  const contentType = String(att.contentType || "application/octet-stream");
  const isText = /^\s*text\//i.test(contentType);
  const isHtml = /^\s*text\/html\b/i.test(contentType);
  // The listed size refuses a large attachment before any byte is read.
  // When Thunderbird lists no size, the File's own size below enforces the
  // 50 MiB limit, still before its bytes are read.
  if (typeof att.size === "number" && att.size > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
  if (!isText && !s.attachmentDir) fail("refused", NO_DIR);

  const file = answered(await call(run, () => tb().messages.getAttachmentFile(msg.id, att.partName)));
  if (!file || typeof file.size !== "number") fail("thunderbird_error", "Thunderbird did not return the attachment.");
  if (file.size > ATTACHMENT.maxBytes) fail("too_large", TOO_LARGE);
  const shownName = clip(att.name);

  if (isText) {
    // Plain text: at most 4 bytes a character, so this slice holds the
    // first 20000. HTML is cleaned like a body (ruling R23), from at most
    // BODY_CAP bytes.
    const sliceBytes = isHtml ? BODY_CAP : ATTACHMENT_TEXT * 4;
    const buf = answered(await call(run, () => file.slice(0, sliceBytes).arrayBuffer()));
    let text = decoderFor(contentType).decode(buf);
    const partial = file.size > sliceBytes;
    if (partial) text = text.replace(/\uFFFD$/, "");
    if (isHtml) text = htmlToText(text);
    const { text: shown, cut } = truncate(stripInvisible(text), ATTACHMENT_TEXT);
    return { name: shownName, contentType, text: wrapUntrusted(shown), truncated: cut || partial };
  }

  const buf = answered(await call(run, () => file.arrayBuffer()));
  return withSave({ name: shownName, contentType, size: buf.byteLength }, { name: shownName, data: base64(buf) });
}

// ---- mail_filter_suggest ----

// Thunderbird's own words in its message-filter editor (en-US, 153).
const FIELDS = {
  from: { label: "From", ops: ["contains", "is", "begins", "ends"] },
  to: { label: "To", ops: ["contains", "is", "begins", "ends"] },
  subject: { label: "Subject", ops: ["contains", "is", "begins", "ends"] },
  body: { label: "Body", ops: ["contains", "is"] },
  tag: { label: "Tags", ops: ["contains", "is"] },
  date: { label: "Date", ops: ["is", "before", "after"] },
};
const OPS = { contains: "contains", is: "is", begins: "begins with", ends: "ends with", before: "is before", after: "is after" };
const ACTIONS = { move: "Move Message to", copy: "Copy Message to", tag: "Tag Message", mark_read: "Mark As Read", flag: "Add Star" };
const MAX_CONDITIONS = 50;
const MAX_ACTIONS = 20;
const MAX_VALUE = 500;

const q = (s) => `"${s}"`;

function listArg(args, k, max) {
  const v = args[k];
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((x) => x && typeof x === "object" && !Array.isArray(x))) fail("invalid_argument", `${k} must be a list of objects.`);
  if (v.length > max) fail("invalid_argument", `At most ${max} ${k}.`);
  return v;
}

function valueOf(x, what) {
  if (typeof x.value !== "string" || x.value.trim() === "") fail("invalid_argument", `${what} needs a value.`);
  if (x.value.length > MAX_VALUE || /[\r\n]/.test(x.value)) fail("invalid_argument", `${what} value must be one line of at most ${MAX_VALUE} characters.`);
  return x.value;
}

// tagKeyOf maps a tag key or label (case-insensitive) to the tag's key.
export function tagKeyOf(list, value) {
  const want = value.toLowerCase();
  const t = list.find((x) => x && typeof x.key === "string" && (x.key.toLowerCase() === want || String(x.tag ?? "").toLowerCase() === want));
  if (!t) fail("invalid_argument", `Unknown tag: ${value}`);
  return t.key;
}

// tagLabel maps a tag key or name to the name Thunderbird shows.
function tagLabel(list, value) {
  const key = tagKeyOf(list, value);
  return String(list.find((x) => x.key === key).tag);
}

// tagList returns Thunderbird's tags; a failure is thunderbird_error.
export async function tagList(run) {
  const api = tb().messages.tags;
  if (!api || typeof api.list !== "function") fail("thunderbird_error", "Thunderbird cannot list its tags.");
  const v = answered(await call(run, () => api.list()));
  if (!Array.isArray(v)) fail("thunderbird_error", "Thunderbird did not list its tags.");
  return v;
}

// mailFilterSuggest validates a filter and describes how to make it in
// Thunderbird's filter editor. It only reads (accounts, folders, tags).
async function mailFilterSuggest(args, ctx) {
  const s = ctx.settings;
  if (typeof args.account !== "string" || args.account === "") fail("invalid_argument", "account is required.");
  const accountId = args.account;
  const match = args.match == null ? "all" : args.match;
  if (match !== "all" && match !== "any") fail("invalid_argument", "match must be all or any.");
  const conditions = listArg(args, "conditions", MAX_CONDITIONS);
  const actions = listArg(args, "actions", MAX_ACTIONS);
  if (actions.length === 0) fail("invalid_argument", "Give at least one action.");

  const run = newRun();
  const needTags = conditions.some((c) => c.field === "tag") || actions.some((a) => a.type === "tag");
  const tags = needTags ? await tagList(run) : [];

  const rules = conditions.map((c) => {
    const f = Object.prototype.hasOwnProperty.call(FIELDS, c.field) ? FIELDS[c.field] : null;
    if (!f) fail("invalid_argument", "A condition's field must be from, to, subject, body, tag or date.");
    if (!f.ops.includes(c.op)) fail("invalid_argument", `The ${c.field} field takes ${f.ops.join(", ")}.`);
    let value = valueOf(c, "A condition");
    if (c.field === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("invalid_argument", "A date condition needs a date as YYYY-MM-DD.");
    if (c.field === "tag") value = tagLabel(tags, value);
    return `${q(f.label)} ${q(OPS[c.op])} ${q(value)}`;
  });

  let folders = null;
  const account = answered(await call(run, () => tb().accounts.get(accountId)));
  const accountName = String((account && account.name) || accountId);
  let moves = 0;
  const steps = [];
  for (const a of actions) {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, a.type)) fail("invalid_argument", "An action must be move, copy, tag, mark_read or flag.");
    const label = ACTIONS[a.type];
    if (a.type === "move" || a.type === "copy") {
      if (a.type === "move" && ++moves > 1) fail("invalid_argument", "A filter can move a message to one folder only.");
      const path = valueOf(a, `The ${a.type} action`);
      assertFolderAllowed(accountId, path, s);
      folders ??= (answered(await call(run, () => tb().folders.query({ accountId }))) || []).filter((f) => realFolder(f, accountId));
      if (!folders.some((f) => f.path === path)) fail("invalid_argument", `Unknown folder in this account: ${path}`);
      steps.push(`${q(label)} the folder ${q(path)} in ${q(accountName)}`);
    } else if (a.type === "tag") {
      steps.push(`${q(label)} ${q(tagLabel(tags, valueOf(a, "The tag action")))}`);
    } else {
      steps.push(q(label));
    }
  }

  const out = [
    "In Thunderbird, open Tools → Message Filters. If the menu bar is hidden, open it from the ≡ application menu: Tools → Message Filters.",
    `In "Filters for:", choose the account ${q(accountName)}.`,
    'Click "New…".',
    'In "Filter name:", type a name you will recognise.',
  ];
  if (rules.length === 0) {
    out.push('Choose "Match all messages".');
  } else {
    out.push(`Choose ${q(match === "any" ? "Match any of the following" : "Match all of the following")}.`);
    rules.forEach((r, i) => out.push(i === 0 ? `Set the first rule to ${r}.` : `Click "+" at the end of the last rule and set the new rule to ${r}.`));
  }
  steps.forEach((a, i) =>
    out.push(i === 0 ? `Under "Perform these actions:", set the first action to ${a}.` : `Click "+" at the end of the last action and set the new action to ${a}.`),
  );
  out.push('Click "OK". The filter runs on new mail; to run it on mail already in a folder, select it in Message Filters and click "Run Now".');
  return { steps: out.map((x, i) => `${i + 1}. ${x}`) };
}

HANDLERS.mail_accounts = mailAccounts;
HANDLERS.mail_folders = mailFolders;
HANDLERS.mail_search = mailSearch;
HANDLERS.mail_thread = mailThread;
HANDLERS.mail_read = mailRead;
HANDLERS.mail_attachment = mailAttachment;
HANDLERS.mail_filter_suggest = mailFilterSuggest;
