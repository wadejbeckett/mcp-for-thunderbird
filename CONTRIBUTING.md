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
- For the end-to-end tests on Linux: Thunderbird 153 or later, Docker, `xvfb-run`, `curl` and Python 3.
- For the documentation check: bash.
- For release builds: Python 3.9 or later (`packaging/check.sh` and its self-test use features added in Python 3.9), `sha256sum`, and `dpkg-deb` to check the `.deb`.

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

Release build (a local snapshot unless you pass GoReleaser release flags):

```
sh packaging/build.sh
```

It builds every archive, the `.deb` packages, the XPI and the Claude Desktop extensions into `dist/`, then runs `packaging/check.sh`, which checks the artefacts and `SHA256SUMS`, and `packaging/check-selftest.sh`, which proves `check.sh` catches the faults it claims to. The Windows installer and macOS package are built on those systems in CI; [PLATFORMS.md](docs/PLATFORMS.md) describes how.

Release tags must be plain numbers, `vX.Y.Z` (for example `v1.0.0`), giving the version `X.Y.Z`. Pre-release suffixes such as `-rc1` are refused, because Thunderbird add-on versions are dotted numbers and a suffixed build would clash with the final release on addons.thunderbird.net.

## Releasing

1. On `v1`, at the commit to release, check that the `test` and `platforms` workflows are green.
2. Tag it `vX.Y.Z` and push the tag. The `platforms` workflow runs in release mode: GoReleaser creates a draft GitHub release with the archives, `.deb` packages, the `.xpi`, the `.mcpb` bundles, the SBOMs and `SHA256SUMS`; the Windows installers and the macOS pkg are built on their runners, added to `SHA256SUMS`, and uploaded to the draft by the `sums` job.
3. When the end-to-end jobs are green, run the manual check in [PLATFORMS.md](docs/PLATFORMS.md) from the draft, then publish the draft release.
4. Submit the `.xpi` to addons.thunderbird.net, and link the listing from README.md and INSTALL.md once it is live.

Release archives are not yet byte-for-byte reproducible: two builds of the same tag can differ in archive details such as timestamps. Until they are, a release is vouched for by its CI build log, `SHA256SUMS` and the software bill of materials for each archive, not by rebuilding it.

Every GitHub Actions step is pinned to a full commit SHA, with the version in a comment, and the Windows installer tool (Inno Setup) to an exact Chocolatey version (`INNOSETUP_VERSION` in `.github/workflows/platforms.yml`). Update a pin by replacing both the SHA and its comment; the `docs` job fails if any step is not pinned.

GitHub Actions runs the add-on tests and the documentation check on Linux, and the host tests on Linux, Windows and macOS, for every push and pull request (`.github/workflows/test.yml`). A second workflow (`.github/workflows/platforms.yml`) builds the installers and runs end-to-end tests on Windows and macOS.

## Safety rules for the end-to-end tests

The end-to-end tests start a real Thunderbird. Run them so they can never touch your own mail:

- **Never against your own profile.** `run.sh` makes a throwaway profile and work folder whose names start with `mft-e2e`, under `$TMPDIR` (or `/tmp`). It refuses any other name, and any path under `~/.thunderbird`.
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
