/**
 * Phase 1 stub for `ClaudeTeammateRecord`. Decision 0024 §"TeammateRecord"
 * lists the engine-private extensions the Claude engine owns —
 * `/tmp/teammate-<name>.cwd` (plain text, the SessionStart hook's
 * sed-only fast path), `/tmp/teammate-<name>.sid`, `/tmp/teammate-<name>.ready`,
 * `/tmp/teammate-<name>.send-at` — plus the tmux session-name encoding
 * for nested teammate names like `flow/flow-1` (decision 0024 §"Nested
 * teammate names").
 *
 * Phase 2a lands the concrete file builders, the encoding, and the
 * `engineExtensionFiles()` body. This stub gives Phase 2a a stable
 * import target and forces a `not implemented in Phase 1` to surface
 * loudly if any code path tries to use the Claude engine before its
 * implementation lands.
 */

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'

/** Per-teammate file fan-out for the Claude engine — Phase 2a implements. */
export interface ClaudeTeammateExtension {
  /** `/tmp/teammate-<name>.cwd` — sed-readable plain text, hook-consumed. */
  cwd: string
  /** `/tmp/teammate-<name>.sid` — Claude session id; updated by SessionStart on `/clear`. */
  sid: string
  /** `/tmp/teammate-<name>.ready` — touched by SessionStart, cleared by spawn. */
  ready: string
  /** `/tmp/teammate-<name>.send-at` — touched per send for pane-quiet timing. */
  sendAt: string
}

/**
 * Encode a (possibly nested) teammate name into a tmux session name.
 *
 * tmux session names cannot contain `/`, so the Claude engine needs a
 * round-tripping encoding. The single builder is the change-once seam
 * decision 0004's path-builder discipline asks for. Phase 2a chooses
 * the exact character; Phase 1 surfaces a `not implemented` so no
 * downstream code accidentally reads a raw name as a tmux identifier.
 */
export function tmuxSessionName(_name: TeammateName): string {
  throw new Error(
    'tmuxSessionName: not implemented in Phase 1 — Phase 2a lands the Claude engine',
  )
}

export class ClaudeTeammateRecord extends TeammateRecord {
  readonly engine: EngineKind = 'claude'

  constructor(args: {
    name: TeammateName
    cwd: string
    createdAt: number
    displayName: string | null
  }) {
    super(args)
  }

  override engineExtensionFiles(): readonly string[] {
    throw new Error(
      'ClaudeTeammateRecord.engineExtensionFiles: not implemented in Phase 1 — Phase 2a lands the Claude engine',
    )
  }
}
