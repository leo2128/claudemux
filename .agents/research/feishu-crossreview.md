# feishu-channel 插件 — 交叉 review 报告

> 独立交叉评审,只读。日期 2026-05-21。
> 评审对象:`plugins/feishu-channel/`,分支 `feishu-channel-plugin`(15 commits,`31cc87e`..`a101a12`)。
> 基准:`feishu-channel-spec.md`、`channel-references.md`、`feishu-events-notes.md`。
> 评审者未参与该插件开发,目的是给一双外部的眼睛。

---

## 总评

**整体健康度:工程基本功扎实,但有一处"看着完整、其实没接通"的功能性塌陷。**

值得肯定:模块切分干净(纯函数核心 + 可注入边界),`bun:test` + `fast-check` 用得到位,
`gate` / `shutdown` 两个安全攸关模块的单测分支覆盖是真的密。`tsc --noEmit` 干净,
`bun test` 130 全过(本地实测,bun 1.3.14)。优雅关闭的协调器设计正确且锁得很死。

但有一个 ❌ 级问题:**配对(pairing)访问控制的"授权"那一半根本没有实现** —— 新用户能拿到配对码,
却没有任何代码能把他从 `pending` 升到 `allowFrom`。开箱即用的默认策略下,任何人 DM 机器人都永远进不来。
配套的 access / configure skill 也整个缺失(spec 明列的交付物)。

其次有一组"测了但没接线"的死代码(`chunk` / `sendable` / `filename` / `approved*` 路径),
导致 **130 这个测试数字虚高** —— 一部分测试在保护生产里根本不执行的代码。
最典型的是 `chunk`:为"长回复分块"写了完整的 property-based 测试,却没接进 `reply` 链路,
长回复在生产会被飞书 API 直接打回。

**结论:不是质量差,是"完成度被高估了"。** 核心逻辑的代码质量在水准线之上;
问题集中在"模块写完了 ≠ 功能接通了"。下面逐维展开。

---

## 一、测试覆盖 —— ⚠️

### 逐模块核对

每个 `src/` 模块都有对应 `test/` 文件,这一点 ✅。但 spec 明确提醒"数量 ≠ 覆盖",按此核对:

| 模块 | 测试 | 评价 |
|---|---|---|
| `access.ts` (`gate`) | `access.test.ts` | ✅ 强。guard rails / DM 全分支 / group 全分支 / 纯度 / 剪枝,几乎每条 branch 都打到 |
| `shutdown.ts` | `shutdown.test.ts` | ✅ 强。清理顺序、幂等(二次/并发/started)、失败任务不连累、信号、watch 竞态,20+ 例 |
| `chunk.ts` | `chunk.test.ts` | ✅ property-based(无损性、上界、计数),测试本身好 —— 但被测代码没接线(见下) |
| `content.ts` | `content.test.ts` | ⚠️ text/image/file/post/mentions 都测了;漏 `ja_jp` locale 分支、无 locale 块的兜底 |
| `access-store.ts` | `access-store.test.ts` | ✅ load/save/normalize、损坏文件移走、权限位、partial 文件填默认 |
| `feishu.ts` | `feishu.test.ts` | ⚠️ 只测了 `normalizeInboundEvent`;`createFeishuTransport` 整体零测试(见 §2) |
| `pairing.ts` `filename.ts` `paths.ts` `sendable.ts` | 各自 `.test.ts` | ✅ 测试本身写得好(真 symlink、property-based);但 `sendable`/`filename` 没接线 |
| `server.ts` (`createChannelCore`) | `server.test.ts` | ⚠️ 核心路径覆盖不错,但有缺口(见下) |
| `server.ts` (`main`/装配层) | 无 | ❌ 完全没测 |

### 实测确认

```
bun test  →  130 pass / 0 fail / 2712 expect() / 11 files
tsc --noEmit  →  干净
```

spec 交付物"全部 bun test 通过 + tsc 干净" ✅ 达成。

### 真实的覆盖缺口

1. **死代码拉高了计数。** 实测 `grep` 确认以下符号**只在自己文件里出现,没有任何 `src/` 调用点**:
   `chunk`、`assertSendable`、`sanitizeInboundFileName`、`isPairingCode`、`approvedDir`/`approvedMarker`。
   `content.ts` 的 `ParsedInbound.imageKey` / `fileName` 被 `parseInbound` 写入(`content.ts:54-59`),
   但 `server.ts handleInbound` 只读 `parsed.text`,这两个字段没有任何读取点。
   也就是说 130 例里有相当一部分在守护**生产不执行的代码** —— 覆盖率数字可信,但"有效覆盖"被高估。

2. **`createFeishuTransport` 零测试,且其中含关停关键路径。** `feishu.ts:156-227` 的真实 transport
   —— 包括 `close()` 里的 `wsClient?.close()`(`feishu.ts:200-208`)—— 完全没有单测。
   设计注释说"需要真飞书 app 才能测"是站得住的边界,但 spec 硬要求"优雅关闭有测试锁死,
   进程泄漏 bug 不复发":`ShutdownCoordinator` 锁得很死 ✅,可真正释放 WebSocket 的那一下
   (`wsClient.close()`)不在任何测试射程内。已查 SDK 源码确认 `WSClient.close()` 是真方法、
   且与 SDK 自身调用方式一致(`node-sdk` 内部也是 `close({})`),所以**当前是对的**;
   风险在 `feishu.ts:201-205` 那个宽 `try/catch` —— 它本意是吞"重复关闭",但也会吞掉
   "`close` 方法以后被改名/移除"这类错误,而没有测试会发现。

3. **无集成测试。** `channel-references.md` 的 Top 2 明确建议:纯函数单测管"逻辑对不对",
   再用一个可注入的假平台给 MCP 装配层写**集成测试**管"协议接得对不对"。
   现状 `server.test.ts` 测的是 `createChannelCore` 打假货,真正的
   `Server` / `StdioServerTransport` / `server.notification(...)`
   —— 也就是 `notifications/claude/channel` 真正发出去的那一段(`server.ts:333-339`)—— 没有任何测试。

4. **`server.test.ts` 的分支缺口:** 配对**重发**路径(`isResend` 的提示文案、`replies` 递增)
   只在 `gate` 层测了,没在 server 层测;`pair` 分支里 `transport.sendText` 抛错的情况没测;
   群消息"未 @ 机器人被丢弃"在 server 层没测;非 text 消息类型没走过一遍 server。

5. **`readEnvFile` / `loadCredentials`(`server.ts:289-319`)零测试。** 这俩有真实逻辑
   (正则解析、引号剥离、env 回退、缺凭证抛错),没导出、没测。

---

## 二、优雅关闭 / 进程不泄漏 —— ✅(协调器) / ⚠️(叶子未测)

### 接线核对(`server.ts main()` 322-353)

| spec 要求 | 实现 | 状态 |
|---|---|---|
| SIGTERM / SIGINT | `shutdown.installSignalHandlers()` → `SHUTDOWN_SIGNALS` | ✅ |
| stdio onclose | `shutdown.watch(server)`,挂在 MCP `Server.onclose` 上 | ✅ |
| clearInterval | WSClient 的 ping/reconnect 定时器由 `wsClient.close()` 内部 `clearTimeout` 释放 | ✅(SDK 内做) |
| wsClient 断连 | `shutdown.register('feishu-transport', () => transport.close())` → `wsClient?.close()` | ✅ |

`ShutdownCoordinator` 设计正确:幂等(`shutdownRun` 单飞)、按注册序跑、单个任务抛错被记录且不连累其余、
`watch` 保留已有 `onclose`。`shutdown.test.ts` 把这些全锁住了,包括"信号与 onclose 竞态只跑一次清理"。
这是这个插件里质量最高的一块。

### 仍需注意

1. **孤儿检测靠 stdio onclose,这是对的。** `channel-references.md` 提到 retrodigio 的
   "orphan watchdog"(父进程死 → server 自清理)。这里:父 Claude Code 死 → stdio 管道关 →
   `StdioServerTransport` 收到 stdin EOF → `Server.onclose` → `shutdown.watch` 触发。
   MCP-over-stdio 模型下 stdio onclose **就是**孤儿检测,且已接通 ✅。不算缺口。

2. **`watch(server)` 在 `server.connect()` 之前调用** —— 没问题。MCP SDK 的 `Server.onclose`
   是用户属性,`connect()` 通过内部 `_onclose` 读它、不覆盖它。`watch` 还保留了既有 handler。✅

3. **⚠️ 无强制退出兜底。** `runShutdown`(`shutdown.ts:97-106`)逐个 `await` 清理任务,
   没有超时。如果某个清理任务卡住(例如 `wsClient.close()` 因 SDK bug 不返回),进程会**永远挂着**
   —— 这本身就是另一种"进程泄漏"。建议加一个"清理超过 N 秒就 `exit` 兜底"的看门狗定时器。

4. **⚠️ 启动失败绕过协调器。** `transport.start()` 抛错时(如凭证错),`main().catch` 直接
   `process.exit(1)`(`server.ts:356-359`),此时 `server.connect()` 已成功、信号已装,
   但 `process.exit(1)` 不跑清理任务。属于启动期,影响小,但与"所有退出走协调器"不一致。

---

## 三、channel 协议正确性 —— ✅

对照 `channel-references.md` 的协议契约与官方 sample:

| 契约项 | 实现 | 状态 |
|---|---|---|
| `claude/channel` capability | `capabilities: { tools: {}, experimental: { 'claude/channel': {} } }` (`server.ts:278`) | ✅ |
| 进站 `notifications/claude/channel` | `CHANNEL_NOTIFICATION_METHOD`,`params: { content, meta }` (`server.ts:34, 333-339`) | ✅ |
| `meta` 键限字母数字下划线 | `buildMeta` 用 `chat_id`/`message_id`/`chat_type`/`sender_id`,全合规 | ✅ |
| `reply` 出站工具 | `CHANNEL_TOOLS` 有 `reply`(+ `react` / `edit_message` 扩展) | ✅ |
| 进站门禁按"发送者身份" | `gate` 按 `senderId`(open_id)门禁,非按会话 ID | ✅ |
| channel instructions | `CHANNEL_INSTRUCTIONS` 注入,描述 `<channel source="feishu">` 各属性 | ✅ |

**亮点:** `buildMeta`(`server.ts:214-222`)带了一条注释明确写"键必须字母数字下划线 ——
连字符会被丢弃",说明作者读过协议约束、不是瞎对。✅

**说明(非缺陷):** `channel-references.md` 提到 webhook.ts sample 的第三段是
`notifications/claude/channel/permission_request` / `permission` 权限中继。本实现未做。
spec 硬要求只列了"`reply` 等工具出站",未要求权限中继 —— 故归为**将来项**,不是本期缺陷。

---

## 四、认知陷阱 —— 逐条裁决

spec 点名要看那个 teammate 自己做过的判断决定。逐个裁:

### 4.1 reply 按 chat_id 发 —— ✅ 合理取舍

`sendText` 用 `receive_id_type: 'chat_id'`(`feishu.ts:178-184`),接口注释说"按 chat_id 路由、
绝不按 message_id,这样伪造的回复目标无法把消息重定向到无关会话"。安全推理成立。
代价:群里回复是"群里发新消息",不是 threaded 回复。`message_id` 已在 meta 里,
将来想要 thread 回复可切 `im.message.reply` API。**当前取舍合理,不必改。**

### 4.2 bot open_id 裸调 `/open-apis/bot/v3/info` —— ⚠️ 说服了自己,但留了个静默陷阱

`resolveBotOpenId`(`feishu.ts:217-227`)best-effort,失败 → 返回 `undefined`、不阻塞启动。
"不阻塞启动"听着稳健,**但后果没想透**:`botOpenId` 一旦是 `undefined`,
`isBotMentioned(mentions, undefined)` 恒为 `false`(`access.ts:131`),
于是**所有 `requireMention: true` 的群会静默丢掉全部消息** —— channel 在群里彻底失聪,
而失败被 `catch { return undefined }` 吞掉,没有任何日志。
这是典型"局部决定合理、全局后果是静默全failure"。**至少要在解析失败时打一条 warning。**

### 4.3 附件下载未做 —— ⚠️ 本身可接受,但留下一片死代码

`parseInbound` 对 image/file 返回 `imageKey`/`fileName`,但没有下载逻辑,
`server.ts` 也不读这俩字段。图片到 Claude 那里就是字面文本 `"(image)"`。
本期 spec 范围是"IM 消息 + reply",附件下载算可不做。
**真正的问题是:** 为这个没做的功能,`sanitizeInboundFileName`、`inboxDir`、`assertSendable`
全都写好并测好了。`sendable.ts:5-9` 的文件注释甚至说"reply 工具接受任意文件路径作附件"——
可 `reply` 工具(`server.ts:69-85`)只有 `chat_id` + `text`,**根本没有文件参数**。
文档描述的功能不存在。要么把附件接通,要么把这片模块连同其测试一起删掉。

### 4.4 chunk 未接线 —— ❌ 这是"说服了自己"最实的一例

`chunk.ts` 写得很好,property-based 测试齐全,给人"长回复分块已解决"的假象。
但实测 `grep` 确认:**`chunk` 在 `src/` 里零调用点。** `reply` 工具直接
`transport.sendText(chatId, text)` 发整段(`server.ts:185`)。
飞书文本消息有长度上限,Claude 的长回复会被飞书 API 直接打回 ——
`reply` 工具返回 `isError`。这个模块就是为了解决这个问题而造的,却没插进链路。
**一个数着"130 测试、chunk 已覆盖"的 reviewer 会以为长回复处理做完了。没有。**

### 4.5 配对审批闭环 —— ❌ 这是最严重的认知陷阱

这一条 spec 没点名,但它是交叉 review 最该揪出来的:
作者造了 `approvedDir` / `approvedMarker` 路径构造器(`paths.ts:27-34`)、
写了 `paths.ts:26` 的注释"access skill 往这里丢每个发送者的批准标记"、
写了配对 `gate`、写了 README"operator approves the sender out of band,之后消息就送达"——
**整个授权那一半完全不存在**:

- 没有 access skill(`plugins/feishu-channel/` 下没有 `skills/` 目录)。
- `gate` 从不读 `approvedDir` / `approvedMarker` —— 即使 skill 存在并丢了标记文件,
  当前 `gate` 也不会看。
- 没有任何代码往 `access.json` 的 `allowFrom` 写入。`gate` 只动 `pending`(增/剪枝/`replies`++),
  从不把发送者从 `pending` 升到 `allowFrom`。

后果:默认 `dmPolicy: 'pairing'` 下,新用户 DM 机器人 → 拿到配对码 → **然后没有然后了**,
永远进不来。配对码这个功能造好了、测好了(`pairing.test.ts`),却通向一个死胡同。
各个零件单看都完整,**零件之间的线没接**。详见 Top 1。

### 4.6 drop 的 reason 被算出来又丢掉 —— ⚠️

`GateResult` 的每个 `drop` 都带一个 `reason` 字符串(`access.ts:42`),
`server.ts:168-170` `case 'drop': return` —— **reason 直接丢弃,不打日志**。
对一个访问控制系统,"我的消息为什么没进来"是头号运维问题,而答案被算出来后扔了。
建议 drop 时按 debug 级把 `reason` 打出来。

### 4.7 pair 分支先存盘后发送 —— ⚠️ 小但真实

`handleInbound` 的 pair 分支:先 `saveAccess`(`server.ts:154-156`)再
`transport.sendText` 发配对码(`server.ts:163-166`)。若 `sendText` 抛错(飞书抖动),
pending 条目已落盘但用户没收到码。下次同一发送者来 → 走 `isResend`、`replies`++,
两次发送都失败就把人锁在 `MAX_PAIRING_REPLIES` 外、且他从没见过那个码。
pair 分支改成"发送成功后再存盘"更稳。

---

## 五、可扩展性前瞻(registry 重构)—— ⚠️ 没画进死角,但比"注册个新 handler"重

spec 要求事件处理做成注册表 / 可插拔,并明确"禁止把事件硬编码进 server"。
现状 `feishu.ts:168-176` 把 `im.message.receive_v1` 单点硬编码在 `EventDispatcher.register` 里。
下一轮要接 `drive.notice.comment_add_v1`(文档评论,见 `feishu-events-notes.md` §2)。判断如下:

### 已经是 registry-friendly 的两道缝(好消息)

1. **`FeishuTransport` 是带 DI 的接口**(`feishu.ts:52-72`)—— 平台边界已抽象,registry 可以坐在它后面。
2. **`notify(content, meta)` 是事件无关的契约**(`server.ts:37-40`)。content+meta 足够通用,
   评论事件一样能产出 content/meta。**通知层不需要改。** 这是真正 registry-ready 的一块。
3. `normalizeInboundEvent` 是纯函数 ——"原始 payload → 规整事件"正是 per-handler 想要的"解析"步,
   handler 的形状(订阅键 + normalize + 映射)已经半成型,只是没泛化。

### 需要动核心链路的三处(这就是 spec 说"不需要改动核心链路"会被违反的地方)

1. **`FeishuInboundEvent` 是 IM 消息形状**(`feishu.ts:18-36`:messageId/chatId/chatType/
   senderId/messageType/content/mentions)。文档评论事件结构完全不同(`feishu-events-notes.md` §2:
   评论者身份、评论文本、doc token/file_type/title/URL、comment_id/reply_id、is_whole/quote)——
   它不是一条"消息"。要接评论事件,要么把 `FeishuInboundEvent` 撑成 union、要么改 `start()` 签名,
   两者都是核心链路改动。
2. **`gate` 是 IM 门禁**(p2p/group/mention/botOpenId 全是 IM 概念)。评论事件没有 `chat_type`,
   其访问模型不同(`feishu-events-notes.md` §2:跳过机器人自己的评论、跳过没 @ 机器人的评论)。
   `gate` 没法原样复用于评论事件 —— 整条 `parseInbound → gate → notify/pair/drop` 流水线都是 IM 形状的。
3. **`CHANNEL_TOOLS` 扁平硬编码在 `server.ts:69-119`**。评论事件出站走 file-comment API
   (`feishu-events-notes.md` §2 末),与 `reply` 不同。registry 应当让每个事件类型自带它的出站工具。

### 判断

**没有画进死角**(transport DI 边界 + notify 契约这两道缝是对的),
**但 round 2 不是"加一个 handler"那么轻** —— 要引入 `EventHandler` 抽象
(订阅键 + normalize + 访问决策 + 映射成 content/meta + 自带出站工具),
把 `gate` 从"流水线的一环"降级成"IM handler 自己的 access 策略",
再让 `start()` 从 registry 批量 `register` N 个 dispatcher 键。这是一次中等规模的核心重构。

**给 round 2 的一条具体建议:** 别急着把 comment 字段塞进 `FeishuInboundEvent`。
`feishu-events-notes.md` §2 自己标注了 comment payload 字段是第三方来源、未官方逐字核实,
且 `drive.notice.comment_add_v1` 本身建议"落地前在应用后台确认可勾选"。
所以用 **per-handler 的事件类型**(每个 handler 定义自己的规整事件结构)比撑一个全局 union 更稳。

---

## 必须修的 Top 6(按严重度)

### Top 1 — ❌ 配对授权闭环缺失:配对码通向死胡同

配对能发码,但没有任何代码能批准一个发送者。`gate` 从不读 `approvedDir`/`approvedMarker`;
没有代码写 `access.json` 的 `allowFrom`;access / configure skill 整个不存在
(`plugins/feishu-channel/` 无 `skills/` 目录,而 spec 交付物明列"configure skill")。
默认 `dmPolicy: 'pairing'` 下,新用户永远进不来 —— 这是 channel 的头号 UX 路径,目前是断的。
**修:** 补 access skill(消费配对码、写批准),并让 `gate`/`access-store` 真正读它落下的批准标记
(或直接收敛成只写 `allowFrom`,把 `approvedDir`/`approvedMarker` 删掉)。配套补 configure skill。

### Top 2 — ⚠️→❌ chunk 未接线,长回复在生产会失败

`reply` 工具直发整段文本(`server.ts:185`),`chunk.ts` 零调用点。
长 Claude 回复超飞书文本上限会被 API 打回。**修:** `reply` 出站经 `chunk(text, limit, 'newline')`
分块逐条发送。模块已就绪,只差接线。

### Top 3 — ⚠️ botOpenId 解析失败 → 所有 requireMention 群永久失聪

`resolveBotOpenId` 失败静默返回 `undefined`(`feishu.ts:217-227`),导致 `isBotMentioned` 恒 `false`,
群消息全被丢且无日志。**修:** 解析失败时打 warning;考虑启动期重试,或在群门禁里把
"botOpenId 未知"与"未提及"区分对待并记录。

### Top 4 — ⚠️ 死代码集群,130 测试数虚高

`chunk` / `assertSendable` / `sanitizeInboundFileName` / `isPairingCode` /
`approvedDir`/`approvedMarker` / `ParsedInbound.imageKey`/`fileName` —— 全部测了但 `src/` 无调用点。
`sendable.ts:5-9` 还描述了一个不存在的"reply 带文件附件"功能。
**修:** 每个模块二选一 —— 接进生产链路,或连同测试一起删。让测试数反映真实有效覆盖。

### Top 5 — ⚠️ drop 的 reason 被丢弃,访问控制零可观测性

`gate` 给每个 drop 算了 `reason`,`server.ts:168-170` 直接丢。
"消息为什么没进来"无从排查。**修:** drop 分支按 debug/info 级把 `reason`(连同 `senderId`/`chatId`)打出来。

### Top 6 — ⚠️ MCP 装配层与真实 transport 零测试,且无集成测试

`main()` / `createMcpServer` / `readEnvFile` / `loadCredentials` / `createFeishuTransport`
全无测试 —— 包括关停关键的 `transport.close()`。`channel-references.md` Top 2 明确建议给装配层
配一个"假平台"集成测试。**修:** 至少给 `readEnvFile`/`loadCredentials` 补单测;
按 Top 2 思路,把 `createChannelCore` + 假 transport + 一个捕获 `notification` 的假 `Server`
串起来做一个端到端集成测试,覆盖"进站事件 → notification"和"工具调用 → 出站"。

---

## 可选改进

- **关停加强制退出看门狗:** `runShutdown` 无超时;清理任务卡死会让进程永久挂起。加一个
  "清理超 N 秒即 `exit` 兜底"的定时器。
- **pair 分支改成发送成功后再存盘**(见 §4.7),避免飞书抖动把用户锁在配对码外。
- **`feishu.ts:201-205` 的 `try/catch` 收窄:** 当前会吞掉"`close` 方法不存在"这类错误。
  可只吞已知的"重复关闭"错误,或在 catch 里至少打一条 debug 日志。
- **`MAX_PENDING` 锁定风险:** 3 个 pending 占满后,合法的第 4 个用户在 TTL(1 小时)内
  连配对码都拿不到、无任何反馈。TTL 会自愈,严重度低,但值得在文档或日志里体现。
- **`content.ts` 补 `ja_jp` locale 与"无 locale 块"分支的测试**(`pickPostLocale` 列了 `ja_jp` 但没测)。
- **权限中继(`notifications/claude/channel/permission`)** 本期不要求,作为将来项记一笔。
- **`react` 工具的 emoji 不校验** —— 坏 emoji_type 由飞书 API 报错并回传 `isError`,可接受;
  若想更友好可在出站前对照飞书 emoji 枚举校验。

---

## 附:评审中实际跑过的命令(只读验证)

```
git -C .../claudemux log --oneline origin/main..feishu-channel-plugin   # 15 commits
bun test          # 130 pass / 0 fail
bun run typecheck # tsc --noEmit 干净
grep -rn <symbol> src/   # 确认 chunk/sendable/filename/approved* 无调用点
git ls-files plugins/feishu-channel/   # 确认 node_modules 未入库、无 skills/ 目录
# 阅 node-sdk 源码确认 WSClient.close() 为真方法
```

未修改任何飞书代码,未提交,未触碰 `plugins/`。本报告是本次评审唯一写入的文件。
