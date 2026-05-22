/**
 * Integration coverage for the socket server: a real MCP client over a real
 * unix socket, and the stale-socket recovery path. This exercises the wiring
 * that `core.test.ts` (a transport-agnostic core) and `socket-transport.test.ts`
 * (a fake socket) do not — `createCoreNetServer` + `listenOnSocket` end to end.
 *
 * The core here runs on fakes (a canned `tm` runner, a throwaway registry, a
 * stub signal source), so the test needs no real `tm`, tmux, or `/tmp`
 * markers — only a unix socket, which it binds on a unique throwaway path.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server as NetServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore } from '../src/core'
import { Registry } from '../src/registry'
import { createCoreNetServer, listenOnSocket } from '../src/server'
import type { SignalSource } from '../src/subscription'
import type { TmRunner } from '../src/tm'
import type { TmuxRunner } from '../src/tmux'

/** A stub signal source — nothing is ever observed. */
const fakeSignals: SignalSource = { signalFor: () => undefined }

/** A fake `tm` runner — echoes the verb and args so a call result is checkable. */
const echoRunner: TmRunner = async (verb, args) => ({
  code: 0,
  stdout: `VERB:${verb} ARGS:${args.join(',')}`,
  stderr: '',
})

/** A fake `tmux` runner — the socket tests drive non-native verbs only. */
const quietTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })

/** Build a core over fakes, on a throwaway registry file. */
function fakeCore(dir: string): ReturnType<typeof createCore> {
  return createCore({
    runTm: echoRunner,
    runTmux: quietTmux,
    registry: new Registry(join(dir, 'registry.json')),
    subscription: fakeSignals,
    dispatcherDir: dir,
    projectsDir: dir,
  })
}

/** A short socket path — `/tmp` keeps it under the unix-socket length limit. */
function tempSocketPath(): string {
  return `/tmp/claudemux-coretest-${randomUUID().slice(0, 8)}.sock`
}

/** Resolve once the server is listening; reject if it stands down instead. */
function bind(net: NetServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    listenOnSocket(net, socketPath, {
      onListening: () => resolve(),
      onLive: () => reject(new Error('stood down — the test expected to win the bind')),
    })
  })
}

/** A parsed MCP reply line, only the fields the test reads. */
interface Reply {
  id?: number
  result?: { isError?: boolean; content?: { text?: string }[] }
}

/**
 * Connect to the core over a unix socket, run one MCP tool call, resolve with
 * its result. Speaks the SDK's newline-delimited JSON-RPC by hand — enough to
 * drive a handshake and one call without a client-side transport.
 */
function callTool(
  socketPath: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath)
    let buf = ''
    let sentCall = false
    const send = (m: unknown): void => {
      sock.write(`${JSON.stringify(m)}\n`)
    }

    sock.on('error', reject)
    sock.once('connect', () => {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      })
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line) as Reply
        if (msg.id === 1 && !sentCall) {
          // The handshake is done — send `initialized`, then the one call.
          sentCall = true
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
        } else if (msg.id === 2) {
          sock.end()
          resolve({ isError: msg.result?.isError, text: msg.result?.content?.[0]?.text ?? '' })
        }
      }
    })
  })
}

describe('the socket server', () => {
  let net: NetServer | null = null
  let socketPath = ''
  const dirs: string[] = []

  afterEach(() => {
    net?.close()
    net = null
    if (socketPath && existsSync(socketPath)) rmSync(socketPath, { force: true })
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claudemux-server-'))
    dirs.push(dir)
    return dir
  }

  test('serves an MCP tool call over a unix socket', async () => {
    socketPath = tempSocketPath()
    net = createCoreNetServer(fakeCore(freshDir()))
    await bind(net, socketPath)

    const result = await callTool(socketPath, 'doctor', { args: [] })
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('VERB:doctor')
  })

  test('serves a natively-migrated verb over the socket', async () => {
    socketPath = tempSocketPath()
    net = createCoreNetServer(fakeCore(freshDir()))
    await bind(net, socketPath)

    // `ls` runs natively, not via the `tm` shell-out; `quietTmux` reports no
    // sessions, so the native handler returns its "no teammate sessions" line.
    const result = await callTool(socketPath, 'ls', { args: [] })
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('no teammate sessions')
  })

  test('recovers from a stale socket file, then serves', async () => {
    socketPath = tempSocketPath()
    // A leftover file at the socket path: `net.listen` fails EADDRINUSE, the
    // recovery probes it, finds nothing listening, unlinks it, and retries.
    writeFileSync(socketPath, '')
    net = createCoreNetServer(fakeCore(freshDir()))
    await bind(net, socketPath) // rejects if it stood down instead of recovering

    const result = await callTool(socketPath, 'states', { args: [] })
    expect(result.text).toContain('VERB:states')
  })
})
