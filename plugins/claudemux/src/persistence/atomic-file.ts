/**
 * Atomic file primitives.
 *
 * Decision multi-engine-tui-architecture §"TeammateRecord" gives the registry layer one rule: writes
 * to `/tmp/teammate-<name>.json` are atomic, so a verb that reads the file
 * mid-write never sees a half-written record. Atomic on POSIX is
 * write-tmp-then-rename(2): a rename onto an existing path is a single
 * dentry swap and another reader observes either the old contents or the
 * new contents, never a torn write.
 *
 * `reserveExclusive` is the matching primitive for the spawn path: create
 * the marker with `O_CREAT | O_EXCL` so a second concurrent `tm spawn` of
 * the same name fails immediately. The registry layer uses this to enforce
 * the "cross-engine name reuse is forbidden" rule (decision codex-engine-flag §4 carried
 * forward by multi-engine-tui-architecture).
 *
 * Both functions go through this module rather than scattering
 * `writeFileSync` calls at the use sites — the next refactor that wants to
 * swap in `fs/promises` or add fsync semantics changes one file.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write `content` to `path` atomically. The path's directory is created if
 * it doesn't exist. Concurrent readers see either the old contents (if any)
 * or the new contents — never a partial write.
 */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** Read a file; return `null` if it does not exist. Any other error throws. */
export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Create the file with content using `O_CREAT | O_EXCL` — fails with `EEXIST`
 * if the file already exists. The single-step exclusive create is the
 * registry layer's "reserve this name" primitive: a second concurrent spawn
 * of the same teammate cannot race past this point.
 */
export function reserveExclusive(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'wx')
  try {
    writeFileSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

/** Remove the file if it exists; no error if it doesn't. */
export function removeIfPresent(path: string): void {
  rmSync(path, { force: true })
}
