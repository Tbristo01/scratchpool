# Security policy

## Reporting a vulnerability

Please report security problems privately through **GitHub private vulnerability reporting**:
[Report a vulnerability](https://github.com/Tbristo01/scratchpool/security/advisories/new) (repository **Security** tab, then **Report a vulnerability**).
Reports go to the repository owner. Do not open a public issue, discussion or pull request for a suspected vulnerability.

Please include the scratchpool version, `sf --version`, your OS, and the steps to reproduce.
**Never include real tokens, auth URLs or org credentials** in a report; redacted placeholders are enough.

What to expect, on a best-effort basis from a single maintainer:
- acknowledgement within 7 days;
- an assessment and a fix plan within 30 days for confirmed issues;
- a GitHub Security Advisory and a patched release, with credit if you want it.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Security model in brief

The full model is in [docs/security.md](docs/security.md). In short:

- **Fully local.** scratchpool has no server, database, queue or telemetry. Its only remote endpoint is Salesforce, reached through your own `sf` CLI.
- **Your credentials, your orgs.** Pool orgs are created by your own Dev Hub auth on your own machine. scratchpool stores the Dev Hub alias, never a token, and never shares or hands off credentials.
- **Secrets never reach output.** `sf` is spawned with `--json` and argument arrays (no shell strings). Output fields are copied from an allowlist; access tokens, refresh tokens, auth URLs, frontdoor URLs, passwords and `authFields` are never emitted. Every message passed to output or logs is scrubbed. scratchpool refuses to run if `SF_TEMP_SHOW_SECRETS` is set.
- **Scoped deletes.** `release` only deletes orgs recorded in your own state for the selected pool and created by that pool's Dev Hub.
- **Supply chain.** Zero runtime dependencies, no install scripts. Releases are approval-gated and attach a skill zip, `SHA256SUMS` and a build provenance attestation (`gh attestation verify scratchpool-skill-<v>.zip --repo Tbristo01/scratchpool`). Repository controls are listed in [docs/repository-controls.md](docs/repository-controls.md).

## In scope

- Any path by which a token, auth URL or password reaches stdout, stderr, the log or an AI agent's context.
- Deleting or modifying an org that scratchpool did not create for you.
- Command injection through aliases, pool names, paths or config values.
- Unsafe file permissions or symlink handling in `SCRATCHPOOL_HOME`, or scheduler entries that run something other than scratchpool.

## Out of scope

- Vulnerabilities in the Salesforce CLI, Salesforce itself or Node.js (report those upstream).
- Anything that requires an attacker to already control your user account or your `sf` auth files.
- The contents of your own setup hook, which runs with your permissions by design.
