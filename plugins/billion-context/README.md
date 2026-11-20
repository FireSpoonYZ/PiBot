# Billion Context — Host 受管插件

本插件使用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) **0.0.101** 管理长期上下文；不需要 bili 或 HTTP 代理。npm 包名 `@e-launcher/billion-context`，版本 `1.0.4`，能力 ID `e-launcher.billion-context`，要求 Host API `^1.0.0` 和 Durable API `1.4.0`。插件通过 Host 注入的 SDK 接入 Durable，不另装一份 Host 引擎。acp-kernel 的署名与完整条款见文末。

## 打包和分发

在仓库根目录，先由维护者按最终 `package.json` 生成并检查插件和 Host 的锁文件；将 `ARTIFACT_DIR` 设为仓库外已存在的目录，使用 Node >= 22.19 和 npm：

```sh
npm pack ./plugins/billion-context --pack-destination "$ARTIFACT_DIR"
```

保留 npm 输出的 `.tgz` 文件，检查其中有 `package.json`、`capability.json`、manifest 指向的入口和 schema、全部本地模块及本 README，且没有 `node_modules`、越界路径或链接。标准 `npm pack` 不包含 `package-lock.json`；中心在制品未带锁文件时用固定 npm 生成锁文件并记录到部署计划，Host 的 managed installer 根据该锁文件执行 `npm ci --omit=peer --no-audit --no-fund` 安装依赖。因此中心和 Host 都需能访问锁文件所引用的依赖源；Host 还需要可用的 npm CLI。中心可选 `CENTER_NPM_PATH`、独立 Host 可选 `--npm-path` 指向各自的 npm-cli.js 绝对路径；Android 使用其已有 npm 资源。不要把 Host 的 node_modules 或引擎复制进包。

以中心管理 UI 登录后，在“插件、MCP 与 Skill”选择类型 `plugin`、来源“本地制品”、目标 `host`，选择此 `.tgz` 并填写名称提交，等待 operation 完成。**实例安装后处于停用状态，需显式启用**（UI 或 `POST /api/installations/:id/enable`）；启用后中心为没有既有绑定的现有和新 Bot 默认开启绑定，**显式关闭的绑定及已有 overrides 原样保留**。从内置 BC 的旧 Host 迁移时，必须先停止旧 Host，再确认目标 Bot 绑定已开启（默认开启或手动），具体顺序见下节。启动新 Host 后查看实例的部署回执，确认该设备的实际版本为 `1.0.4` 且已应用。仅上传、安装或收到 202 不代表任何 Bot 已启用或 Host 已安装。部署由中心分配给有启用绑定的设备，不能通过手动复制到 Host 目录替代。

需要 API 操作时，管理请求使用已认证 owner session；写请求还需 `x-csrf-token`。上传 `POST /api/artifacts`，multipart 字段名为 `file`，使用响应中的 `artifactRef`；`POST /api/installations` 请求体为 `{"requestId":"<唯一请求ID>","displayName":"Billion Context","kind":"plugin","source":{"type":"artifact","artifactRef":"<上传返回值>"},"target":"host"}`。先以 `GET /api/operations/:id` 跟踪返回的 `operationId`，再从 `GET /api/capabilities` 获取 `installationId`，然后 `POST /api/installations/:id/enable` 启用实例并跟踪其 operation。启用后中心自动为无既有绑定的 Bot 写入默认开启绑定；只需对必须停用的 Bot 以 `GET /api/devices/:deviceId/bots/:botId/capabilities/:id` 读取绑定及 revision，然后对同一路径 PUT `{"expectedRevision":<当前revision>,"enabled":false,"overrides":{}}`；发生 revision 冲突时重新读取，不覆盖其他配置。用 `GET /api/installations/:id/deployments` 检查设备回执。

## 升级与回滚

**迁移顺序：先在中心上传并安装插件实例（此时未启用）；停止旧 Host 并保留数据；在中心启用实例，让离线部署计划生成或排队——启用后无既有绑定的 Bot 默认开启绑定，需排除的 Bot 先写显式关闭绑定再启用实例；更新并启动新 Host，等待安装及 snapshot/profile 应用完成后恢复调度，并检查设备回执。** 迁移期间“保持绑定关闭再逐个开启”的旧流程仅适用于未启用实例或需要排除的 Bot；当前默认行为是启用实例即为无绑定 Bot 自动开启。不要在旧 Host 运行时下发启用 BC：旧 Host 的内置工具与插件原名冲突，旧插件管理器会拒绝注册；忽略 `prepareContext` 不代表可同时加载插件。新 Host 不再内嵌 BC，未启用的 Bot 使用普通未压缩请求并保留最终预算检查，不会本地自动回退启用。保留原 Host 数据目录和旧历史；不要清空或重置旧 BC 状态。迁移后应检查已有会话、状态和恢复中的任务，确保在目标设备上验证后再扩大范围。

制品来源的更新先上传新版本 tgz，再在实例“版本与状态”填写精确目标版本并选择新版制品；API 为 `POST /api/installations/:id/update`，请求体 `{"requestId":"<新的唯一请求ID>","targetVersion":"<精确版本>","source":{"type":"artifact","artifactRef":"<新上传返回值>"}}`。**既有安装不会自动切换到 `1.0.4`**：包能力 ID 和版本必须匹配目标，已安装的 `1.0.3`（或更早版本）实例须显式按 `targetVersion: "1.0.4"` 上传并执行更新操作，等待 operation 与各设备部署回执生效后，才会启用本版逻辑。发送前折叠、`autoFold` 与同轮溢出恢复还需要更新 Host；只更新插件不会开启这些宿主功能。回滚使用同页面“回滚”或 `POST /api/installations/:id/rollback`，请求体仅为 `{"requestId":"<新的唯一请求ID>"}`；它回到中心记录的前一版本，不接受指定版本，首次安装尚无前一版本时不能回滚。两者都要跟踪 operation 与各设备回执；回滚插件不等于回滚 Host 或迁移数据，先确认版本兼容并备份，不能假设旧程序能读取新版本数据。

## 配置项

插件通过 `config.schema.json` 提供以下可选配置（既有空对象 `{}` 配置完全兼容）：

- `autoFold`（`boolean`，默认 `false`）：开启后，当请求估算达到低于当前硬预算上限的可达增长目标时，在发送前主动预压缩较旧可节省历史，并仅在该增长目标生效且未退避时抑制传统 nudge；没有可折叠历史时记录已测下界，等待真正增长；摘要失败时暂时退避并恢复传统提醒，且**低于硬上限的请求不会仅因增长目标失败而被阻塞**。
- `autoFoldTargetTokens`（可选正整数）：开启 `autoFold` 时的增长折叠目标 token 数；留空时默认取当前有效硬预算的一半，生效值下限为 `8192` 且必须严格低于当前硬预算上限，否则不启用增长折叠且不抑制传统 nudge。

## 行为借鉴与保留边界

本版本（`1.0.4`）在行为层面借鉴了上游 [billion-context `1e357bf2`](https://github.com/ranxianglei/billion-context/tree/1e357bf2d6632bfbd2a74ffb70ecee1af1ec7cc3) 的预压缩（preflight）、溢出恢复（overflow）、增长折叠退避/下界、以及模型侧 nudge 节流与失败断路机制，同时严格保留 Host 受管插件的架构与存储边界：

- **预压缩与溢出压缩（`compactContext`）**：在完整请求（含外部贡献，由 Host 的 `estimateTokens(messages)` 统一计量，无法安全测量时返回 `Infinity`）超出硬预算前预压缩较旧范围；真实 overflow 恢复始终采用 Host 拒绝后的更紧目标，绝不用增长目标替代。同一 API attempt 的重复恢复与提交受限定；取消信号（`abortSignal`）绝不吞掉，普通失败返回结构化 `status`（`compacted` / `unchanged` / `no_range` / `summary_failed` / `still_over_limit`）。
- **摘要请求约束与净缩减证明**：摘要统一经 Host `models.completeSimple` 调用同一配置模型，复用同一 abort context、不附带任何 tools、不携带整段巨大原文；按摘要请求预算与条目边界切分候选范围，优先压缩可节省历史，并保护最新真实输入与当前工具调用/结果对；通过 `acp-kernel` 的 refs 与 `applyCompression` 生成标准可搜索 block，仅在证明最终投影相对原请求净缩减（且不靠剥离临时 nudge 伪造缩减）后才写回与重发。
- **nudge 去重与失败暂停**：`prepareContext` 接收真实冻结用户轮 `turnKey`（绝不把每次工具接续都会变化的 generation `taskId` 当作用户轮）。同轮普通 nudge 去重并在显著 regrowth 时可重新提示；同轮 `compress` 工具连续失败或产出 `0` 个 block 达 `3` 次（按最新真实 `turnKey` 计数、按工具 `taskId` 去重、任一成功 `compress` 即解除）后暂停包括 emergency nudge 在内的全部提醒。临时 nudge 仅附加在请求视图中，绝不写入 Durable 用户历史。
- **保留的边界与兼容性**：
  - 继续使用已发布 npm 版 `acp-kernel@0.0.101`，不复制上游 HTTP 代理与外置总结服务。
  - 保持真实 Durable `host.bc-context` v1 文档结构、旧 block、稳定 refs、未知 `kernelVersion` 拒绝（`UNSUPPORTED_SCHEMA`）及 `view.head`（`pi.reset` / `pi.compaction`）变化自动重置兼容；新增元数据字段在旧快照缺失时自动回退默认值。
  - Durable 事务锁仅包裹短写入阶段，摘要 I/O 全部在事务外执行；写回前核对 `view.head`、`prepared.key`、`taskId`、`cutoff`、`revision` 与旧 `state` 摘要防并发覆盖。
  - 每次成功压缩均保留完整 Durable 原文与可搜索/可解压 block，`prepared.tokenCount` 按实际 post-fold 投影计量。

## 行为与状态

BC 按 Durable conversation 保存原有 `host.bc-context` v1 状态，未知 kernel 版本拒绝使用而非重置。原始历史保留；旧纯文本消息和已闭合的单调用工具组合可折叠。活动工具的调用、结果与图片仍保持配对；长工具结果只缩减发给模型的文本副本。工具保留原名 `compress`、`decompress`、`search_context`、`acp_status`，以便恢复旧的待执行工具任务；会话的 selectedExtensions 与所有权检查隔离 Bot，不能跨 Bot 访问原文。主会话和工作会话的 `contextStatus` 动作是只读的，输入分别为 `{}` 和 `{"scopeId":"<非空scopeId>"}`；未绑定会话返回空状态，不创建会话。插件禁用或卸载时查询返回 `EXTENSION_DISABLED`，不是伪造空状态。

上下文边界（`view.head`：`pi.reset` 或 `pi.compaction`）变化时，`prepare` 用本插件的 initial factory 重建该会话内的 `state`/`contentStore`/`prepared` 并清空 `operations`，避免 `/clear` 前的 block 摘要或旧 prepared 重新进入下一次模型请求；Durable 原历史/回执不删。仅当 BC 确实已激活、绑定并接管当前会话时，Host 在 Durable 入队前通过 pre-threshold veto 跳过主动 `threshold`/`background` 自动压缩；未绑定、未加载、未接管或其余 Bot 保持默认阈值/后台策略。所有会话仍保留显式 `/compact` 与 SDK 原生溢出兜底；不经过 AGY ACP Bridge 的模型可先尝试本插件的发送前折叠与一次同轮溢出恢复；当压缩或重置真正写入新的 `head` marker 后，BC 在下一次 `prepare` 检测到 head 变化后只重建自身投影状态，原生摘要消息保留在视图中继续参与投影；原生 compaction 的 summarizer 走 `completeSimple`，不经过 BC 的 `prepareContext`，不会递归触发 BC。

## acp-kernel 许可

以下为 acp-kernel 上游完整许可及附加署名条款：

```text
MIT License

Copyright (c) 2026 ranxianglei

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Additional Term — Attribution on Product Surfaces
(在 MIT 之上附加的条款 —— 产品出处标注)

In addition to the conditions above, if you use or incorporate the Software
in a product or service that end users can see or interact with — whether
commercial or open source — you must make attribution clearly visible in at
least one of the following places:

  1. the product's home page;
  2. its documentation; or
  3. its "About" / "Credits" / "Acknowledgements" page.

The attribution must state that the product uses acp-kernel (and
billion-context, where applicable) and include a link to
https://github.com/ranxianglei/acp-kernel (and
https://github.com/ranxianglei/billion-context, where applicable).

For purely server-side or embedded uses with no user-facing surface, carrying
these notices in the shipped documentation satisfies this term.

附加条款（中文）：

除上述条件外，若将本软件用于任何终端用户可见或可交互的产品或服务（无论商业或开源），
须在下述至少一处显著位置标明出处：

  1. 产品首页；
  2. 产品文档；或
  3. “关于 / 致谢 / Acknowledgements”页面。

署名须说明该产品使用了 acp-kernel（涉及时包括 billion-context），并附指向
https://github.com/ranxianglei/acp-kernel （及 https://github.com/ranxianglei/billion-context，
涉及时）的链接。纯服务端或内嵌、无用户可见界面的用途，随附文档中包含上述声明即可。
```
