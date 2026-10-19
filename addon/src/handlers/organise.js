/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Organise handlers: mail_mark, mail_tag, mail_move, mail_archive and
// mail_trash. Each returns {done: [ids], failed: [{id, code}]}; one bad id
// does not stop the others. Nothing here ever calls messages.delete:
// mail_trash moves to the account's Trash folder.
//
// Policy has already refused ids in disabled accounts or excluded folders,
// ids and an `account` argument that disagree, and an excluded target
// folder (Review Focus 1). The handlers resolve the target inside the
// messages' own account, refuse Trash and Junk as a move target, and check
// every message and target folder again.
//
// Every Thunderbird call goes through read.js's call(), with one 10 s
// budget (SEARCH.budgetMs) for the whole tool call; ids reached after the
// budget is spent fail with thunderbird_error.

import { HANDLERS } from "../rpc.js";
import { decodeId, resolveId } from "../ids.js";
import { assertFolderAllowed } from "../policy.js";
import { fail, isToolError } from "../errors.js";
import { call, newRun, answered, folderByPath, realFolder } from "./read.js";

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
// settings and runs fn(header). A failure of one id is reported, not thrown.
async function forEachMessage(ids, run, s, fn) {
  const out = { done: [], failed: [] };
  for (const id of ids) {
    try {
      const h = answered(await call(run, () => resolveId(id)));
      assertFolderAllowed(h.folder.accountId, h.folder.path, s);
      await fn(h);
      out.done.push(id);
    } catch (e) {
      out.failed.push({ id, code: isToolError(e) ? e.code : "thunderbird_error" });
    }
  }
  return out;
}

// api runs one Thunderbird call within the budget.
async function api(run, fn) {
  return answered(await call(run, fn));
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

// tagKey maps a tag key or label (case-insensitive) to the key.
function tagKey(list, value) {
  const want = value.toLowerCase();
  const t = list.find((x) => x && (x.key === value || String(x.tag ?? "").toLowerCase() === want));
  if (!t || typeof t.key !== "string") fail("invalid_argument", `Unknown tag: ${value}`);
  return t.key;
}

async function mailTag(args, ctx) {
  const add = tagNames(args, "add");
  const remove = tagNames(args, "remove");
  if (add.length === 0 && remove.length === 0) fail("invalid_argument", "Give tags to add, remove or both.");
  const ids = idsArg(args);
  const run = newRun();
  const list = await api(run, () => tb().messages.tags.list());
  if (!Array.isArray(list)) fail("thunderbird_error", "Thunderbird did not list its tags.");
  const addKeys = add.map((t) => tagKey(list, t));
  const removeKeys = new Set(remove.map((t) => tagKey(list, t)));
  return forEachMessage(ids, run, ctx.settings, (h) => {
    const tags = [...new Set([...(h.tags || []), ...addKeys])].filter((k) => !removeKeys.has(k));
    return api(run, () => tb().messages.update(h.id, { tags }));
  });
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

  // Trash and Junk, and anything below them, are for mail_trash.
  const barred = (await accountFolders(run, accountId)).filter((f) => hasUse(f, "trash") || hasUse(f, "junk"));
  const inBarred = hasUse(target, "trash") || hasUse(target, "junk") || barred.some((f) => target.path.startsWith(f.path.replace(/\/+$/, "") + "/"));
  if (inBarred) fail("refused", "Use mail_trash to remove mail; mail_move may not target Trash or Junk.");

  return forEachMessage(ids, run, s, async (h) => {
    if (h.folder.accountId !== accountId) fail("refused", CROSS_ACCOUNT);
    if (!copy && h.folder.path === target.path) return;
    await api(run, () => (copy ? tb().messages.copy([h.id], target.id) : tb().messages.move([h.id], target.id)));
  });
}

// ---- mail_archive ----

async function mailArchive(args, ctx) {
  const s = ctx.settings;
  const ids = idsArg(args);
  const run = newRun();
  // Thunderbird picks the archive folder (and year subfolders); where the
  // account has one and it is excluded, nothing is archived.
  for (const accountId of accountsOf(ids)) {
    const f = await specialFolder(run, accountId, "archive");
    if (f) assertFolderAllowed(accountId, f.path, s);
  }
  return forEachMessage(ids, run, s, (h) => api(run, () => tb().messages.archive([h.id])));
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
  return forEachMessage(ids, run, s, async (h) => {
    const t = trash.get(h.folder.accountId);
    if (!t) fail("refused", CROSS_ACCOUNT);
    if (h.folder.path === t.path) return;
    await api(run, () => tb().messages.move([h.id], t.id));
  });
}

HANDLERS.mail_mark = mailMark;
HANDLERS.mail_tag = mailTag;
HANDLERS.mail_move = mailMove;
HANDLERS.mail_archive = mailArchive;
HANDLERS.mail_trash = mailTrash;
