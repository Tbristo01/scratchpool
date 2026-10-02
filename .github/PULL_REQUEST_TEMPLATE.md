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
