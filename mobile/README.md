# Tauri Android 客户端（`mobile/`）

## 当前发布与更新（2026-11-06）

产品版本为 `1.1.0`、Android versionCode 为 `2`。本轮在 API 36 x86_64 模拟器实际完成从开发包 `1.1.0/code 2` 到隔离验收包 `1.1.1/code 3` 的 PackageInstaller 覆盖升级，包含认证下载、摘要/包身份/版本校验、未知来源授权、系统确认、取消后重试与下次启动读取真实版本；原设备身份、Bot 和已完成模型回复保留。测试使用独立开发签名，未验证正式旧签名 lineage 或 ARM64 真机。完整范围见[发布进度](../docs/open-source-release-progress.md)。

更新桥方法为 `updateStatus/updateCheck/updateDownload/updateInstall/updateCancel`，通过现有 Rust/Kotlin/私有 Binder 访问默认进程的更新器。UI 不传下载 URL、文件路径或令牌。客户端连接后按 24 小时间隔自动检查，手动检查不受此间隔限制；下载、安装由用户发起。安装器启动只表示等待系统操作，下次启动按实际已安装版本判断结果。

首次配对先在原生私有存储保存固定 ID 与待确认令牌；同 ID/同令牌可幂等重试，显式 force 才旋转凭据。中心使用单 HTTPS/WSS origin。Rust 工具链固定为 `1.99.1`；普通开发使用标准本地 debug key，覆盖旧开发包需显式指定原 key，正式 APK 使用独立受保护签名配置。

以下模块说明与历史记录保留原提交/范围；版本、签名和本轮结果以上述当前记录为准。


M18（Tauri Android 外壳）已交付并获父助手限定范围验收，交付时为 **18/20**（本期交付范围为原 20 模块中的 19 个，M19 按用户决定移出本期、编号保留）；M20（跨设备集成、打包与真机验收）进行中，本期当前 **18/19**：M19（Windows/Linux TUI）本期不交付，其未验收代码只在 git stash `02f1396fda08d1b666ca83597ebbcea805c74d28`（仅未来草稿，本期不恢复，保留草稿，不计完成），TUI 界面/终端快捷键验收不再是 M20 完成条件；已交付 **M20-01 手机远端入口 + 限定范围跨设备联调**，并在 REDMI K80 真机完成限定运行验证（首次安装 + 覆盖重装，见「验证边界」），但 M20 并未整体完成。本目录只提供 Android 手机侧可见界面：默认是本机 Host，“其他设备”页是同一份桌面客户端实现跑在手机原生桥上（见下节）；不替代本机 Host，也不含桌面 GUI 安装包（见 [`desktop/`](../desktop/README.md)）。

## 当前聊天与连接行为（2026-10-29）

- 在线发送后，用户消息和“正在发送”动画在首帧显示；本机和远端共用发送、等待、工具调用、回复及终态显示。明确离线时保留草稿，不入队、不自动补发。发送结果不确定时保留原请求 ID，只读对账，避免重复执行。每条新消息在 Host 侧经每轮准入（见下文「每轮插件同步」）：queued 回执表示 Host 已持久保存并排队，不等于模型已执行。
- 打开客户端即启动 `BotClientService` 前台生命周期并尝试启动本机 Host；两者不以中心认证或网络连通为开关。未配置 Host 中心凭据或首次启动失败时显示错误；冷启动仍须中心完成初始化，网络恢复或客户端重新连接中心后会延迟重试已配置但失败的 Host，不循环重试未配置状态。保存 Host 连接配置后再启动。成功运行的 Host 子进程意外退出时，凭当前客户端的退出监听延迟重启。关闭/隐藏界面只释放该界面的观察和可见性；通知或设置中的「退出客户端」关闭界面并回收两个 Node 子进程，保留业务数据与中心凭据。显式断开中心仍清除原有客户端连接凭据并停止该连接的恢复，不停止 Host。
- 中心事件流或 relay 中断由 broker 串行重连；网络恢复和回到前台会做有截止时间的连接检查。UI 恢复 IPC、目标订阅和历史；认证撤销、证书错误等永久错误需更新连接配置。
- 后台已提交任务的完成／失败通知按 Bot 合并并持久去重；正在查看的聊天不弹完成通知。点击通知按设备 ID 与 Bot ID 打开聊天。Android 客户端凭据只通过 AndroidKeyStore 加密保存，broker 不另存明文 token。
- 旧聊天界面入口已停用；历史聊天 Intent 打开当前 Tauri 客户端，不自动定位或迁移旧会话。旧数据、旧 Host 待确认与显式导入仍保留。分享确认仍保存至旧会话草稿、不会发送或自动转入当前客户端；保存后可选择「打开客户端」。
- 主 Bot 横向滚动区铺满手机宽度，横屏不再受 680 px 宽度上限约束；普通列表、按钮和输入框保留内容内边距。
- Bot Hub 列表将群聊（room scope）与普通/远端 Bot 同页混排：本机走只读 scope 适配器、远端按目标设备冻结 identity 后读取各节点可见 room，按最近消息时间与 Bot 行统一排序；后台 DM 不混入主聊摘要与排序。点击群聊行直接进内容：用户可发送消息并编辑成员 —— 发送经 RoomApiResolver 路由到成员所在在线 Host（本机群聊经中心/中继连接回环本机），成员变更只打 scope.authorityDeviceId，写端尚未连上时显示待连接而非只读，DM 仍只读。主 Bot 卡、普通与归档 Bot 行支持长按/右键/键盘（Shift+F10）「查看私聊」菜单；聊天标题也有可见「私聊」按钮，均打开仅该 Bot 参与的 bot-bot DM 列表（默认不选中，全部只读，不含停止回调）。原「Bot 通信」菜单项与抽屉「群聊与 Bot 私聊」入口已移除；系统返回按 详情 → DM 列表 → 来源（Hub 或主聊天）逐级回退。群聊/私聊内容页是面向用户的聊天界面：一个会话头（返回、头像、成员名标题）、独立消息滚动区与底部输入/只读提示，作者与成员一律显示 Bot 名字（宿主 knownBots 全目录解析，无名回退「已移除的 Bot」），不显示 UUID 或协议调试字段；宿主不再叠 subpage 标题栏与外层滚动。

下方 M18/M20 的旧验收记录保留历史事实；涉及旧聊天入口、客户端/Host 启停、连接恢复和离线发送的旧说明，以本节为准。本次生命周期调整尚需设备端验收；厂商后台冻结与真人触摸仍需真机验证。

## 组成：现有 APK 内的一块界面，不是第二个应用

- 沿用原 Gradle APK：`applicationId`/`namespace` 仍为 `com.example.launcherprobe`，原签名、原数据路径、原 Android 能力全部保留；没有生成第二个应用工程，也没有修改 vendored 的 Tauri Android SDK。
- `mobile/src-tauri/`：Rust crate `e-launcher-mobile`（`[lib] name = "e_launcher_mobile"`，`cdylib`），固定 `tauri = 2.12.5`、`tauri-build = 2.7.4`，启用 `custom-protocol` 让前端资源编进库。
- `mobile/web/`：Tauri 前端的唯一入口（`HashRouter` + 既有 `web/src/Host` 的 `HostPage`，`persistentPending`），并新增“其他设备”远端页（见下节）；`mobile/web/src/mobile.css` 只补工具栏、滚动区与`.remote-client` 受限容器，复用 `web/src/styles.css` 与 `desktop/web/src/app.css`。
- `vite.mobile.config.ts` 把 `mobile/web` 构建到 `mobile/build/web`（`tauri.conf.json` 的 `frontendDist` 是 `../build/web`）。
- `app/build.gradle` 的 `buildMobileUi` 任务产出 Rust cdylib、wry/tauri 生成的 Kotlin，以及作为 Gradle assets 源根 `app/build/generated/assets/tauri/` 内的 Rust 通知（APK 内 asset 路径为根目录下的 `THIRD_PARTY_NOTICES.txt`）。

## 为什么要独立进程

Tauri 的 Android 运行链路（App.run → tauri-runtime-wry.run → tao `EventLoop.run`）在 `run_return` 之后调用 `std::process::exit`。若界面与 Host 同进程，SDK 正常退出会连带杀掉默认 Java 进程——它负责 Host/FGS 并拉起独立的 Node Mobile 子进程。因此界面放在独立进程 `:tauri_ui`（manifest `exported=false`、`singleTask`、`windowSoftInputMode=adjustResize`），并在进程内首个 WebView 创建前设置 WebView 数据目录后缀 `tauri-ui`，与旧 Capacitor 进程的 WebView 目录/localStorage 隔离。默认进程的 `InitializationProvider`、WorkManager 与旧 provider 均未改动；`:tauri_ui` 另有一个 lifecycle-only 的 `TauriInitializationProvider`（`authority=${applicationId}.tauri-startup`、仅 `androidx.lifecycle.ProcessLifecycleInitializer`），用于让 wry 的 `ON_CREATE` 能通知 Rust 建界面，不启动 Host/Node/FGS。

## 入口与固定旧入口

- 普通启动、Host 通知和历史旧聊天 Intent 经 `MainActivity` 转入 `TauriMainActivity`，不打开旧聊天页面，也不将旧会话 ID 当作新 Bot ID。
- 旧设置、旧定时任务页面和显式旧 Host 待确认入口仍留在 Capacitor；`assistant_legacy_ui=true` 仅对显式旧 Host 生效，不能恢复旧聊天入口。
- `openLegacy` 仅接受 `settings` / `host`；旧聊天动作已移除，不存在任意 Intent、路径或 shell 转发。
- 旧 Host 的 pending、草稿与 localStorage 仍通过「旧 Host 待确认」进入原 Capacitor 页面访问，不复制、不迁移、不自动重放。

## 命令与桥

- JS 侧只有 4 个命令：`mobile_host_request`、`mobile_host_listen`、`mobile_host_ack`、`mobile_host_unlisten`；插件 id `android-host`，Kotlin 类 `BotHostTauriPlugin`，capability `main.json` 只给 `main` 窗口授予这 4 个权限；窗口使用 HTTPS 资源协议（`https://tauri.localhost`），CSP 只允许自身脚本与 `ipc:`/`https://ipc.localhost`。
- 远端页不新增命令，只用 `mobile_host_request` 的固定 method：`clientRequest {op,params} → {value}`（broker 的 16 个普通操作）、`clientObserve {observationId,targetDeviceId,target}`、`clientUnobserve {observationId}`；观察事件走同一条 `mobile_host_listen` 流上的 `clientFrame`（`data` 为 `DesktopObservationEvent`），ACK 仍按 `deliveryId` 走 `mobile_host_ack`，不使用桌面的 `observe_ack`。没有显式关闭客户端子进程的命令：child 由原生会话在 UI 关闭/EOF 时释放。
- 桥是私有、非导出、同 UID 校验的 Binder 服务：Binder 事务只返回 socket FD，业务走 UTF-8 JSONL（`request`/`response`/`event`）。上限：2 MiB 行、8 个在途普通请求、8 帧/4 MiB 事件预算、暂停/清理保留通道、25 s 请求截止与 5 s 绑定截止、按 generation/nonce 的投递身份、单一原生事件代理与最多一个等待 ACK 的事件帧。
- 公开 Host 控制方法仍是 **35 个**；Kotlin 内的 `start`/`stop`/`openLegacy`/`reconnect`/`hide` 是 UI 本地动作（socket 内另有 `uiSettings`、`pause`），不是新增公开方法。`streamError` 是私有事件通道，不新增 JS 命令或 Host API。

## 首次绑定与引导检查

首次绑定只需中心地址与所有者密码：本地桥新增 `pairCenter`（params
`{url,password,displayName?,ca?,force?}`，result `{centerUrl,deviceId,
displayName,hostConfigured,connectionRequested,warnings?}`，不返回 token）。
原生侧先以 HTTPS owner 身份 `GET /api/session` → `POST /api/session` →
`GET /api/session` → `POST /api/devices`（platform `android`），随后复用既
有 Host 保存、客户端凭据存储与连接/FGS 入口，绑定成功后自动发起连接。仍保
留手动高级模式。

- 密码只在内存中使用；设备 token 只写原生加密存储。自签 CA 继续按原规则
  校验：不 trust-all、不关闭 hostname 校验，也不把密码带进重定向。
- 已成功注册的设备不会重复提交注册；持久化之后连接失败进入可恢复状态。
- 本地桥另有 `repairCenterBinding`：只用本机已保存的绑定与凭据恢复中心绑
  定并重新发起连接，不需要密码、不重新调用 `/api/devices` 注册设备；绑定
  缺失或凭据失效时报可恢复错误，而不是静默重建身份。
- `onboardingStatus {}` → `{notificationsGranted,batteryUnrestricted,
  shizukuInstalled,shizukuRunning,shizukuGranted}`：只读查询，不启动服务或
  授权。
- `onboardingAction {action:'notifications'|'battery-settings'|
  'shizuku-permission'|'shizuku-manager'}` → `{requested:boolean}`：仅前台
  显式按钮动作；回到应用重新查询，`requested:true` 不等于已授权。
- 设备重启后 Shizuku 服务停止，需要用户重新启动 Shizuku（应用授权记录保
  留）；电池不受限需要用户在系统设置中确认。

## 其他设备（手机远端页，M20-01 已交付）

- 与本机 Host 页并列：首次点 **其他设备** 才挂载远端页；之后两侧都保持挂载，**本机 Host** / **其他设备** 只切换可见性（`hidden`），以保留各自草稿与已选目标。不可见的一侧由 `active`/`pageActive` 传给页面：立即取消该页观察（`clientUnobserve` / `cancelObservation`）、停只读轮询（回执刷新、Work activity 1s 刷新、生命周期轮询），**不** stop/abort Host、**不**断开 client、**不**关 client child，也不自动重连或重放变更；再切回时观察/轮询按只读方式重建（LIVE 需要它）。
- 前端没有“退出远端”：断开网络用远端页内桌面 `App` 的显式 **断开**；关闭整个 UI 时由原生会话负责释放 client child（无 `clientClose` 命令）。`dispose()` 会逐个移除本页的 `clientFrame` 与流失败监听（不只 clear 表）；批量取消观察用 owned 8 槽（含 `opening`/`live`/`closing`）与串行 promise 确认取消，无丢弃队列。
- 远端页直接复用 `desktop/web/src/App.tsx` 与 `BotChats`/`Scopes`/`PendingPanel`：连接档案（只持久非密字段）、设备目录、当前目标、创建 Bot、按原 ID 查询、聊天/历史/LIVE、scopes/pending 与桌面同一套代码，因此继承冻结 ID、草稿 CAS、未知结果只读对账与不自动重放。目标选定后连接面板收起、可手动展开，断连后自动复位（`autoCollapsedFor`）。
- 已修：设置页 `null -> null` 状态更新造成的 React 循环；重连后 cached 状态与身份显示矛盾；空 relay 目标被拦下（不把未选设备当目标发请求）。
- `desktop/web/src/api.ts` 的 `DesktopViewApiImpl` 只多了一个可注入 `DesktopTransport`（`request`/`pickFile`/`observe`/`unobserve`），`createDesktopClient()` 默认仍走原 4 个桌面 Tauri 命令，桌面 ACK/ready/close 语义不变；`mobile/web/src/remote-client.ts` 注入手机实现（`clientRequest`/`clientObserve`/`clientUnobserve` + `clientFrame` 监听，复用本 UI 唯一事件流）。host-core 只以 `import type` 引用，Node broker（`desktop-client.js`、`node:sqlite`、`ws`）**不进** Web bundle。
- 远端档案页自身在冷启动不创建桌面 client：只有首次显式点 **其他设备** 才 `createDesktopClient(transport)` 并由 `App` 的 `init()` 触发 `ui_get`。流失败/显式重连后旧身份立即失效（`setTransportConnected(false)` + `setIdentity(null)`），必须用户重新输入 token 并显式连接；不自动重连、不重发观察、不重放变更。
- 手机不提供本机文件 picker：`pickFile()` 直接返回 `FILE_PICK_UNSUPPORTED` + `not-sent`，不假装路径引用可上传。
- 中心登录（“连接中心”）独立于下述远端档案：Android 在中心认证成功后以 AndroidKeyStore AES-GCM 加密保存最后一组客户端凭据于不参与备份的私有文件，启动时尝试恢复一次；“更换中心连接”清除该记录。地址、设备身份或 CA 变更时须重新输入令牌；暂时离线不会清除凭据。
- 远端档案凭据边界：连接 token 与 relay CA 只存在于远端页的输入态（连接尝试结束即清空），不进 localStorage/sessionStorage、不写日志；持久非密配置、草稿与 intents 由原生 broker 的 `desktop-ui.sqlite`、pending 由 `pending/<profileKey>/` 保存（`host-core/desktop-ui-store.js`、`pending-store.js`）。这些数据由独立 client child 使用自己的数据目录 `files/bot-client`，与本机 Host 的 `files/bot-host` 分开，互不覆盖。
- 窄屏/横屏只在 `mobile.css` 的 `.remote-client` 容器内覆盖：桌面两栏折成上下两段，配置/设备目录限高内滚，聊天与发送区占满剩余高度；`.remote-client[hidden]` 显式 `display:none`（作者样式会盖掉 UA 的 `[hidden]`）。`desktop/web/src/app.css` 是全局样式且先于 `styles.css` 加载，所以 `mobile.css` 在本机页容器 `.mobile-body` 内恢复 `styles.css` 的字体/字号/行高/字重/段落下边距基线，避免桌面元素规则污染本机样式；两个样式文件本身未改。
- 远端使用步骤（需先有可连的目标 Host）：① 在“连接配置”保存档案：local 只存 url（可带 expectedDeviceId）与非密名称，relay 只存 url、非密设备 ID 与名称，**档案不含 token/CA**；② 选档案后输入 token（relay 可贴 CA）并点 **连接**，token 与 CA 只在本会话内存；③ 等设备目录出结果，relay 连接成功后还要在目录里显式选目标设备；④ 在聊天/群聊与 Bot 私聊/待发送/Host设置里操作，发送前草稿先持久化。
- 验收（M20-01，父限定，合成模型不付费）：隔离真实 TLS relay 在 Linux，Windows 与 Linux Host 上线；手机 UI 经 CA 认证 relay 创建 Linux Bot（host cwd 校验，首次 `INVALID_CWD` 按明确失败修目录后显式重建）、提交 Unicode/emoji/多行写入真实 Durable/BC 原始 history 并收到合成 SSE 回复；UI 进程 SIGKILL 后 clientNode 退出、Linux 已受理任务仍完成；Windows debug GUI 经同一 relay 续聊手机创建的原 Bot；实际 8 路 primary LIVE 各取 snapshot，8 句柄并发 close 后又开 8 路再关闭通过（真实手机 API，不是纯 mock）；设置页重连无 React 循环且 child 释放。布局在 412x684 验证：折叠后输入可见、聚焦+滚动发送可见；ADB 点输入使软键盘把 viewport 压到 412x400，输入与发送均可滚动触达（ADB 注入不算真实手指）。
- 最终验收：APK sha256 `2b50fccfaef5b1da5f8f47777fe4aea30b91f90d57af9a123e78443be52bba39` 已原签名覆盖安装到模拟器；同目标断开后重连并显式选回原设备，面板自动收起（实际通过）；离线草稿发送只进入 pending，重连后仍为 pending，对目标 `getSubmission` 返回 `SUBMISSION_NOT_FOUND`，不自动重放，用户式本地取消到 `CANCELLED`/`not-sent`。原 Host 6 库 + 新 client 3 库完整性/FK 通过，client 目录合成 token 零匹配（profile 名称阳性对照命中）。
- 未完成：ARM64 旧版本覆盖迁移与 16 KiB 页设备（K80 真机首次安装+覆盖重装限定运行验证见「验证边界」）、手机 UI × Windows Host 的跨机聊天（本轮只用 CLI 建了共用 room/DM 并验元数据传播与 room 持久 ACK，不宣称完整自然群聊智能或 DM 对话）、多格式安装升级卸载、真实 Hindsight/ASR/付费模型；这些不被本轮的远端页结果外推。

## 数据、生命周期与凭据

- Host 运行数据仍在 `files/bot-host`，模型凭据在 `bot_host_credentials`，语音偏好/秘密在 `bot_host_voice`/`bot_host_voice_secrets`；界面 `uiSettings` 只含 language/appearance，不读 Pi 配置、没有凭据 getter。
- 关闭界面、关闭观察或 socket EOF 只释放**该 UI 会话**持有的观察与语音捕获，不调用 `stop`/`abort`/`resume`，不停止 Host；重连只重建本 UI 传输，不重发观察或变更类请求。
- pending：Tauri 界面在独立后缀的 localStorage 保存冻结的 requestId/文本/语音身份（写成功才发送）；旧 pending 仍用 sessionStorage，互不迁移；损坏或冲突记录阻止新发送。删除/替换（包括正常受理回执、已知未派发的语音失败、用户显式本地清除）都先核对持久存储里的原身份与不可变内容；未知结果保留原 ID，供只读对账或用户显式本地清除，不自动重放。取消语音的回执不能证明没有提交，因此不能仅凭它清掉语音身份。
- 接收 `queued/placed` 回执不等于完成：界面按 ≥1000ms、最多 1 个在途只读 `getSubmission` 刷新已接受回执，隐藏/断开/终态停止；显式重连恢复传输与只读刷新，但不重新观察、不自动发送。

## 每轮插件同步（Host 侧准入）

> **状态**：本节为每轮准入契约的用户可见说明，实现由父助手统一集成与端到端验收；验收完成前视为设计契约而非已验证事实。

- 每条发往 Bot 的新消息在 Host 侧经**每轮准入**：先持久化入队（queued 回执），再由 Host 向中心查询目标插件集合、准备并确认后才提交执行；queued 是已受理排队，不是完成。
- 中心失败/集合未就绪时消息保留为等待（检查中/同步中）或失败，不丢、不静默用旧版本执行；失败可显式重试且沿用同一 requestId 与原文，不自动重发，也不回写/覆盖用户更新的草稿。本机与远端页共用同一段显示逻辑。
- 轮内不切换版本：进行中的问卷回答、工具续轮属本轮内部续行，不是新输入；显式停止走既有 abort 取消排队与工作。
- 排队/等待状态经 LIVE `turnAdmission` 字段（queued/checking/synchronizing/failed + 错误码）显示，不含正文与凭据。

## 统一活动、抢占与手动停止

> **状态**：已交付并经父助手**限定范围**验收（probe36 Android API 36 x86_64 模拟器客户端连隔离 Linux Host 实测，含真实 ADB 点按钮；范围与未覆盖项见 [`docs/bot-activity-and-interruption.md`](../docs/bot-activity-and-interruption.md)「验收」）。

- LIVE 的 `activity` 字段是 Bot 工作状态的统一依据，本机页与「其他设备」远端页共用同一解析 helper；旧 Host 缺省该字段时按 busy/queuedCount/turnAdmission 回退，恢复/离线仍显示未知状态、不伪装工作中。
- **停止此 Bot**：停止按钮独立于发送按钮，草稿/附件存在、排队/准备中、failed 受理均可停；stopping 有独立 disabled 防重，不被发送/上传/草稿锁禁用，`onAbort` 的 Promise 被正确等待，失败显示错误提示。停止是 Bot 级取消当前执行与已受理积压，保留历史与取消回执；scope 级「暂停此处工作 / 恢复此处工作」（stopWork/resumeWork）语义不变。
- 本地发送的乐观状态在受理前可继续叠加，受理后以 Host activity 为准；被停止的 Bot 明确显示「已停止」而非已完成。

## 权限与语音


麦克风权限由插件 `@TauriPlugin` 声明，Kotlin 侧在 `startVoice` 前检查真实前台与权限，权限回调按 generation 归属；语音沿用默认进程 Host 的既有“冻结 botId/requestId 只提交一次”语义与事件形状，重复/迟到回调不会串到新捕获。debug 构建开启 WebView 检查，release 保持关闭，未放松 CSP/Origin/TLS。

## 构建与先决条件（Windows PowerShell）

JDK 21、Android SDK Platform 36、NDK `28.2.13676358`、AGP 8.13.0 / Gradle 8.14.3、Kotlin 2.3.20、Node **≥ 22.19**，以及 Rust：SDK 引导的 `cargo metadata` 只需要 Cargo（不需要 Android target 或 NDK）；真正编译 `libe_launcher_mobile.so` 的 ABI 构建才需要相应 `rustup target add aarch64-linux-android x86_64-linux-android` 与 NDK。

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node host-core/build-mobile.js --sdk-path    # 可选：提前生成 SDK include 片段（settings 阶段缺失时也会自动生成）
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
.\gradlew.bat :app:assembleDebug --no-daemon --console=plain   # 默认 arm64-v8a
exit $LASTEXITCODE
```

按需选 ABI：把同一条命令换成 `-PlauncherAbis=x86_64`（模拟器）或 `-PlauncherAbis=arm64-v8a,x86_64`（一个 APK 同时含两种 ABI），不需要连续构建多次。`:app:assembleDebug` 依赖的 `buildMobileUi` 已包含界面前端构建；只改前端想看产物时单独跑 `npm run mobile:web`（tsc + vite → `mobile/build/web`）。

- SDK include 片段 `mobile/build/tauri-sdk.gradle` 是生成物且被忽略：`settings.gradle` 在它缺失时会在配置阶段用 `providers.exec`（`workingDir = rootDir`、显式 argv、不过 shell）同步执行 `node host-core/build-mobile.js --sdk-path`，成功生成后才 `apply`。这同时覆盖 plain Gradle、CI 与 `scripts/verify.ps1`，不需要改任何调用方。手动先跑 `node host-core/build-mobile.js --sdk-path` 仍然有用（可提前定位问题），但不是必需。
- 如果 helper 跑完后片段仍不存在（例如 Cargo 不可用或 `mobile/src-tauri` 的 Cargo 图解析失败），Gradle 会抛带退出码与修复指引的 `GradleException`。注意：`node`/`cargo` 本身无法启动时，`providers.exec` 会直接以 Gradle 的 Exec 失败报错，不会进入这个自定义分支；两者都是真实构建错误，不会猜 cargo registry 目录，也不做 lock 刷新回退。
- `:app:assembleDebug` 依赖 `buildMobileUi`，它执行 `node host-core/build-mobile.js --abis <launcherAbis> --ndk <sdk>/ndk/28.2.13676358`：构建 release 版 Rust cdylib、用 NDK clang 显式参数交叉编译并校验 16 KiB ELF 对齐、把 wry/tauri 生成的 Kotlin 写入 `app/build/generated/source/tauri`、把 `.so` 放到 `app/build/generated/jniLibs/tauri/<abi>`，并把按实际构建 ABI 的 cargo 图生成的完整 Rust 通知写到 Gradle assets 源根 `app/build/generated/assets/tauri/THIRD_PARTY_NOTICES.txt`（APK 内 asset 路径是 `THIRD_PARTY_NOTICES.txt`，不是 `tauri/` 子目录）。
- `gradle.properties` 固定 `org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8`（完整 APK + androidTest 构建实测需要）；未设 Gradle/Cargo 并行上限；Kotlin 数据用 KGP 默认 `.kotlin/`（已忽略）。
- 当 `:tauri-android` 工程（cargo registry）与工作树不在同一磁盘根时，仅该工程的 `KotlinCompile` 关闭增量编译；`:app` 保持增量。
- 依赖自带的法务文本（`/META-INF/LICENSE`、`/META-INF/LICENSE.txt`、`/META-INF/NOTICE`、`/META-INF/NOTICE.txt`、`/LICENSE`、`/LICENSE.txt`、`/NOTICE`、`/NOTICE.txt`）也是这 8 个路径：`android.packaging.resources` 只把这 8 项从 AGP 默认排除集合里移除，并按标准 DSL 加入 `resources.merges`（同名文件合并完整上游文本）。签名/MANIFEST 等其它默认排除、默认 service merge 与 `jniLibs.useLegacyPackaging` 均不变；不使用 `pickFirst`、不手工拼接替代文本。
- 法务资源已验证（限定范围）：删除生成片段后重新完整构建双 ABI `assembleDebug`+`assembleDebugAndroidTest` exit 0、片段自动重建且字节一致；新 APK 相对上一验收包只增加 `META-INF/LICENSE`、`META-INF/LICENSE.txt`、`META-INF/NOTICE` 三个条目，其余全部原条目（DEX/.so/所有 assets/res）按相同 ZIP 顺序单次解压 SHA256 完全一致；4 个 Jackson 2.15.3 依赖各自的 `META-INF/LICENSE`/`NOTICE` 共 8 项均包含在合并后的完整文本中；zipalign `-P16` 与原签名通过。此为父在本机做的限定验收，不等于远端 CI 已验证。
- Rust 依赖的完整通知仍由 `build-mobile.js` 汇总到 assets 的 `THIRD_PARTY_NOTICES.txt`，与上面的 Maven/jar 法务资源是两件事。
- 产品版本从根 package.json 读取，versionCode 独立递增，debug/release 签名分离；applicationId、原业务数据路径、ABI 选择、16 KiB 页对齐与既有 Shower/Pi 资产管线保留。
- GitHub Actions `apk.yml` 在 Gradle 之前用 runner 自带 `rustup` 装固定 Rust 1.99.1（minimal）与两个 Android target（不改本机工具链、不新增 action 依赖）；该步骤属于已实现的接线，**尚未在真实 GitHub runner 上执行**。本地构建只需本机已装 Rust，不需要这一步。

## 验证边界（父助手限定范围）

- 环境：保留 userdata 的专用 `emulator-5556`（Android 36 / x86_64）；`-no-audio` 静音模拟器 + 自有可信 HTTPS 合成 ASR。M18 验收时无真机、无付费模型、无真实 Hindsight/ASR，ARM64 只构建（ELF 对齐、zipalign `-P16`）未运行；其后 M20 已用 K80 真机做限定运行验证（见下条）。
- 已实测：真实 Tauri React 资源/启动/桥；冷启动不拉起 Host/Node 且保留 deviceId 与初始 DB 哈希；Unicode/emoji 创建与聊天、文字与语音回执到 done；界面返回/SIGKILL 后已受理任务仍由同一 Host/Node 完成，冻结原 ID 在回执丢失与 UI 进程死亡后仍可对账且无重放；存储读/写失败阻止发送、owner 冲突、缺失重发与非法 modelRef、条件清理；8 个 RPC 准入与第 9 个 `RPC_BUSY`、已写出 25 s `TIMEOUT`/unconfirmed、超 2 MiB/未知方法/非法 legacy 动作拒绝；8 观察 + 最多一个等待 ACK 的事件帧、溢出锁存、显式重连恢复、旧/重复 ACK 无害；空闲 EOF 只发一条私有 `streamError` 并显示提示；首次授权/拒绝/权限期间 Home/显式取消后迟到授权不启动采集；竖/横屏工具栏、原生 systembar padding、键盘把视口从 684 压到 400 且输入可滚动；固定旧会话/设置/Host 路由与独立 WebView 存储隔离。
- 未实测：真实模型/ASR/Hindsight、手机 UI × Windows Host 的跨机聊天、ARM64 旧版本覆盖迁移与 16 KiB 页设备、全部传输字节饱和与竞态、5 s 绑定故障定时器、全部外观组合。手机远端页已在本轮用隔离真实 TLS relay + 合成模型完成限定验收，不等于完整跨设备中继/目标切换与真机全部通过。
- 真机限定运行（REDMI K80 / 24117RK2CC，Android 16、arm64-v8a、页 4096；旁置 K90 未操作）：同 APK（sha256 `2b50fccfaef5b1da5f8f47777fe4aea30b91f90d57af9a123e78443be52bba39`）先首次安装（安装前设备无此包，故非旧版本真实用户数据迁移验收），再覆盖重装 `-r`；冷启动无 Host Node/FGS，显式启动后真实 ARM64 Node + specialUse FGS 运行，本机 Bot 中文/emoji/多行写入真实 Durable/BC 历史并取回合成 SSE 回复；UI 进程被 kill 后默认进程与 Host Node 同 PID 保持、重开读到持久回复（关闭前受理回执未捕获，不写精确 busy 接纳时序）；打开“其他设备”后 Host/client 两个 ARM64 Node 并存且 client 用独立数据目录；经真实 CA TLS relay 连 Linux Host，提交唯一 K80 marker 多行消息并在 Linux 原始历史读到输入与回复；8 路 LIVE 各 snapshot，批量 close 后再开 8 路再关闭通过；设置页显式重连后 client Node 退出、本机 Host 同 PID 继续且 UI 无循环；清空合成配置/alias 并停 Host 后覆盖重装，Host state + client store + shared_prefs 字节一致、7 份 SQLite integrity/FK 通过，重开冷态无 Node；无崩溃 buffer 条目。页为 4 KiB，不宣称 16 KiB 实测；本轮未跑 `notifications` 组。
- 法务资源改动后 M18 未重跑设备 E2E：上述 M18 设备验收适用于字节一致的原有 APK 条目（Stage 12 已逐条 SHA256 比对），新增的只有 `META-INF/LICENSE|NOTICE` 等法务条目与构建/CI 接线；M20 的 K80 真机验收另使用 `9c495e3` 构建的 APK，摘要见上条；这是独立的运行验收。远端 GitHub Actions 仍未实际运行。
- 旧回归的普通检查里 `notifications` 组仍在“立即删除是否清空通知”断言处失败（M16 起的既有问题；调试器暂停下通过但不属普通通过，确切原因未确认）；本轮普通检查基线通过一次、stage1 新 APK 仍失败，未改产品或断言，不宣称已修好；其余 10 组正常通过是 M18 的历史结果，本轮未复跑这 10 组，不要宣称 11 组全部普通通过。
