/**
 * Claude-engine `tm last` body — reprint a teammate's last-turn reply.
 *
 * The verb resolves the teammate's sid via the on-disk marker, then
 * returns the verbatim content of `<sid>.last`. Two empty states are
 * both "no reply yet": the file missing, or present but zero bytes.
 *
 * Returns a structured result so `ClaudeEngine.last` can pass it through
 * unchanged and the verb-layer formatter renders the right
 * `TmResult`. The `message` field carries the bare diagnostic text
 * without a `tm:` prefix — the formatter adds that.
 */

import { readFileSync, statSync } from 'node:fs'

import { lastFileFor, sidFile } from '../../persistence/paths'
import { readSid } from './state'
import type { TeammateName, TextResult } from '../types'

/** Read a file only if it exists and is non-empty (`tm`'s `[[ -s file ]]`). */
function readIfNonEmpty(file: string): string | null {
  try {
    if (statSync(file).size === 0) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function claudeLast(name: TeammateName): TextResult {
  const sid = readSid(name)
  if (sid === null) {
    return {
      kind: 'failed',
      message:
        `no sid file for ${name} at ${sidFile(name)} — was this teammate ` +
        "spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)",
    }
  }
  const file = lastFileFor(sid)
  const reply = readIfNonEmpty(file)
  if (reply === null) {
    return {
      kind: 'failed',
      message:
        `no reply yet for ${name} (sid=${sid}) — file is missing or empty at ` +
        `${file}. Try 'tm wait ${name}' to block for the next Stop, or ` +
        `'tm send ${name} --prompt "..."' to drive a turn.`,
    }
  }
  return { kind: 'text', text: reply }
}
