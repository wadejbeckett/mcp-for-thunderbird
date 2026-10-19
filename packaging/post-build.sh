#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# post-build.sh <goos> <goarch> <binary> <version>
#
# GoReleaser runs this after each build (and after the macOS universal
# binary). It writes into dist/:
#   linux           the .deb (nfpm, packaging/nfpm.yaml)
#   windows         the .mcpb bundle
#   darwin "all"    the .mcpb bundle (universal binary)
# Per-arch darwin builds need nothing here.
set -eu

[ $# -eq 4 ] || { echo "usage: post-build.sh <goos> <goarch> <binary> <version>" >&2; exit 2; }
goos=$1 goarch=$2 binary=$3 version=$4
root=$(cd "$(dirname "$0")/.." && pwd)
dist="$root/dist"
case "$binary" in /*) ;; *) binary="$root/$binary" ;; esac

# Pinned tools; their go.mod go directive is at most 1.25.
NFPM=github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.46.3

case "$goos/$goarch" in
linux/*)
  cd "$root"
  MFT_VERSION=$version MFT_ARCH=$goarch MFT_BINARY=$binary \
    GOTOOLCHAIN=${MFT_GOTOOLCHAIN:-go1.25.14} \
    go run "$NFPM" pkg --config packaging/nfpm.yaml --packager deb --target "$dist/" >/dev/null
  ;;
windows/* | darwin/all)
  node "$root/packaging/mcpb/build-mcpb.mjs" --binary "$binary" --os "$goos" --arch "$goarch" \
    --version "$version" --dist "$dist" >/dev/null
  ;;
esac
