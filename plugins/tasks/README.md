# Tasks — Host 受管内置插件

统一全局任务与步骤跟进插件（替代打包与新授权中的 `plugins/todo`；历史 `todo` 卡片呈现仍由宿主保留只读兼容）。npm 包名 `@e-launcher/tasks`，版本 `1.0.0`，能力 ID `e-launcher.tasks`，要求 Host API `^1.0.0` 和 Durable API `1.4.0`，无 npm 依赖，无配置项与凭据（config schema 为空对象）。

## 行为与接口

- **模型工具 `task`**（`replay: 'unsafe'`）：支持 `create`、`list`、`get`、`assign`、`propose_plan`、`ask_clarification`、`update`、`add_steps`、`update_step`、`complete`。
  - `assign`：供任务分派 Bot 或当前协调人指派/移交 `coordinatorDeviceId` 与 `coordinatorBotId`，提交前先 `get` 最新任务校验权限与 `expectedRevision`。
  - 角色隔离与 CAS：所有针对已有任务的变更均先 `get` 读取最新快照并携带 `expectedRevision`；普通执行 Bot 仅可通过 `update_step` 更新本人负责的步骤（及对本人受阻步骤发起 `ask_clarification`），不得调用 `propose_plan`、`update`、`add_steps` 或 `complete`；父任务 `complete` 仅允许协调人在无待回应提示且全部有效步骤为 `done` 时显式验收完成。
  - 需求变更采用（`adoption`）：支持 `adoptionPhase`（`recorded | adjusting | needs_scope | adopted`）、`scopeDesc`、`changeText` 与 `shortReceipt`，并在变更调整期保护已完成步骤成果且禁止通过 `propose_plan` 重复触发计划确认。
- **Center 透传门面 `host.tasks`**：通过 `host.tasks.invoke(botId, payload, conversationId)` 调用 Center 全局任务动作；通过 `host.tasks.getActiveForBot(botId, conversationId)` 与 `host.tasks.listDirectoryBots(botId, conversationId)` 读取本机同步缓存的活跃任务与协作 Bot 目录。
- **提示词段落 `tasks`**：每次模型请求前自动注入工具使用指引、团队 Bot 目录概况（含职责、能力、设备、在线状态）、协作与权限纪律以及当前 Bot 关联的活跃任务与角色标识。
- **工具卡片呈现 `TaskPresentation`**：返回单个任务的动作与 `get` 均通过 `api.details({ presentation })` 与 `result.details.presentation` 输出 `kind: 'task', version: 1` 的受控载荷，供前端内联渲染与一键跳转任务看板。

## 打包与构建

通过根目录 `scripts/prepare-builtin-plugins.mjs` 将 `plugins/tasks` 打包为内置插件制品 `build/builtin-plugins/tasks.tgz` 并写入 `manifest.json`。
