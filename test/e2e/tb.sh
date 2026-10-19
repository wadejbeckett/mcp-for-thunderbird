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
# usage: tb.sh start [extra thunderbird args] | stop | wait-conn [seconds] |
#        sync [count] | running
# Environment: MFT_E2E_DIR (work dir), MFT_E2E_PROFILE (profile dir),
# MFT_E2E_MARIONETTE (Marionette port).
set -euo pipefail

: "${MFT_E2E_DIR:=${TMPDIR:-/tmp}/mft-e2e}"
: "${MFT_E2E_PROFILE:=${TMPDIR:-/tmp}/mft-e2e-profile}"
: "${MFT_E2E_MARIONETTE:=28290}"
HOME_DIR=$MFT_E2E_DIR/home
PIDFILE=$MFT_E2E_DIR/tb.pid
CONN_DIR=$HOME_DIR/.config/mcp-for-thunderbird

# group_pid prints our xvfb-run pid when it still leads its process group.
group_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid pgid
  pid=$(cat "$PIDFILE")
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ') || return 1
  [ -n "$pgid" ] && [ "$pgid" = "$pid" ] || return 1
  echo "$pid"
}

start() {
  if group_pid >/dev/null; then
    echo "tb.sh: already running" >&2
    exit 1
  fi
  case "$MFT_E2E_PROFILE" in
    "$HOME"/.thunderbird*|"") echo "tb.sh: refusing profile $MFT_E2E_PROFILE" >&2; exit 1 ;;
  esac
  mkdir -p "$HOME_DIR/.config"
  HOME=$HOME_DIR XDG_CONFIG_HOME=$HOME_DIR/.config MOZ_CRASHREPORTER_DISABLE=1 \
    setsid xvfb-run -a -s "-screen 0 1600x1000x24" \
    thunderbird --profile "$MFT_E2E_PROFILE" --no-remote --marionette --remote-allow-system-access "$@" \
    >>"$MFT_E2E_DIR/tb.out" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
}

stop() {
  local pid
  pid=$(group_pid) || { rm -f "$PIDFILE"; return 0; }
  # A clean quit first, so Thunderbird writes its stores; then signals.
  timeout 20 python3 "$(dirname "$0")/marionette.py" "$MFT_E2E_MARIONETTE" --quit >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    ps -o comm= -g "$pid" 2>/dev/null | grep -q thunderbird || break
    sleep 0.25
  done
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    ps -o pid= -g "$pid" >/dev/null 2>&1 || break
    sleep 0.25
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    ps -o pid= -g "$pid" >/dev/null 2>&1 || break
    sleep 0.25
  done
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
  python3 "$(dirname "$0")/marionette.py" "$MFT_E2E_MARIONETTE" - <<JS
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
  *) echo "usage: tb.sh start|stop|wait-conn [s]|sync [count]|running" >&2; exit 2 ;;
esac
