# Install, prerequisites and uninstall

Every install path runs the same zero-dependency Node script. Only the global npm install puts a `scratchpool` command on your PATH. The agent paths run the script from the installed skill folder.

## Prerequisites

- **Salesforce CLI.** [`sf`](https://developer.salesforce.com/tools/salesforcecli) 2.147.7 or later. That version is needed for the scratch org signup variables in [ci-auth.md](ci-auth.md). Older versions still run, with an `SF_OLD` warning.
- **Node.js** 20 or later.
- **A Dev Hub you have authorised in `sf`:** `sf org login web --set-default-dev-hub --alias my-devhub`.
  - To get one, [enable Dev Hub](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-setup-enable-devhub.html) in Setup on a production or Developer Edition org. Once enabled, it cannot be turned off.
  - A Developer Edition Dev Hub allows 3 active and 6 daily scratch orgs. See [pool-sizing.md](pool-sizing.md).
- **A Salesforce DX project:** a project with `sfdx-project.json`, plus a scratch org definition (default `config/project-scratch-def.json`) or a [snapshot](snapshots.md).

## Claude Code (plugin)

In a Claude Code session:

```text
/plugin marketplace add Tbristo01/scratchpool
/plugin install scratchpool@scratchpool
```

Or from a shell: `claude plugin marketplace add Tbristo01/scratchpool && claude plugin install scratchpool@scratchpool`.

## Codex, Cursor, Copilot, Gemini CLI and other agents

Use the [Agent Skills](https://github.com/vercel-labs/skills) CLI:

```sh
npx skills add Tbristo01/scratchpool
```

- **Inside an agent,** this installs into `.agents/skills/` without prompting and links the skill for the agent it detects.
- **In a normal terminal,** it asks for the scope and agents. Pass `-y --agent <name>` to skip the prompts, or `-g` for a user-level install.
- **Side effects:** it writes a `skills-lock.json` in the project and sends the skills CLI's own install telemetry event. scratchpool itself sends none.

## Plain CLI

scratchpool is not on the npm registry. Install it straight from GitHub:

```sh
npm install -g github:Tbristo01/scratchpool          # puts `scratchpool` on your PATH
npx -y github:Tbristo01/scratchpool --help           # or run it without installing
npx -y github:Tbristo01/scratchpool#v0.1.0 --help    # pinned to a release
```

Or clone it, and use `node scratchpool/skills/scratchpool/scripts/scratchpool.mjs` wherever the docs say `scratchpool`:

```sh
git clone https://github.com/Tbristo01/scratchpool
node scratchpool/skills/scratchpool/scripts/scratchpool.mjs --help
```

In a terminal, `--help` and `--version` print plain text. When stdout is not a terminal (a pipe, CI or an agent), every command prints one JSON object instead, `--help` and `--version` included. See [SPEC.md](SPEC.md).

## claude.ai

1. Download `scratchpool-skill-<version>.zip` from the [latest release](https://github.com/Tbristo01/scratchpool/releases/latest).
2. Check it against `SHA256SUMS`.
3. Upload it as a custom skill under Settings > Capabilities.

## What `init` touches

`init` writes only to two places:
- `<SCRATCHPOOL_HOME>` (config, state, logs);
- the per-user scheduler entry: a LaunchAgent, a systemd `--user` timer or a scheduled task.

It never writes into your project. `claim` sets the default org with `sf config set target-org`, which `sf` stores in the project's `.sf/` folder.

## Uninstall

Remove the scheduler entry before you remove the code, or it keeps running `tick`:

```sh
scratchpool uninstall                      # remove the scheduler entry; pool orgs stay until they expire
scratchpool uninstall --release-pool-orgs  # also delete the unclaimed pool orgs (claimed orgs are kept)
```

Then remove whichever install you used:

```sh
claude plugin uninstall scratchpool@scratchpool && claude plugin marketplace remove scratchpool
npx skills remove scratchpool              # add -g if you installed with -g
npm uninstall -g scratchpool
```

Config, state and logs stay in `<SCRATCHPOOL_HOME>`: `~/.config/scratchpool`, or `%APPDATA%\scratchpool` on Windows. Delete that folder to remove them. For details, see [background-service.md](background-service.md#uninstalling).
