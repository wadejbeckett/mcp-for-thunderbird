#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# check.sh [dist-dir]
#
# Checks a GoReleaser build in dist/ (default) and prints OK, or names the
# first problem and exits 1. It asserts that:
#   - every expected artefact exists and SHA256SUMS lists and verifies it;
#   - no artefact carries .superpowers, spikes/, tests, node_modules or
#     e2e-settings.json (ruling R2);
#   - the XPI's manifest has no experiment_apis, the add-on id, and the
#     release version's X.Y.Z core, and the XPI carries LICENSE and NOTICE;
#   - every host binary contains the native host name and the add-on id,
#     and the linux/amd64 one reports `mcp-for-thunderbird <version>`;
#   - the .deb installs to /usr/lib/mcp-for-thunderbird/ and the .mcpb
#     manifests run the bundled binary with `connect`.
# Needs sh, python3 (3.9 or later) and sha256sum; dpkg-deb when present.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
dist=$(cd "${1:-$root/dist}" && pwd)
NAME=mcp-for-thunderbird
HOST_NAME=mcp_for_thunderbird
ADDON_ID=mcp-for-thunderbird@wadejbeckett.github.io

fail() {
  echo "check: $*" >&2
  exit 1
}

[ -f "$dist/metadata.json" ] || fail "no $dist/metadata.json (run a GoReleaser build first)"
version=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$dist/metadata.json")
[ -n "$version" ] || fail "no version in metadata.json"
core=${version%%-*}

# 1. Every artefact exists.
want=""
for t in linux-amd64.tar.gz linux-arm64.tar.gz darwin-amd64.tar.gz darwin-arm64.tar.gz \
  windows-amd64.zip windows-arm64.zip; do
  want="$want $NAME-$version-$t $NAME-$version-$t.spdx.json"
done
for t in darwin-all windows-amd64 windows-arm64; do
  want="$want $NAME-$version-$t.mcpb"
done
debver=$(echo "$version" | sed 's/-/~/')
want="$want ${NAME}_${debver}_amd64.deb ${NAME}_${debver}_arm64.deb $NAME-$version.xpi"
for f in $want SHA256SUMS; do
  [ -s "$dist/$f" ] || fail "missing artefact $f"
done

# 2. SHA256SUMS verifies and covers every artefact.
(cd "$dist" && sha256sum --check --strict --quiet SHA256SUMS) || fail "SHA256SUMS does not verify"
for f in $want; do
  awk -v f="$f" '$2 == f { found = 1 } END { exit !found }' "$dist/SHA256SUMS" || fail "SHA256SUMS does not list $f"
done

# 3. Archive contents: nothing internal, test-only or e2e-only.
binaries=$(find "$dist" -mindepth 2 -maxdepth 2 -type f \( -name "$NAME" -o -name "$NAME.exe" \))
[ "$(echo "$binaries" | wc -l)" -eq 7 ] || fail "expected 7 host binaries (6 targets + universal), found: $binaries"
python3 -I - "$dist" "$version" "$core" "$ADDON_ID" $want <<'EOF' || exit 1
import io, json, re, subprocess, sys, tarfile, zipfile
dist, version, core, addon_id, *files = sys.argv[1:]
BAD = re.compile(r"(^|/)(\.superpowers|spikes|node_modules|test|tests|testdata)(/|$)|_test\.go$|\.test\.js$|(^|/)e2e-settings\.json$")

def fail(msg):
    print(f"check: {msg}", file=sys.stderr)
    sys.exit(1)

def names(path):
    if path.endswith(".tar.gz"):
        with tarfile.open(path) as t:
            return t.getnames()
    if path.endswith((".zip", ".xpi", ".mcpb")):
        with zipfile.ZipFile(path) as z:
            return z.namelist()
    if path.endswith(".deb"):
        try:
            out = subprocess.run(["dpkg-deb", "--fsys-tarfile", path], check=True, capture_output=True).stdout
        except FileNotFoundError:
            return None
        with tarfile.open(fileobj=io.BytesIO(out)) as t:
            return t.getnames()
    return []

for f in files:
    path = f"{dist}/{f}"
    n = names(path)
    if n is None:
        print(f"check: dpkg-deb not found; {f} contents not checked", file=sys.stderr)
        continue
    for name in n:
        if BAD.search(name.removeprefix("./")):
            fail(f"{f} contains {name}")
    if f.endswith(".deb") and "./usr/lib/mcp-for-thunderbird/mcp-for-thunderbird" not in n:
        fail(f"{f} does not install /usr/lib/mcp-for-thunderbird/mcp-for-thunderbird")
    if f.endswith(".xpi"):
        for licence in ("LICENSE", "NOTICE"):
            if licence not in n:
                fail(f"{f} lacks {licence}")
        with zipfile.ZipFile(path) as z:
            m = json.loads(z.read("manifest.json"))
        if "experiment_apis" in m:
            fail(f"{f} manifest has experiment_apis")
        if m.get("browser_specific_settings", {}).get("gecko", {}).get("id") != addon_id:
            fail(f"{f} manifest has the wrong add-on id")
        if m.get("version") != core:
            fail(f"{f} manifest version {m.get('version')} is not {core}")
    if f.endswith(".mcpb"):
        with zipfile.ZipFile(path) as z:
            m = json.loads(z.read("manifest.json"))
            entry = m["server"]["entry_point"]
            if entry not in z.namelist():
                fail(f"{f} lacks its entry point {entry}")
            if (z.getinfo(entry).external_attr >> 16) & 0o111 == 0:
                fail(f"{f} entry point is not executable")
        if m["server"]["type"] != "binary" or m["server"]["mcp_config"]["args"] != ["connect"]:
            fail(f"{f} manifest does not run the binary with connect")
        if m["display_name"] != "MCP for Thunderbird" or m["version"] != version:
            fail(f"{f} manifest display name or version is wrong")
EOF

# 4. Host binaries: identifiers present; linux/amd64 reports the version.
for b in $binaries; do
  grep -aqF "$HOST_NAME" "$b" || fail "$b lacks the native host name $HOST_NAME"
  grep -aqF "$ADDON_ID" "$b" || fail "$b lacks the add-on id $ADDON_ID"
done
linux=$(find "$dist" -mindepth 2 -maxdepth 2 -path "*_linux_amd64*/$NAME" -type f)
[ -n "$linux" ] || fail "no linux/amd64 binary"
got=$("$linux" version)
[ "$got" = "$NAME $version" ] || fail "linux/amd64 binary reports '$got', want '$NAME $version'"

echo OK
