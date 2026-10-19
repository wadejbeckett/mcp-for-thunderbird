#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# End-to-end run on Linux: GreenMail, a throwaway Thunderbird profile with
# the add-on built for e2e, the real host, then `go test` in test/e2e as an
# MCP client. Everything it starts is torn down on exit (set MFT_E2E_KEEP=1
# to keep the work directory and logs, MFT_E2E_HOLD=1 to keep Thunderbird and
# GreenMail running after the tests until Enter is pressed).
#
# Safety: Thunderbird runs only with --profile <throwaway> --no-remote under
# its own Xvfb, with HOME set to a throwaway directory; only that process
# group is ever stopped. Mail goes only to GreenMail on 127.0.0.1.
#
# usage: test/e2e/run.sh [go test args, e.g. -run TestE2ERead -v]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
export MFT_E2E_DIR=${MFT_E2E_DIR:-${TMPDIR:-/tmp}/mft-e2e}
export MFT_E2E_PROFILE=${MFT_E2E_PROFILE:-${TMPDIR:-/tmp}/mft-e2e-profile}
export GOTOOLCHAIN=${GOTOOLCHAIN:-auto}

CONTAINER=mft-greenmail
IMAGE=greenmail/standalone@sha256:1ef95a966418cd09b7ea91d504d8c0826bbe7a2f6e679a75c601a831587c1626

# Both are removed with rm -rf, so their names (resolved) are checked first,
# and neither may be under ~/.thunderbird.
for d in "$MFT_E2E_DIR" "$MFT_E2E_PROFILE"; do
  real=$(realpath -m "$d")
  case "$(basename "$real")" in
    mft-e2e*) ;;
    *) echo "run.sh: refusing $d (the name must start mft-e2e)" >&2; exit 1 ;;
  esac
  case "$real" in
    "$(realpath -m "$HOME")"/.thunderbird*) echo "run.sh: refusing $d (under ~/.thunderbird)" >&2; exit 1 ;;
  esac
done

log() { printf '[e2e] %s\n' "$*" >&2; }

greenmail_up() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$here/greenmail.compose.yaml" up -d >/dev/null
  else
    docker run -d --name "$CONTAINER" \
      -p 127.0.0.1:3143:3143 -p 127.0.0.1:3025:3025 -p 127.0.0.1:3080:8080 \
      -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.users=test:test@localhost,other:other@localhost -Dgreenmail.hostname=0.0.0.0' \
      -e JAVA_OPTS=-Xmx512m \
      "$IMAGE" >/dev/null
  fi
}

started_greenmail=0
teardown() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  log "teardown"
  "$here/tb.sh" stop
  if [ "$started_greenmail" = 1 ]; then
    if docker compose version >/dev/null 2>&1; then
      docker compose -f "$here/greenmail.compose.yaml" down >/dev/null 2>&1
    fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
  if [ "${MFT_E2E_KEEP:-0}" = 1 ]; then
    log "kept $MFT_E2E_DIR and $MFT_E2E_PROFILE"
  else
    rm -rf "$MFT_E2E_DIR" "$MFT_E2E_PROFILE"
  fi
  exit "$rc"
}

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "run.sh: a container named $CONTAINER already exists; remove it first (docker rm -f $CONTAINER)" >&2
  exit 1
fi
if "$here/tb.sh" running; then
  echo "run.sh: an e2e Thunderbird from an earlier run is still running; stop it with test/e2e/tb.sh stop" >&2
  exit 1
fi
rm -rf "$MFT_E2E_DIR" "$MFT_E2E_PROFILE"
mkdir -p "$MFT_E2E_DIR/bin" "$MFT_E2E_DIR/attachments"
trap teardown EXIT INT TERM

log "starting GreenMail"
started_greenmail=1
greenmail_up
for i in $(seq 1 120); do
  curl -s --max-time 2 -u test:test "imap://127.0.0.1:3143/" -X "NOOP" >/dev/null 2>&1 &&
    curl -s --max-time 2 --fail "http://127.0.0.1:3080/api/service/readiness" >/dev/null 2>&1 && break
  [ "$i" = 120 ] && { log "GreenMail did not start"; exit 1; }
  sleep 0.5
done

log "seeding fixtures"
date_now=$(LC_ALL=C date -R)
# The hostile fixtures (TestE2EInjectionDefaults) go into the same inbox.
for f in "$here"/fixtures/seed/*.eml "$here"/fixtures/hostile/*.eml; do
  sed -e "s/@DATE@/$date_now/" -e 's/$/\r/' "$f" >"$MFT_E2E_DIR/seed.eml"
  curl -s --fail -u test:test --upload-file "$MFT_E2E_DIR/seed.eml" "imap://127.0.0.1:3143/INBOX"
done
rm -f "$MFT_E2E_DIR/seed.eml"
# Folders for TestE2EOrganise and TestE2EDraftAndSend: Thunderbird finds
# Trash by name, the identity names Drafts and Sent (make-profile.sh), and
# GreenMail starts with INBOX only.
for folder in Trash Sorted Drafts Sent; do
  curl -s --fail -u test:test "imap://127.0.0.1:3143/" -X "CREATE $folder" >/dev/null
  curl -s --fail -u test:test "imap://127.0.0.1:3143/" -X "SUBSCRIBE $folder" >/dev/null
done
# curl appends with \Seen; the seeded mail starts unread.
curl -s --fail -u test:test "imap://127.0.0.1:3143/INBOX" -X 'STORE 1:* -FLAGS (\Seen)' >/dev/null
# The second account (other@localhost, account3 in the profile) has one
# folder of its own, the target of the cross-account move the injection
# suite expects to be refused.
curl -s --fail -u other:other "imap://127.0.0.1:3143/" -X "CREATE Elsewhere" >/dev/null
curl -s --fail -u other:other "imap://127.0.0.1:3143/" -X "SUBSCRIBE Elsewhere" >/dev/null

log "building the host and the add-on"
(cd "$repo/host" && go build -o "$MFT_E2E_DIR/bin/mcp-for-thunderbird" ./cmd/mcp-for-thunderbird)
cat >"$MFT_E2E_DIR/e2e-settings.json" <<EOF
{
  "accounts": {"account1": true, "account3": true},
  "groups": {"read": true, "organise": true, "compose": true, "contacts": false},
  "send": {"enabled": true, "allow": ["@localhost"]},
  "attachmentDir": "$MFT_E2E_DIR/attachments",
  "setupDone": true
}
EOF
# The add-on's own defaults (settings.js DEFAULTS) for
# TestE2EInjectionDefaults, so the test never restates them.
node --input-type=module -e "import { DEFAULTS } from 'file://$repo/addon/src/settings.js'; console.log(JSON.stringify({ groups: DEFAULTS.groups, send: DEFAULTS.send }))" >"$MFT_E2E_DIR/defaults.json"
node "$repo/packaging/build-xpi.mjs" --e2e-settings "$MFT_E2E_DIR/e2e-settings.json" --out "$MFT_E2E_DIR/mcp-for-thunderbird-e2e.xpi" >/dev/null

log "building the profile"
"$here/make-profile.sh" "$MFT_E2E_DIR/mcp-for-thunderbird-e2e.xpi" "$MFT_E2E_DIR/bin/mcp-for-thunderbird" >/dev/null

log "starting Thunderbird"
"$here/tb.sh" start
conn=$("$here/tb.sh" wait-conn 120)
log "connection file: $(basename "$conn")"
n=$(ls "$here"/fixtures/seed/*.eml "$here"/fixtures/hostile/*.eml | wc -l)
synced=$("$here/tb.sh" sync "$n")
case "$synced" in
  [0-9]*) log "inbox synchronised: $synced messages" ;;
  *) log "inbox sync failed: $synced"; exit 1 ;;
esac

log "running the tests"
export MFT_E2E=1
export MFT_E2E_BIN=$MFT_E2E_DIR/bin/mcp-for-thunderbird
export MFT_E2E_TB=$here/tb.sh
export MFT_E2E_ATTACHMENTS=$MFT_E2E_DIR/attachments
export MFT_E2E_DEFAULTS=$MFT_E2E_DIR/defaults.json
# The throwaway config dir holds the connection file. It is passed as its
# own variable: setting XDG_CONFIG_HOME for go itself would hide the user's
# go env file (GOPATH, module cache).
export MFT_E2E_CONFIG=$MFT_E2E_DIR/home/.config
rc=0
(cd "$here" && go test -count=1 -run "${MFT_E2E_RUN:-TestE2E}" "$@" ./...) || rc=$?
if [ "${MFT_E2E_HOLD:-0}" = 1 ]; then
  log "holding: Thunderbird and GreenMail stay up; connection files in $MFT_E2E_CONFIG"
  log "press Enter to tear down"
  read -r _ </dev/tty || true
fi
exit "$rc"
