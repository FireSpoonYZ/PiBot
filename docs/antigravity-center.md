# Center Antigravity (`agy`) ACP 接入说明

Center 可选接入 Google Antigravity CLI (`agy acp`) 作为服务端统一模型 Provider（Provider ID 为 `antigravity`，模型 API 为 `pibot-antigravity-acp`）。该能力默认未启用，不影响普通 Center 部署或其他模型服务商；所有用户也不必配置 `agy`。

## 架构与隔离边界

- **中心单账号、设备侧执行工具**：`agy` 仅在 Center 进程中运行；Host 工具（文件、Shell、Shower、Vault 等）仍在已配对设备本机执行。Center 在隔离 profile 中生成受限的 `pibot-center` 专用 Agent，并动态注入 `pibot-bridge` MCP server，只暴露当前对话声明的 Host 工具，再通过标准 `toolCall` / `toolResult` 往返设备侧。
- **独立 Profile 隔离**：Center 专用配置/会话目录默认为 `<CENTER_DATA_ROOT>/antigravity/gemini`，专用工作目录为 `<CENTER_DATA_ROOT>/antigravity/workspace`。严禁指向宿主机日常 `~/.gemini`，不得复制或抽取个人 Google token，也不得使用全局 `permissions.deny`。
- **持久化目录**：专用 home 与 `agy` 会话必须位于已有持久数据目录（Docker 为 `/data`，Linux DEB/systemd 为 `/var/lib/pibot-center`）。

## 安装与部署方式

官方安装脚本 `https://antigravity.google/cli/install.sh` 仅支持 `--dir`，不支持固定版本参数。不要让容器在每次启动时自动下载或运行未固定版本的在线安装脚本。推荐以下任一部署方式：

### 方式 1：预构建 Center 镜像 + 只读挂载宿主机 `agy`（推荐）

1. 按宿主机架构查询官方 manifest 核对版本与 SHA-512：
   - `amd64`：`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json`
   - `arm64`：`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json`
2. 下载 manifest 中的 `cli_linux_*.tar.gz`，用 `sha512sum` 校验一致后解压出 `antigravity` 二进制放到宿主机 `/usr/local/bin/agy`（权限 `0755`）。
3. 在 [`compose.yaml`](../compose.yaml) 的 `center.volumes` 中取消注释只读挂载：

```yaml
volumes:
  - center-data:/data
  - /usr/local/bin/agy:/usr/local/bin/agy:ro
```

### 方式 2：源码构建可选内置 `agy` 的 Center 镜像

[`Dockerfile`](../Dockerfile) 提供默认关闭的可选构建参数 `INSTALL_AGY=false`。需要内置时显式传入 `INSTALL_AGY=true`（构建阶段会按固定的 `AGY_VERSION=1.5.9` 与官方 manifest URL/SHA-512 校验安装包，支持 `amd64` 与 `arm64`）：

```sh
sh scripts/center-build.sh --build-arg INSTALL_AGY=true
```

### 方式 3：Linux DEB / systemd (`pibot-center.service`)

[`center-server/linux/pibot-center.service`](../center-server/linux/pibot-center.service) 的 `PATH` 已包含 `/usr/local/bin`，且通过 `EnvironmentFile=-/etc/pibot-center/center.env` 读取配置、`HOME` 与 `CENTER_DATA_ROOT` 均指向 `/var/lib/pibot-center`。将已校验的官方 `agy` 放至 `/usr/local/bin/agy`（或通过 `/etc/pibot-center/center.env` 指定 `PIBOT_AGY_BIN`）即可，无需修改 unit 文件。

## 环境变量与数据路径

除现有 `CENTER_*` 变量外，目前仅提供两个可选环境变量（均可在 `center.env` 或 `/etc/pibot-center/center.env` 中配置，见 [`center.env.example`](../center.env.example)）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PIBOT_AGY_BIN` | `agy` | `agy` 可执行文件名称或绝对路径 |
| `PIBOT_AGY_HOME` | `<CENTER_DATA_ROOT>/antigravity/gemini` | 可选覆盖专用 `--gemini-dir`；不得设为个人日常 `~/.gemini` |

目录结构（以默认 `CENTER_DATA_ROOT` 为例）：

- Docker 持久目录：`/data/antigravity/gemini`、`/data/antigravity/workspace`
- Linux DEB 持久目录：`/var/lib/pibot-center/antigravity/gemini`、`/var/lib/pibot-center/antigravity/workspace`

> **Center 服务进程网络代理**：`agy` 由 Center 服务进程直接拉起，不会继承其他交互终端的临时代理变量。若网络环境需要代理访问 Google 授权或模型服务，请将代理环境变量（例如 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`）直接写入 Center 的实际服务运行环境（Docker 的 `center.env` / 容器环境，或 Linux systemd 的 `/etc/pibot-center/center.env`）；只有服务进程与有效出口网络代理一致时，Center 的 `validate` 与模型刷新才能正常联通。

## 中心网页登录、既有缓存复用与启用 Provider

1. **自动识别既有登录缓存**：同一系统用户若本机已登录过 `agy`，即便使用全新 `PIBOT_AGY_HOME`，Center 启动及 `GET /api/providers/antigravity/auth-status` 也会自动复用官方 CLI 登录缓存，无需强制 SSH 或重新执行终端登录。不同系统用户或独立容器则需具备各自服务用户可访问的登录缓存。
2. **中心网页授权主流程（手动登录 / 重新授权）**：
   - 在 Center 管理页「服务商与模型」中选择 **Antigravity (Center agy)**；若未检测到可用缓存或需要更换账号/重新授权，直接点击网页登录入口（调用既有 `POST /api/providers/antigravity/login`）。
   - 在浏览器打开页面提供的 Google 官方授权链接完成同意，将跳转后的**完整回调 URL 或授权码**粘贴到网页表单提交（`POST /api/providers/antigravity/login/:flowId/answer`），即可由 Center 传入 `agy --login` 完成授权；过程中也可随时点击取消（`POST /api/providers/antigravity/login/:flowId/cancel`）。
   - 官方 `agy` CLI 自行掌管凭据与系统共享 keyring，Center Node 仅中转官方授权链接与用户输入、不触碰或复制 token，也不提供从网页清除系统共享 CLI keyring 的入口。
3. **自动更新目录与启用切换**：登录完成（或复用既有缓存）后，模型目录会自动同步并可直接在「服务商与模型」验证/启用；随后在「设备与 Bot」页为全局默认或指定 Bot 选择 `antigravity/<modelId>` 及对应思考强度（`thinkingLevel`），可用型号与强度由 ACP 返回目录决定，不在代码中写死。
4. **终端命令登录（仅无浏览器环境或排查时备用）**：

   若需以服务用户直接在终端初始化或排查缓存，请以实际运行 Center 的服务用户执行（切勿用 `root` 写入持久目录导致服务用户无权读取）：

   - **Docker（服务用户 `node`）**：

```sh
docker compose exec -it -u node center agy acp --gemini-dir /data/antigravity/gemini --login
```

   - **Linux DEB / systemd（服务用户 `pibot-center`）**：

```sh
sudo -u pibot-center HOME=/var/lib/pibot-center \
  agy acp --gemini-dir /var/lib/pibot-center/antigravity/gemini --login
```

   若配置了自定义 `PIBOT_AGY_HOME`，将 `--gemini-dir` 替换为对应路径，并确保目录归属服务用户（权限 `0700`）。

## 可重复 E2E 验证与验证范围

仓库提供两个真实链路验证脚本，均要求 `PIBOT_AGY_HOME` 指向已独立登录的专用 gemini 目录（脚本拒绝使用日常 `~/.gemini`，且永不删除外部 `PIBOT_AGY_HOME`）：

### 1. ACP/MCP 服务层往返验证（[`scripts/verify-antigravity-acp.mjs`](../scripts/verify-antigravity-acp.mjs)）

```sh
PIBOT_AGY_HOME=/path/to/dedicated-gemini \
PIBOT_AGY_BIN=/usr/local/bin/agy \
  node scripts/verify-antigravity-acp.mjs
```

- **验证范围**：直接调用 `center-server/antigravity/index.js` 的 `openAntigravity`，使用真实 `agy` 与真实 Host `read` 工具（读取仓库外临时随机文件），验证 `catalog`、两轮上下文记忆、同会话模型与支持强度切换并保留旧记忆、MCP `pibot-bridge` 到 Host `read` 工具执行唯一位置、内置工具限制探测（仅声明 Host `read` 时不得通过原生 `run_command`/`write_file` 在 Center workspace 写入 sentinel），以及 `cancel({ deviceId, sessionId })` 取消。
- **未覆盖范围**：不启动 Center HTTP 服务、管理 API 或 Host Provider。

### 2. Center HTTP + Host Provider 工具往返验证（[`scripts/verify-antigravity-center.mjs`](../scripts/verify-antigravity-center.mjs)）

```sh
PIBOT_AGY_HOME=/path/to/dedicated-gemini \
PIBOT_AGY_BIN=/usr/local/bin/agy \
  node scripts/verify-antigravity-center.mjs
```

- **前置条件**：已安装根目录、`host-core` 与 `center-server` 依赖，本机可执行 `agy`，且 `PIBOT_AGY_HOME` 已完成专用 profile 登录；可选仅用于验证脚本的超时覆盖环境变量 `PIBOT_AGY_TIMEOUT_MS`（正整数毫秒，非 Center 运行时环境变量）。
- **验证范围**：**Center HTTP + Host Provider 工具往返**——使用临时 `dataRoot` 启动真实 `openCenterServer`、`openHost`、`connectCenter` 与未修改的 `applyCenterModels`，走完真实 Owner 登录（`/api/session` + CSRF）、设备注册（`POST /api/devices`）、Provider 启用与 `discover`/`validate`、Bot 模型分配（`PUT /api/devices/:deviceId/bots/:botId/model-config`），以及 `Host Provider -> 真实 Center /api/host/antigravity/stream -> 真实 agy -> 标准 toolCall -> Host read 工具 -> toolResult -> 最终回答` 完整循环与 `/api/host/antigravity/cancel` 取消。
- **未覆盖范围**：脚本未启动完整 `pi-durable` Harness（完整 Agent 会话持久化/调度壳）与反向代理 TLS/WSS 终端，也不覆盖 Web 管理页 UI 交互。

### 3. Center Web-Auth 授权链路验证（[`scripts/verify-antigravity-auth.mjs`](../scripts/verify-antigravity-auth.mjs)）

```sh
# 默认复用当前服务用户已有 agy 缓存（或在提供非 ~/.gemini 隔离目录时使用 PIBOT_AGY_HOME）
node scripts/verify-antigravity-auth.mjs
```

- **前置条件**：已安装根目录与 `center-server` 依赖，本机可执行 `agy` 且当前运行用户在当前网络/代理环境下已完成过 `agy` 登录（脚本会先通过 `/api/providers/antigravity/auth-status` 核查缓存，若未检测到缓存将清晰报前置条件失败）；如传 `PIBOT_AGY_HOME`，脚本会拒绝指向 `~/.gemini` 且永不删除外部目录。
- **验证范围**：使用真实 `openCenterServer` 与真实 `agy`，验证已有缓存自动识别（`auth-status` 返回 `method: 'oauth'`）、显式发起登录获取官方 Google `auth_url` 与 `manual_code` 表单提示、空值/超长输入边界拒绝（HTTP 400 且不提交给上游）、单次固定无效授权码触发 `failed` 状态且错误信息不回显授权码或日志/token 原文、发起登录后取消（`/cancel` -> `cancelled`），以及失败与取消后既有缓存与目录（`auth-status` / `validate` / `discover`）仍保持可用。
- **未覆盖范围**：Google 页面人工账号同意及输入真实有效授权码完成 OAuth 换取凭据不作自动化，因此该脚本不宣称端到端完整真实 OAuth 成功登录，仅覆盖授权链接生成、输入校验、无效失败、取消及既有缓存复用能力。

## 版本与已知限制

- 当前针对 `agy 1.5.9` 仅实测过 `--version`、`--help` 及未登录独立 profile 返回 `Authentication required`，支持 `--agent`、`--gemini-dir`、`--app-data-dir`；尚无其他 `1.5.9` 功能实测限制可宣称。
- 历史 `agy 1.5.2` / `1.5.3` 中存在自定义 Agent 与 `/compact` 的历史已知回归问题，现阶段仅作为 `1.5.9` 后续验收需核查项记录，不表示已在 `1.5.9` 复现。
- `agy` 常规运行可能触发后台自更新逻辑；在只读挂载 `/usr/local/bin/agy` 的容器中二进制不可写入，需由宿主机统一更新镜像外挂载文件或重新构建镜像。
