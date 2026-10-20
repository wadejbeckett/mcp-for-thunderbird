#!/usr/bin/env bash
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
#   - any document calls the product "Thunderbird MCP" in any spelling
#     (ThunderbirdMCP, thunderbird-mcp, thunderbird_mcp ...). Its name is
#     "MCP for Thunderbird": Mozilla's trademark policy allows a Mozilla
#     name only to say what a product works with;
#   - any document refers to internal planning records: a ruling number
#     such as "R12" or a task number such as "Task 12";
#   - PRIVACY.md lacks any of the statements below, word for word, on a
#     line of its own outside HTML comments;
#   - a document cannot be read (any grep error counts as a problem).
# Documents are every *.md file in the repository outside .git,
# .superpowers, node_modules and dist; any file name is handled.
# Needs bash, find, grep and awk. docs/check-docs-selftest.sh proves each
# check catches what it claims to.
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 1
problems=0

problem() {
  echo "check-docs: $*" >&2
  problems=$((problems + 1))
}

# has <file> <grep args...>: 0 when the file matches, 1 when it does not.
# A grep error (exit 2: unreadable file, bad pattern) is a problem and
# counts as a match, so the check fails closed.
has() {
  local f=$1 rc
  shift
  grep -q "$@" -- "$f"
  rc=$?
  if [ "$rc" -gt 1 ]; then
    problem "cannot check $f (grep exit $rc)"
    return 0
  fi
  return "$rc"
}

# show <file> <label> <grep args...>: prints the matching lines.
show() {
  local f=$1 label=$2
  shift 2
  grep -n "$@" -- "$f" 2>/dev/null | sed "s|^|check-docs: $label: $f:|" >&2
}

for f in README.md INSTALL.md SECURITY.md PRIVACY.md CONTRIBUTING.md; do
  if [ ! -s "$f" ]; then
    problem "$f is missing or empty"
  elif has "$f" -F "To be written"; then
    problem "$f still says \"To be written\""
  fi
done

NAME='thunderbird[[:space:]_-]*mcp'
RULING='(^|[^A-Za-z0-9_])R[0-9]+([^A-Za-z0-9_]|$)'
TASK='(^|[^A-Za-z0-9_])Task[[:space:]]+[0-9]+'

count=0
while IFS= read -r -d '' f; do
  f=${f#./}
  count=$((count + 1))
  if has "$f" -i -E "$NAME"; then
    show "$f" "product name" -i -E "$NAME"
    problem "$f names the product \"Thunderbird MCP\"; use \"MCP for Thunderbird\""
  fi
  if has "$f" -E "$RULING"; then
    show "$f" "ruling reference" -E "$RULING"
    problem "$f refers to internal rulings (R<number>)"
  fi
  if has "$f" -i -E "$TASK"; then
    show "$f" "task reference" -i -E "$TASK"
    problem "$f refers to internal task numbers (Task <number>)"
  fi
done < <(find . \( -name .git -o -name .superpowers -o -name node_modules -o -name dist \) -prune \
  -o -type f -name '*.md' -print0)
[ "$count" -gt 0 ] || problem "no Markdown documents found"

# The privacy statements an addons.thunderbird.net reviewer and a user rely
# on. Each must appear in PRIVACY.md exactly as written here, on a line of
# its own that a reader sees: text inside HTML comments does not count.
if [ -s PRIVACY.md ]; then
  visible=$(mktemp)
  trap 'rm -f "$visible"' EXIT
  awk '
    {
      line = $0; out = ""
      while (1) {
        if (incomment) {
          i = index(line, "-->")
          if (!i) { line = ""; break }
          line = substr(line, i + 3); incomment = 0
        } else {
          i = index(line, "<!--")
          if (!i) { out = out line; break }
          out = out substr(line, 1, i - 1); line = substr(line, i + 4); incomment = 1
        }
      }
      print out
    }' PRIVACY.md >"$visible" || problem "cannot read PRIVACY.md"
  while IFS= read -r statement; do
    [ -n "$statement" ] || continue
    has "$visible" -F -x -e "$statement" || problem "PRIVACY.md lacks the statement: $statement"
  done <<'EOF'
- MCP for Thunderbird sends the native program mail data only as tool results: the names and addresses of the accounts you enabled, their folders and tags, message headers, the text of messages the assistant asks to read, the bytes of attachments it asks to save, and contacts when the contacts group is turned on.
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
