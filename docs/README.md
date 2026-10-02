# scratchpool docs

Start with the [project README](../README.md) for the quick start.

## Using scratchpool

| Doc | Read it when |
|---|---|
| [Install](install.md) | Installing for Claude Code, other agents, the plain CLI or claude.ai; prerequisites; uninstalling |
| [Pool sizing](pool-sizing.md) | Choosing `size` and `durationDays` for your Dev Hub's allocations, or sharing a hub with a team |
| [Snapshots](snapshots.md) | Building pool orgs from a scratch org snapshot instead of a definition file |
| [Background service](background-service.md) | Checking or fixing the launchd, systemd `--user`, cron or Task Scheduler entry; file locations; logs |
| [CI auth](ci-auth.md) | Running scratchpool in a CI job (optional) |
| [Troubleshooting](../skills/scratchpool/references/troubleshooting.md) | An error code or warning you don't recognise |

## Reference

| Doc | What it covers |
|---|---|
| [SPEC](SPEC.md) | The implementation contract: commands, `scratchpool/v1` JSON output, exit codes, state files, the `sf` command allowlist |
| [Security model](security.md) | What scratchpool can and cannot touch, secret handling, and the recommended [Claude Code deny rules](../examples/settings.deny.json) |
| [Benchmarks](benchmarks.md) | Measured warm claim versus cold create, with the setup used for each run |
| [Demo](demo/) | The real terminal recording (`scratchpool-demo.cast`) and the animated SVG in the README |

To regenerate the demo SVG after re-recording:

```sh
python3 scripts/cast-to-svg.py docs/demo/scratchpool-demo.cast docs/demo/scratchpool-demo.svg
python3 scripts/cast-to-svg.py docs/demo/scratchpool-demo.cast --text   # check the final screen as text
```

## Design rationale

[design-rationale.md](design-rationale.md) explains v0.1's scope, positioning and key decisions, with the platform evidence and sources behind them, the alternatives that were rejected, and what is still unverified.

## Project

[CHANGELOG](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md) · [Code of Conduct](../CODE_OF_CONDUCT.md) · [Security policy](../SECURITY.md) · [License](../LICENSE)
