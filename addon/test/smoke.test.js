/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("manifest identifies the add-on and requires Thunderbird 140", () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.equal(gecko.id, "mcp-for-thunderbird@wadejbeckett.github.io");
  assert.equal(gecko.strict_min_version, "140.0");
});

test("manifest declares no Experiment APIs", () => {
  assert.equal("experiment_apis" in manifest, false);
});

test("manifest is MV3 with a module event page and the agreed permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { scripts: ["src/background.js"], type: "module" });
  assert.deepEqual(manifest.permissions, [
    "accountsRead",
    "messagesRead",
    "messagesMove",
    "messagesUpdate",
    "messagesTagsList",
    "messagesImport",
    "compose",
    "scripting",
    "addressBooks",
    "nativeMessaging",
    "storage",
  ]);
  assert.deepEqual(manifest.optional_permissions, ["messages.send"]);
  assert.equal(JSON.stringify(manifest).includes("messagesDelete"), false);
  assert.ok(manifest.action);
});

test("the add-on, its toolbar button and its pages have an icon that exists", () => {
  const icons = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  assert.ok(manifest.icons["16"] && manifest.icons["128"] && manifest.action.default_icon["16"]);
  for (const icon of icons) assert.ok(existsSync(new URL(`../${icon}`, import.meta.url)), icon);
  for (const page of ["options", "setup", "popup"]) {
    const html = readFileSync(new URL(`../ui/${page}.html`, import.meta.url), "utf8");
    const href = /<link rel="icon" href="([^"]+)">/.exec(html)?.[1];
    assert.ok(href && existsSync(new URL(`../ui/${href}`, import.meta.url)), `${page}.html icon ${href}`);
  }
});
