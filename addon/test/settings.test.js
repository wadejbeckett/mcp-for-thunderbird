/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { install, fetchFrom } from "./mocks/messenger.js";
import { DEFAULTS, LEVELS, GROUPS, load, save, enabledTools, followFolder } from "../src/settings.js";
import { isExcluded } from "../src/policy.js";

const READ = ["mail_accounts", "mail_folders", "mail_search", "mail_read", "mail_thread", "mail_attachment", "mail_filter_suggest", "mail_tags"];
const ORGANISE = ["mail_mark", "mail_tag", "mail_move", "mail_archive", "mail_trash"];
const COMPOSE = ["mail_draft", "mail_compose"];

let mock;
beforeEach(() => {
  mock = install();
  globalThis.fetch = fetchFrom({});
});

test("DEFAULTS match the Global Constraints", () => {
  assert.deepEqual(DEFAULTS.accounts, {});
  assert.deepEqual(DEFAULTS.groups, { read: true, organise: true, compose: false, contacts: false });
  assert.deepEqual(DEFAULTS.send, { enabled: false, allow: [] });
  assert.equal(DEFAULTS.paused, false);
  assert.equal(DEFAULTS.setupDone, false);
  assert.equal(DEFAULTS.attachmentDir, "");
  assert.deepEqual(DEFAULTS.excludedFolders, []);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test("tool groups match the shared contract", () => {
  assert.deepEqual(GROUPS.read, READ);
  assert.deepEqual(GROUPS.contacts, ["mail_contacts"]);
  assert.deepEqual(GROUPS.organise, ORGANISE);
  assert.deepEqual(GROUPS.compose, COMPOSE);
  assert.deepEqual(GROUPS.send, ["mail_send"]);
});

test("enabledTools for each level", () => {
  const s = (groups) => ({ ...DEFAULTS, groups });
  assert.deepEqual(enabledTools(s(LEVELS.read_only)), READ);
  assert.deepEqual(enabledTools(s(LEVELS.read_organise)), [...READ, ...ORGANISE]);
  assert.deepEqual(enabledTools(s(LEVELS.read_organise_draft)), [...READ, ...ORGANISE, ...COMPOSE]);
  assert.deepEqual(enabledTools(s({ ...LEVELS.read_only, contacts: true })), [...READ, "mail_contacts"]);
  assert.deepEqual(enabledTools(DEFAULTS), [...READ, ...ORGANISE]);
});

test("mail_send appears only with send.enabled and a non-empty allowlist", () => {
  const s = (send) => ({ ...DEFAULTS, send });
  assert.equal(enabledTools(s({ enabled: true, allow: [] })).includes("mail_send"), false);
  assert.equal(enabledTools(s({ enabled: false, allow: ["a@b.test"] })).includes("mail_send"), false);
  assert.equal(enabledTools(s({ enabled: true, allow: ["a@b.test"] })).at(-1), "mail_send");
});

test("load on empty storage gives defaults and a kept 32-hex instance", async () => {
  const s = await load();
  assert.match(s.instance, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...s, instance: "" }, { ...DEFAULTS, instance: "" });
  const again = await load();
  assert.equal(again.instance, s.instance);
  assert.equal((await mock.messenger.storage.local.get("settings")).settings.instance, s.instance);
});

test("save merges groups and send and keeps the instance", async () => {
  const first = await load();
  const s = await save({ groups: { compose: true }, send: { allow: ["x@y.test"] }, accounts: { a1: true } });
  assert.deepEqual(s.groups, { read: true, organise: true, compose: true, contacts: false });
  assert.deepEqual(s.send, { enabled: false, allow: ["x@y.test"] });
  assert.deepEqual(s.accounts, { a1: true });
  assert.equal(s.instance, first.instance);
  assert.deepEqual(await load(), s);
});

test("e2e-settings.json seeds empty storage only (R2)", async () => {
  globalThis.fetch = fetchFrom({ "e2e-settings.json": { accounts: { acc1: true }, setupDone: true, attachmentDir: "/tmp/x" } });
  const s = await load();
  assert.deepEqual(s.accounts, { acc1: true });
  assert.equal(s.setupDone, true);
  assert.equal(s.attachmentDir, "/tmp/x");
  assert.deepEqual(s.groups, DEFAULTS.groups);

  // Stored settings win over the package file from then on.
  await save({ accounts: {} });
  assert.deepEqual((await load()).accounts, {});
});

test("e2e-settings.json is ignored when storage already has settings", async () => {
  await mock.messenger.storage.local.set({ settings: { ...DEFAULTS, instance: "a".repeat(32) } });
  globalThis.fetch = fetchFrom({ "e2e-settings.json": { accounts: { acc1: true } } });
  assert.deepEqual((await load()).accounts, {});
});

test("concurrent loads on empty storage agree on the stored instance", async () => {
  const all = await Promise.all([load(), load(), load()]);
  const stored = (await mock.messenger.storage.local.get("settings")).settings.instance;
  assert.match(stored, /^[0-9a-f]{32}$/);
  for (const s of all) assert.equal(s.instance, stored);
});

test("concurrent saves both persist", async () => {
  await Promise.all([save({ groups: { compose: true } }), save({ accounts: { a1: true } }), save({ send: { enabled: true } })]);
  const s = await load();
  assert.equal(s.groups.compose, true);
  assert.deepEqual(s.accounts, { a1: true });
  assert.equal(s.send.enabled, true);
});

test("excluded folder paths are normalised; empty and root paths are refused", async () => {
  const s = await save({ excludedFolders: [{ accountId: "a1", path: "Private//" }] });
  assert.deepEqual(s.excludedFolders, [{ accountId: "a1", path: "Private" }]);
  for (const path of ["", "/", "//"]) {
    await assert.rejects(save({ excludedFolders: [{ accountId: "a1", path }] }), { code: "invalid_argument" });
  }
  await assert.rejects(save({ excludedFolders: [{ accountId: "", path: "X" }] }), { code: "invalid_argument" });
  assert.deepEqual((await load()).excludedFolders, [{ accountId: "a1", path: "Private" }]);
});

test("an excluded folder renamed or moved in Thunderbird stays excluded under its new path", async () => {
  await save({
    excludedFolders: [
      { accountId: "a1", path: "/Private" },
      { accountId: "a1", path: "/Private/Sub" },
      { accountId: "a1", path: "/Privateer" },
      { accountId: "a2", path: "/Private" },
    ],
  });
  const f = (accountId, path) => ({ accountId, path, name: path.split("/").pop() });
  let s = await followFolder(f("a1", "/Private"), f("a1", "/Private2"));
  assert.deepEqual(s.excludedFolders, [
    { accountId: "a1", path: "/Private2" },
    { accountId: "a1", path: "/Private2/Sub" },
    { accountId: "a1", path: "/Privateer" },
    { accountId: "a2", path: "/Private" },
  ]);
  assert.ok(isExcluded("a1", "/Private2", s));
  assert.ok(isExcluded("a1", "/Private2/Sub/Deeper", s));
  // moved under another folder, then to another account
  s = await followFolder(f("a1", "/Private2"), f("a1", "/Archive/Private2"));
  assert.ok(isExcluded("a1", "/Archive/Private2/Sub", s));
  s = await followFolder(f("a1", "/Archive/Private2"), f("a3", "/Private2"));
  assert.deepEqual(
    s.excludedFolders.filter((ex) => ex.accountId === "a3"),
    [
      { accountId: "a3", path: "/Private2" },
      { accountId: "a3", path: "/Private2/Sub" },
    ],
  );
  // a folder that was not excluded changes nothing; nor does a bad event
  const before = (await load()).excludedFolders;
  await followFolder(f("a1", "/Other"), f("a1", "/Other2"));
  await followFolder(null, f("a1", "/X"));
  await followFolder(f("a1", "/Privateer"), f("a1", ""));
  assert.deepEqual((await load()).excludedFolders, before);
});
