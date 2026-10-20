# Privacy policy

Last updated: 20 October 2026.

This policy covers MCP for Thunderbird: the Thunderbird add-on and the host program it works with. MCP for Thunderbird lets AI apps on your computer, such as Claude Desktop, Claude Code, Codex or Cursor, work with the mail in Thunderbird, within limits you set in Thunderbird. MCP for Thunderbird is published by Wade J. Beckett, whose company is Noiz.

## In short

MCP for Thunderbird moves mail data only between Thunderbird and AI apps on your own computer, and only what an AI app asks for within your settings. It has no server of its own and collects nothing about you. The AI app you connect sends what it reads to its vendor, as it does with anything else you give it.

## What data goes where

MCP for Thunderbird has two parts. The add-on runs in Thunderbird. The host is a separate program on the same computer, started by Thunderbird through its native messaging channel; this policy calls it "the native program". AI apps talk to the native program, and the native program passes their requests to the add-on.

- MCP for Thunderbird sends the native program mail data only as tool results: the names and addresses of the accounts you enabled, their folders and tags, message headers, the text of messages the assistant asks to read, the bytes of attachments it asks to save, and contacts when the contacts group is turned on.
- The native program passes those results only to AI apps on the same computer that hold its access key.
- The AI app sends what it reads to its vendor, under that vendor's own terms and privacy policy.
- Nothing goes to Noiz or to the authors of MCP for Thunderbird.
- There is no telemetry: MCP for Thunderbird collects no usage data, crash reports or analytics.

Some more detail on each point:

- **Only what is asked for, within your settings.** A tool result exists only because an AI app asked for it, and only for the accounts you ticked, outside the folders you excluded, and in the tool groups you turned on. Message headers here means sender, recipients, Reply-To, subject, date, folder, flags and tags, the names, sizes and types of attachments, and the sender authentication results (SPF, DKIM and DMARC) your mail server recorded. Search results never include message text. The text of a message is sent only when an AI app asks to read that one message.
- **Attachments.** When an AI app saves an attachment, its bytes go to the native program, which writes them into the attachment folder you chose in the options. A plain-text attachment can instead be returned as text. Attachments over 50 MiB are refused.
- **Contacts.** Address book entries (names, email addresses and organisation) are sent only when you have turned on the contacts group.
- **The other direction.** The native program sends the add-on the AI app's requests: for example search terms, message ids, and the recipients and text of a draft. When a draft has attachments, the native program reads those files from your attachment folder and passes them to the add-on.
- **Settings.** Besides tool results, the add-on sends the native program two settings: which tools are turned on, and the path of your attachment folder. The native program tells the add-on the name each AI app gives itself, for the activity log. On the setup page, the native program reports which supported AI apps it found on the computer.
- **The access key.** The native program makes a random access key and keeps it, with its port number, in a file in your user's configuration folder that only your user can read. AI apps that start the native program with its `connect` command, whether MCP for Thunderbird set them up or you did, read the key from that file. An app that connects over HTTP gets the key only if you copy it from the options.
- **AI app vendors.** What an AI app's vendor receives, keeps and uses is set by that vendor, not by MCP for Thunderbird. Read your AI app's privacy policy before connecting it to your mail.
- **Noiz and the authors.** Neither receives any of your data: MCP for Thunderbird has no server, no account and no update service of its own. It makes no network connections beyond your own computer (`127.0.0.1`); Thunderbird keeps talking to your mail servers as it always does.
- **Sending mail.** If you turn on direct sending, a message an AI app sends goes through your own mail account in Thunderbird, to the recipients you allowed, as if you had sent it yourself. Direct sending is off unless you turn it on.

## What is stored on your computer

- **In Thunderbird (the add-on's own storage in your profile):** your settings (the accounts you ticked, the tool groups, the direct-sending list of addresses and domains you wrote, the attachment folder and the excluded folders) and the activity log. The activity log keeps the last 500 requests: time, AI app name, tool, the ids of the messages or the folder involved, and the outcome. It never records message text or addresses. You can clear it from the options.
- **In your user's configuration folder:** the native program's connection file, with its port, access key and process number.
- **In your attachment folder:** attachments that AI apps saved. They stay until you delete them.
- **In your AI apps' settings:** if you asked MCP for Thunderbird to set up an AI app, an entry named `mcp-for-thunderbird` that starts the native program. A backup of each settings file is kept next to it before it is changed.
- **Logs:** the native program logs only when it starts and stops, when AI apps connect, and errors. It logs no message text, subjects or addresses.

Removing the add-on deletes its storage. [INSTALL.md](INSTALL.md#uninstalling) shows how to remove the native program, its connection file and the AI app entries.

## Permissions the add-on asks for

Thunderbird describes these in its own words when you install the add-on. Each is used only for the reason given.

| Permission | Used for |
|---|---|
| `accountsRead` | Listing the accounts you can enable, and their folders. |
| `messagesRead` | Searching and reading messages and their attachments. |
| `messagesMove` | Moving, copying, archiving and moving to Trash. MCP for Thunderbird never deletes mail for good. |
| `messagesUpdate` | Marking as read or flagged, and adding or removing tags. |
| `messagesTagsList` | Finding tags by name. |
| `messagesImport` | Saving reply and forward drafts into your Drafts folder with their threading kept. |
| `messages.save` | Saving new drafts. |
| `compose` | Opening a filled-in compose window for you to check and send. |
| `addressBooks` | Looking up contacts, only when the contacts group is on. MCP for Thunderbird does not change contacts. |
| `nativeMessaging` | Talking to the native program. |
| `storage` | Your settings and the activity log. |
| `messages.send` (optional) | Direct sending. Thunderbird asks you for it only when you turn on direct sending in the options, and it is not used otherwise. |

## Your choices

- Choose which accounts AI apps may use, and turn tool groups on or off, in the add-on's options.
- Exclude folders that AI apps must never see.
- Pause every request from the toolbar button.
- Rotate the access key from the options. From then on, requests that use the old key are refused.
- Remove the add-on and the native program at any time.

## Changes to this policy

Changes are published in this file in the project's repository, with a new date at the top. A change that sends any data somewhere new will be stated in the release notes of the version that makes it.

## Contact

Questions about this policy: open an issue on the [GitHub repository](https://github.com/wadejbeckett/mcp-for-thunderbird/issues). For a security problem, follow [SECURITY.md](SECURITY.md) instead.
