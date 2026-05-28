---
"claudemux": patch
---

sync-plugin-version now mirrors the feishu-channel plugin manifest version as well, so `plugins/feishu-channel/.claude-plugin/plugin.json` stays in lockstep with its package.json after `changeset version` instead of drifting.
