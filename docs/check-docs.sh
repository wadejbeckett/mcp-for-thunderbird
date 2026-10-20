#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# check-docs.sh
#
# Checks the project's Markdown documents and prints OK, or lists every
# problem and exits 1. It fails when:
#   - README.md, INSTALL.md, SECURITY.md, PRIVACY.md or CONTRIBUTING.md is
#     missing, or still holds a "To be written" placeholder;
#   - any document calls the product "Thunderbird MCP" (its name is
#     "MCP for Thunderbird"; Mozilla's trademark policy allows a Mozilla
#     name only to say what a product works with);
#   - any document refers to internal planning records: a ruling number
#     such as "R12" or a task number such as "Task 12";
#   - PRIVACY.md lacks any of the statements below, word for word.
# Documents are every *.md file in the repository outside .git,
# .superpowers, node_modules and dist. Needs only sh, find and grep.
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 1
problems=0

problem() {
  echo "check-docs: $*" >&2
  problems=$((problems + 1))
}

for f in README.md INSTALL.md SECURITY.md PRIVACY.md CONTRIBUTING.md; do
  if [ ! -s "$f" ]; then
    problem "$f is missing or empty"
  elif grep -q "To be written" "$f"; then
    problem "$f still says \"To be written\""
  fi
done

docs=$(find . \( -name .git -o -name .superpowers -o -name node_modules -o -name dist \) -prune \
  -o -type f -name '*.md' -print | sed 's|^\./||' | sort)

for f in $docs; do
  if grep -q -i -E 'thunderbird[[:space:]-]+mcp' "$f"; then
    grep -n -i -E 'thunderbird[[:space:]-]+mcp' "$f" | sed "s|^|check-docs: product name: $f:|" >&2
    problem "$f names the product \"Thunderbird MCP\"; use \"MCP for Thunderbird\""
  fi
  if grep -q -E '(^|[^A-Za-z0-9_])R[0-9]+([^A-Za-z0-9_]|$)' "$f"; then
    grep -n -E '(^|[^A-Za-z0-9_])R[0-9]+([^A-Za-z0-9_]|$)' "$f" | sed "s|^|check-docs: ruling reference: $f:|" >&2
    problem "$f refers to internal rulings (R<number>)"
  fi
  if grep -q -i -E '(^|[^A-Za-z0-9_])Task[[:space:]]+[0-9]+' "$f"; then
    grep -n -i -E '(^|[^A-Za-z0-9_])Task[[:space:]]+[0-9]+' "$f" | sed "s|^|check-docs: task reference: $f:|" >&2
    problem "$f refers to internal task numbers (Task <number>)"
  fi
done

# The privacy statements an addons.thunderbird.net reviewer and a user rely
# on. Each must appear in PRIVACY.md exactly as written here, on one line.
if [ -s PRIVACY.md ]; then
  while IFS= read -r statement; do
    [ -n "$statement" ] || continue
    grep -q -F -x -e "$statement" PRIVACY.md || problem "PRIVACY.md lacks the statement: $statement"
  done <<'EOF'
- The add-on sends the native program only tool results: the names and addresses of the accounts you enabled and their folders, message headers, the text of messages the assistant asks to read, the bytes of attachments it asks to save, and contacts when the contacts group is turned on.
- The native program passes those results only to AI apps on the same computer that hold its access key.
- The AI app sends what it reads to its vendor, under that vendor's own terms and privacy policy.
- Nothing goes to Noiz or to the authors of MCP for Thunderbird.
- There is no telemetry: MCP for Thunderbird collects no usage data, crash reports or analytics.
EOF
fi

if [ "$problems" -gt 0 ]; then
  echo "check-docs: $problems problem(s)" >&2
  exit 1
fi
echo OK
