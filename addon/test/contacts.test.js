/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { install, fetchFrom } from "./mocks/messenger.js";
import { dispatch } from "../src/rpc.js";
import { save } from "../src/settings.js";
import "../src/handlers/contacts.js";

const vcard = (lines) => ["BEGIN:VCARD", "VERSION:4.0", ...lines, "END:VCARD"].join("\r\n");

const BOOKS = [
  {
    id: "book1",
    name: "Personal",
    contacts: [
      vcard(["FN:Ann Example", "EMAIL;PREF=1:ann@example.org", "item1.EMAIL;TYPE=work:ann@work.example", "ORG:Example\\, Inc.;Sales"]),
      vcard(["N:Builder;Bob;;;", "EMAIL:bob@example.org"]),
      vcard(["FN:Carol Long-Name-Th", " at Folds", "EMAIL:carol@example.org"]),
    ],
  },
  { id: "book2", name: "Remote", remote: true, contacts: [vcard(["FN:Ann Remote", "EMAIL:ann@remote.example"])] },
];

let mock;
beforeEach(async () => {
  mock = install({ accounts: [{ id: "a1", name: "Work", type: "imap", folders: ["INBOX"] }], books: BOOKS });
  globalThis.fetch = fetchFrom({});
  await save({ accounts: { a1: true } });
});

const call = (args) => dispatch({ type: "call", id: "c1", tool: "mail_contacts", args, client: "test" });

test("TestContactsOnlyWhenGroupOn", async () => {
  const off = await call({ query: "ann" });
  assert.equal(off.ok, false);
  assert.equal(off.error.code, "not_enabled");
  assert.equal(mock.calls.contactsQuery.length, 0);

  await save({ groups: { contacts: true } });
  const on = await call({ query: "ann" });
  assert.equal(on.ok, true, JSON.stringify(on.error));
  assert.deepEqual(on.content, {
    contacts: [{ name: "Ann Example", emails: ["ann@example.org", "ann@work.example"], organisation: "Example, Inc." }],
  });
  assert.equal(mock.calls.contactsQuery[0].searchString, "ann");
  assert.equal(mock.calls.contactsQuery[0].includeRemote, false);
});

test("contacts parse N when FN is missing and unfold folded lines", async () => {
  await save({ groups: { contacts: true } });
  const bob = await call({ query: "bob" });
  assert.deepEqual(bob.content.contacts, [{ name: "Bob Builder", emails: ["bob@example.org"], organisation: "" }]);
  const carol = await call({ query: "carol" });
  assert.equal(carol.content.contacts[0].name, "Carol Long-Name-That Folds");
});

test("contacts limit defaults to 25 and is clamped to 200", async () => {
  const many = Array.from({ length: 250 }, (_, i) => vcard([`FN:Person ${i}`, `EMAIL:p${i}@example.org`]));
  mock = install({ accounts: [{ id: "a1", name: "Work", type: "imap", folders: [] }], books: [{ id: "b", name: "B", contacts: many }] });
  await save({ accounts: { a1: true }, groups: { contacts: true } });
  assert.equal((await call({ query: "person" })).content.contacts.length, 25);
  assert.equal((await call({ query: "person", limit: 1000 })).content.contacts.length, 200);
  assert.equal((await call({ query: "person", limit: 3 })).content.contacts.length, 3);
});

test("contacts need a query", async () => {
  await save({ groups: { contacts: true } });
  for (const args of [{}, { query: "" }, { query: 5 }]) {
    assert.equal((await call(args)).error.code, "invalid_argument");
  }
});

test("contacts fall back to listing address books when query is missing", async () => {
  await save({ groups: { contacts: true } });
  delete mock.messenger.addressBooks.contacts.query;
  const r = await call({ query: "ANN" });
  assert.deepEqual(
    r.content.contacts.map((c) => c.name),
    ["Ann Example"],
  );
});
