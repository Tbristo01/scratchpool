# Benchmarks

## Run 1 — 2026-10-02, smoke-sized project (not a real repo)

| Setting | Value |
|---|---|
| Dev Hub | Developer Edition (3 active / 6 daily) |
| sf CLI | 2.152.14 |
| Platform | macOS arm64 |
| Project | 5 Apex classes; `edition: Developer`, no features, no packages, no data |

| Path | What ran | Time |
|---|---|---|
| Cold | `sf org create scratch -y 1 --wait 30` | 12.2 s |
| Cold | `sf project deploy start` (5 classes) | 3.3 s |
| **Cold total** | | **15.5 s** |
| Pool fill (background) | create + setup hook | ~16 s after the tick |
| **Warm `claim`** | alias handoff + `target-org` (5 sf CLI calls) | **2.9 s** |

**Reading:** on a trivial project, the pool saves about 12.6 s per org. That is far below the project's real-repo bar, which requires saving at least 3 minutes ([design-rationale.md](design-rationale.md#5-evidence-so-far-and-the-bar-to-clear)). This run does **not** pass or fail the gate: it says nothing about real projects. The gate has to be measured on 2 real repos that have package installs, larger deploys, data loads, and features or settings in the def file.

**Live findings fixed in this run:**

- **`ScratchOrgInfo.Description` can't be filtered in SOQL** (`INVALID_FIELD`). The query now filters on `Status` only and matches the tag client-side. The stub now rejects that filter so tests catch any regression.

**Confirmed live:**

- The Description tag (`scratchpool:v1:<hubUser>:<defHash>:<machineId>`) is written to `ScratchOrgInfo`.
- The `ACTIVE_RESERVE` guard works.
- `release` works.
- No secrets appeared in output, state or logs.

**Follow-up:**

- **Claim takes 2.9 s, against a target of under 2 s.** The time is dominated by spawning sf 5 times, about 0.5 s each. Candidates to cut:
  - drop the `sf org list` re-verification on the warm path when state is fresh;
  - combine `alias set` and `alias unset` into one call.
