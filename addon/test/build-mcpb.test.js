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
const script = join(here, "..", "..", "packaging", "mcpb", "build-mcpb.mjs");

// entries reads a zip's central directory: name -> {data, mode}.
function entries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, "end of central directory found");
  const n = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const ext = buf.readUInt32LE(at + 38);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const lname = buf.readUInt16LE(local + 26);
    const lextra = buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + csize));
    out.set(name, { data, mode: (ext >>> 16) & 0o777 });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function build(goos, arch) {
  const dir = mkdtempSync(join(tmpdir(), "mft-mcpb-"));
  try {
    const bin = join(dir, "bin");
    writeFileSync(bin, "fake binary");
    const out = execFileSync(
      process.execPath,
      [script, "--binary", bin, "--os", goos, "--arch", arch, "--version", "0.1.0-SNAPSHOT-abc1234", "--dist", dir],
      { stdio: "pipe" },
    )
      .toString()
      .trim();
    assert.equal(out, join(dir, `mcp-for-thunderbird-0.1.0-SNAPSHOT-abc1234-${goos}-${arch}.mcpb`));
    return entries(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("build-mcpb bundles the binary with a connect entry point", () => {
  const e = build("darwin", "all");
  const m = JSON.parse(e.get("manifest.json").data.toString());
  assert.equal(m.display_name, "MCP for Thunderbird");
  assert.equal(m.version, "0.1.0-SNAPSHOT-abc1234");
  assert.equal(m.server.type, "binary");
  assert.equal(m.server.entry_point, "server/mcp-for-thunderbird");
  assert.equal(m.server.mcp_config.command, "${__dirname}/server/mcp-for-thunderbird");
  assert.deepEqual(m.server.mcp_config.args, ["connect"]);
  assert.deepEqual(m.compatibility.platforms, ["darwin"]);
  assert.equal(e.get("server/mcp-for-thunderbird").data.toString(), "fake binary");
  assert.equal(e.get("server/mcp-for-thunderbird").mode, 0o755);
  assert.ok(e.has("LICENSE") && e.has("NOTICE"));
});

test("build-mcpb uses the .exe name on Windows", () => {
  const m = JSON.parse(build("windows", "arm64").get("manifest.json").data.toString());
  assert.equal(m.server.entry_point, "server/mcp-for-thunderbird.exe");
  assert.equal(m.server.mcp_config.command, "${__dirname}/server/mcp-for-thunderbird.exe");
  assert.deepEqual(m.compatibility.platforms, ["win32"]);
});
