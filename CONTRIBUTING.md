# Contributing to scratchpool

Thanks for helping. scratchpool is small on purpose, so please read this before opening a large pull request.

## Ground rules

- **[docs/SPEC.md](docs/SPEC.md) is the contract.** Behaviour changes update the spec in the same PR and say why.
- **Local only.** No hosted server, cloud service, shared credentials or telemetry. The only remote endpoint is Salesforce, through the developer's own `sf` CLI.
- **Zero runtime dependencies.** Node >= 20 built-ins only. No install scripts.
- **`sf` via `--json` and argument arrays only**, and only the commands in the SPEC section 4 allowlist.
- **No secrets in output.** New output fields go through the allowlist; new messages go through the scrubber.
- Single-org features belong upstream in [sf-skills](https://github.com/forcedotcom/sf-skills) `dx-org-manage`; scratchpool is designed to be contributed there as `dx-org-pool-manage` one day.

## Getting started

```sh
git clone https://github.com/Tbristo01/scratchpool
cd scratchpool
npm test                          # or: node --test tests/*.test.mjs
```

(`node --test tests/` with a directory argument does not work on Node 22.)

There is nothing to install. Tests run against a stub `sf` (`tests/stub/sf`, and `sf.cmd` on Windows) and never call a real Dev Hub.

Useful environment variables for local runs:

| Variable | Use |
|---|---|
| `SCRATCHPOOL_HOME` | Point at a temp directory so you never touch your real pool |
| `SCRATCHPOOL_SF_BIN` | Use the stub `sf` |
| `SCRATCHPOOL_SERVICE_DRYRUN=1` | Write scheduler files under `<home>/service-dryrun/` instead of calling launchctl, systemctl or schtasks |
| `SCRATCHPOOL_PLATFORM` | Exercise another platform's scheduler code |
| `SCRATCHPOOL_NO_DETACH=1` | Run workers synchronously |
| `SCRATCHPOOL_NOW` | Freeze "now" for expiry tests |

**Never run tests or experiments against a real scheduler or Dev Hub by accident:** always set `SCRATCHPOOL_HOME` and `SCRATCHPOOL_SERVICE_DRYRUN=1`.

## Pull requests

All changes, including the maintainer's, go through a pull request: `main` is protected for everyone (admins included), so a direct push is rejected. A PR merges only when all 11 required checks pass (the 9 CI jobs, `dependency review` and `CodeQL`) on a branch that is up to date with `main` and every review conversation is resolved. PRs are squash-merged; GitHub signs the squash commit, so you do not need to sign your own commits (it is welcome). Details: [docs/repository-controls.md](docs/repository-controls.md).

1. Open an issue first for anything beyond a small fix.
2. Keep PRs focused; add or update tests in `tests/`.
3. Run `npm test`. CI runs it on ubuntu, macOS and Windows with Node 20 and 22, plus a secret-shape scan, shellcheck on `examples/*.sh` and manifest validation; dependency review and CodeQL run alongside. All of them are required.
4. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
5. Test fixtures must use obviously fake credentials, and any line holding a token-shaped value must contain the marker `FAKE` (the CI secret scan fails on unmarked matches).

## Releases (maintainer)

Follow [RELEASING.md](RELEASING.md): CHANGELOG section, version bump in `plugin.json`, `package.json` and `SKILL.md`, a PR, then an annotated `vX.Y.Z` tag. The release workflow waits for approval in the `release` environment, then builds the skill zip, `SHA256SUMS` and a build provenance attestation and publishes the CHANGELOG section as the release notes. Decision making is described in [GOVERNANCE.md](GOVERNANCE.md).

## Conduct and license

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
