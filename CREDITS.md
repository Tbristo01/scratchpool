# Credits

scratchpool builds on ideas, findings and formats from the projects and documents below. This page says what we took from each one.

## No third-party code is included

scratchpool contains **no source code copied from any third-party project**. Every file under `skills/`, `scripts/`, `tests/` and `examples/` was written for this project and is licensed Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

How we checked (2026-10-01): we searched the repository for third-party copyright lines, SPDX headers and "adapted/copied/derived from" markers. The only match is the Code of Conduct, which is credited below. We also ran a 12-token overlap scan of our code and docs against the upstream files we studied:

- sfp `PoolFetchImpl.ts`
- sfdx-hardis `scratch/pool/*.ts` and `poolUtils.ts`
- all non-test `.ts` sources and the README of sf-cli-plugin-pool
- sfdx-core `scratchOrgCache.ts`, `scratchOrgInfoApi.ts` and `scratchOrgCreate.ts`
- sf-skills `dx-org-manage/SKILL.md`

The scan found only generic matches: `// ----` divider comments, `sf` CLI command lines, URLs and common JavaScript idioms. It found no copied logic.

## Prior art: scratch org pooling and org setup

| Project | License | What we drew on |
|---|---|---|
| [flxbl-io/sfp](https://github.com/flxbl-io/sfp) (archived) | MIT | The **scratch org pool concept**: pre-create orgs, then let a developer claim a ready one. It also showed us that a pool can live inside the Dev Hub's `ScratchOrgInfo` records (an allocation status plus an auth URL), as described in `PoolFetchImpl.ts`. We kept the idea but not the design: scratchpool's pool is local to each developer. |
| [dxatscale/sfpower-scratchorg-pool](https://github.com/dxatscale/sfpower-scratchorg-pool) (archived) | MIT | An earlier form of the same pooling idea. Background reading only. |
| [SFDO-Tooling/CumulusCI](https://github.com/SFDO-Tooling/CumulusCI) | BSD-3-Clause | **Named org definitions and repeatable setup flows.** This is the model behind scratchpool's per-flavor scratch definitions and its `.scratchpool/setup` hook. Its docs also helped confirm the per-edition allocation numbers. |
| [hardisgroupcom/sfdx-hardis](https://github.com/hardisgroupcom/sfdx-hardis) | AGPL-3.0 | **Scratch org pools** (`hardis:scratch:pool:*`). These showed us what refilling and resetting a pool involves, and that a shared pool needs outside storage plus a CI job. We read it as prior art only. Because of the AGPL, we kept its code entirely out of this repository. |
| [navikt/sf-cli-plugin-pool](https://github.com/navikt/sf-cli-plugin-pool) | MIT | A **pool built as an sf CLI plugin**, with a `ScratchOrgInfo` field schema. We plan to align with that schema in the future team-pool adapter rather than invent a new one (see [docs/design-rationale.md](docs/design-rationale.md)). |

## Salesforce tooling we build on or defer to

| Project | License | What we drew on |
|---|---|---|
| [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) | Apache-2.0 | Salesforce's **official agent skills**. [`dx-org-manage`](https://github.com/forcedotcom/sf-skills/blob/main/skills/dx-org-manage/SKILL.md) already creates single scratch orgs through an agent, and [`dx-org-shape-manage`](https://github.com/forcedotcom/sf-skills/tree/main/skills/dx-org-shape-manage) handles org shapes. scratchpool positions itself as a **pool on top of that work, not a replacement**. It hands single-org work to sf-skills, and it plans to propose pooling upstream (see the README). |
| [salesforcecli/mcp](https://github.com/salesforcecli/mcp) | Apache-2.0 | The **Salesforce DX MCP server**. It showed us which org operations Salesforce already exposes to agents (its non-GA `create_scratch_org` is one). It also showed that its `--orgs` allowlist works poorly for a pool whose orgs change constantly. That is why scratchpool calls the `sf` CLI directly and is designed to work alongside the MCP server. |
| [forcedotcom/sfdx-core](https://github.com/forcedotcom/sfdx-core) | Apache-2.0 | We read the source, which is how we learned that **async resume is a per-machine cache**. `sf org resume scratch` reads the cache from [`src/org/scratchOrgCache.ts`](https://github.com/forcedotcom/sfdx-core/blob/main/src/org/scratchOrgCache.ts) (`scratch-create-cache.json`, a 1-day TTL). On a cache miss it throws `CacheMissError`, from [`src/org/scratchOrgCreate.ts`](https://github.com/forcedotcom/sfdx-core/blob/main/src/org/scratchOrgCreate.ts). That same file also deploys settings from the local machine (`deploySettings`). Web-login hubs log into the new org with the single-use `ScratchOrgInfo.AuthCode`, in [`src/org/scratchOrgInfoApi.ts`](https://github.com/forcedotcom/sfdx-core/blob/main/src/org/scratchOrgInfoApi.ts). Together these showed that queuing job IDs is not a pool. That is why scratchpool fully creates and logs into each org in the background before it counts as ready. See [docs/design-rationale.md](docs/design-rationale.md). |
| [forcedotcom/cli](https://github.com/forcedotcom/cli) issues | Apache-2.0 (repo) | These issues shaped our guards and workarounds:<br>- [#3515](https://github.com/forcedotcom/cli/issues/3515): C-1016 on External Client App + JWT hubs. Workaround in `docs/ci-auth.md`.<br>- [#3658](https://github.com/forcedotcom/cli/issues/3658): removal of `SF_TEMP_SHOW_SECRETS`.<br>- [#3560](https://github.com/forcedotcom/cli/issues/3560): credential redaction and the agent deny-list rationale.<br>- [#1817](https://github.com/forcedotcom/cli/issues/1817): `DeployingSettingsTimeout` retries.<br>- [#1155](https://github.com/forcedotcom/cli/issues/1155): CLI-deleted orgs can stay Active, which needs orphan hygiene.<br>- [#632](https://github.com/forcedotcom/cli/issues/632): orgs created after a timeout with no alias. |

## Documentation and specifications

| Source | What we drew on |
|---|---|
| Salesforce DX Developer Guide: [Supported Scratch Org Editions and Allocations](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs-editions-and-allocations.html) | The active and daily allocation limits per Dev Hub edition. These set scratchpool's reserve, daily floor and `teamCapPct` defaults. |
| Salesforce DX Developer Guide: [Scratch Org Snapshots](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-snapshots-intro.html), and the blog post [Optimize Your Developer Experience with Scratch Org Shapes and Snapshots](https://developer.salesforce.com/blogs/2024/08/optimize-your-developer-experience-with-scratch-org-shapes-and-snapshots) | How snapshots work. This is the basis of the `snapshot:<name>` flavor (see `docs/snapshots.md`). |
| [Agent Skills specification](https://agentskills.io/specification) ([agentskills/agentskills](https://github.com/agentskills/agentskills), Apache-2.0) | The `SKILL.md` format and frontmatter used by `skills/scratchpool/`. |
| Claude Code docs: [Plugins](https://code.claude.com/docs/en/plugins), [Skills](https://code.claude.com/docs/en/skills), [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) | The layout of `.claude-plugin/plugin.json` and `marketplace.json`, and the install paths. |
| [asciicast v2 file format](https://docs.asciinema.org/manual/asciicast/v2/) ([asciinema](https://github.com/asciinema/asciinema)) | The demo file format written by `scripts/record-demo.py`. We implemented it from the published format description, not from asciinema's code, which is GPL-3.0. |
| [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is adapted and condensed from it. The attribution is in that file. |
| [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) | The project license ([LICENSE](LICENSE)) and the [NOTICE](NOTICE) convention. |

## Trademarks

Salesforce, Dev Hub, Salesforce DX and related marks are trademarks of Salesforce, Inc. Claude is a trademark of Anthropic, PBC. scratchpool is an independent open-source project. It is not affiliated with, sponsored by, or endorsed by Salesforce or Anthropic. Every project listed here belongs to its own authors. Being listed here does not mean they endorse scratchpool.

If we missed a credit or got one wrong, please [open an issue](https://github.com/Tbristo01/scratchpool/issues).
