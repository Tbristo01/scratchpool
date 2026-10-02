# scratchpool v0.1 — implementation contract

Source of truth for every builder. Rationale lives in [design-rationale.md](design-rationale.md).
If this file and the rationale disagree, **this file wins**.

## 0. Product model (author decision, 2026-10-01)

**Configure once, runs in the background, owned by the developer.**

- A developer runs `scratchpool init` once per project. It records *their own* Dev Hub alias, the pool size and the org recipe, and installs a per-user background scheduler on *their* machine.
- Every pool org is created by the developer's own Dev Hub credential on their own machine, so `ScratchOrgInfo.CreatedById` is the developer. There are no shared credentials, no central service, and no handoff of credentials between people.
- The scheduler runs `scratchpool tick` every N minutes (default 15). Each tick reconciles state, recycles orgs that are expired or nearly so, and starts background creates up to the configured size, within Dev Hub limits.
- The developer controls everything from the CLI: claim an org, release (delete) orgs, resize the pool, pause it, or uninstall it.
- **Fully local.** The pool is managed entirely on the developer's own machine (laptop or workstation): local config, local state, and the OS's own scheduler. There is no hosted server, database, queue, cloud function or network service of ours — the only remote endpoint is Salesforce, reached through the developer's own `sf` CLI.

`scripts/lib/service.mjs` exports exactly this interface (used by the core script):
```js
installService({home, nodePath, scriptPath, sfPath, intervalMinutes, platform, dryRun}) // -> {installed:true, platform, files:[...], commands:[[...argv]]}
uninstallService({home, platform, dryRun})                                             // -> {installed:false, platform, files:[...], commands:[...]}
serviceStatus({home, platform, dryRun})                                                // -> {installed, platform, intervalMinutes|null, detail}
// Errors: throw an Error with .code = 'SERVICE_UNSUPPORTED' (and .crontab = '<line>' on Linux without systemd --user)
```

## 1. Shape

- One zero-dependency ES module: `skills/scratchpool/scripts/scratchpool.mjs` (Node >= 20, built-ins only; may be split into `scripts/lib/*.mjs` if > ~900 lines, still zero deps).
- Also exposed as a CLI (`npx github:Tbristo01/scratchpool`; not on the npm registry) via `package.json` `"bin": {"scratchpool": "skills/scratchpool/scripts/scratchpool.mjs"}` (shebang `#!/usr/bin/env node`).
- Talks to Salesforce ONLY by spawning the `sf` CLI with `--json`, using arg arrays (never a shell string). On Windows, resolve `sf.cmd` and spawn it through `cmd.exe /d /s /c` with cross-spawn-style escaping (command token caret-escaped, each argument quoted then caret-escaped).
- Platform scheduler integration: macOS launchd LaunchAgent, Linux systemd `--user` timer (fallback: print a crontab line), Windows Task Scheduler (`schtasks`).

## 2. Commands

```
scratchpool init      [--hub <alias>] [--size <n>] [--def <path> | --snapshot <name>] [--duration <days>]
                      [--interval <minutes>] [--setup-hook] [--pool <name>] [--no-service] [--json]
scratchpool claim     [alias] [--pool <name>] [--json] [--no-open] [--cold [--yes]] [--any]
scratchpool release   <alias...> | --pool-orgs | --surplus | --stale | --orphans   [--pool <name>] [--yes] [--json]
scratchpool status    [--pool <name>] [--json]           # alias: list
scratchpool config    show | get <key> | set <key> <value>   [--pool <name>] [--json]
scratchpool pause     [--pool <name>] [--json]           # tick does nothing for this pool
scratchpool resume    [--pool <name>] [--json]
scratchpool tick      [--pool <name>] [--json]           # what the scheduler runs; also "fill now"
scratchpool service   install | uninstall | status  [--interval <minutes>] [--json]
scratchpool uninstall [--release-pool-orgs] [--yes] [--json]  # removes service (+ optionally pool orgs); keeps claimed orgs
scratchpool _worker   --pool <name> --alias <a>          # internal: one background create
scratchpool --version | --help
```

`return` is accepted as a hidden alias of `release`. `--help` or `--version` anywhere on the command line prints help (or the version) and exits 0 **without running the command** (`init --help` must never init).

### Pool selection
`--pool <name>` wins. Otherwise use the pool whose `projectDir` contains the cwd (deepest match). Otherwise, if exactly one pool exists, use it. Otherwise fail with error `NO_POOL` and list the pool names. `init` defaults the pool name to the project directory's basename (sanitised to `[a-z0-9-]`).

### init
1. Find the project root: walk up from cwd to the dir containing `sfdx-project.json` (else `NOT_A_PROJECT`).
2. Resolve the hub: `--hub`, else `sf config get target-dev-hub --json`. Verify it with `sf org display -o <hub> --json` and confirm it appears in `sf org list --json` `result.devHubs` (else `NO_DEVHUB`). Store the **alias/username exactly as the user's local sf auth knows it**. scratchpool never stores tokens.
3. Recipe: `--snapshot` or `--def` (default `config/project-scratch-def.json`, which must exist unless a snapshot is given).
4. Write the pool into the user config (section 3). Record absolute `nodePath` (`process.execPath`), `sfPath` (resolved sf binary) and `scriptPath`, because launchd, systemd and schtasks run with a minimal PATH.
5. Unless `--no-service`, run `service install` (idempotent; one scheduler entry per user, serving all pools).
6. Run one `tick` for this pool immediately, so filling starts now.
7. Output the pool config, service status and the initial tick result.

Re-running `init` updates the pool (idempotent).

### claim
0. Refuse with `USAGE` if `[alias]` is the pool's `hub` or the alias of any non-scratch org in `sf org list` (`devHubs`, `nonScratchOrgs`, `sandboxes`, `other`): claim must never repoint such an alias.
1. **Idempotent:** if `[alias]` exists in `sf org list` `scratchOrgs` and has not expired → `source:"existing"`.
2. **Warm path, no limits call, no create:** take the oldest `ready` entry with a matching `defHash` (any hash with `--any`) and `lifeLeftHours >= claimMinLifeHours`, still present and unexpired in `sf org list`. Run `sf alias set <alias>=<username>`, `sf alias unset <pool alias>`, `sf config set target-org=<alias>` (in the project dir). Mark the entry `claimed` with `claimedAs:<alias>` and `claimedAt` → `source:"pool"`.
3. **Cold path:** check limits (`LIMIT` if ActiveRemaining < 1 or DailyRemaining < 1). In an interactive TTY without `--json`, or with `--cold` (which also needs `--yes` when not interactive, else `CONFIRM_REQUIRED`): do a blocking create under the requested alias with `-y coldDurationDays`, and record it as a `claimed` entry → `source:"fresh"`. The setup hook is **not** run at claim time (`setupRan:false`; warning `SETUP_SKIPPED` when `setupHook` is on): it runs only in background refill. Otherwise return `POOL_EMPTY` (`retryable: true`) with `pool` counts and `refillEtaMin: 5`.
4. After any pool or fresh claim, start one detached `tick` for that pool (fast replenishment, without waiting for the timer).
5. Open the browser only in a TTY, without `--json` or `--no-open`.
6. Default alias if none is given: `sp-<yyyymmdd>-<4 hex>`.

### release
Releasing means **deleting the org and freeing its Dev Hub slot**. It only ever touches orgs recorded in this user's state for the selected pool (or, with `--orphans`, hub records this machine created).
Deletion is two-phase (tick recycle/surplus, every `release` mode, `uninstall --release-pool-orgs`): targets are chosen from a snapshot, then **under the state lock** each target is re-read by alias, kept only if its *current* status is one the caller allows (never `claimed`, except `release <alias>` and expired claimed entries in `--stale`), its *current* username is taken, and it is marked `releasing` (claims only take `ready`; workers only advance `creating`). Then the org is deleted and the entry dropped, or its status restored if the delete failed. An entry with a username is always deleted on the hub, even if `sf org list` does not show it; only a failed delete of an unlisted or expired org is treated as already gone.
- `release <alias...>`: each must be a `claimed` or `ready` entry in state, must be in `sf org list` `scratchOrgs`, and its `devHubUsername` must equal the pool's hub username (else `NOT_MINE`/`NOT_SCRATCH`). Not in state but a scratch org of this hub → refuse with `NOT_MANAGED` (tell the user to use `sf org delete scratch`).
- `--pool-orgs`: release all `ready`, `creating` and `failed` entries. Never touches `claimed` orgs.
- `--surplus`: release the youngest `ready` entries beyond `size`.
- `--stale`: release `ready` entries with a stale defHash, entries past `expiresAt`, and `failed`/`expired` entries.
- `--orphans`: delete hub `ScratchOrgInfo` records with `Status = 'Active'` whose Description starts `scratchpool:v1:<hubUsername>:` **and ends `:<machineId>` of this install**, whose `SignupUsername` is in no local pool state, whose `CreatedDate` is at least 60 min old (a create may still be running), and that do not carry a local alias other than a pool worker alias `sp-<pool>-<4 hex>` (a user alias means it was probably claimed). Skipped records are listed in `skipped` with the reason. The confirmation names them as orphans that may still be in use.
- Non-interactive (`--json` or no TTY) requires `--yes`, else `CONFIRM_REQUIRED`. Interactive mode asks y/N on stdin.
- Output: `deleted:[aliases]`, `skipped:[{alias, reason}]`. Entries are removed from state after a successful delete.

### config
Keys (per pool): `size` (0–50; 0 = keep nothing warm), `hub`, `definitionFile`, `snapshot`, `durationDays`, `coldDurationDays`, `setupHook`, `dailyFloor`, `teamCapPct`, `claimMinLifeHours`, `activeReserve`. Global key: `intervalMinutes` (changing it reinstalls the service).
- `set size` lower than the current ready count → surplus is released on the next tick. `set size` higher → filled on the next tick. `config set` itself never creates or deletes.
- Validate types and ranges (error `USAGE`).
- Reject (`USAGE`, in `init` and `config set durationDays|claimMinLifeHours`) when `(durationDays − 1) × 24 ≤ claimMinLifeHours`, with `durationDays: null` checked as 3. Expiry is a UTC date, so an org created just before UTC midnight has only `(durationDays − 1) × 24` h left; otherwise recycle would delete every new org on the next tick and refill would recreate it, burning the daily allocation.

### pause / resume
Sets `paused: true/false` on the pool. A paused tick reports `skipped:"paused"` and creates nothing. Claims still work.

### tick (scheduler entry point; must be safe to run concurrently and repeatedly)
For each selected pool (all pools when run by the scheduler with no `--pool`), under a per-pool tick lock (skip if held):
1. **Reconcile.** A `creating` entry whose worker pid is dead and is older than 45 min → `failed`. A `releasing` entry whose `releasePid` is dead → `failed` (recycle retries the delete). A `ready` or `claimed` entry missing from `sf org list` or expired → removed (claimed) or `expired` (ready), **unless it settled (`settledAt`, wall clock) after the list was fetched** — the list cannot know it yet. A claimed entry past `expiresAt` → removed.
2. **Recycle.** `ready` entries with `lifeLeftHours < claimMinLifeHours`, or `failed`/`expired` entries → delete (release). Skip if paused.
3. **Surplus.** If ready + creating > size → release the youngest surplus `ready` entries.
4. **Refill guards** (the only place limits are read besides cold claim). `need = size − (ready + creating)`. If `need ≤ 0` → done. Skip if `setupHook` is on and the hook file is missing or its sha256 differs from `setupHookSha256` (reason `SETUP_UNTRUSTED`; nothing is created). Skip if the (resolved) `durationDays` fails the config rule above (reason `DURATION_TOO_SHORT`; protects hand-edited configs). Read `sf org list limits`. Skip if `DailyRemaining < dailyFloor` (reason `DAILY_FLOOR`). `startable = min(need, ActiveRemaining − activeReserve, DailyRemaining)`; skip if `≤ 0` (reason `ACTIVE_RESERVE`). Skip if active hub records tagged `scratchpool:v1:` ≥ `teamCapPct`% of `ActiveScratchOrgs.max` (reason `TEAM_CAP`).
5. Start `startable` detached workers. Each adds a `creating` entry with alias `sp-<pool>-<4 hex>`; the worker runs `sf org create scratch` with that alias, then the optional setup hook, then marks the entry `ready` (or `failed` with an error message containing no secrets).
6. Append one line per action to `<home>/logs/scratchpool.log` (rotate at 1 MB, keep 1 backup).

Tick output: `{pools:[{name, paused, ready, creating, claimed, size, started, released:[...], skipped:<reason|null>}]}`. `skipped` is `null`, `paused`, `locked` (another tick holds the lock), `SETUP_UNTRUSTED`, `DURATION_TOO_SHORT`, `DAILY_FLOOR`, `ACTIVE_RESERVE`, `TEAM_CAP`, or the error code of a failed tick (e.g. `SF_ERROR`, `LIMIT`).

### service
- **macOS:** `~/Library/LaunchAgents/dev.scratchpool.tick.plist` with `ProgramArguments=[nodePath, scriptPath, "tick", "--json"]`, `StartInterval=intervalMinutes*60`, `RunAtLoad=true`, stdout/stderr → `<home>/logs/launchd.log`, and `EnvironmentVariables` PATH including the dirs of nodePath and sfPath. Then `launchctl bootout gui/<uid>/dev.scratchpool.tick` (ignore failure) and `launchctl bootstrap gui/<uid> <plist>`.
- **Linux:** `~/.config/systemd/user/scratchpool-tick.service` (Type=oneshot, **KillMode=process** so the detached `_worker` creates survive tick's exit, ExecStart with absolute paths, Environment=PATH=… and SCRATCHPOOL_HOME=…) and `scratchpool-tick.timer` (`OnBootSec=2min`, `OnUnitActiveSec=<n>min`, `Persistent=true`), then `systemctl --user daemon-reload` and `enable --now scratchpool-tick.timer`. If `systemctl --user` is unavailable, return `SERVICE_UNSUPPORTED` with a ready-to-paste crontab line.
- **Windows:** write `<home>\scratchpool-tick.cmd` (sets `SCRATCHPOOL_HOME` and `PATH` like the plist/unit, then runs `"<nodePath>" "<scriptPath>" tick --json >> "<home>\logs\task.log" 2>&1`; literal `%` doubled), then `schtasks /Create /F /SC MINUTE /MO <n> /TN scratchpool-tick /TR "\"<home>\scratchpool-tick.cmd\""`. Uninstall also deletes the wrapper.
- **Self-repair:** when an interactive `claim`, `status` or `tick` finds that the recorded `scriptPath`, `nodePath` or `sfPath` no longer exists and the service is installed, it re-installs the service with the running copy's paths and warns `SERVICE_REPAIRED`.
- `<home>/logs` is created `0700`; `launchd.log` (and `cron.log` for the crontab fallback) are pre-created `0600`.
- `uninstall` reverses each. `status` reports `installed`, `intervalMinutes`, the last tick time (from the log or state) and the platform.
- **Test seam:** if `SCRATCHPOOL_SERVICE_DRYRUN=1`, write the unit or plist files under `<home>/service-dryrun/` and record the commands that would have run in `<home>/service-dryrun/commands.json`, without executing launchctl, systemctl or schtasks. `SCRATCHPOOL_PLATFORM` overrides `process.platform`.

## 3. Files

`SCRATCHPOOL_HOME` defaults to `$XDG_CONFIG_HOME/scratchpool`, else `~/.config/scratchpool`; on Windows `%APPDATA%\scratchpool`.

`<home>/config.json` (user-level; this is the only configuration — there is no project-level config file):
```json
{"schema":1,"intervalMinutes":15,"machineId":"1a2b3c4d","nodePath":"/abs/node","sfPath":"/abs/sf","scriptPath":"/abs/scratchpool.mjs",
 "pools":{"my-app":{"projectDir":"/abs/my-app","hub":"devhub","hubUsername":"me@corp.com",
   "size":1,"definitionFile":"config/project-scratch-def.json","snapshot":null,"durationDays":null,
   "coldDurationDays":1,"setupHook":false,"dailyFloor":2,"teamCapPct":25,"claimMinLifeHours":24,
   "activeReserve":1,"paused":false,"setupHookSha256":null}}}
```
- `machineId`: 8 random hex chars generated by the first `init` (or `service install`); written into every org's Description so `release --orphans` never touches orgs created on the developer's other machines.
- `durationDays: null` → 3 if the hub's `DailyScratchOrgs.max <= 6` (Developer Edition hub), else 7.
- `setupHook: true` → run `<projectDir>/.scratchpool/setup` (executable), or `setup.mjs` via nodePath, or `setup.cmd` on Windows, with cwd = projectDir and env `SCRATCHPOOL_TARGET=<pool alias>`. A non-zero exit → entry `failed`. A 30-minute timeout. Enabling the hook (`init --setup-hook` or `config set setupHook true`) records `setupHookSha256`; the worker re-checks it just before running the hook and refuses (`SETUP_UNTRUSTED`, entry `failed`) if the file changed.

`<home>/state/<pool>.json`:
```json
{"schema":1,"entries":[{"alias":"sp-my-app-1a2b","username":"...","orgId":"00D...","defHash":"...",
  "createdAt":"ISO","expiresAt":"YYYY-MM-DD","status":"creating|ready|claimed|failed|expired|releasing",
  "claimedAs":null,"claimedAt":null,"pid":123,"error":null,"settledAt":1759320000000}]}
```
- `settledAt` (epoch ms, wall clock) is set when an entry becomes `ready` or a fresh claim is recorded. `releasing` entries also carry `prevStatus` and `releasePid`.
- `<home>`, `state/` and `logs/` are created `0700`; files are written `0600`.
- Every write is atomic (write a temp file, then rename) under `<file>.lock` (`fs.openSync(...,'wx')`; a lock older than 60 s is stale). Claims and workers must not lose each other's updates: read-modify-write inside the lock.
- `defHash` = the first 12 hex chars of sha256 over a JSON of: the definition file contents (or `snapshot:<name>`), `namespace` from `sfdx-project.json`, the hub username, and the setup hook file contents when `setupHook` is on.

Environment variables:
- `SCRATCHPOOL_HOME`
- `SCRATCHPOOL_SF_BIN` (overrides sfPath; used by tests)
- `SCRATCHPOOL_NO_DETACH=1` (run workers and post-claim ticks synchronously; tests)
- `SCRATCHPOOL_NOW` (an ISO "now"; tests)
- `SCRATCHPOOL_SERVICE_DRYRUN`
- `SCRATCHPOOL_PLATFORM`

If `SF_TEMP_SHOW_SECRETS` is set → refuse every command with `SECRETS_ENV`.

## 4. sf calls (exhaustive allowlist)

| Purpose | Command |
|---|---|
| version | `sf --version` (parse `@salesforce/cli/X.Y.Z`; below 2.147.7 → warning `SF_OLD`, do not fail) |
| default hub | `sf config get target-dev-hub --json` → `result[0].value` |
| hub identity | `sf org display -o <hub> --json` → `result.username` (NEVER `--verbose`) |
| local orgs | `sf org list --json` → `result.devHubs[]`, `result.scratchOrgs[]` `{alias,username,orgId,expirationDate,devHubUsername,isExpired}`, and `{alias,username}` of `devHubs`/`nonScratchOrgs`/`sandboxes`/`other` (claim alias check) |
| limits | `sf org list limits -o <hub> --json` → `result[]` `{name,max,remaining}` (`ActiveScratchOrgs`, `DailyScratchOrgs`) |
| create | `sf org create scratch (-f <abs def> \| --snapshot <name>) -v <hub> -y <days> -a <alias> --description scratchpool:v1:<hubUsername>:<defHash>:<machineId> --wait 30 --json`, cwd = projectDir → `result.username`, `result.orgId`, `result.scratchOrgInfo.ExpirationDate`. Ignore `authFields` entirely. |
| alias | `sf alias set <alias>=<username> --json`, `sf alias unset <alias> --json` |
| default org | `sf config set target-org=<alias> --json` (cwd = projectDir) |
| delete | `sf org delete scratch -o <username> --no-prompt --json` |
| hub records | `sf data query -o <hub> -q "SELECT Id, SignupUsername, Description, ExpirationDate, Status, CreatedDate FROM ScratchOrgInfo WHERE Status = 'Active'" --json` → `result.records[]`, then keep only records whose Description starts `scratchpool:v1:` (Description is a long text area and cannot be filtered in SOQL) |
| open | `sf org open -o <alias>`: TTY only, stdio `ignore` |

On sf failure, parse the JSON `{status, name, message}`. A name or message matching `/limit|allocation/i` → `LIMIT`; otherwise `SF_ERROR` with sf's exit code passed through. **Scrub every message passed to output or logs**: redact `force://\S+`, `00D\w{12,15}![\w.]+`, `sid=\S+`, `access_token=\S+`, `frontdoor\.jsp\S*`, `refresh_token\S*`; additionally `5Aep[\w.]+` and key/value pairs of `refreshToken|accessToken|password|sfdxAuthUrl|clientSecret` (defense in depth).

## 5. Output contract

When `--json` is passed or stdout is not a TTY, stdout is exactly one JSON object. Otherwise it is concise human text. Diagnostics go to stderr only in human mode.

```json
{"schema":"scratchpool/v1","command":"claim","status":"ready|ok|error","pool":"my-app",
 "source":"existing|pool|fresh|null","alias":null,"username":null,"orgId":null,"instanceUrl":null,
 "expiresAt":null,"lifeLeftHours":null,"setupRan":null,
 "counts":{"ready":0,"creating":0,"claimed":0,"size":1,"paused":false},
 "limits":{"activeRemaining":null,"dailyRemaining":null},
 "warnings":[],
 "error":{"code":null,"message":null,"retryable":false}}
```

Command-specific additions:
- `status` adds `entries:[{alias,status,lifeLeftHours,stale,claimedAs}]`, `team:{poolOrgs,activeMax,capPct}` and `service:{installed,intervalMinutes,lastTick}`.
- `release` adds `deleted` and `skipped`.
- `tick` adds `pools`.
- `init`/`config` add `config` (the pool object).

Every field is copied from an explicit allowlist. Never output accessToken, refreshToken, sfdxAuthUrl, loginUrl, frontdoor URLs, passwords, or `authFields`.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | `USAGE`, `CONFIRM_REQUIRED`, `SECRETS_ENV`, `NO_POOL`, `NOT_A_PROJECT`, `SERVICE_UNSUPPORTED`, or generic |
| 3 | `LIMIT` |
| 4 | `POOL_EMPTY` |
| 5 | `NO_DEVHUB`, `NOT_SCRATCH`, `NOT_MINE`, `NOT_MANAGED` |
| sf's own code | `SF_ERROR` (passed through) |
| 127 | `SF_MISSING` |

## 6. Repo layout

```
.claude-plugin/{marketplace.json, plugin.json}
skills/scratchpool/{SKILL.md, scripts/scratchpool.mjs (+ scripts/lib/*.mjs), references/troubleshooting.md}
docs/{README.md, SPEC.md, design-rationale.md, benchmarks.md, pool-sizing.md, ci-auth.md, snapshots.md, security.md, background-service.md, demo/}
examples/{setup.example.sh, settings.deny.json}
tests/{*.test.mjs, stub/sf (+ sf.cmd), fixtures/}
evals/
.github/{workflows/ci.yml, workflows/release.yml, ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md}
package.json README.md CHANGELOG.md LICENSE SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md .gitignore
```

- Version: `0.1.0`
- License: Apache-2.0
- Author: Tishaun Bristol
- Repo URL (not yet pushed): `https://github.com/Tbristo01/scratchpool`
