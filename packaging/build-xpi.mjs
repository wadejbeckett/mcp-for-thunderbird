#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// build-xpi zips addon/ (minus tests, node_modules and the npm package
// files) into dist/mcp-for-thunderbird-<version>.xpi. No dependencies.
//
//   node packaging/build-xpi.mjs [--out <file>] [--e2e-settings <file>]
//
// --e2e-settings embeds <file> as e2e-settings.json, the initial settings
// of an end-to-end test build (ruling R2). Release builds never pass it.
// Entries are sorted and dated 1980-01-01, so a build is reproducible.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const addon = join(root, "addon");
const SKIP_DIRS = new Set(["test", "node_modules"]);
const SKIP_FILES = new Set(["package.json", "package-lock.json"]);

function usage(msg) {
  process.stderr.write(`build-xpi: ${msg}\nusage: build-xpi.mjs [--out <file>] [--e2e-settings <file>]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { out: null, e2e: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    if (a === "--out") opts.out = resolve(val());
    else if (a === "--e2e-settings") opts.e2e = resolve(val());
    else usage(`unknown argument ${a}`);
  }
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

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zip writes a plain zip archive (deflate, no zip64; add-ons are small).
function zip(files) {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

const opts = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(join(addon, "manifest.json"), "utf8"));
const files = walk(addon).map((p) => ({ name: relative(addon, p).split(sep).join("/"), data: readFileSync(p) }));
if (opts.e2e) {
  const data = readFileSync(opts.e2e);
  JSON.parse(data.toString("utf8")); // refuse a file that is not JSON
  files.push({ name: "e2e-settings.json", data });
}
files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const out = opts.out || join(root, "dist", `mcp-for-thunderbird-${manifest.version}.xpi`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(files));
process.stdout.write(out + "\n");
