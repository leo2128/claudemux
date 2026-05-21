/**
 * Guards the plugin-local `.npmrc`.
 *
 * The MCP server's `start` script runs `bun install` on every launch. With no
 * plugin-local `.npmrc`, that install resolves against the user's `~/.npmrc`;
 * on a machine pointed at an internal mirror that lacks a pinned transitive
 * version, the install 404s and the MCP server never starts. The plugin-local
 * `.npmrc` pins the registry to public npm, so the install resolves the same
 * way on every machine regardless of the user's configured registry.
 *
 * CI runs on a host whose default registry is already public npm, so deleting
 * `.npmrc` leaves every other test green — the breakage only surfaces on a
 * machine with a non-default `~/.npmrc`. This test fails instead.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const npmrcPath = join(import.meta.dir, '..', '.npmrc')

/** The registry the install must be pinned to — public npm. */
const PINNED_REGISTRY = 'registry=https://registry.npmjs.org/'

describe('.npmrc — install registry pin', () => {
  test('exists and pins the registry to public npm', () => {
    let body: string
    try {
      body = readFileSync(npmrcPath, 'utf8')
    } catch {
      throw new Error(
        'plugins/feishu-channel/.npmrc is missing — it must pin ' +
          `${PINNED_REGISTRY} so the start-script install does not depend ` +
          "on the user's configured registry",
      )
    }
    const registryLine = body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('registry='))
    expect(registryLine).toBe(PINNED_REGISTRY)
  })
})
