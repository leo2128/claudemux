# `tm` runs TypeScript sources directly under Node type-transform; ws is vendored

- **Status:** Accepted
- **Date:** 2026-05-24
- **Supersedes:** [node-cli-committed-bundle](./node-cli-committed-bundle.md)
- **Affects:** [`plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm), [`plugins/claudemux/src/`](/plugins/claudemux/src/), [`plugins/claudemux/third_party/`](/plugins/claudemux/third_party/), the `claudemux-core` CI job.

## Context

[node-cli-committed-bundle](./node-cli-committed-bundle.md) decided to commit an esbuild
bundle (`core/dist/cli.mjs`) and ship the launcher around it. The chosen
shape worked, but two costs accumulated:

- Every `core/src/` change required re-running `npm run build` and
  committing the regenerated `dist/cli.mjs`. The CI `dist not stale` gate
  caught omissions but at the price of a noisy `dist/` diff on every PR.
- A user who ran `git pull` on the marketplace cache (the dispatcher's
  development workflow) did **not** get plugin updates: the bundle was the
  thing that needed rebuilding, the user had no `node_modules/`, and
  `/reload-plugins` did not rebuild. The phase-3 plan called this gap out
  explicitly as deferred.

Two facts shifted what [node-cli-committed-bundle](./node-cli-committed-bundle.md) ruled out:

- **Node 22.7+ ships `--experimental-transform-types`.** Unlike the
  strip-only mode the prior decision evaluated, transform mode supports
  parameter properties — which our TypeScript classes such as
  `ProductionTeammateRouter` use.
- **The orchestration core has one runtime npm dependency: `ws`.** Every
  other import in [`core/src/`](/plugins/claudemux/src/) is either
  a `node:` built-in or a relative path. Vendoring one package is a
  one-time cost; vendoring an open-ended dependency graph would not be.

## Decision

`tm` runs TypeScript source directly. No build step, no `npm install`.

- [`plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm) — the launcher
  execs
  `node --import core/resolver-register.mjs --experimental-transform-types --no-warnings core/src/main.ts`.
  `--no-warnings` suppresses the per-launch `ExperimentalWarning` Node
  prints for the transform flag; nothing else relies on Node warnings, so
  the trade is clean.
- [`plugins/claudemux/resolver.mjs`](/plugins/claudemux/resolver.mjs)
  + [`resolver-register.mjs`](/plugins/claudemux/resolver-register.mjs)
  — a ~50-line ESM resolve hook that lets Node's TypeScript pipeline
  accept the extension-less and `.js` import specifiers already present in
  the tree. The hook is mounted only by the launcher; vitest's own
  resolver handles the same shapes for the test suite.
- [`plugins/claudemux/third_party/ws/`](/plugins/claudemux/third_party/ws/)
  — the upstream `ws@8.21.0` runtime files (MIT), committed verbatim with
  `LICENSE` and an `UPSTREAM.md` describing the update procedure.
- The core `package.json` declares `"imports": { "#ws": "./third_party/ws/wrapper.mjs" }`;
  the three call sites that used to `import 'ws'` import `#ws`. Both Node
  and vitest honor the `imports` map without a hook.
- A `src/ws-types.d.ts` shim re-declares the `@types/ws` surface against
  `#ws` so `tsc --noEmit` follows imports without a `paths`-mapping
  trick. `@types/ws` stays in `devDependencies`.

## Why this shape

- **Zero install for users.** A `git pull` on the marketplace cache or a
  fresh clone of this repo gives the user a working `tm` immediately, with
  no follow-up step. This is a hard constraint, not a convenience: Claude
  Code installs and upgrades a plugin by syncing its files and never runs
  `npm install` for one, so any dependency that is not committed is simply
  absent at runtime — which is the whole reason `ws` is vendored rather than
  declared. The only host requirement is Node 22.7+, the version
  where `--experimental-transform-types` shipped — that flag is the entire
  basis for the Node-version floor; nothing else here pins a higher one.
- **The 1500 relative imports stay untouched.** Sweeping them to add `.ts`
  extensions would be permanent maintenance debt — the codex-protocol
  bindings under `src/codex-protocol/` are emitted by
  `codex app-server generate-ts` with extension-less imports, and the CI
  `codex-protocol not stale` gate would push any extension-sweep back the
  next time codex is bumped. The resolve hook isolates the rewrite to one
  ~50-line file.
- **One npm runtime dep was worth vendoring.** `ws` is a well-known MIT
  WebSocket client/server with a small surface (`index.js` + `lib/*.js`).
  The upstream ships an ESM facade at `wrapper.mjs` that imports those
  CJS files directly; consuming `wrapper.mjs` from our type-transformed
  ESM sources stays an ESM-imports-CJS edge, which Node has supported
  well before the type-transform flag itself — so vendoring adds no
  Node-version constraint of its own.
- **vitest does not need the hook.** Test discovery and module loading go
  through vitest's own esbuild-based resolver, which handles
  extension-less imports natively; the hook is only mounted in the
  production launcher's `node` invocation.

## Why each alternative loses

- **(A) Keep the committed bundle (the prior committed-bundle decision).** Still works, but stale-bundle
  diffs land in every PR and `git pull` does not deliver a usable plugin
  update until the user reruns the build. Both costs go away with this
  decision.
- **(B) `npm install` at setup.** Adds a network dependency, a
  user-visible step that fails on locked-down machines, and a per-machine
  state mismatch where one user's `node_modules/` lags another's. Already
  rejected in the prior committed-bundle decision for the same reason; nothing has changed.
- **(C) Sweep imports to `.ts` extensions.** Would let us drop the hook,
  but the codex-protocol generator overwrites the sweep every codex bump.
  A hook is the strictly smaller surface.
- **(D) Vendor `tsx`.** Pulls in a ~MB-scale dependency tree to do what
  ~50 lines of resolver + Node's native type stripping already do.

## Consequences

- **CI changes.** The `claudemux-core` job drops the `Build bundle` and
  `dist not stale` steps; a new smoke step hides `node_modules/` and
  invokes `../bin/tm --help` so a regression that quietly resolves `ws`
  through `node_modules` instead of `#ws` is caught.
- **Pre-commit hook scope grows.** The `feature_class_globs` for
  `claudemux` now includes `core/resolver.mjs`,
  `core/resolver-register.mjs`, and `core/third_party/*` — touching any
  of them is runtime-affecting and warrants a changeset.
- **Per-launch overhead.** Node parses the TypeScript surface every
  invocation; on a warm Mac the cold-start cost moves from ~30 ms (bundle)
  to ~120 ms (transform on every file). `tm states` polling is the only
  hot path; if it shows up in dispatcher latency budgets we can revisit
  with a bytecode-cache or a `--experimental-strip-types` lane for a
  trimmed subset.
- **Minimum Node version bumps from 22.0 to 22.7.** 22.7 is where
  `--experimental-transform-types` ships. The vendored `ws` reaches its
  CJS lib files through the upstream ESM `wrapper.mjs`, which Node has
  supported well before 22.7 — so the launcher's `node`-version guard is
  bounded only by the transform-types flag itself. Documented in
  `README.md`'s Requirements table, the launcher's preflight, and the
  `claudemux-core` CI job (which pins one matrix slot to the declared
  minimum so a regression against it shows up on CI rather than at install
  time on a user machine).
