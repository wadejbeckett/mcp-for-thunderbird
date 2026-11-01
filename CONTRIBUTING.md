# Contributing

Thank you for helping with MCP for Thunderbird. This page explains how the project is laid out, how to build and test it, and the rules every change must keep.

For a security problem, do not open a public issue or pull request; follow [SECURITY.md](SECURITY.md).

## Layout

| Folder | What it holds |
|---|---|
| `addon/` | The Thunderbird add-on: plain JavaScript modules in `src/`, its pages in `ui/`, tests in `test/`. |
| `host/` | The host program, in Go: `cmd/mcp-for-thunderbird` and the packages under `internal/`. |
| `test/e2e/` | End-to-end tests: a real Thunderbird, a local test mail server and the real host. |
| `packaging/` | Release builds: the XPI, archives, `.deb`, Windows installer, macOS package and Claude Desktop extension. |
| `docs/` | [PLATFORMS.md](docs/PLATFORMS.md) (what is tested where), [SPIKES.md](docs/SPIKES.md) (experiments that shaped the design) and `check-docs.sh` with its self-test. |

## Tools you need

- Node.js 22 or later, for the add-on tests and the XPI build.
- Go 1.25 or later. With `GOTOOLCHAIN=auto`, Go fetches the exact version named in `host/go.mod`.
- For the end-to-end tests on Linux: Thunderbird 140 ESR or later, Docker, `xvfb-run`, `curl` and Python 3.
- For the documentation check: bash.
- For release builds: Python 3.9 or later (`packaging/check.sh` and its self-test use features added in Python 3.9), `sha256sum`, and `dpkg-deb` to check the `.deb`. Without `dpkg-deb`, `check.sh` fails; set `MFT_CHECK_SKIP_DEB=1` to skip the `.deb` contents on purpose (the `.deb` files must still be present and match `SHA256SUMS`, and the check prints a note that their contents were not checked).

## Build and test

Add-on unit tests (they run against mocks of Thunderbird's `messenger` interfaces):

```
cd addon
npm ci
npm test
```

Host unit tests, formatting and checks:

```
cd host
go test ./...
gofmt -l .
go vet ./...
```

`gofmt -l .` must print nothing.

After changing `host/go.mod`, regenerate the licences of the modules linked into the host and commit the result; `packaging/build.sh` and the `test` workflow fail when it is out of date:

```
sh packaging/third-party-licenses.sh
```

The file lists every module with its version, and a module that `host/go.mod` replaces with its replacement too; it carries every `LICENSE*`, `LICENCE*` and `COPYING*` file at the root of each module. `sh packaging/third-party-licenses-selftest.sh` proves this on a small module of its own.

Documentation check (product name, privacy statements, no internal references):

```
bash docs/check-docs.sh
bash docs/check-docs-selftest.sh
```

The second command proves the first catches every fault it claims to.

End-to-end tests on Linux:

```
test/e2e/run.sh
test/e2e/run.sh -run TestE2ERead -v
```

They use the Thunderbird on your `PATH`. To run them on another version, `test/e2e/fetch-thunderbird.sh` downloads Mozilla's Linux tarball for it, checks it against Mozilla's `SHA256SUMS` and unpacks it; pass the program it prints as `MFT_E2E_THUNDERBIRD`:

```
tb=$(test/e2e/fetch-thunderbird.sh 140.17.0esr "$TMPDIR/mft-e2e-tb")
MFT_E2E_THUNDERBIRD=$tb test/e2e/run.sh -v
```

Release build (a local snapshot unless you pass GoReleaser release flags):

```
sh packaging/build.sh
```

It builds every archive, the `.deb` packages, the XPI and the Claude Desktop extensions into `dist/`, then runs `packaging/check.sh`, which checks the artefacts and `SHA256SUMS`, and `packaging/check-selftest.sh`, which proves `check.sh` catches the faults it claims to. The Windows installer and macOS package are built on those systems in CI; [PLATFORMS.md](docs/PLATFORMS.md) describes how.

Release tags must be plain numbers, `vX.Y.Z` (for example `v1.0.0`), giving the version `X.Y.Z`. Pre-release suffixes such as `-rc1` are refused, because Thunderbird add-on versions are dotted numbers and a suffixed build would clash with the final release on addons.thunderbird.net.

## Releasing

1. On `v1`, at the commit to release, check that the `test` and `platforms` workflows are green, and that `e2e-linux` is green for that commit on both Thunderbird 140 ESR and the current release. `e2e-linux` runs on a push to `v1` only when the push changes the files it tests; if it did not run for the commit, start it by hand (Actions, `e2e-linux`, "Run workflow" on `v1`) and wait for both jobs to pass.
2. Tag it `vX.Y.Z` and push the tag. The tag starts `e2e-linux` again for the tagged commit, and starts the `platforms` workflow in release mode: its `release` job first stops if the tag already has a GitHub release, draft or published, because GoReleaser would otherwise add a second draft with the same tag. It then has GoReleaser create a draft GitHub release with the archives, `.deb` packages, the `.xpi`, the `.mcpb` bundles, the SBOMs and `SHA256SUMS`, records that draft's id, and runs `packaging/check.sh` and its self-test; the Windows installers and the macOS pkg are built on their runners, added to `SHA256SUMS` and checked again by the `sums` job, and uploaded to the draft by the `publish` job. Every later upload or deletion acts on the recorded id only, and never on a published release. Only the `release` and `publish` jobs, which run only on a tag push, have write access to the repository; every other job reads only.
3. If the `release` job fails, its draft is deleted, so no draft holds artefacts the checks rejected; the tag stays. Fix the cause, delete the tag (`git push --delete origin vX.Y.Z`, then `git tag -d vX.Y.Z`) and tag again. If the `release` job stops because the tag already has a release, check that release on the Releases page, then delete it by hand or tag a new version. If the `release` job passed and an installer job, `sums` or `publish` failed (for example a runner or network fault), the draft stays: use "Re-run failed jobs" on the run. That runs the failed jobs and `publish` again, and `publish` uploads the installers, the pkg and `SHA256SUMS` to the same draft, replacing any it uploaded before. If the fault is in the code, delete the draft on the Releases page, then delete the tag and tag again as above.
4. When the end-to-end jobs of `platforms` and the tag's `e2e-linux` run are green, check the Thunderbird versions they ran against in each job's summary, run the manual check in [PLATFORMS.md](docs/PLATFORMS.md) from the draft, then publish the draft release.
5. Publishing the release starts the `mcp-registry` workflow (`.github/workflows/mcp-registry.yml`). It fills in `server.json` for that release (the version, the `.mcpb` download links and their SHA-256 from `SHA256SUMS`), checks the downloaded bundles against `SHA256SUMS`, and publishes the entry to the official MCP Registry, signing in with GitHub's OIDC token, so no personal login or stored secret is needed. `server.json` in the repository is the template; it holds the v0.1.0 values and does not need updating for each release. To list a release that was published before the workflow existed, run the workflow by hand ("Run workflow") with its tag.
6. Fast-forward `main` to the released commit: `git push origin 'vX.Y.Z^{commit}:main'`. Git refuses the push unless it is a fast-forward. `main` is the repository's default branch, and the scheduled CodeQL scan and OpenSSF Scorecard run only from it, so this keeps them on the released code. Otherwise `main` stays at the last release; development happens on `v1`.
7. Submit the `.xpi` to addons.thunderbird.net, and link the listing from README.md and INSTALL.md once it is live.

Release archives are not yet byte-for-byte reproducible: two builds of the same tag can differ in archive details such as timestamps. Until they are, a release is vouched for by its CI build log, `SHA256SUMS` and the software bill of materials for each archive, not by rebuilding it.

Every GitHub Actions step is pinned to a full commit SHA, with the version in a comment, and the Windows installer tool (Inno Setup) to an exact Chocolatey version (`INNOSETUP_VERSION` in `.github/workflows/platforms.yml`). Update a pin by replacing both the SHA and its comment; the `docs` job fails if any step is not pinned.

GitHub Actions runs the add-on tests and the documentation check on Linux, and the host tests on Linux, Windows and macOS, for every push and pull request (`.github/workflows/test.yml`). A second workflow (`.github/workflows/platforms.yml`) builds the installers and runs end-to-end tests on Windows and macOS. A third (`.github/workflows/e2e-linux.yml`) runs the Linux end-to-end tests on Thunderbird 140 ESR and the current release. A fourth (`.github/workflows/mcp-registry.yml`) lists each published release in the official MCP Registry (step 5 of Releasing).

## Security checks

Three more workflows check the code and the workflows themselves:

- **CodeQL** (`.github/workflows/codeql.yml`) scans the Go code and the JavaScript for security problems on every push to `v1` and `main`, on pull requests and once a week. Findings appear in the repository's Security tab.
- **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) rates the repository's supply-chain practices, such as pinned dependencies and token permissions, on every push to `main` and once a week, and publishes the result.
- **zizmor** (`.github/workflows/zizmor.yml`) checks the GitHub Actions workflows for problems such as untrusted input in commands, credentials left in a checkout and excessive permissions, on every push and pull request that changes `.github/workflows/`. It fails on any finding.

## Safety rules for the end-to-end tests

The end-to-end tests start a real Thunderbird. Run them so they can never touch your own mail:

- **Never against your own profile.** `run.sh` makes a new work folder for each run with `mktemp -d`, named `mft-e2e.` and random characters, under `$TMPDIR`, else `$XDG_RUNTIME_DIR`, else `/tmp`, with the throwaway profile inside it. It stops unless the folder and the profile belong to you and only you can open them (mode 0700). `MFT_E2E_DIR` and `MFT_E2E_PROFILE` choose other folders, whose names must start with `mft-e2e`; it refuses any other name, and any path under `~/.thunderbird`.
- **A throwaway home.** On Linux, Thunderbird runs with `HOME` set to a throwaway folder, so the native messaging registration and the connection file never land in your real home folder.
- **Only the test mail server.** Test mail goes to GreenMail, a mail server in a Docker container that listens only on `127.0.0.1`. Never point a test at a real mail account or a real address.
- **Only its own Thunderbird.** Thunderbird runs under its own Xvfb display with `--no-remote`, and the harness stops only the process group it started. Your own Thunderbird keeps running.
- **Windows and macOS register the real host.** On those systems Thunderbird looks up the host only through the real user's registration, so `test/e2e/platform/e2e.py` needs the host installed for real. Run it on a CI runner or a test machine, not on the computer you read mail on. See [PLATFORMS.md](docs/PLATFORMS.md).

`MFT_E2E_KEEP=1` keeps the work folder and logs after a run. `MFT_E2E_HOLD=1` keeps the test Thunderbird and GreenMail running after the tests until you press Enter.

## Rules for every change

- **No Experiment APIs, ever.** Experiment APIs give an add-on unrestricted access to Thunderbird, and addons.thunderbird.net does not list new add-ons that use them. Use only Thunderbird's standard MailExtension APIs. `packaging/check.sh` fails a build whose XPI declares any.
- **No remote code** and no runtime dependencies in the add-on. Everything it runs is in its package.
- **Only the permissions actually used.** A new add-on permission needs a reason in [PRIVACY.md](PRIVACY.md).
- **New Go modules need discussion first.** Open an issue before adding a dependency to the host.
- **Logs never contain message text, subjects or addresses**, in the host or the add-on.
- **Safe defaults stay safe.** With default settings, no change may let an AI app send mail or delete anything for good.
- **Tests first.** Write the failing test, see it fail for the expected reason, then make it pass. Keep test output free of stray warnings.
- **The licence header.** Every source file starts with the MPL-2.0 header used in the existing files. Files derived from thunderbird-cli keep their credit line (see [NOTICE](NOTICE)).
- **The product name is "MCP for Thunderbird"**, in code, interface text and documents.
- **Documents are for a reader who has only the page.** Introduce each point where it is made, in plain English.

## Licence of contributions

MCP for Thunderbird is licensed under the Mozilla Public License 2.0 ([LICENSE](LICENSE)). By submitting a contribution, you agree that it is licensed under the MPL-2.0 too, and you confirm that you have the right to submit it under that licence.
