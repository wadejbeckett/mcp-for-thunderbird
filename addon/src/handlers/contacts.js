/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// mail_contacts: searches the local address books and returns names,
// addresses and organisations from each contact's vCard. Remote (LDAP)
// books are left out so a slow directory cannot stall the call. The
// list-and-filter fallback follows the vitalio-sh "thunderbird-cli"
// extension (seed commit 465613d), MIT licence, see NOTICE.

import { HANDLERS } from "../rpc.js";
import { fail } from "../errors.js";
import { limitArg } from "./read.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

function unescapeValue(v) {
  return v.replace(/\\([\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function splitUnescaped(v) {
  const out = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && i + 1 < v.length) {
      cur += v[i] + v[i + 1];
      i++;
    } else if (v[i] === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += v[i];
    }
  }
  out.push(cur);
  return out;
}

// parseVCard reads FN (or N), every EMAIL and the first ORG component.
export function parseVCard(text) {
  const lines = String(text ?? "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/);
  let fn = "";
  let n = "";
  let org = "";
  const emails = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const prop = line.slice(0, i).split(";")[0].replace(/^.*\./, "").toUpperCase();
    const value = line.slice(i + 1);
    if (prop === "FN" && !fn) {
      fn = unescapeValue(value).trim();
    } else if (prop === "N" && !n) {
      const p = splitUnescaped(value).map((x) => unescapeValue(x).trim());
      n = [p[1], p[0]].filter(Boolean).join(" ");
    } else if (prop === "EMAIL") {
      const e = unescapeValue(value).trim();
      if (e && !emails.includes(e)) emails.push(e);
    } else if (prop === "ORG" && !org) {
      org = unescapeValue(splitUnescaped(value)[0]).trim();
    }
  }
  return { name: fn || n, emails, organisation: org };
}

function matches(c, terms) {
  const hay = [c.name, ...c.emails].map((x) => x.toLowerCase());
  return terms.every((t) => hay.some((h) => h.includes(t)));
}

async function mailContacts(args) {
  const query = args.query;
  if (typeof query !== "string" || query.trim() === "") fail("invalid_argument", "query must be a non-empty string.");
  const limit = limitArg(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const books = globalThis.messenger.addressBooks;
  let nodes;
  let filter = false;
  if (books.contacts && typeof books.contacts.query === "function") {
    nodes = await books.contacts.query({ searchString: query, includeRemote: false });
  } else {
    filter = true;
    nodes = [];
    for (const b of (await books.list(false)) || []) {
      if (b.remote) continue;
      nodes.push(...((await books.contacts.list(b.id)) || []));
    }
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const contacts = [];
  for (const node of nodes || []) {
    if (contacts.length >= limit) break;
    const c = parseVCard(node && node.vCard);
    if (!c.name && c.emails.length === 0) continue;
    if (filter && !matches(c, terms)) continue;
    contacts.push(c);
  }
  return { contacts };
}

HANDLERS.mail_contacts = mailContacts;
