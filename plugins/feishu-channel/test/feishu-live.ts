/**
 * Live Feishu integration test.
 *
 * Unlike the rest of the suite, this file talks to the real Feishu Open
 * Platform. It is deliberately NOT named `*.test.ts`, so `npm test` with no
 * arguments does not discover it — a developer with no credentials, and a
 * fork pull request with no repository secrets, never run it. CI runs it
 * explicitly with `vitest run --config vitest.live.config.ts` and the app
 * credentials in the environment (`FEISHU_APP_ID` / `FEISHU_APP_SECRET`).
 *
 * It covers the two checkpoints a healthy channel depends on:
 *   1. the credentials mint a `tenant_access_token`, and
 *   2. a `WSClient` opens the long-lived WebSocket and reaches `ready`.
 *
 * It does NOT cover document-comment delivery: that needs extra app
 * permissions and a real person commenting on a document, neither of which a
 * CI run can arrange.
 *
 * Every step is bounded by a timeout so a hang fails the test fast rather
 * than wedging the job.
 */

import { expect, test } from 'vitest'
import * as lark from '@larksuiteoapi/node-sdk'

const appId = process.env.FEISHU_APP_ID
const appSecret = process.env.FEISHU_APP_SECRET
const haveCreds = Boolean(appId && appSecret)

if (!haveCreds) {
  console.error(
    '[feishu-live] FEISHU_APP_ID / FEISHU_APP_SECRET are not set — skipping the ' +
      'live Feishu integration test.',
  )
}

/** The tenant_access_token endpoint for a self-built app on open.feishu.cn. */
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'

/** Hard cap on each network step, so a hang fails the test instead of the job. */
const STEP_TIMEOUT_MS = 15_000

/** Shape of the tenant_access_token response fields this test inspects. */
interface TokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
}

test.skipIf(!haveCreds)(
  'credentials mint a tenant_access_token',
  async () => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    })
    expect(res.ok).toBe(true)

    const body = (await res.json()) as TokenResponse
    // Feishu answers 200 even for bad credentials; code === 0 is the real
    // success signal, and msg surfaces the reason when it is not.
    expect(body).toMatchObject({ code: 0 })
    expect(typeof body.tenant_access_token).toBe('string')
    expect((body.tenant_access_token ?? '').length).toBeGreaterThan(0)
  },
  STEP_TIMEOUT_MS + 5_000,
)

test.skipIf(!haveCreds)(
  'WSClient opens the long-lived connection',
  async () => {
    let resolveReady!: () => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const ws = new lark.WSClient({
      appId: appId as string,
      appSecret: appSecret as string,
      // One shot — no reconnect loop — so a failure surfaces immediately as
      // onError instead of retrying until the test's own timeout.
      autoReconnect: false,
      handshakeTimeoutMs: STEP_TIMEOUT_MS,
      onReady: () => resolveReady(),
      onError: (err: Error) => rejectReady(err),
    })

    let bailout: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, reject) => {
      bailout = setTimeout(
        () => reject(new Error('WSClient did not reach ready before the timeout')),
        STEP_TIMEOUT_MS + 5_000,
      )
    })

    try {
      void ws.start({ eventDispatcher: new lark.EventDispatcher({}) }).catch((err: unknown) => {
        rejectReady(err instanceof Error ? err : new Error(String(err)))
      })
      await Promise.race([ready, guard])
    } finally {
      if (bailout) clearTimeout(bailout)
      ws.close()
    }
  },
  STEP_TIMEOUT_MS + 15_000,
)
