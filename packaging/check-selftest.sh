#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# check-selftest.sh [dist-dir]
#
# Proves packaging/check.sh catches what it claims to. On a copy of a good
# build (default dist/, which must pass check.sh), it plants one fault at a
# time, re-signs SHA256SUMS where the fault is not about checksums, and
# expects check.sh to fail. Prints PASS or the first fault check.sh missed.
# Needs python3, sha256sum and dpkg-deb.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
dist=$(cd "${1:-$root/dist}" && pwd)
check="$root/packaging/check.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sh "$check" "$dist" >/dev/null || { echo "selftest: $dist does not pass check.sh to begin with" >&2; exit 1; }
version=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$dist/metadata.json")
debver=$(echo "$version" | sed 's/-/~/')
N=mcp-for-thunderbird

# archive.py add <archive> <entry> [manifest-key]: adds <entry> (or, with a
# key, sets that key in the archive's manifest.json) in place.
# archive.py drop <archive> <base>: removes every entry whose last path
# component is <base>, in place.
cat >"$work/archive.py" <<'EOF'
import io, json, os, shutil, subprocess, sys, tarfile, tempfile, zipfile
mode, path, name = sys.argv[1], sys.argv[2], sys.argv[3]
key = sys.argv[4] if len(sys.argv) > 4 else None
if mode not in ("add", "drop"):
    sys.exit(f"archive.py: unknown mode {mode}")
add = mode == "add"

def keep(entry):
    return add or entry.rstrip("/").split("/")[-1] != name

if path.endswith(".tar.gz"):
    with tarfile.open(path) as t:
        members = [(m, t.extractfile(m).read() if m.isfile() else None) for m in t.getmembers() if keep(m.name)]
    with tarfile.open(path, "w:gz") as t:
        for m, d in members:
            t.addfile(m, io.BytesIO(d) if d is not None else None)
        if add:
            ti = tarfile.TarInfo(name)
            ti.size = 1
            t.addfile(ti, io.BytesIO(b"x"))
elif path.endswith((".zip", ".xpi", ".mcpb")):
    with zipfile.ZipFile(path) as z:
        items = [(i.filename, z.read(i), i.external_attr) for i in z.infolist() if keep(i.filename)]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d, attr in items:
            if add and key and n == "manifest.json":
                m = json.loads(d)
                m[key] = {}
                d = json.dumps(m).encode()
            zi = zipfile.ZipInfo(n)
            zi.external_attr = attr
            z.writestr(zi, d)
        if add and not key:
            z.writestr(name, b"x")
elif path.endswith(".deb"):
    d = tempfile.mkdtemp()
    subprocess.run(["dpkg-deb", "-R", path, d], check=True)
    if add:
        full = os.path.join(d, name)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(b"x")
    else:
        for dirpath, _, files in os.walk(d):
            for f in files:
                if f == name:
                    os.remove(os.path.join(dirpath, f))
    subprocess.run(["dpkg-deb", "-b", "--root-owner-group", d, path], check=True, capture_output=True)
    shutil.rmtree(d)
else:
    sys.exit(f"archive.py: unknown archive type {path}")
EOF

fresh() {
  rm -rf "$work/d"
  cp -a "$dist" "$work/d"
}
resign() {
  (cd "$work/d" && sha256sum $(awk '{print $2}' SHA256SUMS) >SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS)
}
expect_fail() {
  if out=$(sh "$check" "$work/d" 2>&1); then
    echo "selftest: check.sh missed: $1" >&2
    exit 1
  fi
  echo "caught: $1 -> $out"
}

# Excluded paths at the archive root and inside it, in every archive type.
for f in "$N-$version-linux-amd64.tar.gz" "$N-$version-windows-amd64.zip" "$N-$version.xpi" \
  "$N-$version-darwin-all.mcpb" "${N}_${debver}_amd64.deb"; do
  for entry in .superpowers/x spikes/x e2e-settings.json node_modules/x/y.js test/a.test.js; do
    fresh
    python3 -I "$work/archive.py" add "$work/d/$f" "$entry"
    resign
    expect_fail "$entry in $f"
  done
done

fresh
python3 -I "$work/archive.py" add "$work/d/$N-$version.xpi" - experiment_apis
resign
expect_fail "experiment_apis in the XPI manifest"

fresh
printf x >>"$work/d/$N-$version.xpi"
expect_fail "XPI changed after SHA256SUMS"

for licence in LICENSE NOTICE; do
  fresh
  python3 -I "$work/archive.py" drop "$work/d/$N-$version.xpi" "$licence"
  resign
  expect_fail "XPI without $licence"
done

fresh
grep -v '\.xpi$' "$work/d/SHA256SUMS" >"$work/sums" && mv "$work/sums" "$work/d/SHA256SUMS"
expect_fail "XPI missing from SHA256SUMS"

fresh
python3 -I - "$work/d/$N-$version-linux-amd64.tar.gz.spdx.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
d["creationInfo"]["creators"] = ["Organization: Anchore, Inc", "Tool: syft-[not provided]"]
json.dump(d, open(path, "w"))
PY
resign
expect_fail "SBOM creator without a syft version"

fresh
rm "$work/d/${N}_${debver}_arm64.deb"
expect_fail "missing arm64 .deb"

fresh
linux=$(find "$work/d" -mindepth 2 -maxdepth 2 -path "*_linux_amd64*/$N" -type f)
printf '#!/bin/sh\n# mcp_for_thunderbird mcp-for-thunderbird@wadejbeckett.github.io\necho %s 0.0.0-dev\n' "$N" >"$linux"
expect_fail "linux/amd64 binary with the wrong version"

# Every host package must carry THIRD_PARTY_LICENSES at its exact place:
# not missing, not moved elsewhere in the package, not duplicated.
tar="$N-$version-linux-amd64.tar.gz" zip="$N-$version-windows-amd64.zip"
mcpb="$N-$version-darwin-all.mcpb" deb="${N}_${debver}_amd64.deb"
for f in "$tar" "$zip" "$mcpb" "$deb"; do
  fresh
  python3 -I "$work/archive.py" drop "$work/d/$f" THIRD_PARTY_LICENSES
  resign
  expect_fail "$f without THIRD_PARTY_LICENSES"
done
for spec in "$tar ${tar%.tar.gz}/doc/THIRD_PARTY_LICENSES" "$tar THIRD_PARTY_LICENSES" \
  "$zip ${zip%.zip}/doc/THIRD_PARTY_LICENSES" "$mcpb server/THIRD_PARTY_LICENSES" \
  "$deb usr/lib/mcp-for-thunderbird/THIRD_PARTY_LICENSES"; do
  f=${spec%% *} entry=${spec#* }
  fresh
  python3 -I "$work/archive.py" drop "$work/d/$f" THIRD_PARTY_LICENSES
  python3 -I "$work/archive.py" add "$work/d/$f" "$entry"
  resign
  expect_fail "$f with THIRD_PARTY_LICENSES moved to $entry"
done
fresh
python3 -I "$work/archive.py" add "$work/d/$zip" "${zip%.zip}/doc/THIRD_PARTY_LICENSES"
resign
expect_fail "$zip with a second THIRD_PARTY_LICENSES"

# Without dpkg-deb on PATH, check.sh fails unless MFT_CHECK_SKIP_DEB=1.
# $work/bin links every other command on PATH.
mkdir "$work/bin"
IFS=:
for dir in $PATH; do
  [ -d "$dir" ] || continue
  for tool in "$dir"/*; do
    [ -f "$tool" ] && [ -x "$tool" ] || continue
    b=${tool##*/}
    [ "$b" = dpkg-deb ] || [ -L "$work/bin/$b" ] || ln -s "$tool" "$work/bin/$b"
  done
done
unset IFS
fresh
if out=$(PATH="$work/bin" sh "$check" "$work/d" 2>&1); then
  echo "selftest: check.sh missed: no dpkg-deb on PATH" >&2
  exit 1
fi
echo "caught: no dpkg-deb on PATH -> $out"
out=$(PATH="$work/bin" MFT_CHECK_SKIP_DEB=1 sh "$check" "$work/d" 2>&1) || {
  echo "selftest: check.sh failed with MFT_CHECK_SKIP_DEB=1: $out" >&2
  exit 1
}
case "$out" in
*"not checked"*OK) echo "skipped with MFT_CHECK_SKIP_DEB=1 -> $(echo "$out" | head -n 1)" ;;
*)
  echo "selftest: the MFT_CHECK_SKIP_DEB=1 run did not note the skip: $out" >&2
  exit 1
  ;;
esac

echo PASS
