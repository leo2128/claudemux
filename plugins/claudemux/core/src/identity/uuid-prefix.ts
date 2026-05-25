/**
 * Detect whether a user-supplied checkpoint argument looks like a partial
 * canonical UUID — i.e. a string that, if extended, would form a valid
 * `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` (8-4-4-4-12) id. Used by Claude
 * and Codex resume to attach an actionable hint to the "no transcript" /
 * "not a valid uuid" error instead of letting the caller chase the
 * misleading "wrong repo" line.
 *
 * "Looks like a canonical prefix" means: not empty, every position is
 * either lowercase hex or a `-` exactly where canonical UUIDs put one
 * (positions 8, 13, 18, 23), and the input is strictly shorter than the
 * 36-char canonical form. That matches the inputs `tm history`'s detail
 * mode actually accepts (it does `startsWith` against canonical dashed
 * ids), so the hint we emit — "Run 'tm history <repo> <input>'" — is
 * always actionable.
 *
 * Notably rejected: the no-dash 32-hex form (history's startsWith would
 * miss a dashed candidate), uppercase hex, dashes at non-canonical
 * positions, and the full 36-char UUID (which the strict regex would
 * have accepted upstream and never reached this helper).
 */
const DASH_POSITIONS: ReadonlySet<number> = new Set([8, 13, 18, 23])

function isLowerHexChar(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102)
}

export function looksLikeUuidPrefix(input: string): boolean {
  if (input.length === 0 || input.length >= 36) return false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (DASH_POSITIONS.has(i)) {
      if (ch !== '-') return false
    } else {
      if (!isLowerHexChar(ch)) return false
    }
  }
  return true
}
