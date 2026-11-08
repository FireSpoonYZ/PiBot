<p align="center">
  <a href="assets/logo.png"><img src="assets/icon.png" alt="PiBot" width="108" height="108"></a>
</p>

<h1 align="center">PiBot</h1>

<p align="center">
  <strong>自托管的多端 AI 助手与 Agent 协同平台（Windows · Linux · Android）</strong>
</p>

---

## 简介

**PiBot** 采用「**中心管控 + 设备本地执行**」架构：

- **中心服务器（Center）**：通过 Docker 自托管，集中管理模型服务商与 API 凭据、设备与 Bot、MCP / Skill / 插件、Hermes 自学习、Webhook 自动任务以及客户端版本分发。
- **多端节点（Host & Client）**：运行在 Windows、Linux 与 Android 设备上。模型工具调用、文件读写、命令执行、隔离虚拟屏（Shower）以及会话数据全部保存在对应设备本地；客户端既能管理本机 Bot，也能跨设备协同工作。

```mermaid
flowchart LR
  subgraph Center["中心服务器 (Docker)"]
    CW["管理后台 / API / Relay (/v1/link)"]
  end

  subgraph Win["Windows 节点"]
    WC["桌面客户端 (pibot)"]
    WH["后台服务 (pibot-host + Shower)"]
  end

  subgraph Lin["Linux 节点"]
    LC["桌面客户端 (pibot)"]
    LH["systemd 用户服务 (pibot-host + Xvnc)"]
  end

  subgraph And["Android 节点"]
    AC["Tauri 客户端 + 桌面 Widget + 语音"]
    AH["Node Mobile Host + Shower (Shizuku)"]
  end

  CW <-->|HTTPS / WSS| WH
  CW <-->|HTTPS / WSS| LH
  CW <-->|HTTPS / WSS| AH
  WC <--> CW
  LC <--> CW
  AC <--> CW
```

### 核心特性

- **本地工具与隐私边界**：每台设备的 Bot 绑定本地真实工作目录，内置固定版本的 `rg` / `fd` 搜索与运行时环境，敏感凭据由系统加密存储或私有权限文件保护，不进入命令行或明文日志。
- **后台常驻执行**：桌面端关闭窗口不中断已受理任务（Linux 基于 `systemd --user` + `linger`，Windows 基于受保护的登录自启动任务）；Android 在独立进程运行 UI，由前台服务托管 Node Mobile 子进程。
- **Bot 看板与跨机群聊**：桌面与移动端共用「Bot 看板」，汇总所有设备的*需要你（问卷/失败）*、*工作中*、*待查看*与*空闲*状态；支持跨设备 Room 群聊协同与 Bot 私聊审阅。
- **Shower 隔离虚拟屏**：按会话提供独立虚拟显示空间与 GUI 自动化能力（Linux 私有 Xvnc + 轻量桌面，Windows 交互会话桌面，Android 基于 Shizuku 的虚拟屏）。
- **Hermes 学习与 Webhook**：支持后台自动回顾会话沉淀 Skill，并提供带幂等校验（`Idempotency-Key`）的通用 JSON Webhook 入口，轻松对接 n8n、CI 或外部自动化脚本。

---

## 部署指南

### 1. 使用 AI Agent 一键部署与连接（推荐）

将以下 Prompt 复制给你的本地 AI Agent（如 Claude Code、Codex、Cursor 等），Agent 会先与你确认中心部署位置，随后自动完成**中心服务器 Docker 部署、本机客户端安装及配对连接**：

````markdown
请帮我部署 PiBot 中心服务器，并在本机安装客户端连接到该中心。请严格按以下步骤执行：

### 第 0 步：先向我询问确认以下信息（未确认前不要执行后续命令）
1. **中心服务器部署位置**：部署在**本机**，还是**其他远程 Linux 服务器**？（若为远程服务器，请询问 SSH 连接信息）
2. **中心对外 HTTPS 地址**（`CENTER_PUBLIC_URL`，必须是形如 `https://bot.example.com` 的根 origin，不带子路径）
3. **HTTPS 接入方式**：使用仓库自带的 Caddy 自动申请证书（需 80/443 端口），还是我已有反向代理（仅暴露本地 `127.0.0.1:8080`）？
4. **中心所有者密码**（至少 12 位字符）

---

### 第 1 步：Docker 部署并初始化中心服务器
在目标中心服务器上创建工作目录（如 `~/pibot-center`），从 GitHub Release（`https://github.com/FireSpoonYZ/PiBot/releases/latest`）下载部署文件并启动：

1. 下载 `compose.yaml`、`compose.https.yaml`、`Caddyfile` 和 `center.env.example`：
   ```sh
   umask 077
   curl -fsSLO https://github.com/FireSpoonYZ/PiBot/releases/latest/download/compose.yaml
   curl -fsSLO https://github.com/FireSpoonYZ/PiBot/releases/latest/download/compose.https.yaml
   curl -fsSLO https://github.com/FireSpoonYZ/PiBot/releases/latest/download/Caddyfile
   curl -fsSLO https://github.com/FireSpoonYZ/PiBot/releases/latest/download/center.env.example
   cp center.env.example center.env
   ```
2. 将 `center.env` 中的 `CENTER_PUBLIC_URL` 修改为确认的 HTTPS 地址。
3. 启动容器：
   - 使用自带 Caddy 自动 HTTPS：`docker compose -f compose.yaml -f compose.https.yaml up -d`
   - 使用自有反向代理：`docker compose up -d`（中心内部 HTTP、API、SSE 与 `/v1/link` 共用 `127.0.0.1:8080`）
4. 自动完成首次初始化：
   - 轮询 `curl -fsS http://127.0.0.1:8080/api/health` 直至返回 `{"status":"setup"}`。
   - 读取一次性初始化码：`SETUP_TOKEN=$(docker compose exec -T center cat /data/center-setup-token)`。
   - 调用初始化接口完成配置：
     ```sh
     curl -fsS -X POST http://127.0.0.1:8080/api/setup \
       -H "Content-Type: application/json" \
       -d "{\"setupToken\":\"$SETUP_TOKEN\",\"ownerPassword\":\"<所有者密码>\",\"publicUrl\":\"<CENTER_PUBLIC_URL>\"}"
     ```
   - 再次检查 `curl -fsS http://127.0.0.1:8080/api/health`，确认返回 `{"status":"ready"}`。

---

### 第 2 步：下载并安装本机桌面客户端
识别当前本机操作系统，通过 GitHub API（`https://api.github.com/repos/FireSpoonYZ/PiBot/releases/latest`）获取最新发布的安装包下载链接并安装：

- **Linux (Debian / Ubuntu amd64)**：
  下载 `PiBot-<version>-linux-amd64.deb` 并执行：
  ```sh
  sudo apt install -y ./PiBot-*-linux-amd64.deb
  ```
- **Windows (x64)**：
  下载 `PiBot-<version>-windows-x64-setup.exe` 并运行安装器完成安装（默认安装路径为 `C:\Program Files\pibot\`）。

---

### 第 3 步：配对本机 Host 服务并连接桌面客户端
1. 使用安装好的 `pibot-host`（Linux 为 `/usr/bin/pibot-host`，Windows 为 `C:\Program Files\pibot\pibot-host.exe`），通过 stdin 传入所有者密码完成配对（不要把密码写进命令行参数）：
   - Linux / macOS:
     ```sh
     PAIR_JSON=$(printf '%s\n' "<所有者密码>" | pibot-host pair --center-url "<CENTER_PUBLIC_URL>")
     pibot-host enable
     pibot-host start
     pibot-host status
     ```
   - Windows (PowerShell):
     ```powershell
     $PairJson = "<所有者密码>" | & "$env:ProgramFiles\pibot\pibot-host.exe" pair --center-url "<CENTER_PUBLIC_URL>"
     & "$env:ProgramFiles\pibot\pibot-host.exe" enable
     & "$env:ProgramFiles\pibot\pibot-host.exe" start
     & "$env:ProgramFiles\pibot\pibot-host.exe" status
     ```
2. 从 `pair` 返回的 JSON 中提取 `centerUrl`、`deviceId`、`deviceToken`，写入桌面客户端凭据文件（权限 `0600`），使打开桌面 GUI 时自动连接：
   - Linux 路径：`~/.local/share/com.example.launcherprobe.desktop/client/center-credentials.json`
   - Windows 路径：`%LOCALAPPDATA%\com.example.launcherprobe.desktop\client\center-credentials.json`
   - JSON 内容：`{"url":"<centerUrl>","deviceId":"<deviceId>","deviceToken":"<deviceToken>","ca":""}`
3. 最后验证 `pibot-host status` 中 `configured`、`running`、`ready` 均为 `true`，并告知我可以打开客户端及中心网页配置模型。
````

---

### 2. 手动部署中心服务器（Docker）

中心管理页、API、SSE 事件流与 `/v1/link` 共用容器内部 HTTP `8080` 端口；对外只需提供一个 HTTPS origin，WebSocket 地址自动推导为 `wss://<host>/v1/link`。

#### 第一步：下载 Compose 配置并设置域名

从 [GitHub Releases](https://github.com/FireSpoonYZ/PiBot/releases/latest) 下载 `compose.yaml`、`compose.https.yaml`、`Caddyfile` 与 `center.env.example`（或直接克隆本仓库）：

```sh
umask 077
cp center.env.example center.env
# 编辑 center.env，填写对外 HTTPS 根地址（不含路径后缀）：
# CENTER_PUBLIC_URL=https://center.example.com
```

#### 第二步：启动容器

- **方式 A：使用内置 Caddy 自动签发 HTTPS（推荐独立服务器使用）**
  ```sh
  docker compose -f compose.yaml -f compose.https.yaml up -d
  ```
- **方式 B：使用已有反向代理（Nginx / Traefik / Cloudflare Tunnel 等）**
  ```sh
  docker compose up -d
  ```
  默认仅向宿主机回环发布 `127.0.0.1:8080`。在你的反向代理中将所有路径转发至 `http://127.0.0.1:8080`，保留 `Host` 头，为 `/v1/link` 开启 WebSocket `Upgrade`，并为 SSE 关闭代理缓冲（完整 Nginx 配置、备份与迁移说明见 [Linux 中心部署文档](docs/center-linux-deployment.md)）。

#### 第三步：首次初始化

1. 查看一次性初始化码：
   ```sh
   docker compose logs center
   ```
2. 浏览器打开 `CENTER_PUBLIC_URL`，填入日志中的初始化码并设置**所有者密码**（至少 12 位字符）。
3. 登录中心管理后台，在「模型与凭据」中登记模型服务商（Provider）、API Key 与可用模型。

---

### 3. 安装客户端（NSIS / DEB / APK）

前往 [GitHub Releases](https://github.com/FireSpoonYZ/PiBot/releases/latest) 下载对应平台的安装包：

| 平台 | 安装包格式 | 文件名示例 |
| --- | --- | --- |
| **Windows (x64)** | NSIS (`.exe`) | `PiBot-<version>-windows-x64-setup.exe` |
| **Linux (Debian / Ubuntu amd64)** | DEB (`.deb`) | `PiBot-<version>-linux-amd64.deb` |
| **Android (ARM64, Android 13+)** | APK (`.apk`) | `PiBot-<version>-android-arm64.apk` |

#### Windows（NSIS 安装包）

1. 下载并运行 `PiBot-<version>-windows-x64-setup.exe`（需要管理员权限，安装至 `C:\Program Files\pibot\`）。
2. 安装器会同时部署桌面客户端 `pibot.exe`、后台启动器 `pibot-host.exe` 与原生虚拟屏组件，并为当前用户注册受保护的登录自启动任务。
3. 打开 **PiBot**，输入**中心 HTTPS 地址**与**所有者密码**即可一键完成本机设备注册、Host 启动与客户端连接。关闭客户端窗口不会停止后台正在运行的 Host 任务。

#### Linux（DEB 安装包）

1. 使用 `apt` 安装以自动解析并安装所需运行依赖（WebKitGTK 4.1、TigerVNC、轻量 XFCE、ffmpeg 等）：
   ```sh
   sudo apt update
   sudo apt install ./PiBot-*-linux-amd64.deb
   ```
2. 安装后可通过应用菜单启动 **PiBot**（命令 `pibot`），后台服务由 `pibot-host` 与 `systemd --user`（`e-launcher-host.service`）管理。
3. 打开客户端填写中心地址与所有者密码完成首次配对，系统会自动配置用户服务与 `linger` 开机常驻。后续通过 `apt` 覆盖升级 DEB 包时，安装脚本会自动保存并恢复服务运行状态。

#### Android（APK 安装包）

1. 在手机上直接下载安装 `PiBot-<version>-android-arm64.apk`，或通过 ADB 覆盖安装：
   ```sh
   adb install -r PiBot-*-android-arm64.apk
   ```
2. 打开应用，填入中心地址与所有者密码完成绑定。
3. **可选能力**：
   - **桌面 Widget**：在系统桌面添加任务小组件，实时查看任务状态并一键跳转会话或语音。
   - **Shower 虚拟屏**：在客户端引导页配合 **Shizuku** 完成授权，即可为 Bot 启用独立虚拟屏操作能力。

<details>
<summary>附：旧版 Android 覆盖升级后的系统导航栏恢复说明</summary>

仅当从早期桌面版升级且存在 `gestures.pending_restore=true` 标记时，应用会在启动时尝试将 `Settings.Global.force_fsg_nav_bar` 恢复为 `0`。若权限不足，可在设置页使用救援入口或通过 ADB 恢复：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial = '<已授权设备序列号>'
& $adb -s $serial shell pm grant com.example.launcherprobe android.permission.WRITE_SECURE_SETTINGS
& $adb -s $serial shell settings put global force_fsg_nav_bar 0
& $adb -s $serial shell settings get global force_fsg_nav_bar
& $adb -s $serial shell am start -a android.settings.SETTINGS
```
</details>

---

## 文档导航

| 主题 | 文档链接 | 说明 |
| --- | --- | --- |
| **中心服务器部署** | [docs/center-linux-deployment.md](docs/center-linux-deployment.md) | Docker Compose、Nginx 反代配置、数据备份与版本升级 |
| **桌面客户端** | [desktop/README.md](desktop/README.md) | Windows / Linux 客户端架构、服务生命周期、数据目录与自动更新 |
| **Android 客户端** | [mobile/README.md](mobile/README.md) | Android 双进程架构、原生桥、远端设备控制、语音与构建细节 |
| **Bot 管理与自学习** | [docs/bot-management-learning.md](docs/bot-management-learning.md) | 模型分配、受管 Skill / MCP / 插件与 Hermes 后台学习机制 |
| **Webhook 自动任务** | [docs/webhooks.md](docs/webhooks.md) | Bearer 入口创建、幂等键要求、n8n / curl 触发示例与事件生命周期 |
| **Shower 虚拟屏** | [docs/shower-cross-platform.md](docs/shower-cross-platform.md) | Windows / Linux / Android 跨平台虚拟屏原理与权限配置 |
| **发布与版本管理** | [docs/releasing.md](docs/releasing.md) | 版本校验、签名配置、CI 发布流水线与中心客户端分发元数据 |

---

## 目录结构与源码构建

### 目录职责

| 目录 | 职责 |
| --- | --- |
| [`center-server/`](center-server/)、[`center-web/`](center-web/)、[`center-contract/`](center-contract/) | 中心服务端、管理后台前端与共享协议契约 |
| [`host-core/`](host-core/) | 多端通用 Host 核心、客户端 Broker、工具集、受管能力与固定 Pi SDK 集成 |
| [`desktop/`](desktop/) | Windows / Linux Tauri 桌面客户端、`pibot-host` 启动器与 NSIS / DEB 安装包钩子 |
| [`mobile/`](mobile/)、[`web/src/`](web/src/) | Android Tauri 外壳与多端共享 React / TypeScript 界面 |
| [`app/src/main/`](app/src/main/)、[`shower-server/`](shower-server/) | Android 原生桥接、生命周期服务、任务 Widget、语音与虚拟屏服务 |
| [`plugins/`](plugins/) | 内置与受管插件（如 Billion Context 等） |
| [`scripts/`](scripts/)、[`docs/`](docs/) | 构建准备脚本、发布校验工具与专题文档 |

### 从源码构建

**环境要求**：Node.js ≥ 22.19（推荐通过 `mise` 管理）、Rust `1.99.1`（由 [`rust-toolchain.toml`](rust-toolchain.toml) 固定）。构建 Android 还需 JDK 21、Android SDK Platform 36、NDK `28.2.13676358` 与 CMake `3.22.1`。

#### 中心与桌面端（Windows NSIS / Linux DEB）

```sh
mise exec node@22.19.0 -- npm ci
mise exec node@22.19.0 -- npm ci --prefix host-core
mise exec node@22.19.0 -- npm run center:build
mise exec node@22.19.0 -- npm run desktop:build -- --bundles nsis
# Linux 打包 DEB 使用：
# mise exec node@22.19.0 -- npm run desktop:build -- --bundles deb
```

构建产物位于 `desktop/build/target/release/bundle/nsis/` 或 `desktop/build/target/release/bundle/deb/`。

#### Android 客户端（APK）

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"
rustup target add --toolchain 1.99.1 aarch64-linux-android x86_64-linux-android
mise exec node@22.19.0 -- .\gradlew.bat :app:assembleDebug --no-daemon --console=plain
```

默认构建 `arm64-v8a`（模拟器可加 `-PlauncherAbis=x86_64`），产物位于 `app/build/outputs/apk/debug/app-debug.apk`。

---

## 许可证

本项目基于 [AGPL-3.0](LICENSE) 许可证开源。Operit Shower 的 LGPL 派生源码及随包分发的第三方组件许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [`licenses/`](licenses/)。
