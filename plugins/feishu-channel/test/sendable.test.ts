import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSendable } from '../src/sendable'

let root: string
let stateDir: string
let inboxDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feishu-send-'))
  stateDir = join(root, 'state')
  inboxDir = join(stateDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('assertSendable', () => {
  test('allows a file outside the state directory', () => {
    const file = join(root, 'outside.png')
    writeFileSync(file, 'x')
    expect(() => assertSendable(file, stateDir, inboxDir)).not.toThrow()
  })

  test('refuses a file inside the state directory', () => {
    const file = join(stateDir, 'access.json')
    writeFileSync(file, '{}')
    expect(() => assertSendable(file, stateDir, inboxDir)).toThrow(/channel state/)
  })

  test('refuses the credentials file', () => {
    const file = join(stateDir, '.env')
    writeFileSync(file, 'FEISHU_APP_ID=x')
    expect(() => assertSendable(file, stateDir, inboxDir)).toThrow()
  })

  test('allows a file inside the inbox subtree', () => {
    const file = join(inboxDir, 'photo.jpg')
    writeFileSync(file, 'x')
    expect(() => assertSendable(file, stateDir, inboxDir)).not.toThrow()
  })

  test('allows a non-existent file (the caller checks existence)', () => {
    expect(() => assertSendable(join(root, 'ghost.png'), stateDir, inboxDir)).not.toThrow()
  })

  test('refuses a symlink that resolves into the state directory', () => {
    const target = join(stateDir, '.env')
    writeFileSync(target, 'FEISHU_APP_SECRET=x')
    const link = join(root, 'innocent.png')
    symlinkSync(target, link)
    expect(() => assertSendable(link, stateDir, inboxDir)).toThrow(/channel state/)
  })

  test('refuses the state directory itself', () => {
    expect(() => assertSendable(stateDir, stateDir, inboxDir)).toThrow()
  })

  test('allows everything when the state directory does not exist', () => {
    const file = join(root, 'outside.png')
    writeFileSync(file, 'x')
    expect(() => assertSendable(file, join(root, 'no-such-state'), inboxDir)).not.toThrow()
  })
})
