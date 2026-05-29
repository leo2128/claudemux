#!/usr/bin/env bats
#
# Regression tests for hooks/on-stop.sh last-turn extraction. The CI bats lane
# runs the plugin's test/cli/, alongside the release-tooling regression test.

setup() {
  load "$BATS_TEST_DIRNAME/../test_helper.bash"
  HOOK="$PLUGIN_ROOT/hooks/on-stop.sh"
  WORK="$(mktemp -d)"
}

teardown() {
  rm -f "/tmp/claude-idle/cmx-on-stop-${BATS_TEST_NUMBER}-"*
  rm -rf "$WORK"
}

write_transcript_with_task_tag() {
  local transcript="$1" tag="$2"
  printf '%s\n' \
    '{"type":"user","message":{"role":"user","content":"start the turn"}}' \
    '{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"assistant reply before task notification"}]}}' \
    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<$tag>background task finished</$tag>\"}}" \
    > "$transcript"
}

fire_stop_hook() {
  local sid="$1" transcript="$2"
  printf '{"session_id":"%s","transcript_path":"%s","hook_event_name":"Stop"}\n' "$sid" "$transcript" \
    | "$HOOK"
}

@test "on-stop: task notification family entries are skipped, not turn boundaries" {
  for tag in task-notification task-summary task-output; do
    sid="cmx-on-stop-${BATS_TEST_NUMBER}-${tag}"
    transcript="$WORK/$tag.jsonl"
    last_file="/tmp/claude-idle/$sid.last"
    rm -f "$last_file"

    write_transcript_with_task_tag "$transcript" "$tag"
    run fire_stop_hook "$sid" "$transcript"

    [ "$status" -eq 0 ]
    [ -f "$last_file" ]
    [ "$(cat "$last_file")" = "assistant reply before task notification" ]

    rm -f "$last_file" "/tmp/claude-idle/$sid"
  done
}
