---
"claude-channel-feishu": patch
---

Relocate the channel's manual live-verification tooling off the shipped `scripts/` surface: delete `verify-legacy-edit.ts` (its `editText` patch→update fallback is already fully covered by the mocked unit suite) and move `dogfood-markdown.ts` to `test/` beside `feishu-live.ts`, documented in the README as a manual card-render QA tool. No runtime behavior change.
