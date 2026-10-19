# Spike results (Task 2)

Run on 19 October 2026 on Linux Mint, Thunderbird 153.4.0esr (deb package `1:153.4.0esr+linuxmint1`), in throwaway profiles under Xvfb. The spike code is in `spikes/`. It is throwaway and never shipped.

## Summary of decisions

| Question | Decision |
|---|---|
| Manifest version | **`MANIFEST_VERSION` 3.** An open native port kept the MV3 event page alive for 2 h 48 min, with and without pings. |
| `messages.send` as an optional permission | **Optional, and it must be.** On 153 the permission can only be optional, and a required entry is silently dropped. A request from an options-page click works. It must be requested on its own, never from the background. |
| Reply draft | **`messages.saveMessage` cannot make a threaded reply.** It drops `In-Reply-To` and `References`. Use `messages.import` of a hand-built RFC 5322 message into the identity's Drafts folder (recipe below). Use `saveMessage` only for new, non-reply drafts. |
| `fullText` latency | **Median 48.1 s** to drain all 500 matches in a 100,000-message folder. A first page of 25 takes 1.8 s, and a date-scoped search over the newest 5,000 messages takes 1.6 s. Keep `limit` at 25 (max 200). Task 11 must bound every body search with a date window, run newest window first, and pass a folder hint. |
| Native messaging | **Linux deb: works.** Snap and Flatpak are untested on this machine (ruling R5). Windows and macOS are tested in Task 21. |
| EWS | **Untested, best effort.** No Exchange test mailbox. |

## Setup

- **GreenMail.** `greenmail/standalone@sha256:1ef95a966418cd09b7ea91d504d8c0826bbe7a2f6e679a75c601a831587c1626` (GreenMail 2.1.14, image created 19 September 2026). Container name `mft-greenmail`. Ports were published on `127.0.0.1` only (`-p 127.0.0.1:3143:3143 -p 127.0.0.1:3025:3025`), with `GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.users=test:test@localhost,idle:idle@localhost,big:big@localhost -Dgreenmail.hostname=0.0.0.0'` and `JAVA_OPTS=-Xmx6g`. Each test user had its own mailbox, so the idle test was not disturbed by the bulk folder. The container was removed at the end.
- **Profiles.** `spikes/tools/mkprofile.py` writes `user.js`. It sets up an IMAP account on GreenMail with offline download on, Local Folders, a GreenMail SMTP server and quiet first-run prefs. It also sets the sideload prefs (`extensions.autoDisableScopes=0`, `extensions.enabledScopes=15`, `xpinstall.signatures.required=false`), and the XPI goes at `<profile>/extensions/mft-spike@wadejbeckett.github.io.xpi`.
  - **Password.** IMAP needs a stored password; without one, a modal prompt blocks start-up. In a base profile, the GreenMail test password was typed once into that prompt through XTest. All three test logins were then added through Marionette. `key4.db` and `logins.db` were copied into each new profile (TB 153 stores logins in `logins.db`).
  - **Folders.** GreenMail folders made by IMAP `CREATE` must also be `SUBSCRIBE`d, or Thunderbird does not list them.
  - **Identity folders.** Set the identity's `draft_folder`, `fcc_folder` and `stationery_folder` to the IMAP folders. Otherwise drafts go to Local Folders.
- **Start and stop.** `spikes/tools/run-tb.sh` starts `xvfb-run -a thunderbird --profile <dir> --no-remote` in its own process group. `stop-tb.sh` kills only that group.
- **Spike add-on.** `spikes/addon/` is MV3, with `"background": {"scripts": [...]}`. It connects with `runtime.connectNative("mft_spike")`, answers pings, and runs commands that the host forwards from a Unix control socket (`spikes/tools/ctl.py`).
- **Echo host.** `spikes/echohost/` is the Go host. It logs frame types and timings to a JSON-lines file and sends a ping every N seconds (`MFT_SPIKE_PING`).
- **Native manifest.** The host manifest was `~/.mozilla/native-messaging-hosts/mft_spike.json`. That directory did not exist before; it was created for the spike, and both the file and the directory were removed afterwards.

## 1. MV3 lifetime: does an open native port keep the event page alive?

**What ran.** Two Thunderbird instances were left idle, each with the MV3 spike add-on and its own echo host:

| Instance | Pings | Idle time |
|---|---|---|
| `idle` | host pings every 20 s, add-on answers with a pong | 13:09:17 to 15:57:41 UTC, **2 h 48 min 24 s** |
| `noping` | none (the port stays open, no traffic) | same window |

The add-on reports `runtime.onSuspend` to the host, and the host logs the moment its stdin closes. Each pong carries the background's start time (`bgStart`), so a restarted background page would show up as a new value. At the end, a control call was sent to each background and answered.

**Result.**
- `idle`: 505 pongs.
  - One `bgStart` value and one host process throughout.
  - The largest gap between pongs was 20.02 s.
  - Round trip: median 3.4 ms, 99th percentile 8.0 ms, maximum 21.9 ms.
  - No `onSuspend` and no stdin close. The final status call reported an uptime of 168.4 min.
- `noping`: no `onSuspend` and no stdin close in 2 h 48 min. The final status call reported the same `bgStart` and an uptime of 168.4 min.
  - So the open port alone keeps the page alive; the pings are not needed.
  - This matches the 153 source: `ext-backgroundPage.js` resets the idle timer with reason `"nativeapp"` while `hasActiveNativeAppPorts` is true.

**Decision: `MANIFEST_VERSION` 3.**

**Caveat for the add-on port lifecycle (`background.js`).** Nothing keeps the page alive once the port closes, for example when the host crashes. The default idle timeout is 30 s, so the add-on must reconnect well inside that window. Make the first reconnect immediate, keep backoff steps short while the page is alive, and keep a persistent `runtime.onStartup` listener so the page starts with Thunderbird. A 20 s host ping costs nothing and gives the host a liveness check, so keep it.

## 2. Reply draft: what does `messages.saveMessage` produce?

**What ran.** Two messages were seeded in the `test` INBOX:
- `<root-1@seed.test>` from Alice;
- `<child-2@seed.test>` from Bob, an HTML reply, with `In-Reply-To` and `References: <root-1@seed.test>`.

Three ways to make a reply-all draft to Bob's message were tried, then the raw source of each draft was read with `messages.getRaw`.

**A. `messages.saveMessage` (permission `messages.save`).** The exact `details` used:

```json
{
  "identityId": "id1",
  "to": ["Bob Example <bob@example.test>"],
  "cc": ["Alice Example <alice@example.test>"],
  "subject": "Re: Quarterly hosting review",
  "body": "<p>Spike reply A2.</p><div class=\"moz-cite-prefix\">On 01/10/2026 11:00, Bob Example wrote:<br></div><blockquote type=\"cite\" cite=\"mid:child-2@seed.test\"><p>Thursday works for me.</p><p>Bob</p></blockquote>",
  "customHeaders": [
    {"name": "In-Reply-To", "value": "<child-2@seed.test>"},
    {"name": "References", "value": "<root-1@seed.test> <child-2@seed.test>"},
    {"name": "X-Spike", "value": "A2"}
  ]
}
```

- **Result.** The call succeeded and saved the draft to `imap://test@127.0.0.1/Drafts`. Its source had:
  - `From`, `To`, `Cc` and `Subject: Re: Quarterly hosting review`;
  - `X-Spike: A2`, `X-Mozilla-Draft-Info`, `X-Identity-Key: id1` and `Fcc`;
  - the HTML body exactly as given, so the quoted original is whatever the add-on writes.
- **No `In-Reply-To` and no `References`.** They are dropped silently, with no error.
  - In the 153 source (`ext-messages.js`), `saveMessage` always composes as `nsIMsgCompType.New`, and custom headers are filtered to names starting with `X-`.
  - `NewMessageDetails` has no field for a related message or a reply type.
- **Return value for IMAP Drafts.** `messages` was `[]` in 5 of 5 calls. Saving to the Local Folders Drafts returned the `MessageHeader`. A caller that needs the saved draft on IMAP must look it up afterwards, for example by a unique `X-` header or by subject and date.

**B. `compose.beginReply` → `compose.saveMessage` → `windows.remove`.** Permissions: `compose` and `compose.save`.
- **Result.** A correct draft in 696 ms:
  - `References: <root-1@seed.test> <child-2@seed.test>` and `In-Reply-To: <child-2@seed.test>`;
  - Thunderbird's own quote: a `moz-cite-prefix` line, "On 2026/10/01 13:00, Bob Example wrote:", then `<blockquote type="cite" cite="mid:child-2@seed.test">` holding the original.
  - Our text went above the quote through `setComposeDetails`. `saveMessage` returned the header even on IMAP.
- **Cost.** A compose window opens visibly for about 0.7 s and takes focus on the user's desktop.

**C. `messages.import` of a hand-built message into Drafts.** Permission: `messagesImport`, whose prompt text is "Import messages into Thunderbird". The add-on builds this message and imports it with `messages.import(file, draftsFolderId, {read: true})`:

```
Message-ID: <generated@host>
Date: <RFC 5322 date>
MIME-Version: 1.0
User-Agent: MCP for Thunderbird
From: <identity name> <identity email>
To: <original Reply-To or From>
Cc: <reply-all only: original To and Cc minus the identity>
Subject: Re: <original subject, without a second "Re:">
In-Reply-To: <original Message-ID>
References: <original References> <original Message-ID>
X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0;
 attachmentreminder=0; deliveryformat=0
X-Identity-Key: <identity id>
Fcc: <identity's sent folder URI>
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: 7bit

<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>
<p>Reply text</p>
<div class="moz-cite-prefix">On <date>, <original author> wrote:<br></div>
<blockquote type="cite" cite="mid:<original Message-ID>">original body (HTML, or plain text escaped)</blockquote>
</body></html>
```

- **Result.** `messages.import` returned the `MessageHeader` (IMAP Drafts, `headerMessageId` as set). The stored message kept every header as given.
- **Round trip.** The draft was opened the way a user opens one from Drafts: `nsIMsgCompType.Draft`, and `getComposeDetails` reported `type: "draft"`. Re-saving it from the composer kept `References`, `In-Reply-To`, `X-Identity-Key` and the quote. So threading survives the user's own edit and send path.
- **Not opened by `compose.beginNew(draftId)`.** That opens the draft as `EditAsNew` (from the 153 source), which is a new message rather than the same draft.

**Decision.**
- **Replies (`mail_draft` with a `reply_to` id) use recipe C.** It is the only window-free way to get threading headers. Build the MIME with `messengerUtilities.encodeMimeHeader` for non-ASCII headers, use a quoted-printable or base64 body when it is not 7-bit, and include `X-Identity-Key` so the right identity is used when the draft is opened. Add `messagesImport` to the permissions.
- **New, non-reply drafts may use `messages.saveMessage`.** It is simpler. Look the draft up afterwards on IMAP, where the return value is empty.
- **Recipe B is the fallback** if `messagesImport` is ever unwanted. The window flash is the cost.

## 3. Search speed: `messages.query({fullText})` on a large folder

**Seeding.** 100,000 synthetic messages (about 1.5 KB each) went into the `big` INBOX by IMAP APPEND over 8 connections, in 555 s (180 messages a second). Every 200th message contains "zebra", rotating between the subject, the body and the author address. That gives 500 matches.

**IMAP sync of 100,000 messages: blocked by GreenMail, not by Thunderbird.**
- After SELECT, GreenMail sat at 100 to 160 % CPU, and Thunderbird got no headers in more than 8 minutes. A separate `SELECT` then hung for more than 100 s.
- GreenMail's full-range FETCH grows quadratically:

  | Messages | `UID FETCH 1:* (FLAGS)` |
  |---|---|
  | 5,000 | 0.44 s |
  | 20,000 | 9.9 s |
  | 100,000 | about 250 s (extrapolated) |

- So a GreenMail-backed IMAP folder was measured at 20,000 messages instead. The same 100,000 messages went into a Local Folders mbox (`spikes/tools/mkmbox.py`).
- The local folder runs the same `ExtensionMessages.sys.mjs` query path. Body matching parses each message's MIME tree from the local store, the same way as for an offline IMAP folder.
- Thunderbird parsed the 147 MB mbox into a 100,000-message summary in about 7 s.

**IMAP folder (20,000 seeded; GreenMail and Thunderbird settled at 17,714 headers).**
- Headers arrived within 20 s. The offline bodies took about 6 minutes.
- Subject-only query: drained in 237 ms.
- `fullText` run 1: drained in 7.8 s (95 matches).
- Later `fullText` runs on this folder never settled: more than 4 min online, and more than 110 s offline (`offline.startup_state=3`). The offline store held 23,305 mbox entries for 17,714 database rows, after GreenMail's slow responses made Thunderbird resynchronise. Bodies missing from the store are the likely cause; this was not confirmed.

**Local folder, 100,000 messages (offline mode). Medians of 5 runs.**

| Query | First page | All pages | Matches |
|---|---|---|---|
| `{fullText:"zebra", messagesPerPage:200}`, drain all pages | 1.2 s (12 to 17 messages; the default `autoPaginationTimeout` is 1000 ms) | **48.1 s** (42.2 to 51.8 s) | 500 |
| `{fullText:"zebra", messagesPerPage:25, autoPaginationTimeout:0}`, first page | **1.8 s** (1.5 to 2.2 s) | n/a | 25 |
| `{subject:"zebra", messagesPerPage:200}`, drain all pages | 1.1 s | 1.1 s | 166 |
| `{fullText:"zebra", fromDate:<newest 5,000>, messagesPerPage:200}`, drain all pages | 1.1 s | **1.6 s** | 26 |

Body scan rate: about 2,100 messages a second for 1.5 KB messages. Real mail is larger, so expect slower.

**Behaviour that Task 11 depends on.**
- **Order.** Results come in folder storage order, oldest first. The first page of a `fullText` query was `bulk-200`, `bulk-400` and so on, from January 2024. A "first 25" without a date bound returns the oldest matches.
- **Case.** `fullText` and `subject` are case-sensitive substring matches (`String.includes`, no case folding). The author match uses the full decoded `Name <addr>` string.
- **Dates.** Pass `fromDate` and `toDate` as real `Date` objects. An ISO string is accepted by the schema, but the query then never settles: `getTime` is not a function inside the search. The spike hung for more than 6 minutes this way. Converting to `Date` fixed it (3.5 s for a 5,001-message date range).
- **Abort.** `messages.abortList(listId)` after the first page returned promptly in all runs.

**Decision for Task 11.**
- **Limits.** Keep `limit` at default 25 and max 200. Use `autoPaginationTimeout: 0`, `messagesPerPage = limit`, and abort the list after the first page.
- **Date windows.** Never run an unbounded `fullText` or `body` search across a large folder. Search newest first in date windows, for example the last 30 days, then 180 days, then all, stopping when `limit` is reached or the call budget runs out. Stop after a 20 s budget per call, return what was found, and add a note that the search was cut short and how to narrow it.
- **Folder hint.** When the result is cut short, the tool text should suggest a `folder` and a date range.
- **Timeout.** Wrap every query in the 60 s call timeout and call `abortList` on expiry. A query can fail to settle, as on the IMAP folder above.

## 4. Optional permission: `messages.send`

**What ran.**
1. **Schema.** Read the 153 schema (`messages.json` in `omni.ja`). `messages.send` is declared as an `OptionalOnlyPermission`. `ext-permissions.js` refuses to request an optional-only permission together with another permission.
2. **Required.** Built a variant with `messages.send` under `permissions`. After install, `permissions.getAll()` did not include it and `messenger.messages.sendMessage` was `undefined`. The entry is silently dropped.
3. **Optional, from the background.** `permissions.request({permissions:["messages.send"]})` was rejected with "permissions.request may only be called from a user input handler".
4. **Optional, from a click.** The button on the options page (opened with `runtime.openOptionsPage()`, which opens in a tab) was clicked with real X input through XTest.
   - Thunderbird showed a doorhanger: "MFT spike (throwaway) requests additional permissions. New permissions: Programmatically send email messages in bulk on your behalf, without any visual feedback. Use the Activity Manager to review the add-on's send history." with Deny and Allow.
   - After Allow, the request resolved `true`, `permissions.onAdded` fired in the background, and `messages.sendMessage` became available in the running background page with no reload.
5. **Send.** `messages.sendMessage({identityId, to:["test@localhost"], subject, plainTextBody, isPlainText:true}, {mode:"sendNow"})` delivered to GreenMail. It returned `mode: "sendNow"` and a `headerMessageId`, and the message was in the GreenMail INBOX. `messages` was `[]` with the IMAP Sent folder as Fcc.

**Decision.**
- `messages.send` is an optional permission. It cannot be anything else on 153.
- The options page asks for it from the click that turns on direct send, in a `permissions.request` call of its own.
- The add-on checks `permissions.contains` before exposing `mail_send`, and listens for `permissions.onRemoved`.
- No privacy-text change is needed for a required permission.

## 5. Native messaging per platform

| Platform | Result |
|---|---|
| Linux, deb (Mint `153.4.0esr+linuxmint1`) | **Works.** <ul><li>The host manifest is read from `~/.mozilla/native-messaging-hosts/<name>.json`.</li><li>The host is started with arguments `[<manifest path>, <add-on id>]` and inherits Thunderbird's environment.</li><li>Three Thunderbird instances (separate profiles) ran at once, each starting its own host process.</li><li>Frames are 32-bit native-endian length-prefixed JSON.</li><li>The port stayed up for 2 h 48 min.</li></ul> |
| Linux, Snap | **Untested on this machine.** Not installed; installing it is not approved (ruling R5). Bug 1940050 (native messaging in Snap) is marked resolved upstream. |
| Linux, Flatpak | **Untested on this machine.** `flatpak` is present but no Thunderbird Flatpak is installed; installing one is not approved (R5). `flatpak override --user --filesystem=~/.mozilla/native-messaging-hosts:ro org.mozilla.Thunderbird` was therefore not tried. A Flatpak sandbox also cannot run a host binary that lives outside the sandbox, so this needs a test before Flatpak support is claimed. |
| Windows, macOS | Task 21. |

## 6. EWS (native Exchange accounts)

**Untested, best effort.** No Exchange test mailbox was provided. The read and draft paths above use only the generic `messages` and `folders` APIs, so they should apply to any account type, but this is not verified.

## Other findings for later tasks

- **Throttle.** `messages.saveMessage` and `sendMessage` share a throttle in 153 (`enforceSendSaveGap` in `MessagesSendTracker.sys.mjs`), so a tight loop of saves or sends is slowed down.
- **Subjects.** `MessageHeader.subject` has the `Re:` stripped (for example "Quarterly hosting review" for a reply). Read the raw headers when the exact subject matters.
- **Lookup by Message-ID.** `messages.query({headerMessageId})` is the lookup by `Message-ID` that the opaque id scheme needs.
- **Marionette.** It works on 153 with `--marionette --remote-allow-system-access`. It is useful for the end-to-end harness set-up (stored logins), never in the product.
