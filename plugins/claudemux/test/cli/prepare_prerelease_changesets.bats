#!/usr/bin/env bats

setup() {
  load "$BATS_TEST_DIRNAME/../test_helper.bash"
  SCRIPT="$PLUGIN_ROOT/scripts/prepare-prerelease-changesets.mjs"
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/.changeset"
}

teardown() {
  rm -rf "$WORK"
}

write_pre_json() {
  local changesets_json="$1"
  printf '{\n  "mode": "pre",\n  "tag": "beta",\n  "initialVersions": {\n    "claudemux": "1.0.0-beta.3"\n  },\n  "changesets": %s\n}\n' "$changesets_json" > "$WORK/.changeset/pre.json"
}

read_pre_changesets() {
  node -e 'const fs = require("fs"); const pre = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(pre.changesets.join(","));' "$WORK/.changeset/pre.json"
}

prepare_changesets() {
  (cd "$WORK" && node "$SCRIPT" "$@")
}

@test "prepare-prerelease-changesets: reopens newly added fragments that were marked consumed" {
  write_pre_json '["old-fix","new-fix"]'

  run prepare_changesets plugins/claudemux/.changeset/new-fix.md

  [ "$status" -eq 0 ]
  [ "$(read_pre_changesets)" = "old-fix" ]
}

@test "prepare-prerelease-changesets: leaves historical prerelease state unchanged" {
  write_pre_json '["old-fix"]'
  before="$(cat "$WORK/.changeset/pre.json")"

  run prepare_changesets plugins/claudemux/.changeset/new-fix.md

  [ "$status" -eq 0 ]
  [ "$(cat "$WORK/.changeset/pre.json")" = "$before" ]
}
