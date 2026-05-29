# claudemux plugin — dev entry

The multi-repo orchestrator: a **dispatcher** Claude session drives one **teammate** `claude` REPL per repo (each in its own `tmux` session) through the **`tm` CLI**, which coordinates with per-session **hooks** only through files under `/tmp`. A thin bash launcher fronts a Node CLI; the hooks stay bash.

Depth lives in the KB (repo-root `.agents/`, not shipped to users): start at `.agents/root.md`, then the matching `components/*.md` / `domains/*.md`. This file is the entry index — the per-dir map plus the traps that bite when editing here. It deliberately does not restate the KB.

## Where things live (this plugin dir)

- `bin/tm` — thin bash launcher; execs `node` against `src/main.ts` under `--experimental-transform-types` (no build step, no `node_modules`).
- `src/` — the `tm` CLI source: verbs, dispatch, help, the Claude and Codex engines, persistence, identity. → `.agents/components/tm.md`, `.agents/components/claudemux-core.md`.
- `hooks/` — `on-busy.sh`, `on-stop.sh`, `on-session-start.sh`; wiring in `hooks/hooks.json`. These maintain the BUSY/idle turn signal `tm`'s waiting verbs block on. → `.agents/components/hooks.md`.
- `skills/dispatcher/SKILL.md` — teammate-coordination ops manual (the verbs the dispatcher drives); `skills/optimize/SKILL.md` — periodic dispatcher self-review.
- `commands/setup.md` + `scripts/setup.sh` + `templates/CLAUDE.md.template` — the `/claudemux:setup` onboarding flow and the dispatcher seed.

## The load-bearing seam (read before touching `/tmp` or a `tm`↔hook path)

`tm` (Node) and the hooks (bash) **never call each other** — they coordinate only through files under `/tmp` (the turn signal and the sid bridge). Two invariants hold: every protocol path comes from a named builder (no raw string concat at use sites), and the project-dir encoding has one source of truth. → `.agents/domains/cross-process-protocol.md`; the binding form is in the repo-root `CLAUDE.md`.

## Traps (won't infer these from the code)

- **A spawned teammate shields the dispatcher's `CLAUDE.md`** — `tm spawn` launches `claude --settings` with a `claudeMdExcludes` list, so the teammate loads its own repo's `CLAUDE.md`, never the dispatcher's. (Mechanism: `src/engines/claude/spawn.ts` — `teammateSettingsJson` / `teammateLaunchFlags`.)
- **Spawned teammates carry `CLAUDEMUX_TEAMMATE_NAME`** (a `tmux new-session -e` env) as the SessionStart identity gate, together with a recorded-cwd byte match. A raw `tmux` session without that env will not get sid rotation.
- **Hooks always exit 0 and must be fast** — `on-busy.sh` runs on every `PreToolUse`, so it uses `sed`, not `jq`. BSD/GNU command differences go through OS-detected helpers (the CI matrix runs both).

## Versioning

A feature change to `bin/*`, `hooks/*`, `scripts/*`, `templates/*`, a `skills/*/SKILL.md`, or the `src/` CLI source needs a Changesets fragment for `claudemux`, not a `version` edit. KB and docs are exempt. → repo-root `CLAUDE.md`, `.agents/components/repo-tooling.md`.

## Update this file when

A component boundary in this dir shifts, the `/tmp` seam changes, the spawn-shield or identity-gate mechanism changes, or a new top-level trap appears. Follow the Knowledge Delta Protocol in `.agents/CONTRIBUTING.md`.
