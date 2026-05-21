/**
 * Shared types for the Feishu channel.
 *
 * The access-control state defined here is what gets persisted to access.json
 * and what the pure `gate` function reasons over.
 */

/** Access-control policy for direct (1:1) messages. */
export type DmPolicy = 'pairing' | 'allowlist' | 'disabled'

/** Per-group access policy, keyed in Access.groups by the group's chat_id. */
export interface GroupPolicy {
  /** Require the bot to be @-mentioned before a group message is delivered. */
  requireMention: boolean
  /** When non-empty, only these sender open_ids may trigger the bot here. */
  allowFrom: string[]
}

/**
 * A pending pairing request, keyed in Access.pending by its pairing code.
 *
 * `kind` says what approving the code authorizes: a `dm` request adds
 * `senderId` to the top-level `allowFrom`; a `group` request adds `chatId` to
 * `groups`. The two kinds share this one map and the one approval gesture.
 */
export interface PendingEntry {
  /** What approving this code authorizes — a direct sender, or a group. */
  kind: 'dm' | 'group'
  /**
   * open_id of the awaiting party: the sender for a `dm` request, or the
   * group member whose @-mention triggered a `group` request.
   */
  senderId: string
  /**
   * chat_id the request arrived in — the direct chat for a `dm` request, or
   * the group itself for a `group` request (the id approval adds to `groups`).
   */
  chatId: string
  /** Epoch millis the request was created. */
  createdAt: number
  /** Epoch millis the request expires. */
  expiresAt: number
  /** How many pairing-code replies were sent. A `group` request sends once. */
  replies: number
}

/** The full access-control state — persisted verbatim as access.json. */
export interface Access {
  dmPolicy: DmPolicy
  /** Sender open_ids allowed to DM the bot directly. */
  allowFrom: string[]
  /** Per-group policy, keyed by chat_id. */
  groups: Record<string, GroupPolicy>
  /** Pending pairing requests, keyed by pairing code. */
  pending: Record<string, PendingEntry>
}

/** One @-mention inside an inbound Feishu message. */
export interface Mention {
  /** The placeholder token (e.g. `@_user_1`) used in the message text. */
  key: string
  /** Resolved identity of the mentioned party. */
  id?: { open_id?: string; union_id?: string; user_id?: string }
  /** Display name of the mentioned party. */
  name?: string
}
