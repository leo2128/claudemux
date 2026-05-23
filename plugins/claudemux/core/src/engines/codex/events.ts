/**
 * Codex turn notification collection.
 *
 * Codex sends a `turn/completed` envelope whose `turn.items` can be the empty
 * not-loaded husk; completed items arrive on the parallel `item/completed`
 * stream. This module is engine-private: callers above `CodexEngine` see only
 * a `TurnResult`, never the JSON-RPC notification stream.
 */

import type { CodexWsClient } from './rpc.js'
import type { ItemCompletedNotification } from '../../codex-protocol/v2/ItemCompletedNotification.js'
import type { ThreadItem } from '../../codex-protocol/v2/ThreadItem.js'
import type { TurnCompletedNotification } from '../../codex-protocol/v2/TurnCompletedNotification.js'
import type { TurnStartResponse } from '../../codex-protocol/v2/TurnStartResponse.js'

export interface TurnCollector {
  awaitTurn(): Promise<TurnCompletedNotification>
}

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

export async function runTurn(
  client: CodexWsClient,
  threadId: string,
  prompt: string,
  options: { wait: boolean; cwd: string | null },
): Promise<TurnCompletedNotification | null> {
  const collector = options.wait ? subscribeTurnCollection(client, threadId) : null

  await client.request<'turn/start', TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    ...(options.cwd === null ? {} : { cwd: options.cwd }),
  })

  if (collector === null) return null
  return collector.awaitTurn()
}

export type { TurnCompletedNotification }
