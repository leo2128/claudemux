/**
 * The process entrypoint — `tm`'s `argv` → `runCli` → `process` streams + exit code.
 *
 * Kept separate from [`cli.ts`](./cli.ts) so the library (`runCli`,
 * `productionEnv`) imports cleanly into tests and harnesses without a side
 * effect at module-load time. The `bin/tm` launcher execs Node against this
 * file under `--experimental-transform-types`, so there is no build step
 * between source and runtime.
 */

import { productionEnv, runCli, triggersHelp } from './cli'

/** Read all of stdin; `undefined` on an interactive TTY so we never block on a never-arriving EOF. */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // `archive` is the only verb that reads stdin. Slurp it only when the
  // invocation will actually reach the verb handler — `tm archive --help` /
  // `tm archive -h` route to the help branch and read no stdin in bash, so
  // we must skip the slurp there too or the launcher blocks indefinitely on
  // any caller whose stdin is a pipe an upstream producer holds open.
  const needsStdin = argv[0] === 'archive' && !triggersHelp(argv.slice(1))
  const stdin = needsStdin ? await readStdin() : undefined
  const result = await runCli(argv, productionEnv(), stdin)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}

main().catch((err) => {
  process.stderr.write(`[tm] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
