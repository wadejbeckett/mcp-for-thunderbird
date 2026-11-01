/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tools that need an add-on interface only some Thunderbird versions have.
// Each is found out from the interface itself, never from the version
// number. Thunderbird 140 ESR has neither messages.saveMessage nor
// messages.sendMessage (both came in Thunderbird 153, with the
// messages.save and messages.send permissions): there mail_draft and
// mail_send are left out of the tool list and refused with not_supported
// if called. mail_compose, which opens a compose window, works on both.
//
// mail_send is found out from messages.saveMessage, not sendMessage:
// messages.save is a required permission, so saveMessage is there from
// the start on 153 and later, but messages.send is optional and
// sendMessage exists only once it has been granted (docs/SPIKES.md
// section 4). Probing sendMessage would call 153 unable to send before the
// grant, and so hide the very option that asks for it. Whether the
// permission is granted is a separate check (permissions.contains), made
// before mail_send is offered and again before each send.

import { fail } from "./errors.js";

const NEEDS = Object.freeze({
  mail_draft: Object.freeze({
    method: "saveMessage",
    message: "Saving a draft without opening a window needs Thunderbird 153 or later. Use mail_compose to open the message in a compose window instead.",
  }),
  mail_send: Object.freeze({
    method: "saveMessage",
    message: "Sending without a window needs Thunderbird 153 or later. Use mail_compose to open the message in a compose window instead.",
  }),
});

// supported tells whether this Thunderbird (the messenger API m) has what
// the tool needs. A tool with no special need is always supported.
export function supported(tool, m = globalThis.messenger) {
  const need = Object.hasOwn(NEEDS, tool) ? NEEDS[tool] : null;
  if (!need) return true;
  const messages = m && m.messages;
  return Boolean(messages) && typeof messages[need.method] === "function";
}

// supportedTools keeps the tools this Thunderbird can run, in order.
export function supportedTools(tools, m = globalThis.messenger) {
  return tools.filter((t) => supported(t, m));
}

// assertSupported refuses a tool this Thunderbird cannot run.
export function assertSupported(tool) {
  if (!supported(tool)) fail("not_supported", NEEDS[tool].message);
}
