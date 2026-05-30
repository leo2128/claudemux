---
"claude-channel-feishu": patch
---

Consume the shared `@excitedjs/feishu-transport` core for the engine-agnostic Feishu platform I/O (content→text parse, markdown→card render, pairing-code generation, json helpers, and the access-policy types) instead of in-tree duplicates. Deletes ~1076 LoC of logic that was duplicated between this plugin and the dreamux host (and was in fact the source it was ported from). No behavior change — `tsc` clean and the full vitest suite stays green. scope-0 of the claudemux↔dreamux Feishu-channel convergence (claudemux#10 / dreamux#6).
