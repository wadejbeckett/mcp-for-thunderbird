#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// build-mcpb packs one host binary into an MCP Bundle (.mcpb) for Claude
// Desktop and other MCPB clients, from the manifest.json next to this file.
//
//   node packaging/mcpb/build-mcpb.mjs --binary <file> --os <goos> --arch <goarch>
//        --version <v> [--dist <dir>]
//
// Writes <dist>/mcp-for-thunderbird-<v>-<goos>-<goarch>.mcpb (dist defaults
// to dist/) and prints its path. The bundle holds manifest.json, LICENSE,
// NOTICE, THIRD_PARTY_LICENSES and server/mcp-for-thunderbird[.exe] (mode 0755).

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "../zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const PLATFORMS = { darwin: "darwin", windows: "win32", linux: "linux" };

function usage(msg) {
  process.stderr.write(
    `build-mcpb: ${msg}\nusage: build-mcpb.mjs --binary <file> --os <goos> --arch <goarch> --version <v> [--dist <dir>]\n`,
  );
  process.exit(2);
}

const opts = { binary: null, os: null, arch: null, version: null, dist: join(root, "dist") };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
  if (a === "--binary") opts.binary = resolve(val());
  else if (a === "--os") opts.os = val();
  else if (a === "--arch") opts.arch = val();
  else if (a === "--version") opts.version = val();
  else if (a === "--dist") opts.dist = resolve(val());
  else usage(`unknown argument ${a}`);
}
for (const k of ["binary", "os", "arch", "version"]) if (!opts[k]) usage(`--${k} is required`);
if (!PLATFORMS[opts.os]) usage(`unsupported --os ${opts.os}`);
if (!/^[a-z0-9_]+$/.test(opts.arch)) usage(`bad --arch ${opts.arch}`);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(opts.version)) usage(`--version ${opts.version} is not X.Y.Z[-suffix]`);

const exe = "mcp-for-thunderbird" + (opts.os === "windows" ? ".exe" : "");
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
manifest.version = opts.version;
manifest.server.entry_point = `server/${exe}`;
manifest.server.mcp_config.command = `\${__dirname}/server/${exe}`;
manifest.compatibility.platforms = [PLATFORMS[opts.os]];

const files = [
  { name: "LICENSE", data: readFileSync(join(root, "LICENSE")) },
  { name: "NOTICE", data: readFileSync(join(root, "NOTICE")) },
  { name: "THIRD_PARTY_LICENSES", data: readFileSync(join(root, "THIRD_PARTY_LICENSES")) },
  { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") },
  { name: `server/${exe}`, data: readFileSync(opts.binary), mode: 0o755 },
];

const out = join(opts.dist, `mcp-for-thunderbird-${opts.version}-${opts.os}-${opts.arch}.mcpb`);
mkdirSync(opts.dist, { recursive: true });
writeFileSync(out, zip(files));
process.stdout.write(out + "\n");
