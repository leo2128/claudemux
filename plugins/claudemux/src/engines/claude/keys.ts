/**
 * `tm`'s `_send_keys`: push a prompt into a teammate's tmux pane.
 *
 * The hot-path verbs (`spawn` atomic-prompt tail, `send`, `compact`)
 * share the same delivery shape — two modes by size, both clear the
 * idle/last/busy baseline first and touch `<name>.send-at`. Centralised
 * here so a future fix lands across every verb that composes them.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

import { clearIdle, resolveSid } from './idle'
import { sendAtFile, tmuxSessionName } from '../../persistence/paths'
import { die, requireSession, resolvePaneTarget } from './tmux'
import { sleepMs } from './clock'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'
import type { TmuxRunner } from '../../tmux'

/** Runtime knobs `_send_keys` reads from the environment. */
export interface SendKeysConfig {
  /** Max prompt size (chars) to take the inline `send-keys -l + Enter` path. */
  inlineMax: number
  /** Optional override (seconds) for the post-paste settle gap. */
  gapOverride: string | null
}

/**
 * Parse the env knobs for `_send_keys` once per call — a malformed value
 * dies up front rather than crashing the script mid-flow.
 */
export function readSendKeysConfig(env: NodeJS.ProcessEnv): SendKeysConfig | TmResult {
  const inlineRaw = env.TM_SEND_INLINE_MAX ?? ''
  const inlineMax = inlineRaw === '' ? 200 : Number(inlineRaw)
  if (inlineRaw !== '' && !/^[0-9]+$/.test(inlineRaw)) {
    return die(`TM_SEND_INLINE_MAX must be a non-negative integer (got: '${inlineRaw}')`)
  }
  const gapRaw = env.TM_SEND_GAP ?? ''
  if (gapRaw !== '' && !/^[0-9]+(\.[0-9]+)?$/.test(gapRaw)) {
    return die(`TM_SEND_GAP must be a non-negative number of seconds (got: '${gapRaw}')`)
  }
  return { inlineMax, gapOverride: gapRaw === '' ? null : gapRaw }
}

/** `tm`'s size-based default paste-buffer settle gap, in seconds. */
export function defaultPasteGapSec(promptLength: number): number {
  if (promptLength <= 256) return 0.2
  if (promptLength <= 1024) return 0.5
  if (promptLength <= 4096) return 1.0
  if (promptLength <= 16384) return 2.0
  return 4.0
}

/**
 * `tm`'s `_send_keys`. Two delivery modes by size:
 *
 *  - short single-line prompts take the inline `send-keys -l + Enter`
 *    fast path
 *  - larger or multi-line prompts stage the bytes in a named tmux
 *    buffer and `paste-buffer -p -r` them in a single bracketed-paste
 *    sequence, then send Enter after the trailing `\e[201~` marker
 *
 * Both modes clear the idle baseline first and touch `<name>.send-at`.
 *
 * Returns the `TmResult` whose stderr carries the `sent to ... ` /
 * `sid=...` lines `cmd_send`'s preamble emits.
 */
export async function sendKeys(
  name: TeammateName,
  prompt: string,
  runTmux: TmuxRunner,
  processEnv: NodeJS.ProcessEnv,
): Promise<TmResult> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(name, runTmux)
  if (pane === '') return die(`could not resolve pane target for ${name}`)

  const cfg = readSendKeysConfig(processEnv)
  if ('code' in cfg) return cfg

  // Clear the idle baseline before sending so the subsequent wait reflects
  // THIS turn, not a prior one. A no-sid case is the fresh-spawn path where
  // there is no prior turn to clear.
  const sid = resolveSid(name)
  if (sid !== null) clearIdle(sid)

  // `tm`'s `: > "$(send_at_file "$repo")"` — touch the marker.
  const sa = sendAtFile(name)
  mkdirSync(dirname(sa), { recursive: true })
  writeFileSync(sa, '')

  const n = prompt.length
  const inlinePath = n <= cfg.inlineMax && !prompt.includes('\n')

  const session = tmuxSessionName(name)
  let stderr = `sent to ${name} (tmux=${session})\n`
  if (sid !== null) stderr += `sid=${sid}\n`

  // `bin/tm` runs under `set -euo pipefail`, so a failed `tmux send-keys` /
  // `load-buffer` / `paste-buffer` aborts the script before the verb claims
  // success. Mirror that: any non-zero tmux exit fails the verb so the
  // dispatcher does not later block on a Stop hook that will never fire.
  const tmuxOk = (
    result: { code: number; stderr: string },
    what: string,
  ): TmResult | null =>
    result.code === 0
      ? null
      : die(`tmux ${what} failed: ${result.stderr.trim() || 'non-zero exit'}`)

  if (inlinePath) {
    const sent = await runTmux(['send-keys', '-t', pane, '-l', prompt])
    const sentErr = tmuxOk(sent, 'send-keys')
    if (sentErr !== null) return sentErr
    const enter = await runTmux(['send-keys', '-t', pane, 'Enter'])
    const enterErr = tmuxOk(enter, 'send-keys Enter')
    if (enterErr !== null) return enterErr
    return { code: 0, stdout: '', stderr }
  }

  const gap = cfg.gapOverride !== null ? Number(cfg.gapOverride) : defaultPasteGapSec(n)
  const buf = `tm-send-${process.pid}-${randomBytes(2).toString('hex')}`
  let loaded = false
  try {
    const loadResult = await runTmux(['load-buffer', '-b', buf, '-'], { stdin: prompt })
    const loadErr = tmuxOk(loadResult, 'load-buffer')
    if (loadErr !== null) return loadErr
    loaded = true
    const pasteResult = await runTmux([
      'paste-buffer',
      '-p',
      '-r',
      '-d',
      '-b',
      buf,
      '-t',
      pane,
    ])
    const pasteErr = tmuxOk(pasteResult, 'paste-buffer')
    if (pasteErr !== null) return pasteErr
    // `paste-buffer -d` deletes the buffer on success.
    loaded = false
    await sleepMs(Math.round(gap * 1000))
    const enter = await runTmux(['send-keys', '-t', pane, 'Enter'])
    const enterErr = tmuxOk(enter, 'send-keys Enter')
    if (enterErr !== null) return enterErr
  } finally {
    // Mirror `tm`'s RETURN trap: a `paste-buffer` that failed after
    // `load-buffer` succeeded would otherwise leak a named buffer entry.
    if (loaded) {
      try {
        await runTmux(['delete-buffer', '-b', buf])
      } catch {
        // Best effort — `tm` swallows this too (`2>/dev/null || true`).
      }
    }
  }
  return { code: 0, stdout: '', stderr }
}
