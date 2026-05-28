/**
 * The process spawn primitive.
 *
 * Every shell-out backend — `tm.ts`, `tmux.ts`, `column.ts`, `grep.ts` —
 * spawns a child, optionally feeds it stdin, and captures its exit code,
 * stdout, and stderr in full. `spawnCapture` is that one primitive, over Node's
 * `child_process`. Output is collected with no size cap, so a large pane
 * capture or `tm history` listing is never truncated.
 */

import { spawn } from 'node:child_process'

/** A child process's faithful exit-code + stream capture. */
export interface ProcResult {
  /** Process exit code; `1` when the process was terminated by a signal. */
  code: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/**
 * Spawn `argv[0]` with the rest as its arguments, optionally feeding `stdin`,
 * and resolve with its exit code and captured streams. `env` and `cwd`
 * override the inherited process environment and working directory. Rejects
 * if the child fails to spawn (a missing or non-executable binary); a
 * non-zero exit is a resolved result, since `tm` verbs exit non-zero as
 * ordinary behavior.
 */
export function spawnCapture(
  argv: readonly string[],
  options?: { stdin?: string; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    if (command === undefined) {
      reject(new Error('spawnCapture: empty argument vector'))
      return
    }
    const child = spawn(command, args, {
      // `pipe` on all three streams, so `child.stdin/stdout/stderr` are the
      // non-null streams the capture below relies on.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options?.env ?? process.env,
      cwd: options?.cwd,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    // The child may exit before consuming all of stdin (`grep -q` stops at the
    // first match); the resulting broken-pipe write error is expected — the
    // exit code and captured output are what matter — so swallow it.
    child.stdin!.on('error', () => {})
    child.stdin!.end(options?.stdin ?? '')
  })
}
