# Component: the `tm` CLI

`tm` is the orchestrator CLI — the command the dispatcher runs to spawn,
message, wait on, inspect, and kill teammates. Claude Code auto-prepends each
installed plugin's `bin/` to `PATH`, so `tm` resolves in any Bash subshell of
a Claude Code session.

## Shape on the `next` line

On the `next` line `tm` is a small bash launcher at
[`/plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm) that `exec`s `node`
against [`/plugins/claudemux/src/main.ts`](/plugins/claudemux/src/main.ts)
through `--experimental-transform-types`, with a tiny resolve hook
([`resolver-register.mjs`](/plugins/claudemux/resolver-register.mjs)
+ [`resolver.mjs`](/plugins/claudemux/resolver.mjs)) so the
type-stripper accepts the tree's extension-less and `.js` import
specifiers. There is no build step and no `node_modules/` lookup — the one
runtime npm dependency, `ws`, is vendored under
[`third_party/ws/`](/plugins/claudemux/third_party/ws/) and
consumed via the `#ws` subpath in the plugin's `package.json` `imports` map.

The TypeScript source lives under
[`/plugins/claudemux/src/`](/plugins/claudemux/src); see
[components/claudemux-core.md](/.agents/components/claudemux-core.md) for the
module layout. The full rationale (including which alternatives lost) is in
[zero-install-type-stripping](/.agents/decisions/zero-install-type-stripping.md),
which supersedes [node-cli-committed-bundle](/.agents/decisions/node-cli-committed-bundle.md)'s
committed-bundle shape.

The historical Bash `bin/tm` was retired in stage 3c — see
[domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) §8.

## Source of truth for the verb contracts

`tm --help` is the verb index; `tm <verb> --help` is the per-verb flag and
output contract. The help text lives in
[`src/help.ts`](/plugins/claudemux/src/help.ts) — one
`HELP_TEXTS[verb]` entry per verb plus `OVERVIEW_HELP`. Reviewers see help
changes as `help.ts` diffs in the same commit that changes the verb's
behavior. The shipped help is authoritative; never reconstruct a verb's
behavior from memory or this doc.

## Verb families

- **Atomic round-trip verbs** — `spawn --prompt`, `send`, `resume --prompt`,
  `wait`, `compact`. Each sends or triggers a turn, blocks on the Stop-hook
  idle signal, and prints the teammate's reply on **stdout**; status lines
  and the post-turn ctx echo go to **stderr**. This stdout/stderr split is
  deliberate — see [decision atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md).
- **Read-only / fast verbs** — `ls`, `states`, `last`, `ctx`, `history`,
  `mem`, `doctor`, `kill`, `reload`, `archive`. Sub-second; safe foreground.
- **Diagnostic verbs** — `status` (capture the live pane), `poll` (regex-poll
  intermediate pane state). Used when the atomic verbs do not fit.

## Editing rules — the invariants you must hold

These mirror the repo-root `CLAUDE.md` "Cross-Process & Cross-Platform
Invariants"; they bite hardest in the verbs that drive the `/tmp` file
protocol. Each has its own decision record — see
[decision cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md).

- **Never concatenate a protocol path by hand.** Every `/tmp/teammate-*`,
  `/tmp/claude-idle/*`, or `~/.claude/projects/<encoded>/...` path is built
  by a named builder in
  [`src/persistence/paths.ts`](/plugins/claudemux/src/persistence/paths.ts)
  (the matching bash hooks mirror the builder inline). Add a builder rather
  than inlining a string.
- **Cross-platform binaries.** The remaining bash surface (hooks, the launcher,
  the fake-tmux test fixture) still must guard BSD/GNU differences through
  helpers or be macOS-pinned. The native verbs pipe through the real `column`
  and `grep` rather than reimplementing them — those binaries' platform
  behavior is the contract the migration preserves.
- **One source of truth for the project-dir encoding** —
  `encodeProjectDir` in `src/persistence/paths.ts` folds every
  non-`[A-Za-z0-9-]` character to `-`, matching Claude Code's real rule.
  The hooks reproduce the same rule inline (a `tr` invocation); never extend
  either site without updating the other.

## Foot-guns

- `tm` resolves the dispatcher directory once per invocation: `TM_DISPATCHER_DIR`
  if set, else `$PWD` (Node's `process.env.PWD`, which preserves the logical
  cwd through a symlink — `process.cwd()` would return the realpath instead
  and diverge under a symlinked dispatcher tree). `/claudemux:setup` writes
  `TM_DISPATCHER_DIR` into the dispatcher's `.claude/settings.json` so it
  survives Bash-tool cwd drift. `tm doctor` reports the resolved value.
- Spawned teammates are launched with `tmux new-session -e
  CLAUDEMUX_TEAMMATE_REPO=<repo>`; the SessionStart hook uses that env var
  as an identity gate. A teammate started by raw `tmux` without that `-e`
  will not get sid rotation.
- The help pre-scan in `cli.ts` stops at the first non-flag positional or
  at `--prompt`, so a `--help` substring *inside* a prompt does not trigger
  help mode.

## See also

- [components/claudemux-core.md](/.agents/components/claudemux-core.md) — the TypeScript codebase that implements the verbs.
- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the Node CLI architecture and migration history.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` file protocol the verbs share with the hooks.
- [components/hooks.md](/.agents/components/hooks.md) — the other half of that protocol.
- [components/dispatcher-skill.md](/.agents/components/dispatcher-skill.md) — how the dispatcher decides which `tm` verb to call.
