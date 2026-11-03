/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Organise handlers: mail_mark, mail_tag, mail_move, mail_archive and
// mail_trash, and the read-only mail_tags. Each organise handler returns
// {done: [ids], failed: [{id, code}]}; one bad id does not stop the others.
// mail_move, mail_archive and mail_trash also return the id each message
// has after the change, as moved (copied for mail_move with copy):
// [{from, to}]. Nothing here ever calls messages.delete: mail_trash moves to
// the account's Trash folder.
//
// Policy has already refused ids in disabled accounts or excluded folders,
// ids and an `account` argument that disagree, and an excluded target
// folder (Review Focus 1). The handlers resolve the target inside the
// messages' own account, refuse Trash and Junk as a move target, and a
// folder Thunderbird says cannot hold messages, and check every message and
// target folder again.
//
// Every Thunderbird call goes through read.js's call(), with one 10 s
// budget (SEARCH.budgetMs) for the whole tool call; ids reached after the
// budget is spent fail with thunderbird_error.

import { HANDLERS } from "../rpc.js";
import { decodeId, encodeId, resolveId } from "../ids.js";
import { assertFolderAllowed, isExcluded } from "../policy.js";
import { fail, isToolError, ToolError } from "../errors.js";
import { call, newRun, answered, clip, folderByPath, realFolder, tagKeyOf, tagList, TIMEOUT } from "./read.js";

export const MAX_IDS = 100;
const MAX_TAGS = 20;
const CROSS_ACCOUNT = "Moving mail between accounts is not allowed.";

const tb = () => globalThis.messenger;

// idsArg returns the distinct ids of the call; at least one, at most MAX_IDS.
function idsArg(args) {
  const v = args.ids;
  if (!Array.isArray(v) || v.length === 0) fail("invalid_argument", "ids must list at least one message id.");
  if (v.length > MAX_IDS) fail("invalid_argument", `At most ${MAX_IDS} ids per call.`);
  return [...new Set(v)];
}

function boolArg(args, k) {
  if (args[k] === undefined) return undefined;
  if (typeof args[k] !== "boolean") fail("invalid_argument", `${k} must be true or false.`);
  return args[k];
}

function accountsOf(ids) {
  return new Set(ids.map((id) => decodeId(id).accountId));
}

// forEachMessage resolves each id, checks the message again against the
// settings and runs fn(header, id). A failure of one id is reported, not
// thrown. With newIds ("moved" or "copied"), fn returns the id the message
// has after the change, or null when that is not known, and each known one
// is listed as {from, to} under that name.
async function forEachMessage(ids, run, s, fn, newIds) {
  const out = { done: [], failed: [] };
  if (newIds) out[newIds] = [];
  for (const id of ids) {
    try {
      const h = answered(await call(run, () => resolveId(id)));
      assertFolderAllowed(h.folder.accountId, h.folder.path, s);
      const to = await fn(h, id);
      out.done.push(id);
      if (newIds && typeof to === "string") out[newIds].push({ from: id, to });
    } catch (e) {
      const entry = { id, code: isToolError(e) ? e.code : "thunderbird_error" };
      if (e && e.mayHaveCompleted) entry.mayHaveCompleted = true;
      out.failed.push(entry);
    }
  }
  return out;
}

// api runs one Thunderbird call within the budget.
// A timeout of a change may still have taken effect, so the error carries
// mayHaveCompleted.
async function api(run, fn) {
  const v = await call(run, fn);
  if (v === TIMEOUT) {
    const e = new ToolError("thunderbird_error", "Thunderbird did not answer in time.");
    e.mayHaveCompleted = true;
    throw e;
  }
  return v;
}

// ---- mail_mark ----

async function mailMark(args, ctx) {
  const read = boolArg(args, "read");
  const flagged = boolArg(args, "flagged");
  if (read === undefined && flagged === undefined) fail("invalid_argument", "Give read, flagged or both.");
  const ids = idsArg(args);
  const props = {};
  if (read !== undefined) props.read = read;
  if (flagged !== undefined) props.flagged = flagged;
  const run = newRun();
  return forEachMessage(ids, run, ctx.settings, (h) => api(run, () => tb().messages.update(h.id, props)));
}

// ---- mail_tag ----

function tagNames(args, k) {
  const v = args[k];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "")) fail("invalid_argument", `${k} must be a list of tag names.`);
  if (v.length > MAX_TAGS) fail("invalid_argument", `At most ${MAX_TAGS} tags in ${k}.`);
  return v;
}

// Tag changes to one message run one at a time, each computed from the
// tags the message has when it is written, so two calls changing the same
// message do not undo each other's change.
const tagQueues = new Map();

function oneAtATime(key, fn) {
  const before = tagQueues.get(key) || Promise.resolve();
  const result = before.then(fn);
  const settled = result.then(
    () => {},
    () => {},
  );
  tagQueues.set(key, settled);
  settled.then(() => {
    if (tagQueues.get(key) === settled) tagQueues.delete(key);
  });
  return result;
}

async function mailTag(args, ctx) {
  const add = tagNames(args, "add");
  const remove = tagNames(args, "remove");
  if (add.length === 0 && remove.length === 0) fail("invalid_argument", "Give tags to add, remove or both.");
  const ids = idsArg(args);
  const run = newRun();
  const list = await tagList(run);
  const addKeys = add.map((t) => tagKeyOf(list, t));
  const removeKeys = new Set(remove.map((t) => tagKeyOf(list, t)));
  return forEachMessage(ids, run, ctx.settings, (h) =>
    oneAtATime(h.id, async () => {
      const now = answered(await call(run, () => tb().messages.get(h.id)));
      if (!now) fail("not_found", "The message is no longer there.");
      const current = Array.isArray(now.tags) ? now.tags : [];
      const tags = [...new Set([...current, ...addKeys])].filter((k) => !removeKeys.has(k));
      return api(run, () => tb().messages.update(h.id, { tags }));
    }),
  );
}

// ---- folders ----

const hasUse = (f, use) => Array.isArray(f.specialUse) && f.specialUse.includes(use);

async function accountFolders(run, accountId) {
  const all = await api(run, () => tb().folders.query({ accountId }));
  return (Array.isArray(all) ? all : []).filter((f) => realFolder(f, accountId));
}

// specialFolder returns the account's folder with that special use, or null.
async function specialFolder(run, accountId, use) {
  const list = await api(run, () => tb().folders.query({ accountId, specialUse: [use] }));
  return (Array.isArray(list) ? list : []).find((f) => realFolder(f, accountId) && hasUse(f, use)) || null;
}

// folderCapabilities returns what Thunderbird allows in the folder
// (canAddMessages and the rest), or null when it cannot say: an error
// leaves the decision to the move itself.
async function folderCapabilities(run, folder) {
  const f = tb().folders;
  if (!f || typeof f.getFolderCapabilities !== "function") return null;
  const v = await call(run, () => f.getFolderCapabilities(folder.id)).catch(() => null);
  return answered(v) || null;
}

// ---- mail_move ----

async function mailMove(args, ctx) {
  const s = ctx.settings;
  const ids = idsArg(args);
  if (typeof args.folder !== "string" || args.folder.trim() === "") fail("invalid_argument", "folder must name the target folder.");
  const copy = boolArg(args, "copy") === true;

  const accounts = accountsOf(ids);
  if (accounts.size !== 1) fail("refused", CROSS_ACCOUNT);
  const [accountId] = accounts;
  if (args.account !== undefined && args.account !== accountId) fail("refused", CROSS_ACCOUNT);
  assertFolderAllowed(accountId, args.folder, s);

  const run = newRun();
  const target = await folderByPath(run, accountId, args.folder);
  if (target.accountId !== accountId) fail("refused", CROSS_ACCOUNT);
  assertFolderAllowed(accountId, target.path, s);

  // Trash and Junk, and anything below them, are for mail_trash. The
  // Outbox holds mail queued to be sent: moving mail there could send it.
  const folders = await accountFolders(run, accountId);
  const within = (uses) => {
    const roots = folders.filter((f) => uses.some((u) => hasUse(f, u)));
    return uses.some((u) => hasUse(target, u)) || roots.some((f) => target.path.startsWith(f.path.replace(/\/+$/, "") + "/"));
  };
  if (within(["outbox"])) fail("refused", "mail_move may not target the Outbox: mail there is queued to be sent.");
  if (within(["trash", "junk"])) fail("refused", "Use mail_trash to remove mail; mail_move may not target Trash or Junk.");
  // A folder that only holds other folders, such as an IMAP \Noselect
  // parent, cannot take mail.
  const caps = await folderCapabilities(run, target);
  if (caps && caps.canAddMessages === false) fail("invalid_argument", "This folder cannot hold messages.");

  // The new id names the target folder; on IMAP the message may take a
  // moment to appear there. Thunderbird skips a copy into the message's
  // own folder without saying so, so that is refused.
  return forEachMessage(
    ids,
    run,
    s,
    async (h, id) => {
      if (h.folder.accountId !== accountId) fail("refused", CROSS_ACCOUNT);
      if (h.folder.path === target.path) {
        if (copy) fail("refused", "The message is already in this folder, and Thunderbird makes no copy there.");
        return id;
      }
      await api(run, () => (copy ? tb().messages.copy([h.id], target.id) : tb().messages.move([h.id], target.id)));
      return encodeId(accountId, target.path, h.headerMessageId);
    },
    copy ? "copied" : "moved",
  );
}

// ---- mail_archive ----

const NO_ARCHIVE = "Archiving is not available for this account: it has no archive folder of its own that MCP for Thunderbird can check.";
const NO_IDENTITY = "Archiving is not available for this account: it has no identities, so Thunderbird would use another account's archive folder.";
const ELSEWHERE = "Thunderbird may archive this account's mail into a folder of another account";

// checkArchive refuses to archive this account's mail unless every folder
// Thunderbird may archive it into is allowed and, as far as can be told,
// in the account. Thunderbird archives into the archive folder set for the
// identity it picks for the message: one of the account's own identities
// or, for an account without identities such as Local Folders, any
// identity. That folder may be in another account. The add-on API does not
// say which folder an identity archives into, but Thunderbird marks each
// identity's archive folder with the "archives" special use
// (nsMsgIdentity::setFolderPref moves the Archive flag to the folder an
// identity is set to, once that folder exists), so the marked folders stand
// for the possible targets. Any marked folder in an account that is not
// enabled, or that is excluded or holds an excluded folder, blocks
// archiving, since any identity may archive into it. A marked folder in
// another enabled account that has identities of its own is taken to be
// that account's. One in an account without identities (other than a feed
// account, whose archive folder holds its own feed items) can belong to any
// identity, so it blocks archiving from every other account.
function checkArchive(accountId, accounts, marked, s) {
  const account = accounts.find((a) => a && a.id === accountId);
  if (!account || !Array.isArray(account.identities) || account.identities.length === 0) fail("not_enabled", NO_IDENTITY);
  const own = marked.filter((f) => f.accountId === accountId);
  if (own.length === 0) fail("not_enabled", NO_ARCHIVE);
  for (const f of marked) {
    if (f.accountId === accountId) continue;
    if (!s.accounts || s.accounts[f.accountId] !== true) fail("not_enabled", `${ELSEWHERE}, and that account is not enabled.`);
    if (isExcluded(f.accountId, f.path, s) || holdsExcluded(f, s)) fail("excluded", `${ELSEWHERE}, and that folder is excluded or holds an excluded folder.`);
    const other = accounts.find((a) => a && a.id === f.accountId);
    const shared = !other || ((!Array.isArray(other.identities) || other.identities.length === 0) && other.type !== "rss");
    if (shared) fail("refused", `${ELSEWHERE}. ${CROSS_ACCOUNT}`);
  }
  // Thunderbird may file into year or month subfolders; if any excluded
  // folder of the account is at or under an archive folder, nothing is
  // archived.
  for (const f of own) {
    assertFolderAllowed(accountId, f.path, s);
    if (holdsExcluded(f, s)) fail("excluded", "An excluded folder is inside this account's archive folder.");
  }
}

// holdsExcluded tells whether an excluded folder is at or under folder f.
function holdsExcluded(f, s) {
  const root = f.path.replace(/\/+$/, "");
  return (s.excludedFolders || []).some((ex) => {
    if (!ex || ex.accountId !== f.accountId) return false;
    const ep = String(ex.path ?? "").replace(/\/+$/, "");
    return ep === root || ep.startsWith(root + "/");
  });
}

// Waits for Thunderbird's word on an archived message: the move event for a
// message still in sight (RECHECK_MS) and, once it has left its folder, for
// the event that names its new folder (EVENT_WAIT_MS). Both stay within the
// call's budget.
const RECHECK_MS = 500;
const EVENT_WAIT_MS = 3000;

// watchMoves collects messages.onMoved events while mail_archive runs, so it
// learns where Thunderbird put each message: the add-on is not told which
// folder an identity archives into, and Thunderbird may file into a year or
// month subfolder. Each event pairs the moved messages with their headers in
// the new folder; a message is known by the opaque id of its old place. On
// IMAP the event comes once Thunderbird has seen the message in the new
// folder, which can be after messages.archive has returned.
function watchMoves() {
  const ev = tb().messages.onMoved;
  const on = Boolean(ev && typeof ev.addListener === "function");
  const seen = new Map();
  const waiting = new Map();
  const listener = (from, to) => {
    const src = from && Array.isArray(from.messages) ? from.messages : [];
    const dst = to && Array.isArray(to.messages) ? to.messages : [];
    src.forEach((m, i) => {
      if (!m || !m.folder || typeof m.headerMessageId !== "string" || m.headerMessageId === "") return;
      const same = (x) => x && x.folder && x.headerMessageId === m.headerMessageId;
      const d = same(dst[i]) ? dst[i] : dst.find(same);
      if (!d) return;
      const key = encodeId(m.folder.accountId, m.folder.path, m.headerMessageId);
      seen.set(key, d);
      const w = waiting.get(key);
      if (w) w(d);
    });
  };
  if (on) ev.addListener(listener);
  return {
    seen: (id) => seen.get(id) || null,
    // wait resolves to the message's header in its new folder, or null when
    // no move of it is seen within ms and the run's budget.
    wait(run, id, ms) {
      if (seen.has(id)) return Promise.resolve(seen.get(id));
      const left = Math.min(ms, run.deadline - Date.now());
      if (!on || left <= 0) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(null);
        }, left);
        waiting.set(id, (d) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(d);
        });
      });
    },
    stop() {
      if (on) ev.removeListener(listener);
    },
  };
}

// stillThere tells whether the message is still in the folder its id
// names. Thunderbird leaves out messages marked deleted on IMAP.
async function stillThere(run, id) {
  const gone = (e) => {
    if (isToolError(e) && e.code === "not_found") return null;
    throw e;
  };
  return (await api(run, () => resolveId(id).catch(gone))) !== null;
}

// Thunderbird skips, without saying so, a message whose identity has
// archiving turned off.
const NOT_ARCHIVED = "Thunderbird did not archive the message: archiving may be turned off for its identity.";

async function mailArchive(args, ctx) {
  const s = ctx.settings;
  const ids = idsArg(args);
  const run = newRun();
  const accounts = answered(await call(run, () => tb().accounts.list(false)));
  const all = answered(await call(run, () => tb().folders.query({ specialUse: ["archives"] })));
  const marked = (Array.isArray(all) ? all : []).filter((f) => f && realFolder(f, f.accountId) && hasUse(f, "archives"));
  const checked = new Set();
  for (const accountId of accountsOf(ids)) {
    checkArchive(accountId, Array.isArray(accounts) ? accounts : [], marked, s);
    checked.add(accountId);
  }
  // A message counts as archived once Thunderbird reports its move or it
  // has left its folder. Its new id is given only for a folder the
  // settings allow.
  const allowed = (h) => h.folder && s.accounts && s.accounts[h.folder.accountId] === true && !isExcluded(h.folder.accountId, h.folder.path, s);
  const moves = watchMoves();
  try {
    return await forEachMessage(
      ids,
      run,
      s,
      async (h, id) => {
        if (!checked.has(h.folder.accountId)) fail("refused", CROSS_ACCOUNT);
        await api(run, () => tb().messages.archive([h.id]));
        let to = moves.seen(id);
        if (!to && (await stillThere(run, id))) {
          to = await moves.wait(run, id, RECHECK_MS);
          if (!to && (await stillThere(run, id))) fail("not_enabled", NOT_ARCHIVED);
        }
        if (!to) to = await moves.wait(run, id, EVENT_WAIT_MS);
        return to && allowed(to) ? encodeId(to.folder.accountId, to.folder.path, to.headerMessageId) : null;
      },
      "moved",
    );
  } finally {
    moves.stop();
  }
}

// ---- mail_trash ----

async function mailTrash(args, ctx) {
  const s = ctx.settings;
  const ids = idsArg(args);
  const run = newRun();
  const trash = new Map();
  for (const accountId of accountsOf(ids)) {
    const f = await specialFolder(run, accountId, "trash");
    if (!f) fail("refused", "This account has no Trash folder.");
    assertFolderAllowed(accountId, f.path, s);
    trash.set(accountId, f);
  }
  return forEachMessage(
    ids,
    run,
    s,
    async (h, id) => {
      const t = trash.get(h.folder.accountId);
      if (!t) fail("refused", CROSS_ACCOUNT);
      if (h.folder.path === t.path) return id;
      await api(run, () => tb().messages.move([h.id], t.id));
      return encodeId(h.folder.accountId, t.path, h.headerMessageId);
    },
    "moved",
  );
}

// ---- mail_tags ----

const COLOR = /^#[0-9A-Fa-f]{6}$/;

// mailTags lists Thunderbird's tags, so an AI app can find the names to
// give mail_tag and mail_search and read the keys in message lists. Tags
// belong to the whole profile, not to one account. Keys and labels are
// cleaned like headers.
async function mailTags() {
  const list = await tagList(newRun());
  return {
    tags: list
      .filter((t) => t && typeof t.key === "string" && t.key !== "")
      .map((t) => ({ key: clip(t.key), label: clip(t.tag), color: typeof t.color === "string" && COLOR.test(t.color) ? t.color : null })),
  };
}

HANDLERS.mail_mark = mailMark;
HANDLERS.mail_tag = mailTag;
HANDLERS.mail_move = mailMove;
HANDLERS.mail_archive = mailArchive;
HANDLERS.mail_trash = mailTrash;
HANDLERS.mail_tags = mailTags;
