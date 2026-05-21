/**
 * Guards the proxy-clearing `env` block in `.mcp.json`.
 *
 * The channel's MCP server reaches Feishu directly, not through the session
 * HTTP proxy. That is enforced entirely by `.mcp.json`: its `env` block sets
 * the four proxy variables to the empty string, and Claude Code merges that
 * over the inherited environment when it spawns the server — an empty value
 * overrides the inherited one (verified empirically against Claude Code
 * 2.1.146; see decision 0008).
 *
 * The block carries no comment, and CI runs with no proxy set, so deleting it
 * leaves every other test green. This test fails instead.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const mcpConfigPath = join(import.meta.dir, '..', '.mcp.json')

interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

/** Every casing the proxy is cleared in — clients read upper or lower case. */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

describe('.mcp.json proxy-clearing env block', () => {
  const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as McpConfig
  const env = config.mcpServers?.feishu?.env ?? {}

  for (const key of PROXY_VARS) {
    test(`clears ${key} to the empty string`, () => {
      // toHaveProperty alone would pass on a missing key with value undefined;
      // the explicit empty-string check is what makes the proxy actually clear.
      expect(env).toHaveProperty(key)
      expect(env[key]).toBe('')
    })
  }
})
