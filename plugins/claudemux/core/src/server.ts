/**
 * Process entry point for the resident orchestration core.
 *
 * It listens on the unix-domain socket and gives every accepted connection
 * its own MCP `Server` bound to the one shared core. The core's registry and
 * subscription outlive individual connections — that residency is the whole
 * point of the `next` line (see `.agents/domains/mcp-native-orchestrator.md`
 * §4).
 *
 * Startup ordering matters: shared and persistent state — the registry file,
 * the idle watch — is touched **only after this process wins the socket
 * bind** (`listenOnSocket`'s `onListening`). A second core that loses the race
 * stands down having written nothing, so it cannot clobber the winner's
 * registry.
 *
 * `createCoreNetServer` and `listenOnSocket` are exported so an integration
 * test can drive the socket server on a temporary path; `main` is the thin
 * process wiring a unit test does not exercise.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, unlinkSync } from 'node:fs'
import { type Server as NetServer, connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runColumn } from './column'
import { type Core, createCore } from './core'
import { coreSocketPath, registryFile, sidFile } from './paths'
import { Registry } from './registry'
import { SocketServerTransport } from './socket-transport'
import { IdleSubscription } from './subscription'
import { runTm } from './tm'
import { runTmux } from './tmux'

/**
 * Version advertised in the MCP `initialize` handshake. It names the version
 * *line* this core belongs to — it is not the governed plugin-manifest
 * `version`, which the release flow owns.
 */
const SERVER_VERSION = '1.0.0-beta.0'

/** Guidance injected into a connected dispatcher's system prompt. */
const CORE_INSTRUCTIONS = [
  'This MCP server is the claudemux orchestration core. Each tool named after a',
  '`tm` verb drives teammates; pass the verb arguments verbatim in the `args`',
  "array. The `teammates` tool lists the registry — the core's authoritative",
  'teammate set.',
].join('\n')

/**
 * A teammate is live if its repo-keyed `.sid` file still exists. `tm kill`
 * removes that file, so its absence means the teammate is gone. This is an
 * approximation — a teammate killed outside `tm` leaves a stale file; a later
 * Phase B step will give reconciliation an authoritative source via the
 * native `ls`.
 */
function teammateIsAlive(repo: string): boolean {
  return existsSync(sidFile(repo))
}

/** Timestamped stderr log line. */
function log(message: string): void {
  console.error(`[claudemux-core] ${new Date().toISOString()} ${message}`)
}

/** Build one MCP `Server` for an accepted connection, bound to the shared core. */
function connectionServer(core: Core): Server {
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

/**
 * Build the net server that accepts core connections — each socket gets its
 * own MCP `Server` bound to the one shared `core`. Exported for integration
 * tests, which drive it on a temporary socket path.
 */
export function createCoreNetServer(core: Core): NetServer {
  return createServer((socket) => {
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
}

/** Callbacks `listenOnSocket` fires once the bind outcome is known. */
export interface ListenCallbacks {
  /** The bind succeeded — this process owns the socket and may init state. */
  onListening: () => void
  /** Another core already owns the socket — this process should stand down. */
  onLive: () => void
}

/**
 * Listen on the core socket. If the path is already bound, probe it: a live
 * core means this process should stand down (the core is a singleton); a
 * refused probe means a stale socket file, removed before one retry.
 *
 * `onListening` fires exactly once, only when this process wins the bind, so
 * callers init shared and persistent state there and nowhere earlier — a
 * process destined to stand down then never writes it.
 */
export function listenOnSocket(
  net: NetServer,
  socketPath: string,
  callbacks: ListenCallbacks,
): void {
  let retried = false
  net.on('listening', () => {
    log(`listening on ${socketPath}`)
    callbacks.onListening()
  })
  // A persistent error handler, not `once`: the stale-socket recovery below
  // retries `listen`, and that retry can itself fail — the handler must stay
  // armed for it, or a second failure becomes an uncaught exception.
  net.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err
    if (retried) {
      // The stale-socket retry already ran; a fresh EADDRINUSE means another
      // core won the bind race. Stand down rather than crash.
      callbacks.onLive()
      return
    }
    retried = true
    const probe = connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      callbacks.onLive()
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
  const subscription = new IdleSubscription()
  // The dispatcher directory and the Claude Code projects directory, read once
  // at boot. `tm` resolves the dispatcher dir the same way — `TM_DISPATCHER_DIR`
  // or the cwd — and the projects dir mirrors `tm`'s use of `$HOME` to address
  // `~/.claude/projects`.
  const dispatcherDir = process.env.TM_DISPATCHER_DIR ?? process.cwd()
  const projectsDir = join(process.env.HOME ?? homedir(), '.claude', 'projects')
  // `createCore` only assembles the tool list and a dispatcher closure over
  // these objects; it touches no shared state, so it is safe before the bind.
  const core = createCore({
    runTm,
    runTmux,
    runColumn,
    registry,
    subscription,
    dispatcherDir,
    projectsDir,
  })
  const net = createCoreNetServer(core)

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`)
    net.close()
    subscription.stop()
    if (existsSync(socketPath)) unlinkSync(socketPath)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  listenOnSocket(net, socketPath, {
    onListening: () => {
      // The bind is won — only now touch shared and persistent state. A second
      // core that raced this one stands down via `onLive` having written
      // nothing, so it cannot clobber this winner's registry.
      registry.load()
      subscription.start()
      const dropped = registry.reconcile((entry) => teammateIsAlive(entry.repo))
      if (dropped.length > 0) {
        log(
          `reconciled out ${dropped.length} dead teammate(s): ` +
            dropped.map((d) => d.repo).join(', '),
        )
      }
    },
    onLive: () => {
      log(`another core is already listening on ${socketPath} — standing down`)
      process.exit(0)
    },
  })
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[claudemux-core] failed to start:', err)
    process.exit(1)
  })
}
