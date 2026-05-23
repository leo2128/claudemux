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
} from './codex-protocol/index.js'
import type { ItemCompletedNotification } from './codex-protocol/v2/ItemCompletedNotification.js'
import type { ThreadItem } from './codex-protocol/v2/ThreadItem.js'
import type { ThreadResumeResponse } from './codex-protocol/v2/ThreadResumeResponse.js'
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
 * One turn's `turn/completed` envelope with its `item/completed` stream
 * merged in. The collector returned by {@link subscribeTurnCollection}
 * resolves a `Promise<TurnCompletedNotification>` of this shape.
 */
export interface TurnCollector {
  /** Resolve when the next `turn/completed` for the bound thread arrives. */
  awaitTurn(): Promise<TurnCompletedNotification>
}

/**
 * Collect one turn's worth of notifications and resolve when it completes.
 *
 * The codex daemon emits every `turn/completed` with `turn.items: []` and
 * `turn.itemsView: "notLoaded"` (see
 * `codex-rs/app-server/src/bespoke_event_handling.rs:1297`) — the real items
 * arrive on a separate `item/completed` stream during the turn. A client
 * that waits on `turn/completed` alone gets the empty husk that decision
 * 0022's stage 4 verbs were observed to return.
 *
 * This collector subscribes to both streams, filters by `threadId`, and
 * buckets `item/completed` notifications by their `turnId`. When
 * `turn/completed` arrives it merges the matching bucket into `turn.items`.
 * `itemsView` is set to `"full"` only when the bucket has at least one
 * item: the client cannot prove "full" if it never observed anything for
 * the turn, and an empty bucket on a completed turn means events fired
 * before this connection was subscribed (the `codexWait` window — see the
 * note below). Mid-turn subscription that catches *some* events still
 * stamps `"full"`, which is technically optimistic but the dispatcher
 * has no signal that distinguishes "saw every event" from "saw most" at
 * the protocol level; the lying-with-zero case is the only one that
 * actually shows up in practice.
 *
 * **Subscribe before sending `turn/start`.** A turn that completes in one
 * round-trip (cached prompt, fast model) can deliver `turn/completed`
 * between `await client.request('turn/start', …)` returning and a
 * post-request listener being installed. Every caller in this file does
 * the subscribe + send dance in that order; do not reorder.
 *
 * **Ordering invariant.** ItemCompleted and TurnCompleted go through the
 * same per-thread mpsc channel in the daemon. The TurnCompleted emit is
 * `.await`ed in `handle_turn_complete` (`bespoke_event_handling.rs:1488`),
 * and `handle_turn_complete` runs after every spawned item-callback path
 * has resolved its own ItemCompleted emit — `complete_command_execution_item`
 * at line 1399, the approval callback paths starting around line 535/649/
 * 699/756/797/837 — because the daemon does not transition to
 * "turn-complete" until those resolve. Concretely: every ItemCompleted
 * for a turn lands on the wire before that turn's TurnCompleted. The
 * collector relies on this — no post-turn debounce, no late-item
 * buffering. If a future codex version emits TurnCompleted before some
 * approval callback finishes, late ItemCompleteds will land in
 * `itemsByTurn` after the collector has already resolved; the merged
 * Turn is then truthful about what reached the wire by completion time,
 * but incomplete. Re-validate this paragraph when bumping the pinned
 * codex version.
 *
 * **Item-type coverage.** Not every `ThreadItem` variant emits a started+
 * completed pair — reasoning summary text streams as deltas only. Every
 * variant the dispatcher actually reads (`agentMessage`, `commandExecution`,
 * `mcpToolCall`, `fileChange`) emits `item/completed`, so the merged
 * `turn.items` reproduces the visible turn. Delta-only variants are
 * outside this collector's surface — a future streaming consumer can
 * subscribe to `item/agentMessage/delta` etc. directly.
 *
 * **Single-use, per-call client.** The collector assumes a fresh
 * `CodexWsClient` per `tm` invocation — every codex verb in this file
 * builds one in `openInitialized` and closes it in its `finally`. The
 * notification handler stays installed for the lifetime of the client
 * (`onNotification` has no remove counterpart), and `itemsByTurn` is
 * never trimmed; both are unrooted at client close. A future caller
 * that shares a client across turns must build a new collector per
 * turn and accept that the prior collector's handler keeps dispatching
 * — `done` short-circuits it cheaply, but the closure stays linked.
 *
 * `awaitTurn()` caches its Promise: a second call returns the same
 * Promise (or the resolved value), so repeat-await on the same
 * collector is idempotent rather than silently overwriting the
 * resolver.
 */
export function subscribeTurnCollection(
  client: CodexWsClient,
  threadId: string,
): TurnCollector {
  const itemsByTurn = new Map<string, ThreadItem[]>()
  let cached: TurnCompletedNotification | null = null
  let awaiting: Promise<TurnCompletedNotification> | null = null
  let resolveTurn: ((turn: TurnCompletedNotification) => void) | null = null
  let done = false

  const onResolve = (params: TurnCompletedNotification): void => {
    const items = itemsByTurn.get(params.turn.id) ?? []
    // `'full'` claims the client has every item the daemon emitted; an
    // empty bucket on a completed turn means events fired before this
    // connection was a subscriber, so the honest label is `"notLoaded"`
    // — same value the daemon shipped in the original envelope.
    const itemsView = items.length > 0 ? 'full' : 'notLoaded'
    const merged: TurnCompletedNotification = {
      ...params,
      turn: { ...params.turn, items, itemsView },
    }
    cached = merged
    if (resolveTurn !== null) {
      resolveTurn(merged)
      resolveTurn = null
    }
  }

  client.onNotification((notif) => {
    if (done) return
    if (notif.method === 'item/completed') {
      const params = notif.params as ItemCompletedNotification
      if (params.threadId !== threadId) return
      const bucket = itemsByTurn.get(params.turnId) ?? []
      bucket.push(params.item)
      itemsByTurn.set(params.turnId, bucket)
    } else if (notif.method === 'turn/completed') {
      const params = notif.params as TurnCompletedNotification
      if (params.threadId !== threadId) return
      done = true
      onResolve(params)
    }
  })

  return {
    awaitTurn(): Promise<TurnCompletedNotification> {
      if (cached !== null) return Promise.resolve(cached)
      if (awaiting !== null) return awaiting
      awaiting = new Promise<TurnCompletedNotification>((res) => {
        resolveTurn = res
      })
      return awaiting
    },
  }
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
  // Subscribe before sending `turn/start` — see {@link subscribeTurnCollection}
  // for why the order matters. The collector accumulates `item/completed`
  // notifications and merges them into the `turn/completed` envelope, so the
  // caller's `Turn.items` is the full turn rather than the daemon's empty
  // husk.
  const collector = wait ? subscribeTurnCollection(client, threadId) : null

  await client.request<'turn/start', TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
  })

  if (collector === null) return null
  return collector.awaitTurn()
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
      // First send for this teammate: create a new thread, persist its id.
      const resp = await client.request<'thread/start', ThreadStartResponse>(
        'thread/start',
        {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      )
      threadId = resp.thread.id
      writeThreadId(name, threadId)
    } else {
      // Subsequent send: the existing thread is owned by a *prior*
      // WebSocket connection that has since disconnected. The codex
      // daemon does not let `turn/start` address a thread the current
      // connection has not joined — it just silently never replies,
      // observed empirically as `tm send` hanging until killed. A
      // `thread/resume { threadId }` rejoins the running thread on
      // this connection (see vendored ThreadResumeParams docstring).
      await client.request<'thread/resume', ThreadResumeResponse>(
        'thread/resume',
        {
          threadId,
          // `persistExtendedHistory` is the one required ThreadResumeParams
          // field beyond `threadId`; it does not have `experimentalRawEvents`
          // the way ThreadStartParams does.
          persistExtendedHistory: false,
        },
      )
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
 * `tm wait codex-<n>` — block until the teammate's next `turn/completed`.
 *
 * **Known limitation: the prior `--no-wait` turn may already be gone.**
 * The intended composition is `tm send codex-<n> --no-wait` → `tm wait
 * codex-<n>`. The codex daemon's `ThreadScopedOutgoingMessageSender`
 * only forwards a thread's events to the `connection_ids` *currently*
 * subscribed; it does not replay events to a connection that joins
 * later. When `tm send --no-wait` closes its WebSocket immediately
 * after `turn/start`, the daemon drops that connection from the set —
 * and if the turn's `item/completed`/`turn/completed` fire before this
 * `tm wait` has finished its `thread/resume`, those events were sent
 * to a disconnected peer and the dispatcher cannot recover them. This
 * verb then blocks until the *next* turn completes (or its caller
 * cancels).
 *
 * In practice the `send --no-wait` → `wait` window is short enough that
 * a long turn arrives back fine, but a fast turn (cached prompt) is
 * irrecoverable. A future fix needs a daemon-side replay buffer, a
 * connection that stays open across the verbs, or a separate
 * pull-history RPC; none of these is in scope here.
 */
export async function codexWait(name: string): Promise<TmResult> {
  if (!daemonAlive(name)) {
    return die(`codex teammate '${name}' is not alive`)
  }

  // `tm wait codex-<n>` only makes sense after a `tm send --no-wait` (or an
  // equivalent driver) has put a turn in flight against a started thread.
  // Without a recorded thread id there is nothing to subscribe to — refuse
  // with a hint rather than open a connection that will never resolve.
  const threadId = readThreadId(name)
  if (threadId === null) {
    return die(
      `codex teammate '${name}' has no started thread yet — run 'tm send ${name} --prompt "…"' first`,
    )
  }

  let client: CodexWsClient | null = null
  try {
    client = await openInitialized(name)
    // `thread/resume` re-joins this fresh connection to the running thread on
    // the daemon side. Without it, the daemon's `ThreadScopedOutgoingMessageSender`
    // does not include this connection in its `connection_ids` target set
    // (`codex-rs/app-server/src/outgoing_message.rs:142-149`), and no
    // `turn/completed` or `item/completed` notification reaches the client —
    // the wait would hang on a connection the daemon treats as a stranger.
    await client.request<'thread/resume', ThreadResumeResponse>(
      'thread/resume',
      { threadId, persistExtendedHistory: false },
    )
    const collector = subscribeTurnCollection(client, threadId)
    const completed = await collector.awaitTurn()
    touchLastSeen(name)
    return {
      code: 0,
      stdout: JSON.stringify(completed, null, 2) + '\n',
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

// `TurnCompletedNotification` is the public Turn shape every codex verb
// returns through `runTurn` / `subscribeTurnCollection`. Re-exported so
// downstream code can reference it without spelling the `v2/` path.
export type { TurnCompletedNotification }
