import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  accessFile,
  approvedDir,
  approvedMarker,
  envFile,
  inboxDir,
  stateDir,
} from '../src/paths'

describe('paths', () => {
  const base = '/tmp/feishu-test-state'

  test('stateDir ends at the channel directory', () => {
    expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
  })

  test('builders compose onto an explicit base', () => {
    expect(accessFile(base)).toBe(join(base, 'access.json'))
    expect(approvedDir(base)).toBe(join(base, 'approved'))
    expect(approvedMarker('ou_1', base)).toBe(join(base, 'approved', 'ou_1'))
    expect(envFile(base)).toBe(join(base, '.env'))
    expect(inboxDir(base)).toBe(join(base, 'inbox'))
  })

  test('the inbox and approved dirs sit inside the state directory', () => {
    expect(inboxDir(base).startsWith(base + '/')).toBe(true)
    expect(approvedDir(base).startsWith(base + '/')).toBe(true)
    expect(accessFile(base).startsWith(base + '/')).toBe(true)
  })
})
