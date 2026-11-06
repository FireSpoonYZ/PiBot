# 中心服务（center-server）

中心（Center）是多设备 Bot 平台的权威配置面：管理 provider/模型目录、设备登记、托管插件/技能的安装与部署、Bot 绑定与生效配置，并经认证中继向 Host 下发快照与部署计划。服务为 Fastify 应用（`openCenterServer`），数据根下按域保存独立 SQLite 与 artifact 存储；控制台（center-web）与 Host 设备分别走不同的认证入口，Host 侧路由要求已登记的设备身份。

## Bot 模型选择与 Star

Windows、Linux、Android 的 Bot 模型页共用 All / Star 选择器。All 显示已启用且凭证已配置（或明确无需凭证）的服务商模型，包括 pi.dev 自动同步和手动添加的模型；显式停用的模型不显示。已知 provider 修改代理地址后仍会同步目录，新增同名 provider 立即应用中心缓存。中心启动及每 24 小时同步一次，失败时继续使用已有目录。

Star 按完整 `provider/modelId` 保存在中心，供该中心的三个客户端和所有 Bot 共用。收藏立即保存，独立于 Bot 模型覆盖的 CAS 保存；取消收藏不改变 Bot 的模型。服务商停用时保留收藏记录，恢复后重新显示。首次打开有可用收藏时默认进入 Star，否则进入 All。

设备令牌接口为 `GET /api/host/model-picker` 和 `PUT /api/host/model-stars`；管理接口去掉 `/host`，沿用 owner/CSRF 认证。读取返回模型目录、`starredModels` 和同步状态，不返回凭证或接入地址；写入接受 `{modelRef, starred}`，按单模型幂等更新，返回 `{starredModels}`。收藏不会提升执行配置修订。数据库自动升级到 schema 6，增加 `model_stars` 表；部署时需同时更新中心和客户端。

## 设备登记

`POST /api/devices` 需要所有者会话与 `x-csrf-token`（与其他管理端写路由相同）。请求 `{displayName, platform, deviceId?, deviceToken?, replaceExisting?}`：`displayName` 去除首尾空白后为 1–64 个字符，`platform` 为 `windows`、`linux`、`macos` 或 `android`；其他字段或取值返回 `400 INVALID_ARGUMENT`。省略设备身份时生成 UUID 和令牌。首次登记返回 `201 {deviceId, deviceToken, displayName, platform}`。客户端先在原生私有存储保存固定 ID/令牌；同 ID、同令牌重试返回 `200` 并复用身份，异令牌返回 `409`。`replaceExisting: true` 为显式重新配对，轮换令牌并保留 Bot/历史；旧令牌随后失效。新 ID 限 1–200 个可见 ASCII 字符，保留 `center-` 前缀。中心中继注册表（`relay.sqlite`）只保存令牌 SHA-256，不写日志。新设备立即出现在 `GET /api/devices`（未连接前 `online: false`），Host 连接时 hello 上报的平台会覆盖登记时的值。

## Bot 头像

头像按 `deviceId + botId` 保存在中心 `center.sqlite` 的 Bot 目录记录中，包含形状、颜色、旋转和表情。手机、Windows 和 Linux 使用相同标识生成默认头像，客户端本地存储只保留展示缓存与旧版本自定义配置。

`GET /api/host/devices/:deviceId/bots/:botId/avatar` 返回 `{value, revision}`；`PUT` 接受 `{expectedRevision, value}`，`value: null` 恢复默认。设备认证沿用现有 Bearer 与 X-Device-Id；管理端提供同名的不带 `/host` 路由，沿用 owner/CSRF 认证。写入使用修订检查，并通过 Bot 目录序列同步给客户端。Host 上报目录、改名或切换主助手会保留中心头像，头像修改不改变模型与插件执行配置。

升级客户端后，旧的本地自定义头像会在读取目录时自动补传；只在中心从未保存过头像（revision 为 0）时导入，多个旧客户端同时导入时以中心首次接受的配置为准。中心已经保存的配置或“恢复默认”优先，旧缓存不会将其覆盖。新 Bot 创建时的头像先保留本地草稿，随下一次目录同步上传；已有 Bot 编辑头像需要中心保存成功后才显示完成。

## 默认 Bot 绑定

部分 Host 插件在中心注册为"默认绑定"能力：当安装处于已启用状态（`installation.enabled` 且 activation 为 `enabled`）时，新注册的 Bot 自动获得 `enabled: true`、revision 1 的绑定，沿用全局配置。已有 Bot 在安装首次变为已启用状态时同样补发默认绑定。**显式禁用、自定义 overrides 或既有 revision 不会被覆盖。**

当前默认绑定能力：`e-launcher.hindsight`（默认 `projectId: <name>-<botId>`）、`e-launcher.billion-context`（使用全局配置）。默认绑定仅在 Bot 首次注册或安装首次激活时写入一次；之后所有变更走普通 `PUT /api/devices/:deviceId/bots/:botId/capabilities/:id` 修订检查路径。

生产部署 Billion Context 时，经 owner session 上传 artifact 并完成 `POST /api/installations` + `POST /api/installations/:id/enable`；激活成功后所有尚无 BC 绑定记录的 Bot 自动获得默认启用绑定。无额外迁移步骤；已有显式禁用或自定义 overrides 的 Bot 不受影响。

## 每轮准入（turn admission）

> **状态**：本节描述本轮实现的每轮准入契约，由父助手统一集成与端到端验收；在验收完成前以下为设计契约而非已验证事实。Host 侧语义见 [host-core/README.md](../host-core/README.md) 的「每轮集中插件同步」。

中心对每个 Bot 的**目标插件集合**有最终权威：成员、精确版本、不可变 artifact digest、启用/禁用/移除、生效配置修订与所引用凭据的修订。集合身份（setId）按 Bot 计算；无关 Bot 的全局修订变化不使本 Bot 的准备失效。

### Host 设备路由

以下三个端点面向已认证的 Host 设备（与普通设备路由同一认证域）：

| 端点 | 请求 | 响应 |
| --- | --- | --- |
| POST `/api/host/turns/prepare` | `{botId, requestId, scopeKey, inputDigest, knownSetId?}` | TurnPreparation：`{protocol:1, botId, setId, snapshot, plans, admission?}` |
| POST `/api/host/turns/confirm` | `{botId, requestId, scopeKey, inputDigest, setId}` | `{admissionId, setId, admittedAt}` |
| POST `/api/host/turns/restore` | `{botId, admissionId}` | 与 prepare 相同的 TurnPreparation + 原准入许可 |

- **prepare**：返回该 Bot 当前权威集合身份、以此集合配置的设备快照与所需精确安装计划。携带 `knownSetId` 且与当前集合一致、本地已就绪时可在同一请求中直接签发准入；否则 prepare 本身不授权执行。
- **confirm**：在单个数据库事务中比对**当前**权威集合与意图权限后才记录幂等准入；集合已变回 `TURN_SET_CHANGED`，目标 artifact 未就绪/安装失败回 `TURN_SYNC_FAILED`。异步解析期间发现并发修订/计划变化时重试或拒绝，绝不拼凑不一致的快照/计划组合。
- **restore**：校验准入归属与授权仍然有效、被引用凭据修订未变、目标可用/兼容后，返回原准入的快照/配置/模型选择与计划加同一许可。显式撤销或凭据修订变化必须失败，不复活旧授权；普通代码/配置更新允许旧准入恢复原版本继续。
- **artifact 访问**：`GET /api/host/artifacts/:artifactRef` 在现有当前计划授权之外，接受可选 `admissionId` 查询——仅当该 artifact 被此设备/Bot 已存储准入引用且恢复授权仍然有效时放行旧 artifact。
- **请求身份**：以已认证设备 + botId + scopeKey + requestId 键控；相同 requestId 不同 `inputDigest` 视为冲突。准入记录幂等，重试沿用同一身份不会产生重复消息。

### 持久化与安全边界

- 集合快照/计划按 setId 去重持久化，准入行引用集合而非逐条复制 lockfile；沿用既有 CAS 与幂等模式。
- pin 元数据**不保存凭据值**，也不把明文秘密哈希进公开标识；恢复时校验的是凭据**修订**。
- `snapshot` 即既有设备快照（选中该 Bot 并按目标集合配置）；`plans` 沿用既有部署计划形状。集合比对涵盖精确版本、artifact/lock 身份、启用成员、生效配置与凭据修订。
- 中心的 rollout 启用/就绪状态（updating/enabling）与**授权**分开：授权由全局意图启用 + Bot 绑定 + 安装存在性推导，不随瞬态发布进度摇摆；显式禁用/移除与凭据修订变化立即撤销。
- 错误码：`TURN_SET_CHANGED`、`TURN_SYNC_FAILED`、`TURN_RECOVERY_REQUIRED`；离线/忙由 Host 侧映射为既有 `CENTER_OFFLINE`/`RUNTIME_BUSY`。
