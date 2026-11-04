# Billion Context — Host 受管插件

本插件使用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) **0.0.101** 管理长期上下文；不需要 bili 或代理。npm 包名 `@e-launcher/billion-context`，版本 `1.0.1`，能力 ID `e-launcher.billion-context`，要求 Host API `^1.0.0` 和 Durable API `1.4.0`。插件通过 Host 注入的 SDK 接入 Durable，不另装一份 Host 引擎。acp-kernel 的署名与完整条款见文末。

## 打包和分发

在仓库根目录，先由维护者按最终 `package.json` 生成并检查插件和 Host 的锁文件；将 `ARTIFACT_DIR` 设为仓库外已存在的目录，使用 Node >= 22.19 和 npm：

```sh
npm pack ./plugins/billion-context --pack-destination "$ARTIFACT_DIR"
```

保留 npm 输出的 `.tgz` 文件，检查其中有 `package.json`、`capability.json`、manifest 指向的入口和 schema、全部本地模块及本 README，且没有 `node_modules`、越界路径或链接。标准 `npm pack` 不包含 `package-lock.json`；中心在制品未带锁文件时用固定 npm 生成锁文件并记录到部署计划，Host 的 managed installer 根据该锁文件执行 `npm ci --omit=peer --no-audit --no-fund` 安装依赖。因此中心和 Host 都需能访问锁文件所引用的依赖源；Host 还需要可用的 npm CLI。中心可选 `CENTER_NPM_PATH`、独立 Host 可选 `--npm-path` 指向各自的 npm-cli.js 绝对路径；Android 使用其已有 npm 资源。不要把 Host 的 node_modules 或引擎复制进包。

以中心管理 UI 登录后，在“插件、MCP 与 Skill”选择类型 `plugin`、来源“本地制品”、目标 `host`，选择此 `.tgz` 并填写名称提交，等待 operation 完成。**实例安装后处于停用状态，需显式启用**（UI 或 `POST /api/installations/:id/enable`）；启用后中心为没有既有绑定的现有和新 Bot 默认开启绑定，**显式关闭的绑定及已有 overrides 原样保留**。从内置 BC 的旧 Host 迁移时，必须先停止旧 Host，再确认目标 Bot 绑定已开启（默认开启或手动），具体顺序见下节。启动新 Host 后查看实例的部署回执，确认该设备的实际版本为 `1.0.1` 且已应用。仅上传、安装或收到 202 不代表任何 Bot 已启用或 Host 已安装。部署由中心分配给有启用绑定的设备，不能通过手动复制到 Host 目录替代。

需要 API 操作时，管理请求使用已认证 owner session；写请求还需 `x-csrf-token`。上传 `POST /api/artifacts`，multipart 字段名为 `file`，使用响应中的 `artifactRef`；`POST /api/installations` 请求体为 `{"requestId":"<唯一请求ID>","displayName":"Billion Context","kind":"plugin","source":{"type":"artifact","artifactRef":"<上传返回值>"},"target":"host"}`。先以 `GET /api/operations/:id` 跟踪返回的 `operationId`，再从 `GET /api/capabilities` 获取 `installationId`，然后 `POST /api/installations/:id/enable` 启用实例并跟踪其 operation。启用后中心自动为无既有绑定的 Bot 写入默认开启绑定；只需对必须停用的 Bot 以 `GET /api/devices/:deviceId/bots/:botId/capabilities/:id` 读取绑定及 revision，然后对同一路径 PUT `{"expectedRevision":<当前revision>,"enabled":false,"overrides":{}}`；发生 revision 冲突时重新读取，不覆盖其他配置。用 `GET /api/installations/:id/deployments` 检查设备回执。

## 升级与回滚

**迁移顺序：先在中心上传并安装插件实例（此时未启用）；停止旧 Host 并保留数据；在中心启用实例，让离线部署计划生成或排队——启用后无既有绑定的 Bot 默认开启绑定，需排除的 Bot 先写显式关闭绑定再启用实例；更新并启动新 Host，等待安装及 snapshot/profile 应用完成后恢复调度，并检查设备回执。** 迁移期间“保持绑定关闭再逐个开启”的旧流程仅适用于未启用实例或需要排除的 Bot；当前默认行为是启用实例即为无绑定 Bot 自动开启。不要在旧 Host 运行时下发启用 BC：旧 Host 的内置工具与插件原名冲突，旧插件管理器会拒绝注册；忽略 `prepareContext` 不代表可同时加载插件。新 Host 不再内嵌 BC，未启用的 Bot 使用普通未压缩请求并保留最终预算检查，不会本地自动回退启用。保留原 Host 数据目录和旧历史；不要清空或重置旧 BC 状态。迁移后应检查已有会话、状态和恢复中的任务，确保在目标设备上验证后再扩大范围。

制品来源的更新先上传新版本 tgz，再在实例“版本与状态”填写精确目标版本并选择新版制品；API 为 `POST /api/installations/:id/update`，请求体 `{"requestId":"<新的唯一请求ID>","targetVersion":"<精确版本>","source":{"type":"artifact","artifactRef":"<新上传返回值>"}}`。包能力 ID 和版本必须匹配目标。回滚使用同页面“回滚”或 `POST /api/installations/:id/rollback`，请求体仅为 `{"requestId":"<新的唯一请求ID>"}`；它回到中心记录的前一版本，不接受指定版本，首次安装尚无前一版本时不能回滚。两者都要跟踪 operation 与各设备回执；回滚插件不等于回滚 Host 或迁移数据，先确认版本兼容并备份，不能假设旧程序能读取新版本数据。

## 行为与状态

BC 按 Durable conversation 保存原有 `host.bc-context` v1 状态，未知 kernel 版本拒绝使用而非重置。原始历史保留；仅纯文本 user/assistant 消息可折叠，其余复杂内容保留。工具保留原名 `compress`、`decompress`、`search_context`、`acp_status`，以便恢复旧的待执行工具任务；会话的 selectedExtensions 与所有权检查隔离 Bot，不能跨 Bot 访问原文。主会话和工作会话的 `contextStatus` 动作是只读的，输入分别为 `{}` 和 `{"scopeId":"<非空scopeId>"}`；未绑定会话返回空状态，不创建会话。插件禁用或卸载时查询返回 `EXTENSION_DISABLED`，不是伪造空状态。

上下文边界（`view.head`：`pi.reset` 或 `pi.compaction`）变化时，`prepare` 用本插件的 initial factory 重建该会话内的 `state`/`contentStore`/`prepared` 并清空 `operations`，避免 `/clear` 前的 block 摘要或旧 prepared 重新进入下一次模型请求；Durable 原历史/回执不删。SDK 原生自动 compaction（threshold/background，Host 默认启用）与 BC 可同时在同一会话生效：原生摘要作为新的 head marker，BC 在下一次 `prepare` 检测到 head 变化后只丢弃自身投影状态，原生摘要消息保留在视图中继续参与投影；原生 compaction 的 summarizer 走 `completeSimple`，不经过 BC 的 `prepareContext`，不会递归触发 BC。

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
