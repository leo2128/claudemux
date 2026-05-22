/**
 * Process entry point for the resident orchestration core.
 *
 * Responsibilities, in order: load and reconcile the teammate registry, start
 * the resident idle subscription, then listen on the unix-domain socket and
 * give every accepted connection its own MCP `Server` bound to the one shared
 * core. The core's registry and subscription outlive individual connections —
 * that residency is the whole point of the `next` line (see
 * `.agents/domains/mcp-native-orchestrator.md` §4).
 *
 * The testable logic lives in `core.ts`, `registry.ts`, and `subscription.ts`;
 * this file is the thin wiring that a unit test does not exercise.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, unlinkSync } from 'node:fs'
import { type Server as NetServer, connect, createServer } from 'node:net'

import { createCore } from './core'
import { coreSocketPath, registryFile, sidFile } from './paths'
import { Registry } from './registry'
import { SocketServerTransport } from './socket-transport'
import { IdleSubscription } from './subscription'
import { runTm } from './tm'

/**
 * Version advertised in the MCP `initialize` handshake. It names the version
 * *line* this core belongs to — it is not the governed plugin-manifest
 * `version`, which the release flow owns.
 */
const SERVER_VERSION = '1.0.0-beta.0'

/** Guidance injected into a connected dispatcher's system prompt. */
const CORE_INSTRUCTIONS = [
  'This MCP server is the claudemux orchestration core. Each tool named after a',
  '`tm` verb drives teammates by shelling out to `tm`; pass the verb arguments',
  'verbatim in the `args` array. The `teammates` tool lists the registry — the',
  "core's authoritative teammate set.",
].join('\n')

/**
 * A teammate is live if its repo-keyed `.sid` file still exists. `tm kill`
 * removes that file, so its absence means the teammate is gone. This is a
 * Phase A approximation — a teammate killed outside `tm` leaves a stale file;
 * Phase B's native `ls` gives reconciliation an authoritative source.
 */
function teammateIsAlive(repo: string): boolean {
  return existsSync(sidFile(repo))
}

/** Build one MCP `Server` for an accepted connection, bound to the shared core. */
function connectionServer(core: ReturnType<typeof createCore>): Server {
  const server = new Server(
    { name: 'claudemux-core', version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: CORE_INSTRUCTIONS },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: core.tools }))
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    core.handleTool(request.params.name, request.params.arguments ?? {}),
  )
  return server
}

/** Timestamped stderr log line. */
function log(message: string): void {
  console.error(`[claudemux-core] ${new Date().toISOString()} ${message}`)
}

/**
 * Listen on the core socket. If the path is already bound, probe it: a live
 * core means this process should stand down (the core is meant to be a
 * singleton); a refused probe means a stale socket file, which is removed
 * before one retry.
 */
function listenOnSocket(net: NetServer, socketPath: string, onLive: () => void): void {
  let retried = false
  net.on('listening', () => log(`listening on ${socketPath}`))
  // A persistent error handler, not `once`: the stale-socket recovery below
  // retries `listen`, and that retry can itself fail — the handler must stay
  // armed for it, or a second failure becomes an uncaught exception.
  net.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err
    if (retried) {
      // The stale-socket retry already ran; a fresh EADDRINUSE means another
      // core won the bind race. Stand down rather than crash.
      onLive()
      return
    }
    retried = true
    const probe = connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      onLive()
    })
    probe.once('error', () => {
      // Nothing is listening — the socket file is stale. Remove it and retry.
      if (existsSync(socketPath)) unlinkSync(socketPath)
      net.listen(socketPath)
    })
  })
  net.listen(socketPath)
}

async function main(): Promise<void> {
  const socketPath = coreSocketPath()

  const registry = new Registry(registryFile())
  registry.load()
  const subscription = new IdleSubscription()
  subscription.start()

  const dropped = registry.reconcile((entry) => teammateIsAlive(entry.repo))
  if (dropped.length > 0) {
    log(`reconciled out ${dropped.length} dead teammate(s): ${dropped.map((d) => d.repo).join(', ')}`)
  }

  const core = createCore({ runTm, registry, subscription })

  const net = createServer((socket) => {
    const transport = new SocketServerTransport(socket)
    transport.onerror = (err) => log(`connection error: ${err.message}`)
    connectionServer(core)
      .connect(transport)
      .catch((err) => {
        // The MCP handshake failed — close the socket so the connection and
        // its listeners do not leak for the life of the resident core.
        log(`failed to serve a connection: ${String(err)}`)
        socket.destroy()
      })
  })

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`)
    net.close()
    subscription.stop()
    if (existsSync(socketPath)) unlinkSync(socketPath)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  listenOnSocket(net, socketPath, () => {
    log(`another core is already listening on ${socketPath} — standing down`)
    subscription.stop()
    process.exit(0)
  })
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[claudemux-core] failed to start:', err)
    process.exit(1)
  })
}
