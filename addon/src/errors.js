/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tool errors carry one of the shared error codes and a message that is
// safe to show to the MCP client.

export const ERROR_CODES = Object.freeze([
  "paused",
  "not_enabled",
  "excluded",
  "not_found",
  "invalid_argument",
  "refused",
  "too_large",
  "thunderbird_error",
]);

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ToolError(code, message);
}

// isToolError accepts a ToolError or a plain {code, message} with a known
// code and a string message.
export function isToolError(e) {
  return e != null && typeof e === "object" && ERROR_CODES.includes(e.code) && typeof e.message === "string";
}
