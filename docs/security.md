# Security model

scratchpool is a local tool that an AI agent can drive. This page states what it protects,
how, and what it does not try to do. To report a vulnerability, see `SECURITY.md`.

## Trust boundaries

1. **Your machine and your sf login are trusted.** scratchpool runs as you, on your laptop or
   workstation, and talks to Salesforce only by spawning your own `sf` CLI.
2. **The AI agent's context is untrusted and observable.** Anything printed to stdout can end
   up in a transcript, a log, or a model provider's systems. Secrets must never reach it.
3. **Text the agent reads is untrusted.** Tickets, files, web pages and tool output can contain
   instructions (prompt injection). They must not be able to delete orgs, leak credentials or
   deploy code.

## Threats and mitigations

### Local only: no server, no shared credentials

- The pool is managed entirely on your machine: a config file, a state file per pool, a log,
  and your OS's own scheduler (launchd, systemd `--user` or Task Scheduler) running
  `scratchpool tick`. There is no hosted server, database, queue or cloud function, and no
  telemetry. The only remote endpoint is Salesforce, reached through `sf`.
- Every pool org is created with **your own** Dev Hub alias, so `ScratchOrgInfo.CreatedById`
  is you. Credentials are never handed from one person to another.
- The scheduler entry is per user (a LaunchAgent, a user systemd timer, or a user scheduled
  task). It needs no administrator rights and runs nothing as root.
- `sf` is spawned with an argument array, never a shell string. On Windows, where `sf.cmd` has
  to run through `cmd.exe`, cmd parses the line at least twice (the `cmd /c` line and the shim's
  `%*`) and three times with the official Salesforce CLI installer, whose `sf.cmd` passes `%*` on
  to a second `sf.cmd` in `%LOCALAPPDATA%\sf\client\bin`. Every argument is quoted and
  caret-escaped for the first two parses, and an argument or `sf` path containing `"`, `%` or a
  control character is refused with `USAGE`, so later parses see only plain quoted strings and
  keep them literal however many there are. A Dev Hub given to `init --hub` or `config set hub`
  must be an sf alias or username. The crontab line printed when
  systemd `--user` is missing escapes `%` the way cron needs and refuses control characters.

### Credentials leaking into the transcript

- **No secrets stored.** `<home>/config.json` holds the hub *alias or username* exactly as your
  local sf auth knows it, plus paths and numbers. State files hold aliases, usernames, org IDs,
  dates and statuses. Tokens stay in the sf CLI's own store; scratchpool never reads it.
  `<home>` and its `state/` and `logs/` folders are created `0700` and files `0600` (POSIX),
  including the scheduler's own `launchd.log` / `cron.log`.
- **Allowlisted output.** Every JSON field scratchpool prints is copied from an explicit
  allowlist (`docs/SPEC.md` section 5). `accessToken`, `refreshToken`, `sfdxAuthUrl`,
  `loginUrl`, frontdoor URLs, passwords and `authFields` are never copied, even when `sf`
  returns them.
- **Scrubbing.** Every message passed to output or to the log is scrubbed of
  `force://…`, `00D…!…` session IDs, `sid=…`, `access_token=…`, `frontdoor.jsp…`,
  `refresh_token…`, `5Aep…` refresh tokens and `refreshToken`/`accessToken`/`password`/
  `sfdxAuthUrl`/`clientSecret` key-value pairs, including error text from `sf` and from the
  setup hook.
- **No secret-revealing calls.** The script's sf calls are a fixed allowlist. It never passes
  `--verbose` and never calls `sf org auth show-*`.
- **`SF_TEMP_SHOW_SECRETS`.** If it is set, every command refuses with `SECRETS_ENV`. Per
  [forcedotcom/cli#3658](https://github.com/forcedotcom/cli/issues/3658) (as read on
  2026-10-01; not independently verified), the sf CLI redacts secrets by default from 2.136.8
  and plans to remove this variable on 2026-10-28. The check stays until the minimum supported
  CLI is past that removal.
- **No browser URLs.** `sf org open` is called only in an interactive terminal, with its output
  discarded. Agents get the alias and are told to let the user run `sf org open -o <alias>`.

### An agent running dangerous sf commands directly

`allowed-tools` in `SKILL.md` grants only read-only subcommands and `claim` of
`node <skill>/scripts/scratchpool.mjs …` (`status`, `list`, `claim`, `config show|get`,
`service status`); everything else, including `tick` (which can start background creates and
the setup hook), prompts. A pre-approved `claim` can only hand out a warm org: a cold create
needs `--cold --yes` when not interactive, and the skill must get your yes in the chat first. That **pre-approves**; it does not **restrict**. To actually block commands that print secrets,
add `permissions.deny` rules to your Claude Code settings (`~/.claude/settings.json`, or the
project's `.claude/settings.json`). The same snippet ships as `examples/settings.deny.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "deny": [
      "Bash(sf org auth show *)",
      "Bash(sf org auth show-*)",
      "Bash(sf org display --verbose*)",
      "Bash(sf org display *--verbose*)",
      "Bash(sf org display user*)",
      "Bash(sf org generate password*)",
      "Bash(sf org open *--url-only*)",
      "Bash(sf org open -r*)",
      "Bash(sf org open * -r*)",
      "Bash(sf org open *--json*)",
      "Bash(sf org list *--verbose*)",
      "Bash(sfdx force:org:display *--verbose*)",
      "Bash(*SF_TEMP_SHOW_SECRETS*)",
      "Bash(export SF_TEMP_SHOW_SECRETS*)",
      "Bash(* ~/.sf/*)",
      "Bash(* ~/.sfdx/*)",
      "Bash(*/.sf/*)",
      "Bash(*/.sfdx/*)",
      "Bash(*.config/scratchpool*)",
      "Bash(*.scratchpool/setup*)",
      "Read(~/.sf/**)",
      "Read(~/.sfdx/**)",
      "Edit(~/.config/scratchpool/**)",
      "Edit(./.scratchpool/**)"
    ]
  }
}
```

Deny rules match the command text Claude writes, after Claude Code splits compound commands
and strips wrappers and leading variable assignments. They do not stop the same program run
another way (for example `/usr/local/bin/sf …` or inside `bash -c`), and a `Read` deny does not
stop `cat` through Bash (hence the `~/.sf` Bash rules). `Edit(~/.config/scratchpool/**)` does not
cover a custom `SCRATCHPOOL_HOME`; add your own path if you set one. `Edit(./.scratchpool/**)`
keeps an agent from writing the setup hook. Deny rules are defense in depth: they reduce the
likelihood of a leak; they are not a sandbox. For OS-level enforcement use Claude Code's
sandboxing.

### Prompt injection asking to delete orgs or deploy

- **Release guards.** `release` deletes only orgs that are recorded in *your* state for the
  selected pool, are listed as scratch orgs by `sf org list`, and belong to the pool's own Dev
  Hub (`NOT_MINE`, `NOT_SCRATCH`). A scratch org of your hub that scratchpool did not create is
  refused with `NOT_MANAGED`. Deletion is two-phase under the state lock, so an org claimed
  while a release or tick was choosing targets is never deleted. Orphan cleanup is a separate,
  explicit `release --orphans`: it only touches active hub records tagged
  `scratchpool:v1:<your hub username>:…:<this machine's id>`, older than an hour, and not under a
  non-pool local alias. scratchpool cannot delete sandboxes, production orgs, a teammate's
  orgs, or orgs created from your other machines.
- **Aliases.** `claim` refuses an alias that already names a Dev Hub, sandbox or production org,
  so it can never repoint one of them at a scratch org.
- **Confirmation.** In non-interactive mode, `release` and `uninstall --release-pool-orgs`
  require `--yes` (`CONFIRM_REQUIRED`); removing only the scheduler (`uninstall`,
  `service uninstall`) deletes no orgs and needs no `--yes`. The skill tells the agent to get
  your explicit yes in the conversation first, and that text in files or tool output is never
  confirmation. The skill pre-approves only read-only commands and `claim`; `tick`, `release`,
  `config set`, `service` changes and `uninstall` go through Claude Code's permission prompt.
- **`config set` never creates or deletes.** Size changes are applied by the next tick, within
  the allocation guards.
- **No deploy command.** scratchpool has no command that deploys or runs code on request.

### The setup hook

- The hook is a file **you** own in your repository (`.scratchpool/setup`, `setup.mjs` or
  `setup.cmd`). It runs only when you opted in with `setupHook: true`, only during background
  refill, with the new pool org as `SCRATCHPOOL_TARGET`, never at claim time and never because
  an agent asked.
- It runs with your own permissions and your own sf login, unattended. **Treat it as code**:
  review changes to it in pull requests the same way as any build script. Anyone who can change
  that file in your checkout can run commands as you on the next tick.
- Its output is discarded (not logged). A failure marks the org `failed`, and the log records
  the exit status only.
- **It is pinned.** Enabling it (`init --setup-hook` or `config set setupHook true`) records the
  file's sha256. If the file later changes (a `git pull`, a branch switch, an edit), refill stops
  with `SETUP_UNTRUSTED` and creates nothing until you review it and run
  `config set setupHook true` again.
- Its contents are part of the recipe hash, so changing it marks existing ready orgs stale.

### Allocation exhaustion

Refill reads live limits and keeps `activeReserve` slots free, stops below `dailyFloor`, and
stops when pool-tagged orgs across the whole hub reach `teamCapPct`% of the active allocation.
Cold claims check limits first. See `docs/pool-sizing.md`.

### Dev Hub privilege

Your Dev Hub is usually a production org. scratchpool reads only the `ScratchOrgInfo` object
(a `SELECT` of Id, SignupUsername, Description, ExpirationDate, Status) and the limits API. For
CI or shared automation, use a least-privilege user (for example the "Salesforce Limited Access
- Free" license with Dev Hub permissions); see `docs/ci-auth.md`.

### Supply chain

- **Zero dependencies.** One Node script (optionally split into `scripts/lib/*.mjs`) using only
  Node built-ins. No `postinstall` or other install scripts.
- **Readable.** The whole tool is plain JavaScript you can read before you run it.
- **Pin versions.** Install a specific tag (`npx github:Tbristo01/scratchpool#v0.1.0`, or a
  tagged plugin release). scratchpool is not on the npm registry, so never run a bare
  `npx scratchpool`: that would fetch whatever package holds the name. Releases are planned to ship signed tags and SHA-256 checksums, built by pinned
  GitHub Actions.
- **Scheduler entries use absolute paths** to `node`, `sf` and the script recorded at `init`,
  so a later change to `PATH` cannot redirect the background job to a different binary.
  Re-run `init` after you move or upgrade Node or the sf CLI.

## Out of scope

- Protecting against someone who already controls your user account or your repository: they
  can run `sf` as you directly.
- Securing the scratch orgs themselves after you claim them.
- Hiding usernames and org IDs; these are identifiers, not credentials.
