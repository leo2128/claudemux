/**
 * Identity migration for Claude teammates was a one-shot helper that
 * materialised `/tmp/teammate-<name>.json` from a live tmux session
 * or pre-JSON `.cwd` / `.sid` markers (schema 1). The schema 2 cut
 * removed that path: any live teammate predating the new layout no
 * longer has a recordable `repo` field, so the migrator returns a
 * no-op. The verb layer reports the record as missing and the user
 * `tm kill`s + `tm spawn`s to recover.
 */

import type { NativeEnv } from '../../env'
import type { IdentityMigrator } from '../../identity/router'

export function createClaudeIdentityMigrator(_env: NativeEnv): IdentityMigrator {
  return async () => {}
}
