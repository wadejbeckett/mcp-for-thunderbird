#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# check-docs-selftest.sh
#
# Proves docs/check-docs.sh catches what it claims to. On a copy of the
# repository's documents (which must pass to begin with), it plants one
# fault at a time and expects check-docs.sh to fail, and plants harmless
# text it must accept. Prints PASS or the first case it got wrong.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'chmod -R u+rwX "$work" 2>/dev/null; rm -rf "$work"' EXIT

copy() {
  rm -rf "$work/d"
  mkdir -p "$work/d/docs"
  (cd "$root" && find . \( -name .git -o -name .superpowers -o -name node_modules -o -name dist \) -prune \
    -o -type f -name '*.md' -print0 | xargs -0 -I{} cp --parents {} "$work/d/")
  cp "$root/docs/check-docs.sh" "$work/d/docs/"
}
run() { bash "$work/d/docs/check-docs.sh" >"$work/out" 2>&1; }
expect_fail() {
  if run; then
    echo "selftest: check-docs.sh missed: $1" >&2
    exit 1
  fi
  echo "caught: $1 -> $(grep -m1 'check-docs: ' "$work/out")"
}
expect_ok() {
  if ! run; then
    echo "selftest: check-docs.sh wrongly refused: $1" >&2
    cat "$work/out" >&2
    exit 1
  fi
  echo "accepted: $1"
}

copy
expect_ok "the repository's documents"

for name in "Thunderbird MCP" "thunderbird mcp" "Thunderbird-MCP" "thunderbird_mcp" "ThunderbirdMCP" "Thunderbird  MCP"; do
  copy
  printf '\nUse %s.\n' "$name" >>"$work/d/docs/SPIKES.md"
  expect_fail "product named \"$name\""
done

copy
printf '\nSee ruling R12.\n' >>"$work/d/README.md"
expect_fail "ruling reference R12"

copy
printf '\nDone in task 3.\n' >>"$work/d/INSTALL.md"
expect_fail "task reference"

copy
printf '\nSee RFC 5322, U+202E, arm64, SHA256 and mcp-for-thunderbird.\n' >>"$work/d/README.md"
expect_ok "RFC numbers, code points, architectures and the repository name"

copy
printf '# Notes\n\nThe Thunderbird MCP idea.\n' >"$work/d/docs/notes with spaces.md"
expect_fail "violation in a file name with spaces"

copy
sed -i 's/To be written//' "$work/d/README.md"
printf '\nTo be written\n' >>"$work/d/README.md"
expect_fail "\"To be written\" placeholder"

copy
rm "$work/d/CONTRIBUTING.md"
expect_fail "missing CONTRIBUTING.md"

copy
grep -v 'There is no telemetry' "$work/d/PRIVACY.md" >"$work/p" && mv "$work/p" "$work/d/PRIVACY.md"
expect_fail "missing telemetry statement"

copy
sed -i 's/^- The AI app sends what it reads/- The AI app  sends what it reads/' "$work/d/PRIVACY.md"
expect_fail "altered privacy statement"

copy
line=$(grep -m1 '^- Nothing goes to Noiz' "$work/d/PRIVACY.md")
grep -v '^- Nothing goes to Noiz' "$work/d/PRIVACY.md" >"$work/p"
printf '<!--\n%s\n-->\n' "$line" >>"$work/p"
mv "$work/p" "$work/d/PRIVACY.md"
expect_fail "privacy statement only inside an HTML comment"

if [ "$(id -u)" -ne 0 ]; then
  copy
  chmod 000 "$work/d/SECURITY.md"
  expect_fail "unreadable document"
else
  echo "skipped: unreadable document (running as root)"
fi

echo PASS
