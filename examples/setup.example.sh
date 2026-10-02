#!/usr/bin/env bash
# Example scratchpool setup hook.
#
# Copy to <project>/.scratchpool/setup, make it executable (chmod +x), and enable it with
#   scratchpool init --setup-hook        (or: scratchpool config set setupHook true)
#
# When it runs:
#   - Only in the background, right after a pool org is created by `scratchpool tick`.
#   - Never at claim time, and never because an AI agent asked for it.
#   - cwd is the project root. SCRATCHPOOL_TARGET is the new pool org's alias.
#   - A non-zero exit marks the org `failed` (it is then deleted and replaced).
#   - Timeout: 30 minutes.
#
# This file is yours and runs with your own sf login. Review every change to it like code:
# it runs unattended on your machine. Its contents are part of the pool's recipe hash, so
# editing it marks existing ready orgs as stale.
#
# On Windows use .scratchpool/setup.cmd, or .scratchpool/setup.mjs (run with Node) anywhere.

set -euo pipefail

target="${SCRATCHPOOL_TARGET:?SCRATCHPOOL_TARGET is not set; this hook is run by scratchpool}"

# Keep output free of secrets: --json output is not printed, and nothing here echoes URLs.
quiet() { "$@" --json >/dev/null; }

echo "scratchpool setup: preparing ${target}"

# 1. Install package dependencies (edit IDs / versions to match your project).
# quiet sf package install --package "MyDependency@1.2.0-1" --target-org "$target" \
#   --wait 30 --no-prompt --security-type AdminsOnly

# 2. Deploy the project's source.
quiet sf project deploy start --target-org "$target" --wait 30

# 3. Assign permission sets.
# quiet sf org assign permset --name My_App_Admin --target-org "$target"

# 4. Load sample data.
# quiet sf data import tree --plan data/sample-data-plan.json --target-org "$target"

# 5. Run an anonymous Apex setup script.
# quiet sf apex run --file scripts/apex/setup.apex --target-org "$target"

echo "scratchpool setup: ${target} ready"
