#!/usr/bin/env node
/* Copyright (C) 2026 Wade J. Beckett
 * This file is part of MCP for Thunderbird, free software: you can redistribute
 * it and/or modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
 * SPDX-License-Identifier: GPL-3.0-or-later */

// build-xpi zips addon/ (minus tests, node_modules and the npm package
// files), plus the repository's LICENSE and NOTICE, into
// dist/mcp-for-thunderbird-<version>.xpi. No dependencies.
//
//   node packaging/build-xpi.mjs [--version <v>] [--dist <dir> | --out <file>]
//   node packaging/build-xpi.mjs --e2e-settings <file> [--out <file>]
//
// --version (release mode) is the release version, X.Y.Z or a snapshot
// X.Y.Z-SNAPSHOT-<id> (0.1.0-SNAPSHOT-abc1234); other suffixes are
// refused. The XPI's manifest gets the X.Y.Z core, since Gecko add-on
// versions are dotted integers; the file name carries the full version. Without --version the manifest's own version is used.
//
// --e2e-settings puts <file> in the package as settings-seed.json, the
// initial settings of an end-to-end test build (ruling R2). It cannot be
// combined with --version, so a release build never carries seeded
// settings: there addon/settings-seed.json, an empty object, is packed as
// it is, and the build refuses a source file that is not empty.
// Entries are sorted and dated 1980-01-01, so a build is reproducible.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const addon = join(root, "addon");
const SKIP_DIRS = new Set(["test", "node_modules"]);
const SKIP_FILES = new Set(["package.json", "package-lock.json"]);
// X.Y.Z without leading zeros, optionally -SNAPSHOT[-id]. Other pre-release
// suffixes are refused: the add-on would ship as plain X.Y.Z and collide
// with the final release on addons.thunderbird.net.
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-SNAPSHOT(-[0-9A-Za-z.-]+)?)?$/;

function usage(msg) {
  process.stderr.write(`build-xpi: ${msg}\nusage: build-xpi.mjs [--version <v>] [--dist <dir> | --out <file>] | --e2e-settings <file> [--out <file>]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { out: null, dist: null, e2e: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    if (a === "--out") opts.out = resolve(val());
    else if (a === "--dist") opts.dist = resolve(val());
    else if (a === "--e2e-settings") opts.e2e = resolve(val());
    else if (a === "--version") opts.version = val();
    else usage(`unknown argument ${a}`);
  }
  if (opts.version !== null && opts.e2e) usage("--version (release) and --e2e-settings cannot be combined");
  if (opts.out && opts.dist) usage("--out and --dist cannot be combined");
  if (opts.version !== null && !VERSION_RE.test(opts.version)) usage(`--version ${opts.version} is not X.Y.Z or X.Y.Z-SNAPSHOT[-id]`);
  return opts;
}

function walk(dir, top = true) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (top && SKIP_DIRS.has(name)) continue;
      out.push(...walk(p, false));
    } else if (!(top && SKIP_FILES.has(name)) && !name.startsWith(".")) {
      out.push(p);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(join(addon, "manifest.json"), "utf8"));
const version = opts.version ?? manifest.version;
const files = walk(addon).map((p) => ({ name: relative(addon, p).split(sep).join("/"), data: readFileSync(p) }));
// The GPL text and the notice for the MIT-licensed code derived from
// thunderbird-cli travel with the add-on.
for (const name of ["LICENSE", "NOTICE"]) files.push({ name, data: readFileSync(join(root, name)) });
if (opts.version !== null) {
  manifest.version = opts.version.split("-")[0];
  const m = files.find((f) => f.name === "manifest.json");
  m.data = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
const seed = files.find((f) => f.name === "settings-seed.json");
if (!seed) usage("addon/settings-seed.json is missing");
if (opts.e2e) {
  const data = readFileSync(opts.e2e);
  JSON.parse(data.toString("utf8")); // refuse a file that is not JSON
  seed.data = data;
} else {
  const v = JSON.parse(seed.data.toString("utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > 0) {
    usage("addon/settings-seed.json must be an empty object; only --e2e-settings may fill it");
  }
}
files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const out = opts.out || join(opts.dist || join(root, "dist"), `mcp-for-thunderbird-${version}.xpi`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(files));
process.stdout.write(out + "\n");
