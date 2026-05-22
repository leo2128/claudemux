/**
 * The idle subscription derives a teammate's busy/idle signal from its marker
 * files. Two pieces are unit-tested deterministically: `sidOf` (the
 * filename→sid mapping) and `#scanAll` (the directory scan that seeds the
 * signal map, reached through `start()`). `#scanAll` calls the same `#refresh`
 * the `fs.watch` callback does, so the per-marker derivation is fully covered.
 *
 * The `fs.watch` *delivery* itself — a marker changing after `start()` — is
 * not unit-tested: it depends on platform-specific watcher timing (macOS
 * FSEvents arming and coalescing) that cannot be pinned without a flaky sleep.
 *
 * The tests use the real `/tmp/claude-idle/` directory — the same one the
 * hooks use — but only ever with uniquely-prefixed test sids, so they cannot
 * collide with a real teammate's UUID-named markers.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { busyMarkerFor, idleDir, idleMarkerFor } from '../src/paths'
import { IdleSubscription, sidOf } from '../src/subscription'

describe('sidOf maps a marker filename to its session_id', () => {
  test('a bare filename is the sid itself', () => {
    expect(sidOf('a1b2c3')).toBe('a1b2c3')
  })

  test('the .busy and .last suffixes are stripped', () => {
    expect(sidOf('a1b2c3.busy')).toBe('a1b2c3')
    expect(sidOf('a1b2c3.last')).toBe('a1b2c3')
  })

  test('a core diagnostic log (leading underscore) maps to no sid', () => {
    expect(sidOf('_on-stop.log')).toBe('')
  })
})

describe('IdleSubscription reads marker state', () => {
  const created: string[] = []
  let subscription: IdleSubscription

  beforeEach(() => {
    mkdirSync(idleDir(), { recursive: true })
    subscription = new IdleSubscription()
  })

  afterEach(() => {
    subscription.stop()
    for (const file of created.splice(0)) {
      if (existsSync(file)) rmSync(file)
    }
  })

  /** A test sid that cannot collide with a real teammate's UUID. */
  function testSid(): string {
    return `claudemux-core-test-${randomUUID()}`
  }

  /** Touch a marker file and remember it for cleanup. */
  function touch(file: string): void {
    writeFileSync(file, '')
    created.push(file)
  }

  test('the initial scan seeds the signal for markers already present', () => {
    const busy = testSid()
    const idle = testSid()
    touch(busyMarkerFor(busy))
    touch(idleMarkerFor(idle))

    subscription.start()

    expect(subscription.signalFor(busy)).toEqual({ busy: true, idle: false })
    expect(subscription.signalFor(idle)).toEqual({ busy: false, idle: true })
  })

  test('an unobserved sid has no signal', () => {
    subscription.start()
    expect(subscription.signalFor(testSid())).toBeUndefined()
  })

  test('stop() releases the in-memory signal state', () => {
    const sid = testSid()
    touch(busyMarkerFor(sid))
    subscription.start()
    expect(subscription.signalFor(sid)).toEqual({ busy: true, idle: false })

    subscription.stop()
    expect(subscription.signalFor(sid)).toBeUndefined()
  })
})
