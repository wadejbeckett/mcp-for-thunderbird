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

# plant.py <archive> <entry> [manifest-key]: adds <entry> (or, with a key,
# sets that key in the archive's manifest.json) in place.
cat >"$work/plant.py" <<'EOF'
import io, json, os, shutil, subprocess, sys, tarfile, tempfile, zipfile
path, name = sys.argv[1], sys.argv[2]
key = sys.argv[3] if len(sys.argv) > 3 else None
if path.endswith(".tar.gz"):
    with tarfile.open(path) as t:
        members = [(m, t.extractfile(m).read() if m.isfile() else None) for m in t.getmembers()]
    with tarfile.open(path, "w:gz") as t:
        for m, d in members:
            t.addfile(m, io.BytesIO(d) if d is not None else None)
        ti = tarfile.TarInfo(name)
        ti.size = 1
        t.addfile(ti, io.BytesIO(b"x"))
elif path.endswith((".zip", ".xpi", ".mcpb")):
    with zipfile.ZipFile(path) as z:
        items = [(i.filename, z.read(i), i.external_attr) for i in z.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d, attr in items:
            if key and n == "manifest.json":
                m = json.loads(d)
                m[key] = {}
                d = json.dumps(m).encode()
            zi = zipfile.ZipInfo(n)
            zi.external_attr = attr
            z.writestr(zi, d)
        if not key:
            z.writestr(name, b"x")
elif path.endswith(".deb"):
    d = tempfile.mkdtemp()
    subprocess.run(["dpkg-deb", "-R", path, d], check=True)
    full = os.path.join(d, name)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(b"x")
    subprocess.run(["dpkg-deb", "-b", "--root-owner-group", d, path], check=True, capture_output=True)
    shutil.rmtree(d)
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
    python3 -I "$work/plant.py" "$work/d/$f" "$entry"
    resign
    expect_fail "$entry in $f"
  done
done

fresh
python3 -I "$work/plant.py" "$work/d/$N-$version.xpi" - experiment_apis
resign
expect_fail "experiment_apis in the XPI manifest"

fresh
printf x >>"$work/d/$N-$version.xpi"
expect_fail "XPI changed after SHA256SUMS"

fresh
python3 -I - "$work/d/$N-$version.xpi" <<'PY'
import sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    items = [(i, z.read(i)) for i in z.infolist() if i.filename != "LICENSE"]
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    for i, d in items:
        z.writestr(i, d)
PY
resign
expect_fail "XPI without LICENSE"

fresh
grep -v '\.xpi$' "$work/d/SHA256SUMS" >"$work/sums" && mv "$work/sums" "$work/d/SHA256SUMS"
expect_fail "XPI missing from SHA256SUMS"

fresh
rm "$work/d/${N}_${debver}_arm64.deb"
expect_fail "missing arm64 .deb"

fresh
linux=$(find "$work/d" -mindepth 2 -maxdepth 2 -path "*_linux_amd64*/$N" -type f)
printf '#!/bin/sh\n# mcp_for_thunderbird mcp-for-thunderbird@wadejbeckett.github.io\necho %s 0.0.0-dev\n' "$N" >"$linux"
expect_fail "linux/amd64 binary with the wrong version"

echo PASS
