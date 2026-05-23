/**
 * The process entrypoint — `tm`'s `argv` → `runCli` → `process` streams + exit code.
 *
 * Kept separate from [`cli.ts`](./cli.ts) so the library (`runCli`,
 * `productionEnv`) imports cleanly into tests and harnesses without a side
 * effect at module-load time. esbuild bundles *this* file for production
 * (`dist/cli.cjs`); the dev launcher `core/bin/tm` runs this file through
 * `tsx` with no rebuild step.
 */

import { productionEnv, runCli } from './cli'

/** Read all of stdin; `undefined` on an interactive TTY so we never block on a never-arriving EOF. */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // `archive` is the only verb that reads stdin; reading it for any other verb
  // risks blocking on a pipe that is open but never written.
  const stdin = argv[0] === 'archive' ? await readStdin() : undefined
  const result = await runCli(argv, productionEnv(), stdin)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}

main().catch((err) => {
  process.stderr.write(`[tm] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
