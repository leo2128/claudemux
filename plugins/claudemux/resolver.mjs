// ESM resolve hook used by the `tm` launcher to let Node's
// `--experimental-strip-types` run the TypeScript sources as-is, without
// pre-rewriting every import.
//
// Node's native type stripping insists on explicit `.ts` extensions in
// import specifiers; the codex-protocol bindings under `src/codex-protocol/`
// are emitted by `codex app-server generate-ts` with extension-less imports
// (the rest of the source mostly uses NodeNext-style `.js` specifiers that
// also need rewriting). Sweeping the tree would be a permanent maintenance
// tax — every codex CLI bump regenerates extension-less imports and the
// "codex-protocol not stale" CI gate would push them back in.
//
// This hook fills the gap. Three rules, applied only to relative specifiers
// whose default resolution fails:
//   1. `./foo`    -> try `./foo.ts`, then `./foo/index.ts`
//   2. `./foo.js` -> try the sibling `./foo.ts`
//   3. everything else -> defer to the next resolver
//
// Bare-name imports such as `ws` are handled by the `imports` map in
// `package.json` (`#ws`), not by this hook — vitest does not run this hook,
// and the import map is the one mechanism both Node and vitest honor.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TS_EXTS = ['.ts', '.mts', '.cts']

function tryResolveAsFile(urlString) {
  try {
    const path = fileURLToPath(urlString)
    if (existsSync(path)) return urlString
  } catch {
    // not a file: URL — leave it to the default resolver
  }
  return null
}

function tryWithTsExtension(specifier, parentURL) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  if (!parentURL) return null

  const base = new URL(specifier, parentURL)
  const baseHref = base.href

  // .js -> sibling .ts (NodeNext convention used by hand-written sources)
  if (baseHref.endsWith('.js')) {
    const tsHref = baseHref.slice(0, -'.js'.length) + '.ts'
    const hit = tryResolveAsFile(tsHref)
    if (hit) return hit
  }

  // extension-less -> try each TS extension, then /index.ts
  // (codex-protocol generator emits extension-less imports)
  const hasExt = /\.[A-Za-z0-9]+$/.test(baseHref)
  if (!hasExt) {
    for (const ext of TS_EXTS) {
      const hit = tryResolveAsFile(baseHref + ext)
      if (hit) return hit
    }
    for (const ext of TS_EXTS) {
      const hit = tryResolveAsFile(baseHref + '/index' + ext)
      if (hit) return hit
    }
  }

  return null
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err && err.code !== 'ERR_MODULE_NOT_FOUND' && err.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') {
      throw err
    }
    const rewritten = tryWithTsExtension(specifier, context.parentURL)
    if (rewritten) {
      // Hand the rewritten URL back through the resolver chain so Node's
      // TypeScript pipeline picks the format from the `.ts` extension —
      // hard-coding a format breaks across the strip-types / transform-types
      // toggle.
      return await nextResolve(rewritten, context)
    }
    throw err
  }
}
