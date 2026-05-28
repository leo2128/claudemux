import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { accessFile, envFile, lockFile, observedBotsFile, stateDir } from '../src/paths'

describe('paths', () => {
  const base = '/tmp/feishu-test-state'

  test('stateDir ends at the channel directory', () => {
    expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
  })

  test('builders compose onto an explicit base', () => {
    expect(accessFile(base)).toBe(join(base, 'access.json'))
    expect(envFile(base)).toBe(join(base, '.env'))
    expect(lockFile(base)).toBe(join(base, 'connection.lock'))
  })

  test('every state file sits inside the state directory', () => {
    expect(accessFile(base).startsWith(base + '/')).toBe(true)
    expect(envFile(base).startsWith(base + '/')).toBe(true)
    expect(lockFile(base).startsWith(base + '/')).toBe(true)
  })

  describe('observedBotsFile', () => {
    test('embeds appId and chatId in the file name', () => {
      const p = observedBotsFile(base, 'cli_app', 'oc_chat')
      expect(p).toBe(join(base, 'observed-bots-cli_app-oc_chat.json'))
    })

    test('sits inside the base directory', () => {
      expect(observedBotsFile(base, 'a', 'b').startsWith(base + '/')).toBe(true)
    })
  })
})
