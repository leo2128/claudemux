/**
 * `<plugin-root>/bin/tm` and `<plugin-root>/.claude-plugin/plugin.json`
 * path computation, in one place.
 *
 * The relative-`..` math must run from a module that sits at the same
 * depth as the bundled `core/dist/cli.mjs` — esbuild inlines source
 * files into the bundle but binds `import.meta.url` to the *bundle's*
 * location, so a source file two directories deeper would resolve the
 * paths correctly when run under ts-node but emit a wrong answer in
 * the production bundle. This file lives at `core/src/plugin-root.ts`,
 * the same depth as `core/src/cli.ts` and the bundled
 * `core/dist/cli.mjs`, so the two-`..` walk works in both modes.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to `<plugin-root>/bin/tm`, the user-facing launcher. */
export function tmWrapperPath(): string {
  return join(pluginRoot(), 'bin', 'tm')
}

/** Absolute path to `<plugin-root>/.claude-plugin/plugin.json`. */
export function pluginJsonPath(): string {
  return join(pluginRoot(), '.claude-plugin', 'plugin.json')
}

function pluginRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return join(moduleDir, '..', '..')
}
