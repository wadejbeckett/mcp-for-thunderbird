#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
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
for f in LICENSE NOTICE THIRD_PARTY_LICENSES README.md; do install -m 0644 "$root/$f" "$work/root/$f"; done
install -m 0755 "$here/postinstall" "$work/scripts/postinstall"
cp "$root/LICENSE" "$work/resources/LICENSE"

# With the current-user-home domain, the install location is taken
# relative to the user's home folder. --ownership recommended is explicit;
# Task 21 verifies on CI that the installed files end up owned by the user
# (not root) in the home domain.
pkgbuild --root "$work/root" --identifier "$id" --version "$core" \
  --ownership recommended \
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
