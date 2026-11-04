#!/bin/bash
# Copyright (C) 2026 Wade J. Beckett
# This file is part of MCP for Thunderbird, free software: you can redistribute
# it and/or modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version. It comes WITHOUT ANY WARRANTY; see LICENSE.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# screenshots.sh [out-dir]
#
# Takes the listing screenshots for addons.thunderbird.net from a throwaway
# Thunderbird profile that holds only the end-to-end test mail: never a
# real mailbox. It uses the end-to-end harness (test/e2e: GreenMail in
# Docker, a throwaway profile under its own Xvfb, the real host) exactly as
# run.sh does, opens the add-on's pages, and writes PNG files, each 4:3 and
# at least 1000 by 750 pixels, into packaging/atn/screenshots (or out-dir):
#   options.png          the options page
#   options-folders.png  the options page from the excluded folders down
#   options-log.png      the end of the options page, with the activity log
#   setup.png            the setup page
#   popup.png            the toolbar popup (its page in a tab where no
#                        panel can be opened under Xvfb)
# A few tool calls are made first through the host's connect command, so
# the activity log and the popup's recent activity have entries.
# Needs what test/e2e/run.sh needs (Thunderbird, Docker, xvfb-run, curl,
# python3, Go, Node) and ImageMagick's import and convert. Everything it
# starts is torn down on exit. It uses its own container name and ports
# (MFT_SHOTS_IMAP_PORT 4143, MFT_SHOTS_SMTP_PORT 4025, MFT_SHOTS_API_PORT
# 4080), so it can run beside an end-to-end run.
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
CONTAINER=mft-greenmail-shots
IMAP=${MFT_SHOTS_IMAP_PORT:-4143}
SMTP=${MFT_SHOTS_SMTP_PORT:-4025}
API=${MFT_SHOTS_API_PORT:-4080}
export MFT_E2E_IMAP_PORT=$IMAP MFT_E2E_SMTP_PORT=$SMTP
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
  echo "screenshots.sh: a container named $CONTAINER already exists (an earlier run?); remove it first" >&2
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
  -p "127.0.0.1:$IMAP:3143" -p "127.0.0.1:$SMTP:3025" -p "127.0.0.1:$API:8080" \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.users=test:test@localhost,other:other@localhost -Dgreenmail.hostname=0.0.0.0' \
  -e JAVA_OPTS=-Xmx512m "$IMAGE" >/dev/null
for i in $(seq 1 120); do
  curl -s --max-time 2 -u test:test "imap://127.0.0.1:$IMAP/" -X "NOOP" >/dev/null 2>&1 &&
    curl -s --max-time 2 --fail "http://127.0.0.1:$API/api/service/readiness" >/dev/null 2>&1 && break
  [ "$i" = 120 ] && { log "GreenMail did not start"; exit 1; }
  sleep 0.5
done

log "seeding the test inbox"
date_now=$(LC_ALL=C date -R)
n=0
for f in "$e2e"/fixtures/seed/*.eml; do
  sed -e "s/@DATE@/$date_now/" -e 's/$/\r/' "$f" >"$MFT_E2E_DIR/seed.eml"
  curl -s --fail -u test:test --upload-file "$MFT_E2E_DIR/seed.eml" "imap://127.0.0.1:$IMAP/INBOX"
  n=$((n + 1))
done
rm -f "$MFT_E2E_DIR/seed.eml"
for folder in Trash Sorted Drafts Sent Archives; do
  curl -s --fail -u test:test "imap://127.0.0.1:$IMAP/" -X "CREATE $folder" >/dev/null
  curl -s --fail -u test:test "imap://127.0.0.1:$IMAP/" -X "SUBSCRIBE $folder" >/dev/null
done
curl -s --fail -u test:test "imap://127.0.0.1:$IMAP/INBOX" -X 'STORE 1:* -FLAGS (\Seen)' >/dev/null

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

# The mail window fills the screen, so the shots have no empty band.
"$e2e/tb.sh" marionette - <<'JS' >/dev/null
const resolve = arguments[arguments.length - 1];
const win = Services.wm.getMostRecentWindow("mail:3pane");
win.moveTo(0, 0);
win.resizeTo(1600, 1000);
resolve("ok");
JS

# A few calls through connect, as a reviewer would make them, so the log
# has entries. connect reads the throwaway home's connection file, and
# stops when its input closes, so the pipe stays open for the replies.
log "making a few tool calls for the activity log"
(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Claude Desktop","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mail_accounts","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mail_folders","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"mail_search","arguments":{"limit":5}}}'; sleep 8) |
  HOME="$MFT_E2E_DIR/home" XDG_CONFIG_HOME="$MFT_E2E_DIR/home/.config" "$MFT_E2E_DIR/bin/mcp-for-thunderbird" connect >"$MFT_E2E_DIR/calls.out" 2>/dev/null || true
grep -c '"result"' "$MFT_E2E_DIR/calls.out" | sed 's/^/[screenshots] replies: /' >&2

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

# popup opens the add-on's toolbar popup and prints "ok" once a panel is
# open, else what went wrong. The e2e profile's unified toolbar has no
# add-on button, so the button is first added to the mail toolbar's items
# (Thunderbird's own customisation state, default items kept) and clicked;
# failing that, the add-on's action API is asked to open the popup.
popup() {
  "$e2e/tb.sh" marionette - <<'JS'
const resolve = arguments[arguments.length - 1];
(async () => {
  const id = "mcp-for-thunderbird@wadejbeckett.github.io";
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const doc = win.document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOpen = () => [...doc.querySelectorAll("panel")].some((p) => p.state === "open" || p.state === "showing");
  const button = () => doc.querySelector('[item-id="ext-' + id + '"]') || doc.querySelector('[extension="' + id + '"]');
  const errors = [];
  if (!button()) {
    try {
      const { getState, storeState } = ChromeUtils.importESModule("resource:///modules/CustomizationState.mjs");
      const { getDefaultItemIdsFor } = ChromeUtils.importESModule("resource:///modules/CustomizableItems.sys.mjs");
      const state = getState();
      const items = Array.isArray(state.mail) && state.mail.length ? state.mail : getDefaultItemIdsFor("mail");
      if (!items.includes("ext-" + id)) {
        state.mail = [...items, "ext-" + id];
        storeState(state);
        await sleep(1500);
      }
    } catch (e) {
      errors.push("toolbar: " + e);
    }
  }
  if (button()) {
    button().click();
    await sleep(1500);
    if (isOpen()) return "ok";
    errors.push("the click opened no panel");
  } else {
    errors.push("no toolbar button");
  }
  try {
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const ext = WebExtensionPolicy.getByID(id).extension;
    const ctx = [...ext.views].find((v) => v.viewType === "background");
    const api = await ExtensionParent.apiManager.asyncGetAPI("browserAction", ext, "addon_parent");
    await api.getAPI(ctx).action.openPopup();
    await sleep(1500);
    if (isOpen()) return "ok";
    errors.push("openPopup opened no panel");
  } catch (e) {
    errors.push("openPopup: " + e);
  }
  return "error: " + errors.join("; ");
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
# The fragment scrolls the page to the excluded folders when it loads.
open "ui/options.html#excluded"
shot "$out/options-folders.png"
open "ui/options.html#log"
shot "$out/options-log.png"
open "ui/setup.html"
shot "$out/setup.png"
# marionette prints the script's result as JSON, so a string comes quoted.
popped=$(popup | tr -d '"')
case "$popped" in
  ok) shot "$out/popup.png" ;;
  *)
    # The popup's page in a tab shows the same content.
    log "the popup could not be opened ($popped); popup.png shows its page in a tab"
    open "ui/popup.html"
    shot "$out/popup.png"
    ;;
esac
log "done: $out"
