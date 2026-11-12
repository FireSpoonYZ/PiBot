# 中心服务（center-server）

中心（Center）是多设备 Bot 平台的权威配置面：管理 provider/模型目录、设备登记、托管插件/技能的安装与部署、Bot 绑定与生效配置，并经认证中继向 Host 下发快照与部署计划。服务为 Fastify 应用（`openCenterServer`），数据根下按域保存独立 SQLite 与 artifact 存储；控制台（center-web）与 Host 设备分别走不同的认证入口，Host 侧路由要求已登记的设备身份。

## 启动与排查

中心可以用发行镜像部署，也可以从源码构建镜像。部署后在浏览器完成首次初始化和模型配置，再在客户端验证首轮。 [首次部署](../README.md#首次部署并跑通一个-bot) · [中心镜像与诊断](../docs/center-linux-deployment.md)

中心 Dockerfile 使用 Node.js **26.13.0**，按三个包各自的锁文件安装 `center-web`、`center-server` 和 `host-core`。仅开发管理页时，可在仓库根执行 `npm ci --prefix center-web` 和 `npm run center:build`。

## Bot 模型选择与 Star

Windows、Linux、Android 的 Bot 模型页共用 All / Star 选择器。All 显示已启用且凭证已配置（或明确无需凭证）的服务商模型，包括 pi.dev 自动同步和手动添加的模型；显式停用的模型不显示。已知 provider 修改代理地址后仍会同步目录，新增同名 provider 立即应用中心缓存。中心启动及每 24 小时同步一次，失败时继续使用已有目录。

Star 按完整 `provider/modelId` 保存在中心，供该中心的三个客户端和所有 Bot 共用。收藏立即保存，独立于 Bot 模型覆盖的 CAS 保存；取消收藏不改变 Bot 的模型。服务商停用时保留收藏记录，恢复后重新显示。首次打开有可用收藏时默认进入 Star，否则进入 All。

设备令牌接口为 `GET /api/host/model-picker` 和 `PUT /api/host/model-stars`；管理接口去掉 `/host`，沿用 owner/CSRF 认证。读取返回模型目录、`starredModels` 和同步状态，不返回凭证或接入地址；写入接受 `{modelRef, starred}`，按单模型幂等更新，返回 `{starredModels}`。收藏不会提升执行配置修订。数据库自动升级到 schema 6，增加 `model_stars` 表；部署时需同时更新中心和客户端。

## 设备登记

`POST /api/devices` 需要所有者会话与 `x-csrf-token`（与其他管理端写路由相同）。请求 `{displayName, platform, deviceId?, deviceToken?, replaceExisting?}`：`displayName` 去除首尾空白后为 1–64 个字符，`platform` 为 `windows`、`linux`、`macos` 或 `android`；其他字段或取值返回 `400 INVALID_ARGUMENT`。省略设备身份时生成 UUID 和令牌。首次登记返回 `201 {deviceId, deviceToken, displayName, platform}`。客户端先在原生私有存储保存固定 ID/令牌；同 ID、同令牌重试返回 `200` 并复用身份，异令牌返回 `409`。`replaceExisting: true` 为显式重新配对，轮换令牌并保留 Bot/历史；旧令牌随后失效。新 ID 限 1–200 个可见 ASCII 字符，保留 `center-` 前缀。中心中继注册表（`relay.sqlite`）只保存令牌 SHA-256，不写日志。新设备立即出现在 `GET /api/devices`（未连接前 `online: false`），Host 连接时 hello 上报的平台会覆盖登记时的值。

## 配对码

所有者在管理页为新设备签发一次性配对码，设备无需输入所有者密码。线格式 `pibot1.` + base64url(JSON `{u, c, a?}`)：`u` 为 `publicUrl` 的 origin，`c` 为 24 字节随机密钥（32 个 base64url 字符），`a` 为已保存的私有 CA（PEM，可选）。中心只保存 `c` 的 SHA-256；10 分钟有效，单次使用。

所有者接口（需会话；写操作另需 `x-csrf-token`）：`POST /api/pairing-codes`（请求体 `{}` 或 `{deviceId}`）返回一次性的 `{id, code, expiresAt, ttlSeconds, includesCa, target}`。不带 `deviceId` 的通用码登记新的设备 ID，或把已删除的设备 ID 加回，但不能重新绑定在用的设备；带 `deviceId` 的专属码只能把该设备重新绑定（管理页设备卡片上的「重新配对」），目标不存在、已删除（撤销）或是保留的中心设备时返回 `404 NOT_FOUND`。`GET /api/pairing-codes/:id` 返回 `{id, status, createdAt, expiresAt, device?, target?}`，`status` 为 `pending`、`redeemed`、`expired` 或 `revoked`；`DELETE /api/pairing-codes/:id` 使未使用的码作废（已兑换的码不受影响，登记也不撤销）。`GET/PUT /api/pairing/ca`（`PUT {ca: string | null}`）读写嵌入配对码的私有 CA，只接受不超过 64 KiB、最多 8 张的 PEM 证书，规整后保存，响应附带证书主题、SHA-256 指纹与到期时间。

设备接口 `POST /api/pairing/redeem` 不需要会话或 CSRF，凭一次性密钥授权，请求 `{code, deviceId, deviceToken, displayName, platform}`（`code` 为密钥 `c`，不是整串配对码；设备令牌由设备在调用前生成）。请求体上限 8 KiB；限流按来源地址每分钟最多 30 次，中心位于反向代理之后时需设置 `CENTER_TRUST_PROXY`，否则所有请求共用代理地址、共享这 30 次额度。成功时新设备返回 `201`（包括通用码把已删除的设备 ID 加回：撤销被解除、换新令牌，删除时清掉的 Bot 与绑定不恢复），专属码重新绑定在用的设备返回 `200`，响应与 `POST /api/devices` 相同；重新绑定会换令牌、保留 Bot 与会话，并保留所有者改过的设备名。错误码：`PAIRING_CODE_INVALID`（401，密钥不存在或格式不对）、`PAIRING_CODE_USED`（409）、`PAIRING_CODE_EXPIRED`（410，超过 10 分钟，或专属码的目标设备已被删除/撤销）、`PAIRING_CODE_REVOKED`（410，所有者关闭了「添加设备」窗口，码被作废）、`DEVICE_ALREADY_REGISTERED`（409，通用码带来的设备 ID 仍在使用中）、`PAIRING_CODE_DEVICE_MISMATCH`（409，专属码被别的设备使用）；后两种拒绝都不消耗该码。同一设备、同一令牌可在兑换后 10 分钟内重放同一个码，前提是该令牌仍是此码创建的凭据（设备在此期间被删除时不会借重放复活），其余调用方一律得到 `PAIRING_CODE_USED`。

存储：数据库升级到 schema 9，增加 `pairing_codes` 与 `pairing_settings`；超过一天的失效码在下次签发时清理。

## Bot 头像

头像按 `deviceId + botId` 保存在中心 `center.sqlite` 的 Bot 目录记录中，包含形状、颜色、旋转和表情。手机、Windows 和 Linux 使用相同标识生成默认头像，客户端本地存储只保留展示缓存与旧版本自定义配置。

`GET /api/host/devices/:deviceId/bots/:botId/avatar` 返回 `{value, revision}`；`PUT` 接受 `{expectedRevision, value}`，`value: null` 恢复默认。设备认证沿用现有 Bearer 与 X-Device-Id；管理端提供同名的不带 `/host` 路由，沿用 owner/CSRF 认证。写入使用修订检查，并通过 Bot 目录序列同步给客户端。Host 上报目录、改名或切换主助手会保留中心头像，头像修改不改变模型与插件执行配置。

升级客户端后，旧的本地自定义头像会在读取目录时自动补传；只在中心从未保存过头像（revision 为 0）时导入，多个旧客户端同时导入时以中心首次接受的配置为准。中心已经保存的配置或“恢复默认”优先，旧缓存不会将其覆盖。新 Bot 创建时的头像先保留本地草稿，随下一次目录同步上传；已有 Bot 编辑头像需要中心保存成功后才显示完成。

## 默认 Bot 绑定

部分 Host 插件在中心注册为"默认绑定"能力：当安装处于已启用状态（`installation.enabled` 且 activation 为 `enabled`）时，新注册的 Bot 自动获得 `enabled: true`、revision 1 的绑定，沿用全局配置。已有 Bot 在安装首次变为已启用状态时同样补发默认绑定。**显式禁用、自定义 overrides 或既有 revision 不会被覆盖。**

内置问卷、待办、Vault 与 Billion Context 在新中心默认启用。Hindsight 和 Webfox 随镜像提供，启用并配置服务后可下发 Bot 绑定。Hindsight 的默认 `projectId` 为 `<name>-<botId>`。可在管理页查看全局激活与单 Bot 绑定。自定义制品按普通安装与启用流程部署。 [中心插件管理](../docs/center-linux-deployment.md#模型能力与客户端版本)

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
