/**
 * `tm history` — inspect a teammate name's past Claude Code sessions.
 *
 * Two modes: a list view (every transcript jsonl, newest first) and a
 * detail view (one chosen transcript's headers + first prompt + last
 * assistant text). Both modes parse the transcript jsonl natively,
 * mirroring the `jq -s` / `jq` passes `bin/tm`'s `cmd_history` ran.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { encodeProjectDir } from '../../persistence/paths'
import { fmtAge, fmtLocalDateTime } from './clock'
import { isDirectory, isRegularFile, resolveSid } from './idle'
import { dieRepoNotFound, projectDirForCwd } from './repo-fs'
import { die } from './tmux'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'
import type { HistoryListEntry } from '../types'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One-decimal string of `value`, rounding a `.x5` tie to even — C
 * `printf`'s `%.1f`, which `fmt_size`'s `awk` uses. `Number.toFixed`
 * rounds half away from zero, so it would print `1.3M` where `awk`
 * prints `1.2M` for a file of exactly 1.25 MiB; this keeps the size
 * cells byte-identical to `tm`.
 */
function toFixed1HalfEven(value: number): string {
  const tenths = value * 10
  const floor = Math.floor(tenths)
  const frac = tenths - floor
  let rounded: number
  if (frac < 0.5) rounded = floor
  else if (frac > 0.5) rounded = floor + 1
  else rounded = floor % 2 === 0 ? floor : floor + 1
  return (rounded / 10).toFixed(1)
}

/** Format a byte count as a short human size — `tm`'s `fmt_size`. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${Math.trunc(bytes / 1024)}K`
  if (bytes < 1073741824) return `${toFixed1HalfEven(bytes / 1048576)}M`
  return `${toFixed1HalfEven(bytes / 1073741824)}G`
}

/** `tm`'s `sed -E 's/T/ /; s/\.[0-9]+Z?$//; s/Z$//'` on a transcript timestamp. */
function mungeCreated(ts: string): string {
  return ts.replace('T', ' ').replace(/\.[0-9]+Z?$/, '').replace(/Z$/, '')
}

/** Prefix every line of `text` with two spaces — `tm`'s `sed 's/^/  /'`. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** A bare-integer string's numeric value, as bash arithmetic reads it (`null` → 0). */
function bashNum(value: string): number {
  const n = Number(value)
  return Number.isInteger(n) ? n : 0
}

/**
 * The `text`-typed items of a transcript entry's `content` array.
 * Returns the list of their `.text` values when the array has at least
 * one text item, or `null` when it has none. Throws on a shape `jq`
 * errors on — a non-object array item, or a non-string non-null
 * `.text`.
 */
function contentTextItems(content: readonly unknown[]): string[] | null {
  let hasText = false
  const texts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item)) throw new Error('jq-fail')
    if (item.type === 'text') {
      hasText = true
      const t = item.text
      if (t === null || t === undefined) texts.push('')
      else if (typeof t === 'string') texts.push(t)
      else throw new Error('jq-fail')
    }
  }
  return hasText ? texts : null
}

/**
 * The prompt text of a `user` transcript entry — `tm`'s shared filter:
 * a string `content` is the text itself; an array `content` joins its
 * `text` items with a space. Returns `null` when the entry is not a
 * selectable user prompt.
 */
function userPromptText(entry: Record<string, unknown>): string | null {
  const message = entry.message
  if (message === null || message === undefined) return null
  if (!isPlainObject(message)) throw new Error('jq-fail')
  if (message.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = contentTextItems(content)
    return texts === null ? null : texts.join(' ')
  }
  return null
}

/** A `message.usage` object's cache-inclusive input total — `null` when every field is absent. */
function historyUsageSum(usage: unknown): number | null {
  if (!isPlainObject(usage)) throw new Error('jq-fail')
  let sum: number | null = null
  for (const key of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const value = usage[key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'number') throw new Error('jq-fail')
    sum = (sum ?? 0) + value
  }
  return sum
}

/** `jq`'s `tostring` on a usage sum: a number, or the literal `null`. */
function historyUsageStr(sum: number | null): string {
  return sum === null ? 'null' : String(sum)
}

/** First-line-of-first-user-prompt — `tm`'s `history_first_prompt`. */
function historyFirstPrompt(content: string): string {
  // `head -200`: a human first prompt sits near the file head, so the
  // scan is capped there. `jq` without `-s` reports a bad line and
  // moves on, so a parse error or a filter error skips that line
  // rather than failing.
  for (const line of content.split('\n').slice(0, 200)) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isPlainObject(entry) || entry.type !== 'user') continue
    let text: string | null
    try {
      text = userPromptText(entry)
    } catch {
      continue
    }
    if (text === null) continue
    return text.split('\n')[0] ?? ''
  }
  return ''
}

/** The `TOPIC` cell — first prompt, control chars stripped, 60 chars. */
function historyTopic(content: string): string {
  const stripped = [...historyFirstPrompt(content)].filter(
    (ch) => (ch.codePointAt(0) ?? 0) > 0x1f,
  )
  const topic = stripped.slice(0, 60).join('')
  return topic.length > 0 ? topic : '(no user prompt)'
}

interface HistoryData {
  firstPrompt: string
  lastAssistant: string
  createdTs: string
  used: string
  peak: string
}

const EMPTY_HISTORY: HistoryData = {
  firstPrompt: '',
  lastAssistant: '',
  createdTs: '',
  used: '',
  peak: '',
}

/**
 * Read a transcript's `history_detail` data — the native form of `tm`'s
 * `jq -r -s` pass. `jq -s` slurps the whole file: one unparseable line,
 * or any line `jq` errors while indexing, fails the entire pass — `tm`
 * catches that with `|| echo $'\t\t\t\t\t'`. So any such failure here
 * returns `EMPTY_HISTORY`, which renders identically to a transcript
 * that simply has no prompts, assistant text, or usage.
 */
function readHistoryData(content: string): HistoryData {
  try {
    const uPrompts: string[] = []
    const aTexts: string[] = []
    const usages: unknown[] = []
    const timestamps: unknown[] = []
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      const entry: unknown = JSON.parse(line)
      if (entry === null) continue
      if (!isPlainObject(entry)) throw new Error('jq-fail')
      if (entry.type === 'user') {
        const text = userPromptText(entry)
        if (text !== null) uPrompts.push(text)
      } else if (entry.type === 'assistant') {
        const message = entry.message
        if (message !== null && message !== undefined) {
          if (!isPlainObject(message)) throw new Error('jq-fail')
          if (Array.isArray(message.content)) {
            const texts = contentTextItems(message.content)
            if (texts !== null) aTexts.push(texts.join('\n'))
          }
          if (message.usage !== null && message.usage !== undefined) {
            usages.push(message.usage)
          }
        }
      }
      const ts = entry.timestamp
      if (ts !== null && ts !== undefined) timestamps.push(ts)
    }

    let createdTs = ''
    if (timestamps.length > 0) {
      const first = timestamps[0]
      if (first === false) createdTs = ''
      else if (typeof first === 'string') createdTs = first
      else throw new Error('jq-fail')
    }

    let used = ''
    let peak = ''
    if (usages.length > 0) {
      const sums = usages.map(historyUsageSum)
      used = historyUsageStr(sums[sums.length - 1] ?? null)
      let peakNum: number | null = null
      for (const sum of sums) {
        if (sum !== null && (peakNum === null || sum > peakNum)) peakNum = sum
      }
      peak = historyUsageStr(peakNum)
    }

    return {
      firstPrompt: (uPrompts[0] ?? '').replace(/\n+$/, ''),
      lastAssistant: (aTexts[aTexts.length - 1] ?? '').replace(/\n+$/, ''),
      createdTs,
      used,
      peak,
    }
  } catch {
    return EMPTY_HISTORY
  }
}

/**
 * Read list-mode rows for Claude Code sessions. `null` means the Claude
 * project directory does not exist; an empty array means it exists but has
 * no transcript files.
 */
function claudeHistoryListEntries(
  name: string,
  projectDir: string,
): readonly HistoryListEntry[] | null {
  if (!isDirectory(projectDir)) {
    return null
  }
  let names: string[]
  try {
    names = readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    names = []
  }
  if (names.length === 0) {
    return []
  }

  const liveSid = resolveSid(name) ?? ''
  const entries = names.map((name) => {
    const full = join(projectDir, name)
    const sidFull = name.replace(/\.jsonl$/, '')
    let mtimeMs = 0
    let size = 0
    try {
      const stat = statSync(full)
      mtimeMs = stat.mtimeMs
      size = stat.size
    } catch {
      mtimeMs = 0
      size = 0
    }
    let content = ''
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      content = ''
    }
    return {
      engine: 'claude',
      id: sidFull,
      mtimeMs,
      size,
      topic: historyTopic(content),
      active: liveSid !== '' && sidFull === liveSid,
    } satisfies HistoryListEntry
  })
  // `ls -t` — newest first; equal mtimes break by name (a `<`/`>`
  // compare, not `localeCompare`, so the tie order is the same on
  // every CI runner).
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return entries
}

/**
 * Both the formatted `TmResult` and the structured entries from one
 * project-dir scan. The engine adapter consumes both halves; the bash-
 * compatible `claudeHistory` entry point drops the entries and returns
 * the `TmResult` only.
 */
export interface ClaudeHistoryListResult {
  readonly tmResult: TmResult
  readonly entries: readonly HistoryListEntry[]
}

/**
 * `tm history <name>` — list a teammate name's past Claude Code
 * sessions, one per transcript jsonl, newest first. One project-dir
 * walk produces both the structured entries (returned for engine-level
 * consumers like `Engine.history`'s `HistoryResult.entries`) and the
 * `column -t`-aligned text rows. Repo-missing surfaces as `{ tmResult:
 * die..., entries: [] }`.
 */
export async function claudeHistoryList(name: string, cwd: string | null, env: ClaudeVerbEnv): Promise<ClaudeHistoryListResult> {
  const target = cwd ?? join(env.dispatcherDir, name)
  if (!isDirectory(target)) {
    return { tmResult: dieRepoNotFound('history', name, target, env.dispatcherDir), entries: [] }
  }
  const projectDir = projectDirForCwd(target, env)
  const entries = claudeHistoryListEntries(name, projectDir)
  if (entries === null || entries.length === 0) {
    return {
      tmResult: { code: 0, stdout: `(no past sessions for ${name})\n`, stderr: '' },
      entries: entries ?? [],
    }
  }
  const now = Math.floor(Date.now() / 1000)
  // Full id, not an 8-char prefix — keeps this engine-raw fallback render
  // (used when verbs/history.ts can't take its cross-engine merge path)
  // byte-consistent with the merged renderer, so a single-engine call site
  // never silently emits a different ID column shape than the dispatcher one.
  const rows: string[][] = [[' ', 'ENGINE', 'ID', 'AGE', 'SIZE', 'TOPIC']]
  for (const entry of entries) {
    rows.push([
      entry.active ? '*' : ' ',
      entry.engine,
      entry.id,
      fmtAge(Math.max(0, now - Math.floor(entry.mtimeMs / 1000))),
      fmtSize(entry.size),
      entry.topic,
    ])
  }
  const tmResult = await env.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
  return { tmResult, entries }
}

/**
 * `tm history <name> <sid-or-prefix>` — the detail view of one past
 * session. Resolves the prefix to a unique transcript, then prints
 * the history-detail block.
 */
function historyDetail(teammateName: string, projectDir: string, prefix: string): TmResult {
  if (!/^[0-9a-f-]{1,36}$/.test(prefix)) {
    return die(`tm history: invalid sid prefix '${prefix}' — must match ^[0-9a-f-]{1,36}$`)
  }
  if (!isDirectory(projectDir)) {
    return die(`tm history: no project dir at ${projectDir} for ${teammateName} (no sessions yet)`)
  }

  let files: string[]
  try {
    files = readdirSync(projectDir).filter(
      (file) =>
        file.startsWith(prefix) &&
        file.endsWith('.jsonl') &&
        isRegularFile(join(projectDir, file)),
    )
  } catch {
    files = []
  }
  files.sort()
  if (files.length === 0) {
    return die(`tm history: no session matching '${prefix}' in ${teammateName}`)
  }
  if (files.length > 1) {
    const cands = `${files.map((f) => f.replace(/\.jsonl$/, '')).join(' ')} `
    return die(
      `tm history: prefix '${prefix}' matches ${files.length} sessions — ` +
        `be more specific: ${cands}`,
    )
  }

  const fname = files[0]!
  const file = join(projectDir, fname)
  const sidFull = fname.replace(/\.jsonl$/, '')
  let size = 0
  let mtime = 0
  try {
    const stat = statSync(file)
    size = stat.size
    mtime = Math.floor(stat.mtimeMs / 1000)
  } catch {
    size = 0
    mtime = 0
  }
  let content = ''
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    content = ''
  }
  const lineCount = (content.match(/\n/g) ?? []).length
  const now = Math.floor(Date.now() / 1000)
  const data = readHistoryData(content)

  const createdStr = data.createdTs !== '' ? mungeCreated(data.createdTs) : ''
  let ctxStr = '(no usage data)'
  if (data.used !== '' && data.peak !== '') {
    const window = bashNum(data.peak) > 210000 ? 1000000 : 200000
    const pct = Math.trunc((bashNum(data.used) * 100) / window)
    const wlabel = window >= 1000000 ? '1M' : '200k'
    const note = window >= 1000000 ? 'detected 1M' : 'assumed 200k'
    ctxStr = `${data.used} tokens · ${pct}% of ${wlabel} (${note})`
  }

  let laDisplay = data.lastAssistant !== '' ? data.lastAssistant : '(no assistant text)'
  if (data.lastAssistant !== '') {
    const cps = [...data.lastAssistant]
    if (cps.length > 1500) {
      laDisplay =
        `${cps.slice(0, 1500).join('')}\n` +
        `... (${cps.length - 1500} chars truncated; full text in jsonl)`
    }
  }
  const fpDisplay = data.firstPrompt !== '' ? data.firstPrompt : '(no user prompt)'

  const stdout =
    `sid:        ${sidFull}\n` +
    `file:       ${file}\n` +
    `            (${fmtSize(size)} · ${lineCount} lines)\n` +
    `created:    ${createdStr !== '' ? createdStr : '(unknown)'}\n` +
    `last_seen:  ${fmtLocalDateTime(mtime)}  (${fmtAge(now - mtime)} ago)\n` +
    `ctx:        ${ctxStr}\n` +
    '\n' +
    'first prompt:\n' +
    `${indent(fpDisplay)}\n` +
    '\n' +
    'last assistant:\n' +
    `${indent(laDisplay)}\n` +
    '\n' +
    `resume: tm resume ${teammateName} ${sidFull}\n`
  return { code: 0, stdout, stderr: '' }
}

/**
 * Existence-only check: does the Claude Code project dir for `cwd`
 * hold any transcript jsonl? Mirrors `hasCodexHistoryForCwd` — both
 * resume-probing callers ask the same question of each engine and
 * branch on the answer, so the two helpers must agree on what
 * "has candidate" means (any file present; depth-read is intentionally
 * absent, since `claude --continue` will itself pick the latest).
 *
 * `projectsDir` is plumbed in by the caller (cli/context.ts owns env wiring
 * via `NativeEnv.projectsDir`); deriving from `$HOME` here would
 * diverge from tests that inject a tmpdir `projectsDir`.
 */
export function hasClaudeHistoryForCwd(cwd: string, projectsDir: string): boolean {
  const projectDir = join(projectsDir, encodeProjectDir(cwd))
  if (!isDirectory(projectDir)) return false
  try {
    for (const name of readdirSync(projectDir)) {
      if (name.endsWith('.jsonl')) return true
    }
  } catch {
    return false
  }
  return false
}

export async function claudeHistory(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const name = args[0] ?? ''
  if (name.length === 0) return die('usage: tm history <name> [<sid-or-prefix>]')

  const sidArg = args[1] ?? ''
  const cwdArg = args[2] && args[2].length > 0 ? args[2] : null
  if (sidArg === '') return (await claudeHistoryList(name, cwdArg, env)).tmResult

  const cwd = cwdArg ?? join(env.dispatcherDir, name)
  if (!isDirectory(cwd)) return dieRepoNotFound('history', name, cwd, env.dispatcherDir)
  const projectDir = projectDirForCwd(cwd, env)
  return historyDetail(name, projectDir, sidArg)
}
