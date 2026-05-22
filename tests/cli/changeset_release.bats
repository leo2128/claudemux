#!/usr/bin/env bats
#
# Integration tests for the release tooling — bin/changeset and bin/release.
#
# Each test runs in a throwaway git repo with a fake plugin manifest, so the
# scripts' real filesystem and git behavior is exercised end to end without
# touching this repository's own plugins.

setup() {
  load "$BATS_TEST_DIRNAME/../test_helper.bash"
  CHANGESET="$TESTS_REPO_ROOT/bin/changeset"
  RELEASE="$TESTS_REPO_ROOT/bin/release"

  WORK="$(mktemp -d)"
  cd "$WORK"
  git init -q
  mkdir -p plugins/demo/.claude-plugin
  printf '{\n  "name": "demo",\n  "version": "1.2.3"\n}\n' \
    > plugins/demo/.claude-plugin/plugin.json
}

teardown() {
  cd /
  rm -rf "$WORK"
}

manifest_version() {
  jq -r .version plugins/demo/.claude-plugin/plugin.json
}

# ---- bin/changeset --------------------------------------------------------

@test "changeset: creates a fragment carrying the level and the summary" {
  run "$CHANGESET" demo minor "add a thing"
  [ "$status" -eq 0 ]
  # The echoed path is repo-relative and under the plugin's .changeset dir.
  [[ "$output" == plugins/demo/.changeset/*.md ]]
  frag="$output"
  [ -f "$frag" ]
  [ "$(sed -n '1p' "$frag")" = "minor" ]
  [ "$(sed -n '3p' "$frag")" = "add a thing" ]
}

@test "changeset: two invocations create two distinct fragments" {
  run "$CHANGESET" demo patch "first"
  [ "$status" -eq 0 ]
  first="$output"
  run "$CHANGESET" demo patch "second"
  [ "$status" -eq 0 ]
  [ "$first" != "$output" ]
  [ "$(find plugins/demo/.changeset -name '*.md' | wc -l | tr -d ' ')" = "2" ]
}

@test "changeset: rejects an invalid level" {
  run "$CHANGESET" demo huge "x"
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid level"* ]]
}

@test "changeset: rejects an unknown plugin" {
  run "$CHANGESET" nope patch "x"
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown plugin"* ]]
}

@test "changeset: missing arguments print usage" {
  run "$CHANGESET"
  [ "$status" -ne 0 ]
  [[ "$output" == *"usage:"* ]]
}

# ---- bin/release ----------------------------------------------------------

@test "release: with no changesets, reports nothing to do and leaves the version" {
  run "$RELEASE" demo
  [ "$status" -eq 0 ]
  [[ "$output" == *"nothing to release"* ]]
  [ "$(manifest_version)" = "1.2.3" ]
}

@test "release: a single minor changeset bumps the minor version" {
  "$CHANGESET" demo minor "a feature" >/dev/null
  run "$RELEASE" demo
  [ "$status" -eq 0 ]
  [ "$(manifest_version)" = "1.3.0" ]
}

@test "release: a single patch changeset bumps the patch version" {
  "$CHANGESET" demo patch "a fix" >/dev/null
  run "$RELEASE" demo
  [ "$status" -eq 0 ]
  [ "$(manifest_version)" = "1.2.4" ]
}

@test "release: the highest level among the changesets wins" {
  "$CHANGESET" demo patch "a fix" >/dev/null
  "$CHANGESET" demo major "a break" >/dev/null
  "$CHANGESET" demo minor "a feature" >/dev/null
  run "$RELEASE" demo
  [ "$status" -eq 0 ]
  [ "$(manifest_version)" = "2.0.0" ]
}

@test "release: writes a CHANGELOG section and consumes the fragments" {
  "$CHANGESET" demo patch "a fix" >/dev/null
  run "$RELEASE" demo
  [ "$status" -eq 0 ]
  [ -f plugins/demo/CHANGELOG.md ]
  grep -q "## 1.2.4 — " plugins/demo/CHANGELOG.md
  grep -q -- "- (patch) a fix" plugins/demo/CHANGELOG.md
  # The .changeset directory is gone once its fragments are consumed.
  [ ! -d plugins/demo/.changeset ]
}

@test "release: prepends new sections newest-first" {
  "$CHANGESET" demo minor "first release" >/dev/null
  "$RELEASE" demo >/dev/null
  "$CHANGESET" demo minor "second release" >/dev/null
  "$RELEASE" demo >/dev/null
  newer=$(grep -n "## 1.4.0" plugins/demo/CHANGELOG.md | cut -d: -f1)
  older=$(grep -n "## 1.3.0" plugins/demo/CHANGELOG.md | cut -d: -f1)
  [ "$newer" -lt "$older" ]
}

@test "release: rejects a fragment with an invalid level line and writes nothing" {
  mkdir -p plugins/demo/.changeset
  printf 'banana\n\nbad\n' > plugins/demo/.changeset/bad.md
  run "$RELEASE" demo
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid level"* ]]
  # release validates every fragment before it edits anything.
  [ "$(manifest_version)" = "1.2.3" ]
  [ ! -f plugins/demo/CHANGELOG.md ]
}

@test "release: rejects a fragment with no summary" {
  mkdir -p plugins/demo/.changeset
  printf 'patch\n\n' > plugins/demo/.changeset/nosum.md
  run "$RELEASE" demo
  [ "$status" -ne 0 ]
  [[ "$output" == *"no summary"* ]]
}

@test "release: rejects an unknown plugin" {
  run "$RELEASE" nope
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown plugin"* ]]
}
