# Governance

scratchpool is a small, single-maintainer open source project. This document says who decides what, and how that can change.

## Model

scratchpool follows a benevolent-dictator-for-life (BDFL) model. The maintainer, [@Tbristo01](https://github.com/Tbristo01), has final say on scope, design, releases and who gets write access. With one maintainer this is simply honest: the same person reviews, merges and releases, and the [repository controls](docs/repository-controls.md) (required checks, protected tags, an approval-gated release environment, provenance attestations) are what keep that person honest.

## How decisions are made

- **The contract is [docs/SPEC.md](docs/SPEC.md).** A change in behaviour is a change to the spec, proposed in the same PR, with the reason.
- **Small fixes** go straight to a pull request.
- **Anything larger** (a new command, a config key, a change to what `sf` commands may run, a new install path) starts as an issue so the trade-off is discussed before code is written.
- **Scope** is guided by the roadmap and the kill criteria in [docs/design-rationale.md](docs/design-rationale.md). Proposals that turn scratchpool into a hosted or shared service, add runtime dependencies, or widen what it can delete are likely to be declined.
- The maintainer decides, explains the decision in the issue or PR, and records user-visible outcomes in [CHANGELOG.md](CHANGELOG.md).

## Becoming a maintainer

Write access is earned through sustained, high-quality contributions: several merged PRs, useful reviews of other people's work, and good judgement on the security-sensitive paths listed in [.github/CODEOWNERS](.github/CODEOWNERS). The maintainer invites new maintainers; you can also ask in an issue.

When a second maintainer joins:

1. They are added to CODEOWNERS for the areas they own.
2. Branch protection moves to at least one required approving review, with code-owner review required, so no one merges their own change unreviewed.
3. They are added as a required reviewer on the `release` environment.
4. This document is updated to describe how the maintainers reach decisions together.

A maintainer who is inactive for six months may be moved to emeritus status, and their access removed, after being asked.

## Security reports

Security problems never go through public issues or PRs:

1. The reporter uses GitHub private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).
2. The maintainer acknowledges within 7 days and assesses within 30 days, working in a private security advisory (with a temporary private fork if a fix needs one).
3. The fix is merged through the normal PR flow, released by the [release procedure](RELEASING.md), and the advisory is published with credit if the reporter wants it.

## Code of conduct and license

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under the [Apache License 2.0](LICENSE).
