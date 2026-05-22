/**
 * The Feishu channel's credential factory.
 *
 * `/feishu-channel:configure` runs this script with the user's app_id and
 * app_secret. It does the two things a slash command must not leave to prose:
 *
 *  1. Writes the channel's `.env` file deterministically — owner-only
 *     directory and file, exactly the two keys the server reads.
 *  2. Verifies the credentials against Feishu *before* the user restarts, by
 *     fetching a tenant-access-token. An invalid App Secret is caught here, in
 *     the configuring session, instead of at the next channel boot.
 *
 * The pure functions — env-file rendering, endpoint construction, response
 * interpretation — are exported and unit-tested. `main` is the thin effectful
 * entry point that does the I/O and the network call.
 */

import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GROUP_POLICIES, loadAccess, saveAccess } from '../src/access-store'
import { isRecord } from '../src/json'
import { accessFile, envFile, stateDir } from '../src/paths'
import type { GroupPolicy } from '../src/types'

/** Feishu's open-platform base URL — the default for a mainland self-built app. */
export const DEFAULT_FEISHU_BASE = 'https://open.feishu.cn'

/** Process exit codes, one per verification verdict. */
const EXIT_CODE = { valid: 0, rejected: 1, unverified: 2 } as const

/**
 * Reject credential input that would corrupt the `.env` file or is obviously
 * unusable, before anything is written. Returns an error message, or `null`
 * when both values look usable. This is a shape check only — whether Feishu
 * accepts the credentials is `interpretTokenResponse`'s job.
 */
export function validateCredentialInput(
  appId: string | undefined,
  appSecret: string | undefined,
): string | null {
  if (!appId || !appId.trim()) return 'App ID is empty.'
  if (!appSecret || !appSecret.trim()) return 'App Secret is empty.'
  if (/[\r\n]/.test(appId) || /[\r\n]/.test(appSecret)) {
    return 'App ID and App Secret must not contain line breaks.'
  }
  return null
}

/**
 * Parse the group-message policy the user chose. Returns the policy, or `null`
 * when the value is missing or not one of the three known modes — `block`
 * (the bot ignores groups), `allowlist` (each group is authorized by pairing),
 * or `follow-user` (a group message is gated on the sender's allowlist alone).
 */
export function parseGroupPolicy(value: string | undefined): GroupPolicy | null {
  const v = (value ?? '').trim()
  return (GROUP_POLICIES as readonly string[]).includes(v) ? (v as GroupPolicy) : null
}

/**
 * Render the `.env` body for a pair of credentials. Deterministic — this is
 * exactly the content the channel server's `readEnvFile` parses on boot.
 */
export function renderEnvFile(appId: string, appSecret: string): string {
  return [
    '# Feishu channel credentials — written by /feishu-channel:configure.',
    '# Re-run that command to update them.',
    `FEISHU_APP_ID=${appId}`,
    `FEISHU_APP_SECRET=${appSecret}`,
    '',
  ].join('\n')
}

/** The tenant-access-token endpoint for a given open-platform base URL. */
export function tokenEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/open-apis/auth/v3/tenant_access_token/internal`
}

/** One probe of the tenant-access-token endpoint. */
export type TokenProbe =
  | { kind: 'response'; body: unknown }
  | { kind: 'network-error'; detail: string }

/** What probing the endpoint told us about the credentials. */
export type CredentialVerdict = 'valid' | 'rejected' | 'unverified'

/** The outcome of one verification probe, ready to print and exit on. */
export interface VerificationResult {
  verdict: CredentialVerdict
  message: string
}

/**
 * Interpret a tenant-access-token probe:
 *
 * - A reachable response with `code === 0` — Feishu accepted the credentials
 *   (`valid`).
 * - A reachable response with a non-zero `code` — Feishu rejected them
 *   (`rejected`); the Feishu `msg` is surfaced so the user knows what to fix.
 * - A network failure, or a response that cannot be read — `unverified`: the
 *   `.env` file is still written, but the credentials could not be confirmed.
 *   That is not the same as "wrong".
 */
export function interpretTokenResponse(probe: TokenProbe): VerificationResult {
  if (probe.kind === 'network-error') {
    return {
      verdict: 'unverified',
      message: `Could not reach Feishu to verify the credentials (${probe.detail}).`,
    }
  }
  const body = probe.body
  if (!isRecord(body)) {
    return {
      verdict: 'unverified',
      message: 'Feishu returned an unrecognized response; credentials not verified.',
    }
  }
  const code = body.code
  if (typeof code !== 'number') {
    return {
      verdict: 'unverified',
      message: 'Feishu returned no result code; credentials not verified.',
    }
  }
  if (code === 0) {
    return { verdict: 'valid', message: 'Feishu accepted the credentials.' }
  }
  const msg = body.msg
  const detail = typeof msg === 'string' && msg ? msg : `code ${code}`
  return {
    verdict: 'rejected',
    message: `Feishu rejected the credentials: ${detail}. Re-check the App ID and App Secret.`,
  }
}

/** POST the credentials to the tenant-access-token endpoint. Never throws. */
async function probeCredentials(
  baseUrl: string,
  appId: string,
  appSecret: string,
): Promise<TokenProbe> {
  try {
    const res = await fetch(tokenEndpoint(baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const body = (await res.json().catch(() => undefined)) as unknown
    return { kind: 'response', body }
  } catch (err) {
    return { kind: 'network-error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Effectful entry point: write the `.env`, then verify against Feishu. */
async function main(): Promise<void> {
  const [rawAppId, rawAppSecret, rawGroupPolicy, rawBase] = process.argv.slice(2)
  const appId = (rawAppId ?? '').trim()
  const appSecret = (rawAppSecret ?? '').trim()
  const baseUrl = (rawBase ?? '').trim() || DEFAULT_FEISHU_BASE

  const usage = 'Usage: configure <app_id> <app_secret> <group_policy> [feishu_base_url]'

  const inputError = validateCredentialInput(appId, appSecret)
  if (inputError) {
    console.error(`configure: ${inputError}`)
    console.error(usage)
    process.exit(1)
  }

  const groupPolicy = parseGroupPolicy(rawGroupPolicy)
  if (!groupPolicy) {
    console.error(`configure: group policy must be one of: ${GROUP_POLICIES.join(', ')}.`)
    console.error(usage)
    process.exit(1)
  }

  // Write the .env deterministically — directory 0700, file 0600. The mode on
  // writeFileSync only applies on create, so chmod covers a re-configure over
  // an existing file.
  const dir = stateDir()
  const file = envFile(dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, renderEnvFile(appId, appSecret), { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(`Wrote ${file} (owner-only).`)

  // Persist the chosen group-message policy into access.json, preserving every
  // other access field — re-running configure must not wipe the allowlist or
  // any pending pairings.
  const accessPath = accessFile(dir)
  const { access } = loadAccess(accessPath)
  saveAccess(accessPath, { ...access, groupPolicy })
  console.log(`Set the group policy to "${groupPolicy}" in ${accessPath}.`)

  // Verify the credentials now, so an invalid App Secret surfaces here rather
  // than at the next channel boot.
  const result = interpretTokenResponse(await probeCredentials(baseUrl, appId, appSecret))
  console.log(`[${result.verdict}] ${result.message}`)
  process.exit(EXIT_CODE[result.verdict])
}

// Run `main` when invoked as the program entry, not when a test imports this
// module. `realpathSync` canonicalizes the invocation path so it matches the
// symlink-resolved module URL.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('configure: unexpected failure:', err)
    process.exit(1)
  })
}
