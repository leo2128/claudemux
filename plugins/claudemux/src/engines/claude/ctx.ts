/**
 * Claude-engine `tm ctx` body — report a teammate's transcript context
 * window usage.
 *
 * Two entry points keep the strangler clean:
 *
 *  - `claudeCtxLine(name, windowOverride, env)` is the byte-exact text
 *    the legacy `tm ctx` printed per teammate (including the
 *    `? (no sid / no transcript / no usage)` soft-fails so a `--all`
 *    fan-out keeps going across teammates with no readable transcript).
 *    The CLI fan-out wrapper still emits this verbatim.
 *  - `claudeCtxUsage(name, env)` is the structured `ContextResult` the
 *    Engine interface speaks in — same numbers, no formatting.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { encodeProjectDir } from '../../persistence/paths'
import { cwdFile } from '../../persistence/paths'
import { readSid } from './state'
import type { ContextResult, TeammateName } from '../types'

export interface ClaudeCtxEnv {
  readonly dispatcherDir: string
  readonly projectsDir: string
}

/** A teammate's context-window usage, summed from its transcript. */
export interface CtxUsage {
  /** Tokens in the last assistant turn — input plus both cache reads. */
  used: number
  /** Output tokens of the last assistant turn. */
  out: number
  /** The largest `used`-style total across every assistant turn. */
  peak: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sum the cache-inclusive input tokens of one `message.usage` object. */
function usageInput(usage: Record<string, unknown>): number {
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return (
    num(usage['input_tokens']) +
    num(usage['cache_creation_input_tokens']) +
    num(usage['cache_read_input_tokens'])
  )
}

function readIfNonEmpty(file: string): string | null {
  try {
    if (statSync(file).size === 0) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The Claude Code transcript file for a teammate session under `projectsDir`. */
export function transcriptFile(projectsDir: string, cwd: string, sid: string): string {
  return join(projectsDir, encodeProjectDir(cwd), `${sid}.jsonl`)
}

/**
 * The most recent assistant turn's joined text from a Claude Code
 * transcript jsonl, or `''` when no text-bearing assistant entry exists
 * (unreadable file, malformed entries, tool-only/thinking-only turns).
 *
 * Walks the parsed entries from end to start, picks the first assistant
 * entry whose `message.content` carries at least one non-empty `text`
 * block, and returns those text blocks joined with `''` — the on-stop
 * hook's `extract_last_turn` shape for a single assistant entry.
 *
 * Used by `tm spawn --resume` to seed `<sid>.last` with the prior turn's
 * deliverable so the dispatcher has something to re-read after the
 * relaunch, even before the next turn fires.
 */
export function readLastAssistantText(jsonlPath: string): string {
  let content: string
  try {
    content = readFileSync(jsonlPath, 'utf8')
  } catch {
    return ''
  }
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isPlainObject(entry)) continue
    if (entry['type'] !== 'assistant') continue
    const message = entry['message']
    if (!isPlainObject(message)) continue
    const arr = message['content']
    if (!Array.isArray(arr)) continue
    const texts: string[] = []
    for (const item of arr) {
      if (!isPlainObject(item)) continue
      if (item['type'] !== 'text') continue
      const t = item['text']
      if (typeof t === 'string') texts.push(t)
    }
    const joined = texts.join('')
    if (joined.length > 0) return joined
  }
  return ''
}

/**
 * Read a teammate's ctx usage from its transcript jsonl — the native
 * form of the `jq -s` pass `tm`'s `_ctx_format_line` ran. Collects
 * every assistant entry's `message.usage`: `used` / `out` come from the
 * last one, `peak` is the max input across all. Returns `null` when
 * there is no usable usage; that includes the cases where `jq -s`
 * itself would have failed (a non-object entry, a non-object
 * `.message` / `.message.usage`).
 */
export function readCtxUsage(jsonl: string): CtxUsage | null {
  let content: string
  try {
    content = readFileSync(jsonl, 'utf8')
  } catch {
    return null
  }
  const inputs: number[] = []
  let lastOut = 0
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return null
    }
    if (entry === null) continue
    if (!isPlainObject(entry)) return null
    if (entry['type'] !== 'assistant') continue
    const message = entry['message']
    if (message === null || message === undefined) continue
    if (!isPlainObject(message)) return null
    const usage = message['usage']
    if (usage === null || usage === undefined) continue
    if (!isPlainObject(usage)) return null
    inputs.push(usageInput(usage))
    lastOut = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
  }
  if (inputs.length === 0) return null
  let peak = inputs[0]!
  for (const value of inputs) if (value > peak) peak = value
  return { used: inputs[inputs.length - 1]!, out: lastOut, peak }
}

/**
 * The byte-exact per-teammate `tm ctx` line. `windowOverride` is `''`,
 * `'200k'`, or `'1m'`. Soft-fails to a `? (...)` diagnostic so a
 * `--all` fan-out keeps going.
 */
export function claudeCtxLine(
  name: TeammateName,
  windowOverride: string,
  env: ClaudeCtxEnv,
): string {
  const sid = readSid(name)
  if (sid === null) return `${name}: ? (no sid file)`

  const recordedCwd = readIfNonEmpty(cwdFile(name))
  const cwd =
    recordedCwd !== null ? recordedCwd.replace(/\n+$/, '') : `${env.dispatcherDir}/${name}`
  const jsonl = transcriptFile(env.projectsDir, cwd, sid)
  if (!isRegularFile(jsonl)) return `${name}: ? (no transcript at ${jsonl})`

  const usage = readCtxUsage(jsonl)
  if (usage === null) return `${name}: ? (no assistant usage in transcript)`

  const next = usage.used + usage.out
  let window: number
  let note: string
  if (windowOverride === '1m') {
    window = 1000000
    note = 'flag'
  } else if (windowOverride === '200k') {
    window = 200000
    note = 'flag'
  } else if (usage.peak > 210000) {
    window = 1000000
    note = 'detected 1M'
  } else {
    window = 200000
    note = 'assumed 200k'
  }
  const pct = Math.floor((usage.used * 100) / window)
  const wlabel = window >= 1000000 ? '1M' : '200k'
  return `${name}: ${usage.used} tokens · ~${next} next turn · ${pct}% of ${wlabel} (${note})`
}

/**
 * Structured `ContextResult` for `ClaudeEngine.ctx`. Returns `kind:
 * 'not-supported'` when the transcript or usage is unreadable — the
 * verb-layer formatter renders the same `? (...)` line a future
 * EngineRegistry dispatch would emit.
 */
export function claudeCtxUsage(name: TeammateName, env: ClaudeCtxEnv): ContextResult {
  const sid = readSid(name)
  if (sid === null) return { kind: 'not-supported', reason: `no sid file for ${name}` }
  const recordedCwd = readIfNonEmpty(cwdFile(name))
  const cwd =
    recordedCwd !== null ? recordedCwd.replace(/\n+$/, '') : `${env.dispatcherDir}/${name}`
  const jsonl = transcriptFile(env.projectsDir, cwd, sid)
  if (!isRegularFile(jsonl)) {
    return { kind: 'not-supported', reason: `no transcript at ${jsonl}` }
  }
  const usage = readCtxUsage(jsonl)
  if (usage === null) {
    return { kind: 'not-supported', reason: `no assistant usage in transcript for ${name}` }
  }
  const window = usage.peak > 210000 ? 1000000 : 200000
  return {
    kind: 'usage',
    tokensUsed: usage.used,
    tokensTotal: window,
    pct: Math.floor((usage.used * 100) / window),
  }
}
