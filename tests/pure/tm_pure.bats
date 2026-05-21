#!/usr/bin/env bats
#
# Pure-function unit tests for bin/tm. These functions have no IO, no
# global state beyond their args, and no external command calls — they
# are the safest layer to lock down with cheap assertions.
#
# Loaded via test_helper.bash, which strips the trailing `main "$@"`
# line from bin/tm and sources the rest, so every function defined in
# tm is callable here as a plain shell function.

setup() {
    load "$BATS_TEST_DIRNAME/../test_helper.bash"
    load_tm_functions
}

# ---- session_name: PREFIX + repo, no escaping ----

@test "session_name: typical repo" {
    run session_name foo
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-foo" ]
}

@test "session_name: dashes in repo are preserved literally" {
    run session_name a-b-c
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-a-b-c" ]
}

@test "session_name: empty repo yields bare prefix (documents current behavior)" {
    run session_name ""
    [ "$status" -eq 0 ]
    [ "$output" = "teammate-" ]
}

# ---- sid_file: /tmp/teammate-<repo>.sid path builder ----

@test "sid_file: typical repo" {
    run sid_file foo
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-foo.sid" ]
}

@test "sid_file: repo with dots passes through" {
    run sid_file my.repo
    [ "$status" -eq 0 ]
    [ "$output" = "/tmp/teammate-my.repo.sid" ]
}

@test "sid_file: matches the prefix used by session_name" {
    # Lock the invariant: sid_file and session_name share the
    # teammate-<repo> stem. Drift between them would silently break
    # spawn -> wait coordination.
    local sn sf
    sn=$(session_name foo)
    sf=$(sid_file foo)
    [ "$sf" = "/tmp/${sn}.sid" ]
}

# ---- fmt_age: seconds -> short relative age ----

@test "fmt_age: under 60 seconds shows seconds" {
    run fmt_age 0
    [ "$output" = "0s" ]
    run fmt_age 59
    [ "$output" = "59s" ]
}

@test "fmt_age: minute and hour boundaries" {
    run fmt_age 60
    [ "$output" = "1m" ]
    run fmt_age 3599
    [ "$output" = "59m" ]
    run fmt_age 3600
    [ "$output" = "1h" ]
}

@test "fmt_age: day boundary" {
    run fmt_age 86399
    [ "$output" = "23h" ]
    run fmt_age 86400
    [ "$output" = "1d" ]
}

# ---- teammate_launch_flags: claude flags shared by every teammate launch ----

@test "teammate_launch_flags: exact flag string for a trivial settings JSON" {
    # Locks the whole shape: --settings carrying the JSON single-quoted,
    # then exactly --disallowedTools AskUserQuestion and nothing else.
    run teammate_launch_flags '{}'
    [ "$status" -eq 0 ]
    [ "$output" = "--settings '{}' --disallowedTools AskUserQuestion" ]
}

@test "teammate_launch_flags: settings JSON passes through verbatim, single-quoted" {
    # The real caller hands in the claudeMdExcludes JSON, whose embedded
    # double quotes must survive into the launch command untouched.
    local json='{"claudeMdExcludes":["/repo/CLAUDE.md","/repo/CLAUDE.local.md"]}'
    run teammate_launch_flags "$json"
    [ "$status" -eq 0 ]
    [ "$output" = "--settings '$json' --disallowedTools AskUserQuestion" ]
}

@test "teammate_launch_flags: AskUserQuestion is the only tool disabled" {
    # The disable is intentionally scoped to one tool. If a second tool
    # were ever appended it would show as a comma/space-joined list.
    run teammate_launch_flags '{}'
    [ "$status" -eq 0 ]
    [[ "$output" == *"--disallowedTools AskUserQuestion" ]]
    [[ "$output" != *"--disallowedTools AskUserQuestion "* ]]
    [[ "$output" != *"AskUserQuestion,"* ]]
}
