# Releasing scratchpool

Releases are cut from a green `main` by pushing an annotated `vX.Y.Z` tag. The [release workflow](.github/workflows/release.yml) runs the tests, then waits in the `release` environment for the maintainer's approval before it builds and publishes anything. The controls behind each step are listed in [docs/repository-controls.md](docs/repository-controls.md).

## 1. Start from a green main

```sh
git switch main && git pull --ff-only
gh run list --branch main --workflow ci --limit 1   # the latest main run must be "completed success"
npm test
```

## 2. Write the CHANGELOG section

In [CHANGELOG.md](CHANGELOG.md), rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and update the link definitions at the bottom of the file (`[Unreleased]` compares from `vX.Y.Z`; add a `[X.Y.Z]` line).

The release workflow publishes the body of the `## [X.Y.Z]` section as the GitHub Release notes, so write it for users. A tag without a matching, non-empty section fails the release.

## 3. Bump the version in all three places

| File | Field |
|---|---|
| `.claude-plugin/plugin.json` | `version` (the source of truth) |
| `package.json` | `version` |
| `skills/scratchpool/SKILL.md` | `metadata.version` in the frontmatter |

CI (`validate manifests`) checks that all three agree on every PR; the release workflow checks them against the tag.

## 4. Open a PR and merge it

```sh
git switch -c release/vX.Y.Z
git commit -am "release: vX.Y.Z"
git push -u origin release/vX.Y.Z
gh pr create --title "release: vX.Y.Z" --body "CHANGELOG section and version bump for vX.Y.Z."
gh pr checks --watch
gh pr merge --squash --delete-branch
```

## 5. Tag the merge commit

```sh
git switch main && git pull --ff-only
git tag -a vX.Y.Z -m "scratchpool vX.Y.Z"
git push origin vX.Y.Z
```

Use an annotated tag (`-a`). Once pushed, a `v*` tag is protected by the tag ruleset: it cannot be moved or deleted except by a repository admin bypassing the ruleset, and by policy we never do that for a published release. Check the commit before pushing.

## 6. Approve the release environment

The `test` job runs straight away. The `release` job then waits for review in the `release` environment:

```sh
gh run list --workflow release --limit 1
gh run view <run-id>   # status "waiting"
```

Approve it from the run page (**Review deployments**, tick `release`, **Approve and deploy**). Only approve a run whose tag and commit you just pushed. Admins can bypass this approval; don't.

## 7. Verify the published release

```sh
gh release view vX.Y.Z                         # notes match the CHANGELOG section
gh release download vX.Y.Z --dir /tmp/sp-vX.Y.Z
cd /tmp/sp-vX.Y.Z
sha256sum -c SHA256SUMS                        # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify scratchpool-skill-X.Y.Z.zip --repo Tbristo01/scratchpool \
  --signer-workflow Tbristo01/scratchpool/.github/workflows/release.yml \
  --source-ref refs/tags/vX.Y.Z
unzip -l scratchpool-skill-X.Y.Z.zip | head    # root is scratchpool/SKILL.md, with LICENSE and NOTICE
```

With `--signer-workflow` and `--source-ref`, `gh attestation verify` checks that the zip's provenance was signed by this repository's `release.yml` running for the `vX.Y.Z` tag, so it was not built elsewhere or uploaded by hand. (With `--repo` alone it only checks that some workflow in this repository signed it.)

## If something goes wrong

- **The release job failed before `gh release create`.** Nothing was published. Fix the cause on `main` through a PR, then release the next patch version; the old tag stays (tags are immutable by policy).
- **A bad release was published.** Mark it as a pre-release or edit its notes to point at the fix, then cut a patch release. For a security problem, follow [SECURITY.md](SECURITY.md) and publish an advisory.
