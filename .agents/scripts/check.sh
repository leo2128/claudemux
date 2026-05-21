#!/usr/bin/env bash
# check.sh — structural self-check for the .agents/ knowledge base.
#
# Three checks:
#   1) Broken links. Every Markdown link whose target is a repo-root path
#      (starts with "/", e.g. /.agents/components/tm.md or
#      /plugins/claudemux/bin/tm) must resolve to a file or directory that
#      exists. A broken link FAILS the check (exit 1).
#   2) Orphan docs. Every .agents/**/*.md file should be reachable by
#      following /.agents/*.md links starting from root.md. An unreachable
#      doc is reported as a WARNING (it does not fail the check — a freshly
#      added doc may simply not be wired into the navigation yet).
#   3) Hazard dispositions. Every research snapshot must carry a
#      "## Hazard dispositions" section so a flagged hazard cannot be
#      silently dropped at a hand-off. A research doc without one FAILS the
#      check (exit 1). index.md is the archive's table of contents, not a
#      snapshot, so it is exempt. See
#      .agents/decisions/0009-research-hazard-dispositions.md.
#
# Run from anywhere inside the repo:
#   bash .agents/scripts/check.sh
#
# Portable bash: no associative arrays (macOS ships bash 3.2), no GNU-only
# flags. Works on macOS and Linux.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "check: not inside a git repo" >&2
    exit 1
}
cd "$repo_root"
[ -d .agents ] || {
    echo "check: .agents/ not found at repo root" >&2
    exit 1
}

# All Markdown files under .agents/, repo-relative, sorted.
md_files=$(find .agents -name '*.md' -type f | LC_ALL=C sort)

# Pull every repo-root link target — the "/..." inside a ](...) — out of a
# file. Fenced code blocks are stripped first so example link syntax inside
# ``` fences is not mistaken for a real link. Drops any #anchor. One target
# per line.
link_targets() {
    awk '/^[[:space:]]*```/ { infence = !infence; next } !infence { print }' "$1" 2>/dev/null \
        | grep -oE '\]\(/[^)]+\)' \
        | sed -E 's/^\]\((.*)\)$/\1/' \
        | sed -E 's/#.*$//' \
        || true
}

# --- Check 1: broken links -------------------------------------------------
broken=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    while IFS= read -r target; do
        [ -n "$target" ] || continue
        rel="${target#/}"
        if [ ! -e "$rel" ]; then
            broken="${broken}  ${f}  ->  ${target}"$'\n'
        fi
    done <<EOF
$(link_targets "$f")
EOF
done <<EOF
$md_files
EOF

# --- Check 2: orphan docs (reachability BFS from root.md) ------------------
# visited is a newline-delimited set, bracketed by newlines so a membership
# test is a glob match: case "$visited" in *$'\n'"$x"$'\n'*) ...
visited=$'\n'
frontier=".agents/root.md"
while [ -n "$frontier" ]; do
    next=""
    while IFS= read -r cur; do
        [ -n "$cur" ] || continue
        case "$visited" in
            *$'\n'"$cur"$'\n'*) continue ;;
        esac
        visited="${visited}${cur}"$'\n'
        while IFS= read -r target; do
            [ -n "$target" ] || continue
            t="${target#/}"
            case "$t" in
                .agents/*.md) [ -f "$t" ] && next="${next}${t}"$'\n' ;;
            esac
        done <<EOF
$(link_targets "$cur")
EOF
    done <<EOF
$frontier
EOF
    frontier="$next"
done

orphans=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$visited" in
        *$'\n'"$f"$'\n'*) ;;
        *) orphans="${orphans}  ${f}"$'\n' ;;
    esac
done <<EOF
$md_files
EOF

# --- Check 3: research docs carry a hazard-disposition section -------------
# Every snapshot under .agents/research/ must reconcile the hazards it raised
# to an explicit disposition. index.md is the table of contents, not a
# snapshot — exempt. The check is presence-only: it confirms the section
# exists, not that every hazard is listed (prose is not machine-checkable).
missing_disposition=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
        .agents/research/index.md) continue ;;
        .agents/research/*.md) ;;
        *) continue ;;
    esac
    if ! grep -qE '^## Hazard dispositions[[:space:]]*$' "$f"; then
        missing_disposition="${missing_disposition}  ${f}"$'\n'
    fi
done <<EOF
$md_files
EOF

# --- Report ----------------------------------------------------------------
status=0

if [ -n "$broken" ]; then
    echo "check: broken links" >&2
    printf '%s' "$broken" >&2
    status=1
fi

if [ -n "$missing_disposition" ]; then
    echo "check: research docs missing a '## Hazard dispositions' section" >&2
    printf '%s' "$missing_disposition" >&2
    status=1
fi

if [ -n "$orphans" ]; then
    echo "check: orphan docs (not reachable from root.md) — wire them into the navigation:" >&2
    printf '%s' "$orphans" >&2
fi

if [ "$status" -eq 0 ] && [ -z "$orphans" ]; then
    echo "agents: check passed ($(printf '%s\n' "$md_files" | grep -c . ) docs, all links resolve, research dispositions present)"
elif [ "$status" -eq 0 ]; then
    echo "agents: links + dispositions OK; see orphan warnings above"
fi

exit "$status"
