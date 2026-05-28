import { homedir } from 'node:os'
import { join } from 'node:path'

import { runColumn } from '../column'
import { createClaudeIdentityMigrator } from '../engines/claude/identity-migration'
import { createCodexIdentityMigrator } from '../engines/codex/identity-migration'
import { productionRegistry } from '../engines/production'
import type { EngineContext } from '../engines/types'
import type { NativeEnv } from '../env'
import { runGrep } from '../grep'
import { ProductionTeammateRouter } from '../identity/router'
import { ProductionIdentityStore } from '../persistence/identity-writer'
import { runTmux } from '../tmux'
import type { VerbContext } from '../verbs/context'

/**
 * The verb-side context the engine-routed verbs consume. The router reads
 * the identity JSON; the migrators only materialise that JSON for live
 * teammates spawned before the identity store existed.
 */
export function productionVerbContext(env: NativeEnv): VerbContext {
  const registry = env.engines ?? productionRegistry(env)

  const migrateCodexIdentity = createCodexIdentityMigrator(env)
  const migrateClaudeIdentity = createClaudeIdentityMigrator(env)
  const router = new ProductionTeammateRouter(registry, async (name) => {
    await migrateCodexIdentity(name)
    await migrateClaudeIdentity(name)
  })

  const engineContext: EngineContext = { now: () => Date.now(), env: process.env }
  return {
    engines: registry,
    router,
    engineContext,
    identity: new ProductionIdentityStore(),
    runColumn: env.runColumn,
  }
}

/** The production `NativeEnv` — the real backends, resolved once per invocation. */
export function productionEnv(): NativeEnv {
  const env: NativeEnv = {
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or
    // `$PWD` (bash's `${TM_DISPATCHER_DIR:-$PWD}`). Two semantics matter:
    //   - `$PWD` is the *logical* cwd, preserving the symlink the user
    //     `cd`'d through; Node's `process.cwd()` would return the
    //     symlink-resolved physical path, and `~/.claude/projects`
    //     lookups would diverge between bash and native on a symlinked
    //     dispatcher tree.
    //   - bash `${VAR:-default}` triggers the default on *unset* OR
    //     *empty*, so `||` (which treats empty strings as falsy) is the
    //     right operator — `??` would let an accidentally-empty
    //     `TM_DISPATCHER_DIR` through and resolve `<repo>` paths against
    //     `""`.
    dispatcherDir: process.env.TM_DISPATCHER_DIR || process.env.PWD || process.cwd(),
    projectsDir: join(process.env.HOME ?? homedir(), '.claude', 'projects'),
  }
  return { ...env, engines: productionRegistry(env) }
}
