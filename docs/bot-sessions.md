# 统一 Bot 主会话（Unified Bot Session）

本文档记录「每个 Bot 一个统一主 Session」模型的实际实现。用户私聊、Bot 私聊与普通群聊
消息进入同一个 Durable 主会话（primary），模型看到的是带可信来源标注的连续上下文；
scope 消息账本（MessageLog）仍是消息事实的唯一权威，主会话是执行面。

## 模型

- **执行**：每 Bot 仅 `primaryConversationId` 映射的 ownerless 主会话承接全部生成任务。
  `PrimaryIndex` 映射与既有主会话数据原样保留；`botConversations()` 继续返回
  primary + 全部 work 绑定会话（忙闲检查、重置前清理、abort 的口径不变）。
- **协调**：`WorkIndex` / `WorkContextState` 与既有 work 原生会话保留为按 scope 的
  协调状态与旧历史；`binding.nativeId` 的含义不变（协调/旧存储 ID）。新建的 pending
  工作记录额外写 `executionNativeId` / `executionConversationId` 指向主会话；
  升级前已存在的 pending 记录保持原执行目标直到完结/取消，不双执行。
- **串行**：同一 Bot 的用户排队轮与工作决策轮共享 admission/准入边界与 Bot FIFO，
  不同时发授权；不同 Bot 之间互不影响、可并发。
- **SOUL**：scope 专属持久指令不写入主会话 AgentDoc；scope 工作策略是轮级
  （turn-scoped）上下文，随冻结轮注入。

## 来源、身份与路由

- 每条导入消息在主会话中是 `host.scope-message` 条目：`data.message` 为账本原文，
  `data.attribution` 为安全投影（kind、botId、deviceId、channel、scopeId、messageId、
  replyTo、category、direction、createdAt）。模型输入以 JSON 序列化并明确标注来源；
  名称只做展示，消息正文永不是 Host 权威来源。
- 每个实际原生输入带自定义来源条目：已鉴权 HTTP/control `submit` 与计划任务都在
  主会话提交 `host.user-message`（`data.requestId` / `data.turn` 稳定）；`turn.sender.kind`
  只由可信边界写 user 或 host，wire 自带的任意 origin/author 字段绝不采信；缺席
  origin 的遗留队列条目按 host 记，但仍有稳定 `requestId`/`turn` 元数据。
- 冻结轮（frozen turn）在 Host 侧完整保留 `requestId`/`taskId`/`kind`/`scopeId`/
  `sender`/`replyTarget`、权限、回复关联与账本状态不变；`sessions.getTurn` 只对匹配
  的当前任务返回，`workNativeId` 仅内部使用，不出现在 UI/公开元数据。持续冻结并归档
  每一轮的原因是：对端同伴的迟到回复会在原轮结束后经账本唤醒新一轮，Host 必须依赖
  持久冻结轮与 `replyOrigin`/`responseMessageId` 关联把迟到回复准确续接回原始
  `primary` 或发起 scope 的 `replyTarget`，并执行成员与 stale-input 校验，而不依赖
  模型正文或摘要。
- 模型侧轮级路由采用紧凑默认策略（借鉴 Grok 风格将普通主会话设为静默默认、仅非默认
  来源附带简短指引的思路，不宣称或复制其内部实现）：普通人类发起且 `replyTarget` 为
  `primary` 的轮次不生成合成路由消息，直接按静态行为指令作为常规主会话回复（无通用
  显式发布工具，不改主会话流式输出、已存储历史或路由校验）；其他来源/目标（同伴 DM、
  room、同伴回复续接回主会话、Host/定时触发）由 Host 生成瞬态 `SystemMessage`
  （`content: ''`、`sections: { 'host-turn-routing': <短说明> }`、`timestamp: 0`，
  不含其他 section 或工具），在插件完成最终上下文投影后**前插**到最终 `messages` 头部，
  永不作为 `user` 消息追加，也不写入持久化历史。该说明只含来源/行为与默认去向类别，
  不暴露 `requestId` 或原始冻结轮 JSON；传输继续沿用同一 JSON `messages` 封包，不从
  旧版文本前缀猜测可信元数据，完整行为由 Host 与 Center 成对更新协同生效。
- 对外发布（统一 `send_to` 与 scope publication）继续以冻结轮的受信 `replyTarget`
  与 stale-input/member 校验为准，不新增发送工具。调用 `send_to` 时若省略 `scopeId`，
  Host 会解析为当前轮已校验的 DM/room `replyTarget`，同时继续支持显式传入 `scopeId`；
  peer/room 轮的普通助手文本不会自动发给用户或对端。
- 外发 request 类消息经 `sessions.recordOutgoing` 记录原始回复去向；
  `sessions.markRepliesObserved` 记账已消费回复水位，未被消费的新回复才续接。

## 导入与水位

- `sessions.sync(botId)` 在调用方已持有 Bot 准入、处于安全边界的条件下，把该 Bot
  inbox 各 scope 自高水位之后的消息增量导入主会话（含 selfEcho 的自身发布），
  提交/追加/水位推进在同一原子节奏内，返回
  `{nativeId, conversationId, lastImportedLocalId}`。
- 用户主会话提交与 pending 工作准入都在解析安全空闲边界后、原生 submit 之前先 sync；
  Host 排队用户输入优先于后台工作。
- 新工作授予前先过 `turns.canRunWork(botId)`：排队的用户轮为显式优先（queued 即拦），
  且本 Bot 任一原生会话（含遗留 work 会话）仍忙时不发 grant。仅存在 background
  pending 记录不算原生忙/死锁。`admitWorkDecision` 在任何可能签发 grant 的中心调用
  前、以及所有 await（restore/sync）之后 submit 之前各复核一次；忙即保持 pending
  等下轮 poll，绝不把 grant 硬塞进忙会话。
- 打开视图/读历史只读账本与投影，绝不调度推理。
- Bot/room 消息与迟到回复按安全边界自动导入且恰好一次；通知与自回声成为上下文
  但不触发应答循环。

## 迟到回复、Reset 与旧行为

- **迟到回复**：`sessions.replyOrigin` 用外发请求的来源记账定位原始本地请求的
  replyTarget；未被消费的新回复可续接其原始渠道（主会话或发起 scope）。
  模型侧只有异步 `send_to`（DM/room 统一；回复关联由 Host 沿持久化
  `responseMessageId` 还原到原始请求消息——recordOutgoing/replyOrigin/
  冻结轮/触发批逐跳传递，多层嵌套委派不回退到触发消息或其 replyTo），
  发完即结束本轮，对端应答经账本唤醒新一轮。同 DM 不同 request 消息
  不合批，各自续轮；room public 仍按 scope 合批。
- **Reset（/clear）**：先 `sessions.sync(botId)` 把未导入的账本消息推进水位
  （`lastImportedLocalId` 是 reset 唯一保留的导入边界），再 `conversation.reset()`，
  随后 `sessions.reset(botId)` — 账本导入水位、既有 ID/数据、回复回执与未决外发
  请求的来源记账全部保留（旧账本消息绝不重现，迟到回复仍可续接），只清理过期活动轮状态。
- **Compact**：沿用 SDK 默认自动压缩，包括阈值触发和一次 provider 溢出压缩重试；
  手动 `/compact` 追加来源/scope/未决请求的保留指令（`BOT_SESSION_COMPACT_INSTRUCTIONS`）。
  路由事实以 Durable 状态为准，不依赖摘要正文。
- **Scope Stop**：只取消所选 scope 当前请求及其所属任务，不中断其他 scope 或用户轮；
  释放 Bot 准入后唤醒用户队列。恢复 scope 时同样优先处理排队用户。
- **旧数据**：work 原生会话历史不删除；成员工作 API 继续可读旧历史，新的共享执行
  在主会话中呈现并带正确归属，不把其他 scope 的工作标成所选 scope。
  普通聊天记录只显示 `primary` 路径：普通人类 primary 轮以及同伴回复续接且
  `replyTarget` 为 `primary` 的生成与回复仍正常可见并保持原有流式体验；dm/room 归因
  的协作过程轮、scope 导入消息与 host 触发记录在普通主聊天中保持隐藏，仅在专门通信页
  与成员工作视图中可见。
- **离线**：`scopeHistory`/`getScopeMessage`/`getScopeMessageDelivery`/`getScopeState`/
  `listScopeStates`/`listScopeReplicas` 为纯本地账本读取，离线放行给被动浏览；
  scope 写路径仍受 Center 门禁。HTTP `OFFLINE_ALLOWED` 放行同一批被动只读
  scope 路由键（`/v1/scopes*` GET）及受理/回执/历史/取消路由，不写、不推理。

## 接线（runtime.js）

- `createBotSessionRuntime({host, getHarness, getMessageLog, context, getPrimary})`
  在准入队列之后、decisions 之前构造；`getMessageLog`/`getPrimary` 为惰性回调。
  `getPrimary` 与准入泵同口径：已映射直接返回，否则按当前 Center 模型选择与
  primary profile 创建并应用人格。
- `sessions` 注入 `createWorkDecisionRuntime`、`createWorkContextRuntime`、
  `createTurnAdmission`、`createCommunicationTools`。
- `GenerationTask.beforeRequest` 顺序：`sessions.beforeRequest`（冻结轮并在非默认
  来源/目标时构造瞬态 `host-turn-routing` `SystemMessage`）→ `decisions.beforeRequest`
  → `plugins.prepareContext` → RequestContext 计数 → `plugins.beforeRequest` →
  将瞬态 `host-turn-routing` `SystemMessage`（如有）**前插**到插件计算后的最终投影
  `messages` 头部；`cap-final-budget` 与 `decisions.checkBudget` 仍在最后。
- 生命周期：close 顺序不变（turns → decisions → bot lane 排空 → schedules/shower →
  workContexts quiesce → live → collaboration → harness/plugins 关闭），
  session 状态全部在 Durable 文档内，随 harness 关闭自然落盘；冷恢复走既有
  `restoreTurns`/pin 恢复，导入水位保证重启后不重复导入。

## UI 归属

执行身份、定时交接和独立待答问卷的增量约定见 [Always-on Runtime](always-on-runtime.md)。
其中 Run、SDK task、业务任务和等待记录分别拥有自己的生命周期，不能由聊天卡片状态相互推导。

- 后端 history/live 只在安全 schema 内投影 attribution；ChatTurn 增加可选
  attribution；scope 事件 UI 渲染原始消息正文与发送者/设备/渠道/回复归属；
  host 触发记录不渲染为普通气泡。

- 同名 Bot 显示短 ID，完整 Bot/设备 ID 可通过标题和无障碍标签读取；发送者设备取消息的 `sourceDeviceId`。
- 通信历史先显示最近一页，再向前加载；旧页不会改写增量读取游标，每页按整条消息返回。
- 成员工作面板默认收起，选择成员后打开；收起或离开页面会停止该面板的实时观察。
- 用户附件元数据与来源标记同时保留；历史传输剥离内嵌图片字节后再计量和分块。
