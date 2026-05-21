# feishu-channel 插件 —— 需求 spec(无人值守开发锚点）

> claudemux 仓库新建插件 `plugins/feishu-channel/`。所有 feishu 开发轮次以此为准。
> 日期 2026-05-21。

## 目标

一个**装上即用**的 Claude Code 飞书 channel 插件:飞书事件进 Claude Code 上下文,Claude 可经 channel 回复。

## 硬要求

1. **Claude Code channel 架构**:MCP server over stdio,`claude/channel` capability,`notifications/claude/channel` 进站,`reply` 等工具出站。
2. **完善单元测试**:照 `channel-references.md` Top 1 方法学 —— 纯函数抽离、`bun:test`、`fast-check` property-based、`mkdtempSync` 真实 I/O、不 mock 协议/飞书 API。
3. **优雅关闭从第一天就做对**:SIGTERM/SIGINT + stdio `onclose` → clearInterval + wsClient 断连 + exit。有测试锁住,进程泄漏 bug 不复发。
4. **飞书长连接模式**(`WSClient`),不暴露公网回调。

## 事件范围(本期 vs 将来)

- **本期只接两类事件**:
  1. IM 消息(`im.message.receive_v1`)+ reply
  2. **飞书文档评论事件**(精确 event_type 见 `feishu-events-notes.md` 调研)
- **架构必须可扩展**:事件处理设计成**注册表 / 可插拔模式** —— 新事件类型(表情回应、文件变更、日历、审批等)将来能直接注册接入,**不需要改动核心链路**。禁止把"两个事件"硬编码进 server。每个事件类型 = 一个 handler(订阅 + 解析 + 映射成 `<channel>` notification 的 content/meta),由一个 registry 统一挂载。
- 飞书事件全貌的深度调研产物:`feishu-events-notes.md`(由 claude-plugin-feishu teammate 产出)—— 设计可扩展层时以它为依据,确认未来事件的 payload 形态不会打破当前抽象。

## 交付物

- `plugins/feishu-channel/` 完整插件(scaffold + 8 核心模块 + feishu/shutdown/server + 事件 registry)
- marketplace 条目 + CI bun job(`oven-sh/setup-bun` + `bun test`)
- configure skill + README(安装 + 配置 app_id/app_secret 的清晰路径)
- 全部 `bun test` 通过 + `tsc --noEmit` 干净
- 一个 PR(分支 `feishu-channel-plugin`)

## 工程约束

- bun 在 `$HOME/.bun/bin/bun`(不在 PATH)
- 分支 `feishu-channel-plugin`,增量 commit,不直推 main
- 知识库(`.agents/`)完成后 cherry-pick 过来,开发中同步沉淀飞书 channel 的决策
