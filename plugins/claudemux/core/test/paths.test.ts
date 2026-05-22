/**
 * The path builders mirror, byte-for-byte, the `/tmp` protocol shapes the
 * Bash hooks and `tm` write (`.agents/domains/cross-process-protocol.md`).
 * A drift here silently de-syncs the core from the hooks, so the exact
 * strings are pinned.
 */

import { describe, expect, test } from 'vitest'

import {
  busyMarkerFor,
  coreSocketPath,
  cwdFile,
  encodeProjectDir,
  idleDir,
  idleMarkerFor,
  lastFileFor,
  registryFile,
  sidFile,
} from '../src/paths'

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

describe('core state paths', () => {
  test('the registry lives under ~/.claude so it survives a reboot', () => {
    expect(registryFile()).toMatch(/\/\.claude\/claudemux\/registry\.json$/)
  })

  test('the socket is an ephemeral /tmp rendezvous', () => {
    expect(coreSocketPath()).toBe('/tmp/claudemux-core.sock')
  })
})
