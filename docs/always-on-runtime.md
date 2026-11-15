# Always-on Runtime：身份、交接与持久等待

本次重构从 `develop` 的 `f8593e40cf0d963dd55496f598fad044f0c3c8ad` 切出独立分支
`refactor/always-on-runtime-20261115`；交付前已合入随后新增的 `develop@efec5522ce27a41cd29af0c38bcc25c114bac1fc` 并重新完成全量测试。目标是让每轮执行有可追踪的输入、让定时交接可恢复、让等待用户的工作释放 Bot，并控制每轮任务上下文的大小。运行验收单独记录在 [验收记录](always-on-runtime-validation.md)。

## 文章与 PiBot 的对应关系

William Hu 于 2026-11-13 发布的 [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents)
把持续在线体验解释为一连串由事件唤醒的有限运行。每轮在 Session 中工作，保存状态后休眠；用户稍后的回答也作为新事件继续工作。文章提出事件收件箱、定时器、记忆、权限、发件箱五个基础组件。

PiBot 已有这些组件的大部分基础。本次采用下表中的归属，继续由 Pi Durable 管理模型运行、工具执行和原生恢复。

| 组件 | PiBot 的事实来源 | 本次调整 |
| --- | --- | --- |
| 事件收件箱 | `TurnQueue`、SDK submission、scope `MessageLog`、Center Webhook/任务派发 | 统一投影输入身份与运行身份；沿用 Bot 准入和幂等请求 |
| 定时器 | Host 或 Android 的 `schedules.sqlite` | 持久化一次到期事件向 Runtime 交接的输入与停止代次 |
| 记忆与任务进度 | SOUL、Hindsight、Center GlobalTask、会话历史 | 任务提示改为有焦点、有上限的视图，完整事实继续按需查询 |
| 权限与等待 | Center 能力策略、TurnPin、Vault、问卷插件 | 问卷以独立持久记录等待；回答通过原准入路径恢复 |
| 发件箱 | 现有跨 Host 消息账本、发送及 ACK 流程 | 保持送达与执行状态分离；用户通知节流留待后续 |

文章建议按工作选择新建或恢复 Session。PiBot 此次继续使用每 Bot 一个统一主 Session，以保留现有聊天与协作归属；通过 Run 身份、可信路由和上下文投影缩小每轮关注范围。它没有实现按任务自动拆分 Session。

```mermaid
flowchart TD
  Timer["持久定时器"] --> Handoff["冻结输入与 stopEpoch"]
  Handoff --> Queue["Host 准入与 SDK submission"]
  Input["用户、Webhook、协作事件"] --> Queue
  Queue --> Run["Pi Durable Run"]
  Run --> Wait["持久问卷等待"]
  Wait --> Answer["回答落盘与幂等续接"]
  Answer --> Queue
  Run --> State["任务、记忆与输出状态"]
```

## 身份与状态的归属

| 概念 | 身份或权威 | 生命周期与含义 |
| --- | --- | --- |
| Bot | `deviceId + botId` | 能力、准入和停止边界 |
| Conversation | 主会话 UUID 与 SDK 数字 ID 的映射 | 保存多轮消息及工具历史 |
| Event | `eventId`、`requestId`、可选原生 `submissionId` | 一次输入的去重和关联；一个 Run 可以消费多个输入 |
| Run | SDK `LiveRun.first` 对应的逻辑锚点 | 跨 generation handoff 保持身份；SDK continue 可沿用同一锚点 |
| SDK execution | `nativeTaskId`、`sdkExecutionId` | 当前 generation/attempt；handoff 后可能变化 |
| GlobalTask / Step | Center 的 `taskId`、`stepId`、执行版本 | 长期业务进度；仅由可信派发上下文绑定 |
| Wait | `botId + installationId + conversationId + requestId` | 问卷与回答；独立于已经结束的工具任务 |
| Delivery | 原消息与送达回执 | 已存储或 ACK 只说明交付进度 |

`runtime-execution-context.js` 提供纯投影函数；`sessions.getRunContext(api, context, {dispatchContexts})` 从当前 SDK run 和其实际输入读取事实。逻辑 ID 为 `run:${JSON.stringify([deviceId, nativeConversationId, first])}`；`first` 不是正安全整数时 `runId` 留空，跨 handoff 的读取不一致则不返回上下文。所有输入的 request/submission 身份都保留；冻结轮中的旧 `taskId` 表示 SDK 任务，不能据此推断 GlobalTask。

执行投影使用 `accepted / queued / running / waiting / completed / failed / cancelled`。
原生终态回执优先于过时的等待提示；`waiting` 需要与本次请求匹配的有效等待记录。新问卷结束原生 Run 后，原生执行可以是 `completed`，而独立 Wait 仍是 `pending`。看板需同时表达“需要用户回应”和当前 Bot 的执行活动，等待本身不占用准入。

相关实现：[执行协议](../host-core/runtime-execution-context.js)、[会话来源](../host-core/runtime-bot-session.js)、[统一主会话](bot-sessions.md)。

## 定时交接与停止边界

到期 occurrence 先向 Runtime 取得停止代次，再将以下内容写入自己的持久记录，完成后才可提交：

```js
handoff: {
  version: 1,
  state: 'pending', // 收到合法受理回执后变为 accepted
  input: { requestId, text },
  stopEpoch,
  // acceptedAt: 首次受理时间
}
```

Host 与 Android 采用相同顺序：冻结交接 → 查询原回执 → 确认缺失后补投同一请求 → 持续对账。恢复时重新查询，进程内的“已查明缺失”标记不跨重启保存。

| 观察结果 | 调度器处理 |
| --- | --- |
| 有有效 `pending` 交接，回执明确缺失 | 使用冻结的 `requestId/text/stopEpoch` 补投 |
| 超时、断线、空对象、身份不匹配或畸形回执 | 保留不确定状态，继续查询 |
| 合法 `queued + submissionId:null` | 已在 Host 持久受理，标记 `accepted` |
| 合法 `unanswered/cancelled + submissionId:null` | 已有取消回执，结束交接 |
| 已 `accepted` 或已有旧版受理证据，后来查询缺失 | 继续对账，不再补投 |
| 旧版不确定提交没有冻结交接 | 只查询回执 |
| 重启时未捕获交接的错过 occurrence | 沿用 `skipped_offline` 策略 |
| 已终态记录收到迟到结果 | 保持终态 |

Node 内部查询以显式 `null` 表示缺失；Android IPC 还接受明确的 `SUBMISSION_NOT_FOUND/responded`。缺少 `submissionId` 字段不等同于显式 JSON `null`。

`getScheduleFence` 与 `submitScheduled` 只用于可信 Host/Java 调度桥，不加入公开 HTTP/control 协议。Runtime 强制 Host 来源，拒绝未来代次。用户 Stop 推进持久停止代次，旧交接仍携带旧值，`TurnQueue` 在受理事务中将其作废；恢复时不会重新捕获一个新代次来使旧任务继续运行。

这提供跨库交接的幂等恢复。外部工具的业务副作用仍依赖该工具自身的幂等能力，不能由 submission 去重推导出外部系统恰好执行一次。

相关实现：[Host 调度](../host-core/host-schedules.js)、[Android 调度](../app/src/main/java/com/example/launcherprobe/BotHostSchedules.java)、[Runtime 准入](../host-core/runtime-turns.js)。

## 持久问卷与续接

新问卷把问题、展示内容、原始冻结轮、可信派发上下文和停止代次保存到 session 作用域的 `host.durable-wait` 文档；`host.durable-wait-index` 保存每 Bot 的活动索引。索引最多容纳 64 个等待及未结算续轮。已受理的续轮继续留在索引中，直到 SDK 回执为 `done/unanswered`；终态历史仍可按身份读取。

问卷工具只在该模型轮唯一直接工具调用时创建新 Wait，并通过 SDK 的 `control.terminate` 结束该轮。多工具轮和新的嵌套 codemode 调用返回明确错误，不建立等待。固定 SDK 只有在同轮所有工具都要求结束时才结束 Run，这一约束保证等待用户期间释放 Bot；它目前不是通用的任意工具暂停机制。

| Wait 状态 | 含义与后续行为 |
| --- | --- |
| `pending` | 等待首次有效回答；卡片可答 |
| `answered` | 回答已持久化；冻结续接输入，等待受理或已受理 |
| `cancelled`, `reason:user` | 用户拒答；仍投递拒答结果，让模型知晓 |
| `cancelled`, `reason:stopped` | Bot/频道停止、清理或历史切换；关闭等待并取消对应续轮 |

续接另有 `pending / accepted / cancelling / cancelled` 状态。回答动作先提交结果及不可变文本，再查询续接回执；仅尚未受理且明确缺失时用固定续接 requestId、原 stopEpoch、原 replyTarget 和派发上下文补投。首个有效答案胜出，重复点击不会重复启动新工作。`accepted` 后查询缺失只继续对账；`receiptStatus/finishedAt` 是 SDK 回执的观察结果，不形成第二套执行权威。

取消先持久写入 `cancelling`，精确取消对应 requestId 后才退出活动索引。进程退出或取消回执丢失时，冷启动的 `recoverCancellations()` 在 Harness 恢复和队列准入之前完成取消；失败阻止恢复，离线及归档 Bot 也执行这一步。TurnQueue 在入队事务和最终 SDK 提交事务中都校验 Wait，防止已经排队的旧续轮越过取消。

频道停止在同一事务设置 `stoppedScopes` 发布门并取消匹配等待，只影响原冻结 scope；显式恢复频道才清除此门，旧问卷不复活。远端频道墓碑也走统一 `stopScopeWork` 回调。清空历史、归档和删除清理对应等待；编辑历史在切换原生会话映射的同一事务取消旧会话等待，失败时一起回滚。上述清理不通过推进整个 Bot 的停止代次来误伤其他频道。

UI 的可答性由 Host 查询 Wait 并核对真实工具 taskId 后投影。历史工具结果本身不拥有可答权限；原工具任务已经结束也不能单独证明问卷已处理。Host 覆盖当前 details，并只对有效待答记录在工具/工具结果顶层标记 `durableWait`，不采信 details 中的自声明。Live 的 `durableWaits` 提供至多 64 个完整活动身份，使窗口外的问卷仍可答；回答或停止后从集合移除，缓存卡立即只读。新用户消息可在同一 Bot 上继续执行，等待提示不遮蔽新的运行；Bot 忙闲仍由 SDK 执行状态决定。

超过 256 KiB、使用字节偏移分块的巨大历史条目保留不可变序列化，避免回答时改写后续 chunk 偏移。标准问卷 presentation 的上限为 48 KiB；窗口外卡片的完整最终答案在下次读取历史时补齐。

旧版 `e-launcher.ask-user-question` task 作用域记录继续原等待和回答协议。若该 Bot 仍有存活的旧嵌套问卷，插件临时保留其调用路径以恢复旧任务，同时拒绝新的嵌套问卷；直接模型工具始终保持可见。

相关实现：[等待服务](../host-core/runtime-waits.js)、[问卷插件](../plugins/ask-user-question/entry.js)、[Live 投影](../host-core/runtime-live-projection.js)。具体接线与测试结果以验收记录为准。

## 每轮上下文

`tasks` section 以 Host 的 `getExecutionContext(botId, conversationId)` 确定本轮任务焦点。Section 可能早于 `beforeRequest` 渲染，因此焦点从当前 live run 的可信输入解析；无法确认时展示有限概况。聊天文本与上一轮残留 `activeTurn` 都不能单独提供焦点或授权。

[任务上下文投影](../plugins/tasks/context-projection.js) 的上限是 **12,000 个 UTF-16 code units**，不是 token 配额。核心协作纪律完整保留，按以下顺序分配空间：本轮任务及待确认门槛、当前步骤、目标与近期结果、有限步骤、其他任务摘要、Bot 目录。数量上限分别为焦点步骤 8 个、近期结果 2 个、其他任务 8 个、目录 Bot 6 个；字符预算还可能进一步减少数量。

省略数量明确展示，截断保持 Unicode 完整。角色权限取自 Center 的协调人和步骤归属，省略不会改变批准、依赖或完成状态；执行前仍可用 `task get/list` 读取完整事实。原始历史和 Center 数据不被裁剪。SDK 自动压缩及现有 RequestContext 最终预算守卫继续工作。

## 升级与回滚

1. 升级前停止 Host，并备份完整数据目录，包括 Durable、调度和消息数据库；SQLite 备份应包含一致的 WAL 状态。问卷和 Tasks 插件版本均更新为 `1.1.0`。新增 Live 字段与 `schedule/task_dispatch` 来源需要同步升级 Host、Center 和客户端；旧 Center 的严格校验器不接受新字段。
2. 新版首次恢复先处理未完成 Stop，再恢复 TurnPin 与等待交接。观察遗留问卷、定时 occurrence 和消息归属，不手动改写 requestId、受理证据或停止代次。
3. 旧版不认识新的持久 Wait，也不能展示其待答卡。存在新 Wait 时，先在新版中回答或停止并确认续接状态，再考虑降级。直接替换旧程序可能让记录暂时不可见，不能视作已完成。
4. 必须恢复升级前备份时，连同相应版本一起恢复，并核对备份之后的外部副作用及消息交付。数据库回滚不会撤销外部动作，不能承诺安全自动重放。

本分支的提交、文档和自动测试不代表已经部署或完成 Android 真机验收。

## 后续范围

用户通知的发送策略、节流与效果评估；按业务任务拆分上下文或 Session；统一费用/运行时预算；云端常驻 worker 和跨 Host 接管，均需独立设计与验收。当前跨设备执行仍受设备在线状态、Center 门禁与既有权限约束。
