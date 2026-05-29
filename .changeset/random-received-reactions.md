---
"claude-channel-feishu": minor
---

The received-reaction indicator now picks a random emoji per inbound message from a "seen, on it" pool (👀 `GLANCE` 看, `LGTM` 了解, `Typing` 敲键盘, `GoGoGo` 冲, `OnIt` 在做了) instead of always reacting with 👀. Removal is unchanged — it keys off the reaction_id Feishu returns, so clearing works regardless of which emoji was placed.
