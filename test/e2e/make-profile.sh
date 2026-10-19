#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build the throwaway end-to-end profile (docs/SPIKES.md "Setup"):
#  1. put the XPI at <profile>/extensions/<id>.xpi and write the native
#     manifest into the throwaway HOME (Task 18's `setup --native-only`
#     takes this over);
#  2. start Thunderbird once on a profile with no mail account and store
#     the GreenMail test login through Marionette (an IMAP account without
#     a stored password blocks start-up with a password prompt). This
#     start also installs the sideloaded XPI: Thunderbird 153 installs a
#     sideloaded add-on on the start that finds it but runs it only from
#     the next start (docs/SPIKES.md "Milestone 2");
#  3. write user.js with the IMAP account test@localhost on 127.0.0.1:3143,
#     SMTP on 3025, offline sync on and the sideload prefs (ruling R3).
#
# usage: make-profile.sh <xpi> <host-binary>
# Environment as tb.sh (MFT_E2E_DIR, MFT_E2E_PROFILE, MFT_E2E_MARIONETTE).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
: "${MFT_E2E_DIR:=${TMPDIR:-/tmp}/mft-e2e}"
: "${MFT_E2E_PROFILE:=${TMPDIR:-/tmp}/mft-e2e-profile}"
: "${MFT_E2E_MARIONETTE:=28290}"
export MFT_E2E_DIR MFT_E2E_PROFILE MFT_E2E_MARIONETTE

ADDON_ID=mcp-for-thunderbird@wadejbeckett.github.io
HOST_NAME=mcp_for_thunderbird
xpi=$(realpath "$1")
host=$(realpath "$2")
prof=$MFT_E2E_PROFILE

case "$(basename "$prof")" in
  mft-e2e*) ;;
  *) echo "make-profile.sh: refusing profile $prof (name must start mft-e2e)" >&2; exit 1 ;;
esac
rm -rf "$prof"
mkdir -p "$prof" "$MFT_E2E_DIR/home"

pref() { # name value (value already formatted for user.js)
  printf 'user_pref("%s", %s);\n' "$1" "$2" >>"$prof/user.js"
}

base_prefs() {
  : >"$prof/user.js"
  pref extensions.autoDisableScopes 0
  pref extensions.enabledScopes 15
  pref xpinstall.signatures.required false
  pref marionette.port "$MFT_E2E_MARIONETTE"
  pref mail.shell.checkDefaultClient false
  pref mailnews.start_page.enabled false
  pref mail.provider.enabled false
  pref datareporting.policy.dataSubmissionEnabled false
  pref toolkit.telemetry.reportingpolicy.firstRun false
  pref app.update.enabled false
  pref app.update.auto false
  pref mail.rights.version 1
  pref mail.ui-rdf.version 999
  pref mail.spotlight.firstRunDone true
  pref mail.winsearch.firstRunDone true
  pref mail.biff.show_alert false
  pref mail.biff.play_sound false
  pref mailnews.database.global.indexer.enabled false
  pref devtools.console.stdout.chrome true
  pref devtools.console.stdout.content true
  pref mail.accountmanager.localfoldersserver '"server2"'
  pref mail.server.server2.type '"none"'
  pref mail.server.server2.hostname '"Local Folders"'
  pref mail.server.server2.userName '"nobody"'
  pref mail.server.server2.name '"Local Folders"'
  pref mail.server.server2.directory-rel '"[ProfD]Mail/Local Folders"'
}

wait_port() { # port seconds
  for _ in $(seq 1 $(($2 * 4))); do
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

mkdir -p "$prof/extensions"
cp "$xpi" "$prof/extensions/$ADDON_ID.xpi"

nmh=$MFT_E2E_DIR/home/.mozilla/native-messaging-hosts
mkdir -p "$nmh"
if [ -e "$nmh/$HOST_NAME.json" ]; then
  echo "make-profile.sh: $nmh/$HOST_NAME.json already exists" >&2
  exit 1
fi
cat >"$nmh/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "MCP for Thunderbird",
  "path": "$host",
  "type": "stdio",
  "allowed_extensions": ["$ADDON_ID"]
}
EOF
# Phase 1: Local Folders only, store the login, quit.
base_prefs
pref mail.accountmanager.accounts '"account2"'
pref mail.account.account2.server '"server2"'
"$here/tb.sh" start
if ! wait_port "$MFT_E2E_MARIONETTE" 60; then
  "$here/tb.sh" stop
  echo "make-profile.sh: Marionette did not start" >&2
  exit 1
fi
sleep 2
result=$(python3 "$here/marionette.py" "$MFT_E2E_MARIONETTE" - <<'JS'
const resolve = arguments[arguments.length - 1];
(async () => {
  const origin = "imap://127.0.0.1";
  const li = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  li.init(origin, null, origin, "test", "test", "", "");
  await Services.logins.addLoginAsync(li);
  const all = await Services.logins.getAllLogins();
  return all.filter((l) => l.origin === origin).length;
})().then(resolve, (e) => resolve("error: " + e));
JS
)
"$here/tb.sh" stop
# A connection file from this start (if the add-on already ran) is stale.
rm -rf "$MFT_E2E_DIR/home/.config/mcp-for-thunderbird"
if [ "$result" != "1" ]; then
  echo "make-profile.sh: storing the test login failed: $result" >&2
  exit 1
fi

# Phase 2: the IMAP account.
base_prefs
for kv in \
  'mail.accountmanager.accounts "account1,account2"' \
  'mail.accountmanager.defaultaccount "account1"' \
  'mail.account.account1.identities "id1"' \
  'mail.account.account1.server "server1"' \
  'mail.account.account2.server "server2"' \
  'mail.server.server1.type "imap"' \
  'mail.server.server1.hostname "127.0.0.1"' \
  'mail.server.server1.port 3143' \
  'mail.server.server1.userName "test"' \
  'mail.server.server1.name "test@localhost"' \
  'mail.server.server1.socketType 0' \
  'mail.server.server1.authMethod 3' \
  'mail.server.server1.login_at_startup true' \
  'mail.server.server1.check_new_mail true' \
  'mail.server.server1.check_time 1' \
  'mail.server.server1.offline_download true' \
  'mail.server.server1.autosync_offline_stores true' \
  'mail.server.server1.directory-rel "[ProfD]ImapMail/127.0.0.1"' \
  'mail.server.server1.useIdle true' \
  'mail.server.default.autosync_max_age_days -1' \
  'mail.identity.id1.useremail "test@localhost"' \
  'mail.identity.id1.fullName "Test User"' \
  'mail.identity.id1.smtpServer "smtp1"' \
  'mail.identity.id1.valid true' \
  'mail.identity.id1.draft_folder "imap://test@127.0.0.1/Drafts"' \
  'mail.identity.id1.fcc_folder "imap://test@127.0.0.1/Sent"' \
  'mail.identity.id1.stationery_folder "imap://test@127.0.0.1/Templates"' \
  'mail.smtpservers "smtp1"' \
  'mail.smtp.defaultserver "smtp1"' \
  'mail.smtpserver.smtp1.hostname "127.0.0.1"' \
  'mail.smtpserver.smtp1.port 3025' \
  'mail.smtpserver.smtp1.authMethod 1' \
  'mail.smtpserver.smtp1.try_ssl 0' \
  'mail.smtpserver.smtp1.username ""' \
  'mail.smtpserver.smtp1.description "GreenMail"'; do
  pref "${kv%% *}" "${kv#* }"
done

echo "$prof"
