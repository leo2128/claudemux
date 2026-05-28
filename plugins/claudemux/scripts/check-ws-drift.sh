#!/usr/bin/env bash
# check-ws-drift.sh — compare the vendored `ws` version under
# `third_party/ws/` against the latest upstream release on npm.
#
# Why: `ws` is no longer in the npm tree, so `npm audit` and Dependabot
# do not cover it. This script is the manual mirror — run it before
# cutting a `claudemux` release (and after a GitHub Security Advisory
# fires for `websockets/ws`) so a CVE-fixing upstream bump does not sit
# vendored at an old version unnoticed.
#
# Exit codes:
#   0  vendored version matches the upstream `latest` dist-tag
#   1  the two diverge — re-run the vendor-update flow in UPSTREAM.md
#   2  the script could not fetch upstream metadata (offline, npm down)
#
# This is intentionally cheap and read-only: it does not auto-bump the
# vendored copy, because a vendor bump should be reviewed the same way
# any other runtime change is. The script does not run on every CI tick
# either — it needs network and `npm view`, which are not worth the
# slowdown on every push.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
vendored_pkg="$here/../third_party/ws/package.json"

if [[ ! -f "$vendored_pkg" ]]; then
    echo "check-ws-drift: vendored package.json not found at $vendored_pkg" >&2
    exit 2
fi

# Both `node -p` and `jq` are already required elsewhere in the repo;
# pick `node -p` so this script does not add a `jq` dependency that
# does not already exist on a contributor's machine.
vendored=$(node -p "require('$vendored_pkg').version")

if ! command -v npm >/dev/null 2>&1; then
    echo "check-ws-drift: npm not on PATH — cannot probe upstream" >&2
    exit 2
fi

# `npm view ws version` returns the `latest` dist-tag in one round trip.
# `--silent` keeps the stderr quiet so a clean run prints just the
# comparison.
if ! upstream=$(npm view ws version --silent 2>/dev/null); then
    echo "check-ws-drift: 'npm view ws version' failed (offline? rate-limited?)" >&2
    exit 2
fi

echo "vendored ws:   $vendored"
echo "upstream ws:   $upstream"

if [[ "$vendored" == "$upstream" ]]; then
    echo "check-ws-drift: in sync"
    exit 0
fi

echo "check-ws-drift: vendored ws is behind upstream — see" \
    "plugins/claudemux/third_party/ws/UPSTREAM.md §Updating" >&2
exit 1
