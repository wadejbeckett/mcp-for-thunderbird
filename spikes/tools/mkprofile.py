#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""THROWAWAY spike (Task 2): build a throwaway Thunderbird profile whose IMAP
account points at the GreenMail container, with the spike add-on sideloaded.

usage: mkprofile.py <profile-dir> <imap-user> <xpi> [extra-pref=value ...]
"""
import os, shutil, sys

prof, user, xpi = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
os.makedirs(os.path.join(prof, "extensions"), exist_ok=True)
shutil.copy(xpi, os.path.join(prof, "extensions", "mft-spike@wadejbeckett.github.io.xpi"))

prefs = {
    # Sideloaded unsigned spike add-on.
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "xpinstall.signatures.required": False,
    # Quiet first run.
    "mail.shell.checkDefaultClient": False,
    "mailnews.start_page.enabled": False,
    "mail.provider.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "app.update.enabled": False,
    "app.update.auto": False,
    "browser.shell.checkDefaultBrowser": False,
    "mail.rights.version": 1,
    "mail.ui-rdf.version": 999,
    "mail.spotlight.firstRunDone": True,
    "mail.winsearch.firstRunDone": True,
    "calendar.timezone.local": "UTC",
    "calendar.timezone.useSystemTimezone": True,
    "mail.biff.show_alert": False,
    "mail.biff.play_sound": False,
    # Accounts: one IMAP account on GreenMail plus Local Folders.
    "mail.accountmanager.accounts": "account1,account2",
    "mail.accountmanager.defaultaccount": "account1",
    "mail.accountmanager.localfoldersserver": "server2",
    "mail.account.account1.identities": "id1",
    "mail.account.account1.server": "server1",
    "mail.account.account2.server": "server2",
    "mail.server.server1.type": "imap",
    "mail.server.server1.hostname": "127.0.0.1",
    "mail.server.server1.port": 3143,
    "mail.server.server1.userName": user,
    "mail.server.server1.name": f"{user}@localhost",
    "mail.server.server1.socketType": 0,
    "mail.server.server1.authMethod": 3,
    "mail.server.server1.login_at_startup": True,
    "mail.server.server1.check_new_mail": True,
    "mail.server.server1.check_time": 1,
    "mail.server.server1.offline_download": True,
    "mail.server.server1.autosync_offline_stores": True,
    "mail.server.server1.directory-rel": "[ProfD]ImapMail/127.0.0.1",
    "mail.server.server1.useIdle": True,
    "mail.server.server2.type": "none",
    "mail.server.server2.hostname": "Local Folders",
    "mail.server.server2.userName": "nobody",
    "mail.server.server2.name": "Local Folders",
    "mail.server.server2.directory-rel": "[ProfD]Mail/Local Folders",
    "mail.identity.id1.useremail": f"{user}@localhost",
    "mail.identity.id1.fullName": f"Spike {user}",
    "mail.identity.id1.smtpServer": "smtp1",
    "mail.identity.id1.valid": True,
    "mail.identity.id1.compose_html": True,
    "mail.identity.id1.reply_on_top": 0,
    "mail.smtpservers": "smtp1",
    "mail.smtp.defaultserver": "smtp1",
    "mail.smtpserver.smtp1.hostname": "127.0.0.1",
    "mail.smtpserver.smtp1.port": 3025,
    "mail.smtpserver.smtp1.authMethod": 1,
    "mail.smtpserver.smtp1.try_ssl": 0,
    "mail.smtpserver.smtp1.username": "",
    "mail.smtpserver.smtp1.description": "GreenMail",
    # Offline use: synchronise everything.
    "mail.server.default.autosync_max_age_days": -1,
    "mailnews.database.global.indexer.enabled": False,
}
for kv in extra:
    k, v = kv.split("=", 1)
    prefs[k] = int(v) if v.lstrip("-").isdigit() else (v == "true" if v in ("true", "false") else v)

def fmt(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'

with open(os.path.join(prof, "user.js"), "w") as f:
    for k, v in prefs.items():
        f.write(f'user_pref("{k}", {fmt(v)});\n')
print(prof)
