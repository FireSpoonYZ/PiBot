# Antigravity ACP Provider (`center-server/antigravity`)

`antigravity-acp`（模型 API `pibot-antigravity-acp`）采用**原生整轮架构**：每次用户轮次由 `agy acp` 通过单次 `session/prompt` 跑完整轮推理与工具编排；Center 维护隔离进程池与 `pibot-bridge` MCP 桥接；Host（Pi Durable）通过最小补丁只做界面投影和真实设备侧 `ToolTask` 执行。

## 整轮执行与 Pi Durable 接入

- [`host-core/patch-pi-durable.js`](../../host-core/patch-pi-durable.js) 仅补丁 `@earendil-works/pi-durable` 的 `generation.js`（`tool.js`、`submissions.js`、`live.js` 零改动）：
  - `prepare` 照常渲染 section（供增量计算），对 AGY 跳过压缩；
  - `request` 在 `beforeRequest` 后调用挂在 provider 上的 `runExternalTurn`（[`host-core/antigravity-runner.js`](../../host-core/antigravity-runner.js)），不进入 `streamResponse` / overflow 压缩 / Pi 工具循环；
  - 关闭 AGY 外部轮次的 restart 自动重试与 `classify` 自动重试；
  - 工具触发 `control.terminate` 时走 `finishExternalTerminate` 收尾，不调用创建后续 generation 的 `finishToolRound`。
- 每个来自 Center 的 `tool_request`，Host 在单事务中提交含真实 `toolCall` 的 `AssistantEntry` 并创建 `ToolTask`（owner 为当前 generation，`abandonOnRestart: true`），执行完成后读取真实 `ToolResultEntry` 并回传 Center。权限、Code Mode、`beforeTool`/`afterTool`、嵌套槽位和取消级联全部复用原有 `ToolTask`。

## Center 路由契约

契约定义见 [`center-contract/antigravity.js`](../../center-contract/antigravity.js) 与 [`center-contract/antigravity.d.ts`](../../center-contract/antigravity.d.ts)，路由实现位于 [`center-server/antigravity-routes.js`](../antigravity-routes.js)：

- `POST /api/host/antigravity/run`：流式返回 `application/x-ndjson`（`thought_delta`、`text_delta`、`usage`、`native_tool_start`、`native_tool_end`、`tool_request`、`turn_done`、`error`）。
- `POST /api/host/antigravity/tool-result`：按 `{ sessionId, runId, callId, content, isError? }` 交付 Host 工具结果（含标准 `text` 与 `image` 块）。
- `POST /api/host/antigravity/steer`：轮中追加原生 `session/prompt`（`{ sessionId, runId, sections?, routeNote?, inputs }`）。
- `POST /api/host/antigravity/cancel`：按 `{ sessionId, runId? }` 发送 `session/cancel`。
- OAuth 登录与模型目录（`/api/providers/antigravity-acp/*`、`discover`/`validate`）独立保留。

## 会话身份与单游标增量

- **身份链**：Host `ProviderDoc.sessionId` ↔ Center [`sessions.json`](./sessions.ts) 中 `(deviceId, sessionId) -> { conversationId, agentName }` ↔ `agy` 原生会话库。
- **新建与恢复**：仅空会话首轮或 `/clear`（轮换 `ProviderDoc.sessionId`）调用 `session/new`，且在首条 prompt 前持久化映射。热轮直接复用存活连接发送 `session/prompt`（不调 `session/load` / `session/resume`）；冷启动通过 `session/resume` 恢复并重设 `model` 与 `thought_level`。原生会话确认丢失或旧会话缺少新游标时，返回 `AGY_HISTORY_CHANGED` 要求一次性 `/clear`。
- **单游标（`AntigravityCursorDoc`）**：Host 在写出 `/run` 或 `/steer` 之前推进唯一游标 `dispatchedThrough`，仅发送游标之后的新输入、本轮图片与可选 `<turn-routing>`。
- **动态 section 增量**：复用 `SystemEntry` changed-key，变更以 `<context key="...">`（移除为 `<context key="..." removed="true" />`）前缀发送一次。SOUL 创建 custom agent 时写入 `initialSystemPrompt`，后续变更走 section 增量；[`plugins/tasks/context-projection.js`](../../plugins/tasks/context-projection.js) 过滤 `bot.online` 抖动。

## 工具、图片与权限

- **Code Mode only**：顶层声明 `codemode` 与已启用 model-only 工具；普通工具在 `codemode` 内发现和调用。
- **连接级 MCP Token 与 run 校验**：每条原生连接分配一个本地回环 MCP token；`tools/call` 请求进入时先捕获当前 active run 引用，派发前校验引用一致。无 active run 时的拒绝只返回普通 MCP 错误，不毒化连接 token。
- **150s 慢工具升级**：工具挂起满 `150_000ms` 时向模型返回带 `callId` 的 `STILL RUNNING` 确认，模型可调用只读 `bridge_poll_result({ callId })` 继续等待同一调用（绝不重跑工具、不合成 user prompt）。
- **工具图片**：直接通过标准 MCP `image` 块回传（含 `bridge_poll_result`），无需额外 hook 旁路。
- **ACP 权限与原生工具**：ACP `session/request_permission` 一律自动放行（`fs/*` 与 `terminal/*` 仍拒绝）；不拒绝 `agy` 残留的原生工具（`manage_task`、`list_resources`、`read_resource`），非 bridge 调用仅按 ACP `tool_call` 通知以 `native_tool_start` / `native_tool_end` 展示。

## 模型切换、Steer、停止、问卷与禁用项

- **模型切换**：全局与单 Bot 模型切换始终放行（不再因设备离线或存在历史对话禁止切模）。同会话支持 AGY 模型间直接切换（`set_config_option`）；非空会话跨服务商切换（非 AGY ↔ AGY）后，Host 拒绝继续原对话并返回 `AGY_HISTORY_CHANGED` 要求 `/clear`（或切回原服务商模型继续）。
- **Steer**：轮中发原生 `session/prompt`；仅在最后一个在途 prompt 结算时发出 `turn_done` 并合并 `usage`。
- **Stop**：Host 中止本地工具 → Center 报错结束挂起 MCP 调用 → 发送 `session/cancel` 等待终态，不杀进程不删会话（仅超时才杀进程，仍保留会话供冷 `session/resume`）。
- **问卷（`ask_user_question`）**：主聊并发与非主聊场景统一通过 `control: { terminate: true }` 结束本轮，答案作为下一轮输入。
- **明确禁用**：Hindsight `autoRecall`（保留 `autoRetain`、bank 与显式记忆工具）、Billion Context、Pi 压缩（`/compact` 提示 `/clear`）、历史编辑/回退/fork、非空会话跨 provider 继续原对话。

## 隔离、部署与源码索引

- 隔离目录默认为 `<CENTER_DATA_ROOT>/antigravity/gemini`（可通过 `PIBOT_AGY_HOME` 覆盖，严禁指向 `~/.gemini`）与 `<CENTER_DATA_ROOT>/antigravity/workspace`；可执行文件由 `PIBOT_AGY_BIN` 指定（默认 `agy`）；子进程启动前剥离 `ANTIGRAVITY_*` 环境变量。部署、Dockerfile（`INSTALL_AGY=true`，`AGY_VERSION=1.5.12`）与网页 OAuth 登录说明见 [`docs/antigravity-center.md`](../../docs/antigravity-center.md)。
- 产品启动使用 [`openHostService`](../../host-core/host-service.js)（先启本机 Runtime / control HTTP，再经 `openDeviceLink` 接入控制通道）。
- 核心模块：
  - 契约与路由：[`center-contract/antigravity.js`](../../center-contract/antigravity.js)、[`center-server/antigravity-routes.js`](../antigravity-routes.js)
  - Center 桥接与 ACP：[`index.js`](./index.js)、[`mcp-bridge.ts`](./mcp-bridge.ts)、[`tool-waiters.ts`](./tool-waiters.ts)、[`sessions.ts`](./sessions.ts)、[`profile.ts`](./profile.ts)、[`vendor/acp/driver.ts`](./vendor/acp/driver.ts)、[`vendor/README.md`](./vendor/README.md)
  - Host 运行与策略：[`antigravity-runner.js`](../../host-core/antigravity-runner.js)、[`antigravity-provider.js`](../../host-core/antigravity-provider.js)、[`patch-pi-durable.js`](../../host-core/patch-pi-durable.js)、[`runtime.js`](../../host-core/runtime.js)
  - 插件适配：[`plugins/tasks/context-projection.js`](../../plugins/tasks/context-projection.js)、[`plugins/ask-user-question/entry.js`](../../plugins/ask-user-question/entry.js)、[`plugins/hindsight/entry.js`](../../plugins/hindsight/entry.js)
