# Claude Code Channel 优质参考实现调研

> 只读调研。日期 2026-05-21。
> 目的:为「在 claudemux 从零写飞书 channel 插件、要求完善单测」找优质参考实现。
> m1heng 的 feishu/weixin 插件只当协议参考,不当质量标杆。

---

## 速查结论

- **官方有 channel 参考实现**:Anthropic 在 `claude-plugins-official` 仓库开源了 4 个官方 channel(telegram / discord / imessage / fakechat),文档里还有完整可跑的 sample code。但**没有 channel SDK**,而且**这 4 个官方 channel 没有任何测试** —— 协议权威,不是测试标杆。
- **测试标杆要去社区找**:`jeremylongshore/claude-code-slack-channel` 是目前唯一一个测试做得认真的 channel 实现(~180+ 单测、property-based、mutation testing、CI 全套)。
- Channels 本身是 2026-03-20 发布的研究预览特性,需 Claude Code v2.1.80+。

---

## 一、Anthropic 官方:有参考实现,但没有测试参考

### 1a. 官方 channel 插件源码 —— `anthropics/claude-plugins-official`

- **URL**:https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins
- **包含的 channel**:`external_plugins/` 下有 `telegram`、`discord`、`imessage`、`fakechat` 四个 channel 插件(其余 asana/github/linear 等是普通工具插件,非 channel)。
- **语言 / runtime**:全部 TypeScript + Bun。
- **MCP 搭法**:每个都是**单文件 `server.ts`**。`new Server(...)` + `StdioServerTransport`,`capabilities.experimental['claude/channel'] = {}`,用 `mcp.notification({ method: 'notifications/claude/channel', ... })` 推进站事件,`reply` 工具走出站。结构上和 m1heng 那套同源(m1heng 八成就是照着官方抄的)。
- **测试情况**:**无。** 已逐一核查 `telegram` 和 `fakechat` 的文件清单 —— 无 `*.test.ts`、无 `tests/` 目录、`package.json` 无 test script;`discord` 同样核查确认无测试;`imessage` 沿用同一单文件模式。
- **质量评价**:**协议权威性 = 高**(这是协议定义方自己的实现,语义最准);**作为测试标杆 = 不适用**(根本没测试)。可以当「协议正确性」对照,不能当「怎么写测试」对照。

#### `fakechat` —— 官方的「reference / demo channel」

- **URL**:https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat
- 文件:`server.ts` + `.mcp.json` + `.claude-plugin/` + `package.json`(无 skills,无测试)。
- 它是官方钦定的最小双向 channel 示范:在 `localhost:8787`(`FAKECHAT_PORT` 可配)起一个浏览器 UI,实现 `reply` + `edit_message` 两个工具 + 文件附件(inbox/outbox,50MB 上限)。
- **价值**:它本身是个「假聊天平台」—— 不用真连任何 IM 就能在浏览器里收发消息验证 channel 进出站。**这正好可以当飞书插件的集成测试 / 手动验收夹具**:把飞书 SDK 那层换掉,channel 协议层用 fakechat 的玩法本地验证。

### 1b. 官方文档里的 sample code —— channels-reference

- **URL**:https://code.claude.com/docs/en/channels-reference
- 这一页**自带完整可跑的 sample server**(`webhook.ts`):从单向 webhook 接收器,到加 `reply` 工具的双向 channel,再到 `claude/channel/permission` 权限中继 —— 三段代码都是完整文件,可直接 `claude --dangerously-load-development-channels server:webhook` 跑。
- 它定义了协议契约:`claude/channel` capability、`notifications/claude/channel`(`content` + `meta`)、`reply` 工具、`gate()` 进站门禁(强调按**发送者身份**而非会话/房间 ID 门禁)、`notifications/claude/channel/permission_request` / `permission` 权限中继。
- **价值**:这是写飞书插件时**协议正确性的第一手依据**,比读 m1heng 的代码可靠。但它是文档示例,不是带测试的工程仓库。
- **没有 channel SDK**:文档明确说唯一硬依赖是 `@modelcontextprotocol/sdk` —— channel 不是一个独立 SDK,就是「按约定声明 capability + 发 notification」的 MCP server。所以「找官方 channel SDK」这条:**不存在**。

---

## 二、社区开源 Claude Code channel 插件

### 2a. `jeremylongshore/claude-code-slack-channel` —— 测试标杆 ⭐

- **URL**:https://github.com/jeremylongshore/claude-code-slack-channel
- **语言 / runtime**:TypeScript(strict)。三种 runtime:Bun(推荐)、Node.js(`npx tsx`)、Docker。
- **MCP 搭法**:**模块化**,不是单文件。源文件:`server.ts`(MCP / channel 协议层)、`supervisor.ts`(进程监管)、`policy.ts` + `policy-dispatch.ts`(权限策略引擎)、`journal.ts`(hash-chain 防篡改审计日志)、`crypto.ts`、`manifest.ts`、`lib.ts`、`acp-adapter.ts`。走 Slack Socket Mode(WebSocket,纯出站,无需公网 URL),`claude/channel` + 权限中继都实现了。
- **测试情况 —— 重点**:
  - 测试文件 `server.test.ts`,框架 `bun:test`(`import { describe, test, expect, beforeAll, ... } from 'bun:test'`)。
  - 规模 **~180+ 个测试 / 25+ 个 describe 块**。
  - `package.json` scripts:`"test": "bun test"`、`"typecheck": "tsc --noEmit"`、`prepare: husky`。
  - devDependencies 里有 **`fast-check`(property-based 属性测试)** 和 **`@stryker-mutator/core`(mutation testing 突变测试)** —— 测试质量意识远超平均水平。
  - 测的内容:`gate()` 进站门禁(bot ID 识别、subtype 过滤、DM 策略、频道 opt-in、@提及要求)、`assertSendable()` 文件外发防护(symlink 跟随、`.env`/`.ssh`/`.aws` 危险文件拦截、路径包含)、session 持久化(文件 I/O、Zod schema 校验、重启恢复、旧版布局迁移)、policy 规则 schema、文本分块、文件名净化、配对码生成。
  - **Mock 策略(关键)**:几乎不 mock。用 `mkdtempSync()` 给每个测试开真实临时目录,**真建文件和 symlink** 来验证路径穿越防护,**不 mock Slack API,也不 mock MCP server** —— 把核心逻辑抽成纯函数后在隔离环境里测。
  - 工程配套:GitHub Actions CI、Biome(lint/format)、husky + lint-staged(pre-commit)、dependency-cruiser(架构约束)、gitleaks(密钥扫描)、OpenSSF Scorecard。
- **进程生命周期**:有 `supervisor.ts`;贡献者 @jinsung-kang 加过「clean shutdown on client disconnect (v0.3.1)」—— 客户端断开就干净关闭,Socket Mode 纯出站设计也让收尾简单。**比 m1heng 那套的进程泄漏强。**
- **质量评价**:**高**。是这次调研里唯一能当「测试怎么写」标杆的实现。

### 2b. `retrodigio/claude-channel-slack` —— 中等,但解决了进程泄漏

- **URL**:https://github.com/retrodigio/claude-channel-slack
- **语言 / runtime**:TypeScript + Bun。
- **MCP 搭法**:**单文件 `server.ts`**,Slack transport + MCP 协议 + 访问控制全揉在一起。结构与 m1heng 的 feishu/weixin **几乎同构**:`skills/{access,configure,threads}/SKILL.md`、状态在 `~/.claude/channels/slack/`、配对流程、反 prompt-injection 的 skill 头部 —— 同一套模式家族。
- **测试情况**:有一个 `gate.test.ts`(对安全攸关的 `gate()` 门禁做单测)。**无 CI**,README 无测试章节,`package.json` 是否有 test script 未能确认。(注:`gate.test.ts` 的 raw 内容拉取返回 404,可能在非默认分支或路径不同,未能逐行核实,此处如实标注。)
- **进程生命周期**:README 明确写了 **"orphan watchdog"** —— 「父 Claude Code 进程死掉后 server 自己干净退出,防止僵尸进程占着 Socket Mode token」。**这正好对症 m1heng 飞书/微信插件的进程残留 bug** —— 值得抄这个机制。
- **质量评价**:**中**。比 m1heng 强(多了 orphan watchdog + 一个 gate 单测),但单文件、无 CI、测试覆盖单薄,不是测试标杆。当「单文件 channel + 进程自清理」的对照看。

### 2c. 不在参考范围内的(避免误抄)

搜索会撞到这两个,但**它们不是 channel 插件**,架构不同,别拿来当参考:

- `mpociot/claude-code-slack-bot`、`yuya-takeyama/cc-slack` —— 这类是「把 Claude Code 当 Slack 机器人跑」:它们 spawn `claude` 进程 / 用 Claude Code SDK,**不走 `claude/channel` MCP capability**。是 channels 特性发布前的老做法,协议模型完全不同。
- `slackapi/slack-mcp-plugin` —— 官方 Slack 的普通 MCP 工具插件,不是 channel(不推进站 notification)。

---

## 三、「最值得参考的 Top 2」

### Top 1:`jeremylongshore/claude-code-slack-channel` —— 抄它的测试架构

值得抄的:

1. **测试分层思路**:channel 的可测面不是 MCP stdio / notification 本身,而是**被抽成纯函数的核心逻辑**。把 `gate()`(门禁)、`assertSendable()`(路径防护)、`chunk()`(分块)、access/session 持久化、policy 匹配都做成不依赖 MCP server、不依赖网络的纯函数 —— 这些就是 180+ 测试的靶子。飞书插件照此做:把 `server.ts` 里的 `gate`/`assertSendable`/`assertAllowedChat`/`chunk`/`readAccessFile`/`extractPostText` 等抽到独立模块,单独测。
2. **不 mock 协议、不 mock 平台 API**:用 `mkdtempSync()` 真实临时目录做文件 I/O,用真实 symlink 测路径穿越。比起 mock 出一个假 MCP server,这种「纯逻辑 + 真文件系统」的测试又快又真。MCP server 装配(`mcp.connect`、`notification`)那一层不直接单测 —— 留给集成测试(见 Top 2)。
3. **`bun:test` + `fast-check` + Stryker**:`bun test` 当跑测器(零配置、和 runtime 同源);`fast-check` 对 `chunk()`、配对码、文件名净化这类「输入空间大」的函数做 property-based 测试;Stryker 突变测试反过来验证「测试本身有没有用」。这套是飞书插件单测可以直接照搬的工具链。
4. **进程监管**:`supervisor.ts` + 「client disconnect 干净关闭」的思路,正好填 m1heng 那套缺的信号处理 / 退出路径。

### Top 2:`fakechat`(官方) —— 抄它的协议正确性 + 当集成测试夹具

值得抄的:

1. **协议正确性基准**:它是 Anthropic 自己写的双向 channel,`reply` + `edit_message` + 文件附件的语义最准。飞书插件的 `reply`/`react`/`edit_message` 工具 schema 和 `notifications/claude/channel` 的 `meta` 用法,以它为准比以 m1heng 为准可靠。
2. **当集成测试夹具**:fakechat 是个「假聊天平台」,在 localhost 起 web UI 收发消息。飞书插件可以借这个思路给 channel 协议层写**集成测试**——把飞书 SDK 那层换成可注入的接口,测试时注入一个 fakechat 式的本地假平台,就能在不连真飞书的情况下端到端验证「进站事件 → notification」「reply 工具调用 → 出站」。这补上了 Top 1 纯函数单测覆盖不到的「MCP 装配层」。
3. 配合文档 sample(`webhook.ts`)一起读,把协议契约钉死。

> 组合用法:**Top 1 的测试方法学(纯函数单测 + property-based + mutation)** 管「逻辑对不对」;**Top 2 的协议基准 + 假平台夹具** 管「协议接得对不对」。两者合起来就是飞书插件「完善单测覆盖」的完整方案。

---

## 四、官方到底有没有现成的 —— 如实说

- **有 channel 参考实现**:`claude-plugins-official` 里 4 个开源官方 channel + 文档里完整 sample code。✅
- **没有 channel SDK**:channel 不是独立 SDK,就是 `@modelcontextprotocol/sdk` 上按约定声明 capability。❌
- **没有带测试的官方参考**:4 个官方 channel 全部零测试,官方不提供「channel 测试该怎么写」的范本。测试标杆只能用社区的 `jeremylongshore/claude-code-slack-channel`。❌

---

## 附:参考实现一览表

| 实现 | URL | 语言/runtime | MCP 搭法 | 测试 | 质量 |
|---|---|---|---|---|---|
| 官方 channel ×4(telegram/discord/imessage/fakechat) | github.com/anthropics/claude-plugins-official/tree/main/external_plugins | TS / Bun | 单文件 server.ts | **无** | 协议高 / 测试不适用 |
| 官方文档 sample(webhook.ts) | code.claude.com/docs/en/channels-reference | TS / Bun | 单文件示例 | 无 | 协议契约权威 |
| jeremylongshore/claude-code-slack-channel | github.com/jeremylongshore/claude-code-slack-channel | TS strict / Bun·Node·Docker | 模块化(server+supervisor+policy+journal…) | **bun:test ~180+,fast-check,Stryker,CI** | **高** |
| retrodigio/claude-channel-slack | github.com/retrodigio/claude-channel-slack | TS / Bun | 单文件 server.ts | gate.test.ts 一个,无 CI | 中 |
| mpociot/claude-code-slack-bot、yuya-takeyama/cc-slack | — | — | 非 channel(spawn claude / SDK) | — | 不在范围 |

---

## Hazard dispositions

> Appended 2026-05-21, after this snapshot was frozen, per
> [decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md).
> The snapshot body above is unchanged; this appendix is append-only.

This is a survey of reference channel implementations and their testing
methodology. It carried one implementer-facing hazard and one methodology
requirement; both travelled.

### Reference channels leak their process on exit (§2b — the m1heng / retrodigio comparison)
**Promoted** → spec hard-requirement #3 →
[decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md)
(`ShutdownCoordinator`). Same hazard as
[feishu-channel-notes.md](/.agents/research/feishu-channel-notes.md) §3.

### Test methodology — pure-function units, `bun:test` + `fast-check`, no mocked protocol (Top 1 / Top 2)
**Promoted** → spec hard-requirement #2, which names this document as the
methodology to follow.
