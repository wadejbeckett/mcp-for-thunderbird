# Platforms

MCP for Thunderbird is tested on Linux, Windows and macOS in GitHub Actions, and supported on Linux only for the moment: the manual check below has not yet been done on a real PC or Mac, and Windows and macOS become supported when it has. This page records what has been checked on each, how, and what is still to be checked by hand.

## Automated checks (GitHub Actions)

Three workflows test the product in GitHub Actions: `test` on every push and pull request; `e2e-linux` on a push to `v1` or a pull request that changes `host/`, `addon/`, `packaging/build-xpi.mjs`, `test/e2e/` or the workflow file, on a push of a release tag (`vX.Y.Z`), and when started by hand; and `platforms` on a push to `v1` that changes `host/`, `addon/`, `packaging/`, `test/e2e/` or the workflow file, on a push of a release tag (`vX.Y.Z`), when it creates a draft release instead of a snapshot (CONTRIBUTING.md, Releasing), and when started by hand. Three more (CodeQL, OpenSSF Scorecard and zizmor) check the code and the workflows; CONTRIBUTING.md, Security checks, describes them.

- `test` (`.github/workflows/test.yml`): the documentation check (`docs/check-docs.sh` and its self-test) and the add-on tests (`npm test`) on `ubuntu-latest`, and the host tests (`go test ./...`) on `ubuntu-latest`, `windows-latest` and `macos-latest`. A Windows step fails unless the Windows-only tests actually ran and passed: `TestWindowsACLOwnerOnly`, `TestWindowsRegistry`, `TestOwnerOnlyWindows` and `TestSavePrivateWindows`. On Linux it also checks `THIRD_PARTY_LICENSES` against `host/go.mod` and runs the self-tests of `packaging/third-party-licenses.sh` and of the Linux end-to-end work folder (`test/e2e/workdir-selftest.sh`).
- `e2e-linux` (`.github/workflows/e2e-linux.yml`): every Linux end-to-end test (`test/e2e/run.sh`) on `ubuntu-latest` under xvfb, once on Thunderbird 140 ESR and once on the current release. `test/e2e/fetch-thunderbird.sh` downloads each from Mozilla as the Linux tarball. It checks the tarball against Mozilla's `SHA256SUMS` and against the version and SHA-256 pinned in the workflow; the workflow's header says how to move the pins to newer versions. On 140 ESR the tests expect `mail_compose` without `mail_draft` and `mail_send`, which need Thunderbird 153 (README, Supported versions).
- `platforms` (`.github/workflows/platforms.yml`, also started by hand with "Run workflow"):
  1. `build` (Linux): the GoReleaser snapshot with `packaging/build.sh`, then `packaging/check.sh` and its self-test. It has read-only access. On a release tag the `release` job runs instead: it stops if the tag already has a release, draft or published, then runs the same steps, with GoReleaser creating the draft release, and records the draft's id. If any step fails, it deletes that draft, never a published release, and keeps the tag. `check.sh` requires `THIRD_PARTY_LICENSES` at its exact place in each host package: next to the binary in the top folder of every archive, at `/usr/share/doc/mcp-for-thunderbird/THIRD_PARTY_LICENSES` in each `.deb`, and at the root of each `.mcpb`.
  2. `windows-installer` (Windows): installs Inno Setup with Chocolatey (on the runner only) and compiles `packaging/windows/installer.iss` for amd64 and arm64. It then installs the amd64 build silently and checks the following:
     - the `HKCU\Software\Mozilla\NativeMessagingHosts\mcp_for_thunderbird` key names `%LOCALAPPDATA%\Programs\MCP for Thunderbird\mcp_for_thunderbird.json`;
     - that manifest points at the installed `mcp-for-thunderbird.exe`;
     - the program folder holds `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES`;
     - uninstalling removes the program, the manifest and the key;
     - when registration fails (a folder sits where the manifest goes), Setup exits with code 100 and logs `setup --native-only failed`.
  3. `macos-pkg` (macOS): builds the pkg from the universal binary with `packaging/macos/build-pkg.sh` and checks that its payload (`pkgutil --payload-files`) holds the binary, `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES`. It installs the pkg with `installer -pkg … -target CurrentUserHomeDirectory`, run as the runner user without `sudo`. It then checks the following:
     - every installed file and the native manifest are owned by that user, not root;
     - `THIRD_PARTY_LICENSES` is installed next to the program;
     - the postinstall wrote `~/Library/Mozilla/NativeMessagingHosts/mcp_for_thunderbird.json`, pointing at the installed binary. This is Thunderbird's per-user folder on macOS. Firefox uses `~/Library/Application Support/Mozilla/NativeMessagingHosts` instead, and Thunderbird does not look there.
  4. `sums` (Linux): adds the two Windows installers and the macOS pkg to `SHA256SUMS` with `packaging/add-sums.sh`, verifies the whole file and runs `packaging/check.sh` again. The result is uploaded as the `release-candidate` artifact (kept 7 days). On a release tag, the `publish` job then checks that the tag's only release is the draft the `release` job recorded and uploads the installers, the pkg and the completed `SHA256SUMS` to it. If an installer job, `sums` or `publish` failed, the draft stays, and "Re-run failed jobs" finishes it (CONTRIBUTING.md, Releasing). `release` and `publish` are the only jobs with write access, and they run only on a tag.
  5. `e2e-windows` and `e2e-macos`: the end-to-end tests `TestE2ERead` and `TestE2EOrganise` run against a real Thunderbird, with the host installed by the installer or the pkg built in the same run. Each job's summary records the Thunderbird version the package manager installed, the version and build the tests ran against (read from the running Thunderbird), the tests and the result. A run started by hand can name other tests in the `e2e_tests` field (a `go test -run` pattern). See below.

### End-to-end tests on Windows and macOS

`test/e2e/platform/e2e.py` replaces `run.sh`, `make-profile.sh` and `tb.sh`, which need Linux (`/proc`, Xvfb, `setsid`, Docker), on these two systems:

- **GreenMail** runs as the standalone jar 2.1.14 from Maven Central (the version in the Linux Docker image), checked against its published SHA-256. The macOS runners have no Docker.
- **Thunderbird** comes from Chocolatey (`thunderbird`) on Windows and from Homebrew (`--cask thunderbird`) on macOS. Both are the release channel, so the version is whatever is current on the day of the run; the job summary records it. Homebrew's `thunderbird@esr` cask is still ESR 140. The job fails if the installed version is older than 153, so these two jobs test the full tool set; 140 ESR is tested on Linux by `e2e-linux`.
- **psutil**, which the harness uses to find and stop its Thunderbird, is installed from `test/e2e/platform/requirements.txt` with `pip --require-hashes`: pip installs psutil 7.0.0 only from a file whose SHA-256 matches one PyPI publishes.
- **Headless:** Thunderbird runs with `--headless` (`MOZ_HEADLESS=1`) on a throwaway profile, with `--profile <dir> --no-remote`.
- **Throwaway home:** `HOME` (macOS) or `APPDATA` (Windows) points at a throwaway folder, so the connection file is written there.
- **Registration:** Thunderbird finds the host through the registration the installer made: the HKCU key on Windows, and `~/Library/Mozilla/NativeMessagingHosts` of the real user on macOS. Thunderbird does not follow `HOME` for this lookup. Run the harness only where installing the host is wanted, such as a CI runner or a test machine.
- **No macOS system address book:** the profile turns off Thunderbird's macOS address book (`ldap_2.servers.osx`). Opening that address book asks macOS for Contacts access, and on a runner nobody can answer, so Thunderbird's main thread waits for ever. On a real Mac, the user sees Thunderbird's own Contacts prompt; this is Thunderbird behaviour, not something MCP for Thunderbird triggers.
- **Stopping Thunderbird:** the harness stops only the Thunderbird it started. It finds it by the command line that names the throwaway profile, checks its start time against the pid file, and stops it with its own child processes. A clean Marionette quit comes first. Marionette calls go only to a listener in that process tree.
- **Tests:** the Go tests in `test/e2e` run unchanged. They call the harness through `test/e2e/platform/tbctl` (macOS) or `tbctl.cmd` (Windows) where Linux uses `tb.sh`.

To run it locally on a Mac or a Windows PC, install Thunderbird, Java 17, Go, Node 22, Python 3.9+ with `psutil` (`python3 -m pip install --require-hashes --only-binary :all: -r test/e2e/platform/requirements.txt`), and the host (the pkg or the installer). Then run:

```
MFT_E2E_BIN=<installed host> MFT_E2E_THUNDERBIRD=<thunderbird executable> \
MFT_E2E_GREENMAIL=<greenmail-standalone-2.1.14.jar> python3 test/e2e/platform/e2e.py run -v
```

`MFT_E2E_RUN` picks other tests (default `TestE2ERead$|TestE2EOrganise$`).

## Results

| Check | Linux | Windows | macOS |
|---|---|---|---|
| `go test ./...` | pass | pass, Windows-only tests ran | pass |
| `npm test` | pass | (Linux runner only) | (Linux runner only) |
| Installer or package builds | `.deb` (GoReleaser) | Inno Setup, amd64 and arm64 | pkg (universal binary) |
| Silent install registers the host | | pass (HKCU key and manifest) | pass (manifest; files owned by the user) |
| Registration failure reported | | pass (exit code 100) | |
| Uninstall removes the registration | | pass | not automated (no uninstaller in v1) |
| In `SHA256SUMS` | pass | pass | pass |
| `TestE2ERead`, `TestE2EOrganise` | pass (`test/e2e/run.sh`, all e2e tests) | pass (Thunderbird 158.0) | pass (Thunderbird 157.0.1) |
| All e2e tests on Thunderbird 140 ESR | pass (140.17.0esr, locally) | | |

These results are from 20 October 2026, at commit `688d076` on `v1`: `test` run [39360856956](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39360856956) and `platforms` run [39360856999](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39360856999). The Linux end-to-end suite ran locally on Thunderbird 153.4.0esr. On 1 November 2026 every Linux end-to-end test also passed locally on Thunderbird 140.17.0esr and 159.0 (Mozilla's tarballs, through `fetch-thunderbird.sh`) and on 153.5.1esr (the distribution package); `e2e-linux` had not yet run in GitHub Actions. The end-to-end tests added on 3 November 2026 (`TestE2ESearchAndThread`, `TestE2EAccountsAndFolders`, `TestE2EAttachmentKinds`, `TestE2EExcludedLocalFolderFollows`, `TestE2EExcludedFolderFollows`, `TestE2ETags`, `TestE2EArchiveNewYearFolder`, `TestE2EContacts`, `TestE2EComposeIdentity`, `TestE2EComposeOtherAccount`, `TestE2EForwardPlaceholder`, `TestE2ESendOffline`, `TestE2EMissingHostText`, `TestE2EBrokenHostText` and `TestE2EHostLogsThunderbirdVersion`) passed on Thunderbird 153.6.0esr, and on 4 November 2026 the whole Linux suite passed locally on 140.17.0esr and 159.0 too (Mozilla's tarballs, through `fetch-thunderbird.sh`). On Windows and macOS only `TestE2ERead` and `TestE2EOrganise` run. The other end-to-end tests (drafts and sending, the injection defaults, connect-mode restarts, the toolbar) have run on Linux only.

## Manual check (maintainer)

The steps below are left for the maintainer, on Windows 11 and on macOS, and are deferred for the moment (4 November 2026); until they are done, only Linux is supported. Use a release candidate: the `release-candidate` artifact of a green `platforms` run, or a draft release.

1. Install Thunderbird 153 or later, if it is not installed already. Thunderbird 140 ESR is supported too, but has no `mail_draft` or `mail_send`; the steps below are written for 153 or later.
2. Install the add-on: in Thunderbird, open Add-ons and Themes, choose "Install Add-on From File…" from the gear menu, and pick `mcp-for-thunderbird-<version>.xpi`. Take a screenshot of the permission prompt.
3. Install the host:
   - **Windows 11:** run `mcp-for-thunderbird-<version>-windows-amd64-setup.exe`, or the arm64 file on an ARM PC. SmartScreen warns about an unknown publisher, because v1 is unsigned. Choose "More info", then "Run anyway". Take screenshots of both SmartScreen screens and the installer's licence page.
   - **macOS:** open `mcp-for-thunderbird-<version>-macos.pkg`. Gatekeeper blocks it, because v1 is unsigned. Open System Settings, then Privacy & Security, and choose "Open Anyway". Take screenshots of the Gatekeeper dialog and of the Privacy & Security button. Install for "me only".
4. Restart Thunderbird. Click the MCP for Thunderbird toolbar button and check that it shows connected. Take a screenshot.
5. Run the setup page: pick an account and "Read and organise", tick Claude Desktop, and finish. Take a screenshot of each step.
6. Open Claude Desktop and ask: "what needs my attention in my inbox today?" Check that Claude calls the MCP for Thunderbird tools and answers from the inbox. Take a screenshot.
7. Uninstall:
   - **Windows:** use Settings, then Apps, then MCP for Thunderbird, then Uninstall. Check that Claude Desktop's configuration no longer lists `mcp-for-thunderbird`.
   - **macOS:** run `"$HOME/Library/Application Support/MCP for Thunderbird/mcp-for-thunderbird" setup --uninstall`, then delete that folder.

Record the results here (date, OS version, Thunderbird version, pass or fail per step), and put the screenshots in INSTALL.md.

| Step | Windows 11 | macOS |
|---|---|---|
| 1-7 | not yet run | not yet run |

## Run log

Each run below found or confirmed one thing.

- [39332126741](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39332126741) (`test`, before the cross-platform fixes) failed on all three systems. The causes:
  - Path comparisons in the tests did not resolve symlinks: macOS `/var` → `/private/var`, and Windows short names such as `RUNNER~1`.
  - The tests assumed Linux locations for the configuration folder and the manifest.
  - On Windows, the test built the host without `.exe`, and its binary path `/opt/...` is not absolute there.
  - On Windows, a 0700 folder mode does nothing, so the attachment folder was not private.
  - On Linux, a race in connect mode returned "unknown tool" after a token rotation.
- [39354609913](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39354609913) (`test`): Linux and macOS green. On Windows:
  - Windows stores a folder's owner-only entry as two entries.
  - Replacing the connection file failed with "Access is denied" while connect mode was reading it.
- [39354990421](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39354990421) (`test`): reads with `FILE_SHARE_DELETE` do not let `MoveFileEx` replace an open file. The fix that stayed is a short retry of the replace.
- [39355253984](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39355253984) (`test`): green on all three systems. `TestWindowsACLOwnerOnly`, `TestWindowsRegistry`, `TestOwnerOnlyWindows` and `TestSavePrivateWindows` passed on Windows.
- [39355781972](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39355781972) (`platforms`, first run):
  - The Windows installer job passed: install, registry, manifest, uninstall, and exit code 100.
  - The macOS pkg job passed.
  - `e2e-windows` passed.
  - Homebrew's `thunderbird@esr` is ESR 140, so `e2e-macos` stopped at the version check.
  - `sums` failed because downloaded artifacts lose the execute bit.
- [39357170747](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39357170747) (`platforms`): everything green except `e2e-macos`, where the host never started.
- [39358612512](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39358612512) and [39359430465](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39359430465) (`platforms`, `e2e-macos` only): Thunderbird's main thread was blocked in `+[ABAddressBook sharedAddressBook]`, waiting for a Contacts permission answer.
- [39360260848](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39360260848) (`platforms`, `e2e-macos` only): the add-on ran but got "No such native application mcp_for_thunderbird". Thunderbird's `XREUserNativeManifests` is `~/Library/Mozilla`, and setup wrote the manifest to Firefox's `~/Library/Application Support/Mozilla`. Setup now writes the Thunderbird folder.
- [39360856956](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39360856956) (`test`) and [39360856999](https://github.com/wadejbeckett/mcp-for-thunderbird/actions/runs/39360856999) (`platforms`): every job green.
