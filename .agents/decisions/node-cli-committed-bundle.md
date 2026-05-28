# `tm` ships as a committed esbuild bundle + thin Node launcher

- **Status:** Superseded by [zero-install-type-stripping](./zero-install-type-stripping.md)
- **Date:** 2026-05-23
- **Affects:** the **`next`** line's production install path — [`plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm), `plugins/claudemux/dist/cli.mjs`, the `claudemux-core` CI job. Made when stage 3c retired the bash `bin/tm` ([roadmap](/.agents/domains/node-cli-orchestrator.md) §8).

## Context

Retiring the bash `bin/tm` means the production PATH entry has to find and
launch the TypeScript codebase under `core/`. A Claude Code marketplace plugin
install is `git clone` of `plugins/<plugin>/` — there is **no `npm install`
step**, so anything the launcher needs at runtime has to be present in the
repo already. Three shapes were on the table:

- **(A) Vendor `tsx`** — the dev launcher `core/bin/tm` already
  `exec`s `tsx` against `src/main.ts`. Make `/claudemux:setup` (or a postinstall
  hook) run `npm install --omit=dev` inside `core/` so production users get the
  same path. **Rejected:** requires a setup-time `npm install`, a network
  dependency, and ~150 ms `tsx` cold-start per invocation; users who skip the
  setup step land on a broken `tm`.
- **(B) `--experimental-strip-types`** — Node 22.6+ can run TypeScript with
  no transpiler. **Rejected** in stage 3b: extensionless relative imports
  (`./paths`, `./tmux`) break the experimental loader, and the rewrite uses
  ESM-style imports throughout.
- **(C) Pre-built bundle, committed.** Bundle `src/main.ts` with esbuild
  into a single self-contained ES module, commit it under `core/dist/`, and
  ship a small launcher that `exec`s `node` against the bundle. **Chosen.**

## Decision

`tm` is two thin layers:

- [`plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm) — ~20 lines of
  bash that checks `node` is on `PATH`, locates
  `core/dist/cli.mjs`, and `exec`s
  `node` against it with the forwarded argument vector. No `set -o pipefail`,
  no logic; the bundle owns every decision.
- `core/dist/cli.mjs` — an esbuild
  bundle of `src/main.ts`, produced by
  `npm run build` (`esbuild ... --bundle --platform=node --target=node22
  --format=esm --banner:js="#!/usr/bin/env node"`). One self-contained file,
  ~77 KB, with no runtime npm dependencies.

The bundle is committed to the repo so a marketplace install needs only
`node` on `PATH`. To keep the committed bundle honest, the `claudemux-core`
CI job rebuilds it from current source and runs `git diff --exit-code dist/`
— a feature commit that changes `core/src/` without re-running `npm run
build` fails CI.

For development the **dev launcher** at
`core/bin/tm` keeps `exec`ing `tsx` against
`src/main.ts`, so source edits take effect with no rebuild. The
live-teammate integration suite points `CLAUDEMUX_TM` at it.

## Why this shape

- **No setup-time `npm install`.** A marketplace user runs `tm` immediately
  after install; the launcher has every dependency it needs.
- **Cold-start cost is small.** Node + bundle warmup is ~30 ms on a warm Mac
  vs. `tsx`'s ~150 ms — relevant only because some dispatcher flows fire
  `tm` in tight loops (e.g. `tm states` polling).
- **Bundle-vs-source diff is easy to read.** The committed `dist/cli.mjs`
  is generated; a reviewer reads the `core/src/` diff and treats the `dist/`
  diff as derived. CI's `git diff --exit-code` enforces that the two move
  together — a stale bundle never lands.
- **Production and dev share `src/`.** Both launchers run the same
  `src/main.ts`; the only difference is the runtime that reads it. Tests
  exercise `src/` directly through vitest, so the bundle is never a separate
  code path under test.

## Reviewer guidance — how to read a `dist/` change

In a PR that touches `core/src/`:

1. Read the `core/src/` diff for the behavioral change.
2. Confirm `core/dist/cli.mjs` was updated in the same commit. The size
   should change roughly in proportion to the source change; the diff itself
   is minified-ish bundle output (one big concatenation), so review it for
   *presence and locality* rather than line-by-line.
3. If the source is non-trivial, run `npm run build` locally and confirm
   the rebuilt bundle matches the committed one (or wait for CI's
   `dist not stale` step).

A bundle change without a matching `core/src/` change is the bug.

## Consequences

- One more file to keep in mind: every `core/src/` change pairs with a
  re-`npm run build` and a `dist/cli.mjs` commit. The pre-commit hook does
  *not* enforce this today (the CI step does); we can add a hook later if
  it becomes a recurring footgun.
- The bundle is a **build artifact** in the repo. Diff-noise on every
  source change is the cost, paid for the marketplace-friendly install
  story.
- `esbuild` is a dev dependency. The set of dev tools in `core/package.json`
  grows by one — also `tsx` for the dev launcher, `vitest` for tests,
  `typescript` for typecheck.
