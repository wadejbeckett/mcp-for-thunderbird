/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "./mocks/messenger.js";
import { supported, supportedTools, assertSupported } from "../src/features.js";
import { GROUPS } from "../src/settings.js";
import { ERROR_CODES } from "../src/errors.js";

const ALL = Object.values(GROUPS).flat();

test("Thunderbird 153 and later run every tool", () => {
  install({ release: 153 });
  assert.deepEqual(supportedTools(ALL), ALL);
  for (const t of ALL) assert.doesNotThrow(() => assertSupported(t));
});

test("Thunderbird 140 ESR runs every tool but mail_draft and mail_send", () => {
  install({ release: 140 });
  assert.deepEqual(
    supportedTools(ALL),
    ALL.filter((t) => t !== "mail_draft" && t !== "mail_send"),
  );
  assert.equal(supported("mail_compose"), true);
});

test("a tool this Thunderbird cannot run is refused with not_supported", () => {
  install({ release: 140 });
  assert.ok(ERROR_CODES.includes("not_supported"));
  for (const t of ["mail_draft", "mail_send"]) {
    assert.throws(
      () => assertSupported(t),
      (e) => e.code === "not_supported" && /Thunderbird 153 or later/.test(e.message) && /mail_compose/.test(e.message),
    );
  }
});

test("support is read from the API given, not from the version", () => {
  install({ release: 153 });
  const m = { messages: { getHeaders() {} } };
  assert.equal(supported("mail_draft", m), true);
  assert.equal(supported("mail_send", m), true);
  assert.equal(supported("mail_draft", {}), false);
  assert.equal(supported("mail_send", {}), false);
  assert.equal(supported("mail_search", {}), true);
});

test("on 153 mail_send is supported before messages.send is granted", () => {
  // sendMessage appears only with the optional permission; support is
  // read from messages.getHeaders, the sign of 153 or later.
  const mock = install({ release: 153 });
  assert.equal(typeof mock.messenger.messages.sendMessage, "undefined");
  assert.equal(supported("mail_send"), true);
  assert.doesNotThrow(() => assertSupported("mail_send"));
  assert.equal(supported("mail_send", { messages: { sendMessage() {} } }), false);
  mock.grant("messages.send");
  assert.equal(typeof mock.messenger.messages.sendMessage, "function");
  assert.equal(supported("mail_send"), true);
});
