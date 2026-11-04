# e-助手桌面客户端（Windows / Linux x64）

> **状态说明**：模块 17（Tauri Windows / Linux 客户端）已交付并获父助手限定范围验收，交付时为 **17/20**（本期交付范围为原 20 模块中的 19 个，M19 按用户决定移出本期、编号保留）；M18（Tauri Android 界面）后续已交付，M20 进行中（已交付 M20-01，本期当前 18/19）。父已在本机真实运行 Windows/Linux 构建、Windows NSIS 安装版、Linux DEB 安装版与 AppImage 提取运行；Windows GUI 另已经真实 TLS relay 续聊手机创建的原 Bot。完整跨设备 Relay/CA 全矩阵、全格式安装与持续负载验收仍归模块 20。

## 架构与生命周期边界

`desktop/` 是基于 **Tauri 2** 的 Windows x64 / Linux x64 独立桌面客户端（标识符 `com.example.launcherprobe.desktop`，窗口标题 `e-助手`），**独立于外部长驻的 Host 守护进程**（`node host-core/host-service-cli.js`）：

1. **客户端不持有 Host 生命周期**：桌面窗口启动、切换配置或退出时，只管理客户端自身的只读/控制传输、观察订阅与私有客户端子进程（`e-launcher-client-node` + `desktop-client.mjs`），**绝不启动、停止或 `abort` 外部 Host 服务及其正在运行的 Agent**。只有用户显式触发主私聊 `abort` 或群/DM 工作上下文 `stopWork` 时，才向目标 Host 发起停止请求。
2. **无内置模型推理循环**：桌面客户端与打包的 Node sidecar 仅包含客户端协议与状态逻辑（`local-control-adapter`、`remote-control-client`、`pending-client`、`desktop-ui-store`），不打包 Pi Durable / Billion Context / Hindsight 服务端，也不在客户端进程内直接请求 LLM。
3. **固定 35 个公开控制方法**：与本机回环 Host（`http://127.0.0.1` 或 `http://[::1]`）或认证中继（`ws://127.0.0.1` / `wss://.../v1/link`）通信时，严格复用 `host-core` 既有 35 个 v2 控制方法、本机设置 CAS（`settings_get` / `settings_set`）与只读服务状态（`service_status`）。不放宽回环 HTTP 的 `Origin` 限制，也不提供通用 HTTP / 端口 / Shell / 文件系统代理。Rust 侧只有 4 个 Tauri 命令（`desktop_request`、`desktop_observe`、`desktop_unobserve`、`desktop_pick_file`）；观察流控回执 `observe_ack` 只在 Rust 本地处理，不转发给 Node 子进程。
4. **凭证与状态隔离**：模型与 Hindsight API 密钥始终留在目标 Host 环境变量中；本机控制 Bearer token、中继设备 token 与可选自签 CA PEM 仅在当前桌面会话内存中持有，不写入 `desktop-ui.sqlite`、命令行参数、`localStorage` 或诊断日志。客户端私有状态目录保存连接档案（不含 token/CA）、草稿、冻结的创建/变更意图与按连接 key 隔离的 `PendingClient` 账本（key 不含 UI 档案 id）。

## 界面与使用

左侧连接面板支持两类带显示名称的档案（最多 16 个，**不含**凭证）：显示名称只用于展示，档案按各自 id 隔离、名称不是唯一键；待发送账本却按连接 key 共用（同一 endpoint 的多个名称档案共用一个队列，见「数据路径」）。

- **local**：目标 Host 的本机回环地址（如 `http://127.0.0.1:8787`）与会话令牌。
- **relay**：`wss://.../v1/link`、已注册的客户端 `deviceId`、设备令牌与可选自签 CA PEM。

连接是**显式**动作：客户端冷启动不自动连接，重开需再次点击「连接」或「重新连接」。连接成功后按 `local`（单 Host）或 `relay`（设备目录）显示 Bot 列表；目录项显示在线/离线与最后观测时间，transport 连接成功不等于目标当前在线，不用缓存冒充在线。

三个主标签页：

- **聊天**：Bot 与群聊在同一名录混排（本机主 Bot 置顶区保留，其余按各自真实最近主聊/群聊消息时间排序）；Bot 创建（冻结 requestId，回执丢失时按 requestId 查询，不盲建第二个）、主私聊历史分页、`LIVE` 被动预览与**原始历史分开**读取、显式发送与显式停止。发送流程先冻结完整输入、所属目标与业务 ID，再入队；本地草稿按 CAS 清空成功后才发送，清空失败不发送。发送后回执丢失保留冻结记录与原 ID 供只读对账（此时编辑框可能已清空），不自动重发。每条新消息在 Host 侧经过**每轮准入**（见下文「每轮插件同步」）：返回 queued 回执表示 Host 已持久保存并排队，不等于模型已受理执行。Bot 行右键/键盘菜单与聊天标题「私聊」按钮打开该 Bot 参与的 bot-bot DM 列表（只读、默认不选对话，逐级返回保留来源与滚动）；群聊行点击直接进入消息内容：用户可发送消息（房间发布与回复 `replyTo`）并经成员面板添加/移除 Bot（`expectedRevision` CAS 变更）。写端经 RoomApiResolver 路由 —— 发送打成员所在在线 Host，成员变更只打 scope.authorityDeviceId，写端尚未连上时显示待连接而非只读；DM 无用户输入框、无成员更换；作者按协议用户角色显示，不把 `kind=user` 当成已认证人类。群聊/DM 内容页是用户聊天界面（单会话头、独立消息滚动、底部输入或只读提示）；作者、成员、标题与 aria 一律显示 Bot 名字（Scopes `knownBots` 全目录，含远端与归档），无名回退「已移除的 Bot」/「未命名设备」，不渲染 UUID、来源设备 ID 或协议调试字段，消息链接经 `desktop_open_center`（仅 HTTPS）打开。工作范围有三种独立来源：`LIVE` 观察流（推送，不推理）、原始历史分页，以及仅当该成员被选中且在线时对 `getWorkActivity` 的每 1000ms 只读刷新（最多一个在途，显式 `stopWork` / `resumeWork` 期间不发新读，旧读不回退显式结果）；停止状态只有显式恢复才解除。
- **待发送**：本地 pending 队列（分页/筛选）、显式「发送」、「对账」（只读）、仅限 pending 的本机「取消」，以及冻结的创建/成员变更意图展示。Bot 创建只支持只读 `findByRequest` 对账；scope 创建/更新没有 request lookup，界面不虚构对账或自动重放。
- **Host设置**：仅 `local` 连接可见（Relay 下明确提示到目标 Host 本机配置）；读取 `settings_get` / `service_status`，JSON 编辑后按 `expectedRevision` CAS 保存，显示 `restartRequired`（设置只在下一次重开 Host 生效）。

## 本地文件/路径引用与远端限制

桌面端通过原生文件选择框（Rust 侧 `tauri-plugin-dialog` 实现，由 `desktop_pick_file` 命令返回）选择本机普通文件时，仅生成**明确标示的本地文件/路径引用**（`{ name, path, size }`）：

- **不存在跨设备文件上传协议**：当前控制面与消息账本均只传输文本消息与固定 JSON 参数，**不会**把所选文件的二进制字节上传或同步到远端 Host。
- **本机与远端目标的差异**：当目标 Bot 位于本机 Host 时，引用路径即本机文件系统路径；当目标位于远端 Host 时，只能引用**已存在于该目标 Host 上**的路径，客户端界面与桥接层绝不伪装文件字节已传输。

## 数据路径

客户端数据根是 Tauri `appLocalDataDir` 下的 `client/`：Windows 为 `%LOCALAPPDATA%\com.example.launcherprobe.desktop\client`，Linux 为 `$XDG_DATA_HOME/com.example.launcherprobe.desktop/client`（默认 `~/.local/share/com.example.launcherprobe.desktop/client`）。Windows 使用 Local 而非 Roaming 目录。Debug 构建可用环境变量 `E_LAUNCHER_DESKTOP_DATA_ROOT`（必须是绝对路径）覆盖该根目录，Release 构建忽略该变量。

- `desktop-ui.sqlite`：schema v1，保存持久 `clientId`、连接档案、草稿与冻结意图的单一修订 JSON；超过 1 MiB、16 档或 128 意图的输入被拒绝，损坏或更高版本的库拒绝打开且不自动重置。
- `pending/<profileKey>/client-pending.sqlite` 与 `pending-owner.sqlite`：`<profileKey>` 为 `sha256(JSON.stringify([kind, url, relay 客户端 deviceId]))`（local 的第三项为空串），**不是** UI 档案 id：同一 endpoint（及同一 relay 客户端设备）的不同显示名称档案共用同一账本与所有权锁；`sending` 遗留行在重开取得锁后转为 `unconfirmed`，需要用户显式只读对账。
- 卸载应用不会上传或迁移上述文件；未发送记录保留在磁盘，重启后不会自动发送。

## 构建先决条件

- **Node.js ≥ 22.19.0**（根目录与 `host-core` 依赖安装、Vite 前端构建及 esbuild 打包）
- **Rust 工具链**（`cargo` / `rustc`；`desktop/src-tauri/Cargo.toml` 使用 `edition = "2021"`）
- **固定依赖版本**：
  - npm：`@tauri-apps/api` `2.12.4`、`@tauri-apps/cli` `2.12.4`
  - Cargo：`tauri` `2.12.5`、`tauri-build` `2.7.4`、`tauri-plugin-dialog` `2.8.3`
  - Sidecar Node.js：`v22.19.0` 官方发行包（Windows x64 `.zip` SHA-256 `ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86`；Linux x64 `.tar.gz` SHA-256 `d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d`）
- **平台系统依赖**：
  - **Windows x64**：MSVC 构建工具、WebView2 Runtime，以及系统自带的 `System32\curl.exe` 与 `System32\tar.exe`（构建脚本不使用 PowerShell / `cmd` / WSL 解压回退）。
  - **Linux x64**：系统 `curl`、`tar`、`pkg-config` 及 Tauri 2 / WebKitGTK 所需开发库（`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等）。

## 构建与开发命令

首次构建前在仓库根目录与 `host-core/` 安装锁定的 npm 依赖。`host-core` 的六个 `@earendil-works/*` 包是固定上游 main SHA（`scripts/pi-main.json`）构建的 `build/pi-main/*.tgz`，须先由 `scripts/prepare-pi-main.mjs` 生成。file: tarball 依赖首次须用 `npm install`（而非 `ci`，`ci` 不生成新 lock）写入 lockfile，之后才可用 `ci` 复现：

```bash
npm ci
npm run prepare:pi-main   # 构建固定 SHA 的六包 tgz 到 build/pi-main/
npm --prefix host-core install --ignore-scripts --no-audit --no-fund   # 首次生成 lock
# 已有 lock 后复现：npm --prefix host-core ci --ignore-scripts --no-audit --no-fund
```

在仓库根目录执行桌面端脚本（`package.json` 中的 `desktop:*`）：

```bash
# 1) 仅准备桌面端构建产物（校验并提取 Node 22.19.0 sidecar、生成图标、打包 desktop-client.mjs、汇总第三方许可证）
npm run desktop:prepare

# 2) 启动开发模式（先执行 prepare，再以 cwd=desktop 启动 Tauri CLI 与 127.0.0.1:1420 Vite 开发服）
npm run desktop:dev

# 3) 构建桌面端发布包（先执行 prepare，再由 Tauri 触发 beforeBuildCommand 构建前端并执行 Cargo 打包）
npm run desktop:build
```

`desktop:dev` / `desktop:build` 由 `host-core/desktop-tauri.js` 固定入口启动 Tauri CLI（显式 argv、`cwd=desktop`、不使用 shell），额外参数可用 `--` 透传，例如仅编译不打包：

```bash
npm run desktop:build -- --no-bundle
```

Windows/Linux 构建的并行度由 Cargo 自行决定，本文不设固定 job 数上限。

桌面构建的主要产物与输出位于已忽略的 `desktop/build/` 下；Tauri 生成的 schema 及按 `build.rs` 的 `AppManifest.commands` 自动生成的权限清单另在 `desktop/src-tauri/gen/` 与 `desktop/src-tauri/permissions/autogenerated/`（四个命令的 `.toml`），两处同样忽略、构建时再生，不是手写产品源文件：

- `desktop/build/binaries/e-launcher-client-node-<target-triple>[.exe]`：从官方固定 SHA-256 归档提取的 Node.js `22.19.0` 可执行文件。
- `desktop/build/binaries/e-launcher-host-<target-triple>[.exe]`：`cargo build --release` 构建的 `desktop/host-launcher` 启动器（内置 Host 监管进程）。
- `desktop/build/host-runtime/`：内置 Host 运行时（布局见「内置 Host 与自启动」），按内容哈希复用，依赖未变时不重复 `npm ci`。
- `desktop/build/desktop-client.mjs`：由 `esbuild` 打包的纯客户端 Node broker（`platform=node`、`format=esm`、`target=node22`）。
- `desktop/build/icons/`：由 `tauri icon` 从仓库内共享的 `assets/icon.png` 生成的应用图标（含 `icon.ico` 与 `icon.png`）。
- `desktop/build/THIRD_PARTY_NOTICES.txt`：汇总完整的 Node.js `LICENSE`、根据 `esbuild` metafile 实际打入 `desktop-client.mjs` 的 npm 依赖许可证原文，以及根据 `cargo metadata` 解析出的第三方 Rust 依赖许可证原文（不含本机绝对路径），另含内置 Host 运行时 `node_modules` 中每个 npm 包、Cua driver 与 `e-launcher-host` 启动器 Rust 依赖的许可证原文。crate 归档未自带许可证文本时，仅对已核实的精确 `package@version` + 声明匹配使用仓库内的补充文本（见 [`licenses/desktop/README.md`](../licenses/desktop/README.md)）；任何未匹配的缺失许可证仍终止构建。
- `desktop/build/web/`：Vite 桌面前端构建输出目录。
- `desktop/build/target/`：Cargo 编译输出目录（由 `desktop/.cargo/config.toml` 配置）。

## 安装包输出

`tauri.conf.json` 的 `bundle.targets` 为 `all`，安装包落在 `desktop/build/target/release/bundle/` 下：

- **Windows x64**：`msi/*.msi`（WiX，`tauri.windows.conf.json` 指定 `language: zh-CN`）与 `nsis/*-setup.exe`。
- **Linux x64**：`deb/*.deb`、`rpm/*.rpm`、`appimage/*.AppImage`。`tauri.linux.conf.json` 把 Linux 的 `productName` 覆盖为 `e-launcher-desktop`（ASCII 包名，资源因此落在 `/usr/lib/e-launcher-desktop/`），并为 deb/rpm 安装 systemd 用户单元；窗口标题仍是 `e-助手`。

## 内置 Host 与自启动

安装包自带一套本机 Host，由启动器 `e-launcher-host` 监管（崩溃退避重启、日志 `logs/host.log` 超 10 MiB 轮转）：

| 内容 | Windows（NSIS，按用户安装） | Linux（deb/rpm） |
| --- | --- | --- |
| 启动器 | `<安装目录>\e-launcher-host.exe` | `/usr/bin/e-launcher-host` |
| Node | `<安装目录>\e-launcher-client-node.exe`（与客户端共用） | `/usr/bin/e-launcher-client-node` |
| Host 运行时 | `<安装目录>\host-runtime\` | `/usr/lib/e-launcher-desktop/host-runtime/` |
| 配置/密钥/数据/日志 | `%LOCALAPPDATA%\e-launcher\host-service\` | `${XDG_CONFIG_HOME:-~/.config}/e-launcher/host-service/` |

`host-runtime/` 由 `node host-core/build-desktop.js` 生成：`host-core/`（运行所需模块、`package.json` 及按当前平台 `npm ci --omit=dev --ignore-scripts` 安装的生产依赖，含 `npm`；类型声明与 source map 已剔除）、`host-core/cua-driver/<平台>/`（固定版本 cua-driver-rs）、`plugins/hindsight/` 中被 host-core 复用的文件，以及仅 Windows 的 `native/shower-windows.exe` + `MSTSCLib.dll`。Linux 包必须在 Linux 上构建。缺少构建工具时可用 `E_LAUNCHER_SHOWER_WINDOWS_DIR`（含上述两个文件的绝对目录）与 `E_LAUNCHER_CUA_DRIVER`（预置 `cua-driver[.exe]` 的绝对路径，同目录需有完整发布文件）指定预构建产物，否则构建直接报错。

配对：首次打开客户端填写中心地址、主密钥与本机名称，客户端调用 `e-launcher-host pair` 登录中心、注册设备、写入配置与随机控制令牌，再启用自启动并启动 Host；已有设备 ID/令牌时可用“高级”入口（`adopt`）接管。主密钥只经 stdin 传给启动器，不落盘。也可在终端执行 `e-launcher-host status|start|stop|restart|enable|disable`，输出为单行 JSON。

自启动：

- **Windows**：`enable` 写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `e-launcher-host` 值（`"<exe>" run`），登录后无窗口启动。NSIS 安装前先 `stop` 并清空旧 `host-runtime\`；安装后若已配对则重新 `enable` + `start`；卸载前 `stop` + `disable`，保留 `host-service` 目录中的配对与数据。MSI 包不含这些钩子，升级前请先在客户端或终端停止 Host。
- **Linux**：deb/rpm 安装 `/usr/lib/systemd/user/e-launcher-host.service`；`enable` 执行 `systemctl --user enable e-launcher-host.service` 并尝试 `loginctl enable-linger <用户>`，使 Host 在未登录图形会话时也能随开机运行（linger 失败仅提示，不影响启用）。AppImage 不安装单元文件，启动器退回为分离的后台 `run` 进程，不提供开机自启。

## 连接外部 Host 服务

桌面客户端本身不直接拉起 Host 进程（内置 Host 由 `e-launcher-host` 管理，见上节）。不使用内置 Host 时，可先在终端独立运行统一本机服务（默认 `serve`）或中继服务（以下均为合成示例，不含真实密钥）；外部部署的 Windows 登录自启动见 `host-core/README.md`「Windows 登录自启动」，不由本客户端管理：

```bash
# 启动外部本机 Host 服务（监听 127.0.0.1:8787；两种 token 各从环境变量读取且必须不同）
export CONTROL_TOKEN="replace_with_32_to_512_chars_urlsafe_token"
export HOST_DEVICE_TOKEN="replace_with_registered_device_token"
node host-core/host-service-cli.js serve \
  --data-root "/path/to/host-data" \
  --token-env CONTROL_TOKEN \
  --center-url https://center.example.com:8443 \
  --device-token-env HOST_DEVICE_TOKEN \
  --port 8787
```

随后在桌面客户端中添加 `local`（填写 `http://127.0.0.1:8787` 与会话令牌）或 `relay`（填写 `wss://.../v1/link`、已注册的客户端 `deviceId`、设备令牌与可选自签 CA PEM）连接。

## 每轮插件同步（Host 侧准入）

> **状态**：本节为每轮准入契约的用户可见说明，实现由父助手统一集成与端到端验收；验收完成前视为设计契约而非已验证事实。

- 每条发往 Bot 的新消息在 Host 侧经**每轮准入**：Host 先持久化入队（返回 status `queued` 的回执），再向中心查询该 Bot 的目标插件集合，完成准备与确认后才真正提交执行；**queued 回执是已受理排队，不是模型已运行或完成**。
- 中心不可达或集合未就绪时，消息在聊天状态区显示 waiting（检查中/同步中）或 failed，不静默用本地旧版本执行；failed 时可用**同一 requestId 与原文**显式重试，不会产生重复消息。客户端不自动重发未确认消息。
- 轮内不切换版本：已受理轮中的工具续轮、问卷回答照常可用；中心发布新版本只影响下一轮。显式停止仍走现有 abort，取消排队中的消息走现有 pending 取消路径。
- 排队/等待状态经 LIVE 的 `turnAdmission` 字段以相位（queued/checking/synchronizing/failed）与错误码呈现，不含消息正文或凭据；无排队项时为 null。
- 客户端待发送（pending）账本语义不变：它记录的是「客户端→Host」的已派发状态，Host 侧准入排队是其后一阶段；「对账」仍为只读查询，不触发模型。

## 统一活动、抢占与手动停止

> **状态**：已交付并经父助手**限定范围**验收（三端客户端连同一隔离 Linux Host 实测，范围与未覆盖项见 [`docs/bot-activity-and-interruption.md`](../docs/bot-activity-and-interruption.md)「验收」；Windows/Linux 桌面分别以 debug/release + WebKitWebDriver/Xvfb 实测）。

- LIVE 的 `activity` 字段是 Bot 工作状态的统一依据（phase：idle/queued/preparing/running/interrupting/stopping/stopped/failed），UI 经共享 helper 解析；旧 Host 缺省该字段时按 busy/queuedCount/turnAdmission 回退，不误判 idle。
- **停止此 Bot**：停止按钮独立于发送按钮，草稿/附件存在、排队/准备中、failed 受理均可停；stopping 有独立 disabled 防重，不被发送/上传/草稿锁禁用。停止是 Bot 级取消当前执行与已受理积压，保留历史与取消回执；scope 级「暂停此处工作 / 恢复此处工作」（stopWork/resumeWork）语义不变，不被即时停止改变。
- 被停止的 Bot 明确显示「已停止」，不显示为已完成；failed 相位不一直转圈。群/DM 页面对选中 Bot 增加 primary 只读订阅，仅显示其统一活动与来源标注（如正在主聊天/其他对话工作），不混入 scope 历史；页面切换只关闭观察，不调用 abort。

## 错误恢复


客户端刻意不做隐式重试，所有不确定结果都要用户显式处理：

- **连接/传输失败**：界面区分未连接、连接中与连接失败；断线后保留原档案与目标，重连是一次显式动作，不自动重放已发送请求。观察订阅断开只结束观察，不停止 Host 内的 Agent。
- **冻结业务 ID**：Bot 创建、房间发布等操作先落本地意图再派发，回执丢失时用原 requestId/messageId 只读查询，查到才采用结果，查不到保持未确认。
- **待发送**：`unconfirmed` 行先「对账」再决定；只有确认缺失（missing）时才由用户显式「发送」原 payload。断线时队列仍可本地读取与取消，发送/对账禁用。不会有 auto flush、重连重放或按时间自动发送。
- **Host 设置 CAS**：CAS 冲突属于已返回（responded），保留编辑并读取远端新 revision，由用户显式「以远端为基准编辑」采用新基线后再保存；只有 `not-sent`（参数/连接校验失败，远端未更新）可直接修正重试。写入或读回丢失回执（unconfirmed）保持锁定，直到「只读对账」成功并显式选择基线，不会自动重放或被旧响应覆盖新目标。

## 验证状态与限制

- 桌面客户端与 sidecar 仅使用本机 Host 与合成模型/测试数据进行验证，不读取真实用户设置、凭据或生产数据库；模型响应为 Mockoon 合成 SSE，未接入付费模型或真实用户模型配置。M17 未做中继 GUI 联调：Relay 档案与设备目录仅为静态实现，跨设备验证归模块 20。
- 已实际运行：Windows/Linux debug 与 no-bundle 构建、Windows Release（MSI + NSIS）、Linux Release（DEB + RPM + AppImage，未削减 targets）；Windows 用 NSIS 静默安装到私有测试目录后运行并完成合成 Host 任务，MSI 仅以 WiX `dark` 解包核实（Product Codepage 936、Language 2052），**未执行 MSI 安装**；Linux 实际安装 DEB 并运行，卸载后以 `AppImage --appimage-extract-and-run` 运行且 `clientId`/配置保留、冷态不自动连接，**未测 FUSE 挂载模式与 RPM 安装**。
- 已实际运行：Windows/Linux 基础 GUI、Node 客户端冷启动/重开、Unicode 与含空格 cwd、发送/接收实时回复；900x600 主聊天与群聊布局，展开原始历史后发送区仍可见。Windows 实测关闭客户端时 Host 仍在 busy 的任务在窗口与 Node 子进程退出后继续完成；Linux 分别验证普通 debug 窗口与 AppImage 原生关闭后客户端/Node 子进程回收、Host 仍存活（未在 Linux 复现 busy 任务连续性）。
- 已实际运行：本地文件选择返回绝对路径与大小（如 `desktop/icon.svg`，496 B），发送内容为 `[文件路径引用，未上传]`；草稿冲突码、pending 入队/取消/重连不重放、设置 CAS 冲突与未知结果锁；9 份客户端 SQLite 完整性/FK 检查；安装版 Windows/Linux 数据目录未检出精确合成 token（profile 名称阳性对照命中），输入框 token 清空，`localStorage`/`sessionStorage` 均 0 条。
- 未覆盖：跨物理设备 Relay/CA 全矩阵与目标切换（Windows GUI 经 relay 续聊手机创建的 Bot 已在 M20-01 实测，Linux GUI 跨机未跑）、全链路压力与交错、FUSE 挂载、MSI 安装/卸载、RPM 安装、ARM64 真机与原生功能；TUI（M19）已按用户决定移出本期（未验收代码只在 git stash `02f1396f`，仅未来草稿、本期不恢复，保留草稿，不计交付，也不是 M20 完成条件）。这些属模块 20 的整体验收，不能由本文的本机结果外推。
