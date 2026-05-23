/**
 * Codex-teammate verb implementations.
 *
 * The hot-path verbs (`tm spawn`, `tm send`, `tm wait`, `tm kill`) fork on
 * the first positional: a name starting with `codex-` routes here instead
 * of into the tmux + hooks path that drives Claude teammates. The fork is
 * a name-prefix convention — `codex-1`, `codex-reviewer`, etc — and the
 * routing happens in [`native.ts`](./native.ts) at the head of each verb.
 *
 * Each function here returns the same `TmResult` shape every other verb
 * does, so the dispatcher experience stays uniform across teammate kinds.
 * The runtime substrate is split across three smaller modules:
 *
 *   - [`codex-supervisor.ts`](./codex-supervisor.ts) — spawn the daemon,
 *     check liveness, reap.
 *   - [`codex-ws.ts`](./codex-ws.ts) — open the WebSocket connection
 *     and speak the JSON-RPC envelope.
 *   - [`codex-protocol/`](./codex-protocol) — the vendored generated
 *     bindings that type every request and notification.
 *
 * Stage 4 keeps the codex verb surface intentionally narrow — spawn,
 * send, wait, kill — and prints raw `Turn` JSON for now; richer
 * assistant-message extraction lands in stage 4's integration suite
 * (#36) where a real codex is available to validate the parsing against.
 */

import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { CodexWsClient } from './codex-ws.js'
import {
  daemonAlive,
  listDaemons,
  readDaemonState,
  reapDaemon,
  spawnDaemon,
  touchLastSeen,
  writeThreadId,
} from './codex-supervisor.js'
import { codexSocketPath, codexTeammateDir, codexThreadFile } from './paths.js'
import type {
  ClientInfo,
  InitializeResponse,
  ServerNotification,
} from './codex-protocol/index.js'
import type { ThreadStartResponse } from './codex-protocol/v2/ThreadStartResponse.js'
import type { TurnCompletedNotification } from './codex-protocol/v2/TurnCompletedNotification.js'
import type { TurnStartResponse } from './codex-protocol/v2/TurnStartResponse.js'
import type { TmResult } from './tm.js'

const CLIENT_INFO: ClientInfo = {
  name: 'claudemux',
  title: null,
  version: '1.0.0-beta.0',
}

/** Per-codex-verb `die` — mirrors the `tm: <msg>` wire shape native.ts uses. */
function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/** Names a codex teammate? Verbs check this to fork into this module. */
export function isCodexTarget(name: string): boolean {
  return name.startsWith('codex-')
}

/**
 * Open a fresh `CodexWsClient` against the named daemon, complete the
 * `initialize` handshake, and return the ready client.
 *
 * Stage 4 opens a new connection per verb invocation rather than holding
 * one open across invocations — `tm` is stateless per call, and the
 * daemon is the part that persists. The `initialize` round-trip is a few
 * ms; the cost is in the price of the simpler model.
 */
async function openInitialized(name: string): Promise<CodexWsClient> {
  const client = new CodexWsClient({ socketPath: codexSocketPath(name) })
  await client.ready()
  await client.request<'initialize', InitializeResponse>('initialize', {
    clientInfo: CLIENT_INFO,
    capabilities: {
      // Opt into the experimental methods the codex protocol marks
      // upstream — every verb here uses one (thread/start, turn/start,
      // turn/completed). Without this opt-in the daemon would suppress
      // them.
      experimentalApi: true,
      requestAttestation: false,
    },
  })
  return client
}

/** Read the persisted thread id for `name`, or null if no thread has been started. */
function readThreadId(name: string): string | null {
  try {
    const txt = readFileSync(codexThreadFile(name), 'utf8').trim()
    return txt.length === 0 ? null : txt
  } catch {
    return null
  }
}

/**
 * Wait for the next server-emitted notification matching `method`. Resolves
 * with the notification payload; never rejects (close-of-connection is the
 * client's own concern and the resulting promise is left dangling — the
 * caller's `client.close()` in a `finally` is the cleanup hook).
 */
function waitForNotification<M extends ServerNotification['method']>(
  client: CodexWsClient,
  method: M,
): Promise<Extract<ServerNotification, { method: M }>> {
  return new Promise<Extract<ServerNotification, { method: M }>>((resolve) => {
    client.onNotification((notif) => {
      if (notif.method === method) {
        resolve(notif as Extract<ServerNotification, { method: M }>)
      }
    })
  })
}

/**
 * `tm spawn codex-<n>` — bring up a fresh codex daemon and, optionally,
 * deliver an initial prompt. The codex equivalent of `tm spawn <repo>`
 * for a Claude teammate.
 *
 * Stage 4 keeps the option surface minimal — no `--task`, no `--model`
 * override yet. A follow-up extends it.
 */
export async function codexSpawn(name: string): Promise<TmResult> {
  try {
    const state = await spawnDaemon({ name })
    return {
      code: 0,
      stdout: '',
      stderr: `spawned: ${name} (pid=${state.pid}, socket=${state.socketPath})\n`,
    }
  } catch (e) {
    return die((e as Error).message)
  }
}

/**
 * Drive one `turn/start` on `threadId`. If `wait` is true, install the
 * notification listener *before* sending the request and resolve with the
 * matching `turn/completed.params`. If `wait` is false, send the request
 * and return; the caller will subscribe to `turn/completed` from a later
 * `tm wait codex-<n>` invocation.
 */
async function runTurn(
  client: CodexWsClient,
  threadId: string,
  prompt: string,
  wait: boolean,
): Promise<TurnCompletedNotification | null> {
  // The listener has to register before the request fires so a fast-
  // firing completion (common on a short, cached prompt) cannot land
  // between the `await` returning and `onNotification` being installed.
  const completed = wait ? waitForNotification(client, 'turn/completed') : null

  await client.request<'turn/start', TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
  })

  if (completed === null) return null
  const notif = await completed
  return notif.params
}

/**
 * `tm send codex-<n> "<prompt>"` — drive one turn on the codex teammate's
 * thread. Starts a thread on first send, reuses it after.
 *
 * With `--no-wait`, fires `turn/start` and returns immediately; the turn
 * proceeds on the daemon and a subsequent `tm wait codex-<n>` blocks on
 * its `turn/completed`. Without `--no-wait` the call blocks on completion
 * and returns the raw `Turn` JSON on stdout.
 */
export async function codexSend(
  name: string,
  prompt: string,
  opts: { noWait?: boolean } = {},
): Promise<TmResult> {
  if (!daemonAlive(name)) {
    return die(
      `codex teammate '${name}' is not alive — try 'tm spawn ${name}' first`,
    )
  }
  if (prompt.length === 0) {
    return die('usage: tm send <teammate> "<prompt>"')
  }
  const noWait = opts.noWait ?? false

  // Wrap the whole protocol round-trip so a ws-connect or RPC failure
  // surfaces as the standard `tm: <message>` stderr line rather than
  // bubbling up to main.ts's `[tm] …` catch-all (which a dispatcher
  // grep-matching `^tm:` would miss).
  let client: CodexWsClient | null = null
  try {
    client = await openInitialized(name)
    let threadId = readThreadId(name)
    if (threadId === null) {
      const resp = await client.request<'thread/start', ThreadStartResponse>(
        'thread/start',
        {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      )
      threadId = resp.thread.id
      writeThreadId(name, threadId)
    }

    const params = await runTurn(client, threadId, prompt, !noWait)
    touchLastSeen(name)

    if (params === null) {
      return {
        code: 0,
        stdout: '',
        stderr: `sent: ${name} (thread=${threadId}, --no-wait; use 'tm wait ${name}' for the reply)\n`,
      }
    }

    return {
      code: 0,
      stdout: JSON.stringify(params, null, 2) + '\n',
      stderr: '',
    }
  } catch (e) {
    return die(
      `codex send on '${name}' failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    if (client !== null) client.close()
  }
}

/**
 * `tm wait codex-<n>` — block until the teammate's next `turn/completed`
 * (an in-progress turn driven by some other caller).
 *
 * The dispatcher uses this when it has issued an asynchronous `turn/start`
 * elsewhere — typically a `tm send --no-wait` — and now needs the result.
 */
export async function codexWait(name: string): Promise<TmResult> {
  if (!daemonAlive(name)) {
    return die(`codex teammate '${name}' is not alive`)
  }

  let client: CodexWsClient | null = null
  try {
    client = await openInitialized(name)
    const completed = await waitForNotification(client, 'turn/completed')
    touchLastSeen(name)
    return {
      code: 0,
      stdout: JSON.stringify(completed.params, null, 2) + '\n',
      stderr: '',
    }
  } catch (e) {
    return die(
      `codex wait on '${name}' failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    if (client !== null) client.close()
  }
}

/**
 * `tm kill codex-<n>` — SIGTERM the daemon (SIGKILL after a grace) and
 * remove the registry entry. Idempotent on a missing name.
 */
export async function codexKill(name: string): Promise<TmResult> {
  const state = readDaemonState(name)
  await reapDaemon(name)
  if (state === null) {
    return {
      code: 0,
      stdout: '',
      stderr: `no codex teammate '${name}' to kill (already gone)\n`,
    }
  }
  return {
    code: 0,
    stdout: '',
    stderr: `killed: ${name} (was pid=${state.pid})\n`,
  }
}

/**
 * Pool-style borrow on a codex teammate.
 *
 * Decision 0019 §6: ask mode is a thin wrapper on top of the teammate
 * substrate — the named `codex-<n>` teammates are *the* pool. An ask
 * borrows one, drives a turn on a fresh thread (so the borrowed
 * teammate's persistent conversation thread is not polluted), and
 * returns the teammate to the pool. The lock file is the rendezvous:
 * an `O_EXCL` create succeeds atomically for exactly one caller, the
 * rest see EEXIST and pass over that teammate.
 */
function tryBorrow(name: string): boolean {
  const lockPath = join(codexTeammateDir(name), 'lock')
  try {
    const fd = openSync(lockPath, 'wx', 0o600)
    try {
      writeSync(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

function releaseBorrow(name: string): void {
  rmSync(join(codexTeammateDir(name), 'lock'), { force: true })
}

/**
 * `tm ask "<prompt>"` — borrow an idle named codex teammate from the
 * pool, drive one turn on an **ephemeral** thread (so the borrowed
 * teammate's persistent conversation thread is neither touched on disk
 * nor cloned server-side), return the teammate.
 *
 * The ephemeral thread is created with `thread/start { ephemeral: true }`
 * — the codex daemon treats it as a throwaway and does not bind it to
 * the teammate's primary conversation history. The teammate's persisted
 * `thread` file under `codexTeammateDir(name)` is never touched, so a
 * later `tm send <name>` continues the user's original conversation
 * exactly as before. This is intentionally narrower than a
 * shelve-and-restore dance on the persistent thread file, because that
 * dance would still allocate a fresh server-side thread per ask without
 * ever freeing it.
 *
 * "Idle" means "has no active borrow lock". Two parallel `tm ask`
 * invocations land on different teammates (or one gets "all busy" and
 * retries). `tm send` does not currently acquire the borrow lock; a
 * `tm send <name>` racing a `tm ask` against the same teammate is
 * guarded only by codex's per-thread sequencing — which on the ask
 * side acts on a different (ephemeral) thread, so there is no
 * server-side contention even if the timing overlaps.
 */
export async function codexAsk(prompt: string): Promise<TmResult> {
  if (prompt.length === 0) {
    return die('usage: tm ask "<prompt>"')
  }

  const candidates = listDaemons().filter(isCodexTarget)
  if (candidates.length === 0) {
    return die(
      "no codex teammates available — run 'tm spawn codex-1' (or similar) first",
    )
  }

  let borrowed: string | null = null
  let aliveCount = 0
  for (const name of candidates) {
    if (!daemonAlive(name)) continue
    aliveCount += 1
    if (tryBorrow(name)) {
      borrowed = name
      break
    }
  }
  if (borrowed === null) {
    if (aliveCount === 0) {
      return die(
        `all ${candidates.length} codex teammate(s) are dead — 'tm doctor' will reap them`,
      )
    }
    return die(
      `all ${aliveCount} alive codex teammate(s) are busy — retry, or spawn another`,
    )
  }

  // The borrow lock must be released even when `openInitialized` itself
  // throws (daemon crashed between the alive check and ws connect, ws
  // hello rejected, initialize RPC errored). A `try` *around* the
  // initialization is the contract decision 0022 §3 step 4 promises:
  // release unconditionally, including on error.
  let client: CodexWsClient | null = null
  try {
    client = await openInitialized(borrowed)
    const resp = await client.request<'thread/start', ThreadStartResponse>(
      'thread/start',
      {
        // Daemon-side throwaway thread: codex treats it as not part of
        // the teammate's persistent history, and frees it once the turn
        // completes. Without this the borrow leaks one server-side
        // thread per ask, accumulating over the daemon's lifetime.
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    )
    const params = await runTurn(client, resp.thread.id, prompt, true)
    touchLastSeen(borrowed)
    return {
      code: 0,
      stdout: JSON.stringify(params, null, 2) + '\n',
      stderr: '',
    }
  } catch (e) {
    return die(
      `codex ask on '${borrowed}' failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    if (client !== null) client.close()
    releaseBorrow(borrowed)
  }
}

// `TurnCompletedNotification` is referenced indirectly via
// `waitForNotification`'s union narrowing — explicit re-export keeps
// downstream code that wants the type without spelling the v2/ path.
export type { TurnCompletedNotification }
