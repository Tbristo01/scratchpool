# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
The version lives in `.claude-plugin/plugin.json` (mirrored in `package.json`).

## [Unreleased]

## [0.1.0] - 2026-10-02

First release. A warm pool of ready Salesforce scratch orgs, managed entirely on the developer's own machine.

### Added
- `scratchpool init`: configure a pool once per project with your own Dev Hub alias, pool size and org recipe (definition file or snapshot), then install a per-user background scheduler and start filling.
- `claim`: hand out a warm, already set up org in about two seconds (alias rename plus default org); cold create fallback in an interactive terminal or with `--cold --yes`; `POOL_EMPTY` (retryable) for agents.
- `release` (alias `return`): delete orgs you own and free their Dev Hub slots, by alias or with `--pool-orgs`, `--surplus` or `--stale`; `--orphans` reaps tagged `ScratchOrgInfo` records this machine created but no longer tracks (never another machine's, never one under 1 h old or under a user alias). Deletion re-checks each entry under the state lock, so an org claimed meanwhile is never deleted.
- `status`/`list`, `config show|get|set`, `pause`, `resume`, `tick`, `service install|uninstall|status`, `uninstall`.
- Background refill via the OS scheduler: macOS launchd LaunchAgent, Linux systemd `--user` timer (crontab line fallback), Windows Task Scheduler.
- Guards: daily floor, active reserve, team cap on tagged org records, expiry-aware recycling, per-pool tick lock, atomic locked state writes; `durationDays`/`claimMinLifeHours` combinations that would recycle every new org are rejected (`DURATION_TOO_SHORT` in tick for hand-edited configs); `claim` never repoints an alias of a Dev Hub, sandbox or production org.
- The scheduler re-installs itself when its recorded script, node or sf path disappears (`SERVICE_REPAIRED`).
- Optional setup hook (`.scratchpool/setup`, `setup.mjs` or `setup.cmd`) that runs while the pool refills, so warm means ready.
- Stable `scratchpool/v1` JSON contract with allowlisted fields and documented exit codes; secret scrubbing on every message.
- Claude Code plugin and marketplace manifests, Agent Skill (`skills/scratchpool`, installable with `npx skills add Tbristo01/scratchpool`), `npx github:Tbristo01/scratchpool` CLI entry point, zero runtime dependencies.
- CI on ubuntu, macOS and Windows with Node 20 and 22, a secret-shape scan, shellcheck and manifest validation; tag-driven release with a skill zip and `SHA256SUMS`.
- First live benchmark on a Developer Edition Dev Hub (smoke-sized project): warm `claim` 1.9 to 2.9 s versus 15.5 s cold create plus deploy ([docs/benchmarks.md](docs/benchmarks.md)). A real-repo benchmark is still pending.
- Real demo recording (`docs/demo/scratchpool-demo.cast`, identifiers redacted) and an animated SVG rendered from it by the zero-dependency `scripts/cast-to-svg.py`.

### Security
- The setup hook is pinned: enabling it records its sha256, and a hook that changed since (for example after a `git pull`) is not run and creates nothing (`SETUP_UNTRUSTED`) until you re-enable it.
- A cold create from a script or agent needs `claim --cold --yes` (`CONFIRM_REQUIRED` otherwise); the skill no longer pre-approves `tick`.
- Text relayed from `sf` is clipped to 300 characters and stripped of control characters, and the skill treats it as data, never instructions.
- `--pool` never resolves to an inherited object property, and scheduler unit paths with control characters are refused.
- The recommended `settings.deny.json` also blocks Bash access to `.sf`, `.sfdx`, the scratchpool config folder and the setup hook.
- CI and release workflows pin every action to a commit SHA, release tests run in a read-only job, and the skill zip ships `LICENSE` and `NOTICE`.

### Fixed
Both found in the first live runs against a real Dev Hub:
- Orphan and team-cap queries no longer filter `ScratchOrgInfo.Description` in SOQL, which Salesforce rejects with `INVALID_FIELD`; the `scratchpool:v1:` tag is now matched client-side. The test stub rejects that filter so a regression fails CI.
- Your own claimed or releasing orgs no longer count toward the team cap. On a Developer Edition hub (3 active, so a 25% cap rounds to 1) the org you had just claimed filled the cap and blocked every refill. `release` of named orgs now also triggers a refill straight away.

[Unreleased]: https://github.com/Tbristo01/scratchpool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Tbristo01/scratchpool/releases/tag/v0.1.0
