# Todo — Host 受管插件

按会话维护一个 todo 列表的 Host 原生插件。npm 包名 `@e-launcher/todo`，版本 `1.0.0`，能力 ID `e-launcher.todo`，要求 Host API `^1.0.0` 和 Durable API `1.4.0`，无 npm 依赖，无配置项与凭据（config schema 为空对象）。插件通过 Host 注入的 `host.sdk`（defineDoc/defineTool/section）接入 Durable，不另装一份引擎。

## 行为与状态

- 任务状态保存为 rewindable 会话文档 `e-launcher.todos` v1（`scope: 'conversation'`、`history: 'rewindable'`、`fork: 'asOf'`）：fork 继承父会话在分叉点的任务；文档不提前创建，首次写入经 `tx.doc()` 落地，读取把缺失文档当作空列表。
- 模型工具名 `todo`，action 枚举 `create | update | list | delete | clear`。上限 100 条任务、subject 200 字符；id 为递增整数且不复用；同一时刻最多一个 `in_progress`（把某任务设为 in_progress 会把原 in_progress 任务退回 pending）。`update` 需 `id` 加 `subject` 和/或 `status`；`delete` 需 `id`；`list` 与 `clear` 无其他必填。
- 每次模型请求前经 `todo` prompt section 注入当前列表；无任务时不渲染。工具的 model 输出（有界 JSON 摘要）、`details.presentation` 与持久化文档共用同一提交内快照：UI 与模型都看到已提交任务。
- replay 使用 Durable 默认 `unsafe`：写入已提交后被意外重启打断的执行不会重跑，不会静默二次创建或修改任务。
- UI 结构：`result.details.presentation`（含运行中 `api.details()`）为 `{kind:'todo',version:1,installationId,tasks:[{id,subject,status}]}`，是 todo 展示的唯一 UI 数据来源；字段白名单投影，不透传参数或未知字段。
- 管理 action `todoStatus`：输入 `{}` 查询 Bot 主会话，`{"scopeId":"<非空scopeId>"}` 查询对应 work 会话（复用宿主的只读授权，不创建会话）。返回 `{botId, conversationId, scopeId?, presentation}`；未绑定 scope 返回空任务列表。供既有管理通道调用，不是 UI 轮询服务。

## 打包和分发

在仓库根目录，将 `ARTIFACT_DIR` 设为仓库外已存在的目录，使用 Node >= 22.19 和 npm：

```sh
npm pack ./plugins/todo --pack-destination "$ARTIFACT_DIR"
```

检查输出的 `.tgz` 含 `package.json`、`capability.json`、`config.schema.json`、`entry.js`、`todo-state.js`、`todo-tool.js` 及本 README，且无 `node_modules`、越界路径或链接。标准 `npm pack` 不含 `package-lock.json`；本包无依赖，中心生成的锁文件为空依赖锁，Host 的 managed installer 据此执行 `npm ci --omit=peer --no-audit --no-fund`。

上传、安装、启用绑定、升级与回滚流程与现有原生插件一致（以中心管理 UI 登录后在"插件、MCP 与 Skill"上传本地制品，安装默认启用、Bot 绑定默认关闭；API 流程见 `plugins/billion-context/README.md` 同名章节，将 installationId/displayName 换为本插件）。安装或上传本身不代表任何 Bot 已启用；部署回执确认设备应用版本为 `1.0.0` 后，该 Bot 的 `todo` 工具、section 与 `todoStatus` action 才可用。工具名按 Bot 唯一注册，与宿主或其他能力同名时绑定会报 `INVALID_STATE` 且不影响其他能力。

## 上游来源与许可

文档定义与 section 注入结构改编自 Pi Durable 1.4 官方示例
`packages/durable/test/examples/11-extension-state.ts`
（https://github.com/earendil-works/pi ，tag v1.4.0），上游许可为 MIT：

```text
MIT License

Copyright (c) 2025 Mario Zechner

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
```
