#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build the throwaway end-to-end profile (docs/SPIKES.md "Setup"):
#  1. put the XPI at <profile>/extensions/<id>.xpi and register the native
#     manifest with the host's own `setup --native-only`, run with HOME and
#     XDG_CONFIG_HOME pointing at the throwaway home (ruling R24);
#  2. start Thunderbird once on a profile with no mail account and store
#     the GreenMail test login through Marionette (an IMAP account without
#     a stored password blocks start-up with a password prompt). This
#     start also installs the sideloaded XPI: Thunderbird 153 installs a
#     sideloaded add-on on the start that finds it but runs it only from
#     the next start (docs/SPIKES.md "Milestone 2");
#  3. write user.js with the IMAP account test@localhost on 127.0.0.1:3143,
#     SMTP on 3025, offline sync on and the sideload prefs (ruling R3), and
#     a second IMAP account other@localhost (account3) on the same server,
#     the other account of the injection suite's cross-account move.
#
# usage: make-profile.sh <xpi> <host-binary>
# Environment as tb.sh (MFT_E2E_DIR, MFT_E2E_PROFILE).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
: "${MFT_E2E_DIR:=${TMPDIR:-/tmp}/mft-e2e}"
: "${MFT_E2E_PROFILE:=${TMPDIR:-/tmp}/mft-e2e-profile}"
export MFT_E2E_DIR MFT_E2E_PROFILE

ADDON_ID=mcp-for-thunderbird@wadejbeckett.github.io
HOST_NAME=mcp_for_thunderbird
xpi=$(realpath "$1")
host=$(realpath "$2")
prof=$MFT_E2E_PROFILE

# The profile is removed with rm -rf: check its name and that it is not
# under ~/.thunderbird first (both resolved).
real=$(realpath -m "$prof")
case "$(basename "$real")" in
  mft-e2e*) ;;
  *) echo "make-profile.sh: refusing profile $prof (name must start mft-e2e)" >&2; exit 1 ;;
esac
case "$real" in
  "$(realpath -m "$HOME")"/.thunderbird*) echo "make-profile.sh: refusing profile $prof" >&2; exit 1 ;;
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

mkdir -p "$prof/extensions"
cp "$xpi" "$prof/extensions/$ADDON_ID.xpi"

# Only the throwaway home: never the real ~/.mozilla.
HOME="$MFT_E2E_DIR/home" XDG_CONFIG_HOME="$MFT_E2E_DIR/home/.config" \
  "$host" setup --native-only >/dev/null
nmh=$MFT_E2E_DIR/home/.mozilla/native-messaging-hosts/$HOST_NAME.json
if ! grep -qF "\"path\": \"$host\"" "$nmh"; then
  echo "make-profile.sh: setup --native-only did not write $nmh" >&2
  exit 1
fi
# Phase 1: Local Folders only, store the login, quit.
base_prefs
pref mail.accountmanager.accounts '"account2"'
pref mail.account.account2.server '"server2"'
"$here/tb.sh" start
sleep 2
result=$("$here/tb.sh" marionette - <<'JS'
const resolve = arguments[arguments.length - 1];
(async () => {
  const origin = "imap://127.0.0.1";
  const li = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  li.init(origin, null, origin, "test", "test", "", "");
  await Services.logins.addLoginAsync(li);
  const li2 = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  li2.init(origin, null, origin, "other", "other", "", "");
  await Services.logins.addLoginAsync(li2);
  const all = await Services.logins.getAllLogins();
  return all.filter((l) => l.origin === origin).length;
})().then(resolve, (e) => resolve("error: " + e));
JS
)
"$here/tb.sh" stop
# A connection file from this start (if the add-on already ran) is stale.
rm -rf "$MFT_E2E_DIR/home/.config/mcp-for-thunderbird"
if [ "$result" != "2" ]; then
  echo "make-profile.sh: storing the test login failed: $result" >&2
  exit 1
fi

# Phase 2: the IMAP accounts.
base_prefs
for kv in \
  'mail.accountmanager.accounts "account1,account3,account2"' \
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
  'mail.account.account3.identities "id2"' \
  'mail.account.account3.server "server3"' \
  'mail.server.server3.type "imap"' \
  'mail.server.server3.hostname "127.0.0.1"' \
  'mail.server.server3.port 3143' \
  'mail.server.server3.userName "other"' \
  'mail.server.server3.name "other@localhost"' \
  'mail.server.server3.socketType 0' \
  'mail.server.server3.authMethod 3' \
  'mail.server.server3.login_at_startup true' \
  'mail.server.server3.directory-rel "[ProfD]ImapMail/127.0.0.1-other"' \
  'mail.identity.id2.useremail "other@localhost"' \
  'mail.identity.id2.fullName "Other User"' \
  'mail.identity.id2.smtpServer "smtp1"' \
  'mail.identity.id2.valid true' \
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
