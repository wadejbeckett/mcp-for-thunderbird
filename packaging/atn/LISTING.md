# The addons.thunderbird.net listing

Everything the submission form on addons.thunderbird.net (ATN) asks for, ready to paste. The submission is made from the publisher's own ATN account; this file is the source of each field, so the listing and the repository say the same thing.

## Before submitting

1. The version to submit is a published GitHub release: the reviewer notes link to that release's host packages and checksums. Upload the release's own `mcp-for-thunderbird-<version>.xpi`, the same file users download, so the two never differ.
2. Run Thunderbird's own linter on that file and check that it finds no issues: clone https://github.com/thunderbird/webext-linter, `npm install`, then `node verify.js <path to the xpi>`. (ATN runs an older Mozilla linter at upload; it does not know the mail permissions and lists them as unknown, which reviewers expect.)
3. `python3 packaging/atn/privacy-text.py` prints the privacy policy as plain text for the privacy policy field.
4. `sh packaging/atn/reviewer-notes.sh <version>` prints the Notes to Reviewers with the download links and checksums filled in from the release.
5. The listing icon is `packaging/mcpb/icon.png` (512 by 512 pixels, rendered from `addon/icons/icon.svg`). ATN takes PNG or JPG only, never SVG.
6. The screenshots are in `packaging/atn/screenshots/`, PNG, taken from a throwaway profile with test mail only (see "Screenshots" below).

## Distribution

- Choose **On this site** (listed). The listed add-on may still be offered as the same `.xpi` on the releases page.
- Source code step: **no source archive**. The xpi holds the plain, unminified source; nothing is bundled or generated.

## Name

MCP for Thunderbird

## Slug

mcp-for-thunderbird

## Summary

At most 250 characters.

```text
Lets AI apps on your computer, such as Claude Desktop, Claude Code, Codex and Cursor, work with your mail through the Model Context Protocol, within limits you set in the add-on's options. Needs the free host program from the project's releases page.
```

## Description

Links in the description are limited to the project's own pages; the releases page and the repository are both under the publisher's control.

```text
MCP for Thunderbird lets AI apps on your computer work with the mail in the Thunderbird mail app, within limits you set. AI apps such as Claude Desktop, Claude Code, Codex and Cursor connect to outside tools through the Model Context Protocol (MCP), an open standard. This add-on gives them a set of mail tools: search your mail, read a message, tidy your inbox, write a draft for you to check. You choose which accounts they may use and what they may do, and you can pause them at any time from the toolbar button.

HOW IT WORKS

There are two parts. The add-on runs in the mail app and does the mail work through the standard add-on interfaces. The host program is a small separate program on the same computer, started through native messaging when the mail app starts and stopped when it closes. AI apps talk to the host program, and the host program passes their requests to the add-on. The host program is a separate download: install it for your system from https://github.com/wadejbeckett/mcp-for-thunderbird/releases and run its setup once. Without it the toolbar button shows "not connected" and nothing else happens.

WHAT AI APPS CAN DO

The tools come in groups that you switch on or off in the options:

- Read: list accounts and folders, search mail, read one message, list a conversation, save an attachment to a folder you choose, and describe a message filter for you to create.
- Organise: mark as read or flagged, add or remove tags, move or copy to another folder, archive, and move to Trash.
- Draft: save a message, reply or forward to Drafts, or open a filled-in compose window for you to check and send.
- Contacts: look people up in your address books.
- Sending: send a message with no window, only to recipients you have listed. Off unless you turn it on.

No tool deletes mail for good, empties Trash or Junk, deletes a folder or changes account settings.

GETTING STARTED

1. Install the host program from the releases page and run its setup; the page explains each system.
2. Install this add-on. Its setup page opens: tick the accounts AI apps may use, choose what they may do, and tick the AI apps to set up.
3. Restart your AI app and ask it, for example, "What needs my attention in my inbox today?"

The options page (Add-ons and Themes, then this add-on's Options) holds every setting, the connection details for an AI app you set up by hand, and an activity log of the last 500 requests.

SAFETY DEFAULTS

- No accounts until you tick them, and no sending: with the default settings nothing an AI app does can send mail or delete anything for good.
- Search returns pointers only (sender, subject, date, folder, flags), never message text. An AI app reads the text of a message only by asking for that one message.
- Message text is marked as untrusted content, with hidden text, scripts and invisible characters removed as far as practical, so a message cannot easily pass itself off as instructions to the AI app.
- Local only, with an access key: the host program listens only on your own computer and answers only requests that carry its key.
- Pause from the toolbar at any time; the activity log shows what each app did.

PRIVACY

The add-on sends the host program mail data only as the results of tool calls an AI app made, within your settings: the names and addresses of the accounts you enabled, their folders and tags, message headers, the text of the messages the AI app asks to read, the bytes of the attachments it asks to save, and contacts when the contacts group is on. The host program passes those results only to AI apps on the same computer that hold its access key. The AI app sends what it reads to its own vendor, under that vendor's terms. Nothing goes to the author of this add-on: it has no server, no account and no telemetry. The full privacy policy is below and in the repository.

REQUIREMENTS

Thunderbird 140 ESR or later on Windows, macOS or Linux; the host program; and an AI app that supports MCP. On 140 ESR the two tools that save a draft or send without a window are not offered, because the mail app gained those interfaces in version 153; the compose window works on every supported version.

MCP for Thunderbird is free software under the Mozilla Public License 2.0, with its source at https://github.com/wadejbeckett/mcp-for-thunderbird. It is not made by, endorsed by or affiliated with Mozilla or MZLA Technologies.
```

## Categories

At most two. Suggested: **Message and News Reading** and **Message Composition**. (The other categories offered are Appearance and Customization, Calendar and Date/Time, Chat and IM, Contacts, Folders and Filters, Import/Export, Language Support, Miscellaneous, Privacy and Security, and Tags.)

## Tags

mcp, ai, assistant, claude, cursor, codex, automation

## Links

- Homepage: https://github.com/wadejbeckett/mcp-for-thunderbird
- Support site: https://github.com/wadejbeckett/mcp-for-thunderbird/issues
- Support email: optional on ATN; leave empty unless an address is to be watched for it.

## Licence

Mozilla Public License, version 2.0 (offered in the form's list).

## Privacy policy

Paste the whole output of:

```bash
python3 packaging/atn/privacy-text.py
```

ATN takes the policy as full text, not a link, and reviewers check that it says what is exchanged over native messaging; PRIVACY.md does.

## Version notes

Written per release, in the release's own words. For the first listed version:

```text
First version on addons.thunderbird.net. The add-on needs the host program of the same version from https://github.com/wadejbeckett/mcp-for-thunderbird/releases.
```

## Notes to Reviewers

Paste the output of:

```bash
sh packaging/atn/reviewer-notes.sh <version>
```

It covers the host program's download links and checksums, the install and test path (no AI app or paid account needed), what each permission is used for and where, and the points a review may raise. Copy the same text into the Whiteboard field under Technical Details, which only reviewers see.

## Listing icon

`packaging/mcpb/icon.png`: 512 by 512 pixels, PNG, the same design as the add-on's own icon and the icon of the Claude Desktop bundle.

## Screenshots

PNG, taken from a throwaway profile that holds only test mail (never a real mailbox), each at a 4 to 3 ratio and at least 1000 by 750 pixels:

| File | Caption |
|---|---|
| `packaging/atn/screenshots/options.png` | The options page: the accounts AI apps may use, what they may do, sending and the attachment folder. |
| `packaging/atn/screenshots/options-folders.png` | Further down the options page: excluded folders, pause, the setup page and the connection details. |
| `packaging/atn/screenshots/options-log.png` | The end of the options page: the activity log of recent requests. |
| `packaging/atn/screenshots/setup.png` | The setup page that opens on first install. |
| `packaging/atn/screenshots/popup.png` | The toolbar button's popup, shown as its own page: connection state, pause and recent activity. |

## After the listing is live

1. README.md, "Quick start", step 2: replace the sentence about the releases page with the listing. Suggested: "Install the add-on from its page on addons.thunderbird.net: https://addons.thunderbird.net/addon/mcp-for-thunderbird/. The same `.xpi` is also on the releases page."
2. README.md, "Known limits", the code-signing bullet: drop "a listing on addons.thunderbird.net, to follow, will update it by itself" and say the add-on updates through addons.thunderbird.net.
3. INSTALL.md, "The add-on": lead with the listing, keep the file install as the alternative, and drop "is to follow and will be linked here when it is live". In "Upgrading", the add-on bullet becomes: the add-on updates itself with the mail app's other add-ons; an add-on installed from a file updates from the listing too, since it has the same id.
4. CONTRIBUTING.md, "Releasing", step 7: after publishing the GitHub release, upload the same `.xpi` as a new version on addons.thunderbird.net with the version notes, and answer reviewer messages within 10 days (an unanswered message is a rejection reason).
5. Watch the ATN developer dashboard and the publisher's email for reviewer messages until the version is approved.
