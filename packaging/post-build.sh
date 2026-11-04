#!/bin/sh
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
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
    GOTOOLCHAIN=${MFT_GOTOOLCHAIN:-go1.26.10} \
    go run "$NFPM" pkg --config packaging/nfpm.yaml --packager deb --target "$dist/" >/dev/null
  ;;
windows/* | darwin/all)
  node "$root/packaging/mcpb/build-mcpb.mjs" --binary "$binary" --os "$goos" --arch "$goarch" \
    --version "$version" --dist "$dist" >/dev/null
  ;;
esac
