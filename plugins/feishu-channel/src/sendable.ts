/**
 * Outbound file guard for the reply tool.
 *
 * The reply tool accepts arbitrary file paths to attach. Without a guard,
 * Claude could be steered into attaching the channel's own state files
 * (access.json, .env) and leaking credentials or the allowlist. `assertSendable`
 * refuses any path inside the state directory, except the inbox subtree where
 * inbound attachments legitimately live.
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Throw if `file` resolves to somewhere inside `stateDir` other than
 * `inboxDir`. Symlinks are resolved on both sides first, so a link that points
 * back into the state tree is also caught.
 *
 * `stateDir` and `inboxDir` should be absolute. A `file` that does not exist
 * is allowed through — the caller's own existence/size check rejects it, and
 * a path that cannot be resolved cannot be inside the protected tree.
 */
export function assertSendable(file: string, stateDir: string, inboxDir: string): void {
  let realState: string
  try {
    realState = realpathSync(stateDir)
  } catch {
    return // No state directory yet — nothing to protect.
  }

  let realFile: string
  try {
    realFile = realpathSync(file)
  } catch {
    return // File does not exist — defer to the caller's existence check.
  }

  if (!isWithin(realFile, realState)) return

  let realInbox: string | undefined
  try {
    realInbox = realpathSync(inboxDir)
  } catch {
    realInbox = undefined
  }
  if (realInbox !== undefined && isWithin(realFile, realInbox)) return

  throw new Error(`refusing to send channel state file: ${file}`)
}

/** True when `target` is `dir` itself or a descendant of it. */
function isWithin(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + sep)
}
