---
"claude-channel-feishu": patch
---

remove `<available_bots>` injection from group message deliveries

The peer-bot open_ids are already surfaced in the `sender_id` attribute of
every `<channel>` event; the separate XML block was redundant. Removing it
simplifies the delivery path and shrinks every group message that Claude sees.
