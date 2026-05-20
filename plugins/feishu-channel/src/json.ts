/**
 * Tiny structural helpers for reading untyped JSON — the shape every raw
 * Feishu event payload arrives in. Shared by the event handlers, which each
 * decode their own event_type's payload defensively.
 */

/** True when `v` is a non-null object, and therefore safe to index. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** `v` when it is a string, otherwise the empty string. */
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
