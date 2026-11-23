# Center Antigravity (`agy`) ACP 接入说明

Center 可选接入 Google Antigravity CLI (`agy acp`) 作为服务端统一模型 Provider（Provider ID 为 `antigravity-acp`，模型 API 为 `pibot-antigravity-acp`）。该能力默认未启用，不影响普通 Center 部署或其他模型服务商；所有用户也不必配置 `agy`。

## 架构与隔离边界

- **中心单账号、设备侧执行工具**：`agy` 仅在 Center 进程中运行；Host 工具（文件、Shell、Shower、Vault 等）仍在已配对设备本机执行。Center 在隔离 profile 中生成受限的 `pibot-center` 专用 Agent，并动态注入 `pibot-bridge` MCP server，只暴露当前对话声明的 Host 工具，再通过标准 `toolCall` / `toolResult` 往返设备侧。
- **仅 Code Mode**：Pi 的顶层工具声明不含独立 `tool_search`。用 `codemode` 内的 `searchTools()`、`describeTool()` 与 `tools.*` 按需执行，不改变当前 ACP prompt 的工具表。MCP 桥复用 Host 的最终 ACP 声明，包括仅由桥处理的 `bridge_poll_result`；仍兼容未声明轮询工具的旧 Host。
- **原生资源发现**由 `PreToolUse` 在执行前拒绝。Center 只在当前轮的 `list_resources` 调用 ID 同时收到已认证的拒绝回执和 ACP `failed` 事件时继续回答，否则按工具隔离错误处理。
- **独立 Profile 隔离**：Center 专用配置/会话目录默认为 `<CENTER_DATA_ROOT>/antigravity/gemini`，专用工作目录为 `<CENTER_DATA_ROOT>/antigravity/workspace`。严禁指向宿主机日常 `~/.gemini`，不得复制或抽取个人 Google token，也不得使用全局 `permissions.deny`。
- **持久化目录**：专用 home 与 `agy` 会话必须位于已有持久数据目录（Docker 为 `/data`，Linux DEB/systemd 为 `/var/lib/pibot-center`）。
- **轮级路由与辅助上下文传递**：继续沿用现有 JSON `messages` 封包，不新增配置项；ACP 不从旧版 Host 路由文本前缀猜测可信路由元数据，完整路由行为仍要求 Host 与 Center 成对更新。普通人类 `primary` 轮不带合成路由消息；非默认来源/目标由 Host 在插件最终投影头部前插瞬态 `SystemMessage`（`content: ''`、`sections: { 'host-turn-routing': <短说明> }`、`timestamp: 0`，不含其他 section、工具、`requestId` 或原始冻结轮 JSON，永不作为 `user` 消息追加），ACP 从 transcript 提取该 `host-turn-routing` section 并**按轮置于真实本轮输入之前**，独立于会话的有效 system prompt。SOUL 等有效系统指令变化时重建 native 上下文；轮级路由说明不作为持久系统指令参与复用判断。`bcContextMaterial`、`bcSummaryMaterial` 和 Billion Context 提醒继续作为辅助上下文传递。
- **Hindsight 自动召回**由插件在临时请求消息上标记 `hindsightRecall: true`。Center 按 `auxiliaryIndices` 识别来源，通过 AGY `PreInvocation` hook 将当前用户轮的 recall 作为 `ephemeralMessage` 注入，并从普通 ACP prompt 和历史摘要中排除召回文本。同一次 native 推理挂起等待工具时沿用这一轮的绑定，完成或取消后释放。召回为空时发送普通用户轮。AGY 的本地诊断日志仍可能记录注入文本，模型自行引用的内容属于正常模型输出。
- **旧 ACP 会话迁移**：缺少内容检查点的旧绑定不能仅凭消息数量继续复用。Center 以 PiBot 当前有效上下文重建配置了 hook 的 native 会话，保留普通对话中的历史回答、工具调用和结果；工具续接按下文的恢复规则处理。PiBot 会话和记录继续保留。旧版 Hindsight 渲染内容也可在已识别为辅助的消息中按轮提取。

### 上下文一致性与故障恢复

PiBot 每次实际发送的上下文投影是恢复依据。Center 按 `(deviceId, sessionId)` 保存 native 绑定和内容检查点：有效系统提示、工具声明的指纹，以及非 system 消息的内容哈希；除自动 recall 外，当前辅助文本和图片也参与匹配，recall 仍按上述 hook 规则处理。只有已同步内容仍是当前历史的完整前缀，且模型、思考强度、有效系统提示、工具声明与辅助上下文一致时，才复用 native 会话。时间戳、用量等传输信息不影响内容比较；同数量改写、历史缩短和辅助摘要变化会被识别。[上下文快照与回放](../center-server/antigravity/context-sync.ts) · [会话存储](../center-server/antigravity/sessions.ts)

| 场景 | 处理方式 |
| --- | --- |
| 正常追加对话 | 复用已确认的 native 上下文，补充尚未传递的历史；不会仅因 provider 相同而省略未见过的 assistant 回答。 |
| `/clear` | Host 在提交重置记录的同一事务中更换 provider 会话身份；下一轮建立新的 native 绑定。清空当前上下文不删除旧回执或 agy 原生会话文件。 |
| SOUL／系统指令或工具声明变化、编辑历史、Billion Context 压缩或改写 | 旧检查点不再匹配时，从当前有效投影重建 native 上下文，应用最新指令。 |
| 等待工具结果 | 原 ACP turn 仍存活、状态为 `parked`，且上下文、模型和思考强度均相容时，通过 `reentry` 交付结果。Center 重启或原 turn 不可继续时，使用持久化绑定并核对 PiBot 历史中同 ID、同工具名的调用，再重建上下文，包含当前 `toolResult` 的正文和图片。绑定缺失或结果无法配对时明确报错。 |
| 旧 native 会话加载失败 | Driver 在发送 `session/prompt` 前报告加载失败；Center 用完整上下文新建会话，最多安全重试一次。认证、配置或 prompt 阶段的其他错误不走这条自动重建重试路径。 |
| 取消、异常退出或 Host 未承接上次输出 | 不再把旧 native 历史视为已确认上下文；后续请求依据 PiBot 实际保留的历史恢复。 |
| SDK 原生 `/compact` 或自动压缩 | 摘要请求使用独立的 AGY 会话身份和摘要系统指令；身份与持久任务绑定，同一压缩任务重试保持稳定，任务结束后回收临时 driver、MCP 注册和绑定。`max_tokens` 或未知／缺失结束原因即使已有文字也明确失败，不以部分摘要替换原历史。 |

Center 持久化 `ready`、`parked`、`uncertain` 状态及恢复所需的检查点。发送会改变 native 历史的请求前先记录不确定状态；工具挂起时先保存恢复信息，再向 Host 交付工具调用。工具结果必须通过本地 MCP 发送屏障；发送失败或 ACP `tool_error` 都不能确认 `ready`。每次新 native turn 都轮换 MCP 注册，拒绝旧 turn 的迟到调用。存储写入失败会返回错误，不会把未保存的恢复状态当成成功同步。这里只持久化可恢复的数据，进程内等待中的 Promise 和 MCP 连接仍随进程结束；普通会话最多保留 64 个完全空闲的内存 slot，按最近使用顺序回收并保留持久检查点，正在运行或等待工具的会话不参与淘汰。[服务层状态转换](../center-server/antigravity/index.js)

当前对原生 `tool_error` 的保守处理可能中断普通工具错误后的同轮自纠正；真实 agy 对这类错误的映射仍需验收，后续重建保留历史中的工具错误正文和 `isError` 标记。

重建回放覆盖当前投影中的所有 provider 回答、工具调用 ID 和参数、工具结果、错误及历史图片。历史图片按回放中的编号附加；自动 recall 仍遵守上述临时 hook 规则。回放不再默认截断为 8,000 字符，也不会因为普通正文出现 compaction 标记而丢掉前面的记录。完整回放会增加输入 token 和图片传输成本，并受 HTTP／ACP 帧大小、模型上下文等上限约束；超限请求必须显式失败，不能裁掉内容后仍推进检查点。

该机制维护 PiBot 当前有效投影的传递与恢复。agy 会话内部还会记录桥接、资源块、原生推理等事件，两边的原生事件日志不会逐条相同。回放以历史记录的形式提供已完成调用，桥本身不会为重放而再次执行这些调用。本地 MCP 发送完成不等于对端已读取或模型已理解；外部工具副作用是否恰好执行一次，还需要工具自身的幂等与回执机制，不能由一段恢复提示词保证。

### 新旧 Host 流传输契约、升级顺序与旧格式歧义边界

- **新版协议（仅 Antigravity `POST /api/host/antigravity/stream`）**：
  - 新版 Host 除既有 `sessionId`、`modelId`、`messages`（及可选 `reasoning`）外，携带可选顶层字段 `turnContext: { inputIndex: number | null, auxiliaryIndices: number[] }`。
  - 新版 Host 为每个 HTTP 流生成新的 UUID `requestId`，对应取消请求携带同一 ID，防止迟到的旧取消终止下一轮。新版 Center 仍兼容不带 `requestId` 的旧 Host，此时取消按会话生效。
  - `inputIndex` 与 `auxiliaryIndices` 均使用**最终归一化并实际发送的 `messages` 数组下标坐标**：
    - `inputIndex` 指向最后一个非 `system`、非辅助条目消息（允许角色为 `user`、`assistant` 或 `toolResult`）；`null` 表示不存在此类消息（例如仅有 `system`，或仅有 `system` 与辅助条目）。
    - `auxiliaryIndices` 为严格递增且唯一的 `user` 辅助条目索引列表（例如 Billion Context 投影/提醒、Hindsight recall 等由插件/运行时注入的辅助 `user` 消息）。
  - 新版 Host 基于真实运行时与插件阶段来源生成 `turnContext`，**不**依赖 `user` 正文前缀或 `timestamp === 0` 猜测来源；独立调用裸 `createAntigravityProvider`（缺少 Host 来源上下文）时不会伪造猜测的 `turnContext`。
  - **Fail-closed 校验**：Center 在 HTTP 路由与服务层均严格校验 `turnContext`：缺失该字段按老 Host 处理；**一旦提供但存在未知键、类型错误、越界、重复/未排序、`auxiliaryIndices` 指向非 `user`、`inputIndex` 指向 `system` 或与 `auxiliaryIndices` 冲突、或与“最后一个非 `system` 非辅助消息”矛盾时，必须直接拒绝（HTTP 400 `INVALID_ARGUMENT` / 服务层终态 `error`、不启动 ACP driver），绝不降级回旧版启发式猜测**。
  - 当 `messages` 仅有 `system`（或仅有 `system` + 辅助条目，`inputIndex === null`）时，Center 返回错误且不启动 ACP driver。`assistant`/`toolResult` 输入必须已有会话绑定；恢复 `toolResult` 还须在 PiBot 历史中找到之前同 ID、同工具名的调用，不能无条件退回较早的用户输入。
  - SDK 在真实 `user` 或 `toolResult` 之后追加的增量 `SystemMessage`（例如 `sections`、`toolsAdded`、`toolsRemoved`）不会遮蔽真实本轮输入，且其末尾工具变更仍在 `pibot-bridge` MCP server 上完整生效。正常用户轮的当前输入单独进入 prompt；重建工具续接时，当前 `toolResult` 也会进入历史回放。

- **升级顺序要求（必须先升级 Center，再升级 Host，或成对同步升级）**：
  1. **新 Center + 新 Host（推荐）**：完整启用 `turnContext` 显式来源契约与 `requestId` 流级取消，消除旧格式歧义并保留全部工具/会话/隔离能力。
  2. **新 Center + 老 Host（兼容过渡）**：老 Host 请求不含 `turnContext`，新 Center 自动走旧版兼容路径——可正确识别非零时间戳 `user` 与合法图片 `user`（含文图/纯图）后接 SDK 追加的常规 `system`（全部 `system` 工具增删照常生效），且 `toolResult` 后接 `system` 时绝不会错误回退到更早的 `user` 消息。
  3. **老 Center + 新 Host（不兼容，禁止）**：老 Center 对 `POST /api/host/antigravity/stream` 顶层字段执行严格白名单校验，会以 HTTP 400 `INVALID_ARGUMENT` 拒绝其尚不支持的 `turnContext` 或 `requestId`。新版 Host 不会自动去掉 `requestId` 重试；滚动升级时务必先完成 Center 升级并就绪，再升级各设备 Host。
  4. **托管 Billion Context 既有安装升级（`1.0.2` → `1.0.3`）**：Center 启动不会自动覆盖已安装的旧版 Billion Context 插件包，且 Host 按 `targetVersion` 缓存插件版本；因此**已启用托管 Billion Context 的既有安装需在 Center 中显式将 Billion Context 更新到 `1.0.3`**，以获得精确的辅助消息来源。此操作**不需要重建会话或数据库**；**未启用 Billion Context 的部署不需要进行这一操作**。
  5. **托管 Hindsight 既有安装可更新到 `1.2.1`**。新版插件识别当前 Host 的主会话输入并在请求中标记自动召回。构建产物为 `build/builtin-plugins/hindsight.tgz`，通过 Center 的插件更新入口应用。

- **无法消除的旧格式歧义（仅老 Host 过渡期存在）**：
  - 在老 Host（未发送 `turnContext`）的旧线格式中，一条位于既有历史消息之后、无图片块、无 `bcContextMaterial`/`bcSummaryMaterial` 标记且 `timestamp === 0` 的纯文本 `user` 消息，与旧版插件注入的未标记 `timestamp === 0` 合成辅助消息（例如 Hindsight recall 或 Billion Context 尾部 nudge）在传输载荷上可能**完全同形**，Center 无法仅凭旧线格式做到无损区分。
  - 因此老 Host 兼容路径不承诺对“历史之后的无标记 `timestamp === 0` 纯文本 `user`”做无损判别；升级至新版 Host（如启用了托管 Billion Context 则一并在 Center 显式更新到 `1.0.3`）后即可彻底消除该歧义。

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

[`Dockerfile`](../Dockerfile) 提供默认关闭的可选构建参数 `INSTALL_AGY=false`。需要内置时显式传入 `INSTALL_AGY=true`（构建阶段会按固定的 `AGY_VERSION=1.5.12` 与官方 manifest URL/SHA-512 校验安装包，支持 `amd64` 与 `arm64`）：

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

1. **自动识别既有登录缓存**：同一系统用户若本机已登录过 `agy`，即便使用全新 `PIBOT_AGY_HOME`，Center 启动及 `GET /api/providers/antigravity-acp/auth-status` 也会自动复用官方 CLI 登录缓存，无需强制 SSH 或重新执行终端登录。不同系统用户或独立容器则需具备各自服务用户可访问的登录缓存。
2. **中心网页授权主流程（手动登录 / 重新授权）**：
   - 在 Center 管理页「服务商与模型」中选择 **Antigravity (Center agy)**；若未检测到可用缓存或需要更换账号/重新授权，直接点击网页登录入口（调用既有 `POST /api/providers/antigravity-acp/login`）。
   - 在浏览器打开页面提供的 Google 官方授权链接完成同意，将跳转后的**完整回调 URL 或授权码**粘贴到网页表单提交（`POST /api/providers/antigravity-acp/login/:flowId/answer`），即可由 Center 传入 `agy --login` 完成授权；过程中也可随时点击取消（`POST /api/providers/antigravity-acp/login/:flowId/cancel`）。
   - 官方 `agy` CLI 自行掌管凭据与系统共享 keyring，Center Node 仅中转官方授权链接与用户输入、不触碰或复制 token，也不提供从网页清除系统共享 CLI keyring 的入口。
3. **自动更新目录与启用切换**：登录完成（或复用既有缓存）后，模型目录会自动同步并可直接在「服务商与模型」验证/启用；随后在「设备与 Bot」页为全局默认或指定 Bot 选择 `antigravity-acp/<modelId>` 及对应思考强度（`thinkingLevel`）。Center 在选中模型后按该会话的 ACP 档位执行。Gemini 4 Neon 和 Hydrogen 在 AGY 提供 `xhigh` 时使用原生的 Extra 档。
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

## 可重复验证与验证范围

上下文同步回归位于 [`web/test/antigravity-sync.test.mjs`](../web/test/antigravity-sync.test.mjs)，随 `npm test` 执行。它使用真实 Host／Durable／Center 代码与受控 ACP，覆盖清空、SOUL 更新、内容检查点、历史改写与压缩、完整回放、工具等待期间重启、加载失败、取消、响应丢失及存储失败，并检查重复流式增量不会被误当成累计重发而吞掉。受控测试不等同于真实 agy、Google 服务或真实故障时序的端到端验收；测试通过数量以实际运行报告为准。

另有以下真实链路验证脚本。前两个要求 `PIBOT_AGY_HOME` 指向已独立登录的专用 gemini 目录；脚本拒绝使用日常 `~/.gemini`，且永不删除外部 `PIBOT_AGY_HOME`。

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

- **前置条件**：已安装根目录与 `center-server` 依赖，本机可执行 `agy` 且当前运行用户在当前网络/代理环境下已完成过 `agy` 登录（脚本会先通过 `/api/providers/antigravity-acp/auth-status` 核查缓存，若未检测到缓存将清晰报前置条件失败）；如传 `PIBOT_AGY_HOME`，脚本会拒绝指向 `~/.gemini` 且永不删除外部目录。
- **验证范围**：使用真实 `openCenterServer` 与真实 `agy`，验证已有缓存自动识别（`auth-status` 返回 `method: 'oauth'`）、显式发起登录获取官方 Google `auth_url` 与 `manual_code` 表单提示、空值/超长输入边界拒绝（HTTP 400 且不提交给上游）、单次固定无效授权码触发 `failed` 状态且错误信息不回显授权码或日志/token 原文、发起登录后取消（`/cancel` -> `cancelled`），以及失败与取消后既有缓存与目录（`auth-status` / `validate` / `discover`）仍保持可用。
- **未覆盖范围**：Google 页面人工账号同意及输入真实有效授权码完成 OAuth 换取凭据不作自动化，因此该脚本不宣称端到端完整真实 OAuth 成功登录，仅覆盖授权链接生成、输入校验、无效失败、取消及既有缓存复用能力。

## 版本与已知限制

- 当前针对 `agy 1.5.9` 仅实测过 `--version`、`--help` 及未登录独立 profile 返回 `Authentication required`，支持 `--agent`、`--gemini-dir`、`--app-data-dir`；尚无其他 `1.5.9` 功能实测限制可宣称。
- 历史 `agy 1.5.2` / `1.5.3` 中存在自定义 Agent 与 `/compact` 的历史已知回归问题，现阶段仅作为 `1.5.9` 后续验收需核查项记录，不表示已在 `1.5.9` 复现。
- `agy` 常规运行可能触发后台自更新逻辑；在只读挂载 `/usr/local/bin/agy` 的容器中二进制不可写入，需由宿主机统一更新镜像外挂载文件或重新构建镜像。
