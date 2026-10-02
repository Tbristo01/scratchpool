## What and why

<!-- One or two sentences. Link the issue: Fixes #123 -->

## How it was tested

<!-- Paste the `npm test` summary. Tests use the stub sf and SCRATCHPOOL_SERVICE_DRYRUN=1; never a real Dev Hub or scheduler. -->

## Checklist

- [ ] Behaviour matches `docs/SPEC.md` (or this PR updates the spec and explains why)
- [ ] No new runtime dependencies; Node >= 20 built-ins only
- [ ] `sf` is called only with `--json` and arg arrays, and only for commands in the SPEC section 4 allowlist
- [ ] No token, auth URL or secret can reach stdout, stderr or logs (output stays allowlisted and scrubbed)
- [ ] Tests added or updated; `npm test` passes locally
- [ ] `CHANGELOG.md` updated under **Unreleased** for user-visible changes
- [ ] `README.md` / `docs/` updated if commands, flags, config keys or install steps changed
- [ ] No email addresses or personal data added

## Security impact

<!-- Tick every box that applies and explain it under "What and why". An unticked list means "none of these". -->

- [ ] Touches `.github/workflows/`, workflow `permissions:`, CODEOWNERS or `dependabot.yml` (every new action pinned to a full commit SHA with a version comment, and on the Actions allowlist; job names of required checks unchanged)
- [ ] Adds or upgrades a dependency, dev tool or GitHub Action
- [ ] Adds or changes a destructive org operation (`release`, recycling, orphan reaping, anything that deletes a scratch org or `ScratchOrgInfo` record)
- [ ] Changes secret handling or the output allowlist (fields copied from `sf` JSON, scrubbing, logs, what an agent can see)
- [ ] Changes the scheduler entries, the setup hook trust check, or the skill's `allowed-tools`
