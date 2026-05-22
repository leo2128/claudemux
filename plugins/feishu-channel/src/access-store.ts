/**
 * Persistence for the access-control state — read, normalize, and atomically
 * write access.json.
 *
 * A damaged file must never wedge the channel: an unparseable access.json is
 * moved aside and the channel restarts from defaults. Writes are atomic
 * (temp file + rename) and owner-only, since the file gates who may reach the
 * Claude session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Access, DmPolicy, GroupEntry, GroupPolicy, PendingEntry } from './types'

const DM_POLICIES: readonly DmPolicy[] = ['pairing', 'allowlist', 'disabled']

/** The three group-message policy values, also offered by the configure command. */
export const GROUP_POLICIES: readonly GroupPolicy[] = ['block', 'allowlist', 'follow-user']

/**
 * A fresh access state — pairing required for direct messages, the
 * decision-0010 per-group pairing for groups, nothing allowed yet.
 */
export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', groupPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }
}

export interface LoadResult {
  access: Access
  /** True when an unreadable access.json was moved aside and defaults used. */
  corrupt: boolean
}

/**
 * Read access.json. A missing file yields defaults. An unparseable file is
 * renamed aside (`<file>.corrupt-<ts>`) and defaults are returned with
 * `corrupt: true`. Any other I/O error (e.g. permission denied) is rethrown,
 * since silently starting fresh would hide a real misconfiguration.
 */
export function loadAccess(file: string): LoadResult {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { access: defaultAccess(), corrupt: false }
    }
    throw err
  }
  try {
    return { access: normalizeAccess(JSON.parse(raw)), corrupt: false }
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // If it cannot be moved aside, defaults still let the channel run.
    }
    return { access: defaultAccess(), corrupt: true }
  }
}

/**
 * Write access.json atomically: write a sibling temp file, then rename over
 * the target. Directory is created 0700 and the file 0600 — owner-only.
 */
export function saveAccess(file: string, access: Access): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Coerce arbitrary parsed JSON into a well-formed Access, filling defaults for
 * missing or wrong-typed fields. This is what lets a hand-edited or
 * partially-written access.json still load predictably.
 */
export function normalizeAccess(parsed: unknown): Access {
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const base = defaultAccess()
  return {
    dmPolicy: DM_POLICIES.includes(obj.dmPolicy as DmPolicy)
      ? (obj.dmPolicy as DmPolicy)
      : base.dmPolicy,
    groupPolicy: GROUP_POLICIES.includes(obj.groupPolicy as GroupPolicy)
      ? (obj.groupPolicy as GroupPolicy)
      : base.groupPolicy,
    allowFrom: toStringArray(obj.allowFrom),
    groups: normalizeGroups(obj.groups),
    pending: normalizePending(obj.pending),
  }
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function normalizeGroups(v: unknown): Record<string, GroupEntry> {
  const out: Record<string, GroupEntry> = {}
  if (v && typeof v === 'object') {
    for (const [chatId, raw] of Object.entries(v as Record<string, unknown>)) {
      const g = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      out[chatId] = {
        requireMention: typeof g.requireMention === 'boolean' ? g.requireMention : true,
        allowFrom: toStringArray(g.allowFrom),
      }
    }
  }
  return out
}

function normalizePending(v: unknown): Record<string, PendingEntry> {
  const out: Record<string, PendingEntry> = {}
  if (v && typeof v === 'object') {
    for (const [code, raw] of Object.entries(v as Record<string, unknown>)) {
      const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const senderId = typeof p.senderId === 'string' ? p.senderId : ''
      // A pending entry with no sender can never be matched — drop it.
      if (!senderId) continue
      out[code] = {
        // Anything that is not exactly 'group' — including a missing field in
        // an access.json written before group pairing existed — is a 'dm'.
        kind: p.kind === 'group' ? 'group' : 'dm',
        senderId,
        chatId: typeof p.chatId === 'string' ? p.chatId : '',
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
        expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0,
        replies: typeof p.replies === 'number' ? p.replies : 1,
      }
    }
  }
  return out
}
