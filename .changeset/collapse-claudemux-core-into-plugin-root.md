---
"claudemux": patch
---

Collapse the `plugins/claudemux/core/` subdirectory into the plugin root so the plugin has a single `package.json` (the same shape `plugins/feishu-channel` already uses). `src/`, `test/`, `third_party/`, `resolver*.mjs`, `tsconfig.json`, `vitest.integration.config.ts`, `knip.json`, and `core/scripts/*` move up one level; the inner `core/package.json` and its `package-lock.json` are removed and the outer manifest absorbs the Node project fields (`type`, `engines`, `imports`, devDeps, test/typecheck/lint scripts). `bin/tm`'s `ROOT` resolution, `.changeset/config.json`'s `changedFilePatterns`, the CI job (switched from `npm ci` to workspace pnpm install), and the KB docs that describe current state are updated accordingly. Runtime behavior of `tm` is unchanged.

Also: move `bin/check-author` to `scripts/check-author` (it is a repo governance tool, not a user-facing executable) and remove two stale regression scripts (`bin/test-tm-mem`, `bin/test-tm-prompt-splat`) that targeted the pre-TypeScript Bash `tm` and no longer execute against current code.
