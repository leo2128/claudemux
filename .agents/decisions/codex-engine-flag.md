# The codex teammate kind moves from a name prefix to an explicit `--engine` flag

- **Status:** Superseded by [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) (§1 and §4 carry forward unchanged; §2 and §3 retired)
- **Date:** 2026-05-23
- **Affects:** the `next` line (`1.0.0-beta.0`) — `tm spawn`'s arg surface,
  the four hot-path verbs' fork (`spawn`, `send`, `wait`, `kill`), the
  `tm ask` pool selection, the codex daemon registry layout, the
  `dispatcher` skill, and `templates/CLAUDE.md.template`.

## Context

[Decision codex-driver §1](/.agents/decisions/codex-driver.md) chose a **name
prefix** as the fork: a teammate whose first positional matches `^codex-`
routes into [`plugins/claudemux/src/engines/codex/verbs.ts`](/plugins/claudemux/src/engines/codex/verbs.ts);
every other name stays on the tmux + hooks path. The contract is enforced by
`isCodexTarget(name)` and read at four sites in the dispatcher (then in
`core/src/native.ts`; today in [`core/src/cli.ts`](/plugins/claudemux/src/cli.ts)
at the heads of `spawn`, `send`, `wait`, `kill`) and in `codexAsk`'s pool
filter.

That choice paid off as a stage-4 shortcut — one helper, four call sites, no
new state — but the cost has accumulated:

- **Surface invisibility.** `tm spawn codex-reviewer` and
  `tm spawn reviewer` produce wildly different teammates (codex daemon vs
  tmux + `claude` REPL). The CLI gives the operator no surface signal that
  the engine differs; the difference is buried in the first six characters
  of the name.
- **A reserved-prefix landmine.** A teammate named `codex-reviewer` whose
  *job* is "review a codex change" is a perfectly natural human choice; the
  system silently demotes that choice by stealing the name space. The
  decision codex-driver closing point — "future verb logic that has to know 'this
  is a codex teammate' reads `isCodexTarget(name)`" — is a stability
  promise for the *implementation*, not a defence of the surface.
- **Extension drag.** A future engine (gemini-cli, cursor, …) under the
  same scheme either reserves another prefix (`gemini-*`, `cursor-*`) — and
  the landmine multiplies — or invents an ad-hoc rule per engine. There is
  no growth path that stays clean.
- **Reported friction.** The user named the constraint directly:
  > 用名称约束也太蠢了 ("a name-based constraint is also too dumb")
  which is the trigger for this record.

The `tm ask` pool, the doctor verb, and the codex registry layout all rest
on the same `isCodexTarget` predicate, so the change must reach those too,
not just spawn.

## Decision

### 1. The engine is selected explicitly at spawn time

`tm spawn <name>` grows an `--engine <engine>` flag:

```
tm spawn reviewer --engine codex     # explicit codex teammate
tm spawn reviewer                    # default: claude (tmux + hooks)
tm spawn reviewer --engine claude    # explicit, same as default
```

`<engine>` is parsed as a string; the recognised values today are `claude`
and `codex`. An unknown value dies with `tm: spawn: --engine '<v>' is not
recognised (known: claude, codex)`. Future engines slot in by extending the
recognised set in one place — no new verb fork, no new prefix carve-out.

`<name>` becomes pure surface identity — the dispatcher chooses it for
human readability and for whatever role the teammate plays, with no
behavioural meaning. A teammate named `codex-reviewer` whose `--engine` is
`claude` is a Claude teammate, period.

### 2. Engine identity is persisted in the existing per-teammate registries

`tm spawn` writes the engine alongside the teammate's other on-disk state.
The persistence does not need a new file:

- **Claude teammates** already write `/tmp/teammate-<name>.cwd`,
  `/tmp/teammate-<name>.sid`, `/tmp/teammate-<name>.ready`. A claude
  teammate's presence is observable as "any of those three exists".
- **Codex teammates** already write `/tmp/teammate-codex/<name>/`
  (see
  [`engines/codex/persistence.ts`](/plugins/claudemux/src/engines/codex/persistence.ts)
  for the registry-directory builders). A codex teammate's presence is
  observable as "that directory exists".

The two registries are already mutually exclusive — they live under disjoint
roots. Engine identity falls out of "which registry holds the name", with
no new state to add and no synchronisation between two stores to defend.

To codify the mapping, a single resolver function in
[`identity/router.ts`](/plugins/claudemux/src/identity/router.ts) replaces the four
`isCodexTarget(name)` call sites:

```ts
type Engine = 'claude' | 'codex' | null
function resolveTeammateEngine(name: string): Engine {
  if (existsSync(codexTeammateDir(name))) return 'codex'
  if (existsSync(sidFile(name)) || existsSync(cwdFile(name))) return 'claude'
  return null
}
```

The four hot-path verbs read this resolver at their head:

- `spawn` — if the resolver returns non-null, refuse with
  `tm: spawn: '<name>' already exists as a <engine> teammate (use
  'tm kill <name>' first)`. This is the cross-engine reuse guard called
  out in §4 below.
- `send` / `wait` / `kill` — switch on the resolver's return:
  `claude` → tmux path, `codex` → codex driver, `null` → the existing
  "no such teammate" error.

`tm ls` and `tm states` continue to enumerate Claude teammates from
`tmux ls`; a separate fix to surface codex teammates in those views is **out
of scope** for this record — see "Out of scope" below.

### 3. Backwards compatibility: `codex-` prefix routing stays for one minor, with a deprecation warning

A hard cut-over would break two real flows on day one:

- The user has scripts that read `tm spawn codex-1` from their dispatcher
  skill. Under a hard cut-over, that command silently switches to spawning
  a Claude teammate named `codex-1`, which then fails with `repo not
  found` because there is no `codex-1` subdirectory of the dispatcher.
  Silent surface change, loud (and confusing) runtime failure.
- The `tm ask` pool in any environment that has codex teammates running
  *right now* would empty out the moment the new code lands, because the
  filter in `codexAsk` would stop matching the running daemons' names.

The transition is **one minor release** (0.9.0):

- `tm spawn codex-<name>` with **no `--engine` flag** continues to route to
  the codex driver. A `tm: spawn: routing 'codex-<name>' to the codex
  driver by name prefix is deprecated — pass --engine codex` is printed to
  stderr (the verb does not fail). The behaviour is unchanged.
- `tm spawn codex-<name> --engine claude` is **allowed** and produces a
  Claude teammate whose name happens to start with `codex-`. This is the
  escape hatch for a user who wants the human name.
- `tm spawn codex-<name> --engine codex` is the new explicit form. The
  deprecation message is **not** printed.

The next minor (0.10.0) deletes the prefix-routing branch. The deprecation
window is one minor specifically because the audience of `tm` is the
dispatcher script + one human; both can absorb one release of warnings.

### 4. Cross-engine name reuse is forbidden

`tm spawn` rejects a name that already exists in either registry, even if
the engine differs:

```
$ tm spawn foo --engine claude
spawned: foo (tmux=teammate-foo, …)
$ tm spawn foo --engine codex
tm: spawn: 'foo' already exists as a claude teammate (use 'tm kill foo' first)
```

The reason is the downstream verbs: `tm send foo --prompt "…"` would have
no way to disambiguate two teammates of the same name across engines.
Disambiguation by a `--engine` flag at every verb is a worse contract than
forbidding the conflict at spawn time — `send` / `wait` / `kill` stay
single-positional, the way they are today.

This rule is enforced by §2's resolver returning non-null.

### 5. `tm ask` selects by engine, not by name prefix

`codexAsk` ([`plugins/claudemux/src/engines/codex/verbs.ts`](/plugins/claudemux/src/engines/codex/verbs.ts))
filters `listDaemons()` with `isCodexTarget`. Under §2, every entry that
`listDaemons()` returns lives under `codexTeammateDir(name)`, so the filter
is **vacuous** — every entry is already engine=codex. The filter is deleted
and the variable name in the closing line is renamed from `candidates` to
`teammates` to reflect what is actually iterated.

This is a quiet behaviour expansion: a codex teammate named `reviewer`
(no `codex-` prefix) becomes eligible for `tm ask` for the first time. That
matches the surface change in §1 — name is identity, engine is the
selector — and is the point of the change.

## Consequences

- **The deprecation window is the only window.** §3 names a one-minor
  schedule. Past that, `tm spawn codex-1` (no flag) is a Claude teammate.
  The schedule lives in this record and in the dispatcher skill's
  changelog; CI does not enforce the deprecation removal date, so the next
  agent must check this record when bumping `0.10.0`.
- **The dispatcher skill changes.** Anywhere
  [`dispatcher` skill](/plugins/claudemux/skills/dispatcher) instructs the
  agent to "spawn `codex-<n>`", it should now say "spawn `<n>` with
  `--engine codex`". The dispatcher template
  ([`templates/CLAUDE.md.template`](/plugins/claudemux/templates/CLAUDE.md.template))
  carries the same change. Both are in scope for the implementation PR.
- **`isCodexTarget` is deleted.** §2's resolver supersedes it; the four
  call sites switch over and the export goes away. A future agent looking
  for "is this name a codex teammate" finds the resolver and gets the
  right answer regardless of name.
- **The `tm ask` candidate set widens.** Codex teammates named without the
  prefix become eligible. This is intentional per §5; a release-notes
  bullet calls it out so an operator does not see surprise borrowing.
- **No new `/tmp` files.** The two existing registries are the source of
  truth for engine identity. Decision cross-process-cross-platform-invariants's path-builder discipline
  (named functions, no string concatenation at use sites) is preserved —
  the resolver lives in `paths.ts` next to the builders it consults.

## Out of scope

- **`tm ls` / `tm states` listing codex teammates.** Decision codex-driver §2 left
  this open; this record neither fixes nor regresses it. A follow-up
  record will decide whether the views merge or stay separate.
- **A `tm spawn --engine gemini` (or similar) implementation.** §1's
  string-typed flag accepts the *shape* of a future engine; the engine
  *itself* is a separate record.
- **Locking `tm send` against `tm ask` on the same teammate.** Decision codex-driver §3 leaves this open and this record does not change the
  trade-off — the surface change does not affect the locking story.

## References

- [decisions/codex-driver.md](/.agents/decisions/codex-driver.md) — the prefix-fork decision this record supersedes in part (§1).
- [decisions/node-cli-orchestrator.md](/.agents/decisions/node-cli-orchestrator.md) — the Node CLI contract the new flag lives on.
- [decisions/cross-process-cross-platform-invariants.md](/.agents/decisions/cross-process-cross-platform-invariants.md) — the path-builder discipline §2's resolver respects.
- [components/claudemux-core.md](/.agents/components/claudemux-core.md) — the module table the resolver will be added to.
- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the §8 stage map updated when this lands.
