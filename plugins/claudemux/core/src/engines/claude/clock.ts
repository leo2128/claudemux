/**
 * Wall-clock + timing utilities shared by the hot-path verbs. Pulled
 * out so a future `EngineContext.now()` plumb-through has a single
 * adapter point (Phase 2a-2 keeps the direct `Date.now()`).
 */

/** Resolve after `ms` milliseconds — `tm`'s `sleep` analog. */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Epoch seconds, sampled once — `tm`'s `$(date +%s)`. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Whether `value` is a valid non-negative integer string (the shape
 * `tm`'s `[[ "$timeout" =~ ^[0-9]+$ ]]` accepts). The native verbs guard
 * `--timeout` with this so a malformed value does not become a NaN loop.
 */
export function isNonNegativeInteger(value: string): boolean {
  return /^[0-9]+$/.test(value)
}
