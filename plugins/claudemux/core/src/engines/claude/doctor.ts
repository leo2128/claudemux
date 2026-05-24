/**
 * `tm doctor` — a read-only environment self-check. Sections fire
 * top-down: the `tm` executable, the dispatcher dir, tmux, the idle
 * dir, the active teammate list, and the codex teammates. Soft-fails
 * throughout (every probe is guarded) and always exits 0; output is
 * meant to be eyeballed, not parsed.
 *
 * The path the "tm executable" section reports is the
 * `<plugin-root>/bin/tm` launcher. The caller passes the resolved
 * paths in (`tmWrapper`, `pluginJson`) because the relative-`../..`
 * computation has to be done from a `core/src/*.ts` file (or the
 * bundled `core/dist/cli.mjs`) — engines/claude/doctor.ts sits two
 * directories deeper, so the math does not work from here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'

import { isDirectory } from './idle'
import { iterTeammates } from './tmux'
import { die } from './tmux'
import { fmtLocalDateTime } from './clock'
import { TMUX_SESSION_PREFIX } from './persistence'
import { idleDir } from '../../paths'
import {
  isProcessAlive as codexProcessAlive,
  listDaemons as listCodexDaemons,
  readDaemonState as readCodexState,
  reapDaemon as reapCodexDaemon,
} from '../codex/supervisor'
import { removeBaseRecord as removeCodexBaseRecord } from '../codex/persistence'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

export interface DoctorPaths {
  /** Absolute path to the `<plugin-root>/bin/tm` launcher. */
  tmWrapper: string
  /** Absolute path to `<plugin-root>/.claude-plugin/plugin.json`. */
  pluginJson: string
}

export async function claudeDoctor(
  args: readonly string[],
  env: ClaudeVerbEnv,
  paths: DoctorPaths,
): Promise<TmResult> {
  if (args.length > 0) {
    return die(`tm doctor: takes no arguments (got: ${args.join(' ')})`)
  }

  // The kv row: a 20-character padded label, then the value — matches
  // `cmd_doctor`'s `printf '  %-20s%s\n'`. One source of truth here
  // keeps alignment immune to label renames.
  const kv = (label: string, value: string): string => {
    const padded = `${label}:`.padEnd(20, ' ')
    return `  ${padded}${value}\n`
  }

  let out = ''

  // --- tm executable ---
  const { tmWrapper, pluginJson } = paths
  let version = 'unknown'
  let pluginJsonPresent = false
  try {
    if (statSync(pluginJson).isFile()) {
      pluginJsonPresent = true
      const parsed = JSON.parse(readFileSync(pluginJson, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        version = parsed.version
      }
    }
  } catch {
    pluginJsonPresent = false
  }
  out += 'tm executable:\n'
  out += kv('path', tmWrapper)
  out += kv('version', version)
  if (!pluginJsonPresent) out += kv('note', `plugin.json not found at ${pluginJson}`)
  out += '\n'

  // --- dispatcher dir ---
  out += 'dispatcher dir:\n'
  out += kv('resolved', env.dispatcherDir)
  const envSet = process.env.TM_DISPATCHER_DIR
  if (envSet !== undefined && envSet.length > 0) {
    out += kv('TM_DISPATCHER_DIR', `set (= ${envSet})`)
  } else {
    out += kv(
      'TM_DISPATCHER_DIR',
      'unset — falling back to $PWD (run /claudemux:setup to inoculate against cwd drift)',
    )
  }
  const pwd = process.cwd()
  out += kv('$PWD', pwd)
  if (env.dispatcherDir !== pwd) {
    out += kv(
      'status',
      'DIVERGED — dispatcher dir != $PWD; env override is currently keeping tm correct despite the drifted PWD',
    )
  } else {
    out += kv('status', 'matched')
  }
  if (!isDirectory(env.dispatcherDir)) {
    out += kv('warning', `${env.dispatcherDir} does not exist as a directory`)
  }
  out += '\n'

  // --- tmux ---
  out += 'tmux:\n'
  let tmuxVersionOk = false
  let tmuxVersionLine = ''
  try {
    const versionResult = await env.runTmux(['-V'])
    if (versionResult.code === 0) {
      tmuxVersionOk = true
      tmuxVersionLine = versionResult.stdout.split('\n')[0] ?? '?'
    }
  } catch {
    tmuxVersionOk = false
  }
  if (!tmuxVersionOk) {
    out += kv('installed', 'no (tmux not on PATH — claudemux teammate workflow needs it)')
  } else {
    out += kv('installed', `yes (${tmuxVersionLine})`)
    let serverRunning = false
    try {
      serverRunning = (await env.runTmux(['info'])).code === 0
    } catch {
      serverRunning = false
    }
    if (serverRunning) out += kv('server', 'running')
    else out += kv('server', "not running (no sessions exist yet — that's fine pre-spawn)")
    const insideTmux = process.env.TMUX ?? ''
    if (insideTmux.length > 0) out += kv('in tmux', `yes (TMUX=${insideTmux})`)
    else out += kv('in tmux', 'no — tm is being run from outside a tmux session')
  }
  out += '\n'

  // --- idle dir ---
  out += `idle dir (${idleDir()}):\n`
  if (isDirectory(idleDir())) {
    let count = 0
    try {
      count = readdirSync(idleDir()).length
    } catch {
      count = 0
    }
    out += kv('exists', `yes (${count} file(s))`)
  } else {
    out += kv('exists', 'no — gets created on first tm spawn / scripts/setup.sh')
  }
  out += '\n'

  // --- active teammates ---
  // `cmd_doctor` projects each `tmux ls` row to its session field and
  // prints it with a two-space indent — bare session name, not the
  // full row.
  out += 'active teammates:\n'
  const sessionRows = (await iterTeammates(env.runTmux)).map(
    (name) => `${TMUX_SESSION_PREFIX}${name}`,
  )
  if (sessionRows.length === 0) {
    out += "  (none — use 'tm spawn <repo>' to launch one)\n"
  } else {
    out += kv('count', String(sessionRows.length))
    for (const name of sessionRows) out += `  ${name}\n`
  }
  out += '\n'

  // --- codex teammates ---
  out += 'codex teammates:\n'
  const codexNames = listCodexDaemons()
  if (codexNames.length === 0) {
    out += "  (none — use 'tm spawn codex-<n>' to launch one)\n"
  } else {
    const reaped: string[] = []
    const live: { name: string; pid: number; startedAt: number }[] = []
    for (const name of codexNames) {
      const state = readCodexState(name)
      if (state === null) {
        reaped.push(name)
        await reapCodexDaemon(name)
        removeCodexBaseRecord(name)
      } else if (!codexProcessAlive(state.pid)) {
        reaped.push(name)
        await reapCodexDaemon(name)
        removeCodexBaseRecord(name)
      } else {
        live.push({ name, pid: state.pid, startedAt: state.startedAt })
      }
    }
    out += kv('count', String(live.length))
    for (const t of live) {
      out += `  ${t.name} (pid=${t.pid}, started ${fmtLocalDateTime(t.startedAt)})\n`
    }
    if (reaped.length > 0) {
      out += kv('reaped orphans', String(reaped.length))
      for (const name of reaped) out += `  ${name}\n`
    }
  }

  return { code: 0, stdout: out, stderr: '' }
}
