# Shared test helpers for the claudemux bats suite.
#
# After stage 3c retired the bash `bin/tm`, the only bats coverage left is
# the release-tooling integration test in `tests/cli/`. This helper just
# exposes the repo-root path it needs.

# Resolve repo root from this helper's own path so tests can `load` it
# from any depth under tests/.
TESTS_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
