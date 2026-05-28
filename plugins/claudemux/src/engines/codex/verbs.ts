/**
 * Thin CLI compatibility exports for Codex-specific callers and tests.
 *
 * The implementation is split by behavior boundary: daemon lifecycle,
 * turn-driving wrappers, state rows, and the `tm ask` pool-borrow path.
 * Engine-routed production verbs go through `verbs/<v>.ts` and
 * `CodexEngine`; this module remains a small compatibility surface.
 */

export { codexAsk } from './ask.js'
export { codexKill, codexSpawn, type CodexSpawnOptions } from './verb-lifecycle.js'
export { codexSend, codexWait } from './verb-turns.js'
export { codexStateRows } from './verb-state.js'
export { subscribeTurnCollection } from './events.js'
export type { TurnCompletedNotification } from './events.js'
