/**
 * Phase 1 stub for `CodexTeammateRecord`. Decision 0024 §"TeammateRecord"
 * inventories the Codex engine's per-teammate state under
 * `/tmp/teammate-codex/<name>/{pid,socket,thread,started-at,last-seen,
 * meta.json}` — that registry directory is the engine-private extension
 * for the Codex engine, mirroring how `.cwd`/`.sid`/`.ready`/`.send-at`
 * extend the Claude side.
 *
 * Phase 2b lands the daemon supervisor, the socket path builder, and
 * the `engineExtensionFiles()` body that `tm doctor` enumerates. This
 * stub gives Phase 2b a stable import target and forces a `not
 * implemented in Phase 1` to surface loudly if a code path tries to
 * use the Codex engine before its implementation lands.
 */

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'

/** Per-teammate registry directory shape for the Codex engine — Phase 2b implements. */
export interface CodexTeammateExtension {
  /** `/tmp/teammate-codex/<name>/` — root directory; `mkdir -p` handles nested names. */
  root: string
  /** `<root>/pid` — daemon process id, written at spawn. */
  pid: string
  /** `<root>/socket` — Unix socket path (`--listen unix://…`). */
  socket: string
  /** `<root>/thread` — current thread id after first `thread/start`. */
  thread: string
  /** `<root>/started-at` — wall-clock seed for doctor timing. */
  startedAt: string
  /** `<root>/last-seen` — refreshed per round-trip for liveness. */
  lastSeen: string
  /** `<root>/meta.json` — engine-private JSON; not the base TeammateRecord. */
  meta: string
}

export class CodexTeammateRecord extends TeammateRecord {
  readonly engine: EngineKind = 'codex'

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
      'CodexTeammateRecord.engineExtensionFiles: not implemented in Phase 1 — Phase 2b lands the Codex engine',
    )
  }
}
