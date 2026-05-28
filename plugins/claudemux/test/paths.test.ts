/**
 * The path builders mirror, byte-for-byte, the `/tmp` protocol shapes the
 * Bash hooks and `tm` write (`.agents/domains/cross-process-protocol.md`).
 * A drift here silently de-syncs the core from the hooks, so the exact
 * strings are pinned.
 */

import { describe, expect, test } from 'vitest'

import {
  busyMarkerFor,
  cwdFile,
  encodeProjectDir,
  idleDir,
  idleMarkerFor,
  lastFileFor,
  sidFile,
} from '../src/persistence/paths'
import {
  codexLastSeenFile,
  codexMetaFile,
  codexPidFile,
  codexRegistryRoot,
  codexSocketPath,
  codexStartedAtFile,
  codexTeammateDir,
  codexThreadFile,
} from '../src/engines/codex/persistence'

describe('idle-dir builders mirror the hook protocol', () => {
  test('the idle directory is /tmp/claude-idle', () => {
    expect(idleDir()).toBe('/tmp/claude-idle')
  })

  test('the bare <sid> marker is the idle signal', () => {
    expect(idleMarkerFor('SID')).toBe('/tmp/claude-idle/SID')
  })

  test('the .busy and .last markers carry their suffixes', () => {
    expect(busyMarkerFor('SID')).toBe('/tmp/claude-idle/SID.busy')
    expect(lastFileFor('SID')).toBe('/tmp/claude-idle/SID.last')
  })
})

describe('repo-keyed builders mirror the hook protocol', () => {
  test('the .sid and .cwd files are /tmp/teammate-<repo>.*', () => {
    expect(sidFile('acme')).toBe('/tmp/teammate-acme.sid')
    expect(cwdFile('acme')).toBe('/tmp/teammate-acme.cwd')
  })
})

describe('encodeProjectDir mirrors Claude Code project-dir naming', () => {
  test('every / becomes a -', () => {
    expect(encodeProjectDir('/Users/x/repo')).toBe('-Users-x-repo')
  })

  test('a . is replaced too — the bug a /-only encoder once shipped', () => {
    expect(encodeProjectDir('/Users/x/foo.bar/repo')).toBe('-Users-x-foo-bar-repo')
  })
})

describe.skip('codex-daemon registry paths', () => {
  test('the registry root is /tmp/teammate-codex', () => {
    expect(codexRegistryRoot()).toBe('/tmp/teammate-codex')
  })

  test('each teammate gets a directory under the registry root', () => {
    expect(codexTeammateDir('codex-1')).toBe('/tmp/teammate-codex/codex-1')
  })

  test('the daemon files live inside the teammate directory', () => {
    expect(codexSocketPath('codex-1')).toBe('/tmp/teammate-codex/codex-1/socket')
    expect(codexPidFile('codex-1')).toBe('/tmp/teammate-codex/codex-1/pid')
    expect(codexStartedAtFile('codex-1')).toBe('/tmp/teammate-codex/codex-1/started-at')
    expect(codexThreadFile('codex-1')).toBe('/tmp/teammate-codex/codex-1/thread')
    expect(codexLastSeenFile('codex-1')).toBe('/tmp/teammate-codex/codex-1/last-seen')
    expect(codexMetaFile('codex-1')).toBe('/tmp/teammate-codex/codex-1/meta.json')
  })

  test('teammate names with hyphens and digits round-trip into their own dir', () => {
    expect(codexTeammateDir('codex-reviewer-2')).toBe('/tmp/teammate-codex/codex-reviewer-2')
    expect(codexSocketPath('codex-reviewer-2')).toBe('/tmp/teammate-codex/codex-reviewer-2/socket')
  })

  test('nested teammate names keep their relative directory shape', () => {
    expect(codexTeammateDir('codex/foo')).toBe('/tmp/teammate-codex/codex/foo')
    expect(codexSocketPath('codex/foo')).toBe('/tmp/teammate-codex/codex/foo/socket')
  })
})
