/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Read handlers: mail_accounts, mail_folders, mail_search, mail_thread.
// The thread lookup (References, In-Reply-To and a same-subject pass for
// replies) and the concurrency limit follow the vitalio-sh
// "thunderbird-cli" extension (seed commit 465613d), MIT licence, see
// NOTICE.
//
// Every message a handler returns passes `visible`: its account is enabled
// and its folder is not excluded (Review Focus 2). Results carry Pointers
// only, never message text.
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

import { HANDLERS } from "../rpc.js";
import { encodeId, resolveId } from "../ids.js";
import { isExcluded, enabledAccountIds, assertFolderAllowed } from "../policy.js";
import { fail } from "../errors.js";
import { buildThreadIds, normalizeSubject, stripAngleBrackets, createLimiter } from "../thread-utils.js";

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
const TIMEOUT = Symbol("timeout");

const tb = () => globalThis.messenger;

// A run is one handler call: its deadline, the message lists it has open,
// and whether it ran out of time or failed.
function newRun() {
  return { deadline: Date.now() + SEARCH.budgetMs, open: new Set(), timedOut: false, failed: false };
}

const listIdOf = (v) => (typeof v === "string" ? v : v && typeof v.id === "string" ? v.id : null);

// call runs fn through the limiter and gives up at the run's deadline,
// freeing its slot even when Thunderbird never answers. With list: true, a
// message list that arrives after the timeout is aborted.
function call(run, fn, { list = false } = {}) {
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

export function limitArg(v, def, max) {
  if (v == null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) fail("invalid_argument", "limit must be a number.");
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

function pointer(h, hasAttachments) {
  return {
    id: encodeId(h.folder.accountId, h.folder.path, h.headerMessageId),
    date: iso(h.date),
    from: mailbox(h.author),
    toCount: count(h.recipients) + count(h.ccList) + count(h.bccList),
    subject: String(h.subject ?? ""),
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
function answered(v) {
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

const realFolder = (f, accountId) =>
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

async function folderByPath(run, accountId, path) {
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
  if (tags.length > 0) base.tags = { tags: Object.fromEntries(tags.map((t) => [t, true])), mode: "all" };
  const sinceMs = optDay(args, "since");
  const untilArg = optDay(args, "until", true);
  const untilMs = untilArg ?? Date.now() + DAY;
  if (sinceMs != null && sinceMs >= untilMs) return { messages: [], truncated: false };

  const run = newRun();
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

HANDLERS.mail_accounts = mailAccounts;
HANDLERS.mail_folders = mailFolders;
HANDLERS.mail_search = mailSearch;
HANDLERS.mail_thread = mailThread;
