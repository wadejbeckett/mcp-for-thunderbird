/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// mail_contacts: searches the local address books and returns names,
// addresses and organisations from each contact's vCard, with the names of
// the address books each contact is in. Remote (LDAP) books are left out so
// a slow directory cannot stall the call. `book` limits the search to the
// local books with that name or id. A person in two books (Thunderbird
// collects outgoing recipients into Collected Addresses) is returned once,
// with both book names and all their addresses: a contact that shares an
// address (any case) with one already returned is a repeat, and so is a
// contact with no address whose name and organisation were already
// returned. A repeat does not take one of the `limit` places. With
// `include_lists`, mailing lists whose name or nickname holds every
// search word are returned too, each with its members. Search words are
// split as Thunderbird's own search splits them (searchTokens), so lists
// and contacts match the same words. `truncated` is true when more
// contacts or lists matched than `limit`. Address books belong to the
// whole profile, not to one account, so policy refuses an `account`. The
// list-and-filter fallback follows the vitalio-sh "thunderbird-cli"
// extension (seed commit 465613d), MIT licence, see NOTICE.
//
// A contact can come from a message (Thunderbird collects addresses), so
// its fields are shown like header values outside the untrusted wrapper:
// cleaned by clip (invisible characters removed, markers defused, at
// most 2000 characters), with at most 200 addresses a contact. Book and
// list names are cleaned the same way, and a list gives at most 200
// members.

import { HANDLERS } from "../rpc.js";
import { fail } from "../errors.js";
import { limitArg, clip, clipList } from "./read.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
export const MAX_MEMBERS = 200;
const MAX_ADDRESSES = 200;

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

// cleaned gives a contact's fields as they are returned.
function cleaned(c) {
  const emails = [...new Set(clipList(c.emails))].filter(Boolean);
  return { name: clip(c.name), emails, organisation: clip(c.organisation) };
}

function matches(fields, terms) {
  const hay = fields.filter(Boolean).map((x) => String(x).toLowerCase());
  return terms.every((t) => hay.some((h) => h.includes(t)));
}

// searchTokens splits a query into search words the way Thunderbird's
// ABQueryUtils.getSearchTokens does for addressBooks.contacts.query: a
// quoted "foo bar" is one word without its quotes (an unclosed quote runs
// to the end), and the rest is split on spaces and commas. Lower-cased.
export function searchTokens(query) {
  let rest = String(query).replace(/^[,\s]+/, "").replace(/[,\s]+$/, "");
  const words = [];
  let start;
  while ((start = rest.indexOf('"')) !== -1) {
    let end = rest.indexOf('"', start + 1);
    if (end === -1) end = rest.length;
    words.push(rest.slice(start + 1, end));
    rest = (rest.slice(0, start) + rest.slice(end + 1)).trim();
  }
  if (rest) words.push(...rest.split(/[,\s]+/));
  return words.map((w) => w.toLowerCase()).filter(Boolean);
}

// people keeps one entry for each person among cleaned contacts. A contact
// that shares an address (any case) with a kept entry is the same person;
// one with no address is the same person as a kept entry with no address
// and the same name and organisation. Two people with one name and no
// address but different organisations stay apart.
function people() {
  const byAddress = new Map();
  const byName = new Map();
  const nameKey = (c) => c.name.toLowerCase() + "\n" + c.organisation.toLowerCase();
  return {
    find(c) {
      if (c.emails.length === 0) return byName.get(nameKey(c));
      for (const e of c.emails) {
        const seen = byAddress.get(e.toLowerCase());
        if (seen) return seen;
      }
      return undefined;
    },
    keep(entry) {
      if (entry.emails.length === 0) byName.set(nameKey(entry), entry);
      for (const e of entry.emails) if (!byAddress.has(e.toLowerCase())) byAddress.set(e.toLowerCase(), entry);
      return entry;
    },
    // merge adds the repeat's addresses the entry does not have yet, up to
    // MAX_ADDRESSES, the 200 a contact's own clipList keeps.
    merge(entry, c) {
      for (const e of c.emails) {
        if (entry.emails.length >= MAX_ADDRESSES) break;
        if (byAddress.has(e.toLowerCase())) continue;
        entry.emails.push(e);
        byAddress.set(e.toLowerCase(), entry);
      }
    },
  };
}

// localBooks returns the local address books to search: all of them, or
// those whose id or name (any case) is `book`.
async function localBooks(books, book) {
  const all = ((await books.list(false)) || []).filter((b) => b && typeof b.id === "string");
  const local = all.filter((b) => !b.remote);
  if (book == null) return local;
  if (typeof book !== "string" || book.trim() === "") fail("invalid_argument", "book must be a non-empty string.");
  const want = book.trim().toLowerCase();
  const named = (b) => b.id === book || String(b.name ?? "").toLowerCase() === want;
  const chosen = local.filter(named);
  if (chosen.length) return chosen;
  if (all.some(named)) fail("refused", "Remote (LDAP) address books are not searched.");
  fail("not_found", "No local address book has that name.");
}

// findNodes returns the contact nodes that match the query in the chosen
// books, in the order of the books.
async function findNodes(books, chosen, query, terms, whole) {
  const order = new Map(chosen.map((b, i) => [b.id, i]));
  let nodes = [];
  if (books.contacts && typeof books.contacts.query === "function") {
    if (whole) {
      nodes = (await books.contacts.query({ searchString: query, includeRemote: false })) || [];
    } else {
      for (const b of chosen) nodes.push(...((await books.contacts.query({ searchString: query, includeRemote: false, parentId: b.id })) || []));
    }
  } else if (books.contacts && typeof books.contacts.list === "function") {
    for (const b of chosen) {
      for (const node of (await books.contacts.list(b.id)) || []) {
        const c = parseVCard(node && node.vCard);
        if (matches([c.name, ...c.emails], terms)) nodes.push(node);
      }
    }
  } else {
    fail("not_supported", "This Thunderbird cannot search address books.");
  }
  nodes = nodes.filter((n) => n && order.has(n.parentId));
  return nodes.sort((a, b) => order.get(a.parentId) - order.get(b.parentId));
}

// findLists returns the mailing lists, at most limit, whose name or
// nickname holds every term, with their members, and whether more matched.
async function findLists(books, chosen, terms, limit) {
  const api = books.mailingLists;
  if (!api || typeof api.list !== "function") fail("not_supported", "This Thunderbird cannot list mailing lists.");
  const lists = [];
  for (const b of chosen) {
    for (const node of (await api.list(b.id)) || []) {
      if (!node || !matches([node.name, node.nickName], terms)) continue;
      if (lists.length >= limit) return { lists, truncated: true };
      const members = [];
      const seen = people();
      let membersTruncated = false;
      for (const m of (await api.listMembers(node.id)) || []) {
        const c = cleaned(parseVCard(m && m.vCard));
        if (!c.name && c.emails.length === 0) continue;
        const repeat = seen.find(c);
        if (repeat) {
          seen.merge(repeat, c);
          continue;
        }
        if (members.length >= MAX_MEMBERS) {
          membersTruncated = true;
          break;
        }
        members.push(seen.keep(c));
      }
      lists.push({ name: clip(node.name), nickName: clip(node.nickName), book: clip(b.name), members, membersTruncated });
    }
  }
  return { lists, truncated: false };
}

async function mailContacts(args) {
  const query = args.query;
  if (typeof query !== "string" || query.trim() === "") fail("invalid_argument", "query must be a non-empty string.");
  if (args.include_lists != null && typeof args.include_lists !== "boolean") fail("invalid_argument", "include_lists must be true or false.");
  const limit = limitArg(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const books = globalThis.messenger.addressBooks;
  const chosen = await localBooks(books, args.book);
  const terms = searchTokens(query);
  const nodes = await findNodes(books, chosen, query, terms, args.book == null);
  const names = new Map(chosen.map((b) => [b.id, clip(b.name)]));

  // Every match is read, after the limit too, so that a returned contact
  // lists all its books.
  const contacts = [];
  const seen = people();
  let truncated = false;
  for (const node of nodes) {
    const c = cleaned(parseVCard(node.vCard));
    if (!c.name && c.emails.length === 0) continue;
    const book = names.get(node.parentId);
    const repeat = seen.find(c);
    if (repeat) {
      seen.merge(repeat, c);
      if (!repeat.books.includes(book)) repeat.books.push(book);
    } else if (contacts.length >= limit) {
      truncated = true;
    } else {
      contacts.push(seen.keep({ ...c, books: [book] }));
    }
  }
  if (!args.include_lists) return { contacts, truncated };
  const found = await findLists(books, chosen, terms, limit);
  return { contacts, lists: found.lists, truncated: truncated || found.truncated };
}

HANDLERS.mail_contacts = mailContacts;
