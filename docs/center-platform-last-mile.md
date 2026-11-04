# 实施补充与续行职责

本文件由父助手记录已经明确的最新接线，配合center-platform-contract-addendum.md；不是增加新产品范围。

- 全局停用必须可恢复：manager.enable、POST /api/installations/:id/enable，Operation/Plan action含enable；只恢复实例，不修改各Bot选择。
- UpdateRequest可选source:{type:'artifact',artifactRef}，用于上传新版制品；校验packageId及准确targetVersion。中心准备成功后一起发布targetVersion/source，各Host独立应用，失败保留本机旧active并报告；不做跨Host原子提交或自动全局回滚。requestId指纹包含source。
- MCP OAuth由effectiveConfig.oauth===true启用，仅中心托管HTTP；与显式Authorization/apiKeyRef同时配置报冲突。openCenterServer增加publicUrl来自CENTER_PUBLIC_URL。
- OAuth模块：center-server/oauth/index.js → openMcpOAuth({store,publicUrl})；start({installationId,deviceId,botId})→{flowId,authorizationUrl}，status(flowId)→{status:'pending'|'complete'|'failed',error?}，complete({state,code?,error?})，logout({installationId,deviceId,botId})，getAuthProvider({installationId,deviceId,botId,url})→官方McpOAuthProvider，close()。异步操作返回Promise，status同步。callback路径/api/oauth/mcp/callback。
- openCenterExecution增加oauth参数，对oauth实例使用adaptOAuthProvider。身份校验仍在execution。
- 配置凭证标记format:'credential-ref'。EffectiveCapability.credentialRefs为中心解析的该Bot/实例引用列表；Host不能把整设备秘密映射交给一个插件。center目标引用在中心store.resolveCredential，不发送Host。
- NativePlugin.durableTasks每实例注册一次，名字由插件按installationId定义，不自动改名；perBot贡献不带tasks。
- host.sdk注入原生Durable/Chord值，原生包不运行时import宿主引擎。定义用传入SDK，业务独立依赖照常npm安装。
- 通用Runtime须暴露 core文档访问供插件读取上下文（例如host.documents={PrimaryIndex,WorkIndex,WorkContextState,WorkDecisionState,ContextState}），不注入Hindsight专用服务。Hindsight自己实现记忆逻辑。
- Hindsight可选旧memory RPC兼容通过按动作名查找已启用插件（唯一匹配，否则明确拒绝），核心不固定hindsight ID或创建特殊memory服务。
- HostService npmPath可选；Host依赖npm11.6.2已由父助手锁定。Android显式传既有npm资产路径；桌面打包受管npm路径；仅真正安装时检查路径。
- 父助手已运行root web构建通过；center-web构建因缺api.listActions报TS2339，由admin-shell补，不允许声称UI已通过。
- 当前Linux/Docker环境尚未就绪：本机无Docker/可用WSL，已有SSH目标不可达。先继续Windows真实协议/浏览器/Android验证；不把Compose未运行写成通过。

补充worker只在自己的职责写文件，均使用openai/gpt-6.1-terra:xhigh、独立worktree、静态开发，不执行测试/构建/安装。

## 第三轮：配置修订号与运行状态分开

- 中心仍是唯一权威配置源；通知仍为 SSE + HTTPS 快照 + CAS + 断线全量重读，不新增同步系统。
- `metadata.revision` 保留原值不再增长（旧用途/数据不重置），新增 `metadata.config_revision`；旧库迁移时初始化为 `max(现有 revision)`，因此旧 Host 的已应用版本不会倒退。user_version 升到 3，新增 `device_configs` 小表。
- `config_revision` 只在实际执行配置变化时递增：provider/model/全局模型选择/Bot 模型覆盖/能力全局配置/绑定/凭证/安装启用与目标版本/真实 Bot 增删。不因相同 bootstrap（Bot 目录无变化）、Bot 活动时间、部署回执、operation 阶段或显示名变更递增。
- 设备快照版本是每设备期望版本：`device_configs` 保存该设备执行内容（provider、model、Bot 模型、每 Bot 能力有效配置、凭证引用及其修订号）的 SHA-256 指纹；指纹不变就不推进版本号，因此其他设备或纯展示变化不会让本设备显示未同步。新版本取 `max(config_revision, 上一版 + 1)`，逐设备单调。指纹只存摘要，不存密钥原文，也不经 API 返回。
- `POST /api/host/receipt` 接受 `applying|waiting-idle|applied|failed`（不接受 pending），可选 `appliedRevision`、`bots[]`、`capabilityErrors[]`；拒绝超过当前期望版本的未来修订，旧回执不回退已存的新版本。旧 Host 只发 `{deviceId,revision,status,error}` 仍可接收。
- 回执由中心记录服务端时间：`updatedAt` 为回执记录时间，`appliedAt` 为当前版本实际应用时间（非 applied 时为 null）。`DeviceRuntimeStatus.updatedAt` 是当前期望配置生效时间，`appliedAt` 来自回执。目标报错只透传安全 code 与固定文案，不返回凭证或原消息。
- `GET /api/devices/:deviceId/runtime-status`（owner）返回 `DeviceRuntimeStatus`：按期望版本与最新回执得出 `pending|applying|waiting-idle|applied|failed`；回执落后即 pending；目标离线只用 `online=false` 表达，不冒充已应用。
- `GET /api/devices/:deviceId/bots/:botId/capabilities`（owner）聚合实例、Bot 绑定与 uiSchema，替代前端 N+1 读取；修改仍走既有 `PUT .../capabilities/:id`。
- `PATCH /api/installations/:id`（owner+CSRF，`{expectedRevision, displayName}`）只改显示名：trim、非空、≤120 字符，不触发重新部署或执行通知。
- 管理页低频轮询（可见时 2.5s，visibilitychange 立即重读）展示应用状态、期望/已应用版本、时间与失败原因；Bot 能力页在覆盖表单打开或写入中暂停刷新，避免覆盖脏表单。MCP 卡片与详情页标出运行位置，说明 URL 由中心或目标 Host 访问。
- 未验证：以上为静态实现，数据库迁移、Host 回执与时序、页面刷新均需父助手实际运行验收。

## 第四轮：全局总启用状态与 Bot 启用前置

- `Installation` 总是带 `activation:{status:'disabled'|'enabling'|'enabled'|'failed', error:{code,message}|null, updatedAt:string|null}`；`enabled` 仍是全局意图。旧行无该字段时，按既有 `enabled` 归一为 `enabled`/`disabled`（updatedAt=null），不丢已有绑定。
- 有效授权 = `enabled && activation.status==='enabled'`（`center-contract` 与 `store.isActive` 同一规则）。快照中的 `EffectiveCapability.enabled`、中心 MCP tools/call、动作校验、Bot 新开启都使用该规则；全局停用立即失效执行，但保留现有 Bot 绑定偏好。
- 新安装默认 `enabled=false, activation.disabled`；必须由用户显式调用 `POST /api/installations/:id/enable`。该接口复用既有异步 operation：先把意图置启用并进入 `enabling`，只有在端口准备/校验通过后才写 `enabled`；失败写 `failed` + 固定 code/message，晚到/旧 operation 不会覆盖新状态（靠 metadata.operationId 与 packages 串行队列）。
- 全局启用成功条件：包版本/manifest/schema 可解析、制品存在（分发准备）、center 目标必须本地已安装对应 targetVersion；center-target MCP 还必须在全局配置下真实 connect+listTools（一次性探测，不借用 Bot 绑定）。host-target plugin/skill 的全局成功仅表示可分配 + 分发准备完成（UI 文案已写明），host-target MCP 的设备连接仍只能在该 Bot 侧确认。
- OAuth（center MCP、全局配置 `oauth:true`）：`EnableRequest.validationBot:{deviceId,botId}` 指定已有 Bot 作为校验身份，不需已启用该 Bot 的绑定；先走现有 `oauth/start` 授权，再用该身份 `getAuthProvider` 做 connect+listTools，成功才 `enabled`；未提供/未授权 → `failed` + `NEEDS_AUTH`（可重试）。令牌仍按 Bot 隔离，不复用给其他 Bot；`globalConfig.url` 必须与该身份有效 URL 一致。
- 更新版本、回滚、全局配置修改（`PUT /api/installations/:id/config`）会把已启用实例降回 `enabling` 并重新准备（配置路径经 `packages.revalidate` 排队），避免旧成功回执/旧成功态被误认；重命名不改 activation 也不重置配置。
- 本次 enable/update/rollback 在部署已 applied 但准备/探测失败时，同时把**该次 operation** 改成 `phase:'failed'` + 固定安全错误（不会出现 activation failed 而 operation applied）。探测/准备期间该 operation 被“持有”（center 与 host 目标相同，`dispatch` 之前即持有）：任何提前到来的终态（installer 回执、monitorOperation、routes 的 host 部署回执）都先写成 `phase:'activating'`，settle 成功才发布 `applied`；waiting-idle 重试只对 enable/update/rollback 先持有再结算，disable/uninstall 不持有也不结算。旧/晚到无法覆盖新状态（以 metadata.operationId 为守卫）。配置 revalidate 不持有 operationId，因此绝不会倒写历史 operation。重启时先根据 activation=enabling 恢复对应未完成 operation 的持有，再连同 probe 结算（无对应 operation 时走 revalidate）。
- Bot 开启硬校验在 store/API：`PUT .../capabilities/:id` 从 off → on 时若全局未有效启用则 403（关闭已有绑定、修改已开启绑定的覆盖仍允许）。
- 指纹只对 enabled 能力计执行内容，从集合移除即表达撤销；snapshot 仍返回完整目录供策略更新。provider/model 的 `name` 已从指纹排除（纯展示字段不再推进 desired 版本）。
- 客户端匹配：`Installation.activation`（列表/详情/`GET .../bots/:botId/capabilities` 聚合内均携带）、`EnableRequest.validationBot`、失败时 `activation.error.code` ∈ {NEEDS_AUTH,MCP_UNREACHABLE,PACKAGE_NOT_READY,INVALID_ARGUMENT,VALIDATION_FAILED,INTERNAL_ERROR}。
- 未验证：以上同样仅静态实现；全局启用可行性需真实中心 + 已有 Bot 的 OAuth 授权 + 真实 MCP 端点验收。
