# 中心平台并行实现契约

状态：共享接口及最新并行接线补充；这里不代表服务已存在或运行验收通过。最终范围以 [reuse-first-development-plan.md](reuse-first-development-plan.md) 为准；实施接缝与职责以 `center-platform-contract-addendum.md` 和 `center-platform-last-mile.md` 的最新决定为准。除标明已有函数外，下面路径和签名是各 lane 要实现的接口，而不是现有代码。共用线上的 DTO 在 `center-contract/index.d.ts`，协议枚举在 `center-contract/protocol.js`，原生包静态 manifest 使用 `center-contract/manifest.schema.json`（draft-07）。这些文件没有 Node、Android、React 或服务端依赖；前端不得导入 `center-server` 或 `host-core`。

## 一致规则

- JSON 编码，`revision` 是非负整数；CAS 更新要求 `expectedRevision` 与当前修订完全一致，冲突返回 409，不能覆盖。新 Binding 第一次写入时以 0 为修订、`enabled=false, overrides={}`；一次成功写入递增修订。
- global 是唯一基础值；对象递归合并、数组整体替换、null 是显式值。删除 override 的字段即恢复继承。只在中心 data 层调用 deepmerge（`arrayMerge: (_target, source) => source`），合并后以对应 draft-07 schema 校验，初始化安装 global 时才应用 schema defaults。Host 只接收 effectiveConfig。
- 凭证字段用 JSON Schema 的 `type: 'string', format: 'credential-ref'` 标记，值为 credentialId；支持普通 properties、items 和 additionalProperties 字典。中心按 Bot/实例合并后的配置计算 `EffectiveCapability.credentialRefs`；只为已启用的 Host 目标发送所需秘密，插件仅得到自身 refs 对应的只读映射，不能拿整设备秘密；center 目标由中心 execution 直接通过 store.resolveCredential 取秘密。普通管理响应只给 credentialId / configured / revision，不返回秘密。设备快照只在内存使用，不写离线业务快照、不记日志。浏览器凭证写入仅使用 HTTPS POST/PUT body。
- 凭证 ID 前缀 `center-internal-` 保留给 relay/OAuth 内部状态；管理配置不得引用此前缀，管理凭证接口不得写入此前缀，Host 快照不下发此前缀对应的秘密。
- 所有安装类副作用请求带 requestId；同一所有者的相同 requestId 和相同请求返回同 operationId，不同内容返回 409。202 仅表示受理；应轮询 operation 和设备回执，不等于已部署。未知外部副作用不能自动重放。
- HTTP 响应错误统一 `{error:{code,message,details?}}`；400 INVALID_ARGUMENT/VALIDATION_FAILED，401 UNAUTHENTICATED，403 FORBIDDEN/CSRF_INVALID，404 NOT_FOUND，409 REVISION_CONFLICT/REQUEST_CONFLICT/INVALID_STATE，413 PAYLOAD_TOO_LARGE，429 RATE_LIMITED，503 CENTER_OFFLINE/DEVICE_OFFLINE，500 INTERNAL_ERROR。错误/日志不得包含凭证。schema 错误可用 details 返回不含敏感值的字段路径。
- `center-contract` 是平台中立的线协议类型，不依赖具体 Fastify/React/Durable 类型；实现模块在其本地使用现有 SDK 类型，不把它们引入共享 DTO。

## 数据与配置（center-data）

`center-server/data/index.js` 导出同步 `openCenterStore({dataRoot, encryptionKey}) -> CenterStore`；`dataRoot` 为绝对路径，密钥由部署环境注入，不存数据库。独立 `center.sqlite`；已有 relay 仍维护其自己的注册库。公开方法均同步，失败抛带 `code` 的错误，`close()` 释放数据库。

```ts
interface CenterStore {
  listProviders(): Provider[];
  getProvider(id: string): Provider | null;
  putProvider(provider: Provider, expectedRevision: number | null): Provider;
  listModels(providerId: string): Model[];
  putModel(providerId: string, model: Model, expectedRevision: number | null): Model;
  getModelConfig(): ModelConfig;
  putModelConfig(expectedRevision: number, global: ModelSelection): ModelConfig;
  getBotModelConfig(deviceId: string, botId: string): BotModelConfig;
  putBotModelConfig(deviceId: string, botId: string, expectedRevision: number, overrides: ModelSelection): BotModelConfig;
  replaceDeviceBots(deviceId: string, bots: BotRef[]): void;
  listDeviceBots(deviceId: string): BotRef[];
  listBotBindings(filter: {deviceId?: string; installationId?: string}): BotBinding[];
  listInstallations(): Installation[];
  getInstallation(id: string): Installation | null;
  getInstallationConfig(id: string): InstallationConfig;
  putInstallationConfig(id: string, input: PutInstallationConfig): InstallationConfig;
  getBotCapability(deviceId: string, botId: string, id: string): BotCapabilityConfig;
  putBotCapability(deviceId: string, botId: string, id: string, input: PutBotCapability): BotCapabilityConfig;
  getCredential(id: string): CredentialInfo | null;
  putCredential(id: string, input: CredentialWrite): CredentialInfo;
  deleteCredential(id: string, expectedRevision: number): void;
  resolveCredential(id: string): string;
  getPackageVersion(packageId: string, version: string): PackageVersion | null;
  putPackageVersion(version: PackageVersion): void;
  putInstallation(installation: Installation, expectedRevision: number | null): Installation;
  putInstallationActivation(id: string, activation: InstallationActivation): Installation;
  isActive(installation: Installation): boolean;
  getOperation(id: string): Operation | null;
  findOperationByRequestId(requestId: string): Operation | null;
  putOperation(operation: Operation, requestFingerprint: string): Operation;
  updateOperation(id: string, update: {phase: DeploymentPhase; error: ApiError['error'] | null}): Operation;
  listOperations(): Operation[];
  putDeploymentPlan(plan: DeploymentPlan): void;
  listDeploymentPlans(deviceId: string | null): DeploymentPlan[];
  putRuntimeReceipt(receipt: RuntimeReceipt): void;
  getRuntimeReceipt(deviceId: string): RuntimeReceipt | null;
  getDeviceRuntimeStatus(deviceId: string, online: boolean): DeviceRuntimeStatus;
  listBotCapabilities(deviceId: string, botId: string): BotCapabilityEntry[];
  renameInstallation(id: string, input: PutInstallationDisplayName): Installation;
  listDeploymentReceipts(installationId: string): DeploymentReceipt[];
  putDeploymentReceipt(receipt: DeploymentReceipt): void;
  getDeviceSnapshot(deviceId: string, linkUrl: string): DeviceRuntimeSnapshot;
  close(): void;
}
```

创建 Provider/Model/Installation 时 expectedRevision 为 null，服务生成 ID 和 revision；写入已有项时以 CAS 为准。Installation 始终带 `activation:{status,error,updatedAt}`；旧行按既有 `enabled` 归一为 `enabled`/`disabled`。`enabled` 是全局意图，有效授权必须同时满足 `activation.status==='enabled'`（`store.isActive`），不满足时快照、中心执行、动作与 Bot 新开启全部无效；`putInstallationActivation` 只改 activation 且在不改变有效授权时不推进配置修订号。credential value 为明文写入入口，持久层加密；仅可信服务内部可调用 resolveCredential。putOperation 只负责创建及 requestId/请求摘要的原子幂等，后续阶段更新使用 updateOperation。先 putPackageVersion，再 putInstallation；新安装 global 可以尚未完整配置，此时不得启用或启动。DeploymentPlan 的 planId 和 desiredRevision 按设备与安装实例标识当前计划，语义变化时才生成新 planId 并递增 desiredRevision；回执须匹配当前 planId，operation.deviceIds 不是永久授权依据。replaceDeviceBots 在事务内全量替换该设备登记的 Bot 引用（不得删除持久 Binding/业务数据）；listBotBindings 两个过滤字段同时提供时取交集。快照在一次一致性读取中生成，不能包含其他设备的 Bot/秘密；每个已登记 Bot 即使没有模型覆盖或 Binding 也必须出现，模型使用 global，能力默认禁用并使用 global 配置。模型字段沿用现有 `host-core/runtime-models.js`，迁移时需要兼容其模型和凭证解析，不把明文写到本地 settings。

## 服务组合（center-api）

`center-server/server.js` 导出 `async openCenterServer({dataRoot, encryptionKey, sessionKey, ownerPasswordHash, publicUrl, https, listenHost, port, relay, webRoot}) -> {url, linkUrl, close(): Promise<void>}`。https 为 `{cert: string, key: string}` PEM；relay 为已有 `openRelayServer` 的 `{listenHost, port, tls}`，显式提供外部可达 `linkUrl`（relay 对象中）而不由监听地址猜测。Fastify 管理 HTTPS 和原 relay 两个 listener 共同启动/关闭；任何启动失败需清理已打开资源。入口 `center-server/cli.js` 只读取部署配置并调用此函数。独立模块 `auth.js`、`routes.js`、`host-bridge.js`、`execution.js` 由 server 组合，不新造第二套 relay 协议；`center-server/execution.js` 由 center-api lane 拥有，使用 pi-mcp 连接部署在中心的 MCP。

`center-server/execution.js` 导出 `openCenterExecution({store, packages, oauth}) -> {listTools(deviceId: string, installationId: string, input: CapabilityToolsListRequest): Promise<CapabilityToolsListResponse>, callTool(deviceId: string, installationId: string, input: CapabilityToolCallRequest): Promise<CapabilityToolCallResponse>, close(): Promise<void>}`。deviceId 只能由已认证设备身份传入，方法负责校验 Binding 并按 Bot 创建复用对应配置的 pi-mcp 连接；提供 withActivation 以在运行边界协调安装切换。使用 OAuth 的实例将 oauth 的 getAuthProvider 结果经官方 adaptOAuthProvider 接入；不提供通用对外 MCP 网关。

浏览器走同源 HttpOnly secure-session；匿名 GET /api/session 建立 cookie 并返回 csrfToken，所有修改请求（含登录）以 `x-csrf-token` 校验，登录后更新 session/token；登录限速。所有者密码哈希格式为 `scrypt$<16字节salt hex>$<64字节key hex>`，Node scrypt 默认参数；CLI `password-hash` 从 stdin 读取口令。`CENTER_ENCRYPTION_KEY_HEX` 与 `CENTER_SESSION_KEY_HEX` 必须为彼此独立的 32 字节（64 hex）密钥。部署输入包括 CENTER_DATA_ROOT、CENTER_LISTEN_HOST、CENTER_PORT、CENTER_RELAY_PORT、CENTER_PUBLIC_URL、CENTER_LINK_URL、CENTER_WEB_ROOT、CENTER_TLS_CERT_FILE/KEY_FILE；可选 CENTER_NPM_PATH 是 npm-cli.js 绝对路径，未配置时中心解析其 npm 依赖。设备 HTTP 请求使用 `Authorization: Bearer <deviceToken>` 加 `X-Device-Id`，并复用原设备链路身份；设备权限限自身 snapshot、制品与回执，不继承所有者权限。原 relay Origin 和设备认证规则不放宽。

### HTTP API

除 `/api/session`、登录外管理接口均需 owner session；PUT/POST/DELETE 要 CSRF。下表 `T` 表示 `center-contract/index.d.ts` 的同名 DTO；列表直接返回数组、成功的空操作返回 204。资源 ID 做 URL 编码。

| 方法与路径 | 请求 → 成功响应 |
| --- | --- |
| GET /api/session | → SessionInfo（匿名也可读） |
| POST /api/session | LoginRequest → SessionInfo；登录后发新 session |
| DELETE /api/session | → 204 |
| GET /api/providers | → Provider[] |
| POST /api/providers | Provider（id 可由服务创建，revision=0）→ Provider，201 |
| GET /api/providers/:id | → Provider |
| PUT /api/providers/:id | RevisionWrite<Provider> → Provider |
| POST /api/providers/:id/validate | ProviderCheckRequest → ProviderCheckResult；指定在线设备执行 |
| POST /api/providers/:id/discover | ProviderCheckRequest → DiscoveryResult；指定在线设备执行 |
| GET /api/providers/:id/models | → Model[] |
| POST /api/providers/:id/models | Model（revision=0）→ Model，201 |
| PUT /api/providers/:id/models/:modelId | RevisionWrite<Model> → Model |
| GET /api/model-config | → ModelConfig |
| PUT /api/model-config | RevisionWrite<ModelSelection> → ModelConfig |
| GET /api/devices | → Device[]（取原 relay 在线状态） |
| GET /api/devices/:deviceId/bots | → BotRef[]（中心登记目录；设备离线时标识设备离线，不触发 Runtime 启动） |
| GET /api/devices/:deviceId/runtime-status | → DeviceRuntimeStatus；期望版本与最新回执对比，无回执或回执落后为 pending，离线只体现在 online=false |
| GET /api/devices/:deviceId/bots/:botId/cwd | → BotCwdConfig；Bot 工作目录为中心权威，常规目录上报与 profile/avatar 等普通 upsert 均不携带；仅 POST createBot 成功回执可对新 Bot 隐式初始化一次，或 Host 在快照中缺值时用 PUT expectedRevision:0 CAS 补登，已有值绝不覆盖 |
| PUT /api/devices/:deviceId/bots/:botId/cwd | RevisionWrite<string> → BotCwdConfig；只校验目标平台绝对路径格式，离线可保存，Host 空闲边界应用且不移动文件 |
| GET /api/devices/:deviceId/bots/:botId/model-config | → BotModelConfig |
| PUT /api/devices/:deviceId/bots/:botId/model-config | RevisionWrite<ModelSelection>（value 为 overrides）→ BotModelConfig |
| GET /api/credentials/:id | → CredentialInfo |
| PUT /api/credentials/:id | CredentialWrite → CredentialInfo |
| DELETE /api/credentials/:id | RevisionWrite<null> → 204 |
| POST /api/artifacts | multipart 字段 file（受限大小）→ ArtifactUploadReceipt，201；校验并存入制品库 |
| GET /api/capabilities | → Installation[] |
| POST /api/installations | InstallRequest → Accepted，202 |
| GET /api/installations/:id | → Installation |
| GET /api/installations/:id/config | → InstallationConfig |
| PUT /api/installations/:id/config | PutInstallationConfig → InstallationConfig |
| PATCH /api/installations/:id | PutInstallationDisplayName → Installation；只改显示名称，不改进安装标识/包 ID/工具名，不触发重新部署，非执行配置变更；不递增配置修订号 |
| GET /api/devices/:deviceId/bots/:botId/capabilities | → BotCapabilityEntry[]；聚合实例、该 Bot 的绑定/有效配置与 uiSchema |
| GET /api/devices/:deviceId/bots/:botId/capabilities/:id | → BotCapabilityConfig |
| PUT /api/devices/:deviceId/bots/:botId/capabilities/:id | PutBotCapability → BotCapabilityConfig |
| POST /api/installations/:id/validate | InstallationCheckRequest（deviceId、botId）→ ProviderCheckResult；未声明 validate 动作时明确不支持 |
| GET /api/installations/:id/actions | → ActionDescriptor[]，来自已安装包的静态描述 |
| POST /api/installations/:id/oauth/start | OAuthStartRequest → OAuthStartResponse |
| GET /api/oauth/mcp/flows/:flowId | → OAuthFlowState |
| POST /api/installations/:id/oauth/logout | OAuthStartRequest → 204 |
| GET /api/oauth/mcp/callback | 公开回调，校验 state/PKCE 后显示固定完成提示 |
| POST /api/installations/:id/updates/check | → PackageVersion[]；只查询，不激活 |
| POST /api/installations/:id/update | UpdateRequest → Accepted，202；可选 source 为新上传 artifact |
| POST /api/installations/:id/rollback | OperationRequest → Accepted，202 |
| POST /api/installations/:id/disable | OperationRequest → Accepted，202 |
| POST /api/installations/:id/enable | EnableRequest → Accepted，202；全局意图置启用并进入 `enabling`，只有中心侧准备/校验成功才转 `enabled`；OAuth 中心 MCP 可带 validationBot；不修改各 Bot 选择 |
| DELETE /api/installations/:id | OperationRequest → Accepted，202；默认保留数据 |
| POST /api/installations/:id/actions/:action | ActionRequest → ActionResult；已声明 action，限输入输出及超时 |
| GET /api/installations/:id/deployments | → DeploymentReceipt[] |
| GET /api/operations/:id | → Operation |

公开 OAuth 回调无需 owner session；其余管理 OAuth 路由仍需 owner session，修改请求需 CSRF。设备独立认证接口（不是浏览器管理接口）：GET `/api/host/events` → `text/event-stream`，仅发送 `event: config-changed` 和 `event: heartbeat`，data 为 `{}`，无秘密；POST `/api/host/bootstrap` BootstrapRequest → BootstrapResponse；GET `/api/host/snapshot` → DeviceRuntimeSnapshot；POST `/api/host/receipt` RuntimeReceipt → 204；POST `/api/host/deployments/receipt` DeploymentReceipt → 204；GET `/api/host/deployments` → DeploymentPlan[]；GET/PUT `/api/host/devices/:deviceId/bots/:botId/cwd` 与 owner 路由同语义；GET `/api/host/artifacts/:artifactRef` → 原始制品字节；POST `/api/host/capabilities/:installationId/tools/list` CapabilityToolsListRequest → CapabilityToolsListResponse；POST `/api/host/capabilities/:installationId/tools/call` CapabilityToolCallRequest → CapabilityToolCallResponse。服务端从认证身份确定 deviceId 并与 body 一致性校验，按实际分配检查制品，不让设备自行指定其他设备的 snapshot。中心 MCP tools/list 与 tools/call 以认证 deviceId + body.botId 校验对应 Binding、实例全局启用、target=center、实际版本及有效配置，再以该 Bot 凭证/配置调用中心 pi-mcp；只暴露分配给该 Bot 的工具，错误脱敏。callId 标识一次调用，网络超时视为结果未知，不自动重放外部副作用。bootstrap 先认证、校验并以事务替换来自该 Host 的 HostBotReport[]（无 cwd/avatar 等中心字段，旧 Host 仍携带时中心忽略），再生成快照；条目均须匹配认证 deviceId。变更影响设备的模型、配置、Binding、凭证或部署计划时，center-api 向对应活跃 SSE 发送 config-changed；心跳维持活性，不持久化事件、不重放。Host 收到通知读取完整当前快照及部署计划，断线后重新连接并再次 bootstrap；原 DeviceLink 仅用于消息与控制。不把秘密或制品塞进 SSE 或有界控制帧。

## 安装和部署（package-install）

`center-server/packages/index.js`：`openPackageManager({dataRoot, store, npmPath}) -> { uploadArtifact(input: AsyncIterable<Uint8Array>): Promise<ArtifactUploadReceipt>, readArtifact(artifactRef: string): Promise<Uint8Array>, listDeploymentPlans(deviceId: string): Promise<DeploymentPlan[]>, install(request: InstallRequest): Promise<Accepted>, update(id: string, request: UpdateRequest): Promise<Accepted>, enable(id: string, request: OperationRequest): Promise<Accepted>, disable(id: string, request: OperationRequest): Promise<Accepted>, uninstall(id: string, request: OperationRequest): Promise<Accepted>, rollback(id: string, request: OperationRequest): Promise<Accepted>, checkUpdates(id: string): Promise<PackageVersion[]>, close(): Promise<void> }`。上传读流限大小并按摘要存储；readArtifact 是仅供已授权服务调用的内部读取，HTTP 设备制品路由须先鉴权。listDeploymentPlans 只返回该设备需执行的当前计划；Operation.target/deviceIds 与各 DeploymentPlan、DeploymentReceipt 的 operationId/deviceId 对应（center 目标 deviceId=null；Host 目标为具体设备）。串行执行，先持久化 operation；源解析用 pacote，依赖树用固定 npm CLI；HTTP 类型登记 URL 而不声称下载或安装远端服务。中心保存固定 resolved/integrity、制品摘要与 lockfile。安装时从已校验的包解析 manifest 指向的 schema 文件，并将 draft-07 configSchema 和可选 uiSchema 作为 PackageVersion 顶层元数据保存，data 层不读取制品文件。原生 Hindsight 和 Skill 在 Host 执行；原生包选择 center 但无 manifest.components.center 时显式拒绝，禁止虚报安装成功。原生 manifest 固定为 capability.json；tgz 支持标准 npm 的 package/ 前缀，packageRoot 是实际含 package.json 的包目录。校验包路径、归档大小和越界链接；不可信归档不得穿越目录。manager 同时提供 getInstalled、reconcileDevice、withActivation 和 onChange(installationId)；Host 部署分配依据当前 Binding，异步操作实际持久化后才调用 onChange 通知相关设备，而非只在 HTTP 202 时通知。

`host-core/managed-install/index.js`：`openManagedInstaller({dataRoot, npmPath, fetchArtifact, report, withActivation}) -> {apply(plan: DeploymentPlan): Promise<DeploymentReceipt>, getInstalled(installationId: string): Promise<{installationId: string, version: string, packageRoot: string, dataDir: string, manifest: JsonObject} | null>, close(): Promise<void>}`；getInstalled 只返回已激活版本的本地元数据，不返回暂存目录；fetchArtifact 接收 artifactRef 返回制品字节，report 接收 DeploymentReceipt。执行端验证摘要并在受管暂存目录用平台 npm 准备依赖，空闲边界激活；失败保留旧版，忙时报告 waiting-idle。卸载默认保留数据；不复制其他平台 node_modules，也不在 Bot 启动时安装。withActivation 接收 `(installationId, publish) => Promise<boolean>`，在同一安装实例按 Runtime 原子准入执行 publish，忙时返回 false；中心 execution 同样通过 withActivation 防止忙时替换。计划、回执只表达部署状态，不把 202 当作成功激活。

更新原生插件或 Skill 时可在 UpdateRequest 中指定新上传的 `source: {type: 'artifact', artifactRef}`；npm 更新继续使用原 source 和目标 targetVersion。中心校验制品 packageId 与准确 targetVersion，准备成功后一起发布 targetVersion/source；requestId 幂等指纹包含 source。各 Host 独立应用，失败保留该 Host 原 active 并报告；不做跨 Host 原子提交或自动全局回滚。

## Host 在线入口（host-center）

`host-core/center-client.js` 导出 `connectCenter({centerUrl, deviceId, deviceToken, ca, onDisconnect, onChange}) -> Promise<CenterClient>`（ca 是可选 PEM）；认证后、bootstrap 前建立 SSE 并在整个在线会话保持，断线调用 onDisconnect(error)，config-changed 调用 onChange()；返回 `{bootstrap(bots: BotRef[]): Promise<BootstrapResponse>, getSnapshot(): Promise<DeviceRuntimeSnapshot>, reportRuntime(receipt: RuntimeReceipt): Promise<void>, getDeployments(): Promise<DeploymentPlan[]>, reportDeployment(receipt: DeploymentReceipt): Promise<void>, fetchArtifact(ref: string): Promise<Uint8Array>, listCapabilityTools(id: string, botId: string): Promise<CapabilityToolsListResponse>, callCapabilityTool(id: string, botId: string, name: string, args: JsonObject, callId: string): Promise<CapabilityToolCallResponse>, close(): Promise<void>}`。设备 HTTP 认证使用上述 Bearer 与 X-Device-Id，消息/控制继续使用原 DeviceLink，不新造离线授权。设备 token 永不传给浏览器。

`host-core/host-service.js` 保留现有 `openHostService(options)` 导出，由 host-center 改造：先冷读 host.sqlite 设备身份及 Bot（复用 `openHost({dataRoot}).listBots()`，按 BotRecord.botId/deviceId/role 转为 BotRef.botId/deviceId/name，关闭冷读连接），认证、SSE 和 bootstrap 并获取快照；control listener/runtime 可在 DeviceLink 前创建，但保持 centerOnline=false 且不得 resume；原 DeviceLink 接通后依次 apply snapshot、online、resume，再回报 ready。Bot 创建、删除或名称变化后同样调用 bootstrap 更新目录，不依赖已启动 Runtime 才能列 Bot。中心断连立即拒绝新工作并经现有取消机制停止在途调用；重连重新读取当前快照、应用后才恢复，不自动重发未确认请求。`host-core/runtime-models.js` 导出 `applyCenterModels(snapshot: DeviceRuntimeSnapshot, existingModels?) -> {models, botModels}`，复用现有模型注册与校验，按引用注入凭证（仅内存）。传入 existingModels 时原位更新该 pi-ai registry，`models` 为当前 registry，`botModels` 按 botId 索引有效 ModelSelection；被禁用/不存在的模型应报错，不自动换模型。


### Provider 验证与 OAuth

owner 选择已保存的 Provider 和在线设备，通过专用内部 relay client 调用 Host 的 `validateCenterProvider` / `discoverCenterProviderModels`；两者入参均为 ProviderProbeRequest `{provider, models, credential?}`，返回分别为 ProviderCheckResult / DiscoveryResult。credential 只作为所有者显式测试时的 TLS 控制帧窄例外，不入库、历史或日志；测试尚未保存的配置须先保存。内部 relay client 有独立身份元数据，其 token 经 store 加密，不冒充 Host。

`center-server/oauth/index.js` 提供 `openMcpOAuth({store, publicUrl}) -> {start, status, complete, logout, getAuthProvider, close}`。`start({installationId, deviceId, botId}) -> Promise<OAuthStartResponse>`；`status(flowId) -> OAuthFlowState`；`complete({state, code?, error?}) -> Promise<void>`；`logout({installationId, deviceId, botId}) -> Promise<void>`；`getAuthProvider({installationId, deviceId, botId, url}) -> Promise<McpOAuthProvider>`；`close() -> Promise<void>`。publicUrl 来自 CENTER_PUBLIC_URL，callback 固定 `/api/oauth/mcp/callback`。仅中心托管 HTTP MCP 的 effectiveConfig.oauth===true 启用 OAuth；同时配置显式 Authorization 或 apiKeyRef 属于冲突。官方 pi-mcp 完成协议，状态/令牌经 store 凭证加密，state/PKCE 校验失败不得完成流程。

### Runtime 与 App 接缝（由 host-plugins 实现 runtime，host-center 调用）

`openRuntime(options)` 返回既有 Runtime，追加以下方法（保留原 API），host-center 不直接修改 `runtime.js`：

```ts
applyCenterSnapshot(snapshot: DeviceRuntimeSnapshot): Promise<void>;
setCenterOnline(online: boolean): Promise<void>;
callCapabilityAction(installationId: string, action: string, request: ActionRequest): Promise<ActionResult>;
withCapabilityActivation(id: string, publish: () => Promise<void>): Promise<boolean>;
```

Runtime 输入增加 `centerRuntime: {snapshot: DeviceRuntimeSnapshot, getClient: () => CenterClient | null, installer}`；getClient 每次取得当前连接，installer 为受管部署器。withCapabilityActivation 与 installer/中心 execution 的 withActivation 同一安装实例原子准入：忙时返回 false 且不执行 publish，在线时约每秒串行重试 waiting-idle。applyCenterSnapshot 只接收认证中心当前设备的完整快照；在 Bot 安全边界应用模型、已安装版本和每 Bot effectiveConfig，返回时应用成功，失败抛带 code 的错误且保持拒绝新工作，不能回报 applied。setCenterOnline(false) 在调用后同步关闭新工作准入，再通过现有取消机制终止在途调用并异步完成清理；true 仅在最新快照成功应用后恢复准入。操作按服务生命周期串行协调，旧快照不能覆盖新的禁用策略。callCapabilityAction 只调用已声明的动作，校验 request.deviceId/botId、实例及当前策略，使用对应 Bot 配置/凭证；无权限、离线、未知动作分别拒绝，不自动重试外部副作用。

`openHostService(options)` 保留原字段 `{dataRoot, token, port?, initialSettings?, nativeBridge?, npmPath?}`，增加必需 `center: {url: string, deviceToken: string, ca?: string}`；token 仍是本地 control token，deviceToken 是设备认证密钥，ca 为可选 PEM。npmPath 为可选 npm-cli.js 绝对路径，只有实际安装需要时才检查；缺失时该安装报告 NPM_UNAVAILABLE，不阻止无安装计划的 Host。二种 token 用途不可混同，不把密钥作为状态返回或放到 URL。HostService.getStatus() 在既有字段基础上增加 `center: CenterConnectionStatus`；仅 `center.state === 'ready'` 时业务可用，appliedRevision 为已应用快照修订，错误经脱敏。host-center 可修改 `control-server.js`、`local-control-adapter.js`、`remote-control-protocol.js`、`control-client.js`、`index.d.ts`、`control-client.d.ts` 完成此接线；`runtime.js` 仍由 host-plugins 独占。

app-online 启动桥按上述 `center` 形状传递中心 URL、设备 token 和可选 CA，并传入可选 npmPath；Android 使用既有 npm 资产，桌面使用受管 npm 路径。原生/App 桥可最多约每秒轮询连接状态，Host 执行入口仍立即检查在线；只保存连接信息和设备认证材料，不保存业务快照。原生桥的连接设置/状态读取必须在 Host 启动失败或尚未创建时也可用，呈现 `CenterConnectionStatus`（disconnected/connecting/ready，未应用时 appliedRevision=null，error 为脱敏错误）；成功启动后从 HostService 状态同步。App 在非 ready 状态只显示连接设置/重试与管理入口，不放行聊天或其他业务；断连立即变为 disconnected，重连仅在快照应用成功后变 ready。桌面/Android 接桥由 app-online 实现，HostService 与控制协议的契约由 host-center 负责。

## 插件与驱动（host-plugins、mcp-skills）

`host-core/plugins/index.js` 导出 `loadNativePlugin({installationId, version, entry, packageRoot, dataDir, host}) -> Promise<NativePlugin>`。原生包 entry 导出 `createPlugin({installationId, version, packageRoot, dataDir, host}) -> Promise<NativePlugin> | NativePlugin`；packageRoot 是已激活不可变包目录（含代码与 Skill 资源），dataDir 是保留状态目录，不能混同；NativePlugin 为 `{durableTasks?, forBot(context): Promise<BotPlugin> | BotPlugin, close(): Promise<void>}`：durableTasks 每实例只注册一次，其 definition 名称由插件按 installationId 生成，Host 不自动重命名。context 为 `{deviceId, botId, installationId, effectiveConfig, credentials}`，credentials 是按有效引用解析的只读映射；BotPlugin 为 `{durableContributions, requestContributions, actions, prepare(), activate(), quiesce(), close()}`，四个生命周期方法均返回 Promise<void>。`durableContributions` 为 `{tools?, sections?, hooks?, wraps?}`，不含 name 和非空 tasks；每 Bot extension 由 Host 稳定命名和显式选择。`requestContributions` 为 `{prepareContext?: async (request, api, context) => Partial<Request> | undefined, beforeRequest?: async (request, api, context) => request | undefined}`；每 Bot 最多一个已启用的 prepareContext 提供者，多个时报 `INVALID_STATE`。Host 先执行在线/模型检查与 decisions.beforeRequest，再执行 prepareContext 并合并部分请求、持久化通用预算快照，然后执行插件 beforeRequest、Durable hooks 和最终预算检查；`actions` 为 `Record<id, {inputSchema, execute(input, invocationContext): Promise<JsonValue>}>`，对应 manifest 静态 `ActionDescriptor`。管理动作按真实 Bot 执行，Runtime 先检查策略。贡献使用现有 Durable 类型，不重定义引擎。资源按 Bot 创建复用；全部 direct/nested 工具、后台任务及 hook 在执行入口检查中心在线、实例与 Binding 双开关。Hindsight 作为此契约的普通插件，迁移保留原状态身份。旧 memory RPC 如需兼容，按动作名查找已启用插件，仅唯一匹配时转发；核心不得固定 Hindsight ID 或创建专用 memory 服务。


工厂中的 `host` 不是任意对象；由 host-plugins 构造以下最小可信服务，MCP/Skill 和 Hindsight 可共同依赖（类型指向现有 Host/Durable，而不塞入平台无关的 DTO）：

```ts
interface PluginHostServices {
  host: import('../host-core/index.js').Host;
  getHarness(): import('@earendil-works/pi-durable').Harness;
  models: /* Host 模型服务（含 getModel） */ unknown;
  sdk: /* 注入的 Host Durable/Chord 工厂 */ unknown;
  documents: /* RequestContext；ContextState 是其兼容别名 */ unknown;
  context: typeof import('@earendil-works/chord/context').BACKGROUND_CONTEXT;
  getWorkContexts(): ReturnType<typeof import('../host-core/runtime-work-contexts.js').createWorkContextRuntime>;
  getWorkActivity(botId: string, scopeId: string): Promise<import('../host-core/index.js').WorkActivity>;
  resolveConversationBot(conversationId: number): Promise<string>;
  assertCapabilityAllowed(botId: string, installationId: string): void;
  getExecutionEnv(botId: string): Promise<ReturnType<typeof import('../host-core/host-environment.js').createHostExecutionEnv>>;
  centerClient: {
    listCapabilityTools(id: string, botId: string): Promise<CapabilityToolsListResponse>;
    callCapabilityTool(id: string, botId: string, name: string, args: JsonObject, callId: string): Promise<CapabilityToolCallResponse>;
  };
}
```

`resolveConversationBot` 接收 Durable 数字 ConversationId，仅查 Host/持久会话绑定，未映射或有歧义时报错，不信任模型传入的 botId；`assertCapabilityAllowed` 同步检查在线、当前快照、实例和 Binding，拒绝时抛带 code 的错误，调用及后台执行入口均须使用。`getExecutionEnv` 是该 Bot 现有工作目录的受控 Durable 执行环境，不授予超出现有 Host 权限；context 为既有 Chord 后台上下文，具体调用时仍传实际 invocation context。host/getHarness/getWorkContexts/getWorkActivity 供 Hindsight 迁移原有 source、outbox 和工作上下文语义；它们是同进程受信代码接口，不是沙箱。host.sdk 注入宿主已有 Durable/Chord 工厂值，插件用注入值创建定义，不运行时 import/安装第二份宿主引擎，不使用跨目录 symlink 或自定义 ESM loader；业务独立依赖照常 npm 安装。host.documents 注入上述 core 文档定义供读取上下文，不注入 Hindsight 专用服务。插件不持久化或输出凭证。


`host-core/capabilities/mcp.js` 导出 `createMcpDriver({installationId, version, target, packageRoot, dataDir, host}) -> Promise<NativePlugin>`；target 直接来自已认证快照的 EffectiveCapability.target（center 或 host），不得从用户配置推测；target=center 时 packageRoot 为 null、没有 Host 本地 MCP 包，target=host 时 packageRoot 为已激活目录；`host-core/capabilities/skill.js` 导出 `createSkillDriver({installationId, version, packageRoot, dataDir, host}) -> Promise<NativePlugin>`。两者使用相同 `forBot(context)` 和生命周期；MCP 按 target=host 通过本机 pi-mcp，target=center 通过 host.centerClient 的 listCapabilityTools/callCapabilityTool，均在 Host 适配为 Durable 工具；Skill 只加载完整受管目录并输出启用 Bot 的 section；必须保留相对资源路径。驱动不得自行合并 global/overrides、绕过策略或将其他 Bot 客户端复用为当前 Bot。MCP config 使用 url/command/args/cwd/env/headers/timeoutMs 及可选 transport；envRefs/headerRefs/apiKeyRef 的值为 credentialId，refs 覆盖同名普通值，apiKeyRef 仅无显式 Authorization 时生成 Bearer。单一 JS bin 用 process.execPath 启动，多 bin 选择 config.bin。Skill 优先根 SKILL.md，其次 capability.json.skills，再 package.json.pi.skills，最后仅扫描受管根；相对路径都限制在包目录内。

### Billion Context 迁移契约

`@e-launcher/billion-context` 1.0.0 是能力 `e-launcher.billion-context` 的 Host 原生插件，依赖固定 `acp-kernel` 0.0.101；Host 不内嵌该依赖或插件。它保留 `host.bc-context` v1 的 conversation/rewindable/asOf 状态，不重置未知版本。Host 的 `host.request-context` v1 是独立的通用预算快照；`documents.ContextState` 仅为旧 Hindsight 读取 prepared 的兼容别名，不指向 BC 存储。

BC 保留 `compress`、`decompress`、`search_context`、`acp_status` 原名，以便恢复旧的待执行工具任务。工具冲突按每个 Bot 可见范围（core 与该 Bot 已启用的插件）检查：不同 Bot 可以同名，同一 Bot 内冲突则拒绝；会话的 selectedExtensions 与所有权检查维持隔离。

先在中心上传和安装插件实例，保持 Bot 绑定关闭；停止旧 Host 并保留数据后，为目标 Bot 启用绑定，使离线计划生成或排队；更新并启动新 Host，等待安装及 snapshot/profile 应用完成后恢复调度，再检查 Host 回执。不得在旧 Host 运行时下发启用 BC：旧内置工具与插件原名冲突，旧管理器会拒绝注册；忽略 prepareContext 不代表可同时加载插件。新 Host 对未启用 BC 的 Bot 使用未压缩请求，并保留最终预算检查。实例默认启用，Bot 绑定默认关闭，无本地启用回退。`contextStatus` 动作输入是仅有可选非空 `scopeId` 的对象；无 scope 为主会话，有 scope 为工作会话，读取不创建绑定；禁用/卸载返回 `EXTENSION_DISABLED`。详细打包、更新和回滚操作见 [插件 README](../plugins/billion-context/README.md)。

## 管理前端（admin-shell、plugin-ui）

`center-web/api.ts` 导出 `api` 对象，方法命名与 HTTP 操作一致：`session, login, logout, listProviders, createProvider, getProvider, putProvider, validateProvider, discoverModels, listModels, createModel, putModel, getModelConfig, putModelConfig, listDevices, getDeviceRuntimeStatus, listBots, getBotModelConfig, putBotModelConfig, getCredential, putCredential, deleteCredential, uploadArtifact, listCapabilities, install, getInstallation, renameInstallation, getInstallationConfig, putInstallationConfig, listBotCapabilities, getBotCapability, putBotCapability, validateInstallation, checkUpdates, updateInstallation, rollbackInstallation, disableInstallation, enableInstallation, uninstallInstallation, listActions, runAction, startOAuth, getOAuthFlow, logoutOAuth, listDeployments, getOperation`。参数按上表顺序（路径 ID 在前，body 在后），返回 Promise<对应响应 DTO>；统一 same-origin、session 和 CSRF，并将 ApiError 转为可展示错误。列表/详情查询无密钥。

`center-web/App.tsx` 默认导出 App；`center-web/pages/Login.tsx`、`Providers.tsx`、`Models.tsx`、`Devices.tsx`、`Capabilities.tsx`、`Installation.tsx`、`BotCapabilities.tsx` 分别默认导出无必需 props 的路由组件。路由参数使用 React Router：`/login`、`/providers`、`/providers/:providerId/models`、`/devices`、`/capabilities`、`/capabilities/:installationId`、`/devices/:deviceId/bots/:botId/capabilities`。admin-shell 挂载这些 export；plugin-ui 使用同一 api，不创建另一份业务状态。共享配置表单由 `center-web/components/ConfigForm.tsx` 默认导出，props 为 `{schema: JsonSchema, uiSchema?: JsonObject, globalConfig: JsonObject, overrides?: JsonObject, onSave(value: JsonObject): void}`；有 overrides 时 onSave 仅提交覆盖项，否则提交 global。凭证字段只显示引用及配置状态，不回填秘密。

## 依赖与验收边界

各清单是互相独立的 npm 安装根，父助手生成对应 lockfile；原 root 和 host lock 不在此轮改动。RJSF 同版 6.11.0、deepmerge 4.3.1、npm 11.6.2 来自计划；yaml 2.9.0 来自现有 `pi-runtime/package-lock.json`；pi-mcp 按父助手定案固定 1.3.0（当前 lock 内是 1.1.0），与现有 Pi 配套需实际验收；React/Vite 使用项目已有版本。Fastify 及插件、Ajv、pacote 和 semver 的清单为固定候选版本，未进行 registry/安装/兼容性验证；父助手在 P0 安装时核验，不能将本契约视作已完成库兼容验证。中心 web、server 分别依赖 center-contract，server 专用依赖不进入 Host/Android/浏览器 bundle。

此轮无业务 stub、无新增测试；端到端需验证真实中心/Host/浏览器及设备，尤其在线中断、CAS、秘密边界、数组替换、制品安全、目标平台 npm 和 React 19 表单。
