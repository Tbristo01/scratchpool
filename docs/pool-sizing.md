# Pool sizing

A warm pool trades Dev Hub allocation for speed. Every idle org in the pool holds one active
scratch org slot, and every refill uses one daily create. This page helps you pick a `size`
that is fast enough without starving you or your teammates.

The pool is per developer and lives on your machine: it uses **your** Dev Hub alias, and the
orgs it creates count against that hub's allocation, the same as orgs you create by hand.

## Dev Hub allocations

From Salesforce's [editions and allocations table](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs-editions-and-allocations.html):

| Dev Hub edition | Active scratch orgs | Daily creates (rolling 24 h) |
|---|---|---|
| Developer Edition / trial | 3 | 6 |
| Enterprise Edition | 40 | 80 |
| Unlimited / Performance Edition | 100 | 200 |

Your contract may differ. scratchpool always reads the live numbers with
`sf org list limits -o <hub> --json` (`ActiveScratchOrgs`, `DailyScratchOrgs`) and shows them
in `scratchpool status`.

On Developer Edition hubs the daily number may be shared with package version creation
("up to six scratch orgs and package versions per day"). This is not confirmed; leave
headroom if you also build package versions.

## The burn formula

With no claims, a pool of `N` orgs that each live `D` days recycles about

```
daily creates used  ≈  N / D            (per developer, idle pool)
active slots held   =  N                (per developer, always)
```

Each claim adds one more create (the refill), so a developer who claims `C` orgs a day uses
about `N / D + C` daily creates.

A pool org is recycled when it has less than `claimMinLifeHours` (default 24) of life left, so
its useful life is roughly `D − 1` days. Use `D − 1` instead of `D` for a tighter estimate.

Worked examples:

| Hub | Pool | Duration | Idle burn | Active slots held |
|---|---|---|---|---|
| Developer Edition | 1 org | 3 days | ~0.33 of 6 daily | 1 of 3 |
| Enterprise, 10 developers | 2 orgs each | 3 days | ~6.7 of 80 daily | 20 of 40 |
| Enterprise, 10 developers | 1 org each | 7 days | ~1.4 of 80 daily | 10 of 40 |

The second row is why the team cap exists: the daily cost is small, but half the team's
active slots sit idle.

## Built-in guards

`scratchpool tick` only creates orgs when all of these hold (see `docs/SPEC.md`):

| Setting | Default | Effect |
|---|---|---|
| `activeReserve` | 1 | Always leave this many active slots free for hand-made orgs. |
| `dailyFloor` | 2 | Do not refill when fewer daily creates than this remain. |
| `teamCapPct` | 25 | Do not refill when pool-tagged orgs from everyone on this hub use this % of the active allocation. |
| `claimMinLifeHours` | 24 | Never hand out an org with less life left; recycle it instead. |
| `durationDays` | 3 on DE hubs (daily max ≤ 6), else 7 | Lifetime of pool orgs. |
| `coldDurationDays` | 1 | Lifetime of an org created on demand when the pool is empty. |

The team cap works because every pool org is tagged on the hub with
`scratchpool:v1:<hubUsername>:<defHash>` in `ScratchOrgInfo.Description`, so each developer's
tick can count everyone's pool orgs without any shared server.

## Recommended size

| Dev Hub edition | Recommended `size` | Notes |
|---|---|---|
| Developer Edition / trial | **1** | 3 active slots: one warm, one claimed, one spare. Do not go higher. |
| Enterprise | **1**, at most 2 | Keep the team total under 25% of 40 (10 orgs). |
| Unlimited / Performance | **1–3** | Keep the team total under 25% of 100 (25 orgs). |

Raise the size only if `claim` keeps returning `POOL_EMPTY` because you claim faster than the
pool refills (a refill takes as long as a cold create plus your setup hook). `size 0` keeps
nothing warm but leaves the configuration and scheduler in place.

## Changing the size

```
scratchpool config set size 2     # filled on the next tick
scratchpool config set size 0     # surplus ready orgs released on the next tick
scratchpool tick                  # apply now instead of waiting
scratchpool pause                 # stop refilling without changing size
```

`config set` never creates or deletes anything itself; the next tick reconciles. Lowering the
size releases the youngest surplus ready orgs, never claimed ones.
