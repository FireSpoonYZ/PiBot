# Bot 统一活动、聊天队列抢占与手动停止（契约说明）

> **状态**：本文描述「Bot 活动 / 用户抢占 / 手动停止」语义与架构。文末是此前**限定范围**三端客户端验收记录，不涵盖本次 Webhook 停止同步、来源与状态修补；本次新增行为仍需父助手整合后的端到端验收，静态开发不等于运行验证。

## 统一活动模型（BotActivity）

同一 Bot 使用既有统一主会话：普通文本、工具续轮、群/DM 工作与后台轮都映射到同一组工作阶段，**不**为不同来源构造永不结束的 Agent。LIVE 状态新增可选 `activity` 字段（旧 busy/queuedCount 保留以兼容旧客户端，`activity` 是 UI 的统一依据）：

```ts
type BotActivity = {
  phase: 'idle' | 'queued' | 'preparing' | 'running' | 'compacting' | 'interrupting' | 'stopping' | 'stopped' | 'failed';
  source: 'primary' | 'room' | 'dm' | 'background' | null;
  scopeId: string | null;
  requestId: string | null;
  startedAt: string | null; // ISO 时间，未知为 null
  error?: { code: string; message: string }; // 仅 failed 的安全短诊断
  webhookStopPending?: boolean; // 任意 phase 可携带，等待中心确认 Webhook 停止
};
```

- 严格边界验证全部 5 个字段、枚举取值与有界 nullable 字符串；本机、远程、移动三端 wire 类型一致；不携带正文、凭据或工具参数。旧帧缺省 `activity` 合法，helper 按旧字段（busy/queuedCount/turnAdmission）回退，不新增公共控制方法、不改 `abort` 的外部请求形状。
- 活动选取优先级：Host 控制相位（interrupting/stopping）→ 实际 primary 运行（元数据取自 BotSessionState 当前冻结 turn / generation attribution，不从最新历史猜来源）→ 未完成工作的 pending / Host 队列相位（queued、checking/synchronizing=preparing、failed）→ 无未完成工作时，手停结果显示 stopped，否则 idle。
- work decisions 经 `setActivityListener` 向 live 发布**纯元数据**摘要（`{ pending: Array<{ requestId, kind:'primary'|'room'|'dm', scopeId, startedAt }> }`，只含存活 pending，不含 stopped/取消/错误终态）；不新增高频轮询、不用活动查询唤醒模型。live 把摘要中 `kind='primary'` 的续轮识别为 `source='background'`。
- `TurnAdmissionStatus.source?: 'primary'|'background'` 来自真实队头 origin；queued/preparing/failed 的 `activity.source` 沿用该来源，running 仍取冻结执行轮。原生 inbox 缺归属时回退 null，不猜 primary。旧 Host 可省略新字段。
- 可见工作状态与流式文本/工具名无关。failed 队头不永远转圈；stopped 明确显示「已停止」，不显示为已完成，也没有持续空闲动画；新的真实工作出现后旧 stopped 不再遮蔽。`stopped + webhookStopPending=true` 显示「本地已停止，中心待同步」；其他阶段保留当前真实工作提示并附「Webhook停止待同步」。该标记不增加 phase，也不单独将 Bot 算作忙碌或永久暂停。
- 忙碌判定：queued/preparing/running/compacting/interrupting/stopping 视为忙；可停判定：queued/preparing/running/compacting/interrupting/failed 可停（failed 是有待取消的失败受理，不是历史模型报错）；stopping/stopped/idle 不可停。

## 聊天队列与抢占范围

- **主聊天 FIFO 保留**：不合并 requestId、不抢占另一条直接用户主聊天；保持每轮集中准入（每轮一次中心准入，见「每轮集中插件同步」）。用户排队优先于 Host 自动事件，同类 FIFO；普通用户输入不自动抢占已经运行的 primary Webhook。W1 已运行、W2 排队、用户 U 后到时，顺序仍 W1 → U → W2。
- **用户优先准入**：直接用户输入持久化后，在准入前调用 `decisions.interruptBotWork(botId, { reason: 'preempted' })` 抢占**同 Bot 当前非用户来源**的 work（群/DM 工作、迟到续轮等）。`pending.turn.sender.kind='user'` 的群用户任务不被打断；Host 来源计划任务不触发抢占。Host 队列中用户条目优先于 host 条目（各自 FIFO）。
- **抢占执行**：进行中时 live 标记 `interrupting`，结束清空；不重复无意义取消，既有运行时 busy gate 保留。抢占只标记/取消已有非用户 pending，不动主聊天、不清 Host 用户队列、不设置 scope.stopped。
- **pending 中断标记**：work pending 新增 `interruption?: { reason: 'preempted' | 'user_stop', throughLocalId: number }`；submitPending/beforeRequest/publishWork/reconcile 全部尊重该标记；主动取消不写 generationError，结算区分 user_stop 与失败（不记 WORK_GENERATION_FAILED）。
- **抢占的水位语义**：`preempted` 不推进 handled 水位——待用户队列排空后按相同原始消息重新触发；已发布批次已把 `prepared.throughLocalId` 推进过其水位，重新触发不会整批重发；author/replyTarget/responseMessageId 全部保留。
- **工作 lane 协作**：`turns.admitWorkDecision` 在网络 await 之后、submit 之前、submit 之后都核对 `pending.interruption` 与 stopped，防止 stop/preempt 的迟到提交，不复活 pin/grant；停止 gate 内 canRunWork=false。`interruptBotWork` 自身不获取第二条 Bot admission lane，允许与在飞准入并发。
- **不移植 Grok zombie 超时并发放行**：取消确认前不允许另一轮争用同一 Bot 资源。

## 手动停止「停止此 Bot」（abort）

- 界面统一名称「**停止此 Bot**」：取消当前执行及停止之前已受理/在受理中的输入与已有工作积压；保留历史、附件与取消回执；**不**新增持久 Bot 禁用开关。停止之后新的用户输入允许新运行。
- `abort` 顺序：先立停止 gate → 持久取消未原生提交的条目 → `interruptBotWork(botId, { reason: 'user_stop', quiesce: centerOnline && !recoveryPending })` → 既有主会话取消 / 离线 abortTask 标记；成功后 `setBotControl(botId,'stopped')`，失败保留可见状态并抛错（取消失败可见，不伪装成功）。进行中的停止共用同一 Promise 防重复。
- `quiesce=false` 时只做持久标记 + abortSubmission/abortTask，不用会隐式 resume 的 conversation.abort/wait。
- **停止 epoch（stopEpoch / stopPending）**：`runtime.submit` 在任何 await/排队前捕获该 Bot 的 stopEpoch；入队持久化在同事务里核对 stopPending/旧 epoch 并作废（保留 cancelled 回执），lane 中待执行的旧 submit 不会在 stop 后复活。停止后新的显式 submit 获得新 epoch。
- **消费边界**：user_stop 覆盖该 Bot 各 scope 的待处理积压（含尚未创建 pending 的消息）与已有 pending，把所停 scope 的消费边界推进到**此次停止捕获的 inbox 水位**，之后新到消息可正常唤醒；未绑定 scope 复用既有 ensureWorkBinding/账本查询确定水位，不吞掉较晚的新输入。
- **重传不复活**：pin commit / 提交前后都核对 cancelled，取消队列条目与空 pin 清理在**同一事务**完成；已取消 requestId 的重复重传保留 cancelled 终态、不当新请求执行，真正重发用新 requestId（UI 已有新发送 ID）。不保留旧复活逻辑。
- **停止按钮独立于发送**：草稿/附件存在时也可停；failed pending 可取消；stopping 有独立 state/disabled 防重，不被 action.busy、上传或草稿锁禁用；queued/preparing 同样可停。`onAbort` 的 Promise 被正确等待，失败经 ErrorNotice 呈现。
- **恢复语义**：重启/恢复调度时，先对带 interruption 标记的 pending 完成取消与结算，不再次 submit 被取消请求；preempted 的未推进水位与 user_stop 的捕获边界都持久保存。

### Webhook 停止同步与来源

- 本地停止与中心确认是两条边界：beginStop 持久提升 `stopEpoch` 并保存 `pendingWebhookStopEpoch`；本地取消结算只清本地 `stopPending`，不清待中心确认标记。离线不阻止本地停止后的新用户输入。
- 在线以中心确认停止的事务为事件边界；离线停止到中心确认之间收到的 Webhook 也取消。重启恢复待同步标记，重连先同步停止，再首次提交新 Webhook。中心确认后新到事件可执行，同代次重试不重复取消新事件；长期停止接收仍用入口停用开关。
- 中心 pending 直接取消，dispatching/queued/running 记录 `cancelRequested` 并显示「取消中」，等待 Host 真实回执结算；已 done 但回执丢失的事件仍保留 succeeded。终态优先于取消意图，非终态取消意图优先于准入失败，准入失败展示安全短诊断而不是普通等待。
- 新 Webhook 采用受信 Host `sender.sourceType='webhook'`，历史/live/UI 投影保留字段；旧历史只在展示层兼容 host + primary + `Webhook · ` 名称前缀。名称不影响调度，外部 payload 或普通用户输入不能注入 Host 身份。回答作者仍是实际 Bot，冻结回复目标不变。
- 中心 `succeeded` 显示「本轮完成」：仅 Webhook 初始提交轮结束，不承诺 `send_to` 等异步协作全部完成。后续结果在原聊天按 requestId/消息关联查看；HTTP 202 仅表示已接收。

完整接口与离线窗口说明见 [Webhook 使用说明](webhooks.md)。

## 「暂停此处工作」与「停止此 Bot」的区别

`stopWork` / `resumeWork` 仍是 scope 级的「**暂停此处工作 / 恢复此处工作**」：持久暂停该 scope 的自动工作，不因主聊天发新输入而解除，也不被即时「停止此 Bot」改变（user_stop 保留 scope.stopped 原值）。两者并存：停止是 Bot 级一次性取消当前积压，暂停是 scope 级长期开关。

## 客户端接入

- 共享 helper（`web/src/botActivity.ts`）：`resolveBotActivity`（有 activity 用 activity，否则按旧字段回退 busy→running、failed admission→failed、checking/synchronizing→preparing、queuedCount>0→queued、默认 idle）、`isBotActivityBusy`、`canStopBotActivity`、`botActivityText`（双语短文案，来源用短标签，不直出 scopeId 长串）。GrokBotWorkingSlot 加可选 `activity` prop，busy 仍以调用者 isBusy 为准（保留本地发送乐观态）。
- 移动端本机页与「其他设备」远端页同接 helper；恢复/离线沿用未知状态提示，不伪装工作中。
- 桌面端聊天工作槽覆盖排队/准备相位；自然完结与手停显示清晰区分；页面切换只关闭观察，不调用 abort。
- 群/DM scope 页面保留原 work 观察与原始历史；对选中可观察 Bot 增加 `kind='primary'` 只读订阅，仅取统一 activity/工作阶段显示「该 Bot 正在主聊天/其他对话工作」，按 source/scopeId 标注，不误称在本群工作、不混入 scope 历史；primary activity 尚未到达或旧 Host 时，不把旧 work idle 当真实 Bot idle。只读用户不可控制。

## 兼容性

- 兼容方向是单向的：**新客户端兼容缺少 `activity` 的旧 Host**（帧缺省时 helper 按 busy/queuedCount/turnAdmission 旧字段回退）；旧客户端/sidecar 的严格字段白名单会拒绝带 `activity` 的新帧（实测旧 Linux 已安装 sidecar 报 BAD_FRAME 断开），**升级新 Host 时应同步升级客户端及 sidecar**。协议 lane 只在 wire 边界严格验证，转发不丢 activity。
- `getWorkActivity` 外部接口保留、返回结构兼容；`lastDecision` 可复用 `aborted`，内部 reason 精确区分 `preempted` / `user_stop`。

## 边界说明

停止/抢占是**取消与结算**，不是回滚：已发布到群/DM 的消息、已执行的工具外部动作不可撤销，不夸大为可回滚外部已发生动作。

## 历史验收（父助手，限定范围已执行；不含本次 Webhook 修补）

- **环境**：Windows Tauri debug 客户端、Linux Tauri release 客户端（WebKitWebDriver/Xvfb 驱动）、probe36 Android API 36 x86_64 模拟器客户端，三端均连接**隔离的 Linux Host/中心**与真实 antigravity/gemini-4-argon-high 模型；使用专用验收 Bot/消息，证据在仓库外（Windows：`C:/Users/46040/AppData/Local/Temp/e-launcher-queue-e2e`，Linux：`/home/firespoon/e-launcher-queue-e2e`）。
- **已实测**：普通文本回复；Windows 带草稿点击停止，回执 aborted；Linux queued 状态取消且草稿保留；Bot DM 后台 sleep90 被用户消息抢占，约 5 秒回复 USER_PREEMPT_OK，旧 work outcome=aborted 且 error=null，用户回复后新 pending 按原消息继续；再次手停 scope 后 handled 水位推进、pending=null、不重驱动；群聊成员 UI 显示 Bot 正在主聊天/本群工作并可「停止此 Bot」；scope 暂停持久 stopped=true，同时主聊天请求 PRIMARY_WHILE_SCOPE_PAUSED 正常 done；Android 经 CDP 实际 UI 操作取消含队列的任务（queued 回执 cancelled、草稿保留），另以独立 ADB 屏幕点击「停止此 Bot」按钮复核；并发首批 2 条消息均 done；已取消 requestId 同 ID 重发及 Host 正常重启后仍 cancelled，scope 暂停仍为 true。
- **未覆盖**：崩溃中途强杀与存储故障注入、长压测、实体手机、Windows 本机 Host（UAC 未继续）。验收范围为三端客户端连同一 Linux Host。
