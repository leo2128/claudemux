import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_FEISHU_BASE,
  interpretTokenResponse,
  renderEnvFile,
  tokenEndpoint,
  validateCredentialInput,
} from '../scripts/configure'
import { readEnvFile } from '../src/server'

describe('validateCredentialInput', () => {
  test('accepts a well-formed pair', () => {
    expect(validateCredentialInput('cli_abc123', 's3cr3t-VALUE_xyz')).toBeNull()
  })

  test('rejects an empty or whitespace App ID', () => {
    expect(validateCredentialInput('', 'secret')).toBe('App ID is empty.')
    expect(validateCredentialInput('   ', 'secret')).toBe('App ID is empty.')
    expect(validateCredentialInput(undefined, 'secret')).toBe('App ID is empty.')
  })

  test('rejects an empty App Secret', () => {
    expect(validateCredentialInput('cli_x', '')).toBe('App Secret is empty.')
    expect(validateCredentialInput('cli_x', undefined)).toBe('App Secret is empty.')
  })

  test('rejects a value containing a line break — it would corrupt the .env', () => {
    expect(validateCredentialInput('cli_x\nFOO=bar', 'secret')).toContain('line breaks')
    expect(validateCredentialInput('cli_x', 'sec\rret')).toContain('line breaks')
  })
})

describe('renderEnvFile', () => {
  test('emits exactly the two keys the server reads', () => {
    const body = renderEnvFile('cli_abc', 'shh')
    expect(body).toContain('FEISHU_APP_ID=cli_abc')
    expect(body).toContain('FEISHU_APP_SECRET=shh')
  })

  test('the rendered file round-trips through the server env parser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-cfg-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, renderEnvFile('cli_abc123', 's3cr3t-VALUE_xyz'))
      // The factory's output must be exactly what the channel server parses.
      expect(readEnvFile(file)).toEqual({
        FEISHU_APP_ID: 'cli_abc123',
        FEISHU_APP_SECRET: 's3cr3t-VALUE_xyz',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tokenEndpoint', () => {
  test('builds the internal tenant-access-token path on the default base', () => {
    expect(tokenEndpoint(DEFAULT_FEISHU_BASE)).toBe(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    )
  })

  test('trims a trailing slash off the base URL', () => {
    expect(tokenEndpoint('https://open.feishu.cn/')).toBe(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    )
  })

  test('honors a Lark (international) base URL', () => {
    expect(tokenEndpoint('https://open.larksuite.com')).toBe(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    )
  })
})

describe('interpretTokenResponse', () => {
  test('code 0 means Feishu accepted the credentials', () => {
    const r = interpretTokenResponse({
      kind: 'response',
      body: { code: 0, tenant_access_token: 't-xxx', expire: 7200 },
    })
    expect(r.verdict).toBe('valid')
  })

  test('a non-zero code means rejected, and surfaces the Feishu message', () => {
    const r = interpretTokenResponse({
      kind: 'response',
      body: { code: 10003, msg: 'invalid app_secret' },
    })
    expect(r.verdict).toBe('rejected')
    expect(r.message).toContain('invalid app_secret')
  })

  test('a non-zero code with no message falls back to the code number', () => {
    const r = interpretTokenResponse({ kind: 'response', body: { code: 99 } })
    expect(r.verdict).toBe('rejected')
    expect(r.message).toContain('99')
  })

  test('a network error means unverified, not rejected', () => {
    const r = interpretTokenResponse({ kind: 'network-error', detail: 'ENOTFOUND' })
    expect(r.verdict).toBe('unverified')
    expect(r.message).toContain('ENOTFOUND')
  })

  test('an unreadable response body is unverified', () => {
    expect(interpretTokenResponse({ kind: 'response', body: undefined }).verdict).toBe(
      'unverified',
    )
    expect(interpretTokenResponse({ kind: 'response', body: 'not json' }).verdict).toBe(
      'unverified',
    )
    expect(interpretTokenResponse({ kind: 'response', body: { msg: 'no code' } }).verdict).toBe(
      'unverified',
    )
  })
})
