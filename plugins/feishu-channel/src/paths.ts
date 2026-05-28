/**
 * Path builders for the channel's on-disk state.
 *
 * Every path under the state directory is constructed by a named builder
 * here, never by string concatenation at the use site — the layout is the
 * coupling layer between the channel server and the access skill, so a schema
 * change stays a single-file edit.
 *
 * Each builder accepts an explicit base directory so tests can point the
 * whole tree at a temporary directory.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root of all channel state: ~/.claude/channels/feishu */
export function stateDir(home: string = homedir()): string {
  return join(home, '.claude', 'channels', 'feishu')
}

/** access.json — the access-control policy, managed by the access skill. */
export function accessFile(base: string = stateDir()): string {
  return join(base, 'access.json')
}

/** .env — Feishu app credentials (FEISHU_APP_ID / FEISHU_APP_SECRET). */
export function envFile(base: string = stateDir()): string {
  return join(base, '.env')
}

/** connection.lock — the single-instance lock for the inbound WebSocket. */
export function lockFile(base: string = stateDir()): string {
  return join(base, 'connection.lock')
}

/**
 * observed-bots-{appId}-{chatId}.json — bots discovered via /introduce in a
 * specific group, keyed by the observing app's perspective (open_ids in this
 * file are valid for this app to use when @-mentioning).
 */
export function observedBotsFile(base: string, appId: string, chatId: string): string {
  return join(base, `observed-bots-${appId}-${chatId}.json`)
}
