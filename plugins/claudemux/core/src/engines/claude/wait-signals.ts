/**
 * `tm`'s `_wait_idle_signal` and `_wait_pane_quiet` — the two block-
 * until-the-turn-ends primitives `tm send` and `tm wait` compose. The
 * idle-marker path is the primary signal; pane-quiet is a fallback for
 * sessions whose Stop hook is not loaded.
 */

import { existsSync, statSync } from 'node:fs'

import { clearIdle, resolveSidOrDie, resolveSid, isRegularFile } from './idle'
import { busyMarkerFor, idleMarkerFor, sendAtFile } from './persistence'
import { requireSession } from './tmux'
import { nowSec, sleepMs } from './clock'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'
import type { TmuxRunner } from '../../tmux'

/**
 * `tm`'s `_wait_idle_signal`: block until `/tmp/claude-idle/<sid>`
 * exists, or `timeoutSec` elapses. Returns the resolved `TmResult` on
 * early-out (no-such-session / no-sid), or `{ ok }` once the loop has
 * its verdict.
 */
export async function waitIdleSignal(
  name: TeammateName,
  timeoutSec: number,
  fresh: boolean,
  runTmux: TmuxRunner,
): Promise<TmResult | { ok: boolean }> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(name)
  if ('error' in sidR) return sidR.error
  if (fresh) clearIdle(sidR.sid)

  const end = nowSec() + timeoutSec
  const marker = idleMarkerFor(sidR.sid)
  while (nowSec() < end) {
    if (existsSync(marker)) return { ok: true }
    await sleepMs(3000)
  }
  return { ok: false }
}

/**
 * `tm`'s `_wait_pane_quiet`: block until the teammate's pane has shown
 * no busy marker for ~4s AND at least 3s have passed since the last
 * send. Returns the resolved `TmResult` on early-out or `{ ok }` once
 * decided.
 */
export async function waitPaneQuiet(
  name: TeammateName,
  timeoutSec: number,
  runTmux: TmuxRunner,
): Promise<TmResult | { ok: boolean }> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) return sessionMissing

  let sendAt = 0
  try {
    sendAt = Math.floor(statSync(sendAtFile(name)).mtimeMs / 1000)
  } catch {
    sendAt = 0
  }

  const end = nowSec() + timeoutSec
  let quietStreak = 0
  while (nowSec() < end) {
    const sid = resolveSid(name)
    const isBusy = sid !== null && isRegularFile(busyMarkerFor(sid))
    if (isBusy) quietStreak = 0
    else quietStreak += 1
    if (quietStreak >= 2 && nowSec() - sendAt >= 3) return { ok: true }
    await sleepMs(2000)
  }
  return { ok: false }
}
