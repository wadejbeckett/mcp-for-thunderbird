#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# reviewer-notes.sh <version>
#
# Prints the "Notes to Reviewers" for the addons.thunderbird.net submission
# of the given release (X.Y.Z): the test path, the permission map and the
# download links of the host program with the SHA-256 checksums from the
# release's SHA256SUMS, fetched from GitHub. Run it after the release is
# published, and paste the output into the Notes to Reviewers field (and
# into the Whiteboard under Technical Details). Needs sh and curl.
set -eu

[ $# -eq 1 ] || { echo "usage: reviewer-notes.sh <version>" >&2; exit 2; }
version=$1
printf '%s' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' || { echo "reviewer-notes.sh: version must be X.Y.Z" >&2; exit 2; }
release="https://github.com/wadejbeckett/mcp-for-thunderbird/releases/download/v$version"
tree="https://github.com/wadejbeckett/mcp-for-thunderbird/tree/v$version"

sums=$(curl -fsSL "$release/SHA256SUMS" 2>/dev/null) || {
  echo "reviewer-notes.sh: could not fetch $release/SHA256SUMS; is v$version published?" >&2
  exit 1
}
# Host packages and the add-on, one line each: "<sha256>  <file>".
packages=$(printf '%s\n' "$sums" | grep -E '\.(deb|pkg|xpi|tar\.gz|zip)$|-setup\.exe$' | sed 's/^/  /')

cat <<EOF
MCP for Thunderbird $version needs a separately installed host program (native messaging). Everything is in one repository at this version's tag, $tree: the add-on in addon/ and the host in host/ (Go, built by GoReleaser from packaging/goreleaser.yaml; the release carries an SPDX software bill of materials for each archive and SHA256SUMS). The xpi is the add-on's plain source: no bundling, minifying or build step beyond zipping, so no source archive is attached.

HOW TO TEST

1. Install the host program for your system from https://github.com/wadejbeckett/mcp-for-thunderbird/releases/tag/v$version. Linux is the supported system for the moment: the .deb, or unpack the .tar.gz anywhere. The macOS .pkg and the Windows -setup.exe pass the same install and end-to-end checks in CI but have not been checked by hand yet; both warn about an unknown publisher, since the host is not code-signed (macOS: System Settings, Privacy & Security, Open Anyway; Windows: More info, Run anyway). SHA-256 of each file, from the release's SHA256SUMS:
$packages

2. Register the host with the mail app: run "mcp-for-thunderbird setup --native-only" as your user. (The macOS package and the Windows installer run it for you.) It writes only the native-messaging manifest. Without --native-only, setup also adds the host to AI apps it finds on the computer, which the review does not need.

3. Install the xpi. The add-on's setup page opens in a tab: tick an account, choose "Read, organise and draft" (the compose window below needs the draft group), click Finish. The red "!" badge on the toolbar button goes away and its tooltip reads "MCP for Thunderbird: connected"; the button's popup says Connected. Without the host program the badge stays, the popup says Not connected, and every tool call is refused.

4. Call a tool without any AI app. "mcp-for-thunderbird connect" is a stdio MCP server that forwards to the running host, so JSON-RPC can be piped into it. It stops as soon as its input closes, so the pipe is kept open for a few seconds to let the replies arrive:

   (printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"review","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mail_search","arguments":{"limit":3}}}'; sleep 8) | mcp-for-thunderbird connect

   The free MCP Inspector works too: npx @modelcontextprotocol/inspector mcp-for-thunderbird connect. mail_search returns headers only; mail_read returns one message's text wrapped as untrusted content; mail_compose opens a compose window with the text at the top. The options page (Add-ons and Themes, then Options) shows the activity log of every call.

5. Direct sending (the mail_send tool) exists only after the user ticks "Allow sending without a window" in the options, lists allowed recipients, and grants the optional messages.send permission in the prompt the mail app then shows. It is off by default, and every other write tool leaves the decision to send with the user.

PERMISSIONS AND WHERE EACH IS USED

The handlers (src/handlers/read.js, organise.js, compose.js) reach the add-on API through a small accessor, tb() (it returns globalThis.messenger, so the unit tests can replace it), which a static linter cannot follow. PRIVACY.md has the same table in the user's words.

- accountsRead: accounts.list, accounts.get and folders.query (src/rpc.js, src/ids.js, src/handlers/read.js, src/handlers/organise.js, src/handlers/compose.js, and the account and folder lists of ui/options.js and ui/setup.js).
- messagesRead: messages.query, get, getFull, getRaw, listAttachments, getAttachmentFile (src/ids.js, src/handlers/read.js, src/handlers/compose.js).
- messagesMove: messages.move, copy and archive (src/handlers/organise.js).
- messagesUpdate: messages.update for read, flagged and tags (src/handlers/organise.js).
- messagesTagsList: messages.tags.list (src/handlers/read.js, tagList).
- messagesImport: messages.import, which saves a reply or forward draft with its threading headers (src/handlers/compose.js, replyDraft).
- compose: compose.beginNew, beginReply, beginForward, getComposeDetails and setComposeDetails (src/handlers/compose.js, mailCompose).
- scripting: scripting.executeScript into the compose window the add-on itself opened, to put the text above the signature (src/handlers/compose.js, insertAtTop).
- addressBooks: addressBooks.contacts.query and list (src/handlers/contacts.js).
- nativeMessaging: runtime.connectNative (src/background.js).
- storage: the settings and the activity log (src/settings.js, src/log.js).
- messages.send (optional): messages.sendMessage (src/handlers/compose.js, mailSend), checked with permissions.contains before every send.

OTHER POINTS A REVIEW MAY RAISE

- Thunderbird 140 ESR: messages.sendMessage exists from version 153, and mail_draft is offered from 153 too (its drafts, saved with messages.import, are tested there). src/features.js tells a 153 Thunderbird by the presence of messages.getHeaders, which the 153 ESR line gained in 153 and which needs only messagesRead; on 140 the two tools are not in the tool list the host offers, so a call to either by name fails as an unknown tool (features.js also refuses them with not_supported if one ever reached the add-on).
- ui/setup.html is opened by src/background.js on first install and by the options page's "Open the setup page" button, and loads ui/setup.js.
- settings-seed.json is an empty object in every release build; the end-to-end test build fills it with test settings (packaging/build-xpi.mjs and packaging/check.sh enforce the empty object in releases).
- Data over native messaging: the privacy policy in the listing says exactly what is exchanged. Neither the add-on nor the host sends anything off the computer; the user's own AI app sends what it reads to its vendor.
EOF
