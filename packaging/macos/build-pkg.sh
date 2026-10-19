#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# build-pkg.sh <version> <universal-binary> [out-dir]
#
# Builds mcp-for-thunderbird-<version>-macos.pkg (default out-dir: dist/)
# on macOS (CI, Task 21) with pkgbuild and productbuild. The package
# installs for the current user only (enable_currentUserHome), into
# ~/Library/Application Support/MCP for Thunderbird, and its postinstall
# runs `setup --native-only`. The binary is GoReleaser's universal build,
# dist/darwin-universal_darwin_all/mcp-for-thunderbird. Unsigned in v1.
set -eu

[ $# -ge 2 ] || { echo "usage: build-pkg.sh <version> <universal-binary> [out-dir]" >&2; exit 2; }
version=$1
binary=$2
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${3:-$root/dist}
id=io.github.wadejbeckett.mcp-for-thunderbird
core=${version%%-*}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/root" "$work/scripts" "$work/resources" "$out"

install -m 0755 "$binary" "$work/root/mcp-for-thunderbird"
for f in LICENSE NOTICE README.md; do install -m 0644 "$root/$f" "$work/root/$f"; done
install -m 0755 "$here/postinstall" "$work/scripts/postinstall"
cp "$root/LICENSE" "$work/resources/LICENSE"

# With the current-user-home domain, the install location is taken
# relative to the user's home folder.
pkgbuild --root "$work/root" --identifier "$id" --version "$core" \
  --install-location "/Library/Application Support/MCP for Thunderbird" \
  --scripts "$work/scripts" "$work/host.pkg"

cat >"$work/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>MCP for Thunderbird</title>
  <license file="LICENSE"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <options customize="never" require-scripts="false" hostArchitectures="x86_64,arm64"/>
  <choices-outline>
    <line choice="default">
      <line choice="$id"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="$id" visible="false">
    <pkg-ref id="$id"/>
  </choice>
  <pkg-ref id="$id" version="$core" onConclusion="none">host.pkg</pkg-ref>
</installer-gui-script>
XML

productbuild --distribution "$work/distribution.xml" --package-path "$work" \
  --resources "$work/resources" "$out/mcp-for-thunderbird-$version-macos.pkg"
echo "$out/mcp-for-thunderbird-$version-macos.pkg"
