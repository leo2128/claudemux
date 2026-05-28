/**
 * Claude-engine identifier helpers — the random sid + suffix + slug
 * minting `tm spawn` and `tm resume` reach for. Centralised so a future
 * change to the alphabet, length, or slug allowlist is a one-site edit.
 */

import { randomBytes, randomUUID } from 'node:crypto'

/** `tm`'s `new_sid`: a lowercase UUID. Claude Code normalizes sids to lower. */
export function newSid(): string {
  return randomUUID().toLowerCase()
}

/** `tm`'s `rand_suffix`: 4 chars drawn from `[a-z0-9]`. */
export function randSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(4)
  let out = ''
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

/** A UUID — the format `tm resume` requires for a resolved sid. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
