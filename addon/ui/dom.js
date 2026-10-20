/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Small DOM helpers shared by the pages. Text is always set with
// textContent, never as markup.

import { renderState, describeEntry } from "./logic.js";

export const byId = (doc, id) => doc.getElementById(id);

// showState shows the state; detail (the host's reason for a host
// problem) follows the label.
export function showState(doc, el, state, detail) {
  const r = renderState(state);
  el.textContent = typeof detail === "string" && detail ? `${r.label}: ${detail}` : r.label;
  el.className = `state ${r.className}`;
}

export function showLog(doc, list, emptyNote, entries) {
  list.replaceChildren();
  for (const e of entries) {
    const d = describeEntry(e);
    const li = doc.createElement("li");
    const when = doc.createElement("span");
    when.className = "when";
    when.textContent = d.when;
    li.append(when, ` ${d.client}: ${d.tool}, ${d.outcome}`);
    list.append(li);
  }
  emptyNote.hidden = entries.length > 0;
}

// field makes a labelled checkbox row. Extra attributes go on the input.
export function checkboxRow(doc, text, attrs, checked, note) {
  const label = doc.createElement("label");
  const input = doc.createElement("input");
  input.type = "checkbox";
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  input.checked = checked;
  label.append(input, ` ${text}`);
  if (note) {
    const hint = doc.createElement("span");
    hint.className = "hint";
    hint.textContent = note;
    label.append(hint);
  }
  return { label, input };
}

export function messageOf(e, fallback) {
  return e && typeof e.message === "string" && e.message ? e.message : fallback;
}

// realDeps are what the pages use inside Thunderbird.
export function realDeps() {
  const m = globalThis.messenger;
  return {
    m,
    send: (msg) => m.runtime.sendMessage(msg),
    clipboard: globalThis.navigator.clipboard,
    confirm: (text) => globalThis.confirm(text),
  };
}

export const inPage = () => typeof globalThis.document !== "undefined" && Boolean(globalThis.messenger) && !globalThis.MFT_NO_AUTOSTART;
