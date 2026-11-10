# pibot 桌面客户端（Windows / Linux x64 · macOS Apple Silicon）

Windows x64、Linux amd64 和 macOS Apple Silicon（13.5+）的发行包分别为 NSIS、DEB 和 DMG；macOS 应用内更新使用签名的 `PiBot.app.tar.gz`。产品版本以仓库根 `package.json` 为准。首次部署和历史验收分别见对应文档。 [快速入门](../README.md#首次部署并跑通一个-bot) · [历史验收](../docs/open-source-release-progress.md)

## 首次连接

安装后打开客户端，填写中心 HTTPS 地址与所有者密码。客户端以本机 Host 持久身份登记，先保存待确认凭据再请求中心；同 ID、同令牌重试复用原记录，显式重新配对才轮换令牌。私有 CA 可在高级设置中填写，不关闭 TLS 或主机名验证。

首次配置分步显示登记、自启动、本机 Host 和客户端连接状态。注册成功后的启动失败保留身份及凭据，可针对失败步骤重试。普通重连不重新启用用户已关闭的自启动；已配置为其他中心/身份时，需显式重新配对，不因浏览另一个中心改写 Host。

设置页分别显示中心认证、服务登记、进程运行、本机就绪及 Host 中心在线状态，并提供启动、停止、重启、自启动与移除服务。关闭客户端窗口不会停止已经运行的 Host。

## 各平台的当前差异

**Linux** 使用 DEB 中的 `/usr/bin/pibot-host` 和 systemd 用户单元，首次配置固定实际 Host home 与 XDG 配置目录，启用 linger。配置文件和服务在用户身份下使用；受限 root helper 只登记调用用户的 UID、Host home 与 XDG 路径，供包升级找到正确目标。

覆盖安装前，DEB 的 preinst 保存用户服务启用和运行状态，再停止服务。安装后为已登记且已配置的 Host 启用并启动用户服务。失败时保留修复依据。安装回退使用原状态快照。卸载移除产品服务，保留用户业务数据与 linger。非默认 `XDG_CONFIG_HOME` 按实际目录登记。 [升级行为](../docs/releasing.md#桌面覆盖升级身份)

**Windows** 当前仍复用受保护的登录任务与原用户 Host home，设置页明确显示“登录后自动运行”。`perMachine` 安装目录、固定 native helper、原所有者和虚拟屏凭据校验保留。SCM、专用虚拟服务账户、跨账户 UAC 与用户会话代理仍在[未完成清单](../docs/open-source-release-progress.md)，当前不能在无人登录时启动 Host。

Windows 图形能力只在所属用户交互会话中使用。Host 核心启动不再主动等待 Shower 授权；图形能力在实际需要时申请。设置页保留显式虚拟屏凭据配置。

**macOS** 使用 `PiBot.app/Contents/MacOS/pibot-host` 和用户 LaunchAgent `~/Library/LaunchAgents/io.github.firespoonyz.pibot.host.plist`（`gui/<uid>` 域）。与 Windows 相同，Host 只在用户登录后运行，设置页显示“登录后自动运行”。supervisor 异常退出后由 launchd 按 10 秒节流重启。停止服务时 supervisor 以 0 退出，同时卸载本次会话中的登录项任务，避免启动失败的 Host 被反复拉起；下次启动服务或重新登录时再加载。自启动开关只决定下次登录是否加载登录项，不停止正在运行的 Host。启动服务时，已登记且有效的登录项经 launchd（`bootstrap`/`kickstart`）运行；没有有效登录项，或 launchd 拒绝启动（例如在「系统设置 › 通用 › 登录项」中关闭了 PiBot 的后台运行）时，直接启动启动器并在结果中附带提示。

登录项记录 App 的实际路径。移动或替换 `PiBot.app` 后，设置页提示需要重新启用，点击后按新位置重写并重新加载登录项，原本运行的 Host 从新位置继续运行。从 Gatekeeper 的临时随机位置（App Translocation）运行时拒绝登记，需先把 App 拖到「应用程序」再打开。

macOS 暂不提供 Shower 虚拟屏与 Cua 桌面工具：Host 不注册这些工具，界面也不显示虚拟屏入口。安装包只做 ad-hoc 签名、未经 Apple 公证，首次打开需在「系统设置 › 隐私与安全性」中选择“仍要打开”。每次更新的 ad-hoc 签名不同，Host 访问「文稿」「桌面」等受保护目录的系统授权在更新后可能需要重新允许；Host 自身数据位于 Application Support，不受影响。

卸载时先在设置页「服务诊断与维护」中移除服务，再把 `PiBot.app` 移到废纸篓。Host 与客户端数据保留在下文的数据目录中，需要时手动删除。

## 数据与协议

Tauri 窗口只运行界面。独立 Node broker 处理客户端连接与观察，独立 Host 处理模型、文件和工具；二者分别保存数据。

- 客户端：Tauri `appLocalDataDir/client`；debug 构建可通过 `E_LAUNCHER_DESKTOP_DATA_ROOT` 指定隔离目录。
- 客户端：Tauri `appLocalDataDir/client`（macOS 为 `~/Library/Application Support/io.github.firespoonyz.pibot/client`）；debug 构建可通过 `E_LAUNCHER_DESKTOP_DATA_ROOT` 指定隔离目录。
- Windows Host：默认 `%LOCALAPPDATA%/e-launcher/host-service`。
- Linux Host：默认 `$XDG_CONFIG_HOME/e-launcher/host-service`，未设置时使用 `~/.config/e-launcher/host-service`。
- macOS Host：默认 `~/Library/Application Support/e-launcher/host-service`。
- Host home 可由 `E_LAUNCHER_HOST_HOME` 指定；`config.json` 中已有的实际 `dataRoot` 保留，不因服务升级搬动数据库。
- `secrets.env` 保存设备令牌与独立控制令牌，均不放进命令行、localStorage 或日志。配对前的 `pairing-pending.json` 同样使用私有权限。

中心连接与高级 local/relay 档案分开。中心凭据由原生持久保存并恢复连接；高级档案只保存非秘密信息，令牌在当前会话输入。公开 Host 控制协议保持固定方法表，没有任意 HTTP、文件或提权代理。LIVE 观察、待发送账本与模型任务各自管理，关闭观察不停止 Host。

新消息先持久化排队，再按 Bot 的权威插件集合完成每轮准备、确认和提交。未知发送结果保留原 requestId 供只读对账；不会因断线重连自动重发用户消息。Bot 级停止覆盖主聊及房间/DM 的在途工作，保留历史和取消回执。

## 客户端更新

连接中心后自动检查，持续在线时每 24 小时最多自动检查一次，也可手动检查。只有用户发起才下载。Rust updater 使用原生保存的中心认证，检查同源地址、大小、SHA-256、发布公钥签名及签名中的应用版本。

下载和验签不停止 Host。安装准备经本机认证控制端点暂停新任务准入，并检查真实活动；可等待，也可显式停止后继续。取消准备恢复准入。安装后的服务恢复由 DEB/NSIS 生命周期负责；Windows 完整安装恢复仍未完成验收。

macOS 没有安装器生命周期：安装准备通过后，客户端先用当前启动器停止 Host，再原位替换 `PiBot.app`；随后在自启动开启时刷新登录项，并用新启动器重新启动原本运行的 Host，最后提示重启客户端。停止失败时不替换 App；恢复失败作为提示附在更新结果中，可在设置页重试。DMG 只用于首次安装，中心分发的是 `PiBot.app.tar.gz`（格式 `app`）。

原生命令为 `desktop_update_status/check/download/install/cancel`；界面不提供任意下载 URL 或发布公钥替换入口。正式 updater 公钥由构建环境 `E_LAUNCHER_UPDATER_PUBLIC_KEY` 注入，私钥不进入安装包或中心。未配置签名材料的开发构建不具备官方更新信任。发布步骤见[发布说明](../docs/releasing.md)。

## 服务诊断

从已配对的用户会话运行状态命令。`ready` 只表示本机认证控制接口已响应，中心 Relay 和配置应用状态分别在客户端设置及中心的「设备与 Bot」检查。 [完整诊断步骤](../docs/center-linux-deployment.md#按层定位故障)

```sh
pibot-host status
systemctl --user status e-launcher-host.service
journalctl --user -u e-launcher-host.service -n 50 --no-pager
```

```powershell
& "$env:ProgramFiles\pibot\pibot-host.exe" status
```

```sh
"/Applications/PiBot.app/Contents/MacOS/pibot-host" status
launchctl print "gui/$(id -u)/io.github.firespoonyz.pibot.host"
tail -n 50 "$HOME/Library/Application Support/e-launcher/host-service/logs/host.log"
```

## 构建

使用 CI 的 **Node.js 26.13.0** 与 `rust-toolchain.toml` 固定的 **Rust 1.99.1**。先将该 Node 版本加入 PATH，再从仓库根安装依赖。

```sh
npm ci
npm ci --prefix host-core
```

### Linux amd64

CI 使用 Ubuntu 24.04，桌面构建需要 WebKitGTK 4.1、GTK3、AppIndicator、librsvg、OpenSSL 开发包和本机编译工具。

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf build-essential curl wget file libssl-dev pkg-config
npm run desktop:build -- --bundles deb
```

DEB 通过 `apt` 安装时解析运行依赖，其中包括 WebKitGTK、TigerVNC、轻量 XFCE 桌面、xauth、dbus、xdotool 与 ffmpeg。产物位于 `desktop/build/target/release/bundle/deb/`。

### Windows x64

CI 使用 Windows Server 2022 runner。源码构建使用 MSVC x64 Rust 工具链、Visual Studio C++ Build Tools 与 Windows SDK。Shower 组件使用 .NET Framework 4.8 提供的 `Framework64\csc.exe`，GUI 运行使用 WebView2。

```powershell
npm run desktop:build -- --bundles nsis
```

产物位于 `desktop/build/target/release/bundle/nsis/`。资源准备会打包固定 Node、Host、npm、原生工具、rg/fd、内置技能与许可。普通开发包可用默认构建流程，正式更新签名见发布说明。 [桌面 CI](../.github/workflows/desktop.yml) · [发布说明](../docs/releasing.md)

### macOS Apple Silicon

CI 使用 `macos-14`（Apple Silicon）runner。本机构建需要 Xcode 或 Command Line Tools；资源准备会下载固定的 Node `darwin-arm64` 与 rg/fd，并编译 `pibot-host`。macOS 不打包 Cua 驱动与 Shower 组件。

```sh
npm run desktop:build -- --bundles app,dmg
```

产物位于 `desktop/build/target/release/bundle/macos/PiBot.app` 和 `bundle/dmg/`；正式构建（`createUpdaterArtifacts`）另生成 `bundle/macos/PiBot.app.tar.gz` 与 `.sig`。`src-tauri/tauri.macos.conf.json` 只在 macOS 上设定 bundle identifier `io.github.firespoonyz.pibot`、产品名 `PiBot`、最低系统版本 13.5（与 Node 26 官方二进制一致）、ad-hoc 签名并关闭 hardened runtime。日后改用 Developer ID 和公证时，需要启用 hardened runtime，为 `pibot-node` 配置 JIT 所需 entitlements，并对 `host-runtime` 内的可执行文件签名。

## 历史验收范围

2026-11-06 的隔离验收中，Windows 实际运行了 debug GUI、原生配对、Host、模型搜索工具、更新检查、认证下载、验签、下载取消，以及安装维护门的等待/停止/恢复。Linux 在本机运行 Host 和真实模型，在独立 systemd 容器运行安装版 GUI，并执行 DEB 安装、升级、自启动状态保留、无 GUI 用户 manager 重启、失败阻断与修复流程。

Windows SCM/跨账户安装恢复、完整 Windows 安装器升级循环、物理机整机重启与长期运行仍未验收。详细结果、数据保留及收尾清理状态见[进度记录](../docs/open-source-release-progress.md)。

2026-11-10 在 Apple Silicon Mac（macOS 26.6.2）本机隔离验证：以固定工具链构建 `PiBot.app`、DMG、更新包与临时密钥签名，`codesign --verify --deep --strict` 通过；经 `open` 启动构建目录中的 App，出现 1200×820 主窗口，界面请求拉起 Node broker 并创建客户端数据库（缺少录屏权限，未截取界面画面）。另用测试专用标签与临时 Host home 实测 LaunchAgent 的登记、launchd 启动、崩溃后重启、正常停止不重启、`kickstart`、关闭自启动、移动 App 后检测失效与一键修复、移除登记。当时没有可用中心，未验证真实配对、Host 就绪与中心在线、应用内更新安装、整机注销/重启后的登录自启动。
