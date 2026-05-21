# Industry vs claudemux — Best-Practice Research

Read-only desk research. Sources cited inline; no code touched.

## 1. Anthropic plugin authoring

There **is** an official authoring guide and reference: `code.claude.com/docs/en/plugins` (overview + quickstart) and `/plugins-reference` (component schemas). The `plugin.json` `version` field is *optional*: if set, users only receive updates when bumped; if omitted, the git commit SHA acts as version and every commit counts as one. Anthropic ships an in-app **Plugin Developer Toolkit** plugin (`/plugin-dev:create-plugin` — an 8-phase guided workflow) plus an "Official, Anthropic-managed directory" repo at `anthropics/claude-plugins-official`. Hook events are enumerated (UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionStart, …) but the docs **do not commit to backward-compatible evolution of payload field names** — there is no published deprecation policy or `hook_protocol_version` field. Runtime-file naming under `/tmp` is not prescribed: each plugin chooses its own convention.

Sources:
- [Create plugins (official guide)](https://code.claude.com/docs/en/plugins)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)

**Gap:** claudemux already uses explicit semver in `plugin.json` and a pre-commit hook to enforce bumps — matches or exceeds the official recommendation. We have **not** taken the `/plugin-dev:create-plugin` toolkit for a spin; might surface missed manifest fields. **No industry convention** for hook payload versioning exists yet — our concern from §2 of `architecture-review.md` is well-founded (Anthropic-side risk we can only defensively absorb).

## 2. `anthropics/claude-code-action` for CI

The official GitHub Action runs the full Claude Code runtime in a runner. Triggers: `@claude` mentions, issue assignment, or explicit-prompt automation. **Requires `ANTHROPIC_API_KEY`** (or Bedrock / Vertex / Foundry credentials) — no free tier. Supports installing plugins into the runner via `plugin_marketplaces` + `plugins` inputs, so a workflow can boot claudemux *inside* CI and exercise it. **It does not natively run bats / shellcheck for us** — those remain a separate workflow step. Its real value is *PR review / CI log triage* by an LLM, not unit testing.

Sources:
- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
- [claude-code-action usage docs](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)
- [Claude Code GitHub Actions (official)](https://code.claude.com/docs/en/github-actions)

**Gap:** We have shellcheck + bats matrix CI already. We do **not** have an LLM PR-reviewer in CI (the review-only teammate is run by hand). Adopting the action for `@claude` PR review would mirror the dispatcher pattern in cloud — cost: small (one workflow file, one secret).

## 3. Bash CLI testing — `main` guard idiom

Bats is the de-facto standard (gh CLI, docker community, sstephenson lineage). The canonical pattern for "source the script for unit tests without running it" is:

```bash
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

This is recommended by multiple practitioner write-ups (opensource.com, jon.sprig.gs) and is the standard solution to claudemux's `sed '$d'` workaround in `tests/test_helper.bash:26`.

Sources:
- [Testing Bash with BATS (opensource.com)](https://opensource.com/article/19/2/testing-bash-bats)
- [bats-core writing-tests docs](https://bats-core.readthedocs.io/en/stable/writing-tests.html)
- [bats-core](https://github.com/bats-core/bats-core)

**Gap:** Our `sed '$d' bin/tm | eval` hack works but is brittle (any move of `main` breaks tests; a stray trailing comment after `main "$@"` also breaks it). Replacing with the `BASH_SOURCE` guard is one line in `bin/tm` and one removed line in the test helper. **Cost: tiny.**

## 4. BSD vs GNU portability

Authoritative compendium: maelvls's BSD-vs-GNU-vs-Busybox matrix. Canonical workarounds:

- **`sed -i`** — `sed -i.bak '...' file && rm file.bak` (works everywhere). Or `perl -pi -e '...'`.
- **`stat`** — no portable single-form. Either detect once and branch (`stat -f %z /dev/null 2>/dev/null && BSD=1`), or use `wc -c < file` for size and `find -printf` alternatives for mtime. Several projects ship a `stat_size()` / `stat_mtime()` two-line helper.
- **`date`** arithmetic — BSD `date -v+1d` vs GNU `date -d "+1 day"`. Same shim approach.
- **`find -printf`** — macOS lacks it. Use `find ... | xargs basename` or a `while read` loop.

The big-three patterns are: (1) OS-detected branch (`case "$OSTYPE" in darwin*) ...`), (2) prefer `g`-prefixed Homebrew GNU tools (`gsed`, `gstat`) and document them as deps, (3) rewrite in `perl -CSD` which behaves the same on both. claudemux already uses (3) for the CJK preview path.

Sources:
- [BSD vs GNU vs Busybox incompat matrix](https://hackmd.io/@maelvls/bsd-vs-gnu-vs-busybox-incompat)
- [Linux (GNU) vs Mac (BSD) command-line utilities](https://ponderthebits.com/2017/01/know-your-tools-linux-gnu-vs-mac-bsd-command-line-utilities-grep-strings-sed-and-find/)
- [Portable shell scripts overview](https://oneuptime.com/blog/post/2026-01-24-portable-shell-scripts/view)

**Gap:** Confirms top-3 #2 of `architecture-review.md`. Best practice is the OS-detected branch + `stat_size`/`stat_mtime` two-helper pattern. Our current `|| echo 0` silently masks the failure on Linux — the industry pattern is one tier better.

## 5. `/tmp` cross-process protocols — prior art

- **tmux** has an internal `PROTOCOL_VERSION` integer constant in C; client-server mismatch aborts with `protocol version mismatch (client N, server M)`. Socket path is `/tmp/tmux-<UID>/default`, **UID-scoped** by directory.
- **SSH ControlMaster** uses `ControlPath %r@%h:%p` (user@host:port) for socket scoping — no version field in the socket name, version negotiation happens in-protocol.
- **systemd / XDG** convention: `XDG_RUNTIME_DIR=/run/user/<uid>` is the standard for per-user, per-boot runtime state — `/tmp` is the fallback. UID-scoped, tmpfs-backed, auto-cleaned on logout.

None of these embed a version field in a *filename*; the version negotiation is either in a header byte (tmux) or implicit in the socket protocol (ssh). The relevant claudemux lesson is **UID scoping**, not a literal version field.

Sources:
- [tmux man page (sockets, IPC)](https://man7.org/linux/man-pages/man1/tmux.1.html)
- [tmux protocol version mismatch issue](https://github.com/tmux/tmux/issues/3143)
- [How SSH multiplexing reuses master connections](https://chessman7.substack.com/p/how-ssh-multiplexing-reuses-master)

**Gap:** Our `/tmp/teammate-<repo>.*` and `/tmp/claude-idle/<sid>*` files are **not UID-scoped** — two users on the same machine with identically named repos collide silently. The industry move is `${XDG_RUNTIME_DIR:-/tmp/tm-$UID}/teammate-<repo>.*`. For version negotiation, a header line inside `.sid` / `.last` (e.g. first line `#tm-proto:1`) is enough; readers tolerate missing header today, future readers check.

## 6. Comparable community plugins

Authoritative discovery surfaces exist (`ComposioHQ/awesome-claude-plugins`, `hesreallyhim/awesome-claude-code`, `cased/claude-code-plugins`, `claudemarketplaces.com`, `claudepluginhub.com`) but **rendering the actual project lists via WebFetch returned navigation chrome rather than entries** — I could not enumerate concrete repos at our scale (skill + hook + multi-hundred-LOC bash CLI). Named plugins surfaced in passing — `backlog` (24 MCP tools + 7 skills), `maestro-orchestrate` (22 subagents + 4-phase workflow), `skill-bus` — are **skill-heavy and TypeScript/MCP-heavy**, not bash-CLI-heavy like claudemux. Our shape (one big bash dispatcher + hooks-driven IPC) seems uncommon in the visible ecosystem.

Sources:
- [ComposioHQ/awesome-claude-plugins](https://github.com/ComposioHQ/awesome-claude-plugins)
- [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
- [claudemarketplaces.com](https://claudemarketplaces.com/)

**Gap:** **Not found — needs human eyeball pass** through the awesome-lists to find genuine peers. Skip judging until we have 2-3 concrete repos to compare against.

---

## Top-5 immediate steals

1. **Replace `sed '$d'` test hack with `if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi` guard.** Industry-canonical, one-line patch in `bin/tm`, removes `sed`-fragility from `tests/test_helper.bash`. **Cost: small.**
2. **`stat_size()` / `stat_mtime()` OS-shim helpers** detected once at script start, replacing every `stat -f` with the helper call. Mirrors the prevailing community pattern; eliminates Linux silent-degradation (top-3 #2). **Cost: small.**
3. **UID-scope the runtime dir.** Use `${XDG_RUNTIME_DIR:-/tmp}/tm-$UID/` as the base for both `teammate-*.{sid,ready,cwd,send-at}` and `claude-idle/<sid>*`. Path-builder helpers (top-3 #3) absorb this in one place. Matches tmux/systemd convention. **Cost: small** *if* §1's path-builder cleanup happens first; medium otherwise.
4. **Reserve a header-line protocol slot in `.sid` / `.last`.** First line `#tm-proto:1`; readers tolerate absence today, future readers check. No semantic change yet, but unlocks the next schema migration. **Cost: small.**
5. **Add a `claude-code-action` PR-review workflow.** Cloud counterpart to our local review-only teammate; runs on every PR open, comments via `@claude`. Requires one secret (`ANTHROPIC_API_KEY`) and one workflow file. Does **not** replace shellcheck/bats — adds an LLM reviewer on top. **Cost: small.**
