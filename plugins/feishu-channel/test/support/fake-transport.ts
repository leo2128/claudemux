/**
 * A fake `FeishuTransport` for unit tests. It records every outbound call and
 * can be told to fail a chosen method, so the channel's inbound and outbound
 * wiring is exercised without a live Feishu connection.
 */

import type {
  FeishuDocComment,
  FeishuDocMeta,
  FeishuSendResult,
  FeishuTransport,
} from '../../src/feishu'
import { renderMarkdownToCards } from '../../src/render'

export class FakeTransport implements FeishuTransport {
  readonly appId: string
  botOpenId: string | undefined
  readonly sent: { chatId: string; text: string }[] = []
  readonly reactions: { messageId: string; emoji: string }[] = []
  readonly reactionRemovals: { messageId: string; reactionId: string }[] = []
  readonly edits: { messageId: string; text: string }[] = []
  /** Records every `fetchDocComment` call. */
  readonly commentFetches: { fileToken: string; fileType: string; commentId: string }[] = []
  /** Records every `fetchDocMeta` call. */
  readonly metaFetches: { fileToken: string; fileType: string }[] = []
  /** When set, the named method throws — used to test outbound failure paths. */
  failOn: 'sendText' | 'addReaction' | 'removeReaction' | 'editText' | undefined
  /** Canned `fetchDocComment` result; `null` simulates a failed enrichment. */
  docComment: FeishuDocComment | null = null
  /** Canned `fetchDocMeta` result; `null` simulates a failed enrichment. */
  docMeta: FeishuDocMeta | null = null

  constructor(botOpenId?: string, appId: string = 'cli_test_app') {
    this.botOpenId = botOpenId
    this.appId = appId
  }

  async start(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<FeishuSendResult> {
    if (this.failOn === 'sendText') throw new Error('feishu send failed')
    this.sent.push({ chatId, text })
    // The real transport renders the markdown into one or more cards and
    // returns one message_id per card sent. Mirror that here so a test that
    // exercises the "split across messages" summary path sees the same
    // messageIds.length the real transport would produce.
    const cards = renderMarkdownToCards(text)
    const messageIds = cards.map((_, i) => `om_sent_${i}`)
    return { messageIds }
  }

  /**
   * Records the reaction and returns a reaction_id derived from the message_id,
   * so a test can predict the id a later `removeReaction` should carry without
   * threading the return value through the channel core.
   */
  async addReaction(messageId: string, emoji: string): Promise<string> {
    if (this.failOn === 'addReaction') throw new Error('feishu reaction failed')
    this.reactions.push({ messageId, emoji })
    return `rk_${messageId}`
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (this.failOn === 'removeReaction') throw new Error('feishu reaction removal failed')
    this.reactionRemovals.push({ messageId, reactionId })
  }

  async editText(messageId: string, text: string): Promise<void> {
    if (this.failOn === 'editText') throw new Error('feishu edit failed')
    this.edits.push({ messageId, text })
  }

  async fetchDocComment(
    fileToken: string,
    fileType: string,
    commentId: string,
  ): Promise<FeishuDocComment | null> {
    this.commentFetches.push({ fileToken, fileType, commentId })
    return this.docComment
  }

  async fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null> {
    this.metaFetches.push({ fileToken, fileType })
    return this.docMeta
  }

  async close(): Promise<void> {}
}
