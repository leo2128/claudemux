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

/** The current date as `YYYY-MM-DD` in local time — `tm`'s `date +%Y-%m-%d`. */
export function fmtLocalDate(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Format an epoch-seconds value as `YYYY-MM-DD HH:MM:SS` in local time
 * — the `tm` `history_detail` `last_seen` field. `tm` does this with
 * BSD `date -r`, so this rendering matches `tm` on macOS; `date -r
 * <epoch>` is not portable to GNU, which is why `history`'s detail-
 * mode conformance is macOS-gated.
 */
export function fmtLocalDateTime(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** Format a second-count as a short relative age — `tm`'s `fmt_age`. */
export function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}
