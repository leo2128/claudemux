/**
 * `<plugin-root>/bin/tm` and `<plugin-root>/.claude-plugin/plugin.json`
 * path computation, in one place.
 *
 * This file lives at `src/plugin-root.ts`; the single-`..` walk from its
 * `import.meta.url` lands at `plugins/claudemux/` regardless of how the
 * launcher invoked Node, so callers do not have to think about it.
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
  return join(moduleDir, '..')
}
