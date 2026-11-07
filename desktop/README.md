# pibot 桌面客户端（Windows / Linux x64）

产品版本 **1.1.0**。当前实现和三端验收范围见[发布进度](../docs/open-source-release-progress.md)。本文描述当前行为；旧 M17/M20 模块记录保留在 Git 历史与[架构进度](../docs/next-generation-architecture.md)，不作为本版本安装与更新已完成的证明。

## 首次连接

安装后打开客户端，填写中心 HTTPS 地址与所有者密码。客户端以本机 Host 持久身份登记，先保存待确认凭据再请求中心；同 ID、同令牌重试复用原记录，显式重新配对才轮换令牌。私有 CA 可在高级设置中填写，不关闭 TLS 或主机名验证。

首次配置分步显示登记、自启动、本机 Host 和客户端连接状态。注册成功后的启动失败保留身份及凭据，可针对失败步骤重试。普通重连不重新启用用户已关闭的自启动；已配置为其他中心/身份时，需显式重新配对，不因浏览另一个中心改写 Host。

设置页分别显示中心认证、服务登记、进程运行、本机就绪及 Host 中心在线状态，并提供启动、停止、重启、自启动与移除服务。关闭客户端窗口不会停止已经运行的 Host。

## 两个平台的当前差异

**Linux** 使用 DEB 中的 `/usr/bin/pibot-host` 和 systemd 用户单元，首次配置固定实际 Host home 与 XDG 配置目录，启用 linger。配置文件和服务在用户身份下使用；受限 root helper 只登记调用用户的 UID、Host home 与 XDG 路径，供包升级找到正确目标。

DEB preinst 保存首次启用/运行快照，停止失败则阻止替换。postinst 恢复原状态，失败保留修复依据；用户关闭的自启动不会被升级开启。卸载停止并移除本产品服务，保留业务数据与 linger。使用非默认 `XDG_CONFIG_HOME` 时，登记的是实际目录。

**Windows** 当前仍复用受保护的登录任务与原用户 Host home，设置页明确显示“登录后自动运行”。`perMachine` 安装目录、固定 native helper、原所有者和虚拟屏凭据校验保留。SCM、专用虚拟服务账户、跨账户 UAC 与用户会话代理仍在[未完成清单](../docs/open-source-release-progress.md)，当前不能在无人登录时启动 Host。

Windows 图形能力只在所属用户交互会话中使用。Host 核心启动不再主动等待 Shower 授权；图形能力在实际需要时申请。设置页保留显式虚拟屏凭据配置。

## 数据与协议

Tauri 窗口只运行界面。独立 Node broker 处理客户端连接与观察，独立 Host 处理模型、文件和工具；二者分别保存数据。

- 客户端：Tauri `appLocalDataDir/client`；debug 构建可通过 `E_LAUNCHER_DESKTOP_DATA_ROOT` 指定隔离目录。
- Windows Host：默认 `%LOCALAPPDATA%/e-launcher/host-service`。
- Linux Host：默认 `$XDG_CONFIG_HOME/e-launcher/host-service`，未设置时使用 `~/.config/e-launcher/host-service`。
- Host home 可由 `E_LAUNCHER_HOST_HOME` 指定；`config.json` 中已有的实际 `dataRoot` 保留，不因服务升级搬动数据库。
- `secrets.env` 保存设备令牌与独立控制令牌，均不放进命令行、localStorage 或日志。配对前的 `pairing-pending.json` 同样使用私有权限。

中心连接与高级 local/relay 档案分开。中心凭据由原生持久保存并恢复连接；高级档案只保存非秘密信息，令牌在当前会话输入。公开 Host 控制协议保持固定方法表，没有任意 HTTP、文件或提权代理。LIVE 观察、待发送账本与模型任务各自管理，关闭观察不停止 Host。

新消息先持久化排队，再按 Bot 的权威插件集合完成每轮准备、确认和提交。未知发送结果保留原 requestId 供只读对账；不会因断线重连自动重发用户消息。Bot 级停止覆盖主聊及房间/DM 的在途工作，保留历史和取消回执。

## 客户端更新

连接中心后自动检查，持续在线时每 24 小时最多自动检查一次，也可手动检查。只有用户发起才下载。Rust updater 使用原生保存的中心认证，检查同源地址、大小、SHA-256、发布公钥签名及签名中的应用版本。

下载和验签不停止 Host。安装准备经本机认证控制端点暂停新任务准入，并检查真实活动；可等待，也可显式停止后继续。取消准备恢复准入。安装后的服务恢复由 DEB/NSIS 生命周期负责；Windows 完整安装恢复仍未完成验收。

原生命令为 `desktop_update_status/check/download/install/cancel`；界面不提供任意下载 URL 或发布公钥替换入口。正式 updater 公钥由构建环境 `E_LAUNCHER_UPDATER_PUBLIC_KEY` 注入，私钥不进入安装包或中心。未配置签名材料的开发构建不具备官方更新信任。发布步骤见[发布说明](../docs/releasing.md)。

## 构建

使用 Node ≥ 22.19 与 `rust-toolchain.toml` 固定的 Rust 1.99.1：

```sh
mise exec node@22.19.0 -- npm ci
mise exec node@22.19.0 -- npm run prepare:pi-main
mise exec node@22.19.0 -- npm ci --prefix host-core
mise exec node@22.19.0 -- npm run desktop:build -- --bundles nsis
# Linux 使用 --bundles deb。
```

Linux 构建需要 WebKitGTK 4.1、GTK3、AppIndicator、librsvg、patchelf、C/C++ 编译链、pkg-config 与 OpenSSL 开发包。DEB 同时声明 sudo、Xvnc、轻量 XFCE 桌面、xauth、dbus、xdotool、ffmpeg 等运行依赖。

资源准备会打包固定 Node、Host、npm、原生工具、rg/fd、内置技能与对应许可。运行时不回退到系统 PATH 或其他 Pi 工具目录。普通开发包不需要正式签名秘密。

安装包位于 `desktop/build/target/release/bundle/nsis/` 或 `desktop/build/target/release/bundle/deb/`；不是 `desktop/src-tauri/target/`。源码开发与安装版的 GUI/Host/权限状态应分别验收。

## 本轮已验证与剩余项

Windows 实际运行了隔离 debug GUI、原生配对、Host、模型搜索工具、更新检查、认证下载、验签、下载取消，以及安装维护门的等待/停止/恢复。Linux 在本机运行 Host 和真实模型，在独立 systemd 容器运行安装版 GUI，并执行 DEB 安装、升级、自启动状态保留、无 GUI 用户 manager 重启、失败阻断与修复流程。

Windows SCM/跨账户安装恢复、完整 Windows 安装器升级循环、物理机整机重启与长期运行仍未验收。详细结果、数据保留及收尾清理状态见[进度记录](../docs/open-source-release-progress.md)。
