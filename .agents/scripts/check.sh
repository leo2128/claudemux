#!/usr/bin/env bash
# check.sh — structural self-check for the .agents/ knowledge base.
#
# Five checks:
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
#      .agents/decisions/research-hazard-dispositions.md.
#   4) Decisions index sync. Every .md under .agents/decisions/ (other than
#      README.md) must appear exactly once in the README.md index table, and
#      every index row must point at a real decision file. A row in the
#      table whose link target is missing, or a decision file missing from
#      the index, FAILS the check (exit 1). The decisions registry has no
#      sequence number after the rename, so README.md is the only browsable
#      registry — drift between the directory and the index would silently
#      hide records.
#   5) No stale NNNN ADR references. Decision records are addressed by
#      topic slug, not by 4-digit ID. A reference of the form
#      "decision NNNN" / "decisions NNNN" / "Decision NNNN" / "ADR NNNN"
#      anywhere in a tracked Markdown / shell / JS / TS file FAILS the
#      check (exit 1). The scan includes `.changeset/` fragments because
#      their summary line eventually lands in CHANGELOG.md and reaches
#      users; `dist/` is excluded because it is a build artifact. Source
#      comments and docs that still cite an old ADR by number can no
#      longer be resolved from the README, so they have to be rewritten
#      to a slug.
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

# --- Check 4: decisions/ ↔ README.md index sync ----------------------------
# README.md inside decisions/ is the only browsable registry of decisions, so
# its index table must match the directory contents exactly. The check is
# bidirectional: every file (other than README.md) must be linked from the
# index, and every link in the index must resolve to a real file.
decisions_dir=".agents/decisions"
decisions_index="${decisions_dir}/README.md"
on_disk=$(find "$decisions_dir" -maxdepth 1 -type f -name '*.md' \
    ! -name 'README.md' \
    | LC_ALL=C sort)

# Link targets in the index that point at a decision file.
indexed=$(grep -oE '\]\(/\.agents/decisions/[a-z0-9-]+\.md\)' "$decisions_index" 2>/dev/null \
    | sed -E 's|^\]\(/(\.agents/decisions/[a-z0-9-]+\.md)\)$|\1|' \
    | LC_ALL=C sort -u || true)

# A file present on disk but not linked from the index.
unindexed_files=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$indexed" in
        *"$f"*) ;;
        *) unindexed_files="${unindexed_files}  ${f}"$'\n' ;;
    esac
done <<EOF
$on_disk
EOF

# A link in the index whose target file does not exist on disk. (Check 1
# already catches a broken link to any path; this check is restricted to
# decision targets and prints the index-specific message.)
stale_index_rows=""
while IFS= read -r t; do
    [ -n "$t" ] || continue
    if [ ! -f "$t" ]; then
        stale_index_rows="${stale_index_rows}  ${t}"$'\n'
    fi
done <<EOF
$indexed
EOF

# --- Check 5: no stale NNNN ADR references ---------------------------------
# Scope: tracked files in the repo, restricted to extensions the agent
# documentation and shipped source live in. dist/ is excluded because it is
# a build artifact; .changeset/ fragments *are* scanned because their
# summary line eventually lands in CHANGELOG.md and reaches users. The
# pattern catches both "decision NNNN" / "Decision NNNN" / "decisions NNNN"
# prose and "ADR NNNN" prose; an ADR is no longer addressed by a 4-digit id
# in either form. We rely on `git ls-files` so that whatever is tracked is
# what is checked — files ignored by .gitignore are skipped automatically.
nnnn_hits=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
        plugins/claudemux/dist/*) continue ;;
    esac
    case "$f" in
        *.md|*.ts|*.tsx|*.js|*.mjs|*.sh|*.bats) ;;
        *) continue ;;
    esac
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        nnnn_hits="${nnnn_hits}  ${f}:${line}"$'\n'
    done <<EOF
$(grep -nE '\b(decision|decisions|Decision|ADR)[[:space:]]+[0-9]{4}\b' "$f" 2>/dev/null || true)
EOF
done <<EOF
$(git ls-files 2>/dev/null || find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path '*/node_modules/*')
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

if [ -n "$unindexed_files" ]; then
    echo "check: decision files missing from $decisions_index index:" >&2
    printf '%s' "$unindexed_files" >&2
    status=1
fi

if [ -n "$stale_index_rows" ]; then
    echo "check: $decisions_index links to decision files that do not exist:" >&2
    printf '%s' "$stale_index_rows" >&2
    status=1
fi

if [ -n "$nnnn_hits" ]; then
    echo "check: stale 'decision NNNN' references — rewrite to a topic slug:" >&2
    printf '%s' "$nnnn_hits" >&2
    status=1
fi

if [ -n "$orphans" ]; then
    echo "check: orphan docs (not reachable from root.md) — wire them into the navigation:" >&2
    printf '%s' "$orphans" >&2
fi

if [ "$status" -eq 0 ] && [ -z "$orphans" ]; then
    echo "agents: check passed ($(printf '%s\n' "$md_files" | grep -c . ) docs, all links resolve, research dispositions present, decisions index in sync, no stale NNNN refs)"
elif [ "$status" -eq 0 ]; then
    echo "agents: links + dispositions + decisions index + NNNN scan OK; see orphan warnings above"
fi

exit "$status"
