# Design rationale

Why scratchpool v0.1 looks the way it does: the problem it solves, the platform facts that
constrain it, each major design decision with the evidence behind it, and what is still
unverified. [SPEC.md](SPEC.md) is the implementation contract. Where this page and the spec
disagree, the spec wins.

This is a curated summary of the pre-build research (2026-10-01) and the first live runs
(2026-10-02). Claims marked **UNVERIFIED** could not be confirmed against a primary source.
Upstream projects and issues change, so each fact is dated by when it was checked.

## 1. The problem and the gap

Creating one scratch org is a solved problem.

- `sf org create scratch -f config/project-scratch-def.json -a x -y 1` is one command.
- Salesforce's [sf-skills](https://github.com/forcedotcom/sf-skills) (Apache-2.0) ships a
  `dx-org-manage` skill that creates orgs from an edition, definition file, snapshot or org
  shape, from inside an agent.
- The [Salesforce DX MCP server](https://github.com/salesforcecli/mcp) has a
  `create_scratch_org` tool. As of 2026-10-01 it is not GA and needs `--allow-non-ga-tools`.

The waiting is the problem. Before a developer or agent can work, they wait for Salesforce to
provision the org, and then for their own setup (deploy, packages, data). There is no SLA for
provisioning. Our own smoke run took 12.2 s; practitioner reports of several minutes, and
10–30 minutes for real setup, are **UNVERIFIED**.

A **pool** removes that wait by doing the work ahead of time. Pooling prior art, checked
2026-10-01:

| Project | Pool | Runs inside an agent | Extra infrastructure | Licence |
|---|---|---|---|---|
| sf-skills `dx-org-manage` | No | Yes | None | Apache-2.0 |
| DX MCP `create_scratch_org` | No | Yes (non-GA) | MCP server | Apache-2.0 |
| [sfp](https://github.com/flxbl-io/sfp) community edition | Yes | No | CI | MIT, **archived** |
| [sfdx-hardis](https://github.com/hardisgroupcom/sfdx-hardis) | Yes | No | External storage + CI job | AGPL-3.0 |
| [navikt/sf-cli-plugin-pool](https://github.com/navikt/sf-cli-plugin-pool) | Yes | No | sf plugin, shared hub records | MIT |
| scratchpool | Yes, ready orgs | Yes | None (your machine) | Apache-2.0 |

Commercial offerings (sfp pro, Hutte and others) also pool orgs; their current features and
prices were not checked (**UNVERIFIED**).

**Positioning:** sf-skills creates orgs; scratchpool hands you one that is already set up.
Anything that is not about the pool is deferred to `dx-org-manage` (SKILL.md, "When to defer").

## 2. Platform facts that shape the design

### Allocations are the scarce resource

From Salesforce's
[editions and allocations](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs-editions-and-allocations.html)
page:

| Dev Hub edition | Active | Daily (rolling 24 h) |
|---|---|---|
| Developer Edition / trial | 3 | 6 |
| Enterprise | 40 | 80 |
| Unlimited / Performance | 100 | 200 |

- `sf org list limits --json` reports them live as `ActiveScratchOrgs` and `DailyScratchOrgs`.
- Every pool org uses one daily create and holds one active slot whether or not anyone claims
  it. With no claims, a pool of N orgs lasting D days uses N / D creates per day.
  [pool-sizing.md](pool-sizing.md) works through the numbers.
- **UNVERIFIED:** whether the Developer Edition daily counter is shared with package version
  creates, and whether failed creates count.

### Async create cannot be resumed later or elsewhere

The obvious design is to queue `sf org create scratch --async` job IDs and resume one when
someone claims. Reading [sfdx-core](https://github.com/forcedotcom/sfdx-core) (checked
2026-10-01; details in [CREDITS.md](../CREDITS.md)) rules that out:

- `sf org resume scratch` reads a per-machine cache (`scratchOrgCache.ts`,
  `scratch-create-cache.json`) with a 1-day TTL, and throws `CacheMissError` when the job is not
  in it.
- For web-login hubs, logging into the new org uses a single-use `ScratchOrgInfo.AuthCode`
  (`scratchOrgInfoApi.ts`). Its lifetime is **UNVERIFIED**.
- Org settings are deployed from the developer's machine during resume (`scratchOrgCreate.ts`,
  `deploySettings`), which is where `DeployingSettingsTimeout`
  ([cli#1817](https://github.com/forcedotcom/cli/issues/1817)) fails.

**Consequence:** a queued job ID is not a warm org. An org counts as warm only after the create
has finished, the org is logged in locally, and the optional setup has run.

### Other CLI facts

- `--edition`, `--snapshot` and `--source-org` are mutually exclusive. Features and settings
  need a definition file.
- In sf v2, `-d` means `--set-default`, not duration. Duration is `-y` / `--duration-days`
  (1–30, default 7).
- `ScratchOrgInfo.ExpirationDate` is a date, not a timestamp, so the exact deletion time is
  unknown. An org created just before UTC midnight has only `(durationDays − 1) × 24` hours of
  guaranteed life.
- `ScratchOrgInfo` stays owned by the user who created the org, so a pool shared between people
  would need credential handoff.
- Orgs can be orphaned: an org deleted through the CLI can stay Active on the hub
  ([cli#1155](https://github.com/forcedotcom/cli/issues/1155)), and a timed-out create can leave
  an org with no alias ([cli#632](https://github.com/forcedotcom/cli/issues/632)).
- Signing up through an External Client App with JWT fails with C-1016
  ([cli#3515](https://github.com/forcedotcom/cli/issues/3515), open as of 2026-10-01). The
  workaround needs `SF_SCRATCH_SIGNUP_*` environment variables and sf 2.147.7, which is why
  2.147.7 is the minimum version. See [ci-auth.md](ci-auth.md).
- Secrets: per [cli#3560](https://github.com/forcedotcom/cli/issues/3560) and
  [cli#3658](https://github.com/forcedotcom/cli/issues/3658) (open, read 2026-10-01), the CLI
  redacts secrets by default and plans to remove the `SF_TEMP_SHOW_SECRETS` workaround on
  2026-10-28. The exact versions and dates are as announced there and were not independently
  verified.

### Snapshots

[Scratch org snapshots](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-snapshots-intro.html)
capture packages, features, licences, metadata and data, so they can remove most of the setup
cost without any compute of ours. They expire after 90 days, must be created and used on the
same Dev Hub, and cannot be taken from a namespaced org or an org built from a snapshot.
Salesforce's
[2024 blog post](https://developer.salesforce.com/blogs/2024/08/optimize-your-developer-experience-with-scratch-org-shapes-and-snapshots)
gives a limit of 5 per day and 5 active. Treat that as the working number and read the live
limits (**UNVERIFIED** for current hubs). See [snapshots.md](snapshots.md).

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Warm means ready.** A background worker runs a blocking `sf org create scratch --wait 30`, then the optional setup hook, and only then marks the org `ready`. | Async resume is per-machine and short-lived (§2). An empty warm org saves only provisioning time; the setup is the bigger cost. |
| 2 | **Claim is an alias handoff.** `sf alias set`, `sf alias unset`, `sf config set target-org`. No limits call and no create on the warm path. | The claim has to be fast and must not fail on allocation checks. Measured 1.9–2.9 s, dominated by about five `sf` process starts ([benchmarks.md](benchmarks.md)). |
| 3 | **Per user, per machine.** Every org is created with the developer's own Dev Hub login. No shared credentials, no hosted service. | `ScratchOrgInfo` ownership (§2), and a shared pool would mean handing auth URLs between people. A team pool is out of scope for v0.1. |
| 4 | **Configure once; the OS scheduler refills.** `init` installs a per-user launchd, systemd `--user` or Task Scheduler entry that runs `tick` every 15 minutes, and each claim kicks one extra tick. | Refill must not depend on an agent or terminal staying open. Using the OS's own scheduler keeps "no server" true. See [background-service.md](background-service.md). |
| 5 | **Allocation guards run only before a create.** `dailyFloor` (default 2), `activeReserve` (default 1, kept free for cold claims) and `teamCapPct` (default 25% of the hub's active allocation, counted over tagged records). | Several personal pools share one hub; one developer's pool must not starve the others. Claimed and releasing orgs do not count toward the cap: on a 3-org Developer Edition hub the cap is 1, and the developer's own claimed org blocked every refill in the first live run. |
| 6 | **Durations.** Pool orgs: 3 days on Developer Edition hubs (daily max ≤ 6), otherwise 7. Cold orgs: 1 day. Claims need `claimMinLifeHours` (24) left; configs where `(durationDays − 1) × 24 ≤ claimMinLifeHours` are rejected. | Balances allocation burn against idle expiry. The rejection rule follows from date-only expiry (§2): otherwise every new org would be recycled on the next tick. |
| 7 | **Hand out the oldest eligible org.** | Handing out the freshest lets older orgs expire unused, and each of those wasted a daily create. The life-left floor protects the person claiming. |
| 8 | **Recipe hash (`defHash`).** A hash of the definition file (or snapshot name), the project namespace, the hub username and the setup hook's contents. Orgs built from an older recipe are stale; `--any` accepts them. | A pooled org must match the code the developer is working on. |
| 9 | **Description tag** `scratchpool:v1:<hubUser>:<defHash>:<machineId>` on `ScratchOrgInfo`, matched client side. | Lets `status` show team usage and `release --orphans` find orgs this machine created but lost track of (a sleeping laptop during a create). Salesforce rejects a SOQL filter on `Description` with `INVALID_FIELD` (found in the first live run), so the query filters on `Status` and the tag is matched in the script. |
| 10 | **Setup hook: opt-in, background only, pinned.** `.scratchpool/setup` (or `setup.mjs` / `setup.cmd`) runs only during refill, never at claim time and never on an agent's request. Enabling it records the file's sha256; a changed hook is not run (`SETUP_UNTRUSTED`) until the user re-enables it. | The hook runs unattended as the user. Keeping it user-owned, out of the agent's reach and pinned to reviewed contents limits what a prompt injection or a `git pull` can make it do. |
| 11 | **One zero-dependency Node script** (Node ≥ 20, built-ins only), also runnable as a CLI. Not an `sf` plugin, not shell plus `jq`. | Auditable in one sitting, no install scripts, and Windows works. An `sf` plugin adds an unsigned-plugin prompt; it can be reconsidered at v1.0. |
| 12 | **CLI only; no MCP create path.** `sf` is spawned with argument arrays. | The MCP tools are non-GA and would bypass the tagging and guards. `dx-org-manage` itself tells agents not to use the MCP tools for org creation (checked 2026-10-01). |
| 13 | **Secrets never reach output.** Output fields come from an allowlist; every message is scrubbed; text relayed from `sf` is clipped and stripped of control characters; the script refuses to run with `SF_TEMP_SHOW_SECRETS` set; `sf org open` runs only in a terminal. | The agent's context is untrusted and observable. See [security.md](security.md). |
| 14 | **`allowed-tools` pre-approves, deny rules restrict.** The skill pre-approves only read-only commands and `claim`; [settings.deny.json](../examples/settings.deny.json) blocks commands that print credentials. | In Claude Code, `allowed-tools` only skips the permission prompt; it does not block anything else. |
| 15 | **Agents never cold-create silently.** An empty pool returns a retryable `POOL_EMPTY`; a cold create from a script or agent needs `--cold --yes`. | A cold create spends a daily allocation. The decision belongs to the user, not to text in a ticket or tool output. |
| 16 | **Stable JSON contract.** Every command prints one `scratchpool/v1` object; a breaking change is a semver major. Exit codes: 0, 1, 3 `LIMIT`, 4 `POOL_EMPTY`, 5 ownership refusals, 127 `SF_MISSING`, otherwise `sf`'s own code. | Agents parse the output, so a schema field is cheap insurance. |

Non-goals for v0.1: sandboxes, single-org features already in `dx-org-manage`, deploy
commands an agent can trigger, any hosted service or database, enabling Dev Hub, and telemetry.

## 4. Alternatives considered and rejected

- **Queue async job IDs and resume on claim.** Rejected: see §2. Resume is per-machine,
  expires after a day and deploys settings locally at claim time.
- **Claim the freshest org first.** Rejected in favour of the oldest eligible org (decision 7).
- **Rely on Salesforce expiry instead of cleanup.** Partly rejected. Background creates can be
  orphaned, and an orphan holds an active slot for days, so `release --stale` and
  `release --orphans` exist.
- **Drop the `SF_TEMP_SHOW_SECRETS` check.** Rejected until the minimum supported CLI is past
  the announced removal of that variable. The check costs one line.
- **Only exit codes 0 and 1, no schema field.** Partly rejected: a schema field plus a few
  documented codes.
- **Ship as an `sf` plugin now.** Deferred to v1.0 (decision 11).
- **macOS and Linux only.** Rejected: the Node script makes Windows cheap to support.
- **Run the setup hook at claim time.** Rejected: it would make the claim slow and let an agent
  trigger code execution.

## 5. Evidence so far and the bar to clear

The first live run (2026-10-02, Developer Edition hub, sf 2.152.14, 5-class smoke project) is
in [benchmarks.md](benchmarks.md): warm claim 1.9–2.9 s against 15.5 s for a cold create plus
deploy. It shows the mechanism works, not that it saves meaningful time, because the smoke
project is the best case for a cold create.

The project's own success criteria:

- On 2 real repos (package installs, larger deploys, data loads, features in the definition
  file), a warm claim must beat a cold create plus setup by at least 3 minutes. **Not yet
  measured.**
- By day 60 after release, at least 3 developers other than the author use `claim` weekly for
  4 weeks.
- If either fails, or Salesforce ships native scratch org pooling, the work goes upstream to
  sf-skills and this repo is archived.

## 6. Open questions

- Whether the Developer Edition daily counter is shared with package versions, and whether
  failed creates count.
- Current snapshot limits (5/5 per the 2024 blog).
- The lifetime of the single-use `AuthCode`.
- Whether `${CLAUDE_SKILL_DIR}` expands inside `allowed-tools`. If it does not, the commands
  simply prompt, which is safe.
- Whether deleting an orphan through its `ActiveScratchOrg` record always frees the slot.
- Whether Node is on `PATH` for developers who installed the sf CLI with the installer (which
  bundles its own Node).
- Real-repo timings (§5).
