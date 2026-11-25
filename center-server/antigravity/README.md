# Antigravity ACP provider

`antigravity-acp` 是 Pi Durable 的模型 provider。Pi Durable 保留唯一业务工具循环；Center 托管隔离的 AGY ACP 会话和 `pibot-bridge` MCP 服务，不接管 Host 的业务工具执行。

## 原生历史与增量传输

AGY 会话只追加新输入，既有 Pi 历史不会重放到原生会话。Host 投影稳定的消息前缀，按偏移和前缀哈希发送 delta；Center 校验、持久化后回复 ACK。

| 边界 | 含义 |
| --- | --- |
| Delta ACK | Center 已保存这段 Pi 历史，不代表 AGY 已处理输入。Host 重启后可以从偏移 0 重传，Center 去重，不重复发给 AGY。 |
| Native dispatch intent | `beforePrompt` 在真正发送 ACP prompt 前持久化原生会话 ID 和已认领的用户输入。只有确定尚未尝试发送时才能撤销认领。 |
| 完成 / 不确定 | 已完成的同一请求可返回保存的结果；发送后取消、断连或失败不能当作未发送而自动重试。 |

未完成业务工具调用时，新输入可被接收保存，但不能越过待交付的工具结果。原生 `session/load` 失败、旧映射缺少增量状态、已提交历史或稳定配置变化时，返回明确错误并要求 `/clear`；不通过重建会话或历史回放修复。

## 工具边界

隔离 custom agent 固定 SOUL 和工具配置，关闭默认组件、自定义规则继承及 AGY 内置文件、Shell、搜索、子代理等业务工具。AGY 只通过桥接 MCP 请求 Pi 工具；Center 将调用交给 Pi Durable，等待 Host 执行结果后恢复同一个原生工具调用。

AGY 强制 Code Mode only：普通工具在 `codemode` 内渐进发现和执行；全部已启用的 model-only 工具（含 deferred）直接声明，保留 `ask_user_question`。`bridge_poll_result` 属于桥接等待协议。业务代码由 Host 的 codemode 执行，不在 AGY 进程中另建业务工具循环。

## 上下文与记忆

- Billion Context 在 AGY 会话中不激活，不参与上下文准备、工具或提示词贡献。Pi 的 threshold / overflow 自动压缩和手动压缩不得改写原生历史；AGY 自身自动压缩由原生会话处理。
- Hindsight **1.2.2** 关闭 AGY 的 autoRecall，保留来源登记、autoRetain、既有 bank 和记忆工具。模型通过工具按需 recall / reflect / retain；`/clear` 不更换 bank。
- SOUL、固定路由规则、工具声明是稳定配置；变化后要求 `/clear`。每轮消息来源、请求 ID 和路由目标属于本轮数据，可正常变化，不参与稳定配置指纹。

已有消息的会话不能切入任何 AGY 模型，也不能在 AGY 模型之间切换。模型写入前须由真实在线 Host 验证当前会话；不能先保存模型再靠 `/clear` 补救。已提交的 AGY 历史禁止编辑、回退和 Pi 手动 compact。`/clear` 使用既有新会话语义，生成新的 provider session ID；不批量清除历史工作会话。

## 取消、恢复与图片

空闲会话可加载原生历史继续。取消或连接中断不保证 AGY 没有收到输入；已认领输入不会自动重复投递。工具结果必须交回仍存活的原生等待调用，重启后丢失这条等待链时要求 `/clear`，不会重跑工具来恢复它。

用户图片随原生 prompt 的 ACP image 块发送。工具结果图片经同一原生轮次的 PreInvocation hook 追加，MCP 结果只返回文本和图片标记，避免重复注入。该通道独立于 autoRecall；图片交付失败须报告失败，不能为了重试图片再次执行已有副作用的工具。

## 接线与源码

产品启动使用 [`openHostService`](../../host-core/host-service.js)：先启动本机 Runtime / control HTTP，再由 `openDeviceLink({ control: { url, token } })` 将控制通道接入 Center。仅调用 `connectCenter()` 不会建立模型验证所需的 Host 控制通道；验收应等待服务的 `relay.phase === 'online'`，再通过 Center 设置 AGY 模型。

- [Host 历史投影与 delta](../../host-core/antigravity-delta.js)、[Center 接收与原生消费](./index.js)
- [custom agent](./profile.ts)、[工具等待与图片交付](./round-trips.ts)
- [Host 会话策略](../../host-core/runtime.js)、[Hindsight](../../plugins/hindsight/entry.js)、[vendor 来源与适配](./vendor/README.md)

## 实机验收

运行 `scripts/verify-antigravity-appendonly.mjs` 可在隔离目录启动完整 Host、Center 和本地 HTTPS/WSS，连接真实 AGY，验证增量传输、Code Mode 工具图片、原生会话重启、SOUL/clear、用户图片和 model-only 问卷续接。Hindsight 使用脚本内的隔离协议 fixture，经真实 Center 配置和 Host 插件验证 autoRetain、显式 recall 与 clear 后 bank 保留。它不连接或修改运行中的 PiBot 或记忆服务。

先准备依赖和 `npm run center:prepare`；提供已登录的隔离 `PIBOT_AGY_HOME`、`PIBOT_AGY_BIN`，并准备本机 Cua driver（或设置 `E_LAUNCHER_CUA_DRIVER`）。脚本使用 OpenSSL 和 Python Pillow 生成本地测试证书与随机图片，结果写入所打印目录的 `result.json`。不能使用日常 `~/.gemini` 作为验收 profile。
