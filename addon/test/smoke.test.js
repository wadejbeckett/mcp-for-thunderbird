/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("manifest identifies the add-on and requires Thunderbird 153", () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.equal(gecko.id, "mcp-for-thunderbird@wadejbeckett.github.io");
  assert.equal(gecko.strict_min_version, "153.0");
});

test("manifest declares no Experiment APIs", () => {
  assert.equal("experiment_apis" in manifest, false);
});
