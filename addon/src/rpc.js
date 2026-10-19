/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tool call dispatch: policy check, handler, activity log, error mapping.

import { isToolError } from "./errors.js";
import { load, groupOf } from "./settings.js";
import { check } from "./policy.js";
import { append } from "./log.js";
import { decodeId } from "./ids.js";
import { PAUSED_MESSAGE } from "./policy.js";

// HANDLERS maps a tool name to async (args, ctx) => content. The handler
// modules fill it in.
export const HANDLERS = Object.create(null);

const SAVE = Symbol("save");

// withSave makes a handler result that also asks the host to write a file
// ({name, data} with data base64) into the attachment folder.
export function withSave(content, save) {
  return { [SAVE]: save, content };
}

const GENERIC = "Thunderbird could not complete the request.";

const MAX_TARGETS = 20;
const MAX_TARGET_CHARS = 200;

function validId(id) {
  try {
    decodeId(id);
    return true;
  } catch {
    return false;
  }
}

// targets lists what the call names: opaque ids that decode (anything else
// is logged as "<invalid>") and the folder path; at most 20 entries of at
// most 200 characters each.
function targetsOf(args) {
  const t = [];
  if (!args || typeof args !== "object") return t;
  const ids = [];
  if ("id" in args) ids.push(args.id);
  if (Array.isArray(args.ids)) ids.push(...args.ids);
  for (const id of ids) t.push(validId(id) ? id : "<invalid>");
  if (typeof args.folder === "string") t.push(args.folder);
  return t.slice(0, MAX_TARGETS).map((x) => x.slice(0, MAX_TARGET_CHARS));
}

// resolveAccountName maps an account given by name to its id, so policy
// and handlers see ids only. Unknown names are left for policy to refuse.
async function resolveAccountName(args, s) {
  if (!args || typeof args.account !== "string" || s.accounts[args.account] !== undefined) return args;
  const accounts = await globalThis.messenger.accounts.list(false);
  const want = args.account.toLowerCase();
  const hit = accounts.filter((a) => typeof a.name === "string" && a.name.toLowerCase() === want);
  return hit.length === 1 ? { ...args, account: hit[0].id } : args;
}

export async function dispatch(call) {
  const client = typeof call.client === "string" && call.client ? call.client : "unknown";
  const argsOk = call.args == null || (typeof call.args === "object" && !Array.isArray(call.args));
  let args = argsOk && call.args ? call.args : {};
  const targets = targetsOf(args);
  let msg;
  try {
    const s = await load();
    if (s.paused) throw { code: "paused", message: PAUSED_MESSAGE };
    if (!groupOf(call.tool)) throw { code: "invalid_argument", message: "Unknown tool." };
    if (!argsOk) throw { code: "invalid_argument", message: "Arguments must be an object." };
    args = await resolveAccountName(args, s);
    check(call.tool, args, s);
    const handler = HANDLERS[call.tool];
    if (!handler) throw { code: "invalid_argument", message: "This tool is not available in this version of MCP for Thunderbird." };
    const out = await handler(args, { client, settings: s, tool: call.tool });
    msg = { type: "result", id: call.id, ok: true };
    if (out && typeof out === "object" && SAVE in out) {
      msg.content = out.content;
      msg.save = out[SAVE];
    } else {
      msg.content = out === undefined ? null : out;
    }
  } catch (e) {
    const error = isToolError(e) ? { code: e.code, message: e.message } : { code: "thunderbird_error", message: GENERIC };
    msg = { type: "result", id: call.id, ok: false, error };
  }
  try {
    await append({ time: new Date().toISOString(), client, tool: String(call.tool), targets, outcome: msg.ok ? "ok" : msg.error.code });
  } catch {
    // the log must never fail a call
  }
  return msg;
}
