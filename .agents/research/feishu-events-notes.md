# 飞书事件机制全貌调研(为 claudemux 飞书 channel 扩展事件接入)

> 只读调研。日期 2026-05-21。来源:飞书开放平台 open.feishu.cn / apifox 官方镜像 / 多个第三方生产实现交叉验证。
> 本期目标:在已有 `im.message.receive_v1` + reply 基础上,**接入文档评论事件**。

---

## 调研方法与可信度说明(重要)

飞书官方「事件列表」页(`open.feishu.cn/.../event-list`)是 JS 动态渲染的 `<md-event-list>` 组件,WebFetch 抓不到正文。因此本报告的事件目录来自:

- **apifox 官方镜像**(`feishu.apifox.cn/doc-1940221`)—— 一份**真实但可能略旧**的事件枚举,IM/Drive 等核心类别可信。
- **官方 API 参考页**(`open.feishu.cn/document/.../drive-v1/...`)—— 单个事件/接口页可抓,用于核对 payload 与 scope。
- **多个第三方生产实现**(OpenClaw `openclaw/openclaw`、NousResearch Hermes Agent)—— 用于交叉验证文档评论事件。

凡是**未能在官方页逐字核实**的字段,下文均显式标注「⚠️ 来源:第三方实现,未官方逐字核实」。**没有编造任何 event_type。**

---

## 一、飞书事件订阅全目录(按类别)

> 长连接说明见本节末尾。除「云文档」类有额外订阅要求外,其余事件在应用后台「事件与回调」勾选即可。

### 1. 通讯录 Contact

| event_type | 含义 |
|---|---|
| `contact.user.created_v3` / `contact.user.updated_v3` / `contact.user.deleted_v3` | 员工入职 / 信息变更 / 离职 |
| `contact.department.created_v3` / `contact.department.updated_v3` / `contact.department.deleted_v3` | 部门增 / 改 / 删 |
| `contact.scope.updated_v3` | 通讯录授权范围变更 |
| `contact.custom_attr_event.updated_v3` | 自定义字段变更 |
| `contact.employee_type_enum.created_v3` / `.actived_v3` / `.deactivated_v3` / `.updated_v3` / `.deleted_v3` | 人员类型枚举变更 |

### 2. 消息与群组 IM(本期已接 `im.message.receive_v1`)

| event_type | 含义 |
|---|---|
| `im.message.receive_v1` | **收到消息**(DM / 群)—— 已接入 |
| `im.message.message_read_v1` | 消息已读 |
| `im.message.recalled_v1` | 消息被撤回 |
| `im.message.reaction.created_v1` / `im.message.reaction.deleted_v1` | 表情回应 添加 / 移除 |
| `im.chat.updated_v1` | 群配置变更(群名、公告等) |
| `im.chat.disbanded_v1` | 群解散 |
| `im.chat.member.user.added_v1` / `.deleted_v1` / `.withdrawn_v1` | 群成员 入群 / 退群 / 被移除 |
| `im.chat.member.bot.added_v1` / `.deleted_v1` | 机器人 入群 / 被移除 |
| `p2p_chat_create` | 用户首次与机器人建单聊 |

### 3. 云文档 Drive(本期重点)

| event_type | 含义 | 备注 |
|---|---|---|
| `drive.file.edit_v1` | 文档内容被编辑 | 含多维表格字段/记录变更;file_type:doc/docx/sheet/bitable/slides |
| `drive.file.title_updated_v1` | 文档标题变更 | |
| `drive.file.read_v1` | 文档被阅读 | 高频噪音 |
| `drive.file.permission_member_added_v1` / `_removed_v1` | 协作者权限 添加 / 移除 | |
| `drive.file.trashed_v1` / `drive.file.deleted_v1` | 移入回收站 / 彻底删除 | |
| `drive.file.bitable_field_changed_v1` | 多维表格字段变更 | |
| `drive.file.bitable_record_changed_v1` | 多维表格记录增删改 | apifox 镜像未列,subscribe 接口文档提及 |
| `file.created_in_folder_v1` | 文件夹内新建文件 | 订阅文件夹时用 |
| **`drive.notice.comment_add_v1`** | **文档评论新增 / 回复** | **本期要接,详见第二节** ⚠️ |

⚠️ `drive.file.*` 系列事件需对**每个具体文档**额外调用「订阅云文档事件」API(`POST /open-apis/drive/v1/files/{file_token}/subscribe`)才会推送;不是应用后台勾选就全局生效。`drive.notice.comment_add_v1` 据第三方实现看是应用级订阅(与 `im.message.receive_v1` 同样在后台勾选),见第二节。

### 4. 多维表格 Bitable

多维表格的记录/字段变更走云文档事件 `drive.file.bitable_record_changed_v1` / `drive.file.bitable_field_changed_v1`(归在 Drive 类,需按文档订阅)。

### 5. 日历 Calendar

| event_type | 含义 |
|---|---|
| `calendar.calendar.changed_v4` | 日历变更 |
| `calendar.calendar.event.changed_v4` | 日程创建/修改/删除 |
| `calendar.calendar.acl.created_v4` / `.deleted_v4` | 日历共享权限 增 / 删 |

### 6. 审批 Approval

`approval.approval.updated_v4`(审批定义变更);以及实例事件 `leave_approvalV2`、`work_approval`、`shift_approval`、`remedy_approval`、`trip_approval`、`out_approval`(请假/加班/换班/补卡/出差/外出)。

### 7. 视频会议 VC

`vc.meeting.meeting_started_v1` / `.meeting_ended_v1` / `.join_meeting_v1` / `.leave_meeting_v1` / `.recording_started_v1` / `.recording_ended_v1` / `.recording_ready_v1` / `.share_started_v1` / `.share_ended_v1`,以及 `vc.meeting.all_meeting_started_v1` / `.all_meeting_ended_v1`;会议室 `vc.room.created_v1` / `.updated_v1` / `.deleted_v1`。

### 8. 其他类别

- **会议室** Meeting Room:`meeting_room.meeting_room.created_v1` / `.updated_v1` / `.deleted_v1` / `.status_changed_v1`。
- **服务台** Helpdesk:`helpdesk.ticket.created_v1` / `.updated_v1`、`helpdesk.ticket_message.created_v1`、`helpdesk.notification.approve_v1`。
- **任务** Task:`task.task.updated_v1`、`task.task.update_tenant_v1`、`task.task.comment.updated_v1`(注意:这是**任务评论**,不是文档评论)。
- **应用** Application:`application.application.created_v6`、`application.application.feedback.created_v6` / `.updated_v6`、`app_open`、`app_status_change`、`app_uninstalled`、`order_paid`、`app_ticket` 等。
- **智能门禁** ACS:`acs.user.updated_v1`、`acs.access_record.created_v1`。
- **历史遗留**(v1.0 旧格式):`user_add`、`dept_add`、`user_status_change`、`contact_scope_change`。
- ⚠️ apifox 镜像未覆盖**招聘(hire)、邮箱(mail)、人事(CoreHR)、电子表格(sheets)** 等较新业务线的事件 —— 这些在官方实时列表里存在,本报告未逐一展开(本期不需要)。

### 长连接(WebSocket)模式能否推送这些事件

官方「使用长连接接收事件」文档里,长连接的**唯一限制**是:

> 长连接仅支持企业自建应用;商店应用须用「将事件发送至开发者服务器」。

**没有按事件类型的限制** —— 应用订阅了什么事件,长连接就推什么,IM / 云文档 / 评论事件都能走长连接。现有飞书 channel 用的 `lark.WSClient` 即长连接,无需公网回调。云文档类事件的额外要求是「需按文档调 subscribe API」,与传输方式(长连接 vs HTTP 回调)无关。

---

## 二、文档评论事件详解(本期要接)

### 精确 event_type:`drive.notice.comment_add_v1`

⚠️ **来源与可信度**:此 event_type 在 apifox 事件列表镜像中**未出现**;官方事件列表页 JS 动态渲染,WebFetch 无法加载正文,故**未能在官方页逐字核对**。但它被**多个独立的第三方生产实现一致使用**:

- OpenClaw 官方飞书 channel(`openclaw/openclaw` 仓库 `docs/channels/feishu.md`)
- NousResearch Hermes Agent 飞书集成(GitHub Issue #11465 + 用户指南)

两处独立实现都订阅 `drive.notice.comment_add_v1` 来接文档评论,交叉印证它是真实事件。**建议落地前在飞书开放平台应用后台「事件与回调」里搜索确认该事件确实可勾选**(后台搜不到 = 不能用,以后台为准)。

### 触发条件

事件体里有 `notice_type` 字段区分子类型(⚠️ 来源:第三方实现):

- `add_comment` —— 新增评论(全文评论 或 局部选区评论)
- `add_reply` —— 在已有评论串里新增回复

第三方实现的路由逻辑只处理这两类,并额外过滤:跳过机器人自己发的评论、跳过没 @ 到机器人的评论。**「解决/恢复评论」似乎不在此事件覆盖范围内**(第三方实现未处理)。

### payload 结构

⚠️ 字段名来源:第三方实现描述,未官方逐字核实。事件体大致包含:

- **谁评论的**:评论者的 user identity(open_id 等)
- **评论内容**:评论文本
- **挂在哪**:文档的 token、file_type、标题、URL
- **评论位置**:是全文评论(`is_whole`)还是局部选区评论(带 `quote` 选中文本)
- **评论标识**:comment_id;若是回复则带 reply_id
- 评论串上下文(用于机器人读取整个 thread)

精确字段建议以「接入时实际收到的事件 JSON」为准 —— 飞书 v2.0 事件带 `schema` 字段、`header`(含 `event_type`)+ `event` 两段结构。

### 评论对象本身的结构(来自官方 file-comment API,**已逐字核实**)

读取/补全评论详情时用 `GET /open-apis/drive/v1/files/{file_token}/comments`,评论对象字段:

- 评论:`comment_id`、`user_id`、`create_time`、`update_time`、`is_solved`、`solved_time`、`solver_user_id`、`quote`(局部评论选中文本)、`is_whole`(全文/局部)、`reply_list`(分页:`has_more` / `page_token`)
- 回复:`reply_id`、`user_id`、`create_time`、`update_time`、`content.elements[]`
- 内容元素类型:`text_run`(纯文本)、`docs_link`(文档链接)、`person`(@ 提及,带 user_id)

来源:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/list

### 所需权限 scope

⚠️ 评论事件本身的订阅 scope 未官方逐字核实;以下为第三方实现申请的 scope,其中 `docs:document.comment:*` 系列已被官方 file-comment API 页确认为真实 scope 名:

- `docs:document.comment:read` —— 读评论(官方 file-comment/list 页确认)
- `docs:document.comment:create` / `docs:document.comment:write_only` —— 发评论/回复(用于出站)
- `drive:drive.metadata:readonly` —— 读文档元信息(标题/类型)
- `docx:document:readonly` —— 读文档正文(机器人要「看懂」文档时)
- 评论 API 也接受粗粒度 scope:`docs:doc`、`docs:doc:readonly`、`drive:drive`、`drive:drive:readonly`

### 长连接能否推送

能(强证据,非官方明文)。理由:(1) 长连接对事件类型无限制(见第一节末);(2) OpenClaw / Hermes 的飞书集成都把 `drive.notice.comment_add_v1` 与 `im.message.receive_v1` 一起订阅,而这类飞书 channel 普遍用长连接(`lark.WSClient`)。两者同一套订阅、同一条连接,评论事件随长连接推送。

### 怎么回复一条评论(出站 API)

飞书云文档评论的官方 API(已逐字核实端点):

- **新增全文评论**:`POST /open-apis/drive/v1/files/{file_token}/comments`(query 带 `file_type`),body 为 `reply_list.replies[]`,每条 reply 的 `content.elements[]` 支持 `text_run` / `docs_link` / `person`。
- **在已有评论串里回复**:`drive-v1/file-comment-reply` 命名空间(create / update 回复)。
- 出站 scope:`docs:document.comment:create` 或 `docs:document.comment:write_only`(或粗粒度 `docs:doc` / `drive:drive`)。
- 第三方实现做法:局部评论用「在该评论串回复」,失败回退到「发全文评论」;回复文本按 ~4000 字分块。

来源:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/create

---

## 三、建议接入清单

> 判断准则:channel 事件应是「值得占用一个 Claude 回合去 react 的信号」。多 channel 事件汇入同一条串行队列(见 `multi-channel-notes.md`),**接噪音事件 = 堵队列、烧回合**。所以只接「直接请求型」信号,不接「状态同步型」firehose。

### 本期接入(确定)

| event_type | 理由 |
|---|---|
| `im.message.receive_v1` | 已接。用户直接对话,channel 的核心。 |
| `drive.notice.comment_add_v1` | **本期目标**。文档评论是典型「非聊天外部信号」—— 有人 @ 机器人评论文档,正是要插进 Claude 上下文让它 react 的事。出站可回评论,形成闭环。**落地前先在应用后台确认该事件可勾选。** |

### 下一步可考虑(非本期)

| event_type | 理由 |
|---|---|
| `im.message.reaction.created_v1` | 表情回应可当轻量信号(用户用 👍/❓ 给指令),量小,值得后面接。 |
| `im.message.recalled_v1` | 用户撤回消息时让 Claude 知道「刚才那条作废」,小而有用。 |

### 不建议接(噪音 / 非 react 型)

- `drive.file.edit_v1` / `drive.file.read_v1` / `drive.file.bitable_record_changed_v1` —— 文档编辑/阅读/表格记录变更是高频 firehose,单条不值得一个回合,会把串行队列冲垮。
- `drive.file.permission_member_added_v1` 等权限事件、`im.message.message_read_v1` 已读事件 —— 状态同步,不需要 Claude react。
- 日历 / 通讯录 / 视频会议 / 审批 / 服务台 —— 除非有明确工作流需要,否则与「channel = 把信号插进会话」无关。
- `im.chat.*` 群成员/配置变更 —— 运维型,不接。

**一句话准则**:接「有人在叫 Claude」(消息、评论、@提及、回应),不接「系统在记账」(编辑、已读、记录变更、权限同步)。

---

## 附:关键文档 URL

- 事件概述:https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM
- 事件列表(JS 动态页):https://open.feishu.cn/document/server-docs/event-subscription-guide/event-list
- 事件列表(apifox 可读镜像):https://feishu.apifox.cn/doc-1940221
- 长连接接收事件:https://feishu.apifox.cn/doc-7518429
- 订阅云文档事件 API:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/subscribe
- 文档编辑事件 `drive.file.edit_v1`:https://open.larkenterprise.com/document/server-docs/docs/drive-v1/event/list/file-edited
- 获取评论列表 API:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/list
- 添加评论 API:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/create
- 文档评论事件第三方参考(OpenClaw):https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md
- 文档评论事件第三方参考(Hermes Agent Issue):https://github.com/NousResearch/hermes-agent/issues/11465

---

## Hazard dispositions

> Appended 2026-05-21, after this snapshot was frozen, per
> [decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md).
> The snapshot body above is unchanged; this appendix is append-only.

### `drive.notice.comment_add_v1` could not be confirmed against Feishu's own docs (§二)
**Promoted** → [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md):
the doc-comment handler decodes defensively, never throws, and logs an
unrecognized-payload note; the README and the `configure` skill tell operators
to confirm the event in their app console before relying on it.

### Noise events would flood the single serial session queue (§三)
**Promoted** → the spec's event scope (this round: chat messages plus document
comments only) and the registry design in decision 0006. The "only
react-worthy signals" rule keeps high-frequency `drive.file.*` events off the
queue.
