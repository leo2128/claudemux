/**
 * Identity migration for Codex daemons spawned before the schema 2
 * cut. Schema 2 added `repo` / `worktreeSlug` fields the daemon's
 * `meta.json` does not carry, so the migrator returns a no-op. A
 * straggler Codex daemon predating the upgrade surfaces as a
 * missing identity; the user `tm kill`s and `tm spawn`s to recover.
 */

import type { NativeEnv } from '../../env'
import type { IdentityMigrator } from '../../identity/router'

export function createCodexIdentityMigrator(_env: NativeEnv): IdentityMigrator {
  return async () => {}
}
