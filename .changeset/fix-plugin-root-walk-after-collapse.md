---
"claudemux": patch
---

Fix the plugin-root path walk after the `core/` collapse moved the source tree up one level. `tmWrapperPath`/`pluginJsonPath` (`src/plugin-root.ts`) and `resolveTmBinary` (`src/tm.ts`) still walked up two directories from their module, resolving to `plugins/bin/tm` and `plugins/.claude-plugin/plugin.json` instead of the real files under `plugins/claudemux/`. Each now walks up one level. A new `test/paths.test.ts` block pins all three helpers to files that must exist on disk under a `claudemux` plugin root, so a future tree-depth change fails in CI instead of at teammate spawn or plugin.json read.
