/**
 * The idle subscription derives a teammate's busy/idle signal from its marker
 * files. The filename→sid mapping is the one piece of parsing; the rest is an
 * `fs.watch`. Both are tested here.
 *
 * The watch tests use the real `/tmp/claude-idle/` directory — the same one
 * the hooks use — but only ever with uniquely-prefixed test sids, so they
 * cannot collide with a real teammate's UUID-named markers.
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

  test('the watch picks up a marker created after start', async () => {
    const sid = testSid()
    subscription.start()
    // Let the OS file watcher finish arming before the change is made — on
    // macOS (FSEvents) a change in the same tick as `watch()` can be missed.
    await Bun.sleep(250)
    touch(busyMarkerFor(sid))

    // The watch then fires asynchronously; poll generously for it to land.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && subscription.signalFor(sid) === undefined) {
      await Bun.sleep(20)
    }
    expect(subscription.signalFor(sid)).toEqual({ busy: true, idle: false })
  })
})
