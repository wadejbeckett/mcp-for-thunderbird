# MCP for Thunderbird

MCP for Thunderbird lets AI apps on your computer work with the mail in Thunderbird, within limits you set in Thunderbird.

AI apps such as Claude Desktop, Claude Code, Codex and Cursor connect to outside tools through the Model Context Protocol (MCP), an open standard. MCP for Thunderbird gives them a set of mail tools: search your mail, read a message, tidy your inbox, write a draft for you to check. You choose which accounts they may use and what they may do, and you can pause them at any time from Thunderbird's toolbar.

MCP for Thunderbird works with Thunderbird. It is not made by, endorsed by or affiliated with Mozilla or MZLA Technologies, the makers of Thunderbird.

## How it works

MCP for Thunderbird has two parts:

- **The add-on**, installed in Thunderbird. It does the mail work through Thunderbird's standard add-on interfaces, and it holds your settings, the activity log and the pause switch.
- **The host**, a small program installed on the same computer. Thunderbird starts it when Thunderbird starts, and it stops when Thunderbird closes. AI apps talk to the host, and the host passes their requests to the add-on.

Thunderbird already has your mailbox logins and a copy of your mail, so MCP for Thunderbird never asks for a mail password. Nothing goes through any outside server: the add-on, the host and the AI apps talk to each other only on your computer. The AI app itself then sends what it reads to its vendor, as it does with anything else you give it. [PRIVACY.md](PRIVACY.md) sets out exactly what goes where.

## What AI apps can do

The tools come in groups, and you switch each group on or off in the add-on's options. A tool in a group that is off is not offered to AI apps at all.

| Group | Tools | What they do |
|---|---|---|
| Read | `mail_accounts`, `mail_folders`, `mail_search`, `mail_read`, `mail_thread`, `mail_attachment`, `mail_filter_suggest` | List accounts and folders; search mail; read one message; list the messages in a conversation; save an attachment to a folder you choose; describe a message filter for you to create. |
| Organise | `mail_mark`, `mail_tag`, `mail_move`, `mail_archive`, `mail_trash` | Mark as read or flagged; add or remove tags; move or copy to another folder; archive; move to Trash. |
| Draft | `mail_draft`, `mail_compose` | Save a new message, reply or forward to Drafts; open a filled-in compose window for you to check and send. |
| Contacts | `mail_contacts` | Look people up in your address books. |
| Sending | `mail_send` | Send a message with no window, only to recipients you have listed. Off unless you turn it on. |

## What it cannot do

- **Delete mail for good.** The organise tools can move mail to Trash, but no tool empties Trash or Junk, deletes a folder or changes account settings.
- **Edit Thunderbird's message filters.** Thunderbird gives add-ons no way to change filters, so `mail_filter_suggest` writes out the steps for you to follow in Thunderbird's Message Filters window.
- **Calendar and tasks.** Thunderbird has no stable add-on interface for them.
- **Work with AI apps in a web browser**, such as ChatGPT or claude.ai in a browser tab. Those reach tools through a server on the internet, and MCP for Thunderbird only listens on your own computer.
- **Work when Thunderbird is closed.** The host runs only while Thunderbird runs. An AI app that asks in the meantime is told "Thunderbird is not running".
- **Run on Thunderbird for Android.**

## Safety defaults

- **No accounts until you tick them.** On first run a setup page asks which accounts AI apps may use. None is ticked to begin with.
- **"Read and organise" is the suggested level.** Drafting and contacts are off until you turn them on.
- **No sending.** With the default settings, nothing an AI app does can send mail or delete anything for good. Drafts and the compose window leave the decision to send with you. Direct sending stays off unless you turn it on in the options, list the addresses or domains it may send to, and allow it in Thunderbird's own permission prompt.
- **Search never returns message text.** Search results are pointers: sender, subject, date, folder, flags. An AI app reads the text of a message only by asking for that one message.
- **Message text is marked as untrusted.** Hidden text, scripts and invisible characters are removed as far as practical, and what remains is wrapped in a block that tells the AI app it is data from the sender, never instructions.
- **Local only, with an access key.** The host listens only on 127.0.0.1 and answers only requests that carry its access key. The AI apps that setup connects read the key by themselves, so you never copy it by hand.
- **You can see and stop it.** The toolbar button shows whether MCP for Thunderbird is connected, paused or not connected, and its menu has a Pause button that refuses every request until you resume. The activity log in the options lists the last 500 requests (time, app, tool and outcome), without message text or addresses.

[SECURITY.md](SECURITY.md) describes the threats and the protections in detail, including their limits.

## Supported versions

- Thunderbird 153 or later, on Windows, macOS and Linux. Earlier versions lack the add-on interfaces MCP for Thunderbird needs to save drafts without opening a window.
- Tested on Thunderbird ESR 153.4 on Linux; Thunderbird 158 on Windows and Thunderbird 157 on macOS are covered by the end-to-end tests that run in CI.
- Account types: tested with IMAP. MCP for Thunderbird uses only Thunderbird's general mail interfaces, so other account types Thunderbird supports, such as Gmail and Microsoft 365 over IMAP, should behave the same. Exchange accounts added with Thunderbird's built-in Exchange support have not been tested.
- Linux: Thunderbird downloaded from thunderbird.net, and distribution packages that are not a Snap or Flatpak, work. The Snap (what `apt install thunderbird` gives you on current Ubuntu) has not been tested, and the Flatpak is not supported; see [INSTALL.md](INSTALL.md).

## Quick start

1. Install the host for your system from the [GitHub releases page](https://github.com/wadejbeckett/mcp-for-thunderbird/releases). Windows and macOS warn that it comes from an unknown publisher; [INSTALL.md](INSTALL.md) shows how to continue. On Linux, then run `mcp-for-thunderbird setup` as your own user.
2. Install the add-on in Thunderbird from the same releases page: download `mcp-for-thunderbird-<version>.xpi`, open the ≡ menu, choose **Add-ons and Themes**, then the gear button, then **Install Add-on From File…**, and pick the file. (A listing on addons.thunderbird.net, which updates the add-on by itself, is to follow.)
3. The add-on opens its setup page: tick the accounts AI apps may use, choose what they may do, and tick the AI apps to set up.
4. Restart your AI app and ask it, for example, "What needs my attention in my inbox today?"

[INSTALL.md](INSTALL.md) has the full steps for each system, how to connect other AI apps, how to upgrade and how to uninstall.

## Known limits

- **Text search needs mail stored on your computer.** Searching the text of messages finds only messages whose full text Thunderbird has downloaded. For IMAP accounts, turn on "Keep messages for this account on this computer" in the account's Synchronization & Storage settings.
- **Text search is case-sensitive**, because Thunderbird's search is. Results come newest first, and a long search stops after about 10 seconds and returns what it found, with a note on how to narrow it.
- **"Has attachments" can be unknown** in search results when there was no time left to check it.
- **One time budget per request.** A request that changes many messages at once (marking, tagging, moving) reports which messages were done and which failed if Thunderbird is slow.
- **Reply and forward drafts** are saved to Drafts with their threading kept. When you send one, Thunderbird files the sent copy according to the account's own settings; this has not been tested on every account type.
- **Direct sending accepts only simple addresses**: letters, digits and `. _ + -` before the `@`, and a plain domain. Write a draft for any other address. [SECURITY.md](SECURITY.md) explains why.
- **The host is not code-signed yet**, so Windows and macOS warn when you install it. The add-on on the releases page is unsigned too; Thunderbird installs an unsigned add-on from a file, and it will be signed by addons.thunderbird.net once listed there.

## Links

- [INSTALL.md](INSTALL.md): installing, connecting AI apps, upgrading and uninstalling
- [SECURITY.md](SECURITY.md): threat model, protections, known limits and how to report a vulnerability
- [PRIVACY.md](PRIVACY.md): what data goes where
- [CONTRIBUTING.md](CONTRIBUTING.md): building, testing and contributing
- [docs/PLATFORMS.md](docs/PLATFORMS.md): what has been tested on each system

## Support this project

MCP for Thunderbird is free software from Noiz. If it is useful to you, the main way to support its development is a donation in Monero (XMR):

```text
44BtMn9izxH8mK2yFbSdY6Di7TNobkLbnHdZ6gZQjukCME5vsNhtPRtH4TcVkDHKHLhSpAJbsjv8gCdYuSZVMpXgMkUC1hV
```

You can also help by reporting bugs, sending fixes or starring the repository.

## Licence and credits

MCP for Thunderbird is published by Wade J. Beckett ([wadejbeckett](https://github.com/wadejbeckett) on GitHub) under the Mozilla Public License 2.0 ([LICENSE](LICENSE)).

Parts of the add-on and the threat model in [SECURITY.md](SECURITY.md) are adapted from [thunderbird-cli](https://github.com/vitalio-sh/thunderbird-cli) by Vitalii Ionov, used under the MIT License. [NOTICE](NOTICE) lists the files and keeps that licence.

Thunderbird is a trademark of the Mozilla Foundation.
