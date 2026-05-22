import { defineConfig } from 'vitest/config'

/**
 * Config for the live-teammate integration suite (`test/integration/*.itest.ts`).
 *
 * The `*.itest.ts` files are deliberately not `*.test.ts`, so the default
 * `npm test` run (vitest's default `include`) never discovers them — they
 * spawn real `claude` teammates, are slow, and need a working Claude Code
 * install, so they must not run in CI or an ordinary unit-test pass. vitest
 * only auto-loads `vitest.config.*` / `vite.config.*`, so this file is reached
 * solely by `--config`:
 *
 *   npx vitest run --config vitest.integration.config.ts
 *
 * `test/integration/harness.test.ts` is a normal `*.test.ts` (unit tests for
 * the harness's pure pieces) and is intentionally outside this `include` — it
 * runs in the default `npm test` pass instead.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.itest.ts'],
    // Each test is a real Claude Code turn; `tm` self-bounds with its own
    // `--timeout`, and this is the backstop for a wedged process.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    // One teammate at a time — never spawn parallel REPLs from one run.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
