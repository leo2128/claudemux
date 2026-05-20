import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { accessFile, envFile, stateDir } from '../src/paths'

describe('paths', () => {
  const base = '/tmp/feishu-test-state'

  test('stateDir ends at the channel directory', () => {
    expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
  })

  test('builders compose onto an explicit base', () => {
    expect(accessFile(base)).toBe(join(base, 'access.json'))
    expect(envFile(base)).toBe(join(base, '.env'))
  })

  test('every state file sits inside the state directory', () => {
    expect(accessFile(base).startsWith(base + '/')).toBe(true)
    expect(envFile(base).startsWith(base + '/')).toBe(true)
  })
})
