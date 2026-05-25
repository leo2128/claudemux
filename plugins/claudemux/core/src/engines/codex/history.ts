/**
 * `tm history` for Codex teammates.
 *
 * Codex persists durable threads as rollout JSONL files under
 * `~/.codex/sessions/YYYY/MM/DD/`. This module keeps history read-only:
 * it filters rollout files by their recorded cwd, renders thread ids for
 * `tm resume`, and never mutates the daemon registry.
 */

import { Buffer } from 'node:buffer'
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'

import type { EngineContext, HistoryListEntry, HistoryRequest, HistoryResult } from '../types'
import type { TmResult } from '../../tm'
import { readBaseRecord, readCodexMeta } from './persistence.js'
import { readDaemonState } from './supervisor.js'
import {
  listCodexRolloutFiles,
  readCodexRolloutSnapshot,
  type CodexRolloutFile,
} from './rollout.js'

interface CodexHistoryEntry {
  readonly threadId: string
  readonly path: string
  readonly mtimeMs: number
  readonly createdAt: string | null
  readonly size: number
  readonly lineCount: number
  readonly cwd: string
  readonly firstPrompt: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function comparablePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function cwdMatches(recorded: string, target: string): boolean {
  return recorded === target || comparablePath(recorded) === comparablePath(target)
}

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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${Math.trunc(bytes / 1024)}K`
  if (bytes < 1073741824) return `${toFixed1HalfEven(bytes / 1048576)}M`
  return `${toFixed1HalfEven(bytes / 1073741824)}G`
}

function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    const type = item['type']
    if (type !== 'input_text' && type !== 'output_text' && type !== 'text') continue
    const text = stringProp(item, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

function promptFromEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null

  if (payload['type'] === 'user_message' || payload['type'] === 'userMessage') {
    return stringProp(payload, 'message') ?? stringProp(payload, 'text')
  }
  if (entry['type'] === 'response_item' && payload['type'] === 'message' && payload['role'] === 'user') {
    return textFromContent(payload['content'])
  }
  return null
}

function cwdFromEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null
  return stringProp(payload, 'cwd')
}

function readFirstLine(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(4096)
    let offset = 0
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n === 0) break
      const chunk = buf.subarray(0, n)
      const newline = chunk.indexOf(10)
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(Buffer.from(chunk))
      offset += n
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch { /* ignore close failure after a read-only route probe */ }
    }
  }
}

function cwdFromFirstLine(file: CodexRolloutFile): string | null {
  const line = readFirstLine(file.path)
  if (line === null || line.trim() === '') return null
  try {
    return cwdFromEntry(JSON.parse(line))
  } catch {
    return null
  }
}

function readHistoryEntry(file: CodexRolloutFile): CodexHistoryEntry | null {
  let content: string
  try {
    content = readFileSync(file.path, 'utf8')
  } catch {
    return null
  }

  let cwd: string | null = null
  let firstUserEventPrompt: string | null = null
  let firstUserRolePrompt: string | null = null
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    cwd = cwd ?? cwdFromEntry(entry)
    const prompt = promptFromEntry(entry)
    if (prompt !== null) {
      if (isPlainObject(entry) && entry['type'] === 'event_msg') {
        firstUserEventPrompt = firstUserEventPrompt ?? prompt
      } else {
        firstUserRolePrompt = firstUserRolePrompt ?? prompt
      }
    }
  }

  if (cwd === null) return null
  let size = 0
  try {
    size = statSync(file.path).size
  } catch {
    size = 0
  }
  return {
    threadId: file.threadId,
    path: file.path,
    mtimeMs: file.mtimeMs,
    createdAt: file.createdAt,
    size,
    lineCount: content.match(/\n/g)?.length ?? 0,
    cwd,
    firstPrompt: firstUserEventPrompt ?? firstUserRolePrompt,
  }
}

function historyEntriesForCwd(cwd: string, env: NodeJS.ProcessEnv): readonly CodexHistoryEntry[] {
  return listCodexRolloutFiles(env)
    .map((file) => readHistoryEntry(file))
    .filter((entry): entry is CodexHistoryEntry => entry !== null && cwdMatches(entry.cwd, cwd))
}

function codexHistoryListEntries(
  entries: readonly CodexHistoryEntry[],
  activeThreadId: string | null,
): readonly HistoryListEntry[] {
  return entries.map((entry) => ({
    engine: 'codex',
    id: entry.threadId,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    topic: historyTopic(entry),
    active: activeThreadId === entry.threadId,
  }))
}

export function hasCodexHistoryForCwd(cwd: string, env: NodeJS.ProcessEnv): boolean {
  for (const file of listCodexRolloutFiles(env)) {
    const recordedCwd = cwdFromFirstLine(file)
    if (recordedCwd !== null && cwdMatches(recordedCwd, cwd)) return true
  }
  return false
}

function historyTopic(entry: CodexHistoryEntry): string {
  if (entry.firstPrompt === null || entry.firstPrompt.length === 0) return '(no user prompt)'
  const firstLine = entry.firstPrompt.split('\n')[0] ?? ''
  const stripped = [...firstLine].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
  const topic = stripped.slice(0, 60).join('')
  return topic.length > 0 ? topic : '(no user prompt)'
}

function alignRows(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_cell, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  ) ?? []
  return rows.map((row) =>
    row.map((cell, index) =>
      index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
    ).join('  ').trimEnd(),
  ).join('\n') + '\n'
}

function listHistory(
  name: string,
  entries: readonly CodexHistoryEntry[],
  activeThreadId: string | null,
  nowMs: number,
): TmResult {
  if (entries.length === 0) {
    return { code: 0, stdout: `(no codex threads for ${name})\n`, stderr: '' }
  }
  const rows: string[][] = [[' ', 'ENGINE', 'ID', 'AGE', 'SIZE', 'TOPIC']]
  // Full id — see the matching note in `engines/claude/history.ts`. Engine-raw
  // list output stays consistent with the cross-engine renderer in verbs/.
  for (const entry of codexHistoryListEntries(entries, activeThreadId)) {
    rows.push([
      entry.active ? '*' : ' ',
      entry.engine,
      entry.id,
      fmtAge(Math.max(0, Math.floor((nowMs - entry.mtimeMs) / 1000))),
      fmtSize(entry.size),
      entry.topic,
    ])
  }
  return { code: 0, stdout: alignRows(rows), stderr: '' }
}

function truncateAssistant(text: string): string {
  const cps = [...text]
  if (cps.length <= 1500) return text
  return `${cps.slice(0, 1500).join('')}\n... (${cps.length - 1500} chars truncated; full text in jsonl)`
}

function fmtTokenWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k`
  return String(tokens)
}

function fmtContext(snapshot: ReturnType<typeof readCodexRolloutSnapshot>): string {
  if (snapshot?.tokenUsage === null || snapshot?.tokenUsage === undefined) return '(no usage data)'
  return `${snapshot.tokenUsage.tokensUsed} tokens · ${snapshot.tokenUsage.pct}% of ${
    fmtTokenWindow(snapshot.tokenUsage.tokensTotal)
  }`
}

function detailHistory(
  name: string,
  selector: string,
  entries: readonly CodexHistoryEntry[],
  ctx: EngineContext,
): TmResult {
  if (!/^[0-9a-f-]{1,36}$/i.test(selector)) {
    return { code: 1, stdout: '', stderr: `tm: history: invalid thread-id prefix '${selector}'\n` }
  }
  const prefix = selector.toLowerCase()
  const matches = entries.filter((entry) => entry.threadId.toLowerCase().startsWith(prefix))
  if (matches.length === 0) {
    return { code: 1, stdout: '', stderr: `tm: history: no codex thread matching '${selector}' in ${name}\n` }
  }
  if (matches.length > 1) {
    const cands = `${matches.map((entry) => entry.threadId).join(' ')} `
    return {
      code: 1,
      stdout: '',
      stderr: `tm: history: prefix '${selector}' matches ${matches.length} codex threads - be more specific: ${cands}\n`,
    }
  }

  const entry = matches[0]!
  const snapshot = readCodexRolloutSnapshot(entry.threadId, ctx.env)
  const firstPrompt = entry.firstPrompt ?? '(no user prompt)'
  const ctxStr = fmtContext(snapshot)
  const lastAssistant = snapshot?.lastAssistantText === null || snapshot?.lastAssistantText === undefined
    ? '(no assistant text)'
    : truncateAssistant(snapshot.lastAssistantText)
  const stdout =
    `thread:     ${entry.threadId}\n` +
    `rollout:    ${entry.path}\n` +
    `            (${fmtSize(entry.size)} · ${entry.lineCount} lines)\n` +
    `created:    ${entry.createdAt ?? '(unknown)'}\n` +
    `last_seen:  ${fmtAge(Math.max(0, Math.floor((ctx.now() - entry.mtimeMs) / 1000)))} ago\n` +
    `ctx:        ${ctxStr}\n` +
    '\n' +
    'first prompt:\n' +
    `${indent(firstPrompt)}\n` +
    '\n' +
    'last assistant:\n' +
    `${indent(lastAssistant)}\n` +
    '\n' +
    `resume: tm resume ${name} ${entry.threadId}\n`
  return { code: 0, stdout, stderr: '' }
}

export function codexHistory(req: HistoryRequest, ctx: EngineContext): HistoryResult {
  const cwd = req.cwd ?? readBaseRecord(req.name)?.cwd ?? readCodexMeta(req.name)?.cwd ?? null
  if (cwd === null) {
    return { kind: 'failed', message: `codex teammate '${req.name}' has no cwd to match rollout history` }
  }

  const entries = historyEntriesForCwd(cwd, ctx.env)
  const activeThreadId = readDaemonState(req.name)?.threadId ?? null
  const tmResult = req.index === null
    ? listHistory(req.name, entries, activeThreadId, ctx.now())
    : detailHistory(req.name, req.index, entries, ctx)

  if (tmResult.code !== 0) return { kind: 'failed', message: tmResult.stderr.trim(), tmResult }
  if (req.index === null) {
    return {
      kind: 'list',
      turns: [],
      entries: codexHistoryListEntries(entries, activeThreadId),
      tmResult,
    }
  }
  return {
    kind: 'detail',
    turn: { index: 0, startedAt: 0, summary: req.index },
    items: [],
    tmResult,
  }
}
