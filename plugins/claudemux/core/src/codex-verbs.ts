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
 * `tm send codex-<n> "<prompt>"` — drive one turn on the codex teammate's
 * thread. Starts a thread on first send, reuses it after.
 *
 * Returns the raw `Turn` JSON on stdout for stage 4 — the assistant
 * message lives inside `turn.items` as `{ type: 'agentMessage', text }`,
 * but extracting it cleanly needs a real codex to validate against, so
 * the parser lands with the integration suite. A consumer of the JSON
 * can already pluck `.items[].text` themselves.
 */
export async function codexSend(name: string, prompt: string): Promise<TmResult> {
  if (!daemonAlive(name)) {
    return die(
      `codex teammate '${name}' is not alive — try 'tm spawn ${name}' first`,
    )
  }
  if (prompt.length === 0) {
    return die('usage: tm send <teammate> "<prompt>"')
  }

  const client = await openInitialized(name)
  try {
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

    // Listen for the completion notification *before* sending the request
    // so we cannot miss a fast-firing notification between turn/start
    // returning and the listener being installed.
    const completed = waitForNotification(client, 'turn/completed')

    await client.request<'turn/start', TurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    })

    const notif = await completed
    touchLastSeen(name)

    return {
      code: 0,
      stdout: JSON.stringify(notif.params, null, 2) + '\n',
      stderr: '',
    }
  } finally {
    client.close()
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

  const client = await openInitialized(name)
  try {
    const completed = await waitForNotification(client, 'turn/completed')
    touchLastSeen(name)
    return {
      code: 0,
      stdout: JSON.stringify(completed.params, null, 2) + '\n',
      stderr: '',
    }
  } finally {
    client.close()
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
 * pool, drive one turn on a *fresh* thread, return the borrowed teammate.
 *
 * Stage 4's ask mode is intentionally minimal: it picks any idle
 * `codex-<n>` teammate (the user does not name one), runs the turn
 * outside the teammate's persistent conversation thread (the thread
 * file is shelved across the call), and prints the raw `Turn` JSON for
 * the same reason `codexSend` does — assistant-message extraction
 * lands with the live integration suite.
 *
 * "Idle" here means "has no active borrow lock". Two parallel `tm ask`
 * invocations land on different teammates (or one of them gets the
 * "all busy" error and retries); a `tm ask` running while the user
 * also runs `tm send` against the same teammate is not guarded — codex
 * itself sequences turns on a thread and will reject overlap, but
 * `tm send` does not currently acquire the borrow lock.
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

  // Shelve the persistent thread id (if any) so this turn runs on a
  // fresh thread without polluting the borrowed teammate's primary
  // conversation. Whatever happens during the turn, the persisted
  // thread is restored in the `finally`.
  let shelvedThread: string | null = null
  try {
    shelvedThread = readFileSync(codexThreadFile(borrowed), 'utf8').trim() || null
  } catch {
    shelvedThread = null
  }
  if (shelvedThread !== null) {
    rmSync(codexThreadFile(borrowed), { force: true })
  }

  try {
    return await codexSend(borrowed, prompt)
  } finally {
    // Replace whatever thread `codexSend` wrote with the one we shelved,
    // so future `tm send <name>` continues the user's original
    // conversation.
    if (shelvedThread !== null) {
      writeThreadId(borrowed, shelvedThread)
    } else {
      rmSync(codexThreadFile(borrowed), { force: true })
    }
    releaseBorrow(borrowed)
  }
}

// `TurnCompletedNotification` is referenced indirectly via
// `waitForNotification`'s union narrowing — explicit re-export keeps
// downstream code that wants the type without spelling the v2/ path.
export type { TurnCompletedNotification }
