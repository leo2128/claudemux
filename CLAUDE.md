# Repository Instructions

## Communication

- Reply to the user in Chinese.
- Write repository instruction files and plugin-shipped agent documents in English.

## Knowledge Base

- `.agents/` holds the agent knowledge base — architecture overview, per-component guides, a cross-process protocol reference, decision records, and a research archive. Read `.agents/root.md` first when starting non-trivial work; it routes you to the document that matches your task.
- `.agents/research/` archives the point-in-time research snapshots behind those decisions (the Feishu channel survey, the `tm` architecture audits). They are dated history, not maintained — start from `.agents/research/index.md` and treat a decision record as authoritative where the two disagree.
- This file (`CLAUDE.md`) remains authoritative for binding rules. The KB is the navigation, architecture, and decision layer on top of it; when the two disagree, `CLAUDE.md` wins and the KB has drifted — fix the KB.
- After a change that moves a component boundary, the cross-process file protocol, the `tm` verb set, hook wiring, or that settles a design decision, update the matching `.agents/` document in the same change, then run `bash .agents/scripts/check.sh`. The protocol and writing standard are in `.agents/CONTRIBUTING.md`.

## Verify Before Acting

- Treat user framing as a hypothesis. Check the actual files, scripts, and runtime contracts before changing behavior.
- When searching code, choose the narrowest repository or subdirectory scope first. This repository is the scope for claudemux work.

## Audience Boundaries

Before editing any Markdown in this repository, identify who reads that surface:

- `README.md` and `README.zh-CN.md` are human-facing product documentation. Explain user workflows, installation, and visible behavior.
- `plugins/claudemux/commands/*.md` frontmatter is human-facing slash-command UI. Keep `description` short and useful beside the command name; it is not a model auto-trigger contract.
- `plugins/claudemux/commands/*.md` body is read by Claude only after the user explicitly invokes the command. Write it as an execution guide for that command invocation. It may instruct Claude to run safe checks, ask the human to perform actions, wait for confirmation, and report results.
- `plugins/claudemux/skills/*/SKILL.md` frontmatter is model-facing skill routing metadata. Describe when the skill is relevant; keep behavioral policy and operational steps in the skill body.
- `plugins/claudemux/skills/*/SKILL.md` body is model-facing operational guidance. Assume the future agent has no prior conversation context. Give complete, actionable steps with the reason that makes each step necessary.
- `plugins/claudemux/skills/*/references/*.md` is on-demand model-facing detail. Put diagnostics, edge cases, and deeper mechanisms there when they would distract from the main skill flow.
- `plugins/claudemux/templates/CLAUDE.md.template` is always-loaded dispatcher memory copied into the user's dispatcher directory. Keep it short and durable: dispatcher identity, routing boundaries, and stable rules. Put long protocols and helper-specific mechanics in the dispatcher skill.
- `plugins/claudemux/bin/`, `plugins/claudemux/hooks/`, and `plugins/claudemux/scripts/` are executable contracts. Align command docs and skill instructions with their actual flags, stdout, and failure modes.

## Writing Agent Instructions

- Prefer "do this, because ..." over prohibition-heavy wording. Positive action plus reason is easier for future agents to follow.
- Keep development-process commentary out of shipped agent documents. Only write durable behavior rules and operational facts that make sense to a fresh agent.
- Do not explain why a rejected alternative is wrong. A fresh agent has never seen that alternative, so a warning like "do not convert this back to X" or "this used to be Y" names an unfamiliar thing and raises a question instead of answering one — it reads as noise. State the rule to follow now; drop the history of what it replaced. If a foot-gun genuinely needs guarding, encode the guard in the executable contract (script, hook, validation), not in prose aimed at a reader who lacks the context to act on it.
- Separate trigger text from behavior. If a surface is not actually used for automatic invocation, write it as user-visible documentation instead of trigger prose.
- Keep fixed command names, flags, paths, output strings, JSON keys, and code fences exact unless the task is to change that contract.

## Cross-Process & Cross-Platform Invariants

These rules cover the shared surfaces between `bin/tm`, the hooks, and the host OS. They exist because each one has already drifted at least once in this codebase and the drift was load-bearing.

- **Path-builder discipline.** Every path under `/tmp/teammate-*` or `/tmp/claude-idle/*`, and every `$HOME/.claude/projects/<encoded>/...` path, must be constructed by a named builder function (`sid_file`, `idle_marker_for`, `last_file_for`, `encode_project_dir`, ...). No raw string concatenation at use sites. Reason: the cross-process file protocol is *the* coupling layer between `bin/tm` and the hooks; spreading its shape across many string literals makes the next schema change a multi-site sweep across files that cannot be refactored atomically. Hooks cannot source `bin/tm`, so they mirror the builders inline — the discipline is "named function", not "shared definition".

- **Cross-platform shell discipline.** Every command whose flags differ between BSD (macOS) and GNU (Linux) — `stat -f` vs `stat -c`, `sed -i ''` vs `sed -i`, `find -printf` (GNU-only), `date -d` (GNU-only), `tail -r` vs `tac`, `readlink -f` (GNU-only) — must go through an OS-detected helper (`stat_size`, `stat_mtime`, `rev_lines`, ...), or the script must declare itself macOS-only at the top. Reason: the CI matrix runs on both OSes, and pairing a BSD-only command with `|| echo 0` silently degrades on Linux without failing — harder to catch than a hard error.

- **One source of truth for the project-dir encoding.** Any code that needs to map a teammate cwd → Claude Code's project-dir name routes through the `encode_project_dir` helper (and its `project_dir_for_repo` wrapper for the common case). Reason: the encoding (`/` and `.` → `-`) is an Anthropic-controlled contract; spreading the mapping across the codebase guarantees one site drifts when the contract is reproduced by hand (already happened — a `tr / -` site silently dropped dots).

## Slash Command Methodology

- Treat `/claudemux:setup` as a guided human onboarding flow. Claude may run safe checks and the bundled setup script; the human handles package-manager installs, starting `tmux`, launching a fresh `claude`, and creating teammates because those actions may need passwords, new terminals, or startup-time settings.
- `/claudemux:setup` operates on the current working directory. If the cwd looks wrong, guide the user to exit, `cd` to the intended dispatcher directory, launch `claude`, and run the command again.
- Keep slash-command final reports short and actionable: what was checked, what changed, what remains manual, and the exact next command for the human.

## Versioning

This repo ships more than one plugin under `plugins/`. Each plugin has its own manifest (`plugins/<name>/.claude-plugin/plugin.json`) and its own version number — the plugins are versioned independently.

For claudemux, a feature commit does **not** edit the `version` field. It declares the change with a Changesets fragment written directly to `.changeset/<slug>.md` at the repo root — do not use the interactive CLI:

```markdown
---
"claudemux": patch
---

<one-paragraph description>
```

Commit the fragment alongside the change. The level you pick is what that change warrants on its own:

- `patch` — bug fix, no behavior change visible to users
- `minor` — new feature, backward-compatible
- `major` — breaking change to a documented contract (CLI flag removal, file path change, on-disk format change)

The version is bumped only by the release pipeline. Official Changesets consumes pending fragments, updates `plugins/claudemux/package.json`, writes `plugins/claudemux/CHANGELOG.md`, and deletes consumed fragments. The `version-packages` script then mirrors that package version into `plugins/claudemux/.claude-plugin/plugin.json`. Because each feature commit adds a new fragment instead of editing the shared `version` line, parallel feature branches do not collide on versioning. See [decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md).

Release-surface paths are declared in `.changeset/config.json` under `changedFilePatterns`:

- `bin/*`, `hooks/*`, `scripts/*`, `templates/*` (claudemux)
- `skills/*/SKILL.md` (claudemux)
- `core/src/*`, `core/package.json`, `core/resolver.mjs`, `core/resolver-register.mjs`, `core/third_party/*` (claudemux core)
- `src/**` (feishu-channel — use package name `"claude-channel-feishu"`)

Two local hooks run via Husky (installed by `pnpm install`):

- `.husky/pre-commit` — delegates to `.githooks/pre-commit`, which checks the commit author email via `bin/check-author`.
- `.husky/pre-push` — runs `pnpm changeset status --since=origin/next` to catch missing changeset fragments before push.

Pure-docs commits (README, CLAUDE.md, KB files, `*.md` outside `SKILL.md`), CI/test changes, and edits limited to a manifest's description/keywords remain exempt from release intent.

To enable all hooks on a fresh clone: `pnpm install` (the `prepare` script sets `core.hooksPath=.husky/_` automatically).

## Commit Author

Commit author email must be a real, well-formed address — not a machine-default identity (git's `whoami@hostname` guess, e.g. `dyzhu@MacBook.local`, which git fabricates when `user.email` is unset). Any valid public email passes; there is no per-person whitelist.

The rule lives in `bin/check-author` — one source of truth, called from two places: `.githooks/pre-commit` (invoked via `.husky/pre-commit`) checks the identity the next commit would use, and the CI workflow checks every commit a push or PR introduces. It rejects an unparseable email or an mDNS/LAN suffix (`.local`, `.localdomain`, `.lan`, `.home`, `.internal`).

To stop machine-default identities at the root, set once per machine: `git config --global user.useConfigOnly true` — git then refuses to commit until `user.email` is explicitly configured, instead of silently guessing.
