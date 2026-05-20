/**
 * A fake `FeishuTransport` for unit tests. It records every outbound call and
 * can be told to fail a chosen method, so the channel's inbound and outbound
 * wiring is exercised without a live Feishu connection.
 */

import type { FeishuSendResult, FeishuTransport } from '../../src/feishu'

export class FakeTransport implements FeishuTransport {
  botOpenId: string | undefined
  readonly sent: { chatId: string; text: string }[] = []
  readonly reactions: { messageId: string; emoji: string }[] = []
  readonly edits: { messageId: string; text: string }[] = []
  /** When set, the named method throws — used to test outbound failure paths. */
  failOn: 'sendText' | 'addReaction' | 'editText' | undefined

  constructor(botOpenId?: string) {
    this.botOpenId = botOpenId
  }

  async start(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<FeishuSendResult> {
    if (this.failOn === 'sendText') throw new Error('feishu send failed')
    this.sent.push({ chatId, text })
    return { messageId: 'om_sent' }
  }

  async addReaction(messageId: string, emoji: string): Promise<void> {
    if (this.failOn === 'addReaction') throw new Error('feishu reaction failed')
    this.reactions.push({ messageId, emoji })
  }

  async editText(messageId: string, text: string): Promise<void> {
    if (this.failOn === 'editText') throw new Error('feishu edit failed')
    this.edits.push({ messageId, text })
  }

  async close(): Promise<void> {}
}
