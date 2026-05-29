# Shared helpers for the claudemux bats suite (hook + release-tooling
# regressions under cli/).
#
# Resolve the plugin root from this helper's own path so each test can reach
# the plugin's hooks/ and scripts/ without hard-coding a tree depth.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
