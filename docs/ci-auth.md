# Using scratchpool in CI (optional)

**CI is optional.** scratchpool's main path is the local pool: you run `scratchpool init` once
on your own laptop or workstation, and your OS scheduler keeps a warm org ready using your own
Dev Hub login. Nothing in that path needs CI, a server, or shared credentials.

This page is for teams that also want to call scratchpool from a CI job. In CI there is no
background scheduler and the runner is usually thrown away after each job, so a warm pool
does not survive between jobs. CI therefore almost always uses the **cold path**: `claim --cold`
creates an org on demand, the job uses it, and `release` deletes it at the end.

## 1. Authenticate the Dev Hub with JWT

Web login does not work on a headless runner. Use the JWT bearer flow with a connected app or
External Client App (ECA) that has your certificate, as described in Salesforce's
[JWT authorization guide](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-jwt-flow.html).

```bash
# server.key comes from a CI secret and is written to a temp file, never committed
sf org login jwt \
  --username "$SF_HUB_USERNAME" \
  --client-id "$SF_HUB_CLIENT_ID" \
  --jwt-key-file "$RUNNER_TEMP/server.key" \
  --alias devhub \
  --set-default-dev-hub
```

Use a dedicated integration user on the Dev Hub with the least privilege needed to create
scratch orgs (for example the "Salesforce Limited Access - Free" license with Dev Hub
permissions). Do not reuse a developer's personal login in CI.

## 2. Work around C-1016 on ECA + JWT hubs (cli#3515)

Hubs that authenticate with an External Client App over JWT can fail scratch org creation
with error **C-1016** ([forcedotcom/cli#3515](https://github.com/forcedotcom/cli/issues/3515),
open at the time of writing). The documented workaround is to make the new scratch org's
signup use the CLI's own connected app:

```bash
export SF_SCRATCH_SIGNUP_CONNECTED_APP=PlatformCLI
export SF_SCRATCH_SIGNUP_CALLBACK_URL=http://localhost:1717/OauthRedirect
```

- These variables need **sf CLI 2.147.7 or later**, which is also scratchpool's minimum
  supported version (older versions produce the `SF_OLD` warning).
- The callback URL above is the CLI's default local OAuth redirect. Check the issue thread for
  the value Salesforce currently recommends for your setup; it is not verified here.
- They only affect how the new org is signed up. scratchpool passes the environment through
  to `sf` unchanged and never reads or stores them.

## 3. A job that claims and releases

```bash
npx --yes github:Tbristo01/scratchpool#v0.1.0 init --hub devhub --size 0 --no-service --json
npx --yes github:Tbristo01/scratchpool#v0.1.0 claim "ci-$GITHUB_RUN_ID" --cold --yes --no-open --json > claim.json
# ... deploy and run tests against the alias "ci-$GITHUB_RUN_ID" ...
npx --yes github:Tbristo01/scratchpool#v0.1.0 release "ci-$GITHUB_RUN_ID" --yes --json   # in an always() step
```

Notes:

- `--no-service` skips installing a scheduler on the runner. `--size 0` keeps nothing warm, so
  `init`'s first tick creates nothing.
- Set `SCRATCHPOOL_HOME` to a path inside the workspace if the runner's home is read-only.
- `claim --cold` needs `--yes` when not run in an interactive terminal. It uses one daily create and `coldDurationDays` (default 1) of life. Release the
  org at the end so it does not hold an active slot for a day.
- Without `--json`, a non-TTY run still prints JSON, and `release` requires `--yes`.
- Pin a release tag (`#v0.1.0`) rather than the default branch. scratchpool is not published to
  the npm registry, so do not use `npx scratchpool`: that name could be registered by anyone.

## 4. Keeping secrets out of logs

- scratchpool never prints tokens, auth URLs or frontdoor links, and refuses to run when
  `SF_TEMP_SHOW_SECRETS` is set (`SECRETS_ENV`). Do not set that variable in CI.
- Do not run `sf org display --verbose` or `sf org auth show-*` in a job log.
- Store the JWT key and client ID only as CI secrets, and delete the key file at the end of
  the job.

## When a CI pool might make sense

A self-hosted, long-lived runner can keep a pool across jobs: run `init` with a size of 1 or 2
on that runner and let its own scheduler (or a cron step calling `scratchpool tick`) refill it.
That pool belongs to the CI integration user, not to any developer, and counts against the
same hub allocation, so size it with `docs/pool-sizing.md`.
