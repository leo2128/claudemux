/**
 * Claude-engine idle / sid utilities. The on-busy and on-stop hooks
 * write `/tmp/claude-idle/<sid>{,.busy,.last}` markers, and several
 * hot-path verbs need to clear or wait on those markers around a turn.
 *
 * Decision cross-process-cross-platform-invariants (path-builder discipline) keeps the marker paths in
 * `persistence/paths.ts`; this module composes them into the runtime
 * operations the verb bodies use.
 */

import { rmSync, statSync, readFileSync } from 'node:fs'

import {
  busyMarkerFor,
  idleMarkerFor,
  lastFileFor,
  sidFile,
} from '../../persistence/paths'
import { die } from './tmux'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'

/** Read a file only if it exists and is non-empty (`tm`'s `[[ -s file ]]`). */
export function readIfNonEmpty(file: string): string | null {
  try {
    if (statSync(file).size === 0) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Whether a path is a regular file (`tm`'s `[[ -f file ]]`). */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a path is a directory (`tm`'s `[[ -d path ]]`). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Strip trailing newlines (the effect of bash `$(cat ...)`). */
export function rstrip(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Read the recorded sid for a teammate — `tm`'s `resolve_sid`. */
export function resolveSid(name: TeammateName): string | null {
  const raw = readIfNonEmpty(sidFile(name))
  return raw === null ? null : rstrip(raw)
}

/**
 * `resolveSid` that dies with `tm`'s shared error when the sid is
 * missing. Returned in a discriminated shape the caller branches on.
 */
export function resolveSidOrDie(
  name: TeammateName,
): { sid: string } | { error: TmResult } {
  const sid = resolveSid(name)
  if (sid === null) {
    return {
      error: die(
        `no sid file for ${name} at ${sidFile(name)} — was this teammate ` +
          "spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)",
      ),
    }
  }
  return { sid }
}

/**
 * `tm`'s `clear_idle`: drop a sid's three hook artifacts together —
 * the idle marker, the `.last` text, and the `.busy` marker — so a later
 * wait/last sees the next turn, not a stale one. No-op for an empty sid.
 */
export function clearIdle(sid: string): void {
  if (sid === '') return
  for (const file of [idleMarkerFor(sid), lastFileFor(sid), busyMarkerFor(sid)]) {
    rmSync(file, { force: true })
  }
}
