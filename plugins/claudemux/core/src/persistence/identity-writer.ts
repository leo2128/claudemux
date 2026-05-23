/**
 * `IdentityStoreWriter` — the verb-layer-facing seam for the identity
 * file. Decision 0024 §"Verb is the abstraction" pulls `VerbContext`'s
 * `identity` field out as an interface so the verb code does not import
 * the persistence module directly; the Phase 1 `NoopIdentityStore` lives
 * in `verbs/context.ts`, and Phase 2a's production implementation lives
 * here.
 *
 * The only mutation verbs trigger is `remove(name)` — `killVerb` calls it
 * after a successful kill so a later `tm spawn` of the same name is not
 * blocked by a stale record. Spawn-time `reserve` and per-verb reads go
 * through `persistence/identity-store.ts` directly (the verb file owns
 * the rest of the spawn flow).
 */

import { remove as removeIdentity } from './identity-store'
import type { IdentityStore } from '../verbs/context'
import type { TeammateName } from '../engines/types'

/** Production `IdentityStore` — deletes the JSON file. Idempotent. */
export class ProductionIdentityStore implements IdentityStore {
  async remove(name: TeammateName): Promise<void> {
    removeIdentity(name)
  }
}
