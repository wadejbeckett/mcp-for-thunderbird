#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Start and stop the end-to-end Thunderbird: the throwaway profile only,
# under its own Xvfb display, in its own process group, with HOME set to a
# throwaway directory (so the native manifest and the connection file stay
# out of the real home). Never touches any other Thunderbird.
#
# Marionette exposure: the e2e Thunderbird runs with --marionette and
# --remote-allow-system-access, so any local process can run chrome code in
# it through its Marionette port while it runs. The port is a random free
# port on 127.0.0.1 chosen at each start, the profile holds only GreenMail
# test data, and every Marionette call here first checks that the port's
# listener is in our process group.
#
# usage: tb.sh start [extra thunderbird args] | stop | running |
#        wait-conn [seconds] | sync [count] | marionette <script-file | ->
# Environment: MFT_E2E_DIR (work dir), MFT_E2E_PROFILE (profile dir; its
# name must start mft-e2e).
#
# The pid file holds "<xvfb-run pid> <its start time> <Marionette port>".
# Nothing is signalled unless that pid still leads its process group, has
# the same start time (/proc/<pid>/stat field 22) and the command line this
# script started; otherwise the pid file is stale and is removed.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
: "${MFT_E2E_DIR:=${TMPDIR:-/tmp}/mft-e2e}"
: "${MFT_E2E_PROFILE:=${TMPDIR:-/tmp}/mft-e2e-profile}"
HOME_DIR=$MFT_E2E_DIR/home
PIDFILE=$MFT_E2E_DIR/tb.pid
CONN_DIR=$HOME_DIR/.config/mcp-for-thunderbird

check_profile() {
  local real
  real=$(realpath -m "$MFT_E2E_PROFILE")
  case "$(basename "$real")" in
    mft-e2e*) ;;
    *) echo "tb.sh: refusing profile $MFT_E2E_PROFILE (the name must start mft-e2e)" >&2; exit 1 ;;
  esac
  case "$real" in
    "$(realpath -m "$HOME")"/.thunderbird*) echo "tb.sh: refusing profile $MFT_E2E_PROFILE" >&2; exit 1 ;;
  esac
}

start_time() { # pid: field 22 of /proc/<pid>/stat (after the "(comm)" field)
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  # The text after "(comm) " starts at field 3, so field 22 is word 20.
  echo "$stat" | awk '{print $20}'
}

ours_cmdline() { # pid: is it the xvfb-run this script starts for our profile?
  local cmd
  cmd=$(tr '\0' '\n' <"/proc/$1/cmdline" 2>/dev/null) || return 1
  grep -qx -- "--profile" <<<"$cmd" && grep -qxF -- "$MFT_E2E_PROFILE" <<<"$cmd" &&
    grep -q "xvfb-run" <<<"$cmd"
}

# group_pid prints our xvfb-run pid when the pid file still describes a live
# process of ours that leads its group; a stale pid file is removed.
group_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid st port pgid
  read -r pid st port <"$PIDFILE" || true
  if [ -n "${pid:-}" ] && [ -n "${st:-}" ] &&
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ') && [ "$pgid" = "$pid" ] &&
    [ "$(start_time "$pid")" = "$st" ] && ours_cmdline "$pid"; then
    echo "$pid"
    return 0
  fi
  rm -f "$PIDFILE"
  return 1
}

# owned_port prints the Marionette port once its listener is a process in
# our group; it waits up to <seconds> for it.
owned_port() {
  local limit=${1:-60} pid port lpid
  pid=$(group_pid) || { echo "tb.sh: the e2e Thunderbird is not running" >&2; return 1; }
  read -r _ _ port <"$PIDFILE"
  for _ in $(seq 1 $((limit * 4))); do
    for lpid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      if [ "$(ps -o pgid= -p "$lpid" 2>/dev/null | tr -d ' ')" = "$pid" ]; then
        echo "$port"
        return 0
      fi
    done
    sleep 0.25
  done
  echo "tb.sh: no Marionette listener of ours on port $port" >&2
  return 1
}

# marionette runs one chrome script (file or -) in our Thunderbird.
marionette() {
  local port
  port=$(owned_port 60) || return 1
  python3 "$here/marionette.py" "$port" "$@"
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

start() {
  check_profile
  if group_pid >/dev/null; then
    echo "tb.sh: already running" >&2
    exit 1
  fi
  local port pid st
  port=$(free_port)
  # user.js is read at each start; set this start's Marionette port.
  sed -i '/"marionette.port"/d' "$MFT_E2E_PROFILE/user.js"
  printf 'user_pref("marionette.port", %s);\n' "$port" >>"$MFT_E2E_PROFILE/user.js"
  mkdir -p "$HOME_DIR/.config"
  HOME=$HOME_DIR XDG_CONFIG_HOME=$HOME_DIR/.config MOZ_CRASHREPORTER_DISABLE=1 \
    setsid xvfb-run -a -s "-screen 0 1600x1000x24" \
    thunderbird --profile "$MFT_E2E_PROFILE" --no-remote --marionette --remote-allow-system-access "$@" \
    >>"$MFT_E2E_DIR/tb.out" 2>&1 </dev/null &
  pid=$!
  st=$(start_time "$pid")
  # Wait until setsid has made it a group leader running xvfb-run, so the
  # pid file is never judged stale while the process is still starting.
  for _ in $(seq 1 40); do
    [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ] && ours_cmdline "$pid" && break
    sleep 0.05
  done
  echo "$pid $st $port" >"$PIDFILE"
  group_pid >/dev/null || { echo "tb.sh: Thunderbird did not start" >&2; exit 1; }
}

stop() {
  local pid port
  pid=$(group_pid) || return 0
  # A clean quit first, so Thunderbird writes its stores; then signals.
  if port=$(owned_port 1 2>/dev/null); then
    timeout 20 python3 "$here/marionette.py" "$port" --quit >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 60); do
    ps -o comm= -g "$pid" 2>/dev/null | grep -q thunderbird || break
    sleep 0.25
  done
  # Re-check before each signal: the group must still be ours.
  group_pid >/dev/null || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    ps -o pid= -g "$pid" >/dev/null 2>&1 || break
    sleep 0.25
  done
  if group_pid >/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      ps -o pid= -g "$pid" >/dev/null 2>&1 || break
      sleep 0.25
    done
  fi
  rm -f "$PIDFILE"
}

# wait_conn waits for a connection file whose host process is alive.
wait_conn() {
  local limit=${1:-120} f pid
  for _ in $(seq 1 $((limit * 2))); do
    for f in "$CONN_DIR"/connection-*.json; do
      [ -f "$f" ] || continue
      pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f")
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "$f"
        return 0
      fi
    done
    sleep 0.5
  done
  echo "tb.sh: no connection file after ${limit}s" >&2
  return 1
}

# sync asks Thunderbird to update the IMAP inbox now (instead of at the next
# new-mail check), waits until it holds at least <count> messages, then
# downloads them for offline use and waits for that too: body searches
# (fullText) only match messages whose bodies are stored offline.
sync() {
  local want=${1:-1}
  marionette - <<JS
const resolve = arguments[arguments.length - 1];
(async () => {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const server = MailServices.accounts.getAccount("account1").incomingServer;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let inbox = null;
  for (let i = 0; i < 120; i++) {
    inbox = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    if (inbox && inbox.getTotalMessages(false) >= $want) break;
    if (inbox && i % 10 === 0) inbox.updateFolder(null);
    await sleep(500);
  }
  if (!inbox || inbox.getTotalMessages(false) < $want) return "timeout (headers)";
  const offline = () => [...inbox.msgDatabase.enumerateMessages()].filter((h) => h.flags & Ci.nsMsgMessageFlags.Offline).length;
  for (let i = 0; i < 120; i++) {
    if (offline() >= $want) return inbox.getTotalMessages(false);
    if (i % 10 === 0) inbox.downloadAllForOffline(null, null);
    await sleep(500);
  }
  return "timeout (offline bodies)";
})().then(resolve, (e) => resolve("error: " + e));
JS
}

cmd=${1:-}
shift || true
case "$cmd" in
  start) start "$@" ;;
  stop) stop ;;
  wait-conn) wait_conn "$@" ;;
  running) group_pid >/dev/null ;;
  sync) sync "$@" ;;
  marionette) marionette "$@" ;;
  *) echo "usage: tb.sh start|stop|running|wait-conn [s]|sync [count]|marionette <file|->" >&2; exit 2 ;;
esac
