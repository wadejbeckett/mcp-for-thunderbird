/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tool call dispatch: policy check, handler, activity log, error mapping.

import { isToolError } from "./errors.js";
import { load, groupOf } from "./settings.js";
import { check } from "./policy.js";
import { append } from "./log.js";

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

// targets lists what the call names: opaque ids and folder paths only.
function targetsOf(args) {
  const t = [];
  if (!args || typeof args !== "object") return t;
  if (typeof args.id === "string") t.push(args.id);
  if (Array.isArray(args.ids)) t.push(...args.ids.filter((x) => typeof x === "string"));
  if (typeof args.folder === "string") t.push(args.folder);
  return t;
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
  let args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
  const targets = targetsOf(args);
  let msg;
  try {
    if (!groupOf(call.tool)) throw { code: "invalid_argument", message: "Unknown tool." };
    const s = await load();
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
