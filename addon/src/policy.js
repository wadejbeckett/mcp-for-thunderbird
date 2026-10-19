/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Policy: the user's settings decide what a call may touch. Handlers call
// assertFolderAllowed again for every message and folder they reach.

import { fail } from "./errors.js";
import { groupOf, sendEnabled } from "./settings.js";
import { decodeId } from "./ids.js";

export const PAUSED_MESSAGE = "Paused by the user in Thunderbird";

const trimSlash = (p) => p.replace(/\/+$/, "");

// isExcluded matches an excluded folder and its subfolders. Paths are
// compared without trailing slashes; an entry that names the root (stored
// by hand, since save refuses it) excludes the whole account.
export function isExcluded(accountId, folderPath, s) {
  const path = trimSlash(String(folderPath));
  return (s.excludedFolders || []).some((ex) => {
    if (!ex || ex.accountId !== accountId) return false;
    const ep = trimSlash(String(ex.path ?? ""));
    return ep === "" || path === ep || path.startsWith(ep + "/");
  });
}

export function assertFolderAllowed(accountId, folderPath, s) {
  if (isExcluded(accountId, folderPath, s)) fail("excluded", "This folder is excluded in MCP for Thunderbird settings.");
}

export function assertAccountEnabled(accountId, s) {
  if (!s.accounts || s.accounts[accountId] !== true) fail("not_enabled", "This account is not enabled in MCP for Thunderbird.");
}

export function enabledAccountIds(s) {
  return Object.keys(s.accounts || {}).filter((id) => s.accounts[id] === true);
}

const CROSS_ACCOUNT = "Moving mail between accounts is not allowed.";

// check refuses a call the settings do not allow. Order: paused, tool
// group, argument types, account, the ids, then the folder. Policy owns the
// account and folder checks; handlers repeat assertFolderAllowed for every
// message they reach.
export function check(tool, args, s) {
  args = args || {};
  if (s.paused) fail("paused", PAUSED_MESSAGE);

  const group = groupOf(tool);
  if (!group) fail("invalid_argument", "Unknown tool.");
  if (group === "send" ? !sendEnabled(s) : !(s.groups && s.groups[group])) {
    fail("not_enabled", `The ${group} tools are turned off in MCP for Thunderbird.`);
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(args, k);
  if (has("account") && typeof args.account !== "string") fail("invalid_argument", "account must be a string.");
  if (has("id") && typeof args.id !== "string") fail("invalid_argument", "id must be a string.");
  if (has("ids") && !(Array.isArray(args.ids) && args.ids.every((x) => typeof x === "string"))) {
    fail("invalid_argument", "ids must be a list of strings.");
  }
  if (has("folder") && typeof args.folder !== "string") fail("invalid_argument", "folder must be a string.");

  if (has("account")) assertAccountEnabled(args.account, s);

  const ids = [];
  if (has("id")) ids.push(args.id);
  if (has("ids")) ids.push(...args.ids);
  const idAccounts = new Set();
  for (const id of ids) {
    const { accountId, folderPath } = decodeId(id);
    assertAccountEnabled(accountId, s);
    assertFolderAllowed(accountId, folderPath, s);
    if (has("account") && accountId !== args.account) fail("refused", CROSS_ACCOUNT);
    idAccounts.add(accountId);
  }

  if (has("folder")) {
    if (idAccounts.size > 1) fail("refused", CROSS_ACCOUNT);
    const accounts = new Set(idAccounts);
    if (has("account")) accounts.add(args.account);
    if (accounts.size === 0) {
      const enabled = enabledAccountIds(s);
      if (enabled.length !== 1) fail("invalid_argument", "Name the account for this folder.");
      accounts.add(enabled[0]);
    }
    for (const a of accounts) assertFolderAllowed(a, args.folder, s);
  }
}
