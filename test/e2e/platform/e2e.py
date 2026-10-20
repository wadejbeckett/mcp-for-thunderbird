#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""End-to-end harness for macOS and Windows (Linux uses test/e2e/run.sh).

It does what run.sh, make-profile.sh and tb.sh do, without /proc, Xvfb,
setsid or Docker: GreenMail runs as the pinned standalone jar, Thunderbird
runs headless (MOZ_HEADLESS=1) on a throwaway profile, and the host is the
one the installer put in place (MFT_E2E_BIN).

usage:
  e2e.py run [go test args]
  e2e.py tb start | stop | running | wait-conn [s] | sync [n] | marionette <file|->

Environment:
  MFT_E2E_BIN          the installed host binary (required for run)
  MFT_E2E_THUNDERBIRD  the Thunderbird executable (required)
  MFT_E2E_GREENMAIL    the GreenMail standalone jar (required for run)
  MFT_E2E_DIR          work dir, MFT_E2E_PROFILE profile dir; both names
                       must start mft-e2e (default under the temp dir)
  MFT_E2E_RUN          go test -run pattern (default TestE2ERead$|TestE2EOrganise$)
  MFT_E2E_KEEP=1       keep the work dir and profile
  MFT_E2E_HEADLESS=0   show Thunderbird's window instead of running headless

Safety: Thunderbird runs only with --profile <throwaway> --no-remote, with
HOME (macOS) or APPDATA (Windows) pointing at a throwaway folder so the
connection file stays out of the real one. Thunderbird finds the native
manifest the installer registered: the HKCU key on Windows, and on macOS
~/Library/Mozilla of the real user (it does not follow HOME there), so run
this only on a machine where installing the host is wanted. Every process this script
signals is one it started: Thunderbird is found by its command line naming
the throwaway profile and checked against the pid file's start time, and
it is stopped with its own child processes only. Mail goes only to
GreenMail on 127.0.0.1. Needs Python 3.9+ and psutil.
"""
import imaplib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from email.utils import formatdate
from pathlib import Path

import psutil

HERE = Path(__file__).resolve().parent
E2E = HERE.parent
REPO = E2E.parent.parent
ADDON_ID = "mcp-for-thunderbird@wadejbeckett.github.io"
WIN = sys.platform == "win32"
MAC = sys.platform == "darwin"

TMP = Path(tempfile.gettempdir())
WORK = Path(os.environ.get("MFT_E2E_DIR") or TMP / "mft-e2e")
PROFILE = Path(os.environ.get("MFT_E2E_PROFILE") or TMP / "mft-e2e-profile")
HOME = WORK / "home"
PIDFILE = WORK / "tb.pid"
HEADLESS = os.environ.get("MFT_E2E_HEADLESS", "1") != "0"


def log(msg):
    print(f"[e2e] {msg}", file=sys.stderr, flush=True)


def die(msg):
    print(f"e2e.py: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def real_thunderbird_dirs():
    h = Path.home()
    dirs = [h / ".thunderbird", h / "Library" / "Thunderbird"]
    if os.environ.get("APPDATA"):
        dirs.append(Path(os.environ["APPDATA"]) / "Thunderbird")
    return [d.resolve() for d in dirs]


def check_dirs():
    """Both dirs are removed with rmtree: check their names first."""
    for d in (WORK, PROFILE):
        r = d.resolve()
        if not r.name.startswith("mft-e2e"):
            die(f"refusing {d} (the name must start mft-e2e)")
        for real in real_thunderbird_dirs():
            if r == real or real in r.parents:
                die(f"refusing {d} (inside a real Thunderbird folder)")


def config_dir():
    """Where the host (os.UserConfigDir) keeps its connection file."""
    if WIN:
        return HOME / "AppData" / "Roaming"
    if MAC:
        return HOME / "Library" / "Application Support"
    return HOME / ".config"


def tb_env():
    env = dict(os.environ)
    if HEADLESS:
        env["MOZ_HEADLESS"] = "1"
    env["MOZ_CRASHREPORTER_DISABLE"] = "1"
    env["XDG_CONFIG_HOME"] = str(HOME / ".config")
    if WIN:
        env["APPDATA"] = str(config_dir())
    else:
        env["HOME"] = str(HOME)
    return env


# --- Thunderbird control (tb.sh) ---------------------------------------


def our_process():
    """The Thunderbird main process of our profile, if the pid file still
    describes it; a stale pid file is removed."""
    try:
        pid, created, port = PIDFILE.read_text().split()
        p = psutil.Process(int(pid))
        if abs(p.create_time() - float(created)) < 0.01 and profile_arg(p):
            return p, int(port)
    except (OSError, ValueError, psutil.Error):
        pass
    PIDFILE.unlink(missing_ok=True)
    return None, None


def profile_arg(p):
    try:
        cmd = p.cmdline()
    except psutil.Error:
        return False
    want = str(PROFILE)
    return any(cmd[i] in ("--profile", "-profile") and os.path.normcase(cmd[i + 1]) == os.path.normcase(want)
               for i in range(len(cmd) - 1))


def find_main():
    """The process running Thunderbird for our profile (a launcher may have
    started it and exited)."""
    for p in psutil.process_iter():
        if profile_arg(p):
            return p
    return None


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def set_pref(name, value):
    uj = PROFILE / "user.js"
    lines = [l for l in uj.read_text().splitlines() if f'"{name}"' not in l] if uj.exists() else []
    lines.append(f'user_pref("{name}", {value});')
    uj.write_text("\n".join(lines) + "\n")


def tb_start(extra=()):
    check_dirs()
    if our_process()[0]:
        die("Thunderbird is already running")
    exe = os.environ.get("MFT_E2E_THUNDERBIRD") or die("MFT_E2E_THUNDERBIRD not set")
    port = free_port()
    set_pref("marionette.port", port)
    config_dir().mkdir(parents=True, exist_ok=True)
    out = open(WORK / "tb.out", "ab")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if WIN else 0
    headless = ["--headless"] if HEADLESS else []
    proc = subprocess.Popen([exe, "--profile", str(PROFILE), "--no-remote", *headless,
                             "--marionette", "--remote-allow-system-access", *extra],
                            env=tb_env(), stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                            creationflags=flags, start_new_session=not WIN)
    out.close()
    # The started process is Thunderbird's main process, unless a launcher
    # (Windows) hands over to another process and exits: then the main
    # process is the one running with our profile.
    started = time.time()
    main = None
    while time.time() - started < 20:
        if proc.poll() is None:
            if time.time() - started >= 2:
                main = psutil.Process(proc.pid)
                break
        else:
            main = find_main()
            if main:
                break
        time.sleep(0.1)
    if not main:
        die(f"Thunderbird did not start (exit {proc.poll()}); see {WORK / 'tb.out'}")
    PIDFILE.write_text(f"{main.pid} {main.create_time()} {port}\n")


def tree(p):
    try:
        return [p] + p.children(recursive=True)
    except psutil.Error:
        return [p]


def owned_port(limit=60):
    p, port = our_process()
    if not p:
        die("the e2e Thunderbird is not running")
    deadline = time.time() + limit
    while time.time() < deadline:
        for q in tree(p):
            try:
                for c in q.net_connections(kind="tcp"):
                    if c.status == psutil.CONN_LISTEN and c.laddr.port == port:
                        return port
            except psutil.Error:
                continue
        time.sleep(0.25)
    die(f"no Marionette listener of ours on port {port}")


def marionette(args, stdin=None):
    port = owned_port()
    r = subprocess.run([sys.executable, str(E2E / "marionette.py"), str(port), *args],
                       input=stdin, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"marionette: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def tb_stop():
    p, port = our_process()
    if not p:
        return
    procs = tree(p)
    try:
        subprocess.run([sys.executable, str(E2E / "marionette.py"), str(port), "--quit"],
                       timeout=20, capture_output=True)
    except (subprocess.SubprocessError, OSError):
        pass
    gone, alive = psutil.wait_procs(procs, timeout=15)
    # Re-check before signalling: the main process must still be ours.
    if alive and our_process()[0]:
        for q in alive:
            try:
                q.terminate()
            except psutil.Error:
                pass
        gone, alive = psutil.wait_procs(alive, timeout=10)
        for q in alive:
            try:
                q.kill()
            except psutil.Error:
                pass
        psutil.wait_procs(alive, timeout=5)
    PIDFILE.unlink(missing_ok=True)


def wait_conn(limit=120, fatal=True):
    d = config_dir() / "mcp-for-thunderbird"
    deadline = time.time() + limit
    while time.time() < deadline:
        for f in sorted(d.glob("connection-*.json")) if d.is_dir() else []:
            try:
                pid = json.loads(f.read_text()).get("pid")
            except (OSError, ValueError):
                continue
            if pid and psutil.pid_exists(pid):
                return str(f)
        time.sleep(0.5)
    if fatal:
        die(f"no connection file after {limit}s")
    return None


DIAG_JS = """
const resolve = arguments[arguments.length - 1];
(async () => {
  const id = "ADDON_ID";
  const out = { home: Services.env.get("HOME"), appdata: Services.env.get("APPDATA") };
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const a = await AddonManager.getAddonByID(id);
    out.addon = a && { active: a.isActive, userDisabled: a.userDisabled, appDisabled: a.appDisabled,
      version: a.version, signedState: a.signedState, location: a.location && a.location.name };
  } catch (e) { out.addonError = String(e); }
  for (const key of ["XREUserNativeManifests", "XRESysNativeManifests"]) {
    try { out[key] = Services.dirsvc.get(key, Ci.nsIFile).path; } catch (e) { out[key] = "error: " + e; }
  }
  try {
    const { NativeManifests } = ChromeUtils.importESModule("resource://gre/modules/NativeManifests.sys.mjs");
    const r = await NativeManifests.lookupManifest("stdio", "mcp_for_thunderbird", { id });
    out.lookup = r ? r.path : null;
  } catch (e) { out.lookupError = String(e); }
  out.console = Services.console.getMessageArray().map((m) => String(m.message || m.errorMessage || m))
    .filter((m) => /native|mcp|extension|addon|connect/i.test(m)).slice(-30);
  return JSON.stringify(out, null, 1);
})().then(resolve, (e) => resolve("error: " + e));
"""


def diagnose():
    """Prints what the harness can see when the host did not start."""
    log("diagnostics")
    for root in (HOME, Path.home() / "Library" / "Mozilla"):
        if root.exists():
            for f in sorted(root.rglob("*")):
                print(f"  {f}", file=sys.stderr)
    p, _ = our_process()
    if p:
        for q in tree(p):
            try:
                print(f"  process {q.pid} {q.name()}", file=sys.stderr)
            except psutil.Error:
                pass
        if MAC:
            # Where the main thread is (sample needs no root for our own process).
            r = subprocess.run(["sample", str(p.pid), "2"], capture_output=True, text=True)
            lines = r.stdout.splitlines()
            start = next((i for i, l in enumerate(lines) if "Call graph:" in l), 0)
            print("\n".join(lines[start:start + 120]), file=sys.stderr)
        try:
            print(marionette(["-"], DIAG_JS.replace("ADDON_ID", ADDON_ID)), file=sys.stderr)
        except SystemExit:
            pass


SYNC_JS = """
const resolve = arguments[arguments.length - 1];
(async () => {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const server = MailServices.accounts.getAccount("account1").incomingServer;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let inbox = null;
  for (let i = 0; i < 120; i++) {
    inbox = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    if (inbox && inbox.getTotalMessages(false) >= WANT) break;
    if (inbox && i % 10 === 0) inbox.updateFolder(null);
    await sleep(500);
  }
  if (!inbox || inbox.getTotalMessages(false) < WANT) return "timeout (headers)";
  const offline = () => [...inbox.msgDatabase.enumerateMessages()].filter((h) => h.flags & Ci.nsMsgMessageFlags.Offline).length;
  for (let i = 0; i < 120; i++) {
    if (offline() >= WANT) return inbox.getTotalMessages(false);
    if (i % 10 === 0) inbox.downloadAllForOffline(null, null);
    await sleep(500);
  }
  return "timeout (offline bodies)";
})().then(resolve, (e) => resolve("error: " + e));
"""


def tb_main(argv):
    cmd, rest = (argv[0], argv[1:]) if argv else ("", [])
    if cmd == "start":
        tb_start(rest)
    elif cmd == "stop":
        tb_stop()
    elif cmd == "running":
        sys.exit(0 if our_process()[0] else 1)
    elif cmd == "wait-conn":
        print(wait_conn(int(rest[0]) if rest else 120))
    elif cmd == "sync":
        print(marionette(["-"], SYNC_JS.replace("WANT", str(int(rest[0]) if rest else 1))))
    elif cmd == "marionette":
        src = sys.stdin.read() if rest == ["-"] else None
        print(marionette(rest if src is None else ["-"], src))
    else:
        die("usage: e2e.py tb start|stop|running|wait-conn [s]|sync [n]|marionette <file|->")


# --- Profile (make-profile.sh) -----------------------------------------

BASE_PREFS = [
    ("extensions.autoDisableScopes", "0"),
    ("extensions.enabledScopes", "15"),
    ("xpinstall.signatures.required", "false"),
    ("mail.shell.checkDefaultClient", "false"),
    ("mailnews.start_page.enabled", "false"),
    ("mail.provider.enabled", "false"),
    ("datareporting.policy.dataSubmissionEnabled", "false"),
    ("toolkit.telemetry.reportingpolicy.firstRun", "false"),
    ("app.update.enabled", "false"),
    ("app.update.auto", "false"),
    ("mail.rights.version", "1"),
    ("mail.ui-rdf.version", "999"),
    ("mail.spotlight.firstRunDone", "true"),
    ("mail.winsearch.firstRunDone", "true"),
    ("mail.biff.show_alert", "false"),
    ("mail.biff.play_sound", "false"),
    ("mailnews.database.global.indexer.enabled", "false"),
    ("devtools.console.stdout.chrome", "true"),
    ("devtools.console.stdout.content", "true"),
    ("mail.accountmanager.localfoldersserver", '"server2"'),
    ("mail.server.server2.type", '"none"'),
    ("mail.server.server2.hostname", '"Local Folders"'),
    ("mail.server.server2.userName", '"nobody"'),
    ("mail.server.server2.name", '"Local Folders"'),
    ("mail.server.server2.directory-rel", '"[ProfD]Mail/Local Folders"'),
    # No macOS system address book: opening it asks for Contacts access,
    # and on a CI runner that request blocks Thunderbird's main thread for
    # ever (seen in a main-thread sample, +[ABAddressBook sharedAddressBook]).
    # dirType -1 is what Thunderbird's deleteAddressBook writes for it.
    ("ldap_2.servers.osx.dirType", "-1"),
    ("ldap_2.servers.osx.position", "0"),
]

ACCOUNT_PREFS = """
mail.accountmanager.accounts "account1,account3,account2"
mail.accountmanager.defaultaccount "account1"
mail.account.account1.identities "id1"
mail.account.account1.server "server1"
mail.account.account2.server "server2"
mail.server.server1.type "imap"
mail.server.server1.hostname "127.0.0.1"
mail.server.server1.port 3143
mail.server.server1.userName "test"
mail.server.server1.name "test@localhost"
mail.server.server1.socketType 0
mail.server.server1.authMethod 3
mail.server.server1.login_at_startup true
mail.server.server1.check_new_mail true
mail.server.server1.check_time 1
mail.server.server1.offline_download true
mail.server.server1.autosync_offline_stores true
mail.server.server1.directory-rel "[ProfD]ImapMail/127.0.0.1"
mail.server.server1.useIdle true
mail.server.default.autosync_max_age_days -1
mail.account.account3.identities "id2"
mail.account.account3.server "server3"
mail.server.server3.type "imap"
mail.server.server3.hostname "127.0.0.1"
mail.server.server3.port 3143
mail.server.server3.userName "other"
mail.server.server3.name "other@localhost"
mail.server.server3.socketType 0
mail.server.server3.authMethod 3
mail.server.server3.login_at_startup true
mail.server.server3.directory-rel "[ProfD]ImapMail/127.0.0.1-other"
mail.identity.id2.useremail "other@localhost"
mail.identity.id2.fullName "Other User"
mail.identity.id2.smtpServer "smtp1"
mail.identity.id2.valid true
mail.identity.id1.useremail "test@localhost"
mail.identity.id1.fullName "Test User"
mail.identity.id1.smtpServer "smtp1"
mail.identity.id1.valid true
mail.identity.id1.draft_folder "imap://test@127.0.0.1/Drafts"
mail.identity.id1.fcc_folder "imap://test@127.0.0.1/Sent"
mail.identity.id1.stationery_folder "imap://test@127.0.0.1/Templates"
mail.smtpservers "smtp1"
mail.smtp.defaultserver "smtp1"
mail.smtpserver.smtp1.hostname "127.0.0.1"
mail.smtpserver.smtp1.port 3025
mail.smtpserver.smtp1.authMethod 1
mail.smtpserver.smtp1.try_ssl 0
mail.smtpserver.smtp1.username ""
mail.smtpserver.smtp1.description "GreenMail"
"""

LOGINS_JS = """
const resolve = arguments[arguments.length - 1];
(async () => {
  const origin = "imap://127.0.0.1";
  for (const [u, p] of [["test", "test"], ["other", "other"]]) {
    const li = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    li.init(origin, null, origin, u, p, "", "");
    await Services.logins.addLoginAsync(li);
  }
  const all = await Services.logins.getAllLogins();
  return all.filter((l) => l.origin === origin).length;
})().then(resolve, (e) => resolve("error: " + e));
"""


def write_prefs(prefs):
    (PROFILE / "user.js").write_text("".join(f'user_pref("{k}", {v});\n' for k, v in prefs))


def make_profile(xpi):
    if PROFILE.exists():
        shutil.rmtree(PROFILE)
    (PROFILE / "extensions").mkdir(parents=True)
    shutil.copy(xpi, PROFILE / "extensions" / f"{ADDON_ID}.xpi")
    # Phase 1: Local Folders only; store the GreenMail logins; quit. This
    # start also installs the sideloaded XPI (docs/SPIKES.md).
    write_prefs(BASE_PREFS + [("mail.accountmanager.accounts", '"account2"'),
                              ("mail.account.account2.server", '"server2"')])
    tb_start()
    time.sleep(2)
    result = marionette(["-"], LOGINS_JS)
    tb_stop()
    shutil.rmtree(config_dir() / "mcp-for-thunderbird", ignore_errors=True)
    if result != "2":
        die(f"storing the test logins failed: {result}")
    # Phase 2: the IMAP accounts.
    prefs = list(BASE_PREFS)
    for line in ACCOUNT_PREFS.strip().splitlines():
        k, v = line.split(" ", 1)
        prefs.append((k, v))
    write_prefs(prefs)


# --- GreenMail ---------------------------------------------------------


def greenmail_start(jar):
    out = open(WORK / "greenmail.out", "ab")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if WIN else 0
    p = subprocess.Popen(["java", "-Xmx512m",
                          "-Dgreenmail.setup.test.all",
                          "-Dgreenmail.users=test:test@localhost,other:other@localhost",
                          "-Dgreenmail.hostname=127.0.0.1",
                          "-Dgreenmail.api.hostname=127.0.0.1",
                          "-Dgreenmail.api.port=3080",
                          "-jar", str(jar)],
                         stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                         creationflags=flags, start_new_session=not WIN)
    out.close()
    deadline = time.time() + 90
    while time.time() < deadline:
        if p.poll() is not None:
            die(f"GreenMail exited ({p.returncode}); see {WORK / 'greenmail.out'}")
        try:
            with imaplib.IMAP4("127.0.0.1", 3143) as m:
                m.login("test", "test")
            urllib.request.urlopen("http://127.0.0.1:3080/api/service/readiness", timeout=2).read()
            return p
        except (OSError, imaplib.IMAP4.error):
            time.sleep(0.5)
    die("GreenMail did not start")


def stop_process(p):
    if p is None or p.poll() is not None:
        return
    p.terminate()
    try:
        p.wait(15)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait(5)


def seed():
    fixtures = sorted((E2E / "fixtures" / "seed").glob("*.eml")) + sorted((E2E / "fixtures" / "hostile").glob("*.eml"))
    date = formatdate(localtime=False)
    with imaplib.IMAP4("127.0.0.1", 3143) as m:
        m.login("test", "test")
        for f in fixtures:
            text = f.read_bytes().replace(b"@DATE@", date.encode())
            text = b"\r\n".join(text.replace(b"\r\n", b"\n").split(b"\n"))
            typ, _ = m.append("INBOX", None, None, text)
            if typ != "OK":
                die(f"append {f.name}: {typ}")
        # Thunderbird finds Trash by name; the identity names Drafts and Sent.
        for folder in ("Trash", "Sorted", "Drafts", "Sent"):
            m.create(folder)
            m.subscribe(folder)
        m.select("INBOX")
        m.store("1:*", "-FLAGS", "(\\Seen)")
    with imaplib.IMAP4("127.0.0.1", 3143) as m:
        m.login("other", "other")
        m.create("Elsewhere")
        m.subscribe("Elsewhere")
    return len(fixtures)


# --- run -------------------------------------------------------------------


def run(goargs):
    check_dirs()
    host = os.environ.get("MFT_E2E_BIN") or die("MFT_E2E_BIN not set (the installed host)")
    jar = os.environ.get("MFT_E2E_GREENMAIL") or die("MFT_E2E_GREENMAIL not set")
    if our_process()[0]:
        die("an e2e Thunderbird from an earlier run is still running; stop it with e2e.py tb stop")
    for d in (WORK, PROFILE):
        shutil.rmtree(d, ignore_errors=True)
    (WORK / "attachments").mkdir(parents=True)
    HOME.mkdir(parents=True)
    gm = None
    rc = 1
    try:
        log("starting GreenMail")
        gm = greenmail_start(jar)
        log("seeding fixtures")
        n = seed()

        log("building the add-on")
        attachments = WORK / "attachments"
        settings = {"accounts": {"account1": True, "account3": True},
                    "groups": {"read": True, "organise": True, "compose": True, "contacts": False},
                    "send": {"enabled": True, "allow": ["@localhost"]},
                    "attachmentDir": str(attachments), "setupDone": True}
        (WORK / "e2e-settings.json").write_text(json.dumps(settings, indent=2))
        defaults = subprocess.run(["node", "--input-type=module", "-e",
                                   "import { DEFAULTS } from " + json.dumps((REPO / "addon/src/settings.js").as_uri()) +
                                   "; console.log(JSON.stringify({ groups: DEFAULTS.groups, send: DEFAULTS.send }))"],
                                  check=True, capture_output=True, text=True).stdout
        (WORK / "defaults.json").write_text(defaults)
        xpi = WORK / "mcp-for-thunderbird-e2e.xpi"
        subprocess.run(["node", str(REPO / "packaging/build-xpi.mjs"), "--e2e-settings",
                        str(WORK / "e2e-settings.json"), "--out", str(xpi)], check=True,
                       stdout=subprocess.DEVNULL)

        log("building the profile")
        make_profile(xpi)

        log("starting Thunderbird")
        tb_start()
        conn = wait_conn(120, fatal=False)
        if not conn:
            diagnose()
            die("no connection file after 120s")
        log("connection file: " + Path(conn).name)
        synced = marionette(["-"], SYNC_JS.replace("WANT", str(n)))
        if not synced.isdigit():
            die(f"inbox sync failed: {synced}")
        log(f"inbox synchronised: {synced} messages")

        log("running the tests")
        wrapper = HERE / ("tbctl.cmd" if WIN else "tbctl")
        env = dict(os.environ, MFT_E2E="1", MFT_E2E_PYTHON=sys.executable, MFT_E2E_BIN=host, MFT_E2E_TB=str(wrapper),
                   MFT_E2E_ATTACHMENTS=str(attachments), MFT_E2E_DEFAULTS=str(WORK / "defaults.json"),
                   MFT_E2E_CONFIG=str(config_dir()), MFT_E2E_HOME=str(HOME),
                   MFT_E2E_DIR=str(WORK), MFT_E2E_PROFILE=str(PROFILE))
        env.setdefault("GOTOOLCHAIN", "auto")
        pattern = os.environ.get("MFT_E2E_RUN", "TestE2ERead$|TestE2EOrganise$")
        rc = subprocess.run(["go", "test", "-count=1", "-run", pattern, *goargs, "./..."],
                            cwd=E2E, env=env).returncode
    finally:
        log("teardown")
        tb_stop()
        stop_process(gm)
        if rc != 0:
            for name in ("tb.out", "greenmail.out"):
                f = WORK / name
                if f.exists():
                    log(f"--- {name} (last 80 lines)")
                    print("\n".join(f.read_text(errors="replace").splitlines()[-80:]), file=sys.stderr)
        if os.environ.get("MFT_E2E_KEEP") == "1":
            log(f"kept {WORK} and {PROFILE}")
        else:
            shutil.rmtree(WORK, ignore_errors=True)
            shutil.rmtree(PROFILE, ignore_errors=True)
    return rc


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "tb":
        tb_main(sys.argv[2:])
    elif len(sys.argv) >= 2 and sys.argv[1] == "run":
        sys.exit(run(sys.argv[2:]))
    else:
        die("usage: e2e.py run [go test args] | e2e.py tb <command>")


if __name__ == "__main__":
    main()
