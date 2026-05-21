# 飞书 channel 插件 —— 调研笔记

> 目的:在 claudemux 仓库**从零写一个新的飞书 channel 插件**。本轮只做「同步代码 + 调研接口文档」,不写实现。
> 日期 2026-05-21。本文件在 dispatcher 目录,**不属于 claudemux repo**。

---

## 0. 代码同步确认

- claudemux 仓库已切回 `main` 并 `pull --ff-only` 到最新。
- **main 当前 HEAD:** `0f2e654 docs: dispatcher wait-and-readback 补「回复可能引用未目击指令」小节`
- 之前停在 feature 分支 `raise-wait-timeout-default`(已落后 5 个 commit),现已对齐 origin/main。

---

## 1. 飞书侧接口(官方 open.feishu.cn 文档)

China 站点 `open.feishu.cn`;Lark 国际站把 host 换成 `open.larksuite.com`,路径/结构一致。

### 1.1 tenant_access_token —— 自建应用换 token

- **文档:** https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
- **接口:** `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
  - Header `Content-Type: application/json; charset=utf-8`
  - 这个接口本身**不需要鉴权、不需要权限 scope**(用 token 换 token 的起点)。
- **请求体:** `{ "app_id": "cli_xxx", "app_secret": "xxx" }`
- **响应:** `{ "code": 0, "msg": "ok", "tenant_access_token": "t-...", "expire": 7200 }`
  - `expire` 是**剩余** TTL(秒),最大 2 小时。
- **关键陷阱 —— token 复用语义:**
  - 飞书服务端缓存 token。剩余 TTL ≥ 30 分钟时再调,返回**同一个** token(`expire` 变小)。
  - 剩余 TTL < 30 分钟时,签发**新** token,旧 token 仍有效到原过期点 —— **两个 token 会共存 ~30 分钟**。
  - 客户端应自己缓存并提前刷新,**不要每次请求都换 token**。
- **token 类型区分:**
  - `tenant_access_token` —— app 在某个租户内的身份。**bot 收发消息几乎全用这个。**
  - `app_access_token` —— app 自身的全局身份(自建应用 endpoint:`POST /open-apis/auth/v3/app_access_token/internal`,同样 app_id+app_secret 体)。bot 一般用不到。
  - `user_access_token` —— 代表某个具体用户(OAuth 流程),纯 bot 不需要。
- **实现注意:** 用官方 SDK 时**完全不用手动调这个接口** —— `lark.Client` / `lark.WSClient` 内部自动取并缓存 token(见 1.5)。仅在 SDK 没暴露的接口(如取 bot 信息)才需要裸调。

### 1.2 长连接 / WebSocket 事件订阅模式(长连接模式)

- **文档:** https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
- **可行性:官方原生支持。** app 主动开一条全双工 WebSocket 到开放平台,事件从这条 socket 推下来 —— **不需要公网 IP / 域名 / 回调 URL**。这是「不暴露公网回调」的关键能力。
- **限制(实现时必须知道):**
  - **仅自建应用可用。** 商店/应用市场应用必须用 HTTP 回调模式。
  - **每个 app 最多 50 条连接。** 每个初始化的 SDK client = 一条连接。
  - **集群投递,非广播。** 同一 app 跑多个实例时,每个事件只**随机投给其中一个**实例 —— 不要假设 fan-out。
  - **3 秒处理时限。** 事件 handler 要在 ~3s 内不抛错地返回,否则触发平台重试 —— 重活要异步做、快速 ack。
  - **不需要解密 / 验签。** 鉴权只在建连时做一次,后续事件 payload 是**明文**(HTTP 回调模式才要 Encrypt Key 解密 + Verification Token 验签)。
  - HTTP 回调能投的事件类型,长连接全都能投(v1.0 / v2.0 schema 都行)。
- **开发者后台配置:** 应用 → 事件与回调 → 事件配置 → 选「**使用长连接接收事件**」→ 订阅 `im.message.receive_v1` → 保存。**保存时必须有一个 client 在线连着**,否则保存失败。
- **建连客户端:** 官方 server SDK,版本门槛见 1.5。

### 1.3 接收消息事件 —— `im.message.receive_v1`

- **文档:** https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
- **内容结构:** https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
- **schema 2.0**,外层信封:`{ "schema": "2.0", "header": {...}, "event": {...} }`
  - 注意:用 SDK 的 `EventDispatcher` 注册 handler 时,handler 收到的 `data` 已经是 `event` 那一层(不含 header 信封)。
- **`header`:** `event_id`(幂等去重用)、`event_type`、`create_time`(毫秒字符串)、`app_id`、`tenant_key`、`token`。
- **`event.sender`:**
  ```json
  "sender": {
    "sender_id": { "union_id": "...", "user_id": "...", "open_id": "..." },
    "sender_type": "user",   // "user" 或 "bot"/"app"
    "tenant_key": "..."
  }
  ```
  - 三种 ID 都给:`open_id` app 内唯一;`union_id` 开发者内稳定;`user_id` 租户内(需 user_id 权限才有)。
  - **访问控制要 gate 在 `sender_id.open_id` 上**,不要 gate 在 chat_id —— 群里多人共用一个 chat_id。
- **`event.message`:**
  | 字段 | 说明 |
  |---|---|
  | `message_id` | `om_xxx`,用于 reply / react |
  | `root_id` / `parent_id` / `thread_id` | 回复链/话题相关,普通顶层消息可能缺省 |
  | `create_time` / `update_time` | 毫秒字符串 |
  | `chat_id` | 会话 ID `oc_xxx` |
  | `chat_type` | `"p2p"`(单聊)或 `"group"`(群) |
  | `message_type` | `"text"` / `"post"` / `"image"` / `"file"` / `"interactive"` ... |
  | `content` | **JSON 序列化后的字符串**,要二次 `JSON.parse` |
  | `mentions` | @提及对象数组 |
- **content 编码:**
  - `text`:`{"text":"@_user_1 hello"}` —— `@_user_1` 是占位符,真实身份对应 `mentions` 数组。
  - `post`(富文本):按 locale 分组 `{ zh_cn: {title, content}, en_us: {...} }`,`content` 是「段落数组的数组」,元素 tag 有 `text` / `a` / `at` / `img` / `media` / `code_block` / `hr` 等。
  - `image`:`{"image_key":"img_xxx"}`。
- **`mentions[]` 元素:** `{ key: "@_user_1", id: {open_id,union_id,user_id}, name, mentioned_type, tenant_key }` —— 用 `key` 匹配正文里的 `@_user_N` 占位符。

### 1.4 发送消息 API —— `im/v1/messages`

- **发送文档:** https://open.feishu.cn/document/server-docs/im-v1/message/create
- **回复文档:** https://open.feishu.cn/document/server-docs/im-v1/message/reply
- **加表情回应:** https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
- **emoji 枚举:** https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce

**发送消息:**
- `POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=<type>`
- Header:`Authorization: Bearer <tenant_access_token>`、`Content-Type: application/json; charset=utf-8`
- **`receive_id_type`(query,必填):** `open_id` / `union_id` / `user_id` / `email` / `chat_id`。
- **请求体:**
  | 字段 | 必填 | 说明 |
  |---|---|---|
  | `receive_id` | 是 | 要和 `receive_id_type` 对应 |
  | `msg_type` | 是 | 见下 |
  | `content` | 是 | **JSON 序列化后的字符串**,不是嵌套对象 |
  | `uuid` | 否 | 幂等键,≤50 字符,1 小时内同消息同 uuid 去重 |
- **`content` 必须 stringify:** `{"receive_id":"oc_xxx","msg_type":"text","content":"{\"text\":\"hello\"}"}` —— 内层是转义后的字符串,传裸对象会被拒。
- **`msg_type` 取值:** `text` / `post` / `image` / `file` / `audio` / `media` / `sticker` / `interactive` / `share_chat` / `share_user` / `system`。
- **响应 `data`:** `message_id` / `msg_type` / `chat_id` / `sender` / `body.content` / `mentions[]`。
- **大小限制:** text ≤ 150 KB;card/富文本 ≤ 30 KB;媒体要先上传拿 key 再引用。

**回复消息(quote-reply):**
- `POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reply`
- path `message_id` = 被回复消息;body:`content`(stringify,必填)、`msg_type`(必填)、`reply_in_thread`(bool,默认 false,true 为话题串回复)、`uuid`(选填)。
- **安全注意:** `reply` 按 `message_id` 路由,会忽略你校验过的 chat_id —— 伪造的 reply_to 能把消息发到无关会话。出站前要校验 `message_id` 属于断言的 chat_id。

**加表情回应:**
- `POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reactions`
- body:`{ "reaction_type": { "emoji_type": "SMILE" } }`
- 列出:`GET .../reactions`;删除:`DELETE .../reactions/:reaction_id`。

**速率限制(发送 / 回复 / 表情共用):**
- 全局:1000 请求/分钟,50 请求/秒。
- 单个用户(p2p):5 QPS。
- 单个群:5 QPS,**该群所有 bot 共享**。

### 1.5 官方 Node.js SDK —— `@larksuiteoapi/node-sdk`

- **npm:** https://www.npmjs.com/package/@larksuiteoapi/node-sdk
- **GitHub:** https://github.com/larksuite/node-sdk
- **包名:** `@larksuiteoapi/node-sdk`(旧的 `@larksuiteoapi/api` 已废弃,不要用)。
- **版本:** 最新约 `1.62.0`(npm 页面 403,版本号来自搜索快照,锁版本前用 `npm view @larksuiteoapi/node-sdk version` 复核);**长连接支持需 ≥ 1.24.0**。
- **长连接 `lark.WSClient`:完整支持。**
  ```js
  const lark = require('@larksuiteoapi/node-sdk');
  const wsClient = new lark.WSClient({ appId: 'cli_xxx', appSecret: 'xxx' });
  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => { /* data = event payload */ }
    })
  });
  ```
- **token 自动管理:** `lark.Client` / `WSClient` 内部自动取并缓存 `tenant_access_token`,不用手动加 `Authorization` 头。由 `disableTokenCache`(默认 false)控制;多进程可传自定义 `cache`。
- **`EventDispatcher`:** `new lark.EventDispatcher({})` —— **长连接模式传空配置 `{}`**(建连时鉴权);HTTP 回调模式才要传 `encryptKey` + `verificationToken`。`.register({ 'event_type': handler })` 注册事件。
- **发送用 `lark.Client`:** `client.im.message.create({ params:{receive_id_type}, data:{receive_id,msg_type,content} })`。
- **其它官方 SDK:** Go `oapi-sdk-go/v3`、Python `lark-oapi`、Java `oapi-sdk` —— 都支持长连接。

---

## 2. Claude Code channel 侧(优先 code.claude.com/docs)

- **build channel 契约:** https://code.claude.com/docs/en/channels-reference
- **安装/启用/企业管控:** https://code.claude.com/docs/en/channels
- **官方示例插件:** https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins (telegram / discord / imessage / fakechat)
- **状态:研究预览(research preview)。** `--channels` 语法和协议契约可能变。需要 Anthropic 鉴权(claude.ai 登录或 Console API key);**Bedrock / Vertex AI / Foundry 上不可用**。

### 2.1 `claude/channel` capability 声明

- 在 MCP `Server` 构造器的 capabilities 里声明:
  ```ts
  const mcp = new Server(
    { name: 'feishu', version: '0.0.1' },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: '...'
    },
  )
  ```
  | capability key | 必需 | 含义 |
  |---|---|---|
  | `capabilities.experimental['claude/channel']` | **必需**,值恒 `{}` | 它的**存在**把这个 MCP server 标记成 channel;Claude Code 在 MCP initialize 握手看到它就注册 `notifications/claude/channel` 监听 |
  | `capabilities.experimental['claude/channel/permission']` | 选填,值恒 `{}` | 开启权限提示转发(见 2.6) |
  | `capabilities.tools` | 双向 channel 必需,值恒 `{}` | 标准 MCP tool 能力,出站 reply 工具靠它被发现 |
  | `instructions` | 推荐 | 标准 MCP 字段,注入 Claude system prompt |
- 这个 key 走标准 MCP `initialize` 握手的 `ServerCapabilities`,不是单独握手。

### 2.2 channel 插件结构

- 就是普通 Claude Code 插件,只是它的 MCP server 声明了 channel capability。`plugin.json` **没有 channel 专属字段**(channel 只作为 keyword 出现)。
- 典型布局(官方 `fakechat`):
  ```
  .claude-plugin/plugin.json
  .mcp.json
  package.json
  server.ts            ← channel MCP server
  README.md
  ```
- **`.mcp.json`**(官方插件几乎逐字相同,只改 server name):
  ```json
  {
    "mcpServers": {
      "feishu": {
        "command": "bun",
        "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
      }
    }
  }
  ```
- **传输:永远 stdio。** Claude Code 把 channel server 作为**子进程** spawn,走 stdin/stdout(`StdioServerTransport`)。channel 没有 HTTP/SSE MCP 传输 —— 任何 HTTP 监听(webhook 接收、本地 UI)是 channel 自己的服务,跟 MCP stdio 链路无关。
- **运行时:** 只硬性依赖 `@modelcontextprotocol/sdk` + 一个 Node 兼容运行时。Bun / Node / Deno 都行,官方示例用 Bun。

### 2.3 进站 `notifications/claude/channel`

- channel 调 `mcp.notification()` 推事件 —— 单向 MCP notification,**无响应、无 ack**。
- **method 名:** `notifications/claude/channel`
- **`params`:**
  | 字段 | 类型 | 必需 | 含义 |
  |---|---|---|---|
  | `content` | `string` | 是 | 事件正文,成为 `<channel>` 标签的 body 文本 |
  | `meta` | `Record<string,string>` | 否 | 每个键成为 `<channel>` 标签的一个**属性**,用于路由上下文 |
- **`meta` key 规则(重要):** key 只能是标识符 —— **字母、数字、下划线**。含连字符等的 key 会被**静默丢弃**(`chat_id` 合法,`chat-id` 被丢)。
- **`meta` 无固定 schema。** `source` / `chat_id` / `sender` 都不是协议强制键 —— `meta` 自由定义,靠 `instructions` 告诉 Claude 每个属性什么意思。
- **渲染 `<channel>` 块:**
  ```
  <channel source="feishu" chat_id="oc_xxx" message_id="om_xxx" user="...">
  消息正文
  </channel>
  ```
  - `source` 属性由 **Claude Code 自动从 MCP server 的 `name` 取**,channel 不要自己塞 `source` 进 `meta`;其余属性都来自 `meta`。
- **投递语义:**
  - notification 不被 ack,`await mcp.notification()` 在写入 transport 时 resolve,不等 Claude 处理。
  - 若会话没把这个 server 当 channel 加载、或被组织策略挡,事件**静默丢弃**,server 收不到错误。
  - 事件**排队按序处理**;Claude 忙时到达的多条会在下个 turn 一起投递、成组处理。要并发独立流就开多个会话。

### 2.4 出站:Claude → channel

- 出站回复就是**标准 MCP tool**,没有 channel 专属机制。双向 channel 需要三样:`capabilities.tools: {}`、tool handler(`ListToolsRequestSchema` + `CallToolRequestSchema`)、`instructions` 告诉 Claude 何时怎么调。
- **惯例工具 `reply`**(只是约定,不是协议保留名):
  ```ts
  { name: 'reply',
    inputSchema: { type:'object',
      properties: { chat_id:{type:'string'}, text:{type:'string'} },
      required: ['chat_id','text'] } }
  ```
  Claude 从进站 `<channel chat_id="...">` 取 `chat_id` 回传给 `reply`。工具名/参数名完全由作者决定,Claude Code 不要求一定叫 `reply`。
- Claude 通过 channel 回复时,终端用户看到进站消息 + tool 调用 + 确认(如 "sent"),但**看不到回复正文** —— 正文出现在外部平台。

### 2.5 启用 / flag / 门禁

- **最低版本:Claude Code v2.1.80+**(确认)。权限转发(2.6)需 **v2.1.81+**。
- **`--channels`(正常启用 flag):** `claude --channels plugin:<name>@<marketplace>`,可空格分隔多个。研究预览期 `--channels` **只接受 Anthropic 维护的 allowlist 上的插件**(或组织 `allowedChannelPlugins`)。传非 allowlist 插件:Claude Code 正常启动,channel 不注册,启动时给提示。
- **注意:仅出现在 `.mcp.json` 不足以成为 channel —— 还必须在 `--channels` 里点名。**
- **`--dangerously-load-development-channels`(开发期绕过 allowlist,拼写已确认):**
  ```bash
  claude --dangerously-load-development-channels plugin:feishu@<marketplace>
  claude --dangerously-load-development-channels server:feishu   # 裸 .mcp.json server,无插件包装
  ```
  - 绕过是**逐条**的,跟 `--channels` 混用不会把绕过传染给 `--channels` 条目。
  - 只绕过 **allowlist**,不绕过 `channelsEnabled` 组织策略 —— `channelsEnabled` 关着时连这个 flag 也被挡。
- **settings.json(managed settings,管理员控,用户改不了):**
  | key | 类型 | 用途 |
  |---|---|---|
  | `channelsEnabled` | `boolean` | 总开关,必须 true 任何 channel 才投递;关着时连开发 flag 也挡 |
  | `allowedChannelPlugins` | `[{marketplace,plugin}]` | 开启后哪些插件可注册;设了就**替换**整个 Anthropic allowlist;只在 `channelsEnabled:true` 时生效 |
- **默认可用性:** Pro/Max 个人(无组织)默认可用,`--channels` 逐会话 opt-in;claude.ai Team & Enterprise **默认禁用**(管理员开);Console API key **默认允许**。
- **官方 vs 开发插件:** 默认 allowlist = `claude-plugins-official` 仓库里的 channel 插件。发布到自己 marketplace 的插件仍需 `--dangerously-load-development-channels`。

### 2.6 权限提示转发(v2.1.81+,可选)

- channel 声明 `capabilities.experimental['claude/channel/permission']: {}` 后,可在远端并行收到工具审批提示;终端对话框和远端同时活,先答的赢。
- 覆盖 Bash/Write/Edit 等工具审批;**不**转发 project-trust / MCP-server consent(那些只能终端)。
- 出站:`notifications/claude/channel/permission_request`,`params`:`request_id`(5 个 a–z 小写字母,**排除 `l`**)、`tool_name`、`description`、`input_preview`(≤200 字符)。
- 入站裁决:channel 发 `notifications/claude/channel/permission`,`params`:`request_id` + `behavior`(`'allow'`/`'deny'`)。
- 文档强烈建议:只有 channel 能鉴别发送者身份时才声明这个 capability —— 能回复的人就能批准工具调用。

---

## 3. 现成参考插件(读过,不抄)

同级目录两个已有 Claude Code channel 插件,确认了上面协议在真实代码里怎么落地:

- **`/Users/dyzhu/Development/claude-plugin-feishu`** —— 一个**已实现的飞书 channel**(m1heng 那套),`server.ts` ~840 行单文件,`exploration.md` 已把 channel 骨架拆解清楚。验证到的落地点:
  - capability:`new Server({name:'feishu'}, { capabilities:{ tools:{}, experimental:{'claude/channel':{}} }, instructions:[...] })`(server.ts:446)。
  - 进站:`lark.WSClient` + `EventDispatcher.register({'im.message.receive_v1': handleInbound})` → gate 访问控制 → `mcp.notification({ method:'notifications/claude/channel', params:{content, meta} })`(server.ts:785)。
  - 出站:`reply` / `react` / `edit_message` 三个 MCP 工具 → `client.im.v1.message.create` / `.reply` / `.update`、`messageReaction.create`。
  - `meta` 实际用的键:`chat_id` / `message_id` / `user` / `user_id` / `ts` / `image_path`。
  - 取 bot open_id 用的是裸 `fetch`(`auth/v3/tenant_access_token/internal` + `bot/v3/info/`),因为 SDK 没暴露 bot info 方法。
  - 凭据从 `~/.claude/channels/feishu/.env` 读(`FEISHU_APP_ID` / `FEISHU_APP_SECRET`);access 状态在 `~/.claude/channels/feishu/access.json`。
  - **已知 bug(exploration.md C 节):** `server.ts` 无信号处理,`setInterval` + WebSocket 钉死 event loop,stdio 关闭不触发退出 —— 进程会残留。**我们从零写时要在一开始就处理优雅关闭**(监听 SIGTERM/SIGINT + stdio transport `onclose` → `clearInterval` + `wsClient` 断连 + `process.exit`)。
- **`/Users/dyzhu/Development/claude-plugin-weixin`** —— 微信 channel 对照,同一作者同套骨架,进站走 HTTP 长轮询而非 WebSocket,凭据靠扫码登录。对「channel 骨架 vs 平台特定」的边界有参考价值。

---

## 4. 信息缺口 / 待实跑确认

1. **SDK 版本号 `1.62.0`** 来自搜索快照(npm 页面对直接 fetch 返回 403)。锁版本前用 `npm view @larksuiteoapi/node-sdk version` 复核;长连接只要 ≥ 1.24.0。
2. **`app_access_token` 自建 endpoint** 的精确 body/响应是按飞书 auth 模型推断的,纯 bot 用不到;若真要用,核对 https://open.feishu.cn/document/server-docs/authentication-management/access-token/app_access_token_internal 。
3. **`emoji_type` 完整枚举** 没逐一抓全,实现 react 工具时从 emoji-introduce 文档拉全表。
4. **长连接 3 秒处理时限** 的精确重试次数/退避没在文档查到 —— handler 延迟按保守处理(重活异步)。
5. **MCP `initialize` 线级 JSON** 没有官方原文,只确认 `claude/channel` 走标准 `ServerCapabilities`;实跑时可抓握手报文确认。
6. **本轮全是静态调研,未实跑验证**:没真正启动一个带 channel 的会话验证 `claude/channel` 握手、没建过飞书长连接、没发过消息。下一轮写实现前/中,需要:
   - 注册一个飞书自建应用、开 Bot 能力、配长连接、拿到 app_id/app_secret 实测 token 与建连。
   - 用 v2.1.80+ 的 Claude Code 加 `--dangerously-load-development-channels` 实测 channel 握手与进出站。
7. **claudemux 集成方式未定**:新插件放 `plugins/feishu-channel/` 作为 marketplace 第二条目;是否让 `tm spawn` 自动给 teammate 拼 `--dangerously-load-development-channels` 是后续增强项,本轮不涉及。

---

## Hazard dispositions

> Appended 2026-05-21, after this snapshot was frozen, per
> [decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md).
> The snapshot body above is unchanged; this appendix is append-only.

This note is decision 0009's motivating document: §1.2 raised the fan-out
hazard, and that is the one that stalled.

### Cluster delivery, not broadcast — inbound events split across instances (§1.2)
**Promoted (retroactively).** Feishu delivers each inbound event to exactly one
of an app's connections. Crossed with claudemux's deployment model — one
Claude Code session per teammate, the plugin loaded once per session — a fleet
of teammates splits one app's inbound messages, and most never reach the
operator. This hazard was written as a platform fact and left the research
layer with no spec requirement, no decision, and no test. It surfaced as a
production bug and was fixed in `626c6b3` (single-instance lock plus a
parent-death watchdog) on branch `fix/feishu-channel-single-instance`. The
silent drop is the case that motivated decision 0009.

### The 50-connection-per-app limit (§1.2)
**Promoted** → the same `626c6b3` single-instance lock: one inbound WebSocket
per machine keeps a teammate fleet well under the limit.

### A `reply` routed by `message_id` can be redirected to an unrelated chat (§1.4)
**Promoted** → [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md):
the `reply` tool sends by `chat_id` and never derives the destination from a
`message_id`.

### A persistent WebSocket plus an MCP stdio server leaks on exit (§3)
**Promoted** → spec hard-requirement #3 →
[decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md)
(`ShutdownCoordinator`), guarded by `test/shutdown.test.ts`. This is the
hazard from the same document that travelled the full pipeline.

### The 3-second event-handler deadline (§1.2)
**Promoted** → satisfied by design: the inbound handler forwards via a
fire-and-forget `mcp.notification()` and returns immediately, so no handler
blocks near the deadline.

### Research-preview instability — `--channels` allowlist and protocol churn (§2.5)
**Out of scope** → an accepted, documented research-preview risk; the README
and the `configure` skill tell operators the feature is preview-grade. Nothing
in the plugin can prevent an Anthropic-side contract change.
