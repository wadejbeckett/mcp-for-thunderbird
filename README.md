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
| Read | `mail_accounts`, `mail_folders`, `mail_search`, `mail_read`, `mail_thread`, `mail_attachment`, `mail_filter_suggest`, `mail_tags` | List accounts and folders; search mail by sender, recipient, subject, text, date, folder, tags, junk state, or mail to or from you; read one message; list the messages in a conversation; save an attachment to a folder you choose; describe a message filter for you to create; list your tags with their colours. |
| Organise | `mail_mark`, `mail_tag`, `mail_move`, `mail_archive`, `mail_trash` | Mark as read or flagged; add or remove tags; move or copy to another folder; archive; move to Trash. Moving, archiving and moving to Trash give back each message's new id, so the AI app can go on working with it. |
| Draft | `mail_draft`, `mail_compose` | Save a new message, reply or forward to Drafts (Thunderbird 153 or later); open a filled-in compose window for you to check and send. |
| Contacts | `mail_contacts` | Look people up in your address books. |
| Sending | `mail_send` | Send a message with no window, only to recipients you have listed (Thunderbird 153 or later). Off unless you turn it on. |

AI apps write the body of a message as plain text, and the add-on turns it into an HTML message: a blank line starts a new paragraph, a paragraph of lines that start with `- ` or `* ` becomes a bulleted list, and a paragraph of lines that start with `1. `, `2. ` and so on becomes a numbered list. An indented line continues the list item above it. A list needs a blank line between it and the text around it; otherwise its lines stay as typed.

An AI app can send the body as HTML instead, with `html` set to true, when it needs tables or formatting. The add-on keeps paragraphs, line breaks, bulleted and numbered lists, bold and italic, links to web and mail addresses, and tables, and gives each table a border and cell padding so it reads the same in Thunderbird and in the recipient's mail program. Everything else is removed: scripts, styles, images and any other markup. The identity's signature and, in a reply or forward, the quoted original still follow the text.

A reply or forward goes out from the identity the original was addressed to, as in Thunderbird: one of its own account's identities first, then one of any other enabled account; for mail you sent, from the identity that sent it. An AI app can name another identity, by its address, with `from`: for a reply or forward, an identity of any enabled account; for a new message or a direct send, one of the account's identities. A draft written from another account's identity is saved in that account's Drafts folder. A reply can go to a mailing list (kind `reply_list`) when the original names one in its List-Post header, and a forward can attach the whole original message (`forward_as` set to `attachment`) instead of quoting it. `mail_compose` returns the ids of the compose tab and window it opened.

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

- Thunderbird 140 ESR or later, on Windows, macOS and Linux. Versions before 140 are not supported.
- On Thunderbird 140 ESR, `mail_draft` and `mail_send` are not offered. The add-on interfaces that save a draft or send a message without opening a window came in Thunderbird 153. `mail_compose` still opens a filled-in compose window for you to check and send, and every other tool works as on later versions. AI apps do not see them in the tool list there, and a call to either by name fails as an unknown tool.
- Tested on Linux with Thunderbird 140.17.0esr, 153.5.1esr and 159.0: every end-to-end test passed on each, run locally on 1 November 2026. The end-to-end test of search arguments and threads (`TestE2ESearchAndThread`) came later and has run only on Thunderbird 153.6.0esr so far. In CI, the `e2e-linux` workflow runs the full end-to-end suite on 140 ESR and on the current release. On Windows and macOS, CI installs the current release and runs the reading and organising end-to-end tests (`TestE2ERead` and `TestE2EOrganise`); the other end-to-end tests (folder search, search arguments and threads, drafts and sending, the injection defaults, connect mode and the toolbar) run on Linux only. [docs/PLATFORMS.md](docs/PLATFORMS.md) lists what runs where.
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
- **Attachments that are not in the message cannot be saved.** A FileLink attachment, or one the message only links to, is listed with its link; one that was detached or deleted in Thunderbird is listed as such. The message holds only a placeholder for these, so the add-on refuses to save it.
- **Excluded folders are kept by their path.** When you rename or move an excluded folder in Thunderbird, the add-on moves the exclusion with it. A folder renamed or moved while the add-on is turned off keeps its old entry, so check Excluded folders in the options after turning the add-on back on.
- **One time budget per request.** A request that changes many messages at once (marking, tagging, moving) reports which messages were done and which failed if Thunderbird is slow.
- **Reply and forward drafts** are saved to Drafts with their threading kept. When you send one, Thunderbird files the sent copy according to the account's own settings; this has not been tested on every account type.
- **Drafts kept in another account.** Thunderbird does not tell add-ons which folder an identity saves its drafts in, so `mail_draft` saves every draft in the Drafts folder of the account it is written from. For an account with no Drafts folder of its own, it uses the Drafts folder of Local Folders, on your computer, when Local Folders is enabled, and refuses otherwise; it never saves a draft in another server account, which would copy the mail it quotes onto that server.
- **Attachments stored outside a message**, such as a FileLink or a detached file, are only a placeholder in the message. A forward draft that would carry one is refused; forward the whole message as an attachment instead, or open the forward with `mail_compose`.
- **Direct sending needs Thunderbird online.** While Thunderbird is set to Work Offline, `mail_send` sends nothing and says so; it does not queue the message to send later.
- **Direct sending accepts only simple addresses**: letters, digits and `. _ + -` before the `@`, and a plain domain. Write a draft for any other address. [SECURITY.md](SECURITY.md) explains why.
- **The host is not code-signed yet**, so Windows and macOS warn when you install it. The add-on on the releases page is unsigned too; Thunderbird installs an unsigned add-on from a file, and it will be signed by addons.thunderbird.net once listed there.

## Links

- [INSTALL.md](INSTALL.md): installing, connecting AI apps, upgrading and uninstalling
- [SECURITY.md](SECURITY.md): threat model, protections, known limits and how to report a vulnerability
- [PRIVACY.md](PRIVACY.md): what data goes where
- [CONTRIBUTING.md](CONTRIBUTING.md): building, testing and contributing
- [docs/PLATFORMS.md](docs/PLATFORMS.md): what has been tested on each system

MCP for Thunderbird is listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/), which MCP directories and apps read, as [`io.github.wadejbeckett/mcp-for-thunderbird`](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.wadejbeckett%2Fmcp-for-thunderbird/versions/latest); each published release updates the entry.

## Support this project

MCP for Thunderbird is free software from Noiz. If it is useful to you, the main way to support its development is a donation in Monero (XMR):

```text
44BtMn9izxH8mK2yFbSdY6Di7TNobkLbnHdZ6gZQjukCME5vsNhtPRtH4TcVkDHKHLhSpAJbsjv8gCdYuSZVMpXgMkUC1hV
```

You can also help by reporting bugs, sending fixes or starring the repository.

## Licence and credits

MCP for Thunderbird is published by Wade J. Beckett ([wadejbeckett](https://github.com/wadejbeckett) on GitHub) under the Mozilla Public License 2.0 ([LICENSE](LICENSE)).

Parts of the add-on and the threat model in [SECURITY.md](SECURITY.md) are adapted from [thunderbird-cli](https://github.com/vitalio-sh/thunderbird-cli) by Vitalii Ionov, used under the MIT License. [NOTICE](NOTICE) lists the files and keeps that licence. The host links Go libraries under the MIT and BSD licences; [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) carries their notices and ships inside every host package.

Thunderbird is a trademark of the Mozilla Foundation. Claude, Codex and Cursor are the names of products of Anthropic, OpenAI and Anysphere; they appear here only to say which apps MCP for Thunderbird works with, and none of those companies makes, endorses or is affiliated with it.
