/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Policy: the user's settings decide what a call may touch. Handlers call
// assertFolderAllowed again for every message and folder they reach.

import { fail } from "./errors.js";
import { groupOf, sendEnabled } from "./settings.js";
import { decodeId } from "./ids.js";

export const PAUSED_MESSAGE = "Paused by the user in Thunderbird";

export function isExcluded(accountId, folderPath, s) {
  return (s.excludedFolders || []).some(
    (ex) => ex.accountId === accountId && (folderPath === ex.path || folderPath.startsWith(ex.path + "/")),
  );
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

// check refuses a call the settings do not allow. Order: paused, tool
// group, account, then the ids and folder named in the arguments.
export function check(tool, args, s) {
  args = args || {};
  if (s.paused) fail("paused", PAUSED_MESSAGE);

  const group = groupOf(tool);
  if (!group) fail("invalid_argument", "Unknown tool.");
  if (group === "send" ? !sendEnabled(s) : !(s.groups && s.groups[group])) {
    fail("not_enabled", `The ${group} tools are turned off in MCP for Thunderbird.`);
  }

  if (args.account != null) assertAccountEnabled(args.account, s);

  const ids = [];
  if (typeof args.id === "string") ids.push(args.id);
  if (Array.isArray(args.ids)) ids.push(...args.ids);
  for (const id of ids) {
    const { accountId, folderPath } = decodeId(id);
    assertAccountEnabled(accountId, s);
    assertFolderAllowed(accountId, folderPath, s);
  }

  if (typeof args.folder === "string") {
    let accountId = args.account;
    if (accountId == null) {
      const enabled = enabledAccountIds(s);
      if (enabled.length === 1) accountId = enabled[0];
    }
    if (accountId != null) assertFolderAllowed(accountId, args.folder, s);
  }
}
