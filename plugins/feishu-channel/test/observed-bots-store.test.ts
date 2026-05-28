import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listObservedBots, recordObservedBots } from '../src/observed-bots-store'

const APP = 'cli_app_a'
const CHAT = 'oc_chat_1'
const NOW = 1_700_000_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-obs-bots-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('recordObservedBots', () => {
  test('persists valid bots and they appear in listObservedBots', () => {
    recordObservedBots(dir, APP, CHAT, [{ openId: 'ou_b', name: 'BotB' }], 'introduce', NOW)
    const list = listObservedBots(dir, APP, CHAT, Infinity, NOW)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ openId: 'ou_b', name: 'BotB', source: 'introduce' })
  })

  test('is a no-op when all entries have empty openId or name', () => {
    recordObservedBots(dir, APP, CHAT, [{ openId: '', name: 'X' }, { openId: 'ou_y', name: '' }], 'introduce', NOW)
    expect(listObservedBots(dir, APP, CHAT, Infinity, NOW)).toHaveLength(0)
  })

  test('updates lastSeenAt and name on re-record, keeps firstSeenAt', () => {
    recordObservedBots(dir, APP, CHAT, [{ openId: 'ou_b', name: 'Old' }], 'introduce', NOW)
    recordObservedBots(dir, APP, CHAT, [{ openId: 'ou_b', name: 'New' }], 'introduce', NOW + 1000)

    const [entry] = listObservedBots(dir, APP, CHAT, Infinity, NOW + 2000)
    expect(entry?.name).toBe('New')
    expect(entry?.firstSeenAt).toBe(NOW)
    expect(entry?.lastSeenAt).toBe(NOW + 1000)
  })

  test('creates the baseDir if it does not exist', () => {
    const nested = join(dir, 'a', 'b', 'c')
    recordObservedBots(nested, APP, CHAT, [{ openId: 'ou_b', name: 'B' }], 'introduce', NOW)
    expect(listObservedBots(nested, APP, CHAT, Infinity, NOW)).toHaveLength(1)
  })
})

describe('listObservedBots', () => {
  test('returns empty array when file does not exist', () => {
    expect(listObservedBots(dir, APP, CHAT)).toHaveLength(0)
  })

  test('returns empty array when file is corrupt JSON', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `observed-bots-${APP}-${CHAT}.json`), '{bad json}', 'utf-8')
    expect(listObservedBots(dir, APP, CHAT)).toHaveLength(0)
  })

  test('filters out expired entries (lastSeenAt + maxAgeMs <= now)', () => {
    recordObservedBots(dir, APP, CHAT, [{ openId: 'ou_old', name: 'Old' }], 'introduce', NOW - 1001)
    recordObservedBots(dir, APP, CHAT, [{ openId: 'ou_new', name: 'New' }], 'introduce', NOW)

    const live = listObservedBots(dir, APP, CHAT, 1000, NOW)
    expect(live.map((b) => b.openId)).not.toContain('ou_old')
    expect(live.map((b) => b.openId)).toContain('ou_new')
  })

  test('files are isolated per app — different appId does not leak entries', () => {
    recordObservedBots(dir, 'app_a', CHAT, [{ openId: 'ou_a', name: 'A' }], 'introduce', NOW)
    expect(listObservedBots(dir, 'app_b', CHAT, Infinity, NOW)).toHaveLength(0)
  })

  test('files are isolated per chat — different chatId does not leak entries', () => {
    recordObservedBots(dir, APP, 'oc_chat_1', [{ openId: 'ou_b', name: 'B' }], 'introduce', NOW)
    expect(listObservedBots(dir, APP, 'oc_chat_2', Infinity, NOW)).toHaveLength(0)
  })
})
