# Building pool orgs from a snapshot

A warm but empty scratch org only saves the signup time. The time that hurts is setup:
installing packages, deploying source and loading data. scratchpool removes that cost in one
of two ways:

- a **setup hook** (`init --setup-hook`, see `examples/setup.example.sh`) that runs on your
  machine while the pool refills in the background, or
- a **scratch org snapshot**: Salesforce copies a prepared org, so new pool orgs start already
  set up and your machine does no setup work at all.

This page covers snapshots. Scratch org snapshots are GA since Summer '24
([Salesforce docs](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-snapshots-intro.html)).

## 1. Create the snapshot (once, by hand)

Prepare one scratch org exactly as you want every pool org to start, then snapshot it with
the same Dev Hub your pool uses:

```bash
sf org create scratch -f config/project-scratch-def.json -a baseline -v devhub -y 7
# install packages, deploy source, load data into "baseline" ...
sf org create snapshot --source-org baseline --name MyAppBase -o devhub \
  --description "my-app baseline, 2026-10-01"
sf org get snapshot --snapshot MyAppBase -o devhub      # wait for Status: Active
```

(The `sf org create snapshot` command is in the sf CLI org plugin; check
`sf org create snapshot --help` for the flags in your CLI version.)

## 2. Point the pool at it

```bash
scratchpool init --hub devhub --snapshot MyAppBase --size 1
# or, for an existing pool:
scratchpool config set snapshot MyAppBase
```

- `--snapshot` replaces `--def`. Salesforce does not let `--snapshot`, `--edition` and
  `--source-org` be combined, and features and settings come from the snapshot, not a
  definition file.
- The pool's recipe hash (`defHash`) becomes `snapshot:<name>` (plus namespace, hub and setup
  hook), so switching the snapshot marks existing ready orgs as stale. `claim --any` still
  hands them out; `release --stale` removes them so the next tick builds fresh ones.
- You can still combine a snapshot with `--setup-hook` for small per-org steps (for example
  assigning a permission set to the new user).

## 3. Limits

Treat these as the working numbers and read the live values for your hub:

| Limit | Working number |
|---|---|
| Active snapshots per Dev Hub | 5 |
| Snapshots created per day | 5 |
| Snapshot lifetime | 90 days |

Sources disagree on the exact limits (Salesforce's August 2024 GA blog says 5 per day and 5
active). Check yours with `sf org list limits -o devhub --json` and look for
`ActiveOrgSnapshots` and `DailyOrgSnapshots` (if your hub reports them).

Because the active limit is small and shared by the whole team, agree on **one baseline
snapshot per project** rather than one per developer. Every developer's pool can use the same
snapshot name, as long as they use the same Dev Hub.

Other constraints from Salesforce:

- The same Dev Hub must create and consume the snapshot. A pool on a different hub cannot use it.
- You cannot snapshot a namespaced org, or an org that was itself created from a snapshot.
- Connected apps, named credentials and external credentials are not copied.
- Snapshot names are limited to 15 characters.
- Creating from a snapshot still uses one scratch org create from your daily allocation.

## 4. The 90-day refresh

A snapshot expires 90 days after creation, and it only reflects the source as of the day you
took it. Plan to refresh it at least every 60–80 days, and whenever your package versions or
baseline metadata change significantly:

1. Create a new baseline org and snapshot it under a **new name** (for example `MyAppBase1201`).
   Using a new name keeps the old snapshot working for everyone until they switch.
2. Each developer runs `scratchpool config set snapshot MyAppBase1201`. Their existing ready
   orgs become stale: `claim` skips them (unless `--any`), but they still count toward `size`,
   so tick does not build new-recipe orgs until they near expiry and are recycled (up to about
   `durationDays` later). Run `scratchpool release --stale` (it asks to confirm) to delete them
   now; the next tick then builds fresh orgs from the new snapshot.
3. Delete the old snapshot to free an active slot:
   `sf org delete snapshot --snapshot MyAppBase -o devhub`.

If a snapshot expires while still configured, background creates fail and entries show as
`failed` in `scratchpool status`, with the scrubbed reason in `<home>/logs/scratchpool.log`.
Refresh the snapshot and update the pool config.

scratchpool v0.1 does not create or refresh snapshots for you; a refresh helper is planned for
a later release.
