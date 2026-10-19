/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Logic shared by the setup, options and popup pages. No DOM here.

import { LEVELS } from "../src/settings.js";
import { isPlainAddress, isPlainDomain } from "../src/address.js";

export const RESTART_NOTE = "If an AI app does not see changes, restart it.";
export const MAX_ALLOWLIST = 200;

const STATES = Object.freeze({
  connected: { label: "Connected", className: "connected" },
  paused: { label: "Paused", className: "paused" },
  not_connected: { label: "Not connected", className: "not-connected" },
  mismatch: { label: "Update needed", className: "mismatch" },
});

// renderState maps the background's state to the words and style the
// pages show.
export function renderState(state) {
  return STATES[state] || STATES.not_connected;
}

// levelToGroups returns the tool groups a setup level switches on.
export function levelToGroups(level) {
  const groups = LEVELS[level];
  if (!groups) throw new Error(`Unknown level: ${level}`);
  return { ...groups };
}

const NON_ASCII = /[^\x00-\x7f]/;

function checkEntry(raw) {
  if (NON_ASCII.test(raw)) {
    return "Use the punycode form (xn--...) for names with accented or non-Latin letters.";
  }
  if (raw.startsWith("@")) {
    return isPlainDomain(raw.slice(1)) ? null : "Not a valid domain. Write it like @example.com.";
  }
  if (raw.includes("@")) {
    return isPlainAddress(raw) ? null : "Not a valid address. Use letters, digits and . _ + - before the @.";
  }
  return isPlainDomain(raw) ? null : "Not a valid address or domain.";
}

// parseAllowlist reads the textarea: one address, @domain or domain per
// line, checked with the same rule mail_send uses. It returns the
// lower-cased, de-duplicated entries and one error per bad line.
export function parseAllowlist(text) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  String(text ?? "")
    .split(/\r\n|\r|\n/)
    .forEach((line, i) => {
      const raw = line.trim();
      if (raw === "") return;
      const problem = checkEntry(raw);
      if (problem) {
        errors.push({ line: i + 1, text: raw.slice(0, 80), message: problem });
        return;
      }
      const entry = raw.toLowerCase();
      if (!seen.has(entry)) {
        seen.add(entry);
        entries.push(entry);
      }
    });
  if (entries.length > MAX_ALLOWLIST) {
    errors.push({ line: 0, text: "", message: `At most ${MAX_ALLOWLIST} entries.` });
  }
  return { entries, errors };
}

// isAbsolutePath accepts /posix/paths, C:\windows\paths and \\server\share.
export function isAbsolutePath(p) {
  if (typeof p !== "string" || p.includes("\0")) return false;
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
}

const OUTCOMES = Object.freeze({
  ok: "Done",
  paused: "Refused: paused",
  not_enabled: "Refused: not switched on",
  excluded: "Refused: excluded folder",
  not_found: "Not found",
  invalid_argument: "Refused: invalid request",
  refused: "Refused",
  too_large: "Too large",
  thunderbird_error: "Thunderbird error",
});

// describeEntry turns a log entry into the text a page shows.
export function describeEntry(e) {
  let when = String(e.time ?? "");
  const d = new Date(when);
  if (!Number.isNaN(d.getTime())) when = d.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
  return { when, client: e.client || "unknown", tool: e.tool || "", outcome: OUTCOMES[e.outcome] || e.outcome || "" };
}
