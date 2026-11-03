/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tools that need an add-on interface only some Thunderbird versions have.
// Each is found out from the interface itself, never from the version
// number. mail_send needs messages.sendMessage, which came in Thunderbird
// 153 with the optional messages.send permission; mail_draft saves with
// messages.import (handlers/compose.js), which every supported version
// has, but is offered only from 153 too, the versions its drafts are tested
// on. On Thunderbird 140 ESR both are left out of the tool list and
// refused with not_supported if called. mail_compose, which opens a
// compose window, works on both.
//
// Neither is found out from its own interface: messages.sendMessage exists
// only once the optional permission has been granted (docs/SPIKES.md
// section 4), so probing it would call 153 unable to send before the
// grant, and so hide the very option that asks for it. The sign of a
// Thunderbird of 153 or later is messages.getHeaders, which the ESR line
// gained in 153 (the release line in 147, every release before 153 being
// out of support) and which needs only messagesRead, a permission the
// add-on uses anyway. Whether messages.send is granted is a separate check
// (permissions.contains), made before mail_send is offered and again
// before each send.

import { fail } from "./errors.js";

const NEEDS = Object.freeze({
  mail_draft: Object.freeze({
    method: "getHeaders",
    message: "Saving a draft without opening a window needs Thunderbird 153 or later. Use mail_compose to open the message in a compose window instead.",
  }),
  mail_send: Object.freeze({
    method: "getHeaders",
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
