# Installing MCP for Thunderbird

MCP for Thunderbird has two parts, and you need both:

- **the host**, a small program you install on your computer once;
- **the add-on**, which you install in Thunderbird.

Install the host first. When the add-on is installed, it opens a setup page that needs the host to find your AI apps.

You need Thunderbird 153 or later. To check, open Thunderbird's ≡ menu (top right), choose **Help**, then **About Thunderbird**. If your version is older, update Thunderbird first.

The steps below take about five minutes.

## 1. Download

All downloads are on the [GitHub releases page](https://github.com/wadejbeckett/mcp-for-thunderbird/releases). Pick the file for your system:

| System | File |
|---|---|
| Windows (most PCs) | `mcp-for-thunderbird-<version>-windows-amd64-setup.exe` |
| Windows on ARM | `mcp-for-thunderbird-<version>-windows-arm64-setup.exe` |
| macOS (Intel and Apple silicon) | `mcp-for-thunderbird-<version>-macos.pkg` |
| Linux, Debian or Ubuntu family | `mcp-for-thunderbird_<version>_amd64.deb` (or `_arm64.deb`) |
| Linux, any other | `mcp-for-thunderbird-<version>-linux-amd64.tar.gz` (or `-linux-arm64.tar.gz`) |

`<version>` is the release number, such as `1.0.0`. You can check that a download is complete and unchanged; see [Checking a download](#checking-a-download).

## 2. Install the host

The host is not code-signed yet, so Windows and macOS warn that it comes from an unknown publisher. The steps below show how to continue past that warning. Do this only with a file you downloaded from the releases page above.

### Windows

1. Your browser may say the file is not commonly downloaded. Choose to keep it.
2. Open the downloaded `…-setup.exe`.
3. Windows shows a blue box headed "Windows protected your PC". Choose **More info**, then **Run anyway**.
   <!-- screenshot: docs/images/windows-smartscreen-protected.png -->
   <!-- screenshot: docs/images/windows-smartscreen-run-anyway.png -->
4. Accept the licence and finish the installer. It needs no administrator rights.
   <!-- screenshot: docs/images/windows-installer-licence.png -->

The installer puts the host in `%LOCALAPPDATA%\Programs\MCP for Thunderbird` and registers it with Thunderbird for your Windows user.

### macOS

1. Open the downloaded `…-macos.pkg`. macOS says it cannot verify the package and does not open it. Choose **Done**, not **Move to Trash**.
   <!-- screenshot: docs/images/macos-gatekeeper-not-opened.png -->
2. Open **System Settings**, then **Privacy & Security**. Scroll down to the Security section. It names the package and offers **Open Anyway**. Choose it and confirm with your password or Touch ID.
   <!-- screenshot: docs/images/macos-privacy-security-open-anyway.png -->
3. The installer opens. When it asks where to install, choose **Install for me only**, and finish.

The package puts the host in `~/Library/Application Support/MCP for Thunderbird` and registers it with Thunderbird in `~/Library/Mozilla/NativeMessagingHosts`.

### Linux

Open a terminal and go to the folder you downloaded the file into, usually Downloads:

```
cd ~/Downloads
```

**Debian, Ubuntu, Linux Mint and similar** (the `.deb`):

```
sudo apt install ./mcp-for-thunderbird_<version>_amd64.deb
mcp-for-thunderbird setup
```

The package installs the program for everyone on the computer. The second command registers it with Thunderbird for your user, so each person who uses MCP for Thunderbird runs it once, as themselves, without `sudo`.

**Any other distribution** (the `.tar.gz`): first check which file you need. Run `uname -m`: `x86_64` means the `-linux-amd64.tar.gz` file, and `aarch64` (or `arm64`) means the `-linux-arm64.tar.gz` file. Then unpack the archive, move the program to a folder where it can stay (here `~/.local/bin`), and run it once from there. For `x86_64`:

```
tar -xzf mcp-for-thunderbird-<version>-linux-amd64.tar.gz
mkdir -p ~/.local/bin
mv mcp-for-thunderbird-<version>-linux-amd64/mcp-for-thunderbird ~/.local/bin/
~/.local/bin/mcp-for-thunderbird setup
```

For `aarch64`, use `arm64` in place of `amd64` in the first and third lines:

```
tar -xzf mcp-for-thunderbird-<version>-linux-arm64.tar.gz
mkdir -p ~/.local/bin
mv mcp-for-thunderbird-<version>-linux-arm64/mcp-for-thunderbird ~/.local/bin/
~/.local/bin/mcp-for-thunderbird setup
```

Thunderbird finds the host through the full path recorded by `setup`. If you move the program later, run `setup` again from its new place.

**Snap and Flatpak.** If your Thunderbird came from the Snap Store or Flathub, MCP for Thunderbird may not work. Both packages run Thunderbird in a sandbox, and neither has been tested:

- Snap: native messaging, which the add-on uses to start the host, was fixed in Thunderbird's Snap package upstream (Mozilla bug 1940050), but MCP for Thunderbird has not been tried with it.
- Flatpak: the sandbox stops Thunderbird from starting programs installed outside it, so expect the add-on to show "not connected".

The `.deb` Thunderbird from your distribution, or Thunderbird downloaded from thunderbird.net, avoids both sandboxes.

## 3. Install the add-on

Install MCP for Thunderbird from addons.thunderbird.net (link added when listed): in Thunderbird, open the ≡ menu (top right), choose **Add-ons and Themes**, search for "MCP for Thunderbird", and choose **Add to Thunderbird**. Thunderbird shows the permissions the add-on asks for; [PRIVACY.md](PRIVACY.md) explains each one.

<!-- screenshot: docs/images/addon-permissions.png -->

Testing builds of the add-on are on the [GitHub releases page](https://github.com/wadejbeckett/mcp-for-thunderbird/releases) as `mcp-for-thunderbird-<version>.xpi`. They are for testing only and are not updated automatically. To install one, open **Add-ons and Themes** from the ≡ menu, choose the gear button, then **Install Add-on From File…**, and pick the `.xpi` file.

## 4. The setup page

After the add-on is installed, it opens a setup page in a Thunderbird tab.

1. **Choose the accounts.** AI apps can use only the accounts you tick. None is ticked to begin with.
2. **Choose what AI apps may do:**
   - **Read only:** search and read mail.
   - **Read and organise** (suggested): also mark, tag, move, archive and move mail to Trash. Nothing is deleted for good.
   - **Read, organise and draft:** also write drafts and open filled-in messages for you to check and send.
3. **Set up AI apps.** Choose **Set up AI apps**. The page lists the AI apps it found on this computer. Tick the ones to connect and choose **Set up the ticked apps**.
4. **Finish.**

<!-- screenshot: docs/images/setup-accounts.png -->
<!-- screenshot: docs/images/setup-level.png -->
<!-- screenshot: docs/images/setup-ai-apps.png -->

Then restart each AI app you set up, so it loads the new tools.

The **MCP for Thunderbird** button on Thunderbird's toolbar shows the state:

- **connected:** AI apps can use the tools;
- **paused** (badge "II"): you paused it, and every request is refused until you resume;
- **not connected** (badge "!"): the add-on cannot reach the host. Check that the host is installed, then restart Thunderbird.
- **Update needed** (badge "!"): the add-on and the host are too far apart in version to work together, and every request is refused. Update the older one; see [Upgrading](#upgrading).
- **Host program problem** (badge "!"): the host started but could not serve AI apps, and the button names the reason, such as no free port between 47110 and 47119. The add-on tries again by itself; if the reason is a busy port, close the program using it or restart the computer.

<!-- screenshot: docs/images/toolbar-connected.png -->

Everything on the setup page can be changed later in the add-on's options: open **Add-ons and Themes**, find MCP for Thunderbird, and choose **Options** (or choose **Open options** from the toolbar button). The options also hold the contacts switch, direct sending, the attachment folder, folders to hide from AI apps, the pause switch, the access key and the activity log. To find and set up AI apps again, choose **Open the setup page** under **AI apps** in the options; it starts from your current choices, and **Finish** changes only what that page shows.

**Excluded folders on Gmail.** Gmail shows the same message in several folders: All Mail, Important and Starred, and one folder for each label. Excluding one folder hides only that copy, so for a Gmail account exclude All Mail, Important and Starred too, or do not rely on excluded folders. The options page reminds you of this when an enabled account has an All Mail folder.

**Searching message text.** A search for words in messages finds only mail whose text Thunderbird has stored on this computer. For an IMAP account, open the account's settings in Thunderbird, choose **Synchronization & Storage**, and tick **Keep messages for this account on this computer**. Searches by sender, recipient and subject work either way.

**Attachment folder.** Before an AI app can save an attachment, or attach a file to a draft, choose a folder for this in the options. AI apps can save files only into that folder, and can attach any file in it to a draft, so keep in it only files you are willing to send. Attachments over 50 MiB are not saved, and a draft takes at most 20 files and 50 MiB from the folder.

## 5. Connecting AI apps

MCP for Thunderbird can set up these AI apps for you:

| App | What setup changes |
|---|---|
| Claude Desktop | adds `mcp-for-thunderbird` to `claude_desktop_config.json` |
| Claude Code | runs `claude mcp add --scope user mcp-for-thunderbird …` |
| Codex | adds `[mcp_servers.mcp-for-thunderbird]` to `~/.codex/config.toml` |
| Cursor | adds `mcp-for-thunderbird` to `~/.cursor/mcp.json` |

Each entry runs the host with the word `connect`, which links the AI app to Thunderbird and reads the access key by itself. No key is written into any AI app's settings. Before changing a file, setup saves a copy next to it named with `.bak-` and the date and time. It leaves every other entry in the file alone.

### From the command line

The setup page is the easy way. You can also set up apps from a terminal, with the names from the table above:

```
mcp-for-thunderbird setup --clients=claude-desktop,claude-code,codex,cursor
```

Run `mcp-for-thunderbird setup` with no names to see which apps it finds and which are already set up.

Where the program is not on your command path, use its full path:

- Windows (Command Prompt): `"%LOCALAPPDATA%\Programs\MCP for Thunderbird\mcp-for-thunderbird.exe" setup --clients=claude-desktop`
- macOS (Terminal): `"$HOME/Library/Application Support/MCP for Thunderbird/mcp-for-thunderbird" setup --clients=claude-code,codex`

**macOS: Claude Code and Codex may not be found from the setup page.** Claude Code and Codex are command-line programs, found through your shell's command path. Thunderbird started from the Dock or Finder does not get that path, so the setup page may say they are not installed. Use the Terminal command above instead.

**If you installed the add-on before the host**, the setup page could not reach the host and found no apps. Install the host, restart Thunderbird, then choose **Open the setup page** under **AI apps** in the add-on's options, or use the command line as above.

### Claude Desktop extension

Each release also has a Claude Desktop extension: `mcp-for-thunderbird-<version>-darwin-all.mcpb` for macOS, and `-windows-amd64.mcpb` or `-windows-arm64.mcpb` for Windows. Opening it in Claude Desktop adds MCP for Thunderbird after you confirm it in Claude Desktop's own window. It is another way to make the same connection as setup does for Claude Desktop, so use one or the other. You still need the host installed as in step 2.

### Other AI apps

Any AI app that can start an MCP server over standard input and output can use the command `<path to the host> connect`, with no other settings.

An app that connects over HTTP instead needs the address and the access key. Both are under **Connection details** in the add-on's options. Send the key in an `Authorization: Bearer <key>` header. The host makes a new key each time Thunderbird starts it, so copy the key into such apps again after every Thunderbird start, and after you rotate the key in the options. Apps that use `connect` pick up the new key by themselves.

### More than one Thunderbird profile

Each Thunderbird profile with the add-on runs its own host. `connect` uses the one that started most recently. To pin an AI app to one profile, add `--instance <id>` after `connect`. The id is part of the connection file's name (`connection-<id>.json`) in the folder listed under [Uninstalling](#uninstalling).

## Upgrading

- **The add-on** from addons.thunderbird.net updates itself with Thunderbird's other add-ons.
- **The host:** install the newer installer, package or archive over the old one. When they connect, the add-on and the host check that they speak the same version of the protocol between them, so a newer add-on usually works with an older host and the other way round. When they do not, the toolbar button shows "Update needed", and AI apps get no mail tools until you update the older one.

### Upgrading from a versioned folder

Thunderbird finds the host through the full path of the program, recorded when you run `mcp-for-thunderbird setup`. If you install the program through a package manager that keeps each version in its own folder (Homebrew, for example, keeps it under `Cellar/mcp-for-thunderbird/<version>/`), run `mcp-for-thunderbird setup` again after every upgrade, so the recorded path points to the new version. Run `setup --clients=…` again too, for the AI apps you use. The Windows installer, the macOS package and the `.deb` install to a fixed folder and need nothing extra.

## Uninstalling

First remove the add-on: in Thunderbird, open **Add-ons and Themes**, find MCP for Thunderbird, and choose **Remove**. Then remove the host:

- **Windows:** open **Settings**, then **Apps**, then **Installed apps**. Find MCP for Thunderbird and choose **Uninstall**. This removes the program, its registration with Thunderbird, and its entries in your AI apps.
- **macOS:** in Terminal, run

  ```
  "$HOME/Library/Application Support/MCP for Thunderbird/mcp-for-thunderbird" setup --uninstall
  ```

  then delete the folder `~/Library/Application Support/MCP for Thunderbird`.
- **Linux (`.deb`):** run `mcp-for-thunderbird setup --uninstall` as each user who ran setup, then `sudo apt remove mcp-for-thunderbird`.
- **Linux (`.tar.gz`):** run `~/.local/bin/mcp-for-thunderbird setup --uninstall`, then delete the program with `rm ~/.local/bin/mcp-for-thunderbird`.

`setup --uninstall` removes the registration with Thunderbird and the `mcp-for-thunderbird` entry from each AI app, keeping a backup of each file it changes.

The host also keeps a small connection file, holding its port and access key while Thunderbird runs, in a folder you can delete afterwards:

- Windows: `%APPDATA%\mcp-for-thunderbird`
- macOS: `~/Library/Application Support/mcp-for-thunderbird`
- Linux: `~/.config/mcp-for-thunderbird`

Attachments that AI apps saved stay in the attachment folder you chose.

## Checking a download

Each release has a file named `SHA256SUMS`, listing a SHA-256 checksum for every download. Download it into the same folder as your file, then:

- **Linux:** `sha256sum --check --ignore-missing SHA256SUMS`. It prints `OK` after your file's name.
- **macOS:** `shasum -a 256 <file>`, and compare the result with your file's line in `SHA256SUMS`.
- **Windows (PowerShell):** `Get-FileHash <file> -Algorithm SHA256`, and compare the result with your file's line in `SHA256SUMS` (PowerShell shows it in capitals; the letters are the same).

If the checksum does not match, do not install the file. Download it again from the releases page.

Each release also has a software bill of materials for every archive (the `.spdx.json` files), listing what the host is built from.

## Troubleshooting

- **The toolbar button says "not connected".** The host is missing or Thunderbird cannot start it. Install the host (step 2), then restart Thunderbird. On Linux, run `mcp-for-thunderbird setup` again as your own user. If Thunderbird is a Snap or Flatpak, see the note in step 2.
- **The AI app says "Thunderbird is not running".** Start Thunderbird. The AI app reconnects by itself.
- **The AI app does not show new tools after you change the options.** Some AI apps do not notice when the tools change. Restart the AI app.
- **A search for words in messages misses mail you know is there.** Thunderbird searches the text of messages only when it has downloaded them. In Thunderbird, open the account's settings, choose **Synchronization & Storage**, and tick **Keep messages for this account on this computer**. Searches are also case-sensitive.
- **Saving an attachment fails.** Choose an attachment folder in the add-on's options.

<!--
Screenshots to capture during the manual check in docs/PLATFORMS.md, saved
under docs/images/ with these names, then turned into image links above:
- windows-smartscreen-protected.png: "Windows protected your PC" with More info
- windows-smartscreen-run-anyway.png: the same box with Run anyway
- windows-installer-licence.png: the installer's licence page
- macos-gatekeeper-not-opened.png: macOS refusing to open the package
- macos-privacy-security-open-anyway.png: Privacy & Security with Open Anyway
- addon-permissions.png: Thunderbird's permission prompt for the add-on
- setup-accounts.png, setup-level.png, setup-ai-apps.png: the setup page steps
- toolbar-connected.png: the toolbar button showing connected
-->
