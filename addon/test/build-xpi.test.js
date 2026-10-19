/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "packaging", "build-xpi.mjs");

// entries reads a zip's central directory: name -> uncompressed bytes.
function entries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, "end of central directory found");
  const n = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const lname = buf.readUInt16LE(local + 26);
    const lextra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function build(args) {
  const dir = mkdtempSync(join(tmpdir(), "mft-xpi-"));
  const out = join(dir, "a.xpi");
  try {
    execFileSync(process.execPath, [script, "--out", out, ...args(dir)], { stdio: "pipe" });
    return entries(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("build-xpi zips the add-on without tests or package files", () => {
  const e = build(() => []);
  const manifest = JSON.parse(e.get("manifest.json").toString());
  assert.equal(manifest.browser_specific_settings.gecko.id, "mcp-for-thunderbird@wadejbeckett.github.io");
  assert.ok(e.has("src/background.js"));
  assert.ok(e.has("src/handlers/read.js"));
  assert.equal(e.get("src/rpc.js").toString(), readFileSync(join(here, "..", "src", "rpc.js"), "utf8"));
  for (const name of e.keys()) {
    assert.ok(!name.startsWith("test/") && !name.startsWith("node_modules/"), name);
    assert.ok(!/^package(-lock)?\.json$/.test(name), name);
  }
  assert.ok(!e.has("e2e-settings.json"), "release builds never carry e2e settings");
});

test("build-xpi --e2e-settings embeds the file as e2e-settings.json", () => {
  const settings = { accounts: { account1: true }, setupDone: true };
  const e = build((dir) => {
    const f = join(dir, "s.json");
    writeFileSync(f, JSON.stringify(settings));
    return ["--e2e-settings", f];
  });
  assert.deepEqual(JSON.parse(e.get("e2e-settings.json").toString()), settings);
});

test("build-xpi --version sets the manifest version (release mode)", () => {
  const e = build(() => ["--version", "1.2.3"]);
  assert.equal(JSON.parse(e.get("manifest.json").toString()).version, "1.2.3");
  assert.ok(!e.has("e2e-settings.json"));
});

test("build-xpi --version keeps the numeric core of a snapshot version", () => {
  // Gecko add-on versions are dotted integers only; the full snapshot
  // version stays in the file name.
  const e = build(() => ["--version", "0.1.0-SNAPSHOT-abc1234"]);
  assert.equal(JSON.parse(e.get("manifest.json").toString()).version, "0.1.0");
});

test("build-xpi names the file after the full --version", () => {
  const dir = mkdtempSync(join(tmpdir(), "mft-xpi-"));
  try {
    const out = execFileSync(process.execPath, [script, "--version", "0.1.0-SNAPSHOT-abc1234", "--dist", dir], { stdio: "pipe" })
      .toString()
      .trim();
    assert.equal(out, join(dir, "mcp-for-thunderbird-0.1.0-SNAPSHOT-abc1234.xpi"));
    assert.ok(readFileSync(out).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build-xpi refuses --version with --e2e-settings and a malformed version", () => {
  const run = (args) => {
    try {
      execFileSync(process.execPath, [script, "--out", join(tmpdir(), "never.xpi"), ...args], { stdio: "pipe" });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  assert.equal(run(["--version", "1.0.0", "--e2e-settings", "x.json"]), 2);
  assert.equal(run(["--version", "01.0.0"]), 2);
  assert.equal(run(["--version", "1.0"]), 2);
  assert.equal(run(["--version", "v1.0.0"]), 2);
});

test("build-xpi release mode accepts only a -SNAPSHOT pre-release suffix", () => {
  const run = (v) => {
    try {
      execFileSync(process.execPath, [script, "--version", v, "--out", join(tmpdir(), `mft-v-${process.pid}.xpi`)], { stdio: "pipe" });
      return 0;
    } catch (err) {
      return err.status;
    } finally {
      rmSync(join(tmpdir(), `mft-v-${process.pid}.xpi`), { force: true });
    }
  };
  assert.equal(run("1.0.0-rc1"), 2);
  assert.equal(run("1.0.0-beta.2"), 2);
  assert.equal(run("1.0.0-SNAPSHOTX"), 2);
  assert.equal(run("1.0.0-SNAPSHOT-abc1234"), 0);
  assert.equal(run("1.0.0"), 0);
});
