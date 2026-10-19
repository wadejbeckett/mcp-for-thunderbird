#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// build-xpi zips addon/ (minus tests, node_modules and the npm package
// files) into dist/mcp-for-thunderbird-<version>.xpi. No dependencies.
//
//   node packaging/build-xpi.mjs [--version <v>] [--dist <dir> | --out <file>]
//   node packaging/build-xpi.mjs --e2e-settings <file> [--out <file>]
//
// --version (release mode) is the release version, X.Y.Z with an optional
// -suffix (0.1.0-SNAPSHOT-abc1234). The XPI's manifest gets the X.Y.Z core,
// since Gecko add-on versions are dotted integers; the file name carries
// the full version. Without --version the manifest's own version is used.
//
// --e2e-settings embeds <file> as e2e-settings.json, the initial settings
// of an end-to-end test build (ruling R2). It cannot be combined with
// --version, so a release build never carries it.
// Entries are sorted and dated 1980-01-01, so a build is reproducible.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const addon = join(root, "addon");
const SKIP_DIRS = new Set(["test", "node_modules"]);
const SKIP_FILES = new Set(["package.json", "package-lock.json"]);
// X.Y.Z without leading zeros, optionally -suffix of [0-9A-Za-z.-].
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]+)?$/;

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
  if (opts.version !== null && !VERSION_RE.test(opts.version)) usage(`--version ${opts.version} is not X.Y.Z[-suffix]`);
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
if (opts.version !== null) {
  manifest.version = opts.version.split("-")[0];
  const m = files.find((f) => f.name === "manifest.json");
  m.data = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
if (opts.e2e) {
  const data = readFileSync(opts.e2e);
  JSON.parse(data.toString("utf8")); // refuse a file that is not JSON
  files.push({ name: "e2e-settings.json", data });
}
files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const out = opts.out || join(opts.dist || join(root, "dist"), `mcp-for-thunderbird-${version}.xpi`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(files));
process.stdout.write(out + "\n");
