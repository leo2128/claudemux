import { defineConfig } from 'vitest/config'

/**
 * Config for the live Feishu integration test.
 *
 * `test/feishu-live.ts` is deliberately not a `*.test.ts` file, so the default
 * `npm test` run (vitest's default `include`) never discovers it — a developer
 * with no credentials, and a fork pull request with no secrets, never run it.
 * CI runs it explicitly: `vitest run --config vitest.live.config.ts`. Vitest
 * only auto-loads `vitest.config.*` / `vite.config.*`, so this file is picked
 * up by `--config` alone and never by the default run.
 */
export default defineConfig({
  test: {
    include: ['test/feishu-live.ts'],
  },
})
