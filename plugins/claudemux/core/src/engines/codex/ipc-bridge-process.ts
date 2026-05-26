import { CodexIpcBridge } from './ipc-bridge.js'

async function main(): Promise<void> {
  const name = process.argv[2]
  if (name === undefined || name.length === 0) {
    throw new Error('usage: ipc-bridge-process <codex-teammate-name>')
  }
  await new CodexIpcBridge({ name, env: process.env }).run()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
