/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

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
  "not_supported",
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
