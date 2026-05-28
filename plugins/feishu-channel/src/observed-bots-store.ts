/**
 * Per-observer × per-chat persistent store of bot open_ids discovered via the
 * `/introduce` collaboration handshake.
 *
 * Why per-observer (file name includes the observing app's appId):
 * Feishu open_id is per-app scoped. When this bot receives `@A @B /introduce`,
 * `mentions[i].id.open_id` for Bot B is B as seen by this app — the correct id
 * for this app to use when @-mentioning B. A file keyed only by chatId would
 * mix open_ids from different apps' perspectives.
 *
 * Why also per-chat:
 * Path-level isolation: lookups cannot leak entries from other chats.
 *
 * Atomic writes via unique tmp + rename (pid + randomUUID): a fixed `.tmp`
 * suffix would race between concurrent writers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

export type ObservedBotSource = 'introduce'

export interface ObservedBot {
  openId: string
  name: string
  source: ObservedBotSource
  firstSeenAt: number
  lastSeenAt: number
}

type FileEntry = { name: string; source: ObservedBotSource; firstSeenAt: number; lastSeenAt: number }
type FileShape = Record<string, FileEntry>

function filePath(baseDir: string, appId: string, chatId: string): string {
  return join(baseDir, `observed-bots-${appId}-${chatId}.json`)
}

function readFile(baseDir: string, appId: string, chatId: string): FileShape {
  const fp = filePath(baseDir, appId, chatId)
  if (!existsSync(fp)) return {}
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape
  } catch {
    // corrupt — fall through to empty
  }
  return {}
}

function writeFileAtomic(baseDir: string, appId: string, chatId: string, data: FileShape): void {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
  const fp = filePath(baseDir, appId, chatId)
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, fp)
}

/**
 * Merge a batch of (openId, name) pairs into the observer's per-chat file.
 *
 * - Existing openIds: keep firstSeenAt, bump lastSeenAt, refresh name.
 * - New openIds: firstSeenAt = lastSeenAt = now.
 * - Entries with empty openId or name are silently skipped.
 * - Empty or all-filtered input is a no-op (no file write).
 *
 * `appId` is the OBSERVING app's id (whose perspective these open_ids represent).
 */
export function recordObservedBots(
  baseDir: string,
  appId: string,
  chatId: string,
  bots: ReadonlyArray<{ openId: string; name: string }>,
  source: ObservedBotSource = 'introduce',
  now: number = Date.now(),
): void {
  const valid = bots.filter((b) => b.openId && b.name)
  if (valid.length === 0) return

  const data = readFile(baseDir, appId, chatId)
  for (const b of valid) {
    const prior = data[b.openId]
    if (prior) {
      data[b.openId] = { ...prior, name: b.name, lastSeenAt: now }
    } else {
      data[b.openId] = { name: b.name, source, firstSeenAt: now, lastSeenAt: now }
    }
  }
  writeFileAtomic(baseDir, appId, chatId, data)
}

/**
 * Return non-expired entries for the (observer, chat) pair. `maxAgeMs`
 * defaults to 30 days. Order is unspecified.
 */
export function listObservedBots(
  baseDir: string,
  appId: string,
  chatId: string,
  maxAgeMs: number = DEFAULT_EXPIRY_MS,
  now: number = Date.now(),
): ObservedBot[] {
  const data = readFile(baseDir, appId, chatId)
  const out: ObservedBot[] = []
  for (const [openId, entry] of Object.entries(data)) {
    if (now - entry.lastSeenAt > maxAgeMs) continue
    out.push({
      openId,
      name: entry.name,
      source: entry.source,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    })
  }
  return out
}
