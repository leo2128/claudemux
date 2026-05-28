---
"claude-channel-feishu": minor
---

feat: bot↔bot /introduce handshake + available_bots injection

When a user sends `@BotA @BotB /introduce` in a group, the channel detects
the command, persists each bot's open_id (from this app's perspective) to
`observed-bots-{appId}-{chatId}.json`, and sends a best-effort ack. Side
effects only fire when the access gate would deliver (authorized sender/group).

On every subsequent group delivery, an `<available_bots>` XML block is
appended listing known peer bots (self filtered), giving Claude the open_ids
needed to use `<at id="..."></at>` to @-mention peer bots in replies.

Supporting: `FeishuTransport.appId` (new), `HandlerContext.baseDir` (new,
injectable for tests), `observedBotsFile` path builder.
