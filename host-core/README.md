# @e-launcher/host-core

本仓库以根 `package.json` 记录产品版本。Host 的 Pi SDK 采用 `host-core/package-lock.json` 固定的正式 npm 版本，CI 使用 Node.js 26.13.0。`Runtime.prepareUpdate({stopActive?})` 暂停新工作准入并返回真实活动量，`cancelUpdate()` 恢复。维护入口仅在认证的本机 `/v1/service/update` 上暴露。下文的模块计数、环境与验收数字保留历史范围，当前构建和设备诊断以快速入门为准。 [源码构建](../README.md#从源码构建) · [诊断](../docs/center-linux-deployment.md#按层定位故障)

Host 负责 Bot 登记、会话执行与本机工具，客户端 broker 负责连接与观察。中心下发配置及能力部署计划。模块历史和分项验收见后文。 [产品架构](../README.md)

## 实现与边界

- Host 源码包声明的 Node.js 最低版本为 24.22.2，构建与开发使用 CI 的 26.13.0。存储用 Node 内置 SQLite（`node:sqlite`），登记数据库为 `dataRoot/host.sqlite`。新数据目录及库文件由 Host 建立。
- `openHost` 负责登记，`openRuntime` 负责 Pi Durable 会话、受管能力与本机工具。本机客户端使用认证 HTTP/SSE，远端客户端通过设备中继访问固定控制接口。群聊与 Bot 私聊使用独立工作上下文。
- 写入由 SQLite 事务保护，重复请求重试安全。
- `host.sqlite` 仍只保存登记数据，Durable 使用独立的 `durable.sqlite`；`runtime-owner.sqlite` 的 SQLite 事务锁保证单进程所有权。
- Android 使用 APK 内的 Node Mobile 运行 Host。设备验证按对应平台文档的版本和范围理解。 [Android 客户端](../mobile/README.md)
- dataRoot（数据库/记录）与 cwd（工具默认工作目录）分离：不 `process.chdir`；工具在 Bot Host 中运行，以 cwd 为默认工作目录，write/edit 会写入该目录。

## 数据

每个 Bot 恰有一条记录：

```ts
interface BotRecord {
  botId: string;            // node:crypto randomUUID
  deviceId: string;         // 本机身份，跨进程持久
  role: string;             // 原文保留，不规范化
  cwd: string;              // 本机绝对目录；规范化（路径整理）的是 cwd
  modelRef: string | null;  // 缺省 null
  primaryConversationId: string; // 创建时生成的主私聊记录 ID
  createdAt: string;        // ISO 字符串
}
```

Bot 创建后即有主私聊记录；收发消息、推理与历史不属本模块。

## 可导入 API

仓库根目录的 ESM 中直接导入（当前仓库未安装 `@e-launcher/host-core`，不要按未安装的包名导入）：

```js
import { openHost } from './host-core/index.js';

const host = openHost({ dataRoot: '/path/to/data-root' });
try {
  const bot = host.createBot({
    requestId: 'req-001',   // 非空白字符串，保留原文
    role: 'assistant',      // 非空白文本，保留原文
    cwd: '/path/to/cwd',    // 本机绝对目录
    // modelRef 可省略或为 null；字符串须为非空白文本
  });
  host.getBot(bot.botId);        // BotRecord | null
  host.findByRequest('req-001'); // BotRecord | null
  host.listBots();               // 稳定排序的 BotRecord[]
} finally {
  host.close();                  // 幂等，无保活/定时器
}
```

关键语义：

- `createBot` 重复 requestId 且 cwd 规范化后相同、role/requestId 原文相同、modelRef 相同（缺省按 null）：返回原 BotRecord。
- 内容不同：抛 Error，`code='REQUEST_CONFLICT'`，不产生多余数据。
- 重试先按 requestId 查已受理请求，不要求原 cwd 仍存在；只有新请求才 `statSync` 确认目录。
- `getBot`/`findByRequest` 查无返回 null。
- 输入错误 `code='INVALID_ARGUMENT'`；目录不存在/不是目录 `code='INVALID_CWD'`；数据库更高版本 `code='UNSUPPORTED_SCHEMA'`；其他 I/O 与 SQLite 错误不吞。
- 错误用普通 Error.code，不引入框架。

## CLI

```bash
node host-core/cli.js init --data-root '/path/to/data-root'
node host-core/cli.js create   --data-root '/path/to/data-root'   --request-id req-001   --role assistant   --cwd '/path/to/cwd'
```

`create` 返回 BotRecord，抄下 botId 后可用于 `get`：

```bash
BOT_ID='粘贴create返回的botId'
node host-core/cli.js get --data-root '/path/to/data-root' --bot-id "$BOT_ID"
node host-core/cli.js find-request --data-root '/path/to/data-root' --request-id req-001
node host-core/cli.js list --data-root '/path/to/data-root'
```

- `init` 输出 {deviceId, dataRoot}；`create`/`get`/`find-request` 输出 BotRecord 或 null；`list` 输出数组。一条 JSON 到 stdout。
- 应用错误以一条 `{"error":{"code":...,"message":...}}` 输出到 stderr，exitCode=1，finally 中 close。Node 22 的内置 SQLite 还会向 stderr 输出原生 `ExperimentalWarning`，stdout 的 JSON 格式不受影响。
- `--help` 无须 `--data-root`。
- `get` 用 `--bot-id`，`find-request` 用 `--request-id`。

## 文件

- `store.js`：openStore(dataRoot)，返回 {deviceId, createBot, getBot, findByRequest, listBots, close}。
- `host.js`：openHost({dataRoot})，返回 {deviceId, dataRoot, createBot, getBot, findByRequest, listBots, close}。
- `cli.js`：CLI 入口。
- `index.js`：导出 `openHost`、`openRuntime`、`openControlServer`、`openMessageLog`、`openRelayRegistry`、`openRelayServer`、`openDeviceLink`、`openRemoteControl`、`RemoteControlError` 与控制 IO 辅助（`ControlHttpError`、`createControlAuthorizer`、`readControlBody`、`writeControlJson`、`writeControlError`）；模块 14 起另导出 `openHostService`、`openPendingClient`、`openHostSettings`/`normalizeHostSettings`、`normalizeRuntimeConfig`/`parseRuntimeConfig`/`describeModelCatalog`/`loadRuntimeConfig`（随父助手集成）；扩展增量另导出 `normalizeRuntimeExtensions`/`resolveRuntimeExtensions`（内部工具构造器，不属于公开 RPC）。
- `index.d.ts`：登记接口，以及 `Runtime`、`PrimarySubmission`、`HistoryPage`、`OpenRuntimeOptions`（含可选 `bashPath`/`toolPaths`）、模块 6 直播预览类型（`LiveMessage`/`LiveHistoryItem`/`LiveTool`/`LiveGeneration`/`BotLiveState`/`BotLiveChanges`/`BotLiveSnapshot`/`BotLiveUpdate`/`BotLiveDataFrame`/`BotLiveEnd`/`BotLiveFrame`/`BotWatchEnd`/`BotWatch`）、模块 7 消息账本类型（`MessageMember`/`MessageAuthor`/`MessageScope`/`PublishMessageInput`/`MessageEnvelope`/`MessagePeer`/`MessageAck`/`StoredMessage`/`MessageCursor`/`MessagePageOptions`/`MessageOutboxOptions`/`MessageStreamStatus`/`MessageHistoryPage`/`MessageInboxPage`/`MessageOutboxPage`/`MessageDeliveryStatus`/`MessageLog`/`openMessageLog`）、模块 8 中继类型（`RelayDevice`/`RelayRegistry`/`RelayServerStatus`/`RelayServer`/`DeliveryPumpStatus`/`DeviceLinkStatus`/`DeviceLink`/`openRelayRegistry`/`openRelayServer`/`openDeviceLink`，`OpenDeviceLinkOptions.control` 可选）、模块 9 远程控制类型（`RemoteControlOutcome`/`RemoteControlMethodMap`/`OpenRemoteControlOptions`/`RemoteControl`/`RemoteControlError`/`openRemoteControl`）等类型。模块 12 的类型增量（`ScopeCreateInput`/`ScopeUpdateInput`/`ScopeRecord`/`ScopeInfo`/`ScopeAck`/`ScopeListOptions`/`ScopeListPage`/`ScopeOfferOptions`/`ScopeOfferPage`/`ReplicaStream`/`InventoryQuery`/`InventoryPage`/`ReplicaHistoryQuery`/`ReplicaHistoryPage`/`MissingRangeQuery`/`ReplicaListOptions`/`ReplicaListPage`/`UserMessageInput`、MessageLog 新增 17 个门面方法、Runtime 与 ControlClient 各六个方法、`DeviceLinkStatus.scopeDelivery`/`replicaSync`）由模块 12 类型 lane 在 `index.d.ts`/`control-client.d.ts` 补充，随父助手集成。
- 模块 13 的 Hindsight 配置、target、游标、投递/纠正回执类型和八个 Runtime 记忆方法签名，见 `index.d.ts` 与 `control-client.d.ts`。
- `index.d.ts` 的扩展增量：`BotExtensionState`、`BotSoul`、`BotSoulUpdate`、`RuntimeExtensionsConfig`/`HindsightExtensionConfig`，以及 Runtime 的 `initializeBot`/`getBotSoul`/`setBotSoul`、`ControlMethodMap` 的两个新方法与 `normalizeRuntimeExtensions`/`resolveRuntimeExtensions` 声明。
- `index.d.ts` 的模块 10 增量：`MessageInboxOptions`、`WorkContextRecord`、`WorkSyncOptions`、`WorkSyncResult`、`WorkHistoryCursor`、`WorkHistoryPage`、`WorkContextStatus` 与 Runtime 的四个工作上下文方法；不新增根 JS 导出。
- `work-context-docs.js` / `work-context-codec.js` / `runtime-work-contexts.js`：模块 10 的内部持久文档、来源事件编码与被动导入引擎，不作为根 API 导出。
- `index.d.ts` 的模块 11 增量：`MessagePublishGuard`、`MessageInboxItem`、`MessageRepliesPage`、`WorkActivity`；`MessageLog.publish(input, guard?)`、`MessageLog.replies` 和 Runtime 的 `getWorkActivity`/`stopWork`/`resumeWork`。`control-client.d.ts` 为三个本机控制方法复用 `WorkActivity`；不扩展远端方法或根 JS 导出。
- 模块 11 内部模块：`work-decision-state.js` / `work-decision-codec.js`（持久决策与 Host 处理信号）、`runtime-work-decisions.js`（自动处理）、`bot-identity.js` / `communication-tools.js`（权威身份与通信工具）；不作为根 API 导出。
- `messages.js`：模块 7 门面 `openMessageLog({dataRoot})`，组合 openHost 与 openMessageStore；协议边界只验证一次。
- `message-protocol.js`：模块 7 协议校验与规范化（`messageError`/`assertId`/`assertRevision`/`normalizeScope`/`normalizePublish`/`normalizePublishGuard`/`normalizeEnvelope`/`normalizePeer`/`normalizeAck`/`normalizePageOptions`/`streamIdForScope`/`digest`/`assertScopeMessage`）。
- `message-store.js`：`openMessageStore(dataRoot, deviceId)`，建库 `messages.sqlite`（user_version=2）：v0 全新库在初始化事务内一次性建 M7+M12 表；v1 旧库先校验身份行且 deviceId 匹配，再原子执行 `SCOPE_SCHEMA_SQL` 增量迁移到 v2；更高版本拒绝且不 drop/reset。模块 12 在此实现托管作用域存储与副本导入（`createScope`/`updateScope`/`getScopeState`/`listScopeStates`/`getScopeRecord`/`acceptScopeOffer`/`acknowledgeScope`/`recordScopeError`/`scopeOffers`/`replicaInventory`/`replicaHistory`/`nextMissingRange`/`listScopeReplicas`/`listReplicaPeers`/`recordReplicaInventory`/`importReplicaHistory`/`recordReplicaScan`，共 17 个 M12 门面方法）。
- `session-search.js` / `session-search-tool.js`：内置 `session_search` search/read 工具，只扫当前 Bot 的既有主/已绑定工作会话原文；有界、可续页，非 FTS。参数、权限、reset 与游标限制见 [session-search.md](session-search.md)。
- `message-queries.js`：`createMessageQueries(db, {deviceId})` 只读查询（getScope/listScopes/getMessage/history/inbox/replies/outbox/deliveryStatus/streamStatus）；replies 为模块 11 的 DM 直接关联回复查询。
- `message-cli.js`：模块 7 特权离线 CLI（scope/get-scope/scopes/publish/get/receive/ack/history/inbox/outbox/delivery/stream）；输入文件读取复用模块 12 新增的 `cli-input.js`（`readInputObject`）。
- `cli-input.js`：模块 12 抽出的共享输入读取（`invalid`/`readInputObject`，≤1MiB 普通 UTF-8 JSON 文件，保留原有大小/竞态/关闭错误处理；`uploadAttachment` 调用可传 32MiB 读取预算），`message-cli.js`、`control-cli.js`、`remote-control-cli.js`、`pending-cli.js` 与 `host-service.js` 共用；模块 14 起新增 `readTextFile`（普通文件 state/open/fstat、≤1MiB+1 有界 read、严格 UTF-8、size change/FD cleanup），供 CA 与 caFile 读取。
- `scope-protocol.js`：模块 12 协议校验与规范化（`MAX_SCOPE_SYNC_BYTES`/`MAX_SCOPE_CONTROL_BYTES`、`normalizeScopeCreate`/`normalizeScopeUpdate`/`normalizeScopeRecord`/`normalizeScopeListOptions`/`normalizeScopeOfferOptions`/`normalizeScopeAck`/`normalizeInventoryQuery`/`normalizeReplicaStream`/`normalizeInventoryPage`/`normalizeHistoryQuery`/`normalizeHistoryPage`/`normalizeMissingRangeQuery`/`normalizeReplicaListOptions`/`normalizeUserMessage`）。
- `scope-store.js`：模块 12 托管作用域存储（`SCOPE_SCHEMA_SQL` 与 `createScopeStore(db,{deviceId,transaction,queries,installScopeRevision})`，12 个方法）。
- `replica-queries.js`：模块 12 只读副本查询（`createReplicaQueries`：inventory/historyPage/nextMissingRange/listScopeReplicas）。
- `scope-wire.js`：模块 12 scope 业务帧解析（`SCOPE_SYNC_ERROR_CODES`、`readScopeClientFrame`/`readScopeServerFrame`）。
- `scope-delivery.js`：模块 12 元数据投递泵（`createScopeDelivery`：scope-offer/ack/reject/unavailable，在线轮询 `scopeOffers`、ACK 期限 5s、目标退避 1..30s）。
- `replica-sync.js`：模块 12 副本修复泵（`createReplicaSync`：服务并主动发起 inventory/history/缺口补齐与 `recordReplicaScan`）。
- `host-environment.js`：HostExecutionEnv（NodeExecutionEnv 子类）；仅命令字符串经 Git Bash/bash 执行，argv 数组与文件操作直接透传。
- `grep-tool.js` / `find-tool.js` / `ls-tool.js`：grep（rg）、find（fd）、ls 工具。
- `extension-manager.js`：旧 Host 扩展设置读取归一化（`normalizeRuntimeExtensions`/`resolveRuntimeExtensions`）：运行时策略来自中心快照，本模块只解析持久配置形状。
- `bot-soul.js`：每 Bot 真实 `SOUL.md` 文件（`ensureSoul`/`setSoulText`，同目录临时文件 + rename，`SOUL_MAX_BYTES` = 64 KiB）；路径只由内部 botId 生成，不接受调用方拼路径。
- `search-bin.js`：rg/fd 固定版本、asset 规格与解析顺序；`prepare-tools.js`：显式下载并安装 rg/fd 的 CLI。
- `control-client.js` / `control-client.d.ts`：控制客户端（`./control-client` 子路径导出），由协作任务提供；模块 12 增加 `listScopeStates`/`createScope`/`getScopeState`/`updateScope`/`publishUserMessage`/`listScopeReplicas` 六个方法（scope 段沿用 `'~'+encodeURIComponent(scopeId)`，无 Node 导入）；模块 14 增加 `getModelCatalog`/`workLive`/`scopeHistory`/`getScopeMessage`/`getScopeMessageDelivery`/`getLocalSettings`/`replaceLocalSettings`/`getServiceStatus`，扩展增量增加 `getBotSoul`/`setBotSoul`，仍为 web-standard fetch only。
- `control-server-cli.js` / `control-cli.js`：模块 5 两个 CLI；`control-cli.js` 的 `live` 子命令在模块 6 增加，模块 10 增加 `work-get`/`work-sync`/`work-history`/`work-context`，模块 11 增加 `work-activity`/`work-stop`/`work-resume`，模块 12 增加 `scope-list`/`scope-get`/`scope-create`/`scope-update`/`scope-send`/`scope-replicas`（新增通用 `--input` 标志），模块 14 再增加 `models`/`service-status`/`settings-get`/`settings-set`/`work-live`/`scope-history`/`scope-message`/`scope-delivery`，扩展增量再增加 `bot-soul`/`bot-soul-set`，仍经同一本机 HTTP 服务调用；新增命令拒绝无关 flag，重复歧义 flag 拒绝（parseArgs tokens）。
- `runtime-live-projection.js` / `runtime-live.js`：模块 6 直播预览投影与 `Runtime.watch`。
- `control-live.js`：模块 6 SSE 路由 `GET /v1/bots/:botId/live`。
- `control-live-client.js`：模块 6 SSE 流式解析与 `readControlLive`。
- `relay-protocol.js`：模块 8 协议常量、凭证/URL/帧校验与编码（`MAX_RELAY_FRAME_BYTES`/`RELAY_HELLO_TIMEOUT_MS`/`RELAY_CLOSE`/`assertDeviceToken`/`parseRelayUrl`/`readClientFrame`/`readServerFrame`/`encodeRelayFrame`/`DELIVERY_REJECT_CODES`）。模块 12 起 hello/ready 支持可选 `scopeProtocol:1`（仅 host 角色，client 声明或其它值拒绝），业务帧解析委托 `scope-wire.js`；旧 hello→旧 ready 形状不变。
- `relay-registry.js` / `relay-registry-cli.js`：中心设备注册库（`relay.sqlite`，唯一写入口）与唯一写 CLI。
- `relay-server.js` / `relay-server-cli.js`：认证中继服务（WebSocketServer noServer + TLS/loopback 规则）与其 CLI。
- `message-delivery.js`：内部投递泵（不导出），在线扫描 outbox、退避与诊断。
- `device-link.js` / `device-link-cli.js`：Host 链路（ws 客户端、Hello/ready、所有权锁、重连/blocked）与其 CLI；模块 9 起 `device-link-cli` 增加可选配对 `--control-url` 与 `--control-token-env`，配置控制适配器后 hello 带 `role:'host',controlProtocol:1`。模块 12 起 hello 恒带 `scopeProtocol:1`，ready 必须回显 `scopeProtocol:1` 否则以 `UNSUPPORTED_SCOPE_PROTOCOL` 永久阻塞；内部实例化 `scope-delivery.js`/`replica-sync.js` 两泵，`getStatus()` 新增 `scopeDelivery`/`replicaSync` 两节，公共 `wake()` 唤醒三泵。
- `remote-control-protocol.js`：模块 9 协议常量与方向性帧校验（`CONTROL_METHODS`/`CONTROL_ERROR_CODES`/`MAX_CONTROL_JSON_BYTES`/`CONTROL_TIMEOUT_MS`/`CONTROL_CLIENT_TIMEOUT_MS`/`CONTROL_MAX_CLIENT_CALLS`/`CONTROL_MAX_HOST_CALLS`/`CONTROL_MAX_PENDING`/`normalizeControlCall`/`readControlClientFrame`/`readControlServerFrame`）；模块 14 起 `CONTROL_METHODS` 为旧十方法 + v2 方法表（现共 40：M14 的固定 25 个不变，另加扩展/SOUL 5 个；`CONTROL_V1_METHODS`/`controlMethodVersion` 见同文件）。Hindsight 超时链常量与辅助（`HINDSIGHT_MAX_TIMEOUT_MS` 由 `hindsight-client.js` 导出；本文件为 `CONTROL_MEMORY_DEADLINE_MS`/`CONTROL_MEMORY_CLIENT_DEADLINE_MS`/`CONTROL_MEMORY_BROKER_DEADLINE_MS`/`MEMORY_HTTP_INACTIVITY_MS`、`isMemoryControlMethod`/`controlMethodTimeoutMs`/`controlClientTimeoutMs`/`controlBrokerTimeoutMs`）只对八个 memory 方法放宽，其余 RPC 仍用原 `CONTROL_TIMEOUT_MS`/`CONTROL_CLIENT_TIMEOUT_MS`。
- `relay-server.js`：模块 8/9 认证中继服务（WebSocketServer noServer + TLS/loopback 规则、control-* 有界路由与清理）。模块 12 增加 scope 业务帧路由：仅已协商 `scopeProtocol:1` 的 host 连接可发送；来源注入 `fromDeviceId`；离线/吊销回 `scope-unavailable`/`replica-unavailable` OFFLINE，目标无能力回 UNSUPPORTED，高水位/编码失败回 BACKPRESSURE；ack/reject/result 为临时帧，目标不可用时静默丢弃；不保存任何 scope/成员/历史状态。
- `local-control-adapter.js`：`createLocalControlAdapter({url,token})`，目标本机回环 Control API 适配（仅字面 `http://127.0.0.1` 或 `http://[::1]`，路径 `/`）。
- `host-control.js`：`createHostControlReceiver({deviceId,execute,send})`，Host 侧控制接收器（最多 8 个活动调用、无队列）。
- `remote-control-client.js`：模块 9 Node 控制客户端（`openRemoteControl`/`RemoteControlError`）。
- `remote-control-cli.js`：模块 9 一次性控制 CLI；模块 14 起按 `CONTROL_METHODS` 动态列出现行方法表（现共 37 个），另有保留命令 `listDevices`/`live`（非 Host JSON 方法），`--input` 经 `normalizeControlCall`/`normalizeDevicesOptions`/`normalizeLiveTarget` 校验；SIGINT/SIGTERM 退出 130/143，EPIPE 取消观察正常退 0，任何取消不发送 abort 控制方法。

### Cua driver（内置计算机控制驱动）

- `cua-driver.js`：导出 `resolveCuaDriverPath()`，同步返回当前平台已存在的 `cua-driver`/`cua-driver.exe` 绝对路径；供 Linux/Windows Shower 后端在其私有图形会话内以 `['mcp','--direct']` 启动。解析顺序：环境变量 `E_LAUNCHER_CUA_DRIVER`（仅接受已存在的绝对路径）→ 模块旁的已准备目录 `host-core/cua-driver/<platform-arch>/`。Linux 下额外校验可执行权限。不支持的平台/架构、缺失或不可执行均抛 `code = 'SHOWER_UNAVAILABLE'`。运行时只按 `process.platform` 决定文件名，不读取版本清单、不查 PATH、不下载、不回退主桌面。同文件还导出 `loadCuaToolInventory()`：Host 启动时对已解析的固定二进制执行只读 CLI metadata（`list-tools` 取名字、`describe <name>` 取完整 description/inputSchema，与私有子会话内 MCP tools/list 同源），`DO_NOT_TRACK=1`、`windowsHide`、有界输出与超时、并发 ≤4、进程内一次缓存；失败抛 `SHOWER_UNAVAILABLE` 且不缓存。它只查询 metadata，不启动 `mcp --direct`、不运行安装/更新/自启、不 ensure 虚拟屏、不扫描 PATH。cua-tools 按该 inventory 逐项注册 `cua_<remoteName>` 内置工具，description/inputSchema 保留上游内容（仅附加 Shower 约束提示），不写死名单、不按数量裁剪、无包装器；参数由框架按上游 schema 校验，无调用前 tools/list + Ajv 二次校验。每个 cua_* 声明 `structuredOutputSchema` 返回 `{content, isError}`：无 schema 时 pi-durable codemode 只拼接文本、图片块在交给脚本前被过滤；`structuredOutput` 复用同一批已限额/校验的 output 块，不透传未限额 raw MCP。模型直接调用时 output 渲染不变；codemode 脚本须显式 `text(block.text)`/`image(block)` 将各块传给模型。
- `build-cua-driver.js`：一次性准备命令 `node host-core/build-cua-driver.js`（npm 脚本 `build:cua-driver`）。下载固定版本 `cua-driver-rs-v0.38.0`（上游 tag commit `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`）的官方 binary 归档，SHA-256 校验后解压（`.tar.gz` 用仓库内 `tar` 依赖，`.zip` 用 Windows `System32/tar.exe`），核对必需文件集与 PE/ELF 头、补 `LICENSE`、Linux 置可执行位，再原子安装到 `host-core/cua-driver/<platform-arch>/`。该目录被 `host-core/.gitignore` 忽略，不入库。缓存命中要求整组必需文件齐全且驱动哈希匹配，缺任一文件即重新准备。不运行上游安装脚本、不注册开机项、不写 PATH。
- `cua-driver-release.json`：随源码入库的固定版本清单（版本、上游 commit、两平台归档 URL/SHA-256/期望文件集）。仅 `build-cua-driver.js` 使用。
- `licenses/cua/`：归档未附带许可文本，`LICENSE-MIT.txt` 为逐字复制的上游 `LICENSE.md`（同 commit），`README.md` 记录来源。

部署：Cua driver 属于 Host 运行资源而非客户端包。按现有 host-core 分发方式（源码/手工部署），在 Host 所在机器上执行 `node host-core/build-cua-driver.js` 生成 `host-core/cua-driver/<platform-arch>/`，随 host-core 目录一起部署即可；若部署环境不能在该机准备，则把已构建的 `cua-driver` 目录复制到 host-core 下，或用 `E_LAUNCHER_CUA_DRIVER` 指向已安装的可执行文件绝对路径。当前仅支持 Windows/Linux x64。

## 本次模块验收

父助手在 Windows / Git Bash 下以 Node 26.8.2 和最低版本 Node 22.19.0 执行了真实 CLI 跨进程验证：创建、列举、两种查询、重启后身份与记录稳定、重复请求、请求冲突和输入错误均通过。8 个进程并发首次建库及提交同一请求，最终只保留一个 Bot；不同请求并发也能完整保存。

通过 SQLite 触发器模拟 Bot 写入后、主私聊写入前的失败，确认 Bot、主私聊及请求记录一起回滚，修复后同请求可正常提交。更高版本、未知表结构和损坏数据库均被拒绝且原文件保持不变；外键、完整性检查及公开类型声明检查通过。

验收数据与报告保存在仓库外临时目录，没有新增测试文件。Android 和 Linux 尚未运行本模块；本次验收不包含 Durable/BC 或现有 Android 应用集成。

## 模块 2：Durable 长期主私聊

当前依赖固定为 Pi SDK 正式 npm 版本。从仓库根运行 `npm ci --prefix host-core`，按锁文件安装。

模块 1 的同步 API、创建幂等语义和 `host.sqlite` schema v1 均保留。Bot 的公开主私聊 UUID 与 Durable 内部数字会话 ID 在同一 Durable commit 中建立映射；不是把旧 SDK 的 Session 或运行检查点直接导入。

### 显式模型配置

当前配置入口支持 OpenAI completions 兼容服务。将以下 JSON 保存到仓库外的 `runtime-config.json`，按实际服务修改 URL 和模型：

```json
{
  "defaultModel": "local/model",
  "providers": [{
    "id": "local",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "apiKeyEnv": "HOST_MODEL_API_KEY",
    "models": [{"id": "model", "contextWindow": 32768, "maxTokens": 1024}]
  }]
}
```

`apiKeyEnv` 指定环境变量名，凭证仅在请求时从该变量读取，不写入 Bot、历史或中心；无密钥的本地服务可明确省略此字段。模块不扫描、迁移或覆盖旧 `models.json` / `auth.json`，不执行密钥命令，暂未迁移 OAuth。`modelRef` 已指定的 Bot 使用自身选择；为空时，首次主私聊采用配置中的默认值并持久保存，以后改变默认值不自动替换已有会话模型。配置可选包含 `bashPath` 与 `toolPaths`（见模块 4），解析后传给 `openRuntime`。

`thinkingLevel` 可设置 `off/minimal/low/medium/high/xhigh/max`；省略或设为 `null` 使用 SDK 默认值。它应用于主会话和工作会话，设置热更新后在后续会话配置时生效。Provider 的 `api` 支持 `openai-completions`（缺省）、`openai-responses`、`anthropic-messages`、`pi-messages`，未知 API 显式拒绝。模型可提供 `input`、`cost`（含价格分档）、`compat`、`thinkingLevelMap` 和 `inputLimits`，保留原配置的视觉能力、兼容设置和预算。

### 命令与 API

```bash
DATA_ROOT='/path/to/host-data'
CONFIG='/path/to/runtime-config.json'
BOT_ID='粘贴登记接口返回的botId'
node host-core/runtime-cli.js send --data-root "$DATA_ROOT" --config "$CONFIG" --bot-id "$BOT_ID" --request-id message-001 --text '你好'
node host-core/runtime-cli.js status --data-root "$DATA_ROOT" --bot-id "$BOT_ID" --request-id message-001
node host-core/runtime-cli.js history --data-root "$DATA_ROOT" --bot-id "$BOT_ID" --limit 50
node host-core/runtime-cli.js wait --data-root "$DATA_ROOT" --config "$CONFIG" --bot-id "$BOT_ID" --request-id message-001
```

从仓库根 ESM 可导入 `openRuntime`。它接收 `{dataRoot, models?, defaultModel?, thinkingLevel?, bashPath?, toolPaths?}`，其中 `models` 为 pi-ai 的 Models 集合；省略时为空集合，可用于不调用模型的历史和回执查询。`bashPath`/`toolPaths` 见模块 4。运行时提供：

| 方法 | 语义 |
| --- | --- |
| `submit(botId, {requestId, text})` | 持久提交输入并返回受理状态 |
| `wait(botId, requestId)` | 等待已有提交，进行中工作可恢复；已结束回执直接返回 |
| `getSubmission(botId, requestId)` | 被动查询，无此提交返回 null |
| `history(botId, {limit?, cursor?, chunked?})` | 原始条目按时间顺序分页，默认 50，上限 200；`chunked:true` 按字节分页并无损分片大条目 |
| `abort(botId)` | 停止该主私聊的当前执行与待处理输入，等待确认 |
| `resume()` | 恢复原生持久任务；模块 11 起还幂等激活群/DM 自动处理，可产生新的工作决策输入（见模块 11） |
| `close()` | 幂等关闭资源，保留未完成工作供之后恢复 |

提交回执包含公开 `botId` / `conversationId`、`requestId`、Durable `submissionId`、`status`、`answerText` 和 `reason`。状态为 queued、placed、done 或 unanswered。相同请求 ID 和相同正文返回原提交；正文不同报 `REQUEST_CONFLICT`。已失败的提交重试相同 ID 仍返回失败回执，继续对话应发送新请求 ID。

历史页的 `nextCursor` 只用于对应 Host、Bot 和扫描条件，调用方应原样传回。历史和 status 不启动模型；未有 Durable 会话时返回空历史/空回执。运行时已被其他进程持有时报 `RUNTIME_BUSY`，不会打开第二个写入者；进程崩溃后由操作系统释放锁。

成功命令输出一行 JSON；send/wait 得到 unanswered 时仍输出回执并退出 2；参数、配置、存储错误写 JSON error 到 stderr 并退出 1。Node 22 可能同时输出 SQLite 的原生实验性警告。

### 恢复与范围

正常关闭与进程中断都保留 Durable 的受理记录和执行状态。重新打开后可先被动查询，再通过 wait 或 resume 恢复；不要为了恢复编造新请求 ID。请求正文摘要与提交之间存在未确认窗口：若回执未返回，调用方保留原 ID 与正文重试。被中断的模型请求可能重新发送，不承诺外部请求恰好执行一次。

冷启动顺序（openRuntime → 中心快照 apply → resume）：Harness open 把存活 running 任务改回 pending 但不派发，调度保持 paused。此阶段初始化只 ensureBotSoul，不用空模型/插件 profile 重写已持久化 AgentDoc（否则恢复任务丢工具、记 toolsRemoved/interrupted）；配置应用的空闲门槛在调度 paused 时把磁盘遗留 pending 视为可恢复而非忙碌，先恢复已授权模型/插件注册/profile，随后 HostService 才 resume 接管任务。正常调度期 botIsIdle 保护不变。

全部 Bot 沿用 SDK 默认自动 compaction（阈值/后台触发与一次 provider 溢出压缩重试），不再强制关闭；BC 插件与原生压缩可共存，两者不互斥。本模块没有注册文件、命令或屏幕工具，没有替换旧 Android/Capacitor 运行链路。

### 模块 2 验收

父助手在 Windows / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 143 个端到端检查点及公开类型声明检查。模型服务采用本地可控的 OpenAI completions SSE 服务，未调用付费模型或读取真实模型凭证。

验证覆盖跨进程主私聊、原始历史分页、不同 Bot 上下文隔离、持久模型选择、请求去重与冲突、错误回执、单进程所有权、强制结束进程后的同 ID 恢复、主动停止、关闭后释放所有权，以及已结束等待不启动其他待处理工作。报告与验证数据保存在仓库外，没有新增测试文件；Linux、Android 和外部真实模型服务尚未验收。

## 模块 3：受管 Billion Context 插件

受管插件使用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 0.0.101 管理长期上下文，不需要另外启动 bili 或代理；新 Host 不内嵌 BC。以下迁移步骤仅适用于从旧内嵌 BC 版本升级：先在中心上传并安装插件实例且保持 Bot 绑定关闭，停止旧 Host 并保留数据后才启用目标 Bot 绑定，再更新并启动新 Host，等待安装及 snapshot/profile 应用完成后恢复调度；不要在旧 Host 运行时下发启用，旧内置工具与插件原名冲突。详细步骤见 [插件 README](../plugins/billion-context/README.md)。中心安装并全局启用后给无显式绑定的既有/新 Bot 默认启用 BC（安装本身实例初始停用），显式 false 与已有 overrides 原样保留；未启用的 Bot 只跑 SDK 原生压缩与最终预算检查。上游负责范围选择、分层压缩、引用、摘要投影与搜索；摘要由模型通过工具提供。完整条款及署名见 [第三方声明](../THIRD_PARTY_NOTICES.md#acp-kernel)。

### 持久状态和请求投影

BC 状态按 Durable conversation 保存，公开 Bot/主私聊身份保持不变。消息身份来自 Durable EntryId 与 entry 内消息下标，不依赖正文哈希或请求数组位置；相同正文的两条消息有不同引用。

每次模型请求前，已启用的插件读取该生成任务 cutoff 对应的历史视图，把 kernel 状态、内容存储和请求投影放在同一次宿主 commit 中。它与随后保存模型回复的 commit 分开。相同逻辑请求的重试/恢复复用持久投影，不重复分配引用、推进块存活次数或追加提醒。缓存值在事务内复制为普通 JSON，不把已结束事务的草稿传给模型。

kernel 的增长/压力决策由插件渲染为临时上下文提醒；窗口占用估计按已折叠投影计算。原始人类输入不带压缩标签，摘要和提醒不伪装成人类消息写回历史。SDK 原生摘要使上下文 head 前移后，BC 在其现有投影增量上重建；两套机制并行生效，不互相改写对方产物。

本模块折叠纯文本 user/assistant 消息。system、thinking、工具调用/结果和图像等复杂内容原样保留并排除折叠，结构化参数与签名不被标签改写；工具结果不进一步卸载，模块 4 保持同一保护。

### 上下文工具

以下为实际注册的原工具名，保留旧待执行工具任务的名称；会话的 selectedExtensions 与所有权检查隔离 Bot。

| 功能 | 当前能力 |
| --- | --- |
| `compress` | 复用上游参数 schema 与解析器，提交模型摘要、范围和来源；以 Durable 工具 taskId 持久去重 |
| `decompress` | 按 blockId 内联返回真实原文/嵌套块内容，块保持折叠；当前不支持 toFile |
| `search_context` | 使用上游统一检索入口查询摘要与原始消息，返回引用、来源块、分数与预览 |
| `acp_status` | 查询该 conversation 的压缩状态、引用及窗口估计 |

工具只能使用自身运行中的 conversation 范围，不接受模型自报 Bot/聊天身份。不同 Bot 的 refs 和原文索引分别保存。统一检索沿用上游 hybrid 规则，可返回模糊相似词；结果携带实际来源，原文查找后可按所属 blockId 展开。

### 被动查询与兼容

Runtime 保留 `contextStatus(botId)` 与 `workContextStatus(botId, scopeId)`，通过已启用插件的 `contextStatus` 动作查询。

插件对该 Bot 启用时，该查询不创建会话或启动调度，返回块、refs 与已准备请求的元信息，不返回缓存模型消息全文；未开始的 Bot 返回空状态。插件禁用或卸载时返回 `EXTENSION_DISABLED`。

模块 2 旧会话在显式提供 models 的主动打开路径中解除旧 tools:[] 限制，身份和历史保留；被动历史/状态读取不执行该升级。未知 kernel 版本被拒绝，不自动重置或套用当前格式，原始历史仍可读取。

### 大历史传输

手机和桌面聊天使用 `history(..., {chunked:true})`，完整条目按约 256 KiB 的字节预算分页。单条记录较大时返回 `entryChunk:{entryId,offset,json,complete}`，`offset` 以 UTF-16 单元计数，客户端沿不透明的 `nextCursor` 收齐 JSON 后还原完整记录。分片可出现空 `items`，须继续读取；只有完整记录才进入聊天状态。该预算不限制历史总量或单条记录大小，不截断或修改持久化原文。未传 `chunked` 的 Runtime/CLI 查询仍返回原始条目。旧 Host 不识别此模式时，客户端回退普通分页并在超限时减少每页条数；单条记录超出旧帧上限时仍需更新该 Host。现有 32 MiB 控制帧上限保持不变。

### 模块 3 历史验收（迁移前内嵌实现）

以下是旧实现的历史结果，不代表本次受管插件迁移已通过验收。父助手完成 69 个端到端检查点及公开类型声明检查，使用 Windows / Git Bash、Node 26.8.2 和最低版本 22.19.0，以及本地可控 SSE 模型服务。

验证包括：原文逐条保留、相同正文引用独立、实际请求采用摘要、真实原文展开、摘要与原文检索、Bot 范围隔离、自动提醒进入模型请求但不写原始人类历史，以及进程强杀后复用同一投影。另以 SQLite 故障注入验证：压缩状态已保存但工具回执写入失败，恢复后仍只有原来的摘要块；重复的模型 toolCallId 不会误用其他工具任务的回执。

未知 kernel 状态的主动执行与上下文查询被拒绝且数据库不变，原始历史仍可读。数据和报告保存在仓库外，没有新增测试文件；Linux/Android 和真实外部模型费用尚未验收。

## 模块 4：本机工具

本机工具已接入 Runtime：read/write/edit/bash 来自 pi-durable 的 coding-tools，grep/find/ls 是模块 4 的原生适配（rg/fd/文件 API）。工具在 Bot Host 上执行，cwd 默认位置不是沙盒；运行时不 `process.chdir`，按 conversation+cwd 缓存执行环境，`close()` 时清理环境进程。

### 命令环境

Windows 只在固定 Git 安装目录（ProgramFiles/ProgramFiles(x86)/LOCALAPPDATA 下的 Git/bin 与 Git/usr/bin）寻找 bash.exe，Linux 固定 `/bin/bash`、`/usr/bin/bash`；均不搜索 PATH，也不提供 PowerShell。缺少 bash 只影响 bash 工具，read/write/edit/ls/grep/find 不受影响。`openRuntime` 或运行时配置接受可选 `bashPath`（绝对路径的 bash/bash.exe）与 `toolPaths`（`{rg, fd}` 绝对路径）；仅 undefined 表示未提供，显式 null 与类型错误报 `INVALID_ARGUMENT`，路径存在性在工具实际使用时才检查。

### 搜索二进制定位与准备

grep/find 使用的 rg/fd 按序定位：显式 `toolPaths` -> dataRoot 固定版本安装（`<dataRoot>/tools/<platform>-<arch>/<name>-<version>/`）-> Pi agent bin 目录（PI_AGENT_DIR/bin 与 ~/.pi/agent/bin）-> PATH（Linux 上 fd 额外识别 `fdfind`）。模型调用不会触发下载；只有显式运行安装命令才会下载：

```bash
node host-core/prepare-tools.js --data-root '/path/to/data-root'
```

安装 rg 15.1.0 / fd 10.3.0：使用系统 curl/tar（Windows 优先 System32 的 curl.exe，缺失时回退 PATH 上的 curl；tar 仅用 System32 的 tar.exe，无 PowerShell 回退），从固定官方 GitHub release 下载固定 asset，tar 流式提取固定 entry 到 stdout（不落盘解压），校验 PE/ELF 头；`LICENSE-MIT` entry 随下载保存到安装目录，binary 先写临时文件再原子 rename 发布，返回安装结果含 sha256 指纹。目前仅 Windows x64 上实际运行过资源安装；Linux/arm64 与四平台完整验收未完成。

### 工具边界

- `find`：picomatch 4.0.7 过滤 glob（dot 含隐藏文件、nonegate/strictBrackets、无斜杠模式按基名匹配），fd 以空正则枚举全部文件并负责 gitignore 遍历（`--hidden`、排除 `.git`，非 git 仓库加 `--no-require-git`）；NUL 分帧逐条过滤（`--print0`），每条路径独立校验与匹配。默认 1000 条（上限 10000）：fd 收集 limit+1 条即只取消本次扫描自身进程；输出 50KB、60 秒超时；坏 glob 报 invalid_pattern 错误，目标不存在等非零退出报错。

- `grep`：rg `--json` 流按记录解析，单条 JSON 记录 64KiB 上限，每行按 500 Unicode 码点截断（带 … 标记），可见输出 50KB，默认 100 条匹配（上限 10000），60 秒超时；命中限额/大小界时只取消本次扫描自身的进程。尊重 .gitignore（仓库内外），单文件搜索从其父目录启动。

- `ls`：纯文件 API（环境 `openDirReader`），无外部程序；字母序（大小写不敏感）、含 dotfile、目录加 `/` 后缀、不跟随符号链接、不递归；默认 500 条（上限 10000）、输出 50KB。

### 重放与副作用

工具沿用 Durable 原生安全语义重放，不承诺外部 shell 副作用 exactly-once（bash 已写文件、操作应用或产生外部效果而结果未知时核查或报告不确定）。模块 3 对 system/thinking/工具调用与结果等复杂内容的原文保护继续生效，模块 4 未做进一步的结果卸载。

### 模块 4 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 和最低版本 Node 22.19.0 下完成 33 个模型工具协议场景、168 个端到端检查点及公开类型声明检查，全部通过。模型使用本地可控的 OpenAI completions SSE 服务，未调用付费模型或读取真实模型凭证。

验证覆盖七个工具的实际往返、中文/空格/emoji 路径、Bot 工作目录、文件读写和精确替换、Git Bash、gitignore 仓库边界、Windows 递归 glob 的零层匹配、隐藏文件、Unicode smart-case、坏参数及错误回执。2105 个文件的目录分页、2105 行 find、3000 行 grep、50KiB 输出限额、长行 Unicode 截断、超时终止和可跨关闭读取的完整输出文件均通过。Node 22 清空 PATH 后仍通过完整工具流程；显式缺失程序不影响文件工具，也不静默回退。

资源准备命令已真实下载并安装固定 rg/fd、保存许可证，重复准备结果稳定；导入模块不执行 CLI。错误配置在创建 Host 数据前被拒绝。强制结束进程后，同一 submissionId 恢复完成，中断的 unsafe Bash 返回可能已部分执行的错误信息，已发生的写入没有重放；恢复后仍应按工具回执核对外部副作用。

数据与 module4-verification.json 报告保存在仓库外，没有新增测试文件。Linux、Android、arm64、真实外部模型服务及设备 UI 尚未验收；旧 Android 运行链路未被替换。

## 模块 5：本机控制面（长期 Host 控制 API）

模块 5 为长期运行的本机 Host 增加受认证的控制 API：一个常驻服务进程持有同一个 openRuntime（唯一运行时）与 openHost registry 连接，客户端经回环 HTTP 控制该 Host。本模块只提供基础 HTTP 服务与 Node/浏览器兼容客户端，**没有**实现 SSE、框架隧道、中心或 Tauri 外壳；不要据此宣称这些能力已就绪。

### 服务端

```js
import { openControlServer } from "./host-core/index.js";

const control = await openControlServer({
  dataRoot: "/path/to/data-root",
  token: "…32-512位 URL-safe 不透明字符串…", // 必填
  // port 可选：默认 8787，0 表示系统分配；固定绑定 127.0.0.1
  // models/defaultModel/bashPath/toolPaths 同 openRuntime（模块 2/4）
});
console.log(control.deviceId, control.url);
await control.close(); // 幂等：先关 listener/连接与进行中 handler，再关 runtime、registry
```

- 先校验 token 再打开任何数据；服务只监听回环地址，不暴露给外部网卡。
- 生命周期：每服务一个 openRuntime 加一个 openHost registry 连接（同一 `host.sqlite`，不启动第二个 runtime）；listen 成功后才调用一次 `resume()`（模块 11 起也激活群/DM 自动处理，不是被动查询服务）。没有任何按请求关闭或客户端断开关闭；`close()` 幂等，任何一步失败仍继续后续清理并最终抛出；优雅关闭保留未完成 Durable 状态，这与 `abort` 是不同的概念。
- 认证：所有请求必须带 `Authorization: Bearer <token>`，token 须匹配 `/^[A-Za-z0-9_-]{32,512}$/`；校验在打开数据前完成，使用 timing-safe 比较。任何携带 `Origin` 头的请求一律拒绝（服务不是开放跨源网页 API；移动 WebView 应用 native fetch 适配，不发送 Origin）。不记录 token，不提供 CORS 通配，不接受 token 查询参数。

### 路由

| 方法与路径 | 请求体 | 成功响应 |
| --- | --- | --- |
| GET `/v1/host` | — | 200 `{protocolVersion:1, deviceId, platform, arch}`（不含 dataRoot/模型凭证） |
| GET `/v1/bots` | — | 200 `BotRecord[]` |
| POST `/v1/bots` | `{requestId, role, cwd}` | 201 `BotRecord`（Host 确认真实 cwd 并去重，注册成功以 Host 回执为准） |
| GET `/v1/bots/:botId` | — | 200 `BotRecord`，否则 404 `BOT_NOT_FOUND` |
| GET `/v1/bot-requests/:requestId` | — | 200 `BotRecord`，否则 404 `BOT_REQUEST_NOT_FOUND` |
| POST `/v1/bots/:botId/submissions` | `{requestId, text}` | 202 `PrimarySubmission`（只受理，决不等待回答） |
| GET `/v1/bots/:botId/submissions/:requestId` | — | 200 `PrimarySubmission`，否则 404 `SUBMISSION_NOT_FOUND` |
| GET `/v1/bots/:botId/history?limit=&cursor=&chunked=true` | — | 200 `HistoryPage`；limit 须为严格正整数十进制数，cursor 须为 JSON 对象，chunked 为可选布尔值 |
| POST `/v1/bots/:botId/abort` | — | 200 `{botId}`；显式停止，客户端断开不是 abort |
| POST `/v1/bots/:botId/history/clear` | — | 200 `{botId, conversationId, clearedThroughEntryId}`；用 SDK `pi.reset` 开新上下文，不新建会话 |
| POST `/v1/bots/:botId/compact` | — | 200 `{botId, conversationId, compacted}`；等手动压缩任务终态，无可压内容时 `compacted:false` |
| GET `/v1/bots/:botId/context` | — | 200 `ContextStatus` |

错误响应统一为 `{"error":{"code":...,"message":...}}`（不带堆栈、不泄漏 token）。错误码到 HTTP 状态映射：`INVALID_ARGUMENT`/`INVALID_CWD`→400，`REQUEST_CONFLICT`/`MODEL_REQUIRED`/`MODEL_NOT_FOUND`/`RUNTIME_BUSY`→409，`BOT_NOT_FOUND`/`BOT_REQUEST_NOT_FOUND`/`SUBMISSION_NOT_FOUND`→404，`UNSUPPORTED_SCHEMA`→503，其他代码返回 500，并保留已有错误码；没有错误码时使用 `INTERNAL`；另有 `UNAUTHORIZED`→401、`ORIGIN_FORBIDDEN`→403、`REQUEST_TOO_LARGE`→413、`UNSUPPORTED_MEDIA_TYPE`→415、`METHOD_NOT_ALLOWED`→405、`NOT_FOUND`→404。

### Bot 看板只读批量快照

`POST /v1/bot-board` / additive v2 `getBotBoard`，参数仅 `{botIds:string[]}`。
数组最多 64 项（允许空数组），ID 沿用非空、well-formed、最多 256 UTF-8 字节约束；重复 ID 保留首次顺序。
Runtime 与 ControlClient 同名方法接收该参数对象。响应为
`{updatedAt,items,errors}`，缺失 Bot 返回单项 `BOT_NOT_FOUND`，不可读快照返回安全固定文案的
`BOARD_UNAVAILABLE`，不阻断其他 Bot；整个请求参数错误为 `INVALID_ARGUMENT`。

远程看板要求中心（含 relay 控制方法白名单）与 Host 一起更新；仅更新 Host 时，旧中心会将新增的 `getBotBoard` 方法拒绝为 `BAD_FRAME`。

- 每项仅 `botId,conversationId,activity,queuedCount,attention,progress,lastResult`；conversationId 始终是公开 UUID。
- activity 复用聊天九相及 Host admission/work/control 优先级，不添加看板专属 phase。
- 被动恢复 admission/work 元数据后，逐 Bot 短暂取得原生 watch，只捕获一次 `native.value`，不启动连续监听，等待该 view 的归属与详情读取完成后 finally 释放；不创建会话、不 resume/nudge、不调用能力 action，也不占 broker live 订阅额度。直接本机 HTTP/Runtime 在 Center 离线和 maintenance 时仍允许；远端保留既有传输鉴权与连接门禁。
- attention 仅取当前 running 工具槽中 pending 的安全 questionnaire presentation，摘要最多 200 字符，count 为该问卷题数；不扫历史问卷。
- progress 读取当前 `e-launcher.todos` v1 Durable 文档，只返回完成数、总数和 in_progress 任务标题（最多 200 字符）；空列表为 null。固定 SDK 的 ConversationView 只挂载 pi.*，所以此处用同契约 token 被动 snapshot。
- `host.bot-board-result` 保存本次启用后最新成功答复：公共 GenerationTask.beforeRequest 换轮失效旧结果；afterRun 用已提交 answer entry 的文本块生成最多 500 字符摘要（不含 thinking/工具参数），entry ID 作稳定字符串 id，首次索引提交时间作 completedAt。幂等重跑不更新时间；不回填旧历史。
- 有 run、afterRun 收尾、队列、停止、失败或压缩时 lastResult 为 null；仅真正 idle 才展示已持久成功。停止起始与结算同事务失效结果；clearHistory 后清理索引，读取还检查 answer 之后的 pi.reset，覆盖 reset 已提交但索引清理前崩溃的窗口。重启读取持久索引，不从 idle/最后模型正文/lastActivityAt 猜成功。

### 对话命令 `/clear` 与 `/compact`

聊天输入框的 slash 命令只有这两个，均经控制面的同名 additive v2 方法（`clearHistory`/`compact`，params 仅 `{botId}`）执行，不进入模型 submit 或 pending 队列；执行中不接受第二个命令，后端成功后才清输入框，失败/离线保留命令草稿并显示原因。

- `/clear`：`Runtime.clearHistory` 在 Bot 准入内先确认主会话无排队提交/活动任务（含手动压缩），再调用 SDK `conversation.reset(undefined, CTX)` 写入 `pi.reset` 开新上下文（自动压缩保持 SDK 默认开启；手动压缩是独立的 conversation 级任务，不受影响）。原始持久条目保留以维持 requestId 回执/去重；`history` 读取时倒序沿 cursor 扫到最近一次 `pi.reset`（不设扫描上限），再用 `minEntryId` 只返回其后的条目，因此重开/其他客户端也不再显示清空前的消息。返回的 `clearedThroughEntryId` 是该 reset 条目的真实 id（取 `conversation.context().head`，不是猜测；无会话为 0），是客户端唯一可见历史水位。
- `/compact`：`Runtime.compact` 在准入内只创建手动压缩任务，`waitForTask` 等终态与摘要落地在准入外（不长期占用 Bot FIFO，第二个命令仍因活动任务而被 `RUNTIME_BUSY` 拒绝）。任务失败/中止抛 `COMPACTION_FAILED`；任务返回 `submissionId` 时还要求该 write 已 `done`（会话空闲时 SDK 在同一个 terminal commit 内落地），否则不算成功。返回 `compacted:false` 表示没有可压缩内容（无会话或任务结果无 summary）。压缩沿用长运行超时链（与 memory 方法同一组 135s/140s/145s 期限和 130s HTTP 空闲窗口），不把入队当成功。
- 两个方法都是归档 Bot 只读（`BOT_ARCHIVED`），主会话有活动任务/排队提交时 `RUNTIME_BUSY`；手动压缩任务本身也计入该检查，避免对正在压缩的会话重复压缩或清空。

### 控制 CLI（常驻）

```bash
export CONTROL_TOKEN="$(openssl rand -hex 32)"
node host-core/control-server-cli.js \
  --data-root "$DATA_ROOT" --config "$CONFIG" \
  --token-env CONTROL_TOKEN --port 8787
```

- 必须提供 `--data-root`、`--config`、`--token-env`；`--port` 可选（0..65535）。环境变量名会被校验；配置通过 `loadRuntimeConfig` 显式读取（模型配置见模块 2）。
- 就绪后向 stdout 输出一行 `{"event":"listening","deviceId":...,"url":...}`，随后保持存活；收到 SIGINT/SIGTERM 时关闭一次。
- 服务 CLI 还接受私有 stdin：输入一行 `shutdown` 触发优雅关闭，供本机进程管理使用；EOF 不会停止 Agent，HTTP 没有 shutdown 端点。

### 控制 CLI（命令）

```bash
node host-core/control-cli.js <host|create|list|get|find-request|send|status|history|abort|context> \
  --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN [核心 CLI 风格参数]
```

- `create` 需要 `--request-id --role --cwd`；`get` 用 `--bot-id`；`find-request` 用 `--request-id`；`send` 用 `--bot-id --request-id --text`；`status` 用 `--bot-id --request-id`；`history` 支持 `--limit --cursor`；`abort`/`context` 用 `--bot-id`。
- `send` **只受理**：输出受理回执一行 JSON，不等待回答；回执为 terminal unanswered 时退出 2。参数/配置/存储错误把 JSON error 写到 stderr 并退出 1。

### 客户端

`@e-launcher/host-core/control-client` 导出 `createControlClient({url, token, fetch?})`，返回与路由表对应的命名方法（getHostInfo/createBot/listBots/getBot/findByRequest/submit/getSubmission/history/abort/contextStatus）。客户端 JS 没有任何 Node 导入，可在浏览器/WebView 使用；可选传入 `fetch` 实现。每个调用可传 `{signal}` 取消；`history` 选项在原 HistoryOptions 上加 `signal`。状态查询是被动的，客户端没有主私聊 wait 或全局 Runtime.resume 端点；模块 11 的 `resumeWork` 只恢复指定 Bot/scope。错误统一为 `ControlApiError`（带 `code`/`status`）：解析 JSON 错误响应，并把网络/协议错误区分清楚；任何情况下不记录 token。

### 边界与安全

- `send` 受理与 `status`/`abort` 分离：断开客户端不会停止 Agent；Host 进程退出只是暂停，重启后经同一长期服务 resume 可恢复，不冒充 abort。
- 只读控制查询现场询问 Host，缓存或离线设备不虚报；Bot 注册成功由目标 Host 确认。
- 模型凭证不进 API，也不进中心；服务没有关闭端点、任意文件读写或其他提权接口。

### 模块 5 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 31 个 HTTP 场景、181 个端到端检查点及公开类型声明检查，全部通过。另在隔离 Chrome 页面实际加载同一纯 JS 客户端，验证协议错误、Origin 拒绝和 AbortSignal 取消。

验证覆盖认证、媒体类型、坏 JSON/UTF-8、1MiB 请求限制、方法与路径、幂等/并发创建、编码请求 ID、历史分页与上下文查询。发送约 140ms 即受理，慢模型不阻塞其他 Bot；客户端退出后推理继续，显式 abort 停止当前及排队输入，并终止命令的后续写入。其他 Bot 的执行不受影响。

存在慢请求体和运行中命令时，私有 stdin shutdown 约 1.1 秒完成优雅关闭并退出 0。Node 22 重启后自动恢复同一 submissionId，原 Host/Bot 身份保留，中断的 unsafe Bash 回执说明可能部分执行，已发生的写入不重放。端口 0、stdin EOF 不停 Host、重复所有者拒绝、CLI 导入无副作用与令牌不回显均通过。

模型使用本地可控 SSE 服务，没有调用真实付费模型或读取真实模型凭证。数据与 module5-verification.json 报告保存在仓库外，没有新增测试文件；Linux、Android、arm64、框架隧道、中心和 Tauri 外壳尚未验收。

## 模块 6：Bot 主私聊实时预览（认证本地 SSE）

模块 6 为模块 5 的控制 API 增加主私聊实时预览：客户端经认证本地 SSE 订阅某 Bot 主私聊的**有界**投影（历史窗口/工具/生成文本/忙碌状态），先拿到完整快照，再接收整体替换式的更新。预览是瞬态进度，不是可靠记录；**原始历史 API 仍是完整事实源**，分页读取不受影响。

**没有**群消息传输、中心或 Tauri 外壳，也没有轮询或新调度器；不要据此宣称这些能力已就绪。

### 服务端路由

| 方法与路径 | 成功响应 |
| --- | --- |
| GET `/v1/bots/:botId/live` | 200 SSE（`event: bot-live`，`data: <JSON frame>`，空行分隔）；帧见下表 |

SSE 与现有路由共用 Bearer 认证；不接受查询参数令牌，不改变 CORS/Origin 规则。`serveBotLive` handler 在流结束后才 resolve，由既有 inflight 追踪与服务关闭统一收尾；只在 SSE 响应上设置无限超时与可选心跳，不改 JSON 路由的服务器超时。

帧公共部分为 `{type, botId, conversationId, sequence}`；`conversationId` 恒为该 Bot 的公开主私聊 UUID（即使 SDK conversation 尚不存在）。`sequence` 在每个订阅内单调递增，可跳号/合并，是投影修订版本号，**不是**持久游标或 ACK。

| type | 字段 | 语义 |
| --- | --- | --- |
| snapshot | `state: BotLiveState` | 每个订阅最先异步交付一次完整快照；重连从新 sequence 和全新有界快照开始 |
| update | `changes: Partial<BotLiveState>` | 变更字段是整体替换（含历史窗口整窗替换），不是追加/增量 |
| end | `reason` | 仅传输层；连接可能在其写出前结束，尽力投递 |

### 运行时 watch

`Runtime.watch(botId, {signal?})` 返回 `BotWatch`：

| 成员 | 语义 |
| --- | --- |
| `value` | 最新完整 `BotLiveSnapshot`（用于 SSE 背压重置） |
| `start(listener)` | 先异步投递快照，再串行交付更新；慢监听器只保留最新状态。内部原生观察回调仅投影/入队，不调用 Session API 或 commit |
| `stop()` | 取消观察者，返回 `BotWatchEnd`；不等待用户回调完成 |
| `closed` | 观察终止的 Promise（`BotWatchEnd`） |

实现使用公共 `Conversation.watch`（BACKGROUND_CONTEXT 派生的取消上下文），投影 Durable 约 100ms 提交的部分消息/工具，**不是** provider 的每个 token；无 subscribeCommits、TaskGraph 内存或 watchDoc 轮询。

**订阅是被动的**：不创建/启动模型会话。新 Bot（或尚无 Durable 会话）返回空快照并保持挂起，绝不创建或启动模型；`Runtime.submit` 在主私聊解析/创建后绑定挂起订阅，再提交输入。每个订阅只附着一次底层 watch；subscribe/bind/stop 竞争幂等处理。

### 有界预览界限

投影有明确上限并置截断标记：

- 历史窗口：最新 50 条可显示条目；每条最多 8 条消息；每条消息 ≤ 4096 UTF-16 单元；全窗口文本总量 ≤ 65536 UTF-16 单元（超出时丢弃最旧整条目）。
- 生成文本 ≤ 32768 UTF-16 单元。
- 工具：前 32 个；每个工具输出尾部 ≤ 4096 UTF-16 单元。
- 省略 system/未知角色及所有非文本部分（参数/签名等）；`droppedBytes`/`droppedLines` 透出丢弃量。

需要完整原文请使用既有 `history` 分页接口；预览窗口与完整历史互不影响。

### 客户端与 CLI

`ControlClient.live(botId, {signal?})` 返回 `AsyncIterable<BotLiveFrame>`，纯 JS 无 Node 导入，浏览器/WebView 可用（native fetch 适配，不发送 Origin）。解析按 SSE 语法（LF/CRLF、注释、多行 data、TextDecoder 流式、单帧上限 8MiB+8KiB、忽略心跳），校验帧信封（已知类型、botId 匹配、非空公开 conversationId、安全非负 sequence、snapshot.state/update.changes 为对象、end.reason）；HTTP 错误信封仍是 `ControlApiError`。`return`/`break`/`abort` 只取消读取与连接，不发 abort API；意外 EOF/网络/协议错误抛出明确错误，显式 end 正常结束；不自动重连/轮询。

```bash
node host-core/control-cli.js live --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID"
```

`live` 与其它单结果命令不同：每个帧输出一行 JSON；SIGINT/SIGTERM 或 stdout EPIPE 只停止该流并以正常码退出；stdout 背压用标准 drain+signal 处理。

### 断开与恢复边界

- 客户端断开只 `watch.stop()`，不会 `runtime.abort()`：Agent 继续运行。
- Host 进程退出只是暂停，重启后经长期服务 `resume()` 恢复，不能冒充 abort；end 帧尽力而为。
- 服务端背压：`res.write` 返回 false 后停止写新更新；只有实际跳过更新时才记 needReset，`drain` 时补最新 `watch.value` 完整快照。已被接受的帧不会因 drain 重复发送，空闲的大快照也不会反复发送。
- 不承诺瞬态进度的可靠投递；预览丢失以新快照重建，完整历史仍可分页读取。

### 模块 6 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 与 Node 22.19.0 下完成 124 个端到端检查点，全部通过；公开类型声明检查通过。隔离 Chrome 页面加载实际纯 JS 客户端，并通过真实 HTTP SSE 夹具验证 LF/CRLF、多行 data、UTF-8、大小限制、身份与修订顺序、错误信封和取消。

实际订阅验证了新 Bot 空快照且 Durable 表计数不变、首次发送绑定多个订阅、已有历史快照、工具 pending/running/done 与中途输出、排队与显式停止。CLI 的 stdout EPIPE 正常退出后，Agent 仍完成写文件。使用本机 OpenSSL TLS 服务分三次发送模型 SSE，分别收到两次已提交部分回复和完整终态；Node 22 的 40006 单元原始回答仅把生成预览截到 32768 单元。

长历史触发 50 条及 65536 单元窗口限制，原始历史保持完整；真实 40 次工具调用仅预览前 32 个，工具输出尾部截到 4096 单元。慢客户端收到合并及重置快照，最后恢复到最新空闲状态；66989 字节空闲快照只发送一次，没有 drain 循环。空闲流跨过 30 秒并收到两次心跳。

关闭时存在 SSE 订阅及快速断连请求，Node 22 服务约 1.1 秒退出 0，随后重新打开同一数据目录成功，设备及主私聊身份保留。数据、协议夹具与 module6-verification.json 保存在仓库外，没有新增测试文件，也没有调用外部模型或读取真实凭证。

Linux、Android、arm64、Tauri/TUI 和真实终端信号尚未验收。Runtime.watch 的直接慢监听器、故障及取消竞争仅作源码核对，实际端到端验收经过 HTTP/CLI 订阅路径；本模块未实现可靠群消息、跨设备隧道或中心。

## 模块 7：本机持久消息账本（messages.sqlite 与特权离线 CLI）

模块 7 在 Host 本机实现持久消息账本：作用域/成员修订、不可变信封、outbox、接收落地去重与 ACK、本地收件/历史/缺口，以及特权离线 CLI。**只**存储与在本机记账；**没有**网络认证/隧道/HTTP 入口/中心/LLM 调用/推理/唤醒/UI。不要据此宣称跨设备消息已收发，或任何网络能力已就绪。

- 新数据库为 `dataRoot/messages.sqlite`（user_version=1，FK ON，busy_timeout 5000，BEGIN IMMEDIATE 事务）；`host.sqlite` v1 与 `durable.sqlite` 保持不变，旧 Android 数据与 Durable 不动。
- `openMessageLog({dataRoot})` 同步返回 `MessageLog`（`{deviceId, dataRoot, installScope, getScope, listScopes, publish, getMessage, receive, acknowledge, history, inbox, replies, outbox, deliveryStatus, streamStatus, close}`），并同时打开既有 openHost registry 连接；不触发 runtime/harness/model 调用。close 幂等；打开失败关闭已打开部分。

```js
import { openMessageLog } from './host-core/index.js';

const log = openMessageLog({ dataRoot: '/path/to/data-root' });
try {
  const scope = log.installScope({
    scopeId: 'room-1', kind: 'room', revision: 1,
    members: [
      { deviceId: log.deviceId, botId: process.env.LOCAL_BOT_ID },
      { deviceId: process.env.REMOTE_DEVICE_ID, botId: process.env.REMOTE_BOT_ID },
    ],
  });
  const stored = log.publish({
    messageId: 'm-1', scopeId: 'room-1', author: { kind: 'user' },
    category: 'public', text: '你好',
  });
  log.history('room-1', { limit: 50 });
} finally {
  log.close();
}
```

示例的 `LOCAL_BOT_ID` 必须是本机已登记 Bot；另外两个环境变量提供已确认的远端设备与 Bot 标识，登记此定义不会查询远端是否在线。

### 作用域与成员

- `MessageScope` 成员只能是 Bot（`{deviceId, botId}`）；`dm` 恰 2 个不同 Bot（可同机），`room` 2..64；成员按 deviceId 再 botId 确定性排序（JS code-unit，非 localeCompare）。
- 修订不可变，kind 不变。DM 的两个参与者固定，换一对 Bot 必须创建不同 scopeId。群首次安装需至少一个本机成员，后续修订可移除本机成员并保留旧历史。相同修订重试返回同一 Scope；同 scope/rev 不同定义报 `REQUEST_CONFLICT`。
- 隐式人类 owner 只能经至少有一个成员 Bot 的 Host 发布到 room；人类作者显式为 `{kind:'user'}`，仅 room 的 public 消息；bot 间 DM 不允许 user actor。模块 11 的模型通信工具由 Host 注入真实 bot actor，不接受模型自报作者；人类发布入口使用 user，不能把工具调用伪装成人类。

### 信封、流与目标快照

- 每个源流按 (scopeId, revision, sourceDeviceId) 区分，`streamId='scope:'+sha256(JSON.stringify([scopeId, revision]))`；成员修订变化即开启新流，新成员不会因从未面向它的事件产生假缺口。
- `envelope.targets` 是**整份规范成员列表**（冻结的 targetSnapshot），随消息一并固定，不由调用方选择；规范属性按 normalizeEnvelope 固定顺序构造。
- digest 为规范化信封 JSON 的 SHA256 小写 hex；完整规范化 publish 请求摘要单独保存用于幂等重试（排除生成字段）。
- 标识最多 256 UTF-8 字节、正文最多 262144 字节；保留原始空白及 Unicode 拼写，拒绝空白正文和孤立 UTF-16 代理字符，防止 SQLite 编码转换造成身份碰撞。时间戳须是有效的毫秒 UTC ISO 字符串。

### publish / receive / ack

- `publish`：已有 messageId 且相同发布指纹时在任何最新作用域检查前返回原消息（重试安全）；指纹不匹配或与已接收 ID 冲突报 `REQUEST_CONFLICT`。replyTo 须引用同作用域已存消息（可为旧修订）；rootId 从 parent.rootId 派生，无 parent 时为 messageId；user 作者即使给 replyTo 也始终以 messageId 为 rootId。room 仅 public；dm 仅 notice/request/reply，reply 必带 replyTo。本地 DM 无远程 outbox。
- `receive`：要求 `peer.deviceId===envelope.sourceDeviceId`、修订已安装、targets 恰为规范存储成员、Bot 作者属于该修订的源 Host 成员（user 源需源 Host 有成员 Bot 且类别 public）、本机目标成员均存在。未知修订拒绝且不发 ACK；不猜名单/中心目录。同 ID 同 digest 返回原始条目与稳定 ACK，绝不重复本地目标；同 ID 异 digest 或 source+stream+seq 被他 ID 复用报 `REQUEST_CONFLICT`。
- `acknowledge`：仅当 peer.deviceId===ack.recipientDeviceId、ack.sourceDeviceId===本机、本机原消息+目标 outbox 存在且 digest 匹配。pending→acked 置 acked_at；重复 ACK 无状态变化/新事件。**ACK 是投递层确认，不是聊天消息**，不进收件/历史。
- 落盘与推理分离：inbox/已落盘 = 纯回执，不等于已推理；没有自动响应或请求合成。

### history / inbox / outbox / delivery / stream

- `history` 按本机 `local_id` 升序（Host 接收顺序，非全局时间线）分页；`MessageCursor {deviceId, kind:'history', key:scopeId, afterLocalId}`，仅限本机/同 scope；每页 `streams` 只含本页条目代表的流状态。`missingRefs` 在读取时计算，晚期补到引用可在不改原信封下消缺。
- `inbox(botId, {scopeId?, limit?, cursor?})` 含本机源副本（`selfEcho` 标记），纯回执、非推理。模块 10 增加可选 `scopeId`：SQL 使用现有 `(scope_id, local_id)` 范围索引限定扫描，并用冻结本机 Bot 目标的 `EXISTS` 在分页前过滤，不先读全局 inbox 再在 JS 过滤；涵盖全部修订，不按当前成员名单剔除旧目标记录，不新增 schema/索引迁移。
- inbox 游标仍为 `MessageCursor`：不传 scope 时 `key=botId`，保留旧调用；传 scope 时 `key='scope:'+sha256(JSON.stringify([botId, scopeId]))`。旧全量/新 scoped 游标以及不同 Bot/scope 的游标不可混用；仍返回 `selfEcho` 与读取时计算的 `missingRefs`。
- `outbox` 只返回 PENDING，`{targetDeviceId, message}` 重试用同一稳定信封；按 local_id 再 target_device_id 排序。
- `deliveryStatus` 只针对本机源消息；收到的消息报 `SCOPE_FORBIDDEN`，未知报 `MESSAGE_NOT_FOUND`；聚合唯一 Host 目标（非 Bot），状态 stored/pending/acked + acknowledgedAt。
- `streamStatus` 的 gaps 只到已观测最高序号，不虚构尾部/补洞；最多 100 个最早缺口区间并置 gapsTruncated；SQL LAG/相邻行索引区间实现，绝不循环 1..highest。
- 分页 limit 默认 50、上限 200；cursor 跨设备/kind/key、字段类型错或未知字段拒绝。

### 错误码

`INVALID_ARGUMENT`、`REQUEST_CONFLICT`、`UNSUPPORTED_SCHEMA`、`BOT_NOT_FOUND`、`SCOPE_NOT_FOUND`（含缺修订）、`MESSAGE_NOT_FOUND`、`DELIVERY_NOT_FOUND`、`SCOPE_FORBIDDEN`、`PEER_MISMATCH`。错误不带堆栈/token。

### CLI（特权离线）

```bash
node host-core/message-cli.js scope --data-root "$DATA_ROOT" --input scope.json
node host-core/message-cli.js scopes --data-root "$DATA_ROOT"
node host-core/message-cli.js get-scope --data-root "$DATA_ROOT" --scope-id room-1 --revision 1
node host-core/message-cli.js publish --data-root "$DATA_ROOT" --input publish.json
node host-core/message-cli.js get --data-root "$DATA_ROOT" --message-id m-1
node host-core/message-cli.js receive --data-root "$DATA_ROOT" --peer-device-id dev-a --input envelope.json
node host-core/message-cli.js ack --data-root "$DATA_ROOT" --peer-device-id dev-a --input ack.json
node host-core/message-cli.js history --data-root "$DATA_ROOT" --scope-id room-1 --limit 50
node host-core/message-cli.js inbox --data-root "$DATA_ROOT" --bot-id "$LOCAL_BOT_ID" --limit 50
# 模块 10：可选范围过滤，旧的不带 --scope-id 调用保持原语义
node host-core/message-cli.js inbox --data-root "$DATA_ROOT" --bot-id "$LOCAL_BOT_ID" --scope-id room-1 --limit 50
node host-core/message-cli.js outbox --data-root "$DATA_ROOT" --scope-id room-1 --limit 50
node host-core/message-cli.js delivery --data-root "$DATA_ROOT" --message-id m-1
node host-core/message-cli.js stream --data-root "$DATA_ROOT" --scope-id room-1 --revision 1 --source-device-id dev-a
```

- 全部命令要求 `--data-root`（除 help）；scope/publish/receive/ack 输入 JSON 文件 ≤1MiB，绝不 stdin；游标是 JSON 对象；未知/缺失/无关选项拒绝。
- receive/ack 是**特权离线适配器**接口：peer 由可信进程内调用方断言，**不是**密码学认证实现，也不是模型选项；无 `--force` 信任绕过，无自动投递/重试/轮询/LLM。
- stdout 一条 JSON；应用错误以 `{"error":{"code":...,"message":...}}` 输出到 stderr，exitCode=1，finally 关闭消息库与 registry，清理失败保留工作错误。

### 边界与验收

- 模块 7 不改当前 token 路由；模块 5/6 的主私聊认证本地 SSE 仍是主私聊通道。
- 父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 **278 个端到端检查点**及公开类型声明检查，全部通过。使用四份独立 Host 数据目录，经特权离线 CLI 传递信封；没有把此过程当作网络认证或真实跨设备传输验收。
- 验证涵盖人类/Bot 作者分离、群与 DM、同机投递、乱序接收、引用补齐、成员变更、旧目标保留、新成员流、去重 ACK、离线待投递和绑定 Host/范围的分页游标。8 个进程并发创建/提交/接收/确认同一项时只保存一次；12 个不同消息并发提交后，序号连续。
- SQLite 触发器故障注入验证消息/outbox、本地收件和 ACK 的事务回滚；失败受理无半条消息、无 ACK，重试不跳过序号。102 个稀疏序号的缺口截到 100 区间并标记截断；最高安全整数 9007199254740991 的接收与查询在本次机器上分别约 117ms / 135ms，没有按整数范围循环。
- 256 字节标识与 262144 字节正文边界、UTF-8/日期、错作者/目标/摘要/来源、SQL 特殊字符、坏文件与参数均经过实跑。未知/更高版本/损坏/错设备消息库被拒绝，文件哈希保持原样；新账本打开前后既有 Host/Durable/owner 数据库哈希相同。Node 22 写入、Node 26 重放与旧主私聊查询通过，当前 HTTP 控制面没有新增 peer ingress。
- 数据、故障夹具与 `module7-verification.json` 报告在仓库外，没有新增测试文件。Linux、Android、arm64 尚未验收；没有执行 SQLite 提交期间强杀，回滚以实际 SQL 故障注入验证；仅适用于直接 JavaScript 调用的额外选项类型分支做了源码核对，端到端验收使用 CLI。

## 模块 8：认证设备中继与 Host 消息投递（relay + device-link）

模块 8 实现轻中心的第一阶段：**认证设备中继**（relay 服务，只保存设备注册）与 **Host 消息投递**（device-link 客户端，复用模块 7 持久 outbox）。真实的本机进程网络端到端投递已实现；跨设备部署与网络形态尚需真机/外网验收。仍**没有** LLM、群决策、UI、远程控制 RPC；中心没有全局 Bot 目录、聊天库、模型凭证，也不提供通用 URL/端口/VPN 转发。

### 安全与信任边界

- **注册是特权显式动作**：本地所有者把目标 Host 已有 `deviceId` 与独立 opaque 设备 token 写入中心 registry（唯一写入口是 `relay-registry-cli.js`）。没有未认证注册端点，不自动生成新设备 ID，也没有自助配对 UI。设备 token 只从环境变量读取，不是控制 token，不会被记录或持久化明文。
- **中心只存注册**：`relay.sqlite` 只有 device_id、token_hash（SHA256）、credential_version、created_at、updated_at、revoked_at；没有 Bot/历史/作用域表，也没有稳定中心 Host 身份。
- **TLS 注入权威**：接收端通过“连接到已认证所有者 relay 的 TLS 通道”获得 fromDeviceId；没有端到端加密签名/PKI 声明。Host 只信任 relay 注入的 fromDeviceId（不是消息 JSON 或本地控制 bearer）。
- **Hello 先于一切**：首个 JSON 文本帧必须在 5000ms 内为 `{type:'hello',protocolVersion:1,deviceId,token}`；ready 只在认证后发送。WS upgrade 携带 Origin 拒绝 403；路径不是 `/v1/link` 或含 query 拒绝 404；无 URL token/userinfo/fragment，不跟随重定向。
- **loopback 与 TLS**：监听只允许字面 `127.0.0.1`/`::1` 免 TLS；其他监听地址必须提供 TLS cert/key。客户端仅字面回环 URL 可用 ws，非回环必须 wss；自签证书可经 `ca` PEM 传入，但绝不关闭校验（无 rejectUnauthorized:false / insecure 开关）。
- **替换与吊销**：最新成功认证的连接替换旧连接（旧连接收到 4409 REPLACED 即进入 blocked，不再自动重连对抗）。registry 变更递增 credentialVersion；服务端在**每个已认证接收帧**与 **1000ms 定时器**上重查版本/启用状态，失效立即关闭 4403——覆盖另一进程用 CLI 修改 registry 的情况。

### 交付与缓存语义

- **ready ≠ 落盘 ACK**：relay 的 ready 只表示认证/传输就绪；消息确认始终是接收 Host 落盘后的 per-Host ACK。离线/未知 peer 目标的 source pending 保留，不改动、不删除，也不伪造 ACK。
- **扫描是投递，不是模型调度**：`createMessageDelivery` 在线时按 1000ms 定时器 + wake 合并扫描模块 7 outbox（每 tick 一页 200 条，cursor 推进防止永久饥饿），每目标至多 1 条、全局至多 16 条在途；匹配失败按 1000→30000ms 指数退避重试。它从不启动模型、创建输入、调用 log.installScope/SQL，也不改信封（ID/正文/修订/targets）。
- **缓冲有限**：单帧上限 40MiB，高水位 80MiB；目标 `bufferedAmount + frameBytes > 80MiB` 时中心发 `unavailable`（BACKPRESSURE）且不入队。
- **诊断有限**：`lastProblem` 只是最新一条诊断（code/target/messageId/at），不代表全部目标状态；实际事实源仍是 `MessageLog.deliveryStatus`/outbox。

### 可执行流程（现有 deviceId → 所有者注册 → TLS 中继 → Host 链路）

```bash
CENTRE_ROOT='/path/to/relay-data'      # 中心数据目录（relay.sqlite 所在）
HOST_ROOT='/path/to/host-data'         # Host 数据目录（host.sqlite / messages.sqlite 所在）

# 1) 取 Host 现有 deviceId（模块 1 init 输出 {deviceId, dataRoot}）
node host-core/cli.js init --data-root "$HOST_ROOT"

# 2) 所有者预登记：独立设备 token 只经环境变量传入（有效格式 ^[A-Za-z0-9_-]{32,512}$）
export DEVICE_ID='<第 1 步输出的 deviceId>'
export RELAY_DEVICE_TOKEN="$(openssl rand -hex 32)"
node host-core/relay-registry-cli.js register --data-root "$CENTRE_ROOT" \
  --device-id "$DEVICE_ID" --token-env RELAY_DEVICE_TOKEN
# stdout: {"deviceId":...,"credentialVersion":1,"createdAt":...,"updatedAt":...,"revokedAt":null}

# 3) 启动 TLS 中继（非回环监听必须 TLS；本地调试可省略 --listen-host 使用默认 127.0.0.1）
node host-core/relay-server-cli.js --data-root "$CENTRE_ROOT" \
  --listen-host 0.0.0.0 --port 8790 \
  --tls-cert /path/to/server.crt --tls-key /path/to/server.key
# stdout 一行: {"event":"listening","url":"wss://…/v1/link"}

# 4) 启动 Host 链路（token 仍只从环境读；自签 CA 加 --ca，禁止关闭校验）
node host-core/device-link-cli.js --data-root "$HOST_ROOT" \
  --url 'wss://…/v1/link' --token-env RELAY_DEVICE_TOKEN \
  --ca /path/to/ca.pem
# stdout 仅在状态变化时输出一行 {"event":"link_status",...DeviceLinkStatus}
```

注意：`--url` 必须精确到 `/v1/link` 且无 query/fragment；CLI 的 token 永不作为命令行值/stdout/JSON 输出。若 relay 服务仅监听 127.0.0.1（免 TLS），第 4 步改为 `--url ws://127.0.0.1:8790/v1/link` 且不传 `--ca`。

### JS API（`./host-core/index.js` 新增导出）

```js
import { readFileSync } from 'node:fs';
import { openRelayRegistry, openRelayServer, openDeviceLink } from './host-core/index.js';

const { CENTRE_ROOT, HOST_ROOT, DEVICE_ID, RELAY_DEVICE_TOKEN, TLS_CERT, TLS_KEY } = process.env;
const cert = readFileSync(TLS_CERT, 'utf8');
const key = readFileSync(TLS_KEY, 'utf8');
const registry = openRelayRegistry({ dataRoot: CENTRE_ROOT });
try {
  registry.register({ deviceId: DEVICE_ID, token: RELAY_DEVICE_TOKEN });
} finally {
  registry.close();
}

const relay = await openRelayServer({ dataRoot: CENTRE_ROOT, port: 8790,
  listenHost: '127.0.0.1', tls: { cert, key } });
const link = await openDeviceLink({ dataRoot: HOST_ROOT,
  url: relay.url, token: RELAY_DEVICE_TOKEN, ca: cert,
  onStatus: (s) => console.log(s.phase, s.attempt, s.lastError, s.delivery) });
// openDeviceLink 只完成本机资源准备；认证成功后才报告 online。
link.wake();
process.once('SIGINT', async () => {
  await link.close();
  await relay.close();
});
```

### 模块 8 验收状态

父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 **146 个端到端检查点**及公开类型声明检查，全部通过。使用独立 Host/中继进程的真实 WebSocket 和 CA 校验 TLS 连接，包含 IPv4、IPv6 回环及系统分配端口；Node 22 新发消息、路由、接收和确认均已实跑。

验收覆盖群/DM 信封、人类作者保留、离线补投、未知修订拒绝后补装、错误凭证、伪造来源/ACK、认证前业务帧、重复 hello、Origin/路径/query 限制、UTF-8/二进制/帧大小错误。真实发送约 780KiB 的合法转义 JSON 消息并核对接收摘要；读取端未确认时，源 outbox 保持 pending。中继数据库只含 relay_devices，日志及数据库检查未发现测试正文、Bot ID、明文设备令牌或原始 SQL 错误。

凭证轮换/撤销会关闭旧连接，旧进程以 blocked/exit 2 停止，不反复重连；相同设备的新认证连接接管路由，旧连接关闭不会删掉新路由。ACK 写入故障保留在途及 pending，强杀来源进程后恢复补投，接收方仍只有原条目和原 storedAt。强杀中继期间新消息留在 Host，重启中继后完成投递。

大消息向 20 个离线目标发送时观察到发送缓冲拒绝，最高在途数为 6，20 项仍持久 pending。stdin EOF 不停止连接；慢 HTTP 头、未认证 WebSocket 和活连接并存时，中继约 1.1 秒关闭并退出 0。消息链路和原 Runtime 使用不同独占锁，可同时运行，分别关闭。ws MIT 许可证与已安装上游文本一致。

数据、网络夹具与 module8-verification.json 报告保存在仓库外，没有新增测试文件。跨物理设备/外网、Linux、Android、arm64 仍待验证；中继慢接收者的 BACKPRESSURE 分支尚无有效实跑证据，256 连接上限未做负载验收。直接 JS 的 getStatus/回调故障分支做了源码核对，端到端验收主要通过生产 CLI。现有信任模型是受信中继与 TLS 通道，没有端到端消息加密或签名。

## 模块 9：认证远程 Host JSON 控制（已完成父助手验收）

模块 9 在模块 8 的认证中继之上增加固定 10 个 JSON 方法的远程 Host 控制：`getHostInfo`/`listBots`/`createBot`/`getBot`/`findByRequest`/`submit`/`getSubmission`/`history`/`abort`/`contextStatus`。控制与消息是分离的不同角色流量：Host 连接沿用 `device-link`（若有 `--control-url` + `--control-token-env` 配对配置则发送 `role:'host',controlProtocol:1` hello），客户端用 `remote-control-client` 显式发送 `role:'client'` hello。**本模块已完成父助手的本机独立进程端到端验收**，具体环境、覆盖及未实测范围见下文，不代表跨物理设备或全端产品已完成。

### CLI

```bash
node host-core/remote-control-cli.js listBots \
  --device-id <SOURCE_DEVICE_ID> --target-device-id <TARGET_DEVICE_ID> \
  --url 'wss://…/v1/link' --token-env REMOTE_CONTROL_TOKEN \
  [--input control-input.json] [--ca /path/to/ca.pem]
```

- METHOD 必须精确等于上述 10 个方法名之一，无别名；`--input` 可选，缺省 `{}`，为 ≤1MiB 的普通 UTF-8 JSON 对象（`uploadAttachment` 为 ≤32MiB）。（模块 14 起该方法表扩展为固定 v2 方法，现共 37 个（含 SOUL 2 个），并新增保留命令 `listDevices`/`live`，见[模块 14](#模块-14统一-host-服务与设备接入已完成父助手限定范围验收)与[Bot 级扩展与 SOUL.md](#bot-级扩展与-soulmdhost-契约增量)两节。）
- 成功：stdout 输出一行原始 JSON 结果，exit 0。失败：stderr 输出 `{"error":{"code":...,"message":...,"outcome":...}}`；unconfirmed 结果 exit 2，其他错误 exit 1，`--help` exit 0。信号只关闭客户端，绝不发送 abort 方法；错误输出不含令牌/调用负载。

### JS API（`./host-core/index.js` 新增导出）

```js
import { openRemoteControl } from './host-core/index.js';

const ctl = await openRemoteControl({
  deviceId: DEVICE_ID,            // 本机已注册设备身份
  url: relay.url,                  // ws(s)://…/v1/link
  token: REMOTE_CONTROL_TOKEN,     // relay 凭证（环境变量）
  // ca: cert,                    // 自签 CA，禁止关闭校验
});
try {
  const info = await ctl.call(TARGET_DEVICE_ID, 'getHostInfo', {});
  const bots = await ctl.call(TARGET_DEVICE_ID, 'listBots', {});
  // createBot/submit 等 10 个方法同构；每调用独立 callId
} finally {
  ctl.close();
}
```

### 语义边界

- **同一设备多客户端共存**：多个 `role:'client'` 连接可同时存在；DeviceLink 仍是唯一主机连接。凭证撤销、轮换检查和心跳覆盖全部认证 host/client 连接；新的 Host 连接只替换同设备的旧 Host 连接，客户端可继续共存。新建客户端不打开 host.sqlite/messages.sqlite/device-link-owner 或 Runtime，原 Host 仍是 cwd 创建、推理、工具与历史的唯一权威。
- **令牌区分**：relay 凭证（`--token-env`）用于登录中继；`--control-url`/`--control-token-env` 是本机回环 Control API 的本地令牌（仅字面 `http://127.0.0.1` 或 `http://[::1]`，路径必须 `/`，不带 query/fragment）。
- **信任模型**：传输仍依赖受信中继 + TLS 通道，不是端到端加密/签名；CA 可用但不能关闭校验。
- **结果语义**：`not-sent` 未交给目标本地 Control API；`unconfirmed` 操作可能已被接受（超时/断线/取消后），不可认定无副作用；`responded` 目标本地 API 已返回（未必代表失败零副作用）。应用层请求幂等依赖显式 requestId 重试核对，不自动重试。
- **上限**：请求参数与结果 JSON 各 ≤32MiB（UTF-8），整 relay 帧 ≤40MiB；客户端 8 个在途调用、25s 超时，Host 8 个活动调用、20s TTL，全局 128 条 pending。
- **边界**：仅 Node 客户端；SSE 直播、设备目录/枚举 UI、任意 URL/路径/头/端口 RPC、离线信箱或自动变更重试不在本模块。

### 模块 9 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下，使用本机独立客户端、中继与 Host 进程及真实 CA 校验的 WSS，完成 **171/171 个端到端检查点**（失败 0），公开类型声明检查通过。IPv6 仅实测回环 ws 认证与目标离线回执，没有据此宣称 IPv6 在线 Host 控制已验收。这里的端到端指业务链路，仍依赖可信中继与 TLS，**不是端到端消息密码学**，没有 E2E 消息加密或签名。

模型服务使用 **Mockoon OpenAI-compatible SSE**，不是外部真实付费模型；目标 Host 实际运行 Durable/BC 及原生 write/bash/grep，确认工具在目标 cwd 执行并写入真实文件。固定 10 个 JSON 方法、同设备多客户端、幂等与并发创建、目标 cwd 校验、逐 call 本机 Host 身份核对、被动历史/上下文查询、离线拒绝且不重放均通过。提交不等待模型，客户端退出后推理继续；忙时输入排队，显式 abort 停止当前及排队输入并阻止后续工具写入。

验收还覆盖调用/连接范围隔离、错误 Host 与重复/迟到回复忽略、更换 Host 后的 unconfirmed、每客户端和每 Host 各 8 个并发上限、20s 中继超时及取消通知、1MiB JSON 边界与超大结果拒绝。RPC 取消不会调用 Agent abort，推理仍可完成；只有显式 abort 才停止 Agent。错误角色/参数/凭证、撤销/轮换、Node 22 中继重启与 Host 重连、Runtime 重开及既有提交稳定、旧消息 outbox/ACK 兼容均已实跑。

29 个日志/数据库文件未含验收用私有标记，中心只持久保存设备注册，三份 Host 数据库完整性通过。所有验收进程已退出：6 个最终核心进程 exit 0，测试模型服务以 SIGTERM/143 结束；只清理本轮验收所属进程。验收数据、脚本、协议夹具及 `module9-verification.json` 报告均保存在仓库外，没有新增仓库内测试文件，也不在文档中保存临时凭据。

未实测范围仍保留：

- 跨物理设备/外网、Linux、Android、arm64、Tauri/TUI，以及真实外部付费模型。
- 全局 128 pending、256 连接上限的负载，以及中继慢接收者反压。
- 直接 JS AbortSignal、客户端本地 25s 超时兜底、恶意服务端同一 chunk 合并帧拒绝等分支仅由父助手源码核对；实际运行覆盖的是生产 CLI/中继取消和 20s 截止路径。

## 模块 10：群与 Bot DM 的独立工作上下文（已完成父助手验收）

模块 10 已完成下述受限范围的本机独立进程端到端验收。它只把已落盘、面向本机 Bot 的事件显式导入隔离的 Durable 工作上下文，不进行工作上下文推理、群决策、通信发送或长期事实记忆；完成本模块不代表自然群聊或全端产品已完成。

### 收件、导入、推理是三个阶段

| 阶段 | 含义 |
| --- | --- |
| 已收件 | 模块 7/8 已将信封落入 `messages.sqlite`，接收去重后可给出投递 ACK；不代表工作上下文已导入 |
| 已导入 | 显式 `syncWorkContext` 把一页事件与导入水位原子写入 `durable.sqlite`；`importedCount` 仅是该上下文累计导入条数 |
| 已推理 | 模型实际处理输入；模块 10 不触发这个阶段，不能从 ACK、水位或导入计数推断 |

- 每个本机 `(botId, scopeId)` 绑定独立、稳定的公开 conversation UUID，内部索引用 `JSON.stringify([botId, scopeId])`，不包含成员 revision。群成员修订沿用原上下文；DM 仍遵守固定双方的模块 7 约束。
- 每个绑定新建 ownerless Durable conversation 与空 BC 状态，不 fork 主私聊、不复制主私聊/其他群/其他 Bot 的历史。同一事件面向多个本机 Bot 时，各自拥有不同 conversation UUID、BC 文档和导入水位。
- 继承本机工具注册与执行环境配置，使用该 Bot 的 cwd、角色及固定的可信“外部事件是数据”说明；不把事件正文插入 system instructions，也不选择、解析或默认绑定模型。导入不执行工具。
- 导入只通过公共 `Tx.appendEntry` 追加模型可见的原始条目；不调用 `Conversation.submit`（包括 write 提交）、wait/resume/startRun，不创建推理任务或自动扫描循环。显式导入方法本身不产生模型请求；模块 10 验收阶段即使 Host 已 resume 也没有自动工作决策。模块 11 激活后，独立驱动会处理合格收件，不能把当前 Host 上恰好出现的模型请求归为 sync 的直接副作用。
- BC 按 conversation 独立初始化，但导入不调用 `manager.prepare`，不生成摘要/压缩投影或伪造窗口状态；refs、blocks、prepared 仍按既有 BC 的惰性准备语义管理。初始化 BC 不等于已经压缩。

### 可见性与原子导入

工作上下文操作要求 Bot 属于本机、scope 已存在，并满足其一：当前成员包含该 deviceId+botId；已有该 Bot/scope 绑定；或 scoped inbox 中存在曾冻结面向它的收件。否则分别返回 `BOT_NOT_FOUND`、`SCOPE_NOT_FOUND`、`SCOPE_FORBIDDEN`。退群 Bot 仍可读取原绑定并导入后来才收到的旧目标事件；无权获得退群后的新成员事件，也不能使用 scope-wide history 或另一 Bot 的收件代替自己的 inbox。

一次 sync 只在**同一个串行 Durable commit 内**重查/创建绑定、读当前水位、从独立消息库连接读取一页 scoped inbox、追加全部新条目并更新水位/计数。水位按本机接收 `localId` 推进，不按源序号、修订或时间戳跳过迟到事件。初始水位为 0 时省略源游标；正水位才构造绑定同一 Bot/scope 的 inbox 游标。

绑定、BC 初始状态、原始 Entries 与水位共同提交或回滚，不存在半页导入后提前推进水位；重试、重启和并发 sync 以已提交水位继续，不重复追加旧 localId。`hasMore` 只反映本次页的 `nextCursor`，不循环到空；之后新到事件留给下一次显式 sync。原始消息账本是只读来源，不删除源游标、不修改 ACK/信封；无需修改 `host.sqlite`/`messages.sqlite` schema，也不改 primary 索引或 requestId 映射。未知/未来持久文档版本的拒绝继续向上传递，不能重置状态。

### 来源条目与真实作者

每条导入 Entry 的 kind 为 `host.scope-message`，data 精确包含 `{version:1, scopeKind, localId, digest, storedAt, selfEcho, message}`，保留完整不可变信封（含 `author.kind`、rootId、replyTo、category、revision、targets）。`missingRefs` 是读取时可变化的派生值，不固化进 Entry。

Entry.model 恰有一条 `role:'user'` 消息，内容为固定的外部事件/数据前缀加 `JSON.stringify(data)`，时间戳为 `Date.parse(storedAt)`。**这个 role 只是模型上下文载体，不是真实作者身份**：真实作者始终在 `data.message.author`，人类仍为 `kind:'user'`，Bot 仍为 `kind:'bot'`；不冒充 system/assistant，也不把外部文本提升为宿主/工具指令。导入本身不执行正文，但载体说明不会一概要求忽略真实人类请求。public/notice/request/reply 与 selfEcho 都可作为来源数据导入，本模块不决定哪些事件触发推理。ACK 与工具进度本来就不进入消息 inbox。原始 Entry 与源账本均保留，后续 BC 只压缩投影。

### Runtime 与公开类型

`WorkContextRecord` 仅含 `deviceId`、`botId`、`scopeId`、`kind:'room'|'dm'`、`conversationId`（公开 UUID）、`createdAt`（ISO 字符串）、`lastImportedLocalId`、`importedCount`；后两项初始均为 0，不暴露 SDK 数字会话 ID。

| 方法 | 结果与语义 |
| --- | --- |
| `getWorkContext(botId, scopeId)` | `WorkContextRecord \| null`；已授权但未绑定返回 null，不创建 conversation |
| `syncWorkContext(botId, scopeId, {limit?})` | `WorkSyncResult {context, imported, hasMore}`；显式调用可为空的已授权 scope 建立绑定，`imported` 是本次追加数 |
| `workHistory(botId, scopeId, {limit?, cursor?})` | `WorkHistoryPage {botId, scopeId, conversationId, items, nextCursor}`；返回该工作上下文原始 Entries，未绑定时 conversationId=null、空 items、null nextCursor，不创建 |
| `workContextStatus(botId, scopeId)` | `WorkContextStatus`：复用 `ContextStatus` 的 BC 字段，加 scopeId，conversationId 可为 null；未绑定返回空 BC 状态，不创建或准备投影 |

所有方法返回 Promise。sync 的 `WorkSyncOptions` **只**允许 limit，默认 50、最大 200、正安全整数；未知字段或无效值在创建绑定前报 `INVALID_ARGUMENT`。历史同样默认 50、最大 200，使用自己的游标，不接受源消息 inbox 游标。

`WorkHistoryCursor` 精确包装为 `{conversationId: <公开 UUID>, position: <非 null、非数组的 SDK 游标对象>}`，只允许这两个包装字段。调用方原样传回 `nextCursor`；拒绝其他工作上下文/主私聊 UUID、裸 SDK 游标或额外包装字段，未绑定上下文不接受非空游标，均为 `INVALID_ARGUMENT`。主私聊的既有历史游标格式不变。

四个方法复用原 Host/harness/BC manager，不新增 Runtime。工作引擎仅在需要消息操作时懒开 MessageLog，纯主私聊且未使用通信工具时不因此创建 `messages.sqlite`。模块 11 的自动处理与通信工具共用这一个连接：关闭时先停驱动、拒绝新工作操作并等待已接纳操作，再关闭 live/harness，最后关闭消息连接，避免中断已接纳工具的查询/收尾；DeviceLink 仍持有独立连接与锁。主私聊 submit/wait/history/getSubmission/abort/watch 与模型选择语义不变。

### 本机 HTTP、客户端与 CLI

本轮只扩展已有认证本机 Control API，沿用 Bearer、Origin 拒绝、请求体限额及关闭规则：

| 方法与路径 | 输入 | 成功响应 |
| --- | --- | --- |
| GET `/v1/bots/:botId/work-contexts/:scopeKey` | — | 200 `WorkContextRecord`；未绑定为 404 `WORK_CONTEXT_NOT_FOUND`，不同于 Runtime 的 null |
| POST `/v1/bots/:botId/work-contexts/:scopeKey/sync` | `{limit?}` | 200 `WorkSyncResult` |
| GET `/v1/bots/:botId/work-contexts/:scopeKey/history?limit=&cursor=` | cursor 为上述包装的 JSON | 200 `WorkHistoryPage` |
| GET `/v1/bots/:botId/work-contexts/:scopeKey/context` | — | 200 `WorkContextStatus` |

新增错误映射 `SCOPE_NOT_FOUND`/`WORK_CONTEXT_NOT_FOUND`→404、`SCOPE_FORBIDDEN`→403；参数/游标错误为 `INVALID_ARGUMENT`→400。共享 history helper 仅转换已识别的 SDK 原生游标错误，不因请求带 cursor 就吞掉存储故障；真实 SQL 读取错误仍保留 `ERR_SQLITE_ERROR`，HTTP 返回 500。未绑定但已授权的 history 查询仍返回空状态；context 查询仅在 BC 为该 Bot 启用时返回空状态，禁用或卸载返回 `EXTENSION_DISABLED`。

`createControlClient` 增加 `getWorkContext(botId, scopeId, options?)`、`syncWorkContext(botId, scopeId, input?, options?)`、`workHistory(botId, scopeId, options?)`、`workContextStatus(botId, scopeId, options?)`；sync 的 input 为 `WorkSyncOptions`，默认 `{}`。history 的 options 是 `{limit?, cursor?:WorkHistoryCursor|null, signal?}`，其他 options 为 `{signal?}`。signal 仅取消 HTTP 等待，不代表导入未提交、回滚收件或停止推理；不确定时可重查水位或重试 sync。

新 HTTP 路径的 botId 段沿用 `encodeURIComponent`，scope 段使用 **`scopeKey='~'+encodeURIComponent(scopeId)`**。服务端对该段解码一次，要求前导 `~`，仅剥去一个 `~` 后把原始 scopeId 交给 Runtime；缺少前缀或解码后 ID 为空报 `INVALID_ARGUMENT`。例如 `'.'→'~.'`、`'..'→'~..'`、`'~.'→'~~.'`，避免 WHATWG URL 折叠点路径且不碰撞、不收窄模块 7 合法 ID。JS/CLI 调用方始终传原始 scopeId，由客户端完成编码；这组工作上下文 HTTP 路由及模块 11 的 activity/stop/resume 路由使用 scopeKey，不改 Runtime/MessageLog 标识或既有主私聊路径，也不兼容未加前缀的新路径。

```bash
node host-core/control-cli.js work-get --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
node host-core/control-cli.js work-sync --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1 --limit 50
node host-core/control-cli.js work-history --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1 --limit 50
node host-core/control-cli.js work-context --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
```

四个命令均要求 `--bot-id --scope-id`；work-sync 仅额外允许 `--limit`，work-history 允许 `--limit --cursor`（上一页包装游标的 JSON），其余拒绝无关选项。旧控制命令也拒绝不适用的 `--scope-id`，不静默忽略。复用原 HTTP 客户端与 JSON 输出，不增加打开第二个 Runtime 的 CLI。

### 模块 10 验收

父助手在 **Windows x64 / Git Bash、Node 26.8.2 与 22.19.0** 下完成 **149/149 个检查点，失败 0**。验收使用本机独立 Host 进程和真实 CA 校验的认证 WSS，模型服务为 **Mockoon OpenAI-compatible SSE**，未调用外部真实付费模型。

- **隔离与分页**：12 个并发 sync 处理 30 条交错收件，合计只导入 30 条，5 页 history 得到 30 个不同 messageId。Bot/room/DM/BC 隔离、真实作者、自身回声、先 reply 后 parent 与旧成员冻结目标通过；262144 字节的 65536 个 emoji 在原始 Entry 与模型载体中完整保留，并由 Node 22 实际读取。
- **原子回滚**：新绑定与已有上下文分别在双消息批次第 2 条注入 SQL 故障，整页 Entries/水位回滚，新绑定及其 BC 初始化也一起回滚；重启后完整补入，再 sync 为 0。未来 WorkDoc version 2 与 BC kernel 999 被拒绝且不重置；纯主私聊路径不打开 `messages.sqlite`。
- **可靠强杀证据仅取第 3 次**：Host 先健康，在 SQLite 写锁下 POST 请求体已发出、health 被阻塞，随后记录 Host exit 137 与客户端 reset 56；恢复后无半成品，显式 sync 导入 1 条、再次为 0。前两次未证明请求已接纳，不计作进行中恢复证据。
- **断连与收件独立**：已受理 sync 被写锁阻塞时 HTTP 客户端超时断开，释放锁后仍完成导入，重试为 0。Runtime 关闭期间，独立消息链路经认证 WSS 落盘并 ACK；重开时上下文水位仍旧，显式 sync 才导入。主私聊处于 placed 时也实际导入了新消息。
- **不自动调用模型**：最终 4 个模型请求全部来自 4 次显式主私聊提交，没有工作上下文推理；检查到 Host A 的 16 个工作上下文共 0 个 tasks。模型 wire 与 primary SSE 均无群/DM 标记；导入不准备 BC 压缩投影。
- **接口与错误边界**：本机 HTTP/CLI、`~` 前缀 scope 路径和绑定游标通过；原生游标错误映射为 `INVALID_ARGUMENT`/400，真实 SQL 读错仍为 `ERR_SQLITE_ERROR`/500。原远程 **10 个方法**全部回归；尝试远程 `workHistory` 被拒为 `not-sent`，新 work API 仍仅限本机。

公开声明检查通过，采用 `--strict --skipLibCheck`（记录为 `types-final.out`）；不加 skipLibCheck 时，既有 `@google/genai` 声明引用缺失的可选 `@modelcontextprotocol/sdk/client/index.js`，本轮未改依赖。6 份数据库完整性/外键检查通过；中心仍仅 `relay_devices`，数据库与 relay 日志未见选定正文标记。5 个核心服务 exit 0、Mockoon 以 143 结束，22 个辅助进程已清理，无本轮残留；没有使用或迁移生产数据。

详细报告保存在仓库外：`C:/Users/46040/AppData/Local/Temp/e-launcher-work-contexts-1792552863388/module10-verification.json`。模块 1–9 的验收记录和限制保留。

### 后续边界与未实测

- 上述模块 10 验收不覆盖模块 11 的自动收件调度、工作上下文推理/发言或沉默、Bot 通信工具；模块 11 已独立完成父助手验收，接口与实测范围见下节。模块 12 的成员同步/历史补齐已完成父助手限定范围验收（122/122 检查点，见下节）；模块 13 已完成 Host 侧适配及限定范围验收，不新增 Session 产品或 UI。
- 模块 9 远程协议保持原 **10 个方法**，未增加远程工作上下文控制；版本化接线属于模块 14（M9–M12；M14 v2 起已扩展为固定 v2 方法表，现共 37 个，见[模块 14](#模块-14统一-host-服务与设备接入已完成父助手限定范围验收)一节）。
- 未实测：跨物理设备/WAN、Linux、Android、arm64、Tauri/TUI、浏览器 native-fetch 适配集成、真实外部付费模型。
- 未实测直接 JS AbortSignal 与直接 `Runtime.close` 并发调用/关闭竞态；已实跑服务端 HTTP 断连继续导入和进程优雅关闭。全局 128 pending/256 连接负载、中继慢接收者压力测试及模块 9 原有未实测项继续保留。

## 模块 11：自然群聊决策与 Bot 通信工具（已完成父助手验收）

模块 11 已完成下述限定范围的实现及父助手端到端验收：**161/161 个检查点，失败 0**，总完成数为 **11/20**。验收使用 Windows 本机独立进程、真实 WSS 与脚本化 Mockoon HTTP/SSE 模型响应，不代表真实智能模型的群聊质量、跨物理设备或全端产品已完成；具体证据与限制见本节末尾。

### 主动 resume 与被动查询

- `openRuntime(...)` 保持被动；`getWorkContext`、`syncWorkContext`、`workHistory`、`workContextStatus` 与新 `getWorkActivity` 不激活自动决策。sync 仍只导入一页，不直接提交推理。主私聊 submit/wait 保留原有原生执行/恢复语义，不以此开启工作决策驱动。
- 显式 `Runtime.resume()` 同时恢复原生任务并幂等激活工作决策驱动：立即扫描，之后约每 1000ms 扫描，不重叠轮询、不在轮询内等待模型结束。`openControlServer` 监听成功后会调用它，因此常驻控制服务是**主动 Host**：已安装 scope 的合格收件可产生模型调用和费用，即使客户端只在查询。
- 只使用本机已安装的 room/DM 定义；没有自动发现其他 Bot、创建 DM、协商成员或补齐远端历史。尚无 `messages.sqlite` 时扫描跳过而不建库；有库后检查本机当前成员与已有工作绑定，空 scope 不因被扫描就新建空绑定。
- 每个 `(botId, scopeId)` 独立导入与决策。每次导入最多 200 条，积压分后续扫描导入，追平后才开始新的决策；模型运行中或 owner 停止时仍可导入来源事件。每对 Bot/scope 至多一个待处理决策，忙时合并新收件，不按每条消息取消/重启模型；同一决策可以多轮工具、多次发布，没有思考次数或自动接话条数上限。
- 非自身回声的 **room public**（人类或其他 Bot）以及 **DM request** 可触发新决策；自身回声、DM notice/reply 只作上下文，不触发新的请求。ACK 和工具进度本就不是消息账本事件。没有强制 @、中央选发言人或必回“收到”规则。

首次工作推理使用该 conversation 已绑定模型，否则选 Bot 的 `modelRef ?? defaultModel` 并持久化；不悄悄更换已经绑定的模型。无配置为 `MODEL_REQUIRED`，模型不可用为 `MODEL_NOT_FOUND`。Host 处理信号不是人类发言；即使模型载体 role 为 user，来源作者仍以 `message.author` 为准，不把其他 Bot 当人类/system，也不一概忽略真正的人类请求。

### 明确发布、沉默与输入水位复核

普通 assistant 最终文本始终留在**私有工作历史**，不自动进入群/DM。只有通信发送工具发布消息；没有专用 silent 工具或 `SILENT` 字符串解析，正常结束且未发送即为沉默，群里不追加沉默通知。跨 scope 发送也必须显式调用工具，不自动转发主私聊、其他群或 DM 全文。

区分三种水位：`lastImportedLocalId` 表示已导入；`handledLocalId` 表示策略已消费的来源（包括扫描到但不触发推理的回声/notice/reply）；`pending.preparedThroughLocalId` 是**本次实际冻结模型请求**中贡献来源内容的最大本机 localId，不是最新导入水位、tokenCount 或 Durable EntryId。来源 localId 可稀疏。决策正常结束最多推进到自己的 prepared 水位，不能顺手消费模型没见过的新输入。

工作工具发布前，在原生串行提交点读取当前停止/决策状态，并用 `MessageLog.publish(input, guard)` 在消息库**同一事务内**复核来源成员资格与新收件，再落盘消息/outbox：

- `MessagePublishGuard = {scopeId, afterLocalId}`；scopeId 是**决策来源 scope**，可以不同于发送目标（例如群决策向 DM 发送）；afterLocalId 必须为非负安全整数，来自实际 prepared 水位。
- guard 仅用于 Bot 作者。省略/undefined 保留旧 publish 行为；显式 null、未知字段或无效值报 `INVALID_ARGUMENT`，不能静默关闭校验。目标 scope/类别/作者的既有校验不变；来源不存在为 `SCOPE_NOT_FOUND`，不再是来源成员为 `SCOPE_FORBIDDEN`。
- room 来源 scope 在水位之后有冻结面向该 Bot 的非自身事件即为 `STALE_INPUT`，包括另一个本机 Bot、人类及 DM notice/reply；其他 scope、只面向别的 Bot 的消息及本机自身回声不使旧稿失效。这个发布校验比“是否触发新推理”的类别规则更严格。DM 工作轮不用新鲜度 guard：冻结轮只处理本轮关联消息，其后到达的 DM 排队给后续决策轮，不使待发稿失效；成员撤销检查仍对所有 scope 生效（publishWork 内部按当前成员复核）。
- `STALE_INPUT` 不写入消息/序号/outbox/目标。驱动持久标记 replan，旧生成不再发起下一次 provider 调用，保留未处理水位，随后用新批次重新考虑；不保证远端尚未到达的消息也被看见。
- 合法的同 messageId、同发布指纹重试在数据库 guard/成员检查前返回原回执；异内容仍报 `REQUEST_CONFLICT`。guard 不进信封或指纹。已落盘发送在停止或崩溃后可对账，不能把失败/中止结果解释为此前绝无发布或其他副作用。

BC 插件启用时负责其投影压缩，原文不删；SDK 原生自动压缩对所有 Bot 生效（含 BC 启用的 Bot），两者共存，原生 head 前移后 BC 在现有投影上重建。Host 在插件和 Durable 贡献之后执行最终预算检查：基线用 cutoff 视图的 SDK usage+尾部估计，插件投影按有序子序列 + 增量对齐，真实越限才以 `CONTEXT_LIMIT` 阻止 provider 调用；不截掉最新大事件、不按整包 JSON 估算误杀正常上下文。窗口估计不是 provider 接受请求的保证。

pi-durable 的 HookRunner 会吞掉普通 hook 抛错，因此请求阶段失败需要按当前生成任务的取消保护处理；此前内嵌实现的故障验收不等于新插件链路已验证。

### 当前约定：自动压缩与失败闭环

- **压缩**：全部 Bot 默认 SDK 自动 compaction（阈值 blocking/background 与一次 overflow 重试）；中心安装并全局启用后对无显式绑定的既有/新 Bot 默认启用 BC（安装本身实例初始停用），显式 false/overrides 在再次全局启用后仍保留；两者共存，原生 head 变化后 BC 重建投影。已实跑：原 478 会话 threshold 自动压缩完成（任务 4908 completed）与 BC 共存、手动压缩完成（任务 4957 completed）、默认绑定与既有显式 false 均已核验。
- **预算**：prepare 与最终守卫都用 cutoff 视图的 SDK usage+尾部估计，插件投影按有序子序列 + 增量计费；真实越限才 CONTEXT_LIMIT，不按整包 JSON 误杀。
- **失败**：只结算本冻结请求批；诊断写 GenerationFailureState 家族（String(taskId) 键、固定安全文案），并向原请求 replyTo 发普通 bot-author `[Host 执行失败]` 回执（前缀只是标签，不提供可信 Host 身份，信封 author 仍是实际 Bot）。旧 scope 闸门错误经迁移边界封存、不重放 backlog，新到消息正常执行。已实跑：委派发起方插入 >20k token 填充后手动 compact，恢复接收方后收到一次稳定 messageId 的 MODEL_REQUIRED 普通 bot 回信（replyTo 原请求），发起方在原 primary 自动报告错误；修复模型后无 resumeWork/无重发旧请求，同一 DM 新请求与回信成功，双方 lastError 归零；Host 重启未重复发失败回执。
- **LIVE**：blocking 与手动压缩显示 compacting（手动 compacting.startedAt 与原生任务一致），后台压缩不抢占 running；失败展示安全 failed.error；计时用冻结轮 frozenAt / nativeTask.startedAt，不取历史用户消息日期。

### 工作状态、逐 scope 停止与恢复

三个新 Runtime 方法均返回 `Promise<WorkActivity>`：

| 方法 | 语义 |
| --- | --- |
| `getWorkActivity(botId, scopeId)` | 被动授权查询，不创建绑定或模型任务；已授权未绑定返回 unbound，不是 404 |
| `stopWork(botId, scopeId)` | 必要时建立绑定，先持久化 stopped=true，再 abort **仅该工作 conversation**，等待其执行静止后返回；不推进 handled 水位 |
| `resumeWork(botId, scopeId)` | 要求当前成员，必要时建立绑定；先清理停止前残余执行，再清 stopped/error，保留未处理输入；仅当全局驱动已激活时促使其继续处理，不会独自激活被动 Runtime |

`WorkActivity` 字段如下（不暴露内部 nativeId、taskId 或 cutoff）：

| 字段 | 含义 |
| --- | --- |
| `botId`, `scopeId`, `conversationId` | 本机 Bot/范围，公开 conversation UUID；未绑定为 null |
| `isMember`, `stopped`, `status` | 最新成员资格、持久 owner 停止位、当前状态；status 优先级为 unbound → stopped → error → inactive（非成员）→ thinking（有 pending）→ idle |
| `lastImportedLocalId`, `handledLocalId` | 分别为导入与策略消费水位；不是投递 ACK 或逐条推理证明 |
| `pending` | null 或 `{requestId, submissionId:number\|null, startedAt, preparedThroughLocalId:number\|null}`；时间为 ISO，准备前水位为 null |
| `lastDecision` | null 或 `{requestId, outcome:'silent'\|'published'\|'replan'\|'aborted'\|'failed', throughLocalId:number\|null, completedAt}`；模型决策结果，不是远端投递回执，失败/中止也可能已有副作用 |
| `error` | null 或 `{code,message}`，保留小型可操作错误，不暴露完整请求、provider 内容或凭证 |

停止不撤回已提交消息/outbox，不清历史，不取消别的 scope 或主私聊；`Runtime.abort(botId)` 仍**只**中止主私聊，不是 stop-all。停止位跨重启保留，`Runtime.resume()`、新的人类消息或重新入群都不能代替 owner 的显式 `resumeWork`。Host 关闭只暂停恢复，不自动置 stopped。

退出当前成员名单时不开始新推理，并终止/对账已绑定的待处理工作；旧冻结收件与历史仍可导入/读取。不把退群写成 owner stopped、不丢未处理输入；重入后若未被 owner 停止且无阻塞错误，可继续处理。

生成失败只结算本次冻结请求批：持久化 `lastError` 诊断（`GenerationFailureState` 家族按 String(taskId) 记安全 code/固定文案），并以普通 bot 作者身份向原请求 replyTo 发送 `[Host 执行失败]` 回执，不阻塞后续新到消息、不再要求 `resumeWork` 清 scope 闸门。旧 `state.error` 阻塞 scope 的历史积压由迁移边界封存、绝不重放；新到消息正常触发执行。意外存储/schema 故障不吞掉或重置：驱动停止轮询、保留 fatal 错误，activity/变更操作向调用方暴露，需正确关闭/重开并处理原因；主私聊不因工作驱动 fatal 被自动改成停止。

### Bot 通信工具与异步消息

工具每次从实际调用 conversation 解析本机 Bot 身份；不信 cwd/角色/模型参数自报身份，不为解析身份新建会话。未知/非本机上下文为 `BOT_CONTEXT_REQUIRED`。模型不能提供 author、botId、messageId 或 guard，未知参数拒绝；发送统一注入 `{kind:'bot',botId:<实际Bot>}`。

| 工具 | 参数与作用 |
| --- | --- |
| `list_scopes` | `{offset?,limit?}`；offset 为非负整数、默认 0，limit 为 1..200 的整数、默认 50，仅列当前成员 scope；返回 `{deviceId,botId,scopes,nextOffset}`，offset 在成员变化时仅尽力分页，不是持久消息游标 |
| `read_scope` | `{scopeId,limit?,cursor?}`；只读自身 scoped inbox，保留退出后的旧冻结目标权限，不读全 scope 或其他 Bot 的 inbox |
| `send_to` | `{scopeId,text,files?}`；已安装 DM 或 room 均可；不暴露 request/reply/public 分类或 replyTo——本轮已在回应该 scope 某条消息时 Host 自动把发送挂到该轮的原始请求消息（嵌套委派经冻结轮还原原请求），其余发送成为可触发对端续轮的新消息 |

read 工具分页默认 50、最大 200。发送只返回紧凑落盘回执 `{messageId,scopeId,author,category,rootId,replyTo,createdAt,status:'stored'}`，**stored 不代表远端收到、开始工作或已交付**。每次发送工具的 messageId 保存在 Durable task memo 中，崩溃在账本写入后/工具回执前时重放沿用同 ID，并由账本指纹去重，不从模型 callId 派生。工具结果为 JSON 文本；已知消息/身份/工作策略错误以 `{code,message}` 和 `isError:true` 返回（如 `WORK_STOPPED`、`WORK_CONTEXT_INACTIVE`、`STALE_INPUT`），取消向上传递，未知存储故障不改报 `INVALID_ARGUMENT`。

Bot 消息通信是异步的：`send_to` 落账后立即返回 stored 回执，对端应答由消息账本/工作扫描在接收 Bot 空闲时唤醒新一轮回到发起上下文；模型侧没有 wait/poll/read-replies 工具，发完必要消息且无独立工作时直接结束本轮。同一轮可多次 `send_to` 派给多个 Bot，不强制每次发送后结束；后续到达的回复经 `sessions.replyOrigin` 寻源回到发起轮（replyTarget 为 primary 时回到用户会话），多轮往返靠“发完即结束、回复再唤醒”而非轮内等待。

底层同步被动 API `log.replies(botId, requestMessageId, {limit?,cursor?})` 保留作账本/对账用途，返回 `MessageRepliesPage {botId,requestMessageId,scopeId,items,nextCursor}`，其中 items 是完整 `MessageInboxItem`（StoredMessage + selfEcho），此底层页不另加 deviceId。原请求不存在为 `MESSAGE_NOT_FOUND`；必须是当前 Host 上该 Bot 自己发出的 DM request，否则 `SCOPE_FORBIDDEN`。只匹配对方 `category:'reply'` 且 `replyTo===requestMessageId`，不是 rootId 下所有回复；不假设回复 localId 大于请求 localId，恢复/乱序到达也可查询。游标仍为 kind inbox，key 为 `'reply:'+sha256(JSON.stringify([botId,requestMessageId]))`，绑定设备/Bot/request，不能混用普通 inbox 或其他请求游标；不新增远端查询方法或 message-cli 子命令。

### 有界工具预览不等于原文截断

通信工具渲染的单次 JSON 文本最多 **50KiB UTF-8**。消息投影项为 `{localId,messageId,sourceDeviceId,scopeId,author,category,rootId,replyTo,text,createdAt,selfEcho,textTruncated}`；每条 text 最多 **4096 UTF-16 单元**，避免切开 Unicode 代理对，显式报告 `textTruncated`。这不是 ledger 信封替换，也不等于 M6 primary SSE 预览。

`read_scope` 页为 `{deviceId,botId,scopeId,items,nextCursor}`。整页超过字节预算只在 item 边界缩短，游标从**最后实际返回**的 localId 继续，不能跳过未显示条目；未缩页时保留查询 nextCursor。`list_scopes` 同样按完整 scope 截页，不输出损坏/半截 JSON。单个 scope 经 JSON 转义后也可能超过 50KiB：若当前页已有可返回前缀，则返回该前缀，nextOffset 指向首个未返回的 scope；若从当前 offset 开始的第一项就放不下，则返回 `isError:true` 的 `RESPONSE_TOO_LARGE` 工具错误。不跳过 scope、不截断标识符，也不返回 nextOffset 不前进的空成功页。

预览限制不修改 `messages.sqlite` 信封、`MessageLog.history/inbox/replies` 原文或 `workHistory` 原始来源 Entries。需要完整正文时由已授权的 Host 原始查询读取；模型上下文原文过大则按前述 CONTEXT_LIMIT 阻塞，不通过截断假装已经处理。

### 本机 HTTP、客户端和 CLI

沿用 Bearer、Origin 拒绝、请求体限制与现有错误映射，不增加网络 ingress 或第二个 Runtime：

| 方法与路径 | 请求体 | 成功响应 |
| --- | --- | --- |
| GET `/v1/bots/:botId/work-contexts/:scopeKey/activity` | — | 200 `WorkActivity`（允许 unbound） |
| POST `/v1/bots/:botId/work-contexts/:scopeKey/stop` | 解析后的空对象 | 200 `WorkActivity` |
| POST `/v1/bots/:botId/work-contexts/:scopeKey/resume` | 解析后的空对象 | 200 `WorkActivity` |

stop/resume 要求 `readControlBody` 解析后的值为空对象；沿用旧约定，零字节 HTTP body 等同 `{}`，并非必须发送字面 JSON `{}`。scopeKey 仍为 `'~'+encodeURIComponent(scopeId)`，服务端只解码一次、只剥一个 `~`。客户端传原 scopeId。`ControlClient.getWorkActivity(botId,scopeId,options?)`、`stopWork(...)`、`resumeWork(...)` 只接受既有 `{signal?}` 调用选项，两个 POST 仍自动发送 JSON `{}`；Web-standard 客户端不增加 Node 导入。取消 HTTP 不回滚已接纳的 stop/resume，断线后应重新查询 activity 确认。

```bash
node host-core/control-cli.js work-activity --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
node host-core/control-cli.js work-stop --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
node host-core/control-cli.js work-resume --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
```

三个命令均要求 `--bot-id --scope-id`，除共同连接选项外不接受 limit/cursor/text 等无关参数；stdout 正常 JSON，错误沿用 stderr JSON/退出码约定。本机完整 work 操作为 M10 的 get/sync/history/context 加 M11 的 activity/stop/resume。**远端仍只有** `getHostInfo`、`listBots`、`createBot`、`getBot`、`findByRequest`、`submit`、`getSubmission`、`history`、`abort`、`contextStatus` **十个方法**；不支持远端 work 控制或群/DM 直播，版本化远程接线留给模块 14。

### 模块 11 验收

父助手在 **Windows / Git Bash、Node 26.8.2 与最低版本 22.19.0** 下完成 **161/161 个检查点，失败 0**。使用 pi-durable **1.3.0**、acp-kernel **0.0.101**，本机独立 Host/链路/中继进程通过真实 WSS 通信；模型服务是实际运行的 localhost HTTP/SSE 进程，使用脚本化 **Mockoon** 响应，并未验证真实智能模型的自主判断质量或调用外部付费模型。

- **决策、作者与隔离**：人类及其他 Bot 的 room public 无须 @ 即可由各 Bot 独立处理；自身回声、DM notice/reply 只导入，不生成新请求。模型实际调用 send_room/send_dm，Host 注入真实作者，伪造字段被拒；最终 assistant 文本保持私有，其他 Bot 的 DM/请求不能越权读取，主私聊/live 不混入群历史。
- **旧稿与成员边界**：新收件使旧请求停止，未继续调用 provider；新的决策确实看到合并批次并发布新内容。来源 scope 与发送目标不同的 guard、仅目标成员资格被拒而不误判来源 replan、来源退群中止及重新加入后沿用原上下文/当前目标修订均通过。
- **逐 scope 停止**：运行中原生工作被中止且无迟发消息；停止期间继续导入但不消费输入，其他 Bot 不受影响。停止位跨 Host 重启/resume 保留，显式 resumeWork 后处理保留输入；缺模型/模型不可用错误也保留输入，修改配置不隐式清错，显式恢复后可完成。
- **DM 关联与等待**：实际 request/reply 往返保留直接 replyTo；同 rootId 下另一 request 的回复、自身 reply 和 notice 被排除，游标绑定请求。已有回复、迟到回复及超时不重发通过。等待 task **489** 在优雅关闭后由 Node 22 恢复同一 task 与原绝对截止时刻，停机期间已过期时不重新等待 30 秒。
- **发布故障恢复**：发送 task **729** 的 memo messageId 和实际消息已落盘后，以 SQLite 触发器使原生工具结果插入失败，再对该 Host 执行 SIGKILL。重开后同一工具返回原回执，即使已收到更新输入也只保留一条发布，更新输入仍在；这是“结果写入故障 + 强杀”的实测，不冒称无故障提交间隙中的精准崩溃实验。
- **原生重试与来源水位**：同一重试 task **852** 的请求 cutoff 为 **858**、缓存 BC cutoff 仍为 **856** 时正常完成；task **913** 在第 2 次尝试把来源水位 **66 → 67**，实际模型 HTTP 请求正文也更新。既未把旧 BC 缓存 cutoff 差异误判为失败，也未把新来源漏掉。
- **请求前阻断**：超大准备投影在 provider 调用前被拒，原文及未处理水位保留。工作上下文中的未知 BC kernelVersion 暴露 fatal，主私聊仍独立可用；主私聊 BC prepare 失败取消当前原生 task，**没有原文回退模型请求**，工作驱动不被该主私聊错误停止，恢复 BC 状态后可继续。
- **有界预览与本机接口**：8 条预览消息分页恰好各返回一次，输出 ≤50KiB，Unicode 截断安全，完整原文保留。scope 列表先返回可用前缀，再对放不下的单项返回 `RESPONSE_TOO_LARGE`。零字节 stop body、resume 请求体校验、Origin/方法/路径、特殊 scope 标识、CLI 无关参数及范围游标隔离均有实跑证据。
- **网络与原能力回归**：本机 Host A/B 经 WSS 完成实际模型协议 request/reply；B Runtime 关闭时，其独立链路仍保存新 notice 并 ACK，重开后只导入而不新建决策。原远端十方法通过，新 work 远端方法仍被拒（截至 M11；M14 v2 起已支持，见模块 14 一节）；M10 被动方法不建推理任务，空 Host 不因扫描创建消息库，运行时独占以及 primary history/live 保留。

公开声明通过父助手的 **strict NodeNext + `--skipLibCheck`** 检查；skipLibCheck 是针对既有第三方声明依赖，不表示检查了全部上游声明。**18 份 SQLite 数据库**完整性/外键检查通过，中心仍仅设备注册表，最终无活动原生任务或故障触发器残留。**7 个最终服务均 exit 0**，验收夹具进程全部清理，剩余进程数为 0。

详细报告：`C:/Users/46040/AppData/Local/Temp/e-launcher-group-decisions-1792558247725/module11-verification.json`。所有夹具与证据留在仓库外，未新增仓库测试、依赖、消息 schema 或 Android 改动；以上运行结论以父助手报告为依据。

### 验收限制与未交付边界

- 未验证跨物理设备/WAN、Linux、Android、arm64、Tauri/TUI 或外部付费/真实智能模型行为；本机真实 WSS 与脚本化模型协议往返不等于这些场景已通过。
- 未穷尽直接 JavaScript 参数/AbortSignal 并发矩阵或每个 close-beforeRequest 微观交错；已覆盖的是上述等待工具关闭/重启、旧稿、预算、schema 与主私聊 prepare 失败阻断路径，不承诺所有竞态均已实测。
- reply 先于 request 的恢复场景使用受信收件 CLI 模拟，不是网络认证证据；发布恢复含刻意注入的原生结果存储失败，不是无故障窗口的精准强杀，也不证明外部命令副作用 exactly-once。
- 旧模块的全局 128 pending/256 连接负载、中继慢接收者压力等未实测范围继续保留；完成数不代表全端产品完成。

## 模块 12：成员范围管理与历史补齐（已完成父助手验收）

模块 12 为模块 7 消息账本增加**托管作用域元数据**（成员修订权威）与**副本历史补齐**（已知 peer 有界交换），并提供六个本机入口与 scopeProtocol:1 中继帧链。父助手已在 Windows 本机 Host A–E、Node 26.8.2/22.19.0、真实本地 TLS/WSS 与 HTTP/CLI 下完成 **122/122 个检查点**及公开声明检查；模型回归使用 Mockoon 脚本化 HTTP/SSE 夹具，不是付费/智能模型验收。本节末尾给出验收覆盖、完整性证据与剩余限制。

### 元数据权威与成员修订

- 托管 scope 由**创建 Host**（authority）背书：`createScope(input)` 在事务内生成 UUID scopeId、装 revision1、写 authority 与投递行；`updateScope(scopeId,input)` 仅 authority 可写，按 `expectedRevision` CAS 递增，kind 与 DM 成员不可变。两类请求都先用 `{operation,…}` 摘要经 `message_scope_operations` 全局去重，同请求幂等返回原结果 revision；冲突报 `REQUEST_CONFLICT`。
- 新 revision 的目标集 = 上一修订成员 ∪ 新成员的 deviceId，剔除本机；曾被移除的设备不再收到新元数据，旧 revision 定义/消息/targets 永不改写。
- 元数据收据持久化：`acknowledgeScope` 使 `pending→acked` 并置 acked_at，`recordScopeError` 只写 pending 行的 last_error_code 保留重试；正常本地 create/update 修订保留真实 pending/acked 目标状态，仅全部 ACK 或合法本机空目标集才报告 `fullyAcknowledged:true`——这只是元数据收据，不代表消息/模型完成。副本接受方（`acceptScopeOffer`）不产生任何 outgoing delivery。当本机 authority 存在但该修订缺本地 create/update 操作记录（例如经认证 peer 恢复安装的历史修订）时，`ScopeInfo.delivery=null`，`isAuthority` 仍为 true；不推断/重建缺失的冻结目标、ACK 或请求 ID，只有存活的本地操作行才证明原交付目标创建发生在同一事务内。
- 旧 M7 安装的 legacy scope（authorityDeviceId=null）保持未托管：**既有 `installScope` 仍接受 legacy 修订**（与 M7 行为一致，不自动收养 authority），授权拒绝是独立情形——① 托管 scope 若绕过 `installScope` 安装新/异定义，报 `SCOPE_AUTHORITY_REQUIRED`（仅完全一致的已装版本幂等重试可过）；② 副本导入路径 `ensureReplicaRecord` 对未知 legacy 新修订一律拒绝（只接受与已存定义完全一致的 legacy 修订），不做 authority 转移/收养。

### 副本授权、历史与观察语义

- 只有**已知 scope peer**（任一已装修订成员或记录 authority，且非本机）能请求/携带副本；注册外部者靠猜 scopeId 不获授权。初始元数据必须直接来自 authority 的 offer；已知 peer 只能提供**同 authority** 的历史修订（conflict 拒绝）。每个历史修订必须同时包含服务 peer 与本机；`historyPage` 还要求 sourceDeviceId 属于该修订成员，且返回封套保留原始 `messageId`/作者/序号/冻结 targets——**新加入的 Bot 不会得到未面向它的旧历史**。
- `nextMissingRange` 基于索引行用 SQL（LEAD 等）找首个缺口，绝不枚举整数区间，`MAX_SAFE_INTEGER` 安全；观察到本地流未知修订也可继续。
- `recordReplicaScan` 只更新**已存在观察行**的 `last_scanned_at`/`last_error_code`，时间戳表示“该请求区间的扫描”，不是全历史完整/在线证明；空观察=未知，不做全局 completeness/online/revocation 共识声明。
- 自源恢复：副本导入允许信封 `sourceDeviceId===本机` 时，重建原始发布指纹（仅补空指纹，不改已有指纹）并用 `INSERT OR IGNORE` 恢复丢失的远端目标 outbox（保留已 ack 行）；本地随后发布沿用 highest+1，不产生新 messageId/模型效果。

### scopeProtocol:1 升级顺序与信任

- 中继先升级：只有**已协商** `scopeProtocol:1` 的 host 源向在线但**未协商**的旧目标发送 scope 帧时，relay 才回 `UNSUPPORTED`；未协商/旧源主动发送 scope 帧则按现有规则以 `REVOKED` 关闭，不会路由。新 DeviceLink 恒在 hello 声明 `scopeProtocol:1`；ready 若在其余身份/角色校验通过后缺少该能力，按 `UNSUPPORTED_SCOPE_PROTOCOL` 永久阻塞；真正不支持扩展 hello 的旧 relay 可能直接以 `BAD_FRAME` 拒绝握手。无 fallback 开关，升级必须先在 relay 侧完成。
- 业务帧仅 host 且已协商 scopeProtocol 的连接可发；源未协商/角色不符即被 `REVOKED` 关闭，不发路由；中继注入 `fromDeviceId`，不采纳客户端自报字段；offer 的 `authorityDeviceId` 必须等于发送连接设备。信任模型仍是**认证通道+TLS 信任服务 Host**：没有原始作者端到端签名/加密声明。

### 六个本机 HTTP/客户端/CLI 入口

`scopeKey='~'+encodeURIComponent(scopeId)`，服务端解码一次并仅剥一个 `~`；候选/CLI 传原始 scopeId：

| 方法与路径 | 输入 | 成功响应 |
| --- | --- | --- |
| GET `/v1/scopes?limit=&cursor=` | 仅允许 limit/cursor | 200 `ScopeListPage` |
| POST `/v1/scopes` | `{requestId, kind, members}` | 201 `ScopeInfo` |
| GET `/v1/scopes/:scopeKey` | 不允许查询参数 | 200 `ScopeInfo`，缺失 404 `SCOPE_NOT_FOUND` |
| POST `/v1/scopes/:scopeKey/members` | `{requestId, expectedRevision, members}` | 200 `ScopeInfo` |
| POST `/v1/scopes/:scopeKey/messages` | `{messageId, text, replyTo?}` | 202 发布回执（ledger 收据，非投递/推理完成） |
| GET `/v1/scopes/:scopeKey/replicas?limit=&cursor=` | 仅允许 limit/cursor | 200 `ReplicaListPage` |

- 分页默认 50、上限 200；列表页 ≤ `MAX_SCOPE_CONTROL_BYTES`（≈1MiB），副本同步页 ≤ `MAX_SCOPE_SYNC_BYTES`（≈2MiB），逐项 UTF-8 整项前缀截断，首项即超限才报 `RESPONSE_TOO_LARGE`。
- 请求体/`--input` 文件均 ≤1MiB 普通 UTF-8 JSON；新增错误映射：`SCOPE_UNMANAGED`→409、`SCOPE_AUTHORITY_REQUIRED`→403、`RESPONSE_TOO_LARGE`→413、`SCOPE_NOT_FOUND`→404。
- `createControlClient` 对应六个方法；`control-cli.js` 新增 `scope-list`、`scope-get`、`scope-create`、`scope-update`、`scope-send`、`scope-replicas`（输入 DTO 与上表一致，无生成/替换 ID）。这六个方法只在本机控制面，**不在远端 10 方法白名单**内。

### 验收状态

父助手实际运行 **122/122 个检查点通过**（Windows 本机进程、真实本地 TLS/WSS 与 HTTP/CLI，Node 26.8.2/22.19.0）。关键覆盖：

- **元数据与成员**：WSS 权威元数据分发、离线 pending 与持久 ACK（含迟到 ACK 落账）、同设备多 Bot 目标去重；托管 create/update 幂等（旧 create/update 返回原 revision）、并发 CAS 单选、移除成员不能再发布、非 authority 拒绝、DM 成员/user 消息拒绝、Managed legacy bypass 拒绝而 legacy 可推进修订、authority 所在 Host 退出成员集合后仍可修订，发布仍要求本机有成员 Bot。
- **第三方补史**：B 自 C 修复 60 条缺失消息至 61 条总数，页 46+14，原始 source/信封/digest 保留、无伪造 A outbox ACK、无原生任务参与。
- **自源恢复**：A 自源 61 条信封/digest/发布指纹相同恢复，同 ID 重试返回原时间、下一发布 sequence 62。
- **迁移/原子性**：M11 v1 真实数据在 Node 22 迁移、owner/缺身份/未来/未知拒绝且失败后 schema 原样；迁移中注入 schema 冲突后事务回滚，移除故障后重试成功；副本导入中第二个封套的冻结目标非法时，元数据、消息和来源记录整页回滚，合法页重试成功；含转义字符的 JSON 分页精确字节预算与整项前缀、非空耗尽页 null cursor、迭代器在后续写入前释放。
- **收据修正**：恢复 authority 修订（无本地操作）返回 `delivery:null`，已知 pending/acked 保留，本地空目标 ACK 合法。
- **协议边界**：scope-wire 畸形帧/未知操作/伪造 from/authority/原始源/未知码/null authority、client 能力、真 M11 relay 拒新 hello、ready 缺能力阻塞、旧目标 UNSUPPORTED、未协商源 REVOKED、同 peer 公平调度。
- **回归**：stop/resume 保留输入、被动元数据/只读操作零原生任务、被动 sync 绑定不建任务、BC 不准备、超大输入 CONTEXT_LIMIT 零 provider 请求、primary live 隔离、远端十方法通过且白名单未扩（截至 M12；M14 v2 起已扩展，见模块 14 一节）。

公开声明以 **strict NodeNext + `--skipLibCheck`** 通过；**42 份 SQLite** 完整性/外键通过（含备份/迁移夹具）；**7 个原生任务**全部终态、无活动任务/故障触发器；**18 份 BC 基础快照**的版本均为 acp-kernel **0.0.101**；夹具进程清理完成，relay 仅存设备注册表。

剩余限制：未验证物理 WAN/Linux/Android/arm64/Tauri/TUI；M7–M11 为选定回归而非全量历史场景重跑；M12 高水位/反压分支未单独饱和测试（沿用 M8 共享路径）；未穷尽并发微观交错；原始作者端到端签名/加密**未实现**，当前信任模型是认证通道+TLS 认证 peer；Mockoon 夹具不代表付费/智能模型验收。

模块 **13** 已完成 Host 侧适配交付。模块 **14**（远程 work/实时接线、统一服务与本机设置、客户端待发送/对账）已完成父助手限定范围验收（139/139 检查点，见下节），总完成数 **14/20**；模块 **15**（Android 本机 Host）已完成父助手验收（见下节），总完成数 **15/20**；模块 **16**（旧数据迁移与 Android 兼容）已完成父助手限定范围验收（见下节），总完成数 **16/20**；截至 M16，模块 **17–20 共 4 个**仍待交付（M17 后续已交付，见末节）：跨平台/外壳/真机集成。不引入中央决策、自动 routine、Session 管理或新的后台任务产品。

<a id="hindsight-memory"></a>

## 模块 13：可追溯长期记忆（Hindsight → Pi Durable，Host 侧适配交付）

模块 13 为每个 Bot 接入 Hindsight 的长期事实提取、召回与纠正能力，保留来源和适用范围。Host 侧适配已交付（M13 交付时为 13/20；当前含 M16 为 16/20）；运行环境与后端联调范围见本节末尾。

### 版本与外接方式

使用官方 `@vectorize-io/hindsight-client@0.9.2` 的公开 SDK 导出（`createClient`/`createConfig`/`sdk`）接入，而不是自己重写 REST 层；召回、投递和去重策略仍沿用 Pi Hindsight **0.13.0** 的语义，运行时接入 pi-durable **1.3.0** 与 acp-kernel **0.0.101**。SDK 已发布版本、gitHead、MIT 许可与逐字副本位置见[Bot 级扩展与 SOUL.md](#bot-级扩展与-soulmdhost-契约增量)一节；服务端版本尚待真实后端联调确认。

### 显式服务配置与数据归属

省略 `options.hindsight` 时记忆功能关闭。启用时由 Host 显式提供 `{baseUrl, apiKeyEnv?, sharedMemory?}`：

```json
{
  "hindsight": {
    "baseUrl": "http://127.0.0.1:8888",
    "apiKeyEnv": "HINDSIGHT_API_KEY",
    "sharedMemory": false
  }
}
```

`apiKeyEnv` 是环境变量名。Runtime 打开前解析其值，凭证只用于后端请求认证，不写入数据库或通过本机控制 API 返回；修改凭证后需重新打开 Runtime。显式指定的变量必须存在且包含非空、可用于请求头的 ASCII token；省略该字段可使用无认证服务。远端地址要求 HTTPS，HTTP 仅允许回环地址，拒绝 URL 内的凭证、查询串和 fragment。新配置推荐写在 `runtime.extensions.hindsight`（含每 Bot 启用/读写模式，见[Bot 级扩展与 SOUL.md](#bot-级扩展与-soulmdhost-契约增量)）；本节形状作为 legacy `runtime.hindsight` 仍被接受，两者不得同时出现。

事实提取与检索由 Hindsight 执行。本机 `hindsight.sqlite` 保存输入关联、持久投递队列、有限的召回缓存、来源和纠正审计，不建立另一套事实检索系统。原始 Durable Entry 和 `messages.sqlite` 历史保持完整。适配器绑定服务 URL 的哈希，拒绝把已有队列改投其他端点。

服务和凭证由各 Host 持有；relay 不接收记忆数据或凭证。不继承当前 Pi 的个人、项目、全局记忆库、HOME 配置或会话文件身份。

### 私有与共享记忆库（bank）

记忆库按 `(deviceId, botId, target)` 确定，target 为 `{kind:'primary'}`、`{kind:'scope',scopeId}` 或 `{kind:'shared'}`。主私聊、各 room 和各 Bot DM 分开。

`sharedMemory` 默认关闭。开启后，仅显式笔记可进入同一 Bot 自己的 shared bank：本机 API/CLI 使用 shared target，模型工具使用 `shared:true`。自动转录不进入 shared bank。模型工具的 Bot、来源 scope 和请求身份由 Host 注入；scope 中的写入、纠正、重试与 reflect 仍检查来源 scope 的成员和停止状态。历史读取沿用已有工作绑定的授权。

### 自动召回与来源

- 请求模型前持久记录输入关联；只在 submission 完成后收集输入、最终回答及冻结的 scope 消息。未回答 submission 不触发自动投递，原始输入仍保留。
- 自动召回在 BC prepare 后按剩余预算临时加入请求，不写入 Durable 条目或 BC 源。当前明确输入和原始证据优先。
- 真实来源与模型 role 分开记录。主私聊来源标记为控制调用方，不据 `role:user` 认证人类；scope 来源保留账本的作者、消息 ID、修订、目标和摘要。
- 显式记忆工具调用及结果属于普通 Durable 工具历史，但不作为自动转录来源。发送的文本先做常见秘密脱敏，再完整分块；脱敏规则不覆盖所有秘密形态。

### 投递与纠正

异步受理后通过 operation 状态确认抽取结果。投递前先查询原 operation；需要重投时沿用冻结 payload、operation ID 和 document ID。失败抽取只慢速查询状态，显式 retry 才请求重试；服务端抽取和 retry 不承诺 exactly-once。

纠正、失效和恢复只修改 Hindsight 派生事实，保留意图、before/after 快照和回执。PATCH 结果不确定时记录 `unconfirmed`，同一请求不再发送 PATCH；明确 HTTP 4xx 拒绝记录 `rejected/responded`。支持纠正 `world` / `experience` 事实，派生 observation 应追溯来源事实。

### 八个本机 API/CLI 与八个模型工具

| Runtime API | 控制 CLI | 模型工具 |
| --- | --- | --- |
| `memoryStatus(botId, input?)` | `memory-status` | `hindsight_status` |
| `recallMemory(botId, input)` | `memory-recall` | `hindsight_recall` |
| `reflectMemory(botId, input)` | `memory-reflect` | `hindsight_reflect` |
| `retainMemory(botId, input)` | `memory-retain` | `hindsight_retain` |
| `getMemory(botId, input)` | `memory-get` | `hindsight_get` |
| `getMemorySource(botId, input)` | `memory-source` | `hindsight_source` |
| `correctMemory(botId, input)` | `memory-correct` | `hindsight_correct` |
| `retryMemory(botId, input)` | `memory-retry` | `hindsight_retry` |

HTTP 状态入口为 GET `/v1/bots/:botId/memory`，其余七个操作为 POST `/v1/bots/:botId/memory/{recall,reflect,retain,get,source,correct,retry}`。retain/correct/retry 返回 202 回执，其他操作返回 200。原远端十方法白名单保持不变，远端记忆与实时接线留给模块 14（模块 14 v2 起已扩展为固定方法表，并加入远端记忆/实时接线，见[模块 14](#模块-14统一-host-服务与设备接入已完成父助手限定范围验收)一节）。这八个方法（以及手动压缩 `/compact`，见“对话命令”一节）使用“后端 120s ≤ 本机 HTTP 130s ≤ 中继/目标 135s ≤ 客户端 140s ≤ 桌面 broker 145s ≤ 原生外层 150s”超时链，其余方法超时不变（详见[Bot 级扩展与 SOUL.md](#bot-级扩展与-soulmdhost-契约增量)一节）。

`memoryStatus` 输入为 `{target?,state?,limit?,cursor?}`，state 为 pending/accepted/completed/failed，limit 为 1–200（默认 20）。游标 `{bankId,state,afterOperationId}` 绑定派生记忆库与过滤条件，不赋予跨库权限。计数覆盖整个上下文，state 只过滤分页 jobs；返回 `jobs/nextCursor` 可发现自动投递失败的 operation ID。状态查询不创建记忆库、不发起后端请求，可读取已有库。禁用时计数与 jobs 为 null；配置但未建库时计数为 0、jobs 为 []。

CLI 均要求 `--bot-id`。`memory-status` 可选 `--input`，其余命令必须提供输入 JSON 文件。这八个模型工具与八个 RPC 都受每 Bot 扩展策略约束：关闭时工具全部隐藏且自动任务暂停，只读时 `retain`/`correct`/`retry` 被拒（`EXTENSION_READ_ONLY`）且暂停自动写入；`memoryStatus` 的 `enabled:false` 仍是正常状态（见[Bot 级扩展与 SOUL.md](#bot-级扩展与-soulmdhost-契约增量)）。

### 内部文件与关闭

`hindsight-client.js`、`hindsight-format.js`、`hindsight-protocol.js` 分别负责官方 SDK 适配（每实例 fetch、`redirect:error`、超时、2 MiB 边界）、脱敏/渲染和参数规范化；`hindsight-store.js`、`hindsight-sources.js` 负责持久状态与来源；`hindsight-service.js`、`runtime-hindsight.js`、`hindsight-tools.js` 负责服务、生命周期和模型工具。

关闭时先启动 Durable 的 close，再取消网络请求并等待记忆调用结束，最后关闭记忆库，避免把普通关闭写成持久任务中止。

### 验收状态

**79/79 个检查点通过**。环境为 Windows、Node **26.8.2 / 22.19.0**，实际运行 Durable、BC、HTTP、CLI 和 SQLite；模型与 Hindsight 响应使用隔离 Mockoon 协议夹具。覆盖：

- 八个 API/CLI/模型工具、独立 runtime-cli，禁用与配置边界，Bot/primary/room/DM 隔离、显式 shared 笔记及作者来源。
- 120 条 scope 消息与两条回答生成 122 个 job；每页 50 条来源收集；58850 字节状态页完整返回；12 个并发主私聊提交全部收集。
- 脱敏来源完整重建为三个不拆 Unicode 代理对的文本块；转义引号秘密脱敏；51197 字节工具预览保持合法 JSON。
- BC 实际压缩一个块、节省 6629 token；后续模型请求同时保留压缩摘要与临时召回，BC 摘要未自动投递为长期记忆。预算不足跳过召回，认证失败时自动召回退回无记忆运行。
- 稳定投递身份、当前状态去重回执、失败抽取与显式重试；纠正审计、HTTP 500/畸形 2xx 的不确定状态、明确拒绝及 pending 审计恢复。
- 本地快照失败时零 PATCH、阻断模型请求并保留原始输入；未来 schema、缺列、设备与端点错配先拒绝再恢复。
- 召回期间关闭后保留可恢复任务；Node 22 重开完成原 submission；2 MiB 后端响应上限与后续调用恢复。

公开声明通过 strict NodeNext + `--skipLibCheck`；**16 份 SQLite** 完整性/外键检查通过，**77 个原生任务**全部终态，两个启用记忆的 Host 分别完成 **206 和 4 个投递 job**。**11 次 Host 服务进程退出码均为 0**，夹具进程已清理。

真实 Hindsight 服务部署、API 互通与事实抽取/召回/reflect 质量尚待联调，未访问真实记忆库。本轮未覆盖 Linux、Android、arm64、Tauri/TUI 或物理 WAN；并发提交产生了 12 个不同回答，共用最终回答的运行场景未单独验证。M1–M12 保留原有验收记录，本轮只回归相关路径。

## 模块 14：统一 Host 服务与设备接入（已完成父助手限定范围验收）

模块 14 把模块 5 本机控制面、模块 8/9 认证中继与远程控制、模块 10–12 工作上下文/scope、模块 13 记忆整合为**统一本机服务**（`openHostService`），并新增本机设置持久化、远端协议 v2（M14 交付时 35 个方法；含后续 SOUL 增量现为 37 个）、受控远端实时预览与客户端待发送/对账。

**状态**：模块 14 已完成交付并获父助手限定范围验收，总完成数 **14/20**；模块 15–18 后续已交付（见下节与末节），M19 已移出本期（本期不交付）、M20 进行中（见末节模块 20-01）。

### 验收覆盖

- 环境：Windows x64 / Git Bash、Node 26.8.2 与 22.19.0、真实本地 HTTP/CLI/TLS/WSS、持久 SQLite、Pi Durable 1.3.0 + acp-kernel 0.0.101；模型与 Hindsight wire 响应来自隔离 Mockoon OpenAI-compatible SSE/Hindsight 协议夹具。无新增依赖、无仓库测试或临时脚本。
- 结果：139/139 检查点通过，失败 0；53 份 SQLite 完整性/外键通过（含刻意构造的畸形 schema 夹具，SQLite 一致性不代表这些 schema 被接受）；8 个 Native tasks 全部 terminal、0 active；30 个 tail readers 清理、夹具进程剩余 0。
- 覆盖要点：统一服务/离线 settings/CAS/重开/重复 owner、null 与 512KiB 启动边界、缺 memory-env 离线救援、settings 存储错误与关闭恢复；35 个固定 v2 方法（含 8 个 memory 方法）；冻结 v1 客户端与 Host 桥兼容及能力拒绝；primary/work 安全快照、冷被动、null→公开绑定、normal/error 帧结束、sequence/目标/私有字段拒绝、1MiB JSON preflight（含误标 SSE）；pending 离线持久化、同 payload 去重/冲突、显式 send、accepted/rejected 不重连、畸形回复/读、仅缺失精确重试、本地持久失败与只读恢复、schema 先校验与 owner 锁；EPIPE 观察者关闭后慢模型实际完成、同一 submissionId 69 在统一服务重开后恢复并完成、持久 scope 停止跨重开保留；scope 查询分页/游标绑定与含斜杠/点/中文/emoji 消息 ID、跨 scope 查找隐藏；relay schema 仅 relay_devices 且无合成业务/凭证标记。
- 兼容性说明：冻结的 M13 基线 v1 远程 CLI 与 device-link 桥接端配合当前控制服务（位于冻结桥后）实际调用 `getHostInfo`，验证 v1 客户端/桥接互操作；这不是整个旧 Runtime 或每个旧客户端场景都冻结验证的断言。
- 开流超时实测：无首帧时约 20.159 秒触发超时，合成 Host 协议对端收到对应 live-cancel；活动观察期间凭证撤销/轮换生效，旧 token 拒绝、新 token 可用；8-live 容量通过。

### 统一本机服务（openHostService / host-service-cli）

- `openHostService({dataRoot, token, center:{url, deviceToken, ca?}, port?, initialSettings?, npmPath?})` 返回 `{deviceId, url, getStatus(), close()}`。Host 先连接中心并取得配置，再启动本机控制服务与中心提供的 relay 链路；`npmPath` 可指定绝对的 `npm-cli.js` 路径。控制 token 与设备 token 必须不同，设备须先在中心登记。
- 默认命令为 `serve`，也支持显式 `serve` 与离线 `settings-get`/`settings-set`。启动仅输出一行 JSONL `{"event":"listening","deviceId":...,"url":...}`——只表示本机回环控制监听成功，不声称 relay 在线/ready。stdin 一行 `shutdown`、SIGINT、SIGTERM 走同一幂等 `close()`：成功 exit 0，失败 stderr 输出 `{"error":{"code":...,"message":...}}` 后 exit 1；stdin EOF 不关服务；关闭不持久 abort Agent。
- 状态 `getStatus()`/GET `/v1/service` 包含本机控制、relay、中心状态与设置 revision；`phase:'running'` 不代替远端在线状态。关闭后状态冻结，不再查询已关数据库。`getHostInfo` 旧字段形状保持。
- 局部启动失败按已打开资源关闭。保留既有独立 `control-server-cli`/`device-link-cli` 可用，统一服务不删除 legacy 用法。
- Windows 当前用户登录自启动见下文「Windows 登录自启动」一节；它不是系统服务，不保证 Host 始终在线，也不由 Tauri 桌面客户端管理。

### 本机设置持久化（host-settings.sqlite）

- `host-settings.sqlite` schema v1 只两张表：`settings_identity`（id=1 + device_id）与 `host_settings`（id=1 + revision + settings_json，规范 JSON ≤512KiB）。schema0 仅空库初始化；未知版本/表清单/缺列/identity 不匹配在写前拒绝，不 reset/drop。默认 revision 1。同步 BEGIN IMMEDIATE CAS 替换：expectedRevision 为正安全整数且精确匹配，递增不溢出，失败回滚保留原完整 JSON。Store.get() 返回重新解析副本，close 后封口。
- Settings 形状 `{runtime:<严格原始运行时配置>, relay:null|{url,tokenEnv,caFile?}}`，规范 JSON 持久保存配置本身（含 URL、模型目录、预算、CA 路径等）；**仅凭证字段以环境变量名表示**（apiKeyEnv/tokenEnv），值不写入库、不进中继；caFile 是绝对路径引用，读取发生在服务启动时。relay.url 用 parseRelayUrl 校验；tokenEnv 只校验合法 env 名不读值；null 表示停用。`normalizeHostSettings` 纯校验，无 env/文件/网络。
- `--initial-settings` 用于初始化设置；已有库也接受规范化后相同的 seed（相同 seed 可重开），差异报 REQUEST_CONFLICT 且不覆盖已有设置。
- HTTP 更新与本机离线 CLI 都可用：GET/PUT `/v1/settings`（Bearer + 拒任何 Origin；PUT 严格 `{expectedRevision,settings}`，无 query）；离线 `host-service-cli settings-get/settings-set` 只需 `--data-root`（settings-set 另需 `--input`），不启动 Runtime/模型/链路、不解析 env——上次服务因 Hindsight/tokenEnv 缺失启动失败后也能读取并修正本机设置，是配置错误救援入口。
- DTO `LocalSettingsSnapshot = {...Snapshot, activeRevision, restartRequired:revision!==activeRevision}`。更新只持久化、下次重开生效；不热替换 Models/Runtime/链路、不自动重启、不修改已持久会话的 model。未配置 store/callback 时新设置路由返回 CONTROL_UNAVAILABLE 503，不影响旧服务；activeSettingsRevision 固定于本次启动，getStatus 实时读当前持久 revision 对比。
- 模型目录白名单：`getModelCatalog`/GET `/v1/models` 只返回 `{defaultModel, models:[{modelRef,name,contextWindow,maxTokens,reasoning}]}`，无 baseUrl/header/secret/env 名；同步 getModels 白名单仅 chat，不 refresh/getAuth/网络，不唤醒模型。

### Windows 登录自启动（autostart-enable / autostart-disable / autostart-status）

`host-service-cli.js` 的三个 autostart 命令在当前 Windows 用户的 Startup 目录（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）管理一个本项目专属 `.cmd` 启动文件；非 Windows 调用返回 `INVALID_ARGUMENT`，不提供 Linux/macOS 自启动。它不是系统服务、不需要管理员权限、不包含崩溃重启监督器，也不启动/停止当前正在运行的 Host。桌面安装包的自启动由 `pibot-host` 启动器负责（Linux systemd 用户单元、Windows 登录任务、macOS 用户 LaunchAgent），见 [desktop/README.md](../desktop/README.md#各平台的当前差异)。

- **文件名**：`e-launcher-host-<dataRoot 规范化路径 SHA-256 前 16 hex>.cmd`——同一规范化 `--data-root` 始终映射到同一文件，重复 enable 幂等覆盖；不同 dataRoot 是互相独立的自启动实例，disable 只删除对应文件。
- **enable** 复用 serve 的全部必需/可选启动参数与校验（重复 flag、env 名格式、`validateCenterUrl`、port 十进制、绝对 data-root 等），但**不读取 token 值、不要求中心在线、不打开 runtime owner**。写入的是一条完整的 `"node.exe" "<cli 绝对路径>" serve --data-root ...` 命令行；`--center-ca-file`/`--initial-settings` 与 serve 一样允许相对输入、注册时 resolve 为绝对路径，`--npm-path` 保持绝对要求（均不读文件内容），这些路径必须在登录时仍然有效。写入走同目录临时文件 + rename 原子替换；必要时创建 dataRoot 目录供重定向打开日志，但不初始化 Runtime。
- **字符边界**：.cmd 以 UTF-8 写入并在首行 `chcp 65001>nul`；每个参数完整双引号引用，`%` 转义为 `%%`（不使用 `call`，无二次展开），参数末尾连续反斜杠按 Windows argv 引号规则翻倍，`setlocal DisableDelayedExpansion` 防 `!` 被展开。含中文等 Unicode、空格、`&`、`()`、`!`、`%` 的合法路径可用；仅 NUL/CR/LF/双引号等无法表达的输入被拒绝。
- **status** 输出单行 JSON `{registered, file}`；disable 输出 `{registered:false, file}`。**registered 只表示启动文件存在，不表示该 Host 已在登录会话中运行过或当前在线**。
- **启动行为**：登录后 Windows 以当前用户身份执行该 .cmd；脚本把 `stdout/stderr` 追加到固定的 `<dataRoot>\autostart.log`。启动的 Host 仍是直接 `node serve` 进程，stdin EOF 不会停止它。
- **Shower 授权提示**：Windows 上 Host 每次启动都执行 Shower `prepare`（`runtime.js` 无条件调用，经一次性 SYSTEM bootstrap 任务请求管理员授权）。实测每次新 Host 启动都会弹出一次 UAC；取消该授权会让整个启动以 `SHOWER_PERMISSION_REQUIRED` 失败退出。登录自启动保留这一既有行为——登录启动的 Host 同样需要用户在桌面确认该次 UAC，自启动不改变、不绕过它。
- **持久环境（必要前提）**：启动文件只保存参数与 token 环境变量**名**；`--token-env`/`--device-token-env` 指向的变量值、运行时设置中的 `apiKeyEnv`/`tokenEnv` 必须在 **Windows 用户或系统环境变量**中持久配置（「系统属性 → 环境变量」或 `setx`），仅在终端 `set`/`$env:` 的临时变量不会跨登录保留，登录启动的 Host 会因缺少变量而在启动时失败（错误记录在 `autostart.log`）。
- **--env-file 与非秘密原生路径**：`autostart-enable` 会把注册进程 `node --env-file=<file>`（`--env-file path` 形式同样支持）规范化为绝对路径写进生成命令行，登录启动用同一份 env 文件提供变量值；文件内容不读取、不复制。`E_LAUNCHER_SHOWER_WINDOWS_EXE` 存在时以 `set "E_LAUNCHER_SHOWER_WINDOWS_EXE=..."`（规范化绝对路径）写入启动脚本，让登录会话找到非秘密的 Shower 原生后端；其他 `execArgv`（debug/preload 等）与环境变量一律不继承。生产部署典型用法：`node --env-file=D:\services\e-launcher\secrets\host.env host-core/host-service-cli.js autostart-enable ...`，并以 `E_LAUNCHER_SHOWER_WINDOWS_EXE` 指向已部署的 `shower-windows.exe`。

### 本机控制面新增路由

| 方法与路径 | 说明 |
| --- | --- |
| GET `/v1/models` | 模型目录（被动，不唤醒模型） |
| GET `/v1/bots/:botId/work-contexts/:scopeKey/live` | 工作上下文实时预览 SSE（事件名仍 bot-live） |
| GET `/v1/scopes/:scopeKey/history` | scope 消息历史（1MiB 整项前缀响应，零项放不下报 RESPONSE_TOO_LARGE） |
| GET `/v1/scopes/:scopeKey/messages/:messageKey` | 单条存储消息；缺失 404 MESSAGE_NOT_FOUND |
| GET `/v1/scopes/:scopeKey/messages/:messageKey/delivery` | 投递状态；缺失 404 DELIVERY_NOT_FOUND |
| GET/PUT `/v1/settings` | 本机设置快照/更新（可选 store，见上节） |
| GET `/v1/service` | 统一服务状态 |

scopeKey/messageKey 固定 `~` 前缀再逐段编码，保护 `.`/`..`/Unicode/斜杠；新路径拒绝无关 query；history 严格 limit(1..200)/cursor 对象，拒未知/重复键。

### 远程协议与握手（40 方法）

- relay 协议不变：protocolVersion 1；scopeProtocol 仅 host 侧 1。Host hello controlProtocol 可为 1 或 2，client hello 可省略（legacy）或声明 2（client 声明 1 无效）。ready 可带 controlProtocol:2，省略即 legacy。**v2 client/link 必须要求 ready 回显 2**；旧 client/host 经 v1 方法兼容。
- 控制方法表 `CONTROL_METHODS` 共 37 个：旧 v1 十方法（getHostInfo/listBots/createBot/getBot/findByRequest/submit/getSubmission/history/abort/contextStatus）+ v2 27 个 = M14 原 25 个（getModelCatalog/getWorkContext/syncWorkContext/workHistory/workContextStatus/getWorkActivity/stopWork/resumeWork/listScopeStates/createScope/getScopeState/updateScope/publishUserMessage/listScopeReplicas/scopeHistory/getScopeMessage/getScopeMessageDelivery/memoryStatus/recallMemory/reflectMemory/retainMemory/getMemory/getMemorySource/correctMemory/retryMemory）不变 + SOUL 2 个（getBotSoul/setBotSoul）。memory 方法 wire params 均为 `{botId,input}`；分页/scope 参数提取 limit/cursor；SOUL setter 也是 `{botId,input}`，input 带 `expectedRevision` SHA-256 与 `text`。
- 能力门控：legacy client（省略 controlProtocol）只能 v1 方法；v2 client 可用 v1/v2，但目标 host.controlProtocol 必须 ≥ controlMethodVersion。无 capability 回 CONTROL_UNAVAILABLE/not-sent；离线 OFFLINE/not-sent；不转发不支持的方法、不创建中央邮箱。settings/status 不加入远端表，无通用代理。结果三态（not-sent/unconfirmed/responded）沿用。
- 聊天命令增量：`CONTROL_METHODS` 追加 `clearHistory`/`compact` 两个 additive v2 方法，params 仅 `{botId}`，见“对话命令”一节。
- 阶段澄清：M10–M13 历史验收记录的“远端仅十方法/远程 work 不可用”在该时间点成立；M14 v2 起远端已是固定方法表（M14 交付时 35 个，含 SOUL 增量现为 37 个），支持固定 work/memory RPC；各模块历史验收文字中的“35 方法”是该次验收时的方法数，不是当前契约。relay 仅有界瞬时转发业务，不持久保存业务正文/工作上下文/模型与 Hindsight API 凭证，也不运行推理；中心仅持久保存设备登记、名称/平台与认证校验信息（设备 token 哈希/credentialVersion），设备认证校验数据不与模型/Hindsight 业务凭证混同。无通用代理、中心变更邮箱、自动重放或 E2E 作者签名/加密声明。
- 设备目录：`devices-list` 是中继自有帧，不转发给 Host；新客户端请求 `names:1` 后返回持久化的 `displayName` 和可选 `platform`，旧请求仍仅返回原四个字段。未命名设备回退 deviceId，离线设备也保留名称；`deviceId` 始终是路由键。认证的 controlProtocol 2 client 可调用 `renameDevice({deviceId, displayName})`（CLI 用 `renameDevice --input`），只能改名有效注册的设备；Host 重连只填首次默认名，不覆盖已有名称。注册可选 `--display-name`，凭据仍只从环境变量读取。注册/轮换/撤销仍是本地特权动作。
- **升级顺序：先中继，再 Host 和客户端。** 新 Host hello 和新客户端设备目录请求使用扩展字段，旧中继会拒绝并断开，不能把该错误当成功；旧 Host/客户端仍可连接新版中继。中继数据库在事务中从版本 1 添加名称/平台字段，不改变设备凭据或撤销状态。

### 远端实时预览（remote live）

- 订阅目标精确为 `{kind:'primary',botId}` 或 `{kind:'work',botId,scopeId}`；work scopeId 恒非空，conversationId 可 null（未绑定）后一次性转为公开 UUID，不可回退/更换；primary 不带 scopeId 且 conversationId 恒非空。
- 帧为**完整快照**：`{type:'snapshot',botId,conversationId,sequence,state,scopeId?}`；state 精确复用投影 8 键（history/historyTruncated/lastEntryId/generation/tools/toolsTruncated/busy/queuedCount），每帧 ≤8MiB，不做枚举假设；work 只发完整快照（无 update）。取消/断流只结束观察，不执行 Agent abort，不自动重连/重放。
- 容量与打开：有界路由 8/client、8/host、128 总槽位；opening 期限 20s（首合法 snapshot 后移除），不是持续观察 lifetime；sequence 严格递增（第一帧允许 0）；正常结束 end 帧理由限 stopped/cancelled/session_closed/retired/listener_error/session_failed，不含 error；error 结束是单独异常（带固定 CONTROL_ERROR_CODES 码）。客户端反压不能无界排队或静默丢必要结束。验收实测见上节“实时预览实测”。
- 本机控制面回环 HTTP 继续拒任何 Origin；浏览器/WebView 需要 native fetch 适配器（不发送 Origin）。

### 客户端待发送与对账（pending client / pending-cli）

- `openPendingClient({dataRoot,deviceId,call})` 同步构造；dataRoot 是客户端自己的绝对状态目录（非 Host），deviceId 显式本机身份；call(targetDeviceId,method,params,{signal}) 是注入的固定操作传输，不存凭证。
- `client-pending.sqlite` schema v1：identity + pending 行（唯一规范化 target/业务 key + 正文指纹）；专用 `pending-owner.sqlite` 独占生命周期 BEGIN IMMEDIATE lease（沿用 runtime-owner 模式），防两个客户端 writer/恢复竞争。不支持/损坏/异设备数据拒绝，不 reset/drop；重开取得独占锁后，遗留 sending 行转为 unconfirmed；open/list/get/enqueue 无网络（reconcile 属显式只读 RPC，见下）。
- enqueue 幂等按 targetDeviceId+kind+(botId/scopeId)+(requestId/messageId)；同规范化 payload 返回当前行，不同 text/replyTo 冲突。调用方用唯一业务 request/message ID per intent；本地行 id 随机 UUID。持久化在变更派发前；本地写失败向上抛，绝不改写为远端拒绝；崩溃后仍可对账。
- states：pending/sending/unconfirmed/accepted/rejected。list 默认 20（1..200），可选 state 精确枚举，keyset cursor `{deviceId,state,afterId}`。
- call 只用 submit/getSubmission/publishUserMessage/getScopeMessage；primary submit 扁平 `{botId,requestId,text}`，查询 `{botId,requestId}`；room publish `{scopeId,input:{messageId,text,replyTo}}`，查询 `{scopeId,messageId}`。无 wait/abort/任意队列。
- **无自动投递/重放**：open/重连/list/后台定时器不发请求，send 是显式用户动作；reconcile 只发起只读查询 RPC，不派发变更、不触发模型。已 accepted 的 send 直接返回保存记录，不再发起另一次变更（accepted 重复 send 不连 relay 传输）。并发重复 send 在首次受理后不得发重复请求。
- unconfirmed 显式 send 先只读 reconcile；匹配到回执标 accepted，缺失 SUBMISSION_NOT_FOUND/MESSAGE_NOT_FOUND 保留 unconfirmed，随后该次显式 send 可重试同一冻结业务 ID/payload。失败/不支持的对账不触发变更。reconcile 只读：primary 匹配 botId/requestId 与有效回执状态；room 匹配 sourceDeviceId===targetDeviceId、scopeId/messageId、author.kind==='user'、category==='public'、text/replyTo；矛盾 → REQUEST_CONFLICT/rejected，绝不静默替换 payload。**accepted 是 Host 受理，不是模型完成或 peer ACK**。
- 变更错误映射：明确 not-sent → pending；unconfirmed → unconfirmed；仅确定校验/归属/冲突码（INVALID_ARGUMENT/INVALID_CWD/REQUEST_CONFLICT/BOT_NOT_FOUND/SCOPE_NOT_FOUND/SCOPE_FORBIDDEN/MODEL_REQUIRED/MODEL_NOT_FOUND）且 responded 或本地 4xx → rejected；NETWORK/BAD_RESPONSE/INTERNAL/STORE_FAILED/RESPONSE_TOO_LARGE 及歧义失败即使服务端已回 → unconfirmed。lastError 只用稳定码，无自由文本 message/stack。
- close 封口 enqueue/send/reconcile，中止观察传输请求，join 已受理 inflight 持久化，关闭库并释放 owner；不取消目标 Agent。调用方取消在派发前留 pending，派发后除非确认 not-sent 否则 unconfirmed。sourceDeviceId 与真实作者/role 分离：room 对账校验来源与正文；callId 只是传输关联，不是业务幂等键。

### CLI 示例（不含真实凭证）

```bash
# 示意语法：取值按需设置为 shell 变量（DATA_ROOT、BOT_ID、SCOPE_ID、SOURCE_DEVICE_ID、
# TARGET_DEVICE_ID、RELAY_URL、CLIENT_STATE、CLIENT_DEVICE_ID、RECORD_ID）；[ ] 表示可选参数，
# 复制时按需取舍。

# 首次取得 Host 身份；在中心机器用相同设备 token 登记该 deviceId（CENTER_DATA_ROOT 为中心数据根）
node host-core/cli.js init --data-root "$DATA_ROOT"
node host-core/relay-registry-cli.js register --data-root "$CENTER_DATA_ROOT" \
  --device-id "$HOST_DEVICE_ID" --token-env HOST_DEVICE_TOKEN
# 统一本机服务（默认 serve；两种 token 各从环境变量读取且必须不同）
node host-core/host-service-cli.js serve --data-root "$DATA_ROOT" --token-env CONTROL_TOKEN \
  --center-url https://center.example.com:8443 --device-token-env HOST_DEVICE_TOKEN \
  [--center-ca-file /path/to/ca.pem] [--npm-path /absolute/path/to/npm-cli.js] \
  [--initial-settings initial-settings.json] [--port 8787]
# --initial-settings 用于初始化，已有库相同 seed 可重开。中心 UI 只列已登记设备，没有网页登记表单。
# 离线设置读取/修复（不启动 Runtime/模型/链路）
node host-core/host-service-cli.js settings-get --data-root "$DATA_ROOT"
node host-core/host-service-cli.js settings-set --data-root "$DATA_ROOT" --input settings-update.json
# Windows 登录自启动（仅 Windows；参数要求与 serve 相同，不读 token 值、不启动服务）
node host-core/host-service-cli.js autostart-enable --data-root "$DATA_ROOT" --token-env CONTROL_TOKEN \
  --center-url https://center.example.com:8443 --device-token-env HOST_DEVICE_TOKEN \
  [--center-ca-file "C:\path\to\ca.pem"] [--npm-path "C:\absolute\path\to\npm-cli.js"] \
  [--initial-settings "C:\path\to\initial-settings.json"] [--port 8787]
node host-core/host-service-cli.js autostart-status --data-root "$DATA_ROOT"
node host-core/host-service-cli.js autostart-disable --data-root "$DATA_ROOT"
# settings-update.json 完整合法内容示例：
# {
#   "expectedRevision": 1,
#   "settings": {
#     "runtime": { "providers": [] },
#     "relay": {
#       "url": "wss://relay.example/v1/link",
#       "tokenEnv": "RELAY_TOKEN",
#       "caFile": "/path/to/ca.pem"
#     }
#   }
# }

# 本机控制命令（新增命令；仍要求 --url/--token-env）
node host-core/control-cli.js models --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN
node host-core/control-cli.js service-status --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN
node host-core/control-cli.js settings-get --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN
node host-core/control-cli.js settings-set --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN --input settings-update.json
node host-core/control-cli.js work-live --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id "$SCOPE_ID"
node host-core/control-cli.js scope-history --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN --scope-id "$SCOPE_ID" --limit 50
node host-core/control-cli.js scope-message --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN --scope-id "$SCOPE_ID" --message-id m-1
node host-core/control-cli.js scope-delivery --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN --scope-id "$SCOPE_ID" --message-id m-1

# 远端控制（40 方法 + listDevices/live）——--input 一律指向文件，不用 inline JSON
node host-core/remote-control-cli.js listBots --device-id "$SOURCE_DEVICE_ID" --target-device-id "$TARGET_DEVICE_ID" \
  --url "$RELAY_URL" --token-env REMOTE_CONTROL_TOKEN [--input control-input.json] [--ca /path/to/ca.pem]
node host-core/remote-control-cli.js listDevices --device-id "$SOURCE_DEVICE_ID" \
  --url "$RELAY_URL" --token-env REMOTE_CONTROL_TOKEN [--input devices-input.json]
node host-core/remote-control-cli.js live --device-id "$SOURCE_DEVICE_ID" --target-device-id "$TARGET_DEVICE_ID" \
  --url "$RELAY_URL" --token-env REMOTE_CONTROL_TOKEN --input live-work.json
# devices-input.json 完整合法内容示例：
# { "limit": 50 }
# live-work.json 完整合法内容示例（把 botId/scopeId 替换为实际值）：
# {
#   "kind": "work",
#   "botId": "b-xxxx",
#   "scopeId": "room-1"
# }

# 客户端待发送（--data-root 是客户端状态目录，非 Host；--input 同理指向文件）
node host-core/pending-cli.js enqueue --data-root "$CLIENT_STATE" --device-id "$CLIENT_DEVICE_ID" --input enqueue.json
node host-core/pending-cli.js list --data-root "$CLIENT_STATE" --device-id "$CLIENT_DEVICE_ID" --state pending --limit 20
node host-core/pending-cli.js get --data-root "$CLIENT_STATE" --device-id "$CLIENT_DEVICE_ID" --id "$RECORD_ID"
# send/reconcile 必须且只能指定一种传输：
node host-core/pending-cli.js send --data-root "$CLIENT_STATE" --device-id "$CLIENT_DEVICE_ID" --id "$RECORD_ID" \
  --local-url http://127.0.0.1:8787 --token-env CONTROL_TOKEN
node host-core/pending-cli.js reconcile --data-root "$CLIENT_STATE" --device-id "$CLIENT_DEVICE_ID" --id "$RECORD_ID" \
  --url "$RELAY_URL" --token-env RELAY_TOKEN [--ca /path/to/ca.pem]
```

### 限制与未实测边界

- 未实测：物理 WAN/多机、Linux/Android/arm64、Tauri/TUI 与 native-fetch UI 集成。
- 真实 Hindsight 互操作/语义质量与真实外部付费模型行为未验收。
- 全局 128-live/256 连接饱和与持续慢读/反压压力未验收。
- 穷举直接 JS AbortSignal/iterator.return/close 与跨代延迟 teardown 交错未做。
- 真实交互式 Windows/Linux 控制台 SIGINT/SIGTERM 矩阵未穷尽。
- 类型检查：skipLibCheck 通过；完整检查仍有既有 genai 声明缺 `@modelcontextprotocol/sdk/client/index.js`（TS2307），不宣称全量第三方类型检查通过。
- 统一长驻服务不是操作系统服务安装器，也不保证始终在线；Android/Tauri/TUI、迁移与既有原生兼容属于后续模块。
- TLS+认证通道 peer 不等于原始作者的端到端签名/加密；relay 仅有界瞬时转发业务，不持久保存业务正文/工作上下文/模型与 Hindsight API 凭证或运行推理；中心仅持久保存设备登记、名称/平台与认证校验信息（设备 token 哈希/credentialVersion）。模块 13 的记忆接线与限制保留，不改路线 M15–M20。

## 模块 15：Android 本机 Host 与原生能力桥

**状态**：M15 已交付并获父助手验收，总完成数 **15/20**；模块 16–18 后续已交付（见下文），M19 已移出本期、M20 进行中（见末节）。M14 历史记录及其验收边界保留。

### 架构与生命周期

Android 本地 Host 在受监督的独立 Node Mobile 子进程中运行 Durable/chord/pi-ai 1.3.0；BC 作为单独的受管插件安装，不内嵌 acp-kernel。Capacitor 保留；未做旧数据迁移或 Tauri。仅用户显式开启的 specialUse FGS；无 boot/auto-start/空闲关闭/粘性重启。专用私有 JSONL、onStarting/真实 spawn/reap、生成清理 fence、固定 debug-only stage/exitCode/优雅日志；Capacitor payload loggingBehavior none。

### 路径、凭据与语音

Host 运行数据在独立 `files/bot-host`（含 `bot-host/workspaces`）；模型凭据在 `bot_host_credentials` SharedPreferences（仅存别名映射，无 getter 不返回值），语音偏好/秘密在 `bot_host_voice`/`bot_host_voice_secrets`；凭据不在 files/bot-host 内。旧路径与签名保留；不读取/清除真实用户数据。

### 构建与前提

当前 Android Host 随 APK 构建。先按平台文档安装构建依赖、npm 包和 Node Mobile，再运行 Gradle wrapper。`prepareHostTools` 与 `buildHostRuntime` 挂在 `preBuild` 上。 [Android 完整构建命令](../mobile/README.md#构建与先决条件)

Android 搜索工具（rg/fd）固定 API 29，不改变 App minSdk33。NDK/16KiB rg15.1.0 fd10.3.0（x86_64、arm64-v8a）固定 crate SHA 与锁定 Cargo 隔离环境；真实 untrusted_app 7/7 文件工具通过（含 grep/find）；私有祖先 Cargo 配置被拒，迁移 pins 后 4/4 缓存复验；许可见 THIRD_PARTY_NOTICES.md。

Node Mobile 24.18.0 内嵌 icu_small（ICU 78.3）缺分词数据，Intl.Segmenter 会段错误；`build-android.js` 下载官方 `icudt78l.dat`（固定 URL/SHA-256，ZIP 缓存在 `app/build/host-icu/`、命中仍复验哈希）作为 payload 兄弟文件装入运行时版本目录，`BotHostProcess` 以 `NODE_ICU_DATA` 指向该目录，官方 LICENSE 并入 `third-party-licenses.txt`。升级 Node 版本时须同步匹配 ICU 主版本与 dat 文件名。

### 设置、凭据与桥

设置与凭据写入仅下次显式重启生效：`settingsSet({input:{expectedRevision,settings}})`，在线保存标记 restartRequired（ready 绑定成功后清除）；saveCredentials 只写整个 aliases 映射替换（validateCredentials 无增量更新）。请求并发满/过渡期拒绝为 BUSY/not-sent。

专用 Capacitor `BotHostPlugin`（name="BotHost"）方法组：

| 方法 | 输入/语义 |
| --- | --- |
| `snapshot` | 返回状态快照 |
| `status` | 状态（phase/deviceId/restartRequired/errorCode 等） |
| `start` / `stop` | 显式启动/停止 Host |
| `settingsGet` | 读取设置 |
| `settingsSet` | `{input:{expectedRevision,settings}}`，仅重启生效 |
| `saveCredentials` | `{aliases}`，整表替换 |
| `call` | `{method,params}`，返回 `{type:'result',id,result}` 信封（result 可为数组） |
| `observe` | `{observationId,target}`，观察订阅 |
| `cancelObservation` | `{observationId}`，仅结束观察订阅 |
| `voiceSettings` | 读取语音设置 |
| `saveVoiceSettings` | `{settings}`，保存语音设置 |
| `startVoice` | `{botId,requestId}`，仅前台显式启动，需麦克风权限 |
| `finishVoice` | 无参数，结束当前输入捕获 |
| `cancelVoice` | 无参数，拒绝 pending 语音并取消当前捕获 |

`call({method,params})` 经 `BotHostProcess.request("call",{method,params})` 发送，返回完整 `{type:'result',id,result}` 信封（result 可为数组，不做二次包装）；Node 侧由 `normalizeControlCall` 校验。hostFrame/voiceEvent 事件带身份字段（hostFrame: observationId+frame/error；voiceEvent: type/botId/requestId/text/receipt/code/outcome/message）。

### 语义边界

观察取消（cancelObservation/close）仅结束观察订阅，不取消进程/录音/Agent；语音仅前台显式启动（foregroundUi + 麦克风权限），最终转录仅原生提交一次，文字草稿独立保留；unconfirmed create/submit 仅只读对账，不自动重发。

### 验证

#### 主运行

真实 App BC 压缩 1 块/1791 tokens、原 65 条前缀保留、文档隐藏期间 placed→done；文件工具（grep/find 等）7/7 通过；ARM64 仅构建；ASR 为合成。服务通知专项实测：失败/offline 读保留 3151，显式 Stop 或恢复 running 清 3151，正常 Stop 清 3150 且无 child。父验收：5/5 SQLite integrity+FK、109 任务 terminal（63 generation/46 tool）、17 submission done。

#### 旧功能回归

8 组旧回归（chat-persistence 仅组件持久化、voice-continuity/widget/share-ui/notifications/search-consistency/questionnaire/shower-preview）在服务小修前通过，不标成新 APK 全量重跑；notifications 曾两次立即删除查询断言失败、原源码未改、原 AVD 重启后 PASS（不能说某补丁修复）；Shower 恢复 shell UID 2000 Shizuku 后 PASS（124 帧/触摸 Settings/Unicode/全屏返回/预览截图）。

#### 哨兵说明

附件未引用哨兵在旧回归后缺失；AttachmentStore 既有 GC 会删未引用文件，父用不同文件名新建未引用探针、经 Chat.newConversation/deleteConversation 实际验证删除（Host 一直 stopped），原缺失 marker 未重造。覆盖安装专测当时 4/4 仍有效，不能声称最新 4/4 或全部真实旧数据检查。

### 证据边界

仅模拟器（emulator-5556/m15_api36）无真机；合成 providers/ASR；`speak` accepted 不代表播放完成；ARM64 仅构建（zipalign 16KiB）未运行；无 ARM64/Linux 运行时。未构造无法回收子进程的 CLEANUP_FAILED 场景，也未穷举跨代、持续背压和交互信号的全部交错；真实 ASR 准确率/Hindsight 生产验证未做；Tauri/TUI 当时尚未开始（桌面外壳后续见末节 M17，Tauri Android 属 M18；TUI 后经用户决定移出本期）。最终夹具清理已完成（临时 CA 在 zygote/App 命名空间均不存在且源目录/主机私钥已删除，22 tails 清理，CDP exit 0，相关端口无 socket/无 forward reverse，独立 AVD 已关闭保 userdata）。

## 模块 16：旧数据迁移与 Android 兼容（已完成父助手限定范围验收）

**状态**：模块 16 已完成交付并获父助手限定范围验收，总完成数 **16/20**；M17/M18 后续已交付（见末节），M19 已移出本期、M20 进行中（见末节模块 20-01）。

### 旧聊天迁移（用户显式）

用户先在迁移面板选择旧会话，并分别设定新的 role/cwd/modelRef 做预览；预览会生成快照与请求 ID。确认导入后该定义被锁定，此后输入变更需要重新预览，不能靠改参数继续旧请求。状态查询只读、不恢复写操作；prepared 只有用户显式继续原冻结请求才恢复，completed 则回到同一已导入 Bot；不明结果不自动重发。

原字节/分支/SDK/附件/草稿永久归档，与选中历史被动投影分开；旧工具不执行，不继承旧凭据/banks/cwd。草稿完整分页后仅向当前匹配 Bot 输入框手动追加文本与永久附件路径，不覆盖、不自动发送。只读 SAX 偏好解析、backup 权威、坏 backup 不回退、不读写 .new、不用 SharedPreferences/ChatStore 做 export；旧 ScheduledTasks 仅延迟 Coordinator/listener 到 snapshot/实际发送。

### 新 Host schedule_task

新 Host 定时任务仅限 Android 原生桥且主私聊，归属持久可信，不接受模型自报身份；unsafe 不自动重放。每定义修订 CAS；每个发生时刻先持久记录提交标记与请求 ID，之后最多提交一次，后续只读查询；删除定义仍保留已尝试运行的对账。Host 仅显式启动时运行，离线错过不补发，新接收器不因广播自动拉起 Host；独立存储与签名日历资产，公开 v2 方法仍 35，迁移私有本地接口不进 HTTP/relay。

### 验收范围（父合成 Windows 私有桥 + emulator-5556/m15_api36）

- 迁移：Windows 私有 JSONL + 真实 Durable 两次导入/两 Bot/四条目、零任务零提交；原 ID 幂等与 prepared 恢复；Android 四次完成导入，含原始结构/SDK/实际旧 SDK 输出；completed 导入在旧源或 staging 移走后仍可读取；哈希与无效 XML/UTF8/SDK 分支检查边界通过；旧工具仅引用被动。
- 冷启动：真实冷启动下 chat.xml/.bak/.new 字节与哈希均保留；旧 BOOT receiver 延迟 ScheduledTasks Coordinator 修复；合成 HTTPS 下真实冷旧任务执行且定义删除；新离线时钟 receiver 不启动 Host/FGS/提交。
- UI：真实 React 终页 8191+5 UTF16/空页，追加不覆盖不发送，匹配 Bot，双击单次，丢回执冻结对账，畸形游标拒绝，迟到页忽略。
- 日程：真实定时执行；同 owner revision CAS/分页/跨 owner 与伪造身份拒绝；运行中自删保留 run；写触发器故障不发送且重开跳过离线；deleteAfterRun；权限拒绝定义保留带 schedulingError（非失败创建）；100 条预置定义/2400462-byte JSON 列表与第 101 条拒绝；坏头/版本/额外行拒绝且不重置坏存储。
- 范围守卫：room 用户消息触发 A schedule_task 拒绝；B primary send_dm 触发 A DM schedule_task 拒绝；调度状态字节前后一致；room A 停止而 DM A 仍触发、B DM 停止而 B primary 仍成功；公开控制拒绝 legacyImport/schedule_task。
- 回归：chat-persistence/share-intake/share-ui/voice-continuity/search-consistency/migration/widget/questionnaire/shower-preview/notifications/shower-lockscreen 旧组通过；此前四次立即删除通知断言失败保留（撤掉临时 Node CA 启动包装后，附加调试器运行和不附加调试器的普通运行均通过；独立完成任务删除在父派发后 325ms 观察到消失，非仅 cancel 时间；原始精确原因仍未确认，未改产品/测试规避）。
- 锁屏：真实非零屏 3 锁定闲置 30 秒仍可见；滑动改变 12% 采样设置内容；主屏保持锁定/关闭；释放移除屏。
- 最终数据：8 份 SQLite 完整性/FK 通过（含 2 诊断库）；180 个 Native tasks 全部 terminal、41 次提交全部 done；4 次 Android 导入完成；4 条定义禁用，6 条 run：4 done、2 skipped_offline。
- 产物：Stage11 x86_64 APK 实际运行于 API36 模拟器 m15_api36；ARM64 APK 仅构建；apksigner 与 16KiB ZIP 对齐通过。
- 注意：skipped_offline 记录的 submitted:true 是终态封闭标志，不代表实际 RPC 已尝试。

### 限制与未实测边界

无真机验收（按用户指令）；合成 provider/ASR，无付费/生产服务。不宣称全部 instrumentation 组、真实手指/桌面 Widget 视觉或进程死亡验收、ARM64 运行、32 active run 饱和或 100 次实际 create。公开 35 v2 方法不变，迁移保持私有本地桥；本模块验收时 Android 仍是 Capacitor/原生 Durable Host，Tauri Android 界面由 M18 交付（见末节）。完整第三方声明检查仍缺可选 MCP SDK，无依赖变通。

### 清理

父已通过保留 userdata 的模拟器重启移除测试 CA 挂载/文件，恢复旧设置与 provider，清空新 Host providers/default/凭据，停止合成服务与 tail，恢复麦克风权限与精确闹钟 appop，并撤销测试专用 WRITE_SECURE_SETTINGS 授权；首次权限回退经重新应用与平台命令处理后二次重启确认保留。

## 模块 17：Tauri Windows / Linux 客户端（已完成父助手限定范围验收）

**状态**：模块 17 已完成交付并获父助手限定范围验收，总完成数 **17/20**；M18 后续已交付（见末节）。当前 M19 已移出本期（编号保留）、M20 进行中（见末节模块 20-01），此前各节“M19–M20 待交付”为当时记录。本模块只增加桌面客户端侧文件，不新增 Host 方法（仍为固定 35 个 v2 方法）、不改 Android。

### 客户端组成

- `desktop-client.js`：纯客户端 Node broker，复用 `local-control-adapter`、`remote-control-client`、`pending-client` 与 `desktop-ui-store`；不打开 Host 数据库、不启动 Runtime、不运行模型。
- `desktop-client-cli.js`：broker 的 stdio 入口，由 `build-desktop.js` 以 esbuild（`platform=node`、`format=esm`、`target=node22`）打成 `desktop/build/desktop-client.mjs`，与官方 Node 22.19.0 sidecar 一起打包，cwd 为客户端数据根。
- `desktop-ui-store.js`：`desktop-ui.sqlite`（schema v1）持久 clientId、连接档案、草稿与冻结意图；不存 token/CA，损坏或更高版本拒绝打开且不自动重置。
- 待发送账本按连接 key 隔离（`pending/<profileKey>/client-pending.sqlite` 加 `pending-owner.sqlite` 独占锁，`profileKey = sha256(JSON.stringify([kind, url, relay 客户端 deviceId]))`，不是 UI profileId：同一 endpoint 的不同显示名称档案共用一份账本），沿用模块 14 的 `openPendingClient` 语义（无自动 flush/重连重放）。
- `build-desktop.js`（prepare、`--web`、`--dev`）与 `desktop-tauri.js`（固定 argv、`cwd=desktop`、`shell=false`）是唯一构建入口，根 `package.json` 的 `desktop:prepare`/`desktop:dev`/`desktop:build` 调它们。

### 边界

- 传输仍为只读/控制回环 HTTP 或认证中继，本机 `settings_get`/`settings_set`（CAS）与 `service_status` 复用既有方法；Rust 侧只有 `desktop_request`、`desktop_observe`、`desktop_unobserve`、`desktop_pick_file` 四个命令，观察流控 `observe_ack` 仅在 Rust 本地处理。
- 不持有 Host 生命周期：只有用户显式 `abort`（主私聊）或 `stopWork`（群/DM）才向目标 Host 发停止请求；关闭窗口不停止 Host 任务。
- 文件选择只产生 `{name, path, size}` 本地路径引用，不存在跨设备上传协议。
- 公开方法表、Host/消息 schema 与 Android 路径本模块均未修改；完整用法、数据路径与安装包输出见 [desktop/README.md](../desktop/README.md)。

### 验收范围

父在本机实际运行：Windows/Linux debug 与 no-bundle 构建、Windows Release（MSI + NSIS）与 Linux Release（DEB + RPM + AppImage，未削减 targets）；Windows NSIS 静默安装到私有测试目录后运行并完成合成 Host 任务，MSI 仅以 WiX `dark` 解包核实（Product Codepage 936、Language 2052）未安装；Linux 实际安装 DEB 并运行，卸载后以 `AppImage --appimage-extract-and-run` 运行且 clientId/配置保留、冷态不自动连接。另实测 Node 客户端冷启动/重开、Unicode 与含空格 cwd、900x600 聊天与群聊布局、展开原始历史后发送区仍可见、真实丢失 enqueue 回执保留原 ID（先冻结完整输入、目标与业务 ID 再入队）、离线/取消/重连不重放、设置 CAS 冲突与双丢失回执保持锁定到显式采用完整基线、草稿两种冲突码、房间发布/回复与成员 CAS、选中成员的 `getWorkActivity` 1 秒只读刷新收敛（work `LIVE` 观察流与原始历史另计）、原生文件选择返回本地路径引用；Windows 实测关闭窗口与 Node 子进程退出后 busy Host 任务继续完成，Linux 分别验证普通窗口与 AppImage 原生关闭后客户端子进程回收且 Host 仍存活（未在 Linux 复现 busy 任务连续性）；9 份客户端 SQLite 完整性/FK 检查通过，安装版数据目录未检出精确合成 token（profile 名称阳性对照命中），输入框 token 清空，localStorage/sessionStorage 均 0 条。

### 限制与未实测边界

所有模型响应为 Mockoon 合成 SSE，无付费模型或真实用户配置；本模块未验证 Hindsight 服务，也未做中继 GUI 联调；GUI 运行验证主要为各自机器的本机 Host，跨设备 Relay/CA、目标切换与全链路压力/交错验收归 M20；未测 FUSE 挂载、MSI 安装/卸载与 RPM 安装；Tauri Android 已由 M18 交付（见末节），M19（TUI）已按用户决定移出本期、不交付（原规格留作历史/后续计划，未验收代码只在 git stash `02f1396f`，仅未来草稿，禁止取回或删除）。本模块不扩大内存/加密作者身份/上传能力声明。

## 模块 18：Tauri Android 界面（已完成父助手限定范围验收）

**状态**：模块 18 已完成交付并获父助手限定范围验收，总完成数 **18/20**；M19 已移出本期（未验收 TUI 代码只在 git stash `02f1396f`，仅未来草稿、禁止取回或删除，不在交付树、不计完成），M20 进行中（见末节模块 20-01）。本节只记录 Host 侧约束；界面组成、命令与构建/操作说明见 [mobile/README.md](../mobile/README.md)。

### 与 Host 的关系

- **Host 没搬家**：默认 Java 进程里仍是用户显式启动的 specialUse FGS，Host 本体在它拉起的受监督 Node Mobile 子进程里运行；`files/bot-host`、`bot_host_credentials`、`bot_host_voice(_secrets)` 路径与语义不变；公开 v2 方法仍 **35 个**，不新增 HTTP/中继线路。
- **界面在独立进程**：`:tauri_ui`（Tauri 2.12.5 / wry 0.57 的 Android 退出路径会 `std::process::exit`，同进程会杀死 Host）。UI 经私有、非导出、同 UID 校验的 Binder 服务打开 socket FD，业务走 JSONL；可调操作限定为既有 Host 数据操作加 `uiSettings`/`pause`，`start`/`stop`/`openLegacy`/`reconnect`/`hide` 是 UI 本地动作，不是 Host 方法。
- **有界协议**：40 MiB 行/请求、8 个在途普通请求、8 帧/80 MiB 事件预算、保留 pause/清理通道、25 s 请求与 5 s 绑定截止、按 generation 的投递身份、单一原生事件代理与最多一个等待 ACK 的事件帧。
- **生命周期**：关闭界面/观察/EOF 只释放该会话的观察与语音捕获，不调用 manager 的 stop/suspend；Host 只在用户显式停止 FGS 或显式操作时结束，不自动重启、不重放已受理请求。
- **语音**：沿用原冻结 botId/requestId 一次提交与事件形状；新增按 botId/requestId 限定作用域的 finish/cancel 重载，迟到回调不会取消他人捕获。

### 构建接线

- `host-core/build-mobile.js --sdk-path` 使用 Cargo 依赖图生成 SDK include。本地 Gradle 与 CI 都在片段缺失时运行该命令。正常构建按所选 ABI 用 NDK 交叉编译并检查 16 KiB ELF 对齐，同时生成 Kotlin、Web 资源与完整的 Rust 依赖许可。 [Android 构建接线](../mobile/README.md#构建与先决条件)
- **依赖法务资源**：`app/build.gradle` 的 `android.packaging.resources` 仅从 AGP 默认排除集中移除 8 个路径（`/META-INF/LICENSE`、`/META-INF/LICENSE.txt`、`/META-INF/NOTICE`、`/META-INF/NOTICE.txt`、`/LICENSE`、`/LICENSE.txt`、`/NOTICE`、`/NOTICE.txt`），并用标准 `merges` 合并同名文件；签名/MANIFEST 等默认排除与 `jniLibs.useLegacyPackaging` 不变，不用 `pickFirst`、不手拼替代文本。已限定验收：删掉生成片段后双 ABI `assembleDebug`+`assembleDebugAndroidTest` exit 0、片段自动重建且字节一致；新 APK 相对上一验收包仅多 `META-INF/LICENSE`、`META-INF/LICENSE.txt`、`META-INF/NOTICE` 三个条目，全部原条目（DEX/.so/assets/res）按相同 ZIP 顺序单次解压 SHA256 完全一致；4 个 Jackson 2.15.3 依赖的 `META-INF/LICENSE`/`NOTICE` 共 8 项均含于合并文本；zipalign `-P16` 与原签名通过。APK 工作流已加 Rust stable + 双 target 准备，但**远端 GitHub Actions 仍未实际运行**。
- `CARGO_LICENSE_FALLBACKS`（`build-desktop.js`，Android 同样复用）只对精确 `package@version` + 声明串生效：Android 图会命中既有的 `alloc-stdlib@0.3.0`、`selectors@0.38.0` 等桌面期映射，以及 M18 新增的 `jni-sys-macros@0.4.1`、`ndk-context@0.1.1`、`ndk@0.9.0`、`ndk-sys@0.6.0+11769913`（均 MIT OR Apache-2.0，文本见 `licenses/android/` 或 `licenses/desktop/`）。只有确实缺失且无精确映射的 license 才硬失败。

### 验收范围（父限定）

- 环境：保留 userdata 的 `emulator-5556`（Android 36 / x86_64），`-no-audio` 静音 + 自有可信 HTTPS 合成 ASR；完整 `assembleDebug`+`assembleDebugAndroidTest`（无排除）通过，原证书覆盖安装，安装前后 Host DB 哈希一致。
- 实测：冷启动只起 `:tauri_ui` 与默认进程，不拉起 Host/Node；界面内创建/聊天/回执到 done（含 Unicode/emoji 与语音合成提交）；关闭或 SIGKILL 界面后已受理任务由同一 Host/Node 继续，冻结原 ID 可对账且无重放（模型计数仅 +1）；8 RPC 与第 9 个 `RPC_BUSY`、25 s `TIMEOUT`、超 2 MiB 与未知方法/非法 legacy 动作拒绝；8 观察与最多一个等待 ACK 的事件帧、溢出锁存与显式重连；空闲 EOF 只发一条私有 `streamError`；权限与 ASR 取消不串归属；8 份 DB 完整性/FK 通过（186 任务终态、47 submissions done，M16 为 180/41）。
- 未实测：ARM64 运行时、真实模型/ASR/Hindsight、跨设备中继与目标切换（M20）、全部传输饱和/竞态与 5 s 绑定故障定时器。法务资源修改后未重跑设备 E2E：上列验收适用于字节一致的原有 APK 条目（Stage 12 逐条 SHA256 比对），新增的只有 `META-INF/LICENSE|NOTICE` 等法务条目与构建/CI 接线；远端 GitHub Actions 仍未实际运行。
- 旧回归中 `notifications` 组仍在“立即删除是否清空通知”断言处失败 3 次（M16 起既有问题，产品/测试未改；调试器暂停下通过但不属普通通过，原因未确认），其余 10 组普通通过。

## 模块 20-01：手机远端客户端（M20 进行中，本期当前 18/19）

**状态**：M20 未整体完成，本节只记录已交付的 M20-01（手机远端入口 + 限定范围跨设备联调）。M19 已按用户决定移出本期（编号保留），未验收 TUI 代码只在 git stash `02f1396f`（仅未来草稿，禁止取回或删除），不在交付内，也不作为 M20 完成条件；跨端创建续聊已按手机创建 → Windows 桌面 GUI 有限验证，Linux GUI 全矩阵、完整故障/BC 与真实设备等项仍待。

### 进程与协议

- `android-runtime.js` 新增 `mode === 'client'`：只 `openDesktopClient({dataRoot})`（ui store + pending 账本 + 固定传输），ready id 用 broker 的 `clientId`；**从不**打开 Host/Runtime、不读模型凭据、不发 native 工具调用。与 Host 共用 `BotHostProcess`（Node Mobile）单例生命周期，但由 `BotHostClient` 以独立 `files/bot-client` 懒启动，与 `files/bot-host` 隔离。
- 桥的私有入口只新增 `clientRequest`/`clientObserve`/`clientUnobserve` 与观察事件 `clientFrame`（`data` 即 `DesktopObservationEvent`）；**没有** `clientClose`，公开仍是 4 个 Tauri 命令与 Host 方法表（M20-01 交付时 35 个，含后续 SOUL 增量现为 37 个）。`clientUnobserve` 与 `pause` 为保留清理操作，不受普通 8 个在途上限约束；普通 RPC 仍 8 个、观察仍 8 路。
- broker 侧 `unobserve` 是纯本地取消：不排到 8 个普通 RPC 或 connect/disconnect 切换后面，否则取消的观察会泄漏槽位；它同步返回、不会堆积。普通请求/观察的 8/8/25 s 上限与行为不变。
- 生命周期：默认进程内单例管理器（冷态只构造）；一个 `clientRoot` 同时只允许一个 UI 会话持有，其余按 BUSY 拒绝；UI 关闭/EOF 只释放本会话观察与该 client child，不 stop/abort 远端 Agent，不自动重连、不重放变更。批量取消用 owned 8 槽与串行幂等清理。
- 凭据：连接 token 与 relay CA 只在会话内存，不进 `desktop-ui.sqlite`/pending/localStorage，也不写日志。

### 验收（父限定，合成模型不付费）

- 环境：Windows x64 Node 26.12.1、Linux x64（Ubuntu 26.04.1）Node 22.19.0、`emulator-5556`（Android 36/x86_64）；隔离真实 TLS relay 在 Linux，Windows 与 Linux Host 上线。
- 实测：手机 UI 经 CA 认证 relay 创建 Linux Bot（host cwd 校验，首次 `INVALID_CWD` 按明确失败修目录后显式重建）、Unicode/emoji/多行提交写入真实 Durable/BC 原始 history 并收到合成 SSE 回复；UI 进程 SIGKILL 后 clientNode 退出、Linux 已受理任务仍完成；Windows 真实 debug GUI 经同 relay 续聊手机创建的原 Bot 并收到回复；CLI 建立 Windows/Linux 共用 room 与 DM，元数据传播与 room 持久 ACK 通过（不宣称完整自然群聊智能行为或 DM 对话已测）；实际 8 路 primary LIVE 各取 snapshot、8 句柄并发 close 后又开 8 路再关闭通过（真实手机 API，不是纯 mock）。
- 构建：`npm run mobile:web`、`npm run build`、`node host-core/build-desktop.js --web`、Windows `desktop:build -- --debug --no-bundle`、最终双 ABI `assembleDebug`+`assembleDebugAndroidTest`（40 s）、apksigner 与 `zipalign -P16` 通过；无新增测试。一次桌面重建因自有测试 exe 占用文件失败，关闭后成功，不是代码失败。
- 未完成/不宣称：ARM64 旧版本覆盖迁移与 16 KiB 页设备运行时（K80 真机限定运行见下条）、真实 Hindsight/ASR/付费模型、Linux GUI 全矩阵、完整故障/BC 恢复与 DM 智能、全格式安装升级卸载、远端 GitHub Actions（本轮不 push、不启动 CI）；原 Host 及 schedule 6 库 + 新 client 3 库完整性/FK 通过、主 DB 文件与覆盖前一致（WAL/SHM 暂态文件不同），client 目录合成 token 零匹配（profile 名称阳性对照命中）。最终 APK sha256 `2b50fccfaef5b1da5f8f47777fe4aea30b91f90d57af9a123e78443be52bba39` 已原签名覆盖安装；同目标断开后重连并显式选回原设备面板自动收起、离线草稿只入 pending 且目标 `getSubmission` 返回 `SUBMISSION_NOT_FOUND` 不重放、用户式本地取消到 `CANCELLED`/`not-sent` 均实际通过。
- 真机限定运行（REDMI K80 / 型号 24117RK2CC，Android 16、arm64-v8a、页 4096；旁置 K90 未操作）：同 APK（sha256 `2b50fccfaef5b1da5f8f47777fe4aea30b91f90d57af9a123e78443be52bba39`）先首次安装（安装前设备无该包，故**不是**旧版本真实用户数据迁移验收），再覆盖重装 `-r`（原签名保留）；冷启动无 Host Node/FGS，显式启动后真实 ARM64 Node 以 specialUse FGS（3150）运行；本机 Bot 中文/emoji/多行写入真实 Durable/BC 原始历史并取回合成 SSE 回复；UI 进程被 kill 后默认进程与该 Host Node 同 PID 保持，重开读取持久回复（关闭前受理回执未捕获，故不写精确 busy 接纳时序）；打开“其他设备”后 Host/client 两个 ARM64 Node 并存，client 使用独立数据目录 `files/bot-client`；经真实 CA TLS relay 连接 Linux Host，提交唯一 K80 marker 多行消息并在 Linux 原始历史读到输入与回复；8 路 LIVE 各自 snapshot，批量 close 后再开 8 路各 snapshot 再关闭通过；设置页显式重连后 client Node 退出、本机 Host 同 PID 继续且 UI 稳定无循环；清空合成配置/alias 并显式停 Host 后同 APK 覆盖重装，Host state + client store + shared_prefs 捕获文件字节一致、7 份 SQLite integrity/FK 通过，重开冷态无 Node；检查期间无崩溃 buffer 条目。页为 4 KiB，不宣称 16 KiB 设备运行实测；手机 UI × Windows Host 仍未测（本轮是手机 UI → Linux Host + K80 本机 Host），也未跑 `notifications` 组。
- 首轮模拟器/桌面收尾（已完成）：最终窗口、client Node、自有 Windows/Linux Host、relay、Mockoon、SSH 转发、3 个自有终端与模拟器均已停止；userdata 与 fixture 记录保留，自有 adb 19220 forward 已删；该阶段未操作物理设备；不外推其他 M20。
- 收尾（K80 本轮）：App 与该测试会话保留在 K80 供查看；本机 Host 已显式停止，`runtime.providers=[]`、`defaultModel=null`、`relay=null`（revision 3）、`credential_aliases={}`；测试前 `POST_NOTIFICATIONS=false`，临时授权后已恢复 false；adb forward 19230 / reverse 18929 已删；自有 Linux Host/relay/Mockoon/SSH 转发/CDP 终端已停；未改电池/自启/无障碍/HOME；未涉及付费模型/真实 ASR/Hindsight。证据目录 basename `e-launcher-k80-1792825796727`（`k80-verification.json`）。

## Bot 级扩展与 SOUL.md（Host 契约增量）

本节记录每 Bot SOUL.md 的技术契约与旧 Host 扩展设置的读取形状。Bot 级扩展/能力管理已全部移至中心接口；旧本机扩展目录与每 Bot 扩展 HTTP/远端方法已移除，没有第二套扩展运行时、插件市场或任意 npm 安装。

### Host 配置：runtime.extensions（兼容 legacy runtime.hindsight）

```json
{
  "extensions": {
    "hindsight": {
      "enabled": true,
      "defaultEnabled": true,
      "config": { "baseUrl": "http://127.0.0.1:8888", "apiKeyEnv": "HINDSIGHT_API_KEY" }
    }
  }
}
```

- 规范位置是 `runtime.extensions.hindsight = {enabled, defaultEnabled?, config?}`；`config` 必填且合法仅当 `enabled:true`，禁用时可保留。`defaultEnabled` 缺省跟随 `enabled`，只在该 Bot **首次初始化时复制一次**；之后改 Host 默认值不影响已初始化的 Bot。
- legacy `runtime.hindsight`（模块 13 形状）继续接受，等价于 `enabled:true`/`defaultEnabled:true` + 原 config；存储与设置 CAS 不回写、不重写旧形状。两者同时出现属边界歧义，直接 `INVALID_ARGUMENT`。
- `normalizeRuntimeConfig`/`parseRuntimeConfig` 返回现有字段再加生效的 `extensions`；`hindsight` 只包含生效启用的 config，凭证只在生效启用时解析。`host-service` 把两者同时前传给控制服务与 Runtime。设置与目录回执不含任何 secret 值。
- 未配置扩展时目录仍列出 Hindsight（`available:false`、`reason:'not-configured'`、`defaultEnabled:false`），新 Bot 默认关闭。

### 每 Bot 策略与生效语义

- 每 Bot 扩展策略由中心权威快照决定；Host 内只保留 `bot_extension_settings` 历史行（含 `retentionFloor`）供插件读取旧写入下限，不再接受本机写入。
- 原生扩展定义即使禁用也注册在 Durable registry（历史/恢复可用）；策略只控制会话内可见/可调用与后台执行，不是只隐藏 schema。
- 关闭/只读期间冻结的 native entry id 写入下限（`retentionFloor`）按持久行读取；已冻结的 job/run 不删除、ID 不改。

### SOUL.md

- 每 Bot 一份真实 UTF-8 文件 `dataRoot/bots/<botId>/SOUL.md`，**绝不**写入共享 cwd；`path` 是相对路径 `bots/<id>/SOUL.md`（仅展示/核对，不用于读取），`revision` 是文件字节的 SHA-256 hex。
- 首次创建与遗留 Bot 用已持久化 role 补建一次；已有内容永不被 bootstrap 覆盖。空 SOUL 合法且有意为空。公开编辑上限 64 KiB，文本须为 well-formed UTF-16/UTF-8。
- CAS 写入：`expectedRevision` 必须是 64 位小写 SHA-256 hex，与当前文件一致才写，否则 `REQUEST_CONFLICT` 且不覆盖；发布走同目录临时文件 + rename 原子替换。同进程内无交错窗口，多进程同时写同一 Bot 仍可能后写覆盖（跨进程互斥未做，属已知限制）。
- 人格：主会话 `instructions` = SOUL（空则清空，不回退 role）；工作会话 = SOUL + 既有来源归属说明 + 工作决策政策（不追加 role、不重复人格）。role 只保留为列表/创建元数据。

### 方法、HTTP 与 CLI

| Runtime / 控制方法 | HTTP | CLI |
| --- | --- | --- |
| `getBotSoul(botId)` | GET `/v1/bots/:botId/soul` | `bot-soul --bot-id` |
| `setBotSoul(botId, input)` | PUT `/v1/bots/:botId/soul` | `bot-soul-set --bot-id --input` |

- 本增量只有上述 2 个方法，`CONTROL_METHODS` 现共 **37**（旧 10 + v2 27）。通用桌面/移动 broker 的 `call` 直接携带这两个方法，没有新增 Tauri 命令或 broker 操作。
- `POST /v1/bots` 在 `host.createBot` 后调用 `runtime.initializeBot(bot.botId)`，去重重试也重复幂等初始化；Runtime 启动时初始化既有 Bot，遗留 Bot 在首次运行使用前初始化。
- setter 是 CAS 请求，不做静默重连或重放；结果未知一律视为未确认，由 UI 显式重读对账。

### SDK 与许可证

- 固定 `@vectorize-io/hindsight-client@0.9.2`（host-core 依赖，lockfile 由父助手生成）：npm 发布包 gitHead `ebad478240d3171bb88201ececda5e8d9883d22d`，仓库根 LICENSE 为 MIT，Copyright (c) 2025 Vectorize AI, Inc.；逐字副本保留在 [`licenses/hindsight-client-0.9.2-MIT.txt`](../licenses/hindsight-client-0.9.2-MIT.txt)。
- 适配器只用包公开导出 `createClient`/`createConfig`/`sdk`，不使用上游 `.pi` 源或内部路径，也不打全局 fetch 补丁；每实例自有 fetch 恢复 `redirect:error`、2 MiB 请求/响应上限与 AbortController，无自动重试或变更重放。
- 新增可选 `timeoutMs`（默认 30000）与 `reflectTimeoutMs`（默认 120000），须为 ≤120000 的正安全整数（未知字段拒绝）；`HINDSIGHT_MAX_TIMEOUT_MS=120000` 供传输层对齐。未显式给出时不写进已存配置（保持 seed/CAS 兼容）。

### 超时链（八个 memory 方法与手动 compact）

Hindsight 后端 120s ≤ 本机控制 HTTP 空闲 130s ≤ 中继/目标执行 135s ≤ 远端/本机客户端 140s ≤ 桌面 broker 145s ≤ 原生外层 150s，每层严格包含内层。手动压缩 `/compact` 复用同一组期限（摘要请求可能超过默认 20s/25s），其 HTTP 路由也使用 130s 空闲窗口。其他 RPC 与并发/准入/请求体/头/写超时不变（仍 20s/25s，在途 8/8、128 槽位）。调用方统一经 `controlMethodTimeoutMs`/`controlClientTimeoutMs`/`controlBrokerTimeoutMs` 取值，不使用过期常量。

## 每轮集中插件同步（turn admission，契约说明）

> **状态**：本节描述本轮多 lane 并行实现的每轮准入契约，由父助手统一集成与端到端验收；在父助手验收完成前，以下行为均视为设计契约而非已验证事实。中心侧接口形状另见 [center-server/README.md](../center-server/README.md) 的「每轮准入」一节。

### 轮边界与准入语义

- **每一条外部用户消息开始一个新的准入轮**：新对话的首条消息、既有主私聊的下一条用户消息、群/DM 工作上下文的新决策、定时任务投递到主私聊的消息都走同一条准入路径。不是只在进程启动或新对话创建时检查一次。
- **同一轮内部不算新输入**：模型↔工具↔模型的续轮、问卷（questionnaire）的回答/取消、已受理工作决策的续行，都复用本轮已取得的准入，不重新查询中心、不在轮中切换代码版本。轮内不允许换版本。
- **后续消息排队而非直送**：一条消息处于准入等待/同步时，后续用户输入先持久保存在 Host 侧队列，按会话一次只放行一条；准入失败/离线时消息保留为等待或失败状态，显式重试沿用同一 requestId 与原文，不自动重发、不静默回退到本地旧版本。

### 中心权威与准备/确认/恢复

- 中心对每个 Bot 的目标插件集合（成员、精确版本、不可变 artifact digest、启用/禁用/移除、生效配置修订与凭据修订）有最终权威。每一轮准入都向中心查询，即使本地已缓存全部 artifact；比较的是**该 Bot 的可执行集合身份**（setId），不是全设备修订号——无关 Bot 的修订变化不触发本 Bot 重新准备。
- 准入分两个在线步骤：**prepare** 返回目标集合身份与所需精确安装计划（Host 端据此完成本地安装但不激活、不切换运行中 Bot）；**confirm** 在中心把当前权威集合与本请求集合在事务中比对后才签发准入许可（admissionId/setId）。准备期间中心集合变化时有限次重准备后进入等待/退避，不在一轮内热循环。
- **没有准入确认前不执行模型或工具**。Host 端 `runtime.submit` 先本地持久化再返回 queued 回执（尚无原生 submissionId）；该回执表示已受理排队，不代表完成或已运行。
- **冷启动恢复**：进程重启后，在恢复调度前先按持久化的准入记录调用 **restore**，重新取得原集合的快照/配置/模型选择与当前仍然有效的凭据授权，再激活精确的旧版本绑定。显式撤销或凭据修订变化会导致恢复失败，不会复活旧授权；普通版本/配置更新则允许旧准入轮在原代码上收尾。
- **旧版本保留**：安装按版本不可变目录共存，被准入记录引用的版本与其数据不删除；回滚/恢复是选择更旧的代码，不清空数据库。缓存中的 artifact 可用于 prepare，但“已缓存”不等于“该 Bot 当前运行该版本”。

### 撤销与错误边界

- 显式禁用/移除与凭据修订变化**立即撤销**：新轮被拒，运行中的授权检查也不再放行；而普通版本升级或常规配置变更**不**打断进行中的问卷/任务，已授权轮可在旧代码上完成。
- 主要错误码：`TURN_SET_CHANGED`（准备/确认之间集合已变）、`TURN_SYNC_FAILED`（目标集合无法就绪）、`TURN_RECOVERY_REQUIRED`（恢复所需身份无法安全确定），并沿用既有 `CENTER_OFFLINE`/`RUNTIME_BUSY`。
- **遗留未固定（unpinned）活动的恢复阻塞**：早于准入元数据存在的活动原生提交不会被静默标记为已准入或以新代码续行；原身份无法安全建立时保持暂停并暴露 `TURN_RECOVERY_REQUIRED`，需显式处理（迁移/恢复路径由操作者决定）。空历史、新会话与终态历史不受影响。
- 准入与队列记录**不保存凭据值、不哈希明文秘密到公开标识**；集合与 pin 元数据按 setId 去重持久化。live 状态经 `setTurnAdmission(botId, status)` 发布 `queued/checking/synchronizing/failed` 相位与有界错误码，不含正文与凭据。

### 操作与更新含义

- **插件更新发布**：中心侧更新发布后，新轮在准入时取得新集合；同一 Bot 的进行中工作继续用已固定版本，不同 Bot 之间互不需要全局停顿。同一 Bot 若目标集合与活动集合不同，新轮排队等待该 Bot 现有工作结束；相同集合的并发工作可直接共用。
- **回滚**：选择旧的已保留版本集合即可，不动数据库与共享数据；被引用的旧版本不因新版本发布而被回收。
- **离线/失败**：中心不可达或集合无法就绪时消息保留并显式等待/重试；Host 端后台快照应用不得覆盖活动的 pin。

## Bot 统一活动、用户抢占与手动停止

> **状态**：已交付并经父助手**限定范围**验收（三端客户端连同一隔离 Linux Host 实测，范围与未覆盖项见 [docs/bot-activity-and-interruption.md](../docs/bot-activity-and-interruption.md)「验收」）。

- LIVE 状态新增可选 `activity`（phase：idle/queued/preparing/running/interrupting/stopping/stopped/failed；source：primary/room/dm/background/null；scopeId/requestId/startedAt 可空），在 wire 边界严格验证，不携带正文或凭据；旧 busy/queuedCount 与 `getWorkActivity` 保留，不新增公共控制方法、不改 `abort` 请求形状。
- **用户抢占**：直接用户输入持久化后、准入前抢占同 Bot 非用户来源 work（`reason:'preempted'`），不动主聊天、不清 Host 用户队列；被抢占 pending 标记 `interruption`、不推进 handled 水位，用户队列排空后按原消息重新触发，已发布批次已推进 `prepared.throughLocalId`，不会整批重发。
- **手动停止**：`abort` 立停止 gate（stopEpoch/stopPending）→ 持久取消未原生提交条目（取消与空 pin 清理同事务）→ `interruptBotWork(reason:'user_stop')` → 主会话取消/离线标记；成功置 stopped，失败可见且抛错。user_stop 覆盖各 scope 积压并把消费边界推进到停止捕获的 inbox 水位，结算为主动取消；已取消 requestId 重传不复活，真正重发用新 requestId。`stopWork`/`resumeWork` 仍是 scope 级「暂停/恢复此处工作」，语义不变。
