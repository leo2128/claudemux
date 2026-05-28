import type { ThreadStartResponse } from '../../codex-protocol/v2/ThreadStartResponse.js'
import type { TmResult } from '../../tm'
import { openInitializedCodexClient } from './engine.js'
import { runTurn } from './events.js'
import {
  daemonAlive,
  listDaemons,
  releaseDaemonBorrow,
  touchLastSeen,
  tryBorrowDaemon,
} from './supervisor.js'
import { die } from './verb-common.js'

/**
 * `tm ask "<prompt>"` — borrow one live codex teammate from the pool, run an
 * ephemeral thread, and release the teammate.
 */
export async function codexAsk(prompt: string): Promise<TmResult> {
  if (prompt.length === 0) return die('usage: tm ask "<prompt>"')

  const candidates = listDaemons()
  if (candidates.length === 0) {
    return die("no codex teammates available — run 'tm spawn <name> --engine codex' first")
  }

  let borrowed: string | null = null
  let aliveCount = 0
  for (const name of candidates) {
    if (!daemonAlive(name)) continue
    aliveCount += 1
    if (tryBorrowDaemon(name)) {
      borrowed = name
      break
    }
  }

  if (borrowed === null) {
    if (aliveCount === 0) {
      return die(`all ${candidates.length} codex teammate(s) are dead — 'tm doctor' will reap them`)
    }
    return die(`all ${aliveCount} alive codex teammate(s) are busy — retry, or spawn another`)
  }

  const borrowedName = borrowed
  let client: Awaited<ReturnType<typeof openInitializedCodexClient>> | null = null
  try {
    client = await openInitializedCodexClient(borrowedName)
    const resp = await client.request<'thread/start', ThreadStartResponse>('thread/start', {
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    const outcome = await runTurn(client, resp.thread.id, prompt, { wait: true, cwd: null })
    if (outcome === null) return die(`codex ask on '${borrowedName}' did not return a turn`)
    touchLastSeen(borrowedName)
    return {
      code: 0,
      stdout: JSON.stringify(outcome.completed, null, 2) + '\n',
      stderr: '',
    }
  } catch (e) {
    return die(
      `codex ask on '${borrowedName}' failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    if (client !== null) client.close()
    releaseDaemonBorrow(borrowedName)
  }
}
