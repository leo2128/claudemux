# Codex teammates ship as a separate `codex-` prefixed driver

- **Status:** Accepted
- **Date:** 2026-05-23
- **Affects:** the `next` line (`1.0.0-beta.0`) — the `tm` CLI, the new
  `codex-*` modules under [`core/src/`](/plugins/claudemux/), the new
  `codex-protocol/` vendored bindings, the `live-codex.itest.ts` suite, the
  doctor verb, the (re-introduced) `tm ask` verb.

## Context

[Decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) names *what*
the codex driver does at a high level — claudemux spawns
`codex app-server --listen unix://<path>` itself, owns the daemon lifecycle
through an FS-backed registry, and connects with a WebSocket JSON-RPC client
against a schema pinned by tests. The roadmap stage 4 — landing in the same
PR as this record — fills in the concrete decisions node-cli-orchestrator left under-specified:

- **Verb fork shape.** `tm` already has 17 verbs against tmux teammates.
  Should codex be a parallel verb namespace (`tm codex-spawn`, `tm codex-send`),
  share verbs with a name-discriminator, or land as its own CLI?
- **Schema pin.** node-cli-orchestrator mandates a schema test against the experimental
  protocol envelope. *Which* schema — hand-typed? Generated? Vendored?
- **Ask-mode pool.** The brief promises "pool borrow/return". Two readings
  fit the words: the named `codex-<n>` teammates *are* the pool (ask
  contends with `tm send`), or ask has a separate anonymous app-server
  pool, disjoint from named teammates.
- **Doctor's orphan story.** The brief asks for "orphan cleanup". Doctor
  has historically been a *report-only* verb. Should it mutate state?
- **Bundle and CI gates.** `dist/cli.mjs` now imports `ws`, a CJS dep
  whose internals call `require()` — esbuild's ESM-bundle output leaves
  the calls in place and the runtime trips on them. The codex-protocol
  bindings (587 generated files) need a drift gate so a codex upgrade
  cannot silently re-shape the envelope under us.

Each is a load-bearing call that the next agent could re-debate without an
explicit record.

## Decision

### 1. The verb fork is a name-prefix branch on the existing verbs

`tm spawn`, `tm send`, `tm wait`, and `tm kill` grow a one-line guard at the
head: if the first positional matches `^codex-`, the verb delegates to
[`plugins/claudemux/src/engines/codex/verbs.ts`](/plugins/claudemux/src/engines/codex/verbs.ts); otherwise the
tmux path runs unchanged. Flags that are tmux-bound (`--pane-quiet`,
`--timeout`, the `tm send --no-wait` semantics) are rejected explicitly on
the codex side rather than silently accepted, because silent acceptance
would mislead a dispatcher into thinking it had set a meaningful knob.

`tm ask` is re-introduced as a *codex-only* verb (it does not name a
teammate; it picks one). The 0.3.0 `REMOVED_VERB_MESSAGES['ask']` entry is
deleted; `cli.ts` now routes the verb into the native dispatch table.

### 2. The schema is the vendored output of `codex app-server generate-ts --experimental`

The codex CLI ships its protocol bindings as an *official* TypeScript
emit:

```
codex app-server generate-ts --experimental --out plugins/claudemux/src/codex-protocol/
```

That output — 587 files, ~2.4 MB, marked `linguist-generated=true` so GitHub
diffs collapse it by default — is committed to the repo as ground truth.
The schema test
([`codex-schema.test.ts`](/plugins/claudemux/test/codex-schema.test.ts))
pins the *envelope* shape (the `{ id, result }` / `{ method, params }` shapes,
the absence of the JSON-RPC `jsonrpc` field) against a captured fixture; the
*field* shape is pinned by the vendored types themselves through tsc.

A CI step reruns `generate-ts` and asserts
`git diff --exit-code -- src/codex-protocol/`. A codex upgrade that changes
the wire schema must regenerate the directory in the same PR, or CI fails
loud rather than the runtime corrupting a turn silently.

### 3. Ask mode is option (A) — named teammates *are* the pool

The named `codex-<n>` teammates serve as the pool. `tm ask "<prompt>"`:

1. Enumerates codex teammates from the FS registry.
2. Picks the first alive one whose borrow lock (`<dir>/lock`, created with
   `O_EXCL`) can be claimed atomically.
3. Opens a fresh ws connection, calls `thread/start` with
   `ephemeral: true` so codex side does not bind the turn to the
   teammate's persistent conversation history. The teammate's
   `<dir>/thread` file is not touched at all — a later
   `tm send <name>` continues the user's primary thread exactly as
   before.
4. Drives one turn through the shared `runTurn` helper.
5. Releases the lock, unconditionally, including on error — the
   borrow/initialize/turn flow is wrapped in `try { … } finally {
   releaseBorrow(borrowed) }` so a thrown ws-connect or RPC error
   never leaks the lock.

`ephemeral: true` is what makes ask cheap on the daemon: without it
every ask leaks one server-side thread per call (a shelve-and-restore
dance on the persisted `<dir>/thread` file does not free the
daemon-side thread the call allocated).

`tm send` does not currently acquire the lock; concurrent
`tm send codex-N` + `tm ask` against the same teammate is guarded by codex's
own per-thread sequencing — and since ask runs on a different
(ephemeral) thread from send, there is no server-side contention even
if the timing overlaps. A future PR can teach `send` to acquire the
lock if user feedback shows that matters.

### 4. Doctor reaps dead-pid orphans, never live ones

`tm doctor` lists every codex teammate in the FS registry with pid and
spawn time. For each entry whose pid is *demonstrably dead* (the registry
file is present but `process.kill(pid, 0)` reports ESRCH), the directory
is removed and the entry is reported under "reaped orphans". An entry
whose pid still answers signal 0 is reported, never touched, even if its
last-seen timestamp is stale — the call to mark a live daemon for removal
is the user's, not doctor's.

This is the narrowest interpretation of the brief's "orphan cleanup": the
mutation is mechanically safe (dead pid implies nothing to break), and the
report-only character of doctor is preserved for everything else.

### 5. CI guards on the bundle and the vendored schema

- **Bundle drift.** Already in place from [decision node-cli-committed-bundle](/.agents/decisions/node-cli-committed-bundle.md):
  `npm run build` + `git diff --exit-code -- dist/`. Adding `ws` as a runtime
  dep grows the bundle to ~221 kB, which the gate continues to catch.
- **ESM-bundle `require` shim.** The esbuild banner now emits
  `const require = createRequire(import.meta.url)`. `ws` (and several of
  its submodules) call `require()`; the ESM output leaves the calls in
  place and they trip on a runtime that does not provide `require`. The
  banner is the standard ESM-bundle workaround.
- **Schema drift.** New CI step in the `claudemux-core` job:
  ```yaml
  - name: Install codex CLI
    run: npm install -g '@openai/codex@0.133.0'
  - name: codex-protocol not stale
    run: |
      codex app-server generate-ts --experimental --out src/codex-protocol/
      git diff --exit-code -- src/codex-protocol/
  ```
  The codex version is pinned alongside the vendored output, so bumping
  codex means bumping that line and regenerating in the same PR. The
  drift gate is deterministic, not a moving target.

## Consequences

- **The CodexWsClient is the protocol seam.** Bugs that look like
  "codex behaved weirdly" should be diagnosed first at the envelope
  level — does the wire shape still match `codex-schema.test.ts`'s
  fixture? — before deeper layers.
- **Daemon supervision is an explicit, on-disk protocol.** Decision node-cli-orchestrator's intent (no in-memory registry) is realized in
  [`plugins/claudemux/src/engines/codex/persistence.ts`](/plugins/claudemux/src/engines/codex/persistence.ts)'s named builders
  and [`plugins/claudemux/src/engines/codex/supervisor.ts`](/plugins/claudemux/src/engines/codex/supervisor.ts).
  A spawn that fails its readiness probe rolls the entry back; a process
  crash before unwind leaves a dead-pid orphan, and doctor reaps it on
  the next pass. There is no "in-flight half-spawned" state to handle
  beyond that.
- **A codex teammate is a `codex-<n>` name, period.** Other prefixes
  (`mycodex-1`, `Codex-1`) stay on the tmux path. This is a stable
  contract: future verb logic that has to know "this is a codex
  teammate" reads `isCodexTarget(name)`, never a substring match.
- **The integration suite is the production verifier.** Both the smoke
  slice (no model spend) and the turn-spending slice (opt-in via
  `CLAUDEMUX_CODEX_SPEND_TOKENS=1`) live under
  [`test/integration/codex.itest.ts`](/plugins/claudemux/test/integration/codex.itest.ts).
  CI cannot run either — no codex install, no auth — so the merge bar
  for codex-touching PRs is **CI green + a reported live run**, matching
  the live-claude pattern already established by
  [decision live-teammate-integration-harness](/.agents/decisions/live-teammate-integration-harness.md).
- **The vendored schema is large.** 587 files / 2.4 MB on the source
  tree. esbuild only bundles what is reached from `src/main.ts`, so the
  production `dist/cli.mjs` includes only the handful of types the
  driver actually imports — the bulk lives in the source tree as the
  drift-gate target, not in the shipped artifact.

## References

- [decisions/node-cli-orchestrator.md](/.agents/decisions/node-cli-orchestrator.md) — the high-level contract; this record fills in stage 4.
- [decisions/live-teammate-integration-harness.md](/.agents/decisions/live-teammate-integration-harness.md) — the live-teammate pattern; codex.itest.ts mirrors it.
- [decisions/node-cli-committed-bundle.md](/.agents/decisions/node-cli-committed-bundle.md) — why `dist/cli.mjs` is committed; this record adds the require-shim wrinkle.
- [components/claudemux-core.md](/.agents/components/claudemux-core.md) — module table now lists the codex-* modules.
- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — §8 marks stage 4 as landed in the same change.
