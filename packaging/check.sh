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
#     release version's X.Y.Z core, and the XPI carries LICENSE, NOTICE and
#     every icon its manifest names (the .mcpb its icon.png too);
#   - every host package carries THIRD_PARTY_LICENSES, the licences of the
#     Go modules linked into the host, at its exact place: next to the binary
#     in each archive's top directory, /usr/share/doc/mcp-for-thunderbird/ in
#     the .deb and the root of the .mcpb;
#   - every host binary contains the native host name and the add-on id,
#     and the linux/amd64 one reports `mcp-for-thunderbird <version>`;
#   - the .deb installs to /usr/lib/mcp-for-thunderbird/ and the .mcpb
#     manifests run the bundled binary with `connect`;
#   - every SBOM is SPDX JSON whose creators name syft with a version
#     (never "[not provided]").
# Needs sh, python3 (3.9 or later), sha256sum and dpkg-deb. Without dpkg-deb
# the check fails, unless MFT_CHECK_SKIP_DEB=1 is set: then the .deb
# contents are not checked and a note says so (the .deb files must still
# exist and verify against SHA256SUMS).
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

skip_deb=0
if ! command -v dpkg-deb >/dev/null 2>&1; then
  [ "${MFT_CHECK_SKIP_DEB:-}" = 1 ] || fail "dpkg-deb not found; install it, or set MFT_CHECK_SKIP_DEB=1 to skip the .deb contents"
  echo "check: dpkg-deb not found and MFT_CHECK_SKIP_DEB=1; .deb contents not checked" >&2
  skip_deb=1
fi

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
python3 -I - "$dist" "$version" "$core" "$ADDON_ID" "$skip_deb" $want <<'EOF' || exit 1
import io, json, re, subprocess, sys, tarfile, zipfile
dist, version, core, addon_id, skip_deb, *files = sys.argv[1:]
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
        if skip_deb == "1":
            return None
        out = subprocess.run(["dpkg-deb", "--fsys-tarfile", path], check=True, capture_output=True).stdout
        with tarfile.open(fileobj=io.BytesIO(out)) as t:
            return t.getnames()
    return []

TOOL = re.compile(r"^Tool: syft-v?[0-9]+\.[0-9]+\.[0-9]+$")
for f in files:
    path = f"{dist}/{f}"
    if f.endswith(".spdx.json"):
        try:
            with open(path) as fh:
                creators = json.load(fh)["creationInfo"]["creators"]
        except (OSError, ValueError, KeyError, TypeError):
            fail(f"{f} is not an SPDX JSON document with creators")
        if not any(isinstance(c, str) and TOOL.match(c) for c in creators):
            fail(f"{f} does not name the syft version that made it: {creators}")
        continue
    n = names(path)
    if n is None:
        continue
    for name in n:
        if BAD.search(name.removeprefix("./")):
            fail(f"{f} contains {name}")
    # THIRD_PARTY_LICENSES at its exact place in each host package, and
    # nowhere else.
    licences = None
    if f.endswith((".tar.gz", ".zip")):
        top = f.removesuffix(".tar.gz").removesuffix(".zip")
        binary = f"{top}/mcp-for-thunderbird" + (".exe" if "-windows-" in f else "")
        if binary not in n:
            fail(f"{f} lacks {binary}")
        licences = f"{top}/THIRD_PARTY_LICENSES"
    elif f.endswith(".deb"):
        licences = "./usr/share/doc/mcp-for-thunderbird/THIRD_PARTY_LICENSES"
    elif f.endswith(".mcpb"):
        licences = "THIRD_PARTY_LICENSES"
    if licences is not None:
        if licences not in n:
            fail(f"{f} lacks {licences}")
        stray = [name for name in n if name != licences and name.rstrip("/").split("/")[-1] == "THIRD_PARTY_LICENSES"]
        if stray:
            fail(f"{f} carries THIRD_PARTY_LICENSES at {stray[0]}, want only {licences}")
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
        icons = list(m.get("icons", {}).values()) + list(m.get("action", {}).get("default_icon", {}).values())
        if not icons:
            fail(f"{f} manifest names no icons")
        for icon in icons:
            if icon not in n:
                fail(f"{f} lacks its icon {icon}")
    if f.endswith(".mcpb"):
        with zipfile.ZipFile(path) as z:
            m = json.loads(z.read("manifest.json"))
            entry = m["server"]["entry_point"]
            if entry not in z.namelist():
                fail(f"{f} lacks its entry point {entry}")
            if (z.getinfo(entry).external_attr >> 16) & 0o111 == 0:
                fail(f"{f} entry point is not executable")
            if m.get("icon") not in z.namelist():
                fail(f"{f} lacks its icon {m.get('icon')}")
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
