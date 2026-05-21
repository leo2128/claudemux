/**
 * Inspect a running process — its command line and working directory.
 *
 * The single-instance lock uses this to decide whether the process holding
 * the lock is an older feishu-channel channel server that a freshly-started
 * server should evict. Two facts identify such a holder: its command line
 * (it runs the channel's `server.ts` entry point) and its working directory
 * (the plugin-cache version directory it was launched in,
 * `.../feishu-channel/<version>`).
 *
 * This module is the OS boundary: reading another process's cwd has no
 * portable API, so `readCwd` branches on the platform. It is not unit-tested
 * for the same reason — the lock's decision logic is tested against an
 * injected probe.
 */

import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'

/** What a process probe reports about a live PID. */
export interface ProcessProbe {
  /** The process's full command line, as `ps` renders it. */
  command: string
  /** The process's current working directory, an absolute path. */
  cwd: string
}

/** Cap on each inspection command so a stuck `ps`/`lsof` cannot hang startup. */
const PROBE_TIMEOUT_MS = 3_000

/**
 * Probe process `pid`. Returns its command line and cwd, or `undefined` when
 * either cannot be determined — a PID that is gone, a process this user may
 * not inspect, or a missing inspection tool. An `undefined` result is the
 * signal to leave the holder alone, so a probe failure can never cause a kill.
 */
export function probeProcess(pid: number): ProcessProbe | undefined {
  const command = readCommand(pid)
  const cwd = readCwd(pid)
  if (command === undefined || cwd === undefined) return undefined
  return { command, cwd }
}

/** Read a process's command line via `ps` — `-p`/`-o args=` are portable across BSD and GNU. */
function readCommand(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })
    const line = out.trim()
    return line.length > 0 ? line : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a process's cwd. There is no portable command for this, so this is the
 * OS-detected helper: Linux exposes the cwd as the `/proc/<pid>/cwd` symlink,
 * while macOS has no `/proc` and goes through `lsof`.
 */
function readCwd(pid: number): string | undefined {
  return process.platform === 'linux' ? readCwdProc(pid) : readCwdLsof(pid)
}

/** Linux: the cwd is the target of the `/proc/<pid>/cwd` symlink. */
function readCwdProc(pid: number): string | undefined {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    return cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/** macOS: `lsof` reports the cwd as the `cwd` descriptor; `-F n` prints it as `n<path>`. */
function readCwdLsof(pid: number): string | undefined {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F', 'n'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1)
    }
    return undefined
  } catch {
    return undefined
  }
}
