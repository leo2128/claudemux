/**
 * The event registry — the channel's extensibility seam.
 *
 * A Feishu channel reacts to more than one kind of Feishu event. Rather than
 * branch the server on each event_type, every event type is implemented as a
 * self-contained `EventHandler`: it declares the event_type it subscribes to
 * and turns one raw event payload into a `ChannelDelivery` (or `null` to drop
 * it). An `EventRegistry` holds the handlers; the server resolves one per
 * inbound event by its event_type.
 *
 * Adding a new Feishu event to the channel is therefore: write one handler
 * module, register it once. The server pipeline and the transport do not
 * change.
 */

import type { FeishuTransport } from './feishu'

/** A channel notification ready to push into the Claude Code session. */
export interface ChannelDelivery {
  /** Human-readable text rendered inside the `<channel>` block. */
  content: string
  /**
   * `<channel>` tag attributes. Keys must be `[A-Za-z0-9_]` only — Claude
   * Code silently drops a key that contains a hyphen.
   */
  meta: Record<string, string>
}

/**
 * Shared services a handler may use while processing an event. The server
 * builds one context and passes it to every handler, so a handler never
 * constructs a transport, reads the clock, or resolves a file path itself.
 */
export interface HandlerContext {
  /** The Feishu platform boundary — outbound calls and the bot's open_id. */
  transport: FeishuTransport
  /** Absolute path to access.json, the persisted access-control policy. */
  accessFile: string
  /** Injected clock (epoch millis). */
  now: () => number
  /** Injected pairing-code generator. */
  generateCode: () => string
  /** Reports a recoverable error. */
  logError: (message: string, err?: unknown) => void
  /** Reports a low-severity diagnostic, e.g. why a message was dropped. */
  logDebug: (message: string) => void
}

/**
 * One Feishu event type, handled end to end.
 *
 * `eventType` is the Feishu event_type string the handler subscribes to
 * (e.g. `im.message.receive_v1`). `handle` receives the raw event payload
 * exactly as the Feishu SDK delivered it and returns the notification to
 * deliver, or `null` to drop the event silently. A handler must not throw on
 * malformed input — it returns `null` instead.
 */
export interface EventHandler {
  readonly eventType: string
  handle(raw: unknown, ctx: HandlerContext): Promise<ChannelDelivery | null>
}

/**
 * A collection of `EventHandler`s keyed by their `eventType`. The server
 * registers every handler once at startup, then resolves a handler per
 * inbound event. Registering two handlers for one event_type is a wiring
 * bug and throws.
 */
export class EventRegistry {
  private readonly handlers = new Map<string, EventHandler>()

  /** Add a handler. Throws when its event_type is already registered. */
  register(handler: EventHandler): this {
    if (this.handlers.has(handler.eventType)) {
      throw new Error(`duplicate handler for event type: ${handler.eventType}`)
    }
    this.handlers.set(handler.eventType, handler)
    return this
  }

  /** The handler for `eventType`, or `undefined` when none is registered. */
  get(eventType: string): EventHandler | undefined {
    return this.handlers.get(eventType)
  }

  /** True when a handler is registered for `eventType`. */
  has(eventType: string): boolean {
    return this.handlers.has(eventType)
  }

  /** Every registered event_type, in registration order. */
  eventTypes(): string[] {
    return [...this.handlers.keys()]
  }
}
