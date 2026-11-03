#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# screenshots.sh [out-dir]
#
# Takes the listing screenshots for addons.thunderbird.net from a throwaway
# Thunderbird profile that holds only the end-to-end test mail: never a
# real mailbox. It uses the end-to-end harness (test/e2e: GreenMail in
# Docker, a throwaway profile under its own Xvfb, the real host) exactly as
# run.sh does, opens the add-on's pages, and writes PNG files, each 4:3 and
# at least 1000 by 750 pixels, into packaging/atn/screenshots (or out-dir):
#   options.png   the options page
#   setup.png     the setup page
#   popup.png     the toolbar popup
# Needs what test/e2e/run.sh needs (Thunderbird, Docker, xvfb-run, curl,
# python3, Go, Node) and ImageMagick's import and convert. Everything it
# starts is torn down on exit.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
e2e=$repo/test/e2e
out=${1:-$here/screenshots}
# shellcheck source=../../test/e2e/workdir.sh
. "$e2e/workdir.sh"

MFT_E2E_DIR=$(e2e_new_workdir)
export MFT_E2E_DIR
export MFT_E2E_PROFILE=$MFT_E2E_DIR/mft-e2e-profile
export GOTOOLCHAIN=${GOTOOLCHAIN:-auto}
export MFT_E2E_THUNDERBIRD=${MFT_E2E_THUNDERBIRD:-thunderbird}
CONTAINER=mft-greenmail
IMAGE=greenmail/standalone@sha256:1ef95a966418cd09b7ea91d504d8c0826bbe7a2f6e679a75c601a831587c1626

log() { printf '[screenshots] %s\n' "$*" >&2; }

for d in "$MFT_E2E_DIR" "$MFT_E2E_PROFILE"; do
  case "$(basename "$(realpath -m "$d")")" in
    mft-e2e*) ;;
    *) echo "screenshots.sh: refusing $d (the name must start mft-e2e)" >&2; exit 1 ;;
  esac
done

started_greenmail=0
teardown() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  log "teardown"
  "$e2e/tb.sh" stop
  if [ "$started_greenmail" = 1 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
  rm -rf "$MFT_E2E_DIR" "$MFT_E2E_PROFILE"
  exit "$rc"
}

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "screenshots.sh: a container named $CONTAINER already exists (an end-to-end run?); remove it first" >&2
  exit 1
fi
if "$e2e/tb.sh" running; then
  echo "screenshots.sh: an e2e Thunderbird is still running; stop it with test/e2e/tb.sh stop" >&2
  exit 1
fi
e2e_private "$MFT_E2E_DIR" || exit 1
(umask 077 && mkdir -p "$MFT_E2E_DIR/bin" "$MFT_E2E_DIR/attachments" "$MFT_E2E_DIR/home" "$MFT_E2E_PROFILE")
trap teardown EXIT INT TERM

log "starting GreenMail"
started_greenmail=1
docker run -d --name "$CONTAINER" \
  -p 127.0.0.1:3143:3143 -p 127.0.0.1:3025:3025 -p 127.0.0.1:3080:8080 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.users=test:test@localhost,other:other@localhost -Dgreenmail.hostname=0.0.0.0' \
  -e JAVA_OPTS=-Xmx512m "$IMAGE" >/dev/null
for i in $(seq 1 120); do
  curl -s --max-time 2 -u test:test "imap://127.0.0.1:3143/" -X "NOOP" >/dev/null 2>&1 &&
    curl -s --max-time 2 --fail "http://127.0.0.1:3080/api/service/readiness" >/dev/null 2>&1 && break
  [ "$i" = 120 ] && { log "GreenMail did not start"; exit 1; }
  sleep 0.5
done

log "seeding the test inbox"
date_now=$(LC_ALL=C date -R)
n=0
for f in "$e2e"/fixtures/seed/*.eml; do
  sed -e "s/@DATE@/$date_now/" -e 's/$/\r/' "$f" >"$MFT_E2E_DIR/seed.eml"
  curl -s --fail -u test:test --upload-file "$MFT_E2E_DIR/seed.eml" "imap://127.0.0.1:3143/INBOX"
  n=$((n + 1))
done
rm -f "$MFT_E2E_DIR/seed.eml"
for folder in Trash Sorted Drafts Sent Archives; do
  curl -s --fail -u test:test "imap://127.0.0.1:3143/" -X "CREATE $folder" >/dev/null
  curl -s --fail -u test:test "imap://127.0.0.1:3143/" -X "SUBSCRIBE $folder" >/dev/null
done
curl -s --fail -u test:test "imap://127.0.0.1:3143/INBOX" -X 'STORE 1:* -FLAGS (\Seen)' >/dev/null

log "building the host and the add-on"
(cd "$repo/host" && go build -o "$MFT_E2E_DIR/bin/mcp-for-thunderbird" ./cmd/mcp-for-thunderbird)
# One account enabled, with an excluded folder, so the pages show their
# settings as a user would see them; the setup page is shown as on first run.
cat >"$MFT_E2E_DIR/e2e-settings.json" <<EOF
{
  "accounts": {"account1": true},
  "groups": {"read": true, "organise": true, "compose": true, "contacts": false},
  "send": {"enabled": false, "allow": []},
  "attachmentDir": "$MFT_E2E_DIR/attachments",
  "excludedFolders": [{"accountId": "account1", "path": "/Sorted"}],
  "setupDone": true
}
EOF
node "$repo/packaging/build-xpi.mjs" --e2e-settings "$MFT_E2E_DIR/e2e-settings.json" --out "$MFT_E2E_DIR/mcp-for-thunderbird-e2e.xpi" >/dev/null

log "building the profile"
"$e2e/make-profile.sh" "$MFT_E2E_DIR/mcp-for-thunderbird-e2e.xpi" "$MFT_E2E_DIR/bin/mcp-for-thunderbird" >/dev/null
chmod 700 "$MFT_E2E_PROFILE"

log "starting Thunderbird"
"$e2e/tb.sh" start
"$e2e/tb.sh" wait-conn 120 >/dev/null
synced=$("$e2e/tb.sh" sync "$n")
case "$synced" in
  [0-9]*) log "inbox synchronised: $synced messages" ;;
  *) log "inbox sync failed: $synced"; exit 1 ;;
esac

# The Xvfb display and its authority file, from the Xvfb process of our
# Thunderbird's process group (tb.sh's pid file names the group).
read -r gpid _ _ <"$MFT_E2E_DIR/tb.pid"
xvfb_args=$(ps -o args= -g "$gpid" | grep -m1 '^Xvfb ')
display=$(echo "$xvfb_args" | awk '{print $2}')
auth=$(echo "$xvfb_args" | sed -n 's/.* -auth \([^ ]*\).*/\1/p')
[ -n "$display" ] && [ -n "$auth" ] || { log "could not find the Xvfb display"; exit 1; }
export DISPLAY=$display XAUTHORITY=$auth

mkdir -p "$out"

# open <page> opens one of the add-on's pages in a tab of the mail window
# and makes it the current tab; the add-on's internal UUID comes from
# Thunderbird's own record of it.
open() {
  "$e2e/tb.sh" marionette - <<JS >/dev/null
const resolve = arguments[arguments.length - 1];
(async () => {
  const uuids = JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"));
  const uuid = uuids["mcp-for-thunderbird@wadejbeckett.github.io"];
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const tabmail = win.document.getElementById("tabmail");
  const tab = tabmail.openTab("contentTab", { url: "moz-extension://" + uuid + "/$1" });
  tabmail.switchToTab(tab);
  return "ok";
})().then(resolve, (e) => resolve("error: " + e));
JS
}

# popup opens the add-on's toolbar popup by clicking its unified toolbar
# button; it returns "missing" when the button is not in the toolbar.
popup() {
  "$e2e/tb.sh" marionette - <<'JS'
const resolve = arguments[arguments.length - 1];
(async () => {
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const button = win.document.querySelector('[extension="mcp-for-thunderbird@wadejbeckett.github.io"]');
  if (!button) return "missing";
  button.click();
  return "ok";
})().then(resolve, (e) => resolve("error: " + e));
JS
}

# shot <file> captures the whole 1600x1000 screen and crops it to 4:3
# (1333x1000) from the left, where the pages and the popup are.
shot() {
  sleep 2
  import -window root "$MFT_E2E_DIR/shot.png"
  convert "$MFT_E2E_DIR/shot.png" -crop 1333x1000+0+0 +repage "$1"
  log "wrote $1"
}

open "ui/options.html"
shot "$out/options.png"
open "ui/setup.html"
shot "$out/setup.png"
case "$(popup)" in
  ok) shot "$out/popup.png" ;;
  *) log "the toolbar button was not found; popup.png not taken" ;;
esac
log "done: $out"
