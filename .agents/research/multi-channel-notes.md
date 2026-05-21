# 单个 Claude Code session 能不能同时开多个 channel

> 只读调研。日期 2026-05-21。来源:官方文档 channels / channels-reference。
> 引用均为官方原文(≤15 词)。

---

## 直接结论

**能。** 一个 session 可以同时挂多个 channel —— `--channels` 支持空格分隔传多个插件,每个 channel 是独立子进程,靠 `<channel source="...">` 区分来源;**但所有 channel 的事件汇进同一条 session 队列、按顺序串行处理,session 内没有并发**,要真并发只能开多个 session。

---

## 确认点(逐条 + 官方原文)

### 1. `--channels` 能一次传多个 plugin —— 能

> "You can pass several plugins to `--channels`, space-separated."
> — https://code.claude.com/docs/en/channels (Quickstart)

语法:`claude --channels plugin:telegram@claude-plugins-official plugin:discord@claude-plugins-official`。文档未给 channel 数量上限。

### 2. 进站事件靠什么区分来源 —— `source` 来自 MCP server 的配置名

> "The `source` attribute is set automatically from your server's configured name"
> — https://code.claude.com/docs/en/channels-reference (Notification format)

`source` = `new Server({ name: 'feishu', ... })` 里的 `name`。多 channel 同挂时,事件分别是 `<channel source="feishu" ...>` / `<channel source="telegram" ...>`。`meta` 里的键再变成标签上的额外属性:

> "Each entry becomes an attribute on the `<channel>` tag for routing context"
> — https://code.claude.com/docs/en/channels-reference (Notification format)

每个 channel 还是各自独立的子进程:

> "Claude Code ... spawns each server as a subprocess."
> — https://code.claude.com/docs/en/channels-reference (Register your server)

### 3. 出站回复怎么路由回正确的 channel —— 各 channel 各自的 reply 工具

每个 channel 是独立 MCP server,各自注册自己的回复工具:

> "expose a standard MCP tool that Claude can call to send messages back"
> — https://code.claude.com/docs/en/channels-reference (Expose a reply tool)

`instructions` 字段告诉 Claude 用哪个工具、回传哪个属性:

> "which tool to use and which attribute to pass back (like `chat_id`)"
> — https://code.claude.com/docs/en/channels-reference (Server options)

机制:进站事件的 `source` 告诉 Claude 这条消息来自哪个 channel,Claude 就调那个 channel 的回复工具,并把该事件 `<channel>` 标签里的 `chat_id` 等回传。不同 server 的同名工具(都叫 `reply`)由 MCP 按 server 命名空间隔开,不冲突。
*(注:文档没有一句专门讲「多 channel 出站路由」;以上是「独立 server + 各自 reply 工具 + source 标识」三条事实的合成推断。)*

### 4. 多 channel 是真并发,还是汇进同一队列串行 —— **串行**

这是最关键的一点,官方原文明确:

> "Events queue into the session and are processed in order."
> — https://code.claude.com/docs/en/channels-reference (Notification format)

> "they're delivered together on the next turn and Claude handles them as a group"
> — https://code.claude.com/docs/en/channels-reference (Notification format)

> "To process independent event streams concurrently, run separate sessions."
> — https://code.claude.com/docs/en/channels-reference (Notification format)

即:多个 channel 的**服务进程**是并行独立的,但它们推进来的**事件全部汇入同一个 session 的单一队列**,按到达顺序串行处理;Claude 忙时到达的多条会攒到下一轮一起当作一组处理。**session 内不存在「feishu 和 telegram 并行各跑一个 Claude 回合」**。要并发只能开多个 session。

### 5. research preview 的 allowlist 对「多 channel」的额外影响 —— 限制的是「哪些」不是「几个」

> "`--channels` only accepts plugins from an Anthropic-maintained allowlist"
> — https://code.claude.com/docs/en/channels (Research preview)

allowlist 约束的是**每个**插件能不能注册,不限制同时挂几个。所以多 channel 时:**列表里每一个 plugin 都得各自在 allowlist 上**(或在组织的 `allowedChannelPlugins` 里)。自建 channel 不在官方 allowlist,要靠 `--dangerously-load-development-channels` 单独放行,且该放行是按条目算的:

> "The bypass is per-entry."
> — https://code.claude.com/docs/en/channels-reference (Test during the research preview)

混用时,官方 channel 走 `--channels`,自建 channel 走 `--dangerously-load-development-channels`,两个 flag 可同时出现,各自列各自的条目。组织级总开关 `channelsEnabled` 对所有 channel 一并生效。

---

## 对我们做飞书 channel 的实际影响

1. **可以和官方 channel 共存。** 用户能在同一 session 同时挂飞书 + telegram/discord,无冲突。飞书插件不用为「独占 session」做任何假设。

2. **server name 必须唯一且稳定。** `<channel source="feishu">` 直接取自 `Server` 构造里的 `name`。飞书插件固定用 `name: 'feishu'`,别和别的 channel 撞名,否则进站事件无法区分来源。

3. **出站工具命名不用特殊处理。** 飞书的 `reply`/`react`/`edit_message` 即使和其他 channel 同名,也被 MCP 按 server 命名空间隔开。但 `instructions` 要写清「飞书的消息用飞书的 reply 工具回、回传 `chat_id`」,多 channel 下 Claude 才不会串台。

4. **别指望 session 内并发。** 即便飞书和另一个 channel 同时挂着,仍是单队列串行 + 同回合批处理。如果要「飞书消息和别的来源真正并行处理」,正确做法是开多个 session —— 这恰好契合 claudemux「一个 teammate 一个 session」的模型:要并发就派多个 teammate,而不是指望一个 session 多 channel 并行。

5. **多 channel 会放大进程残留 bug。** 每个 channel = 一个独立 bun 子进程。同挂 N 个 channel 就有 N 个 server 进程;若飞书插件的进程残留 bug(见 exploration.md C 节)没修,多 channel 场景下泄漏成倍。修复进站/退出清理仍是前置项。

6. **`meta` 键命名约束。** 键只能是字母/数字/下划线,带连字符的会被静默丢弃。飞书现用的 `chat_id`/`message_id`/`user`/`user_id`/`ts`/`image_path` 都合规,保持即可。

7. **启动方式。** 自建飞书 channel 不在官方 allowlist,始终需 `--dangerously-load-development-channels plugin:feishu-channel@claudemux`;若同 session 还要官方 channel,另一个走 `--channels`,两个 flag 并存。

---

## Hazard dispositions

> Appended 2026-05-21, after this snapshot was frozen, per
> [decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md).
> The snapshot body above is unchanged; this appendix is append-only.

This note studied whether one session can host several channels. Its design
implications travelled into decision 0006. One item is recorded here for how
it was mis-filed.

### Events serialize across channels — one session queue, no concurrency (§4)
**Promoted** → [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md)
and the event scope; the channel makes no concurrency assumption.

### `meta` keys must be alphanumeric / underscore (§实际影响 6)
**Promoted** → decision 0006: `buildMeta` uses only compliant keys and carries
a comment recording the constraint.

### Multi-instance reasoning, mis-attributed (§实际影响 5)
This item reasoned about running multiple instances — but along the wrong
axis: *N channels inside one session* amplifying the **process-leak** hazard,
not *N sessions each running the same Feishu channel* splitting **inbound
delivery**. The fan-out hazard it did not reach is dispositioned in
[feishu-channel-notes.md](/.agents/research/feishu-channel-notes.md) §1.2. That
a document which did multi-instance reasoning still missed fan-out is a data
point in [decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md):
a hazard can be partially recognised and still mis-routed.
