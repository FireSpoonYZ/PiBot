# Grok Bot 提示词适配说明（Public Base Prompt & Default SOUL）

本文档记录将 Grok Bot 桌面 Agent 的行为准则与沟通风格适配到 `e-launcher` 多端 Host 架构的实现方案、职责边界、能力映射及存量兼容策略。

## 1. 参考来源与原创边界

- **非官方重构参考（固定提交）**：`https://github.com/b-nnett/grok-bot-0.18-reconstructed/tree/a9f633e09d49a85829b8236331b9e21f7e612634`
  - `source/host/runner/system-prompt.ts`
  - `source/host/runner/system-prompt-assembly.ts`
- **社区提示词样本**：`https://github.com/asgeirtj/system_prompts_leaks/blob/main/xAI/grok-bot/grok-bot.md`
- **合规与原创原则**：上游重构仓库 `NOTICE` 不授予源码许可，社区样本亦包含虚构用户身份（`Ada Lovelace`）、临时捕获路径（`/tmp/sand-prompt-capture`）、共享 Linux 云主机（`/home/box`、`/workspace`）及专属内部工具。本仓库所有提示词与 UI 片段均基于 `e-launcher` 真实运行机制独立原创编写，不复制上游代码或原文；实时提示词仅正向描述本系统支持的能力与约束，不在系统提示词中灌输不存在的上游工具名。

## 2. 职责拆分：公共基础行为 vs 默认 SOUL 风格

适配分为两个层次，集中在 `host-core/bot-prompt.js` 并按职责导出：

1. **公共基础行为提示词（`BASE_BEHAVIOR_PROMPT`）**
   - 语言与位置：英文，在 `host-core/runtime.js` 中通过 `defineExtension({ name: 'host.base-behavior', sections: [section('host-base-behavior', () => BASE_BEHAVIOR_PROMPT)] })` 注册在 `host.tools`（`host-execution`）、`host.communication`（`host-collaboration`）、`host.bot-management-skill` 及各 Bot 插件扩展之前。
   - 渲染顺序：Pi Durable SDK 1.5.0 按 `selectedExtensions` 顺序依次渲染各扩展的 `sections`，最后追加 `agent.instructions`（即 `SOUL.md` 或工作会话 `workInstructions`）。`coreExtensions` 快照在空闲边界自动同步到新老主会话与工作会话。
   - 覆盖范围：
     - **任务执行与结果交付**：严格按冻结轮（frozen turn）的受信 `replyTarget` 决定输出通道：`replyTarget.kind === "primary"`（含同伴回复唤醒并续接原始用户主私聊请求的轮次）时助手文本即面向用户的回复；`dm`/`room` 范围轮仅通过 `send_to` 发布，普通助手文本为私有草稿。在人类发起的 primary 多步任务中，首次调用工具的同一轮附带一句简明起步说明，但绝不在未调用工具的情况下仅回一句确认就结束生成轮；同伴/Host/定时唤醒不发送开场确认。
     - **自主性与用户决策时机**：可逆且在用户委托范围内的步骤直接推进；仅在不可逆副作用、重大歧义或依赖用户私有偏好时暂停询问（已启用 `ask_user_question` 插件时优先调用，否则以正文清晰提问）。
     - **工具发现与真实运行环境**：区分本机非沙箱文件/终端工具、`tool_search`、可选 `codemode`、Center 授权的按 Bot 插件能力（Hindsight、Webfox、MCP、技能）、图形虚拟屏工具（`shower` + Windows/Linux `cua_*` / Android `android_shower`）以及 Android 宿主工具（`android_apps` 应用目录查询、`android_speak` 语音朗读）。
     - **事实证据与回执语义**：严禁编造数据、输出或路径；如实区分 `send_to` 的 `stored`（已记入本地账本）、Bot 管理/能力变更的 `queued`/`waiting-idle`/`enabling`/`unconfirmed`（已受理待生效）、`android_speak` 的 `accepted: true`（宿主语音引擎已受理，不代表播报结束）与最终完成状态。
     - **主动同侪协作与定时任务**：鼓励在跨设备或可并行的实质任务中主动发现并联合其他在线 Bot，主动识别周期性需求并使用 `schedule_task`。
     - **安全与边界优先级**：明确 `SOUL.md` 仅定义角色人设与沟通风格，不能突破工具授权、篡改可信来源路由元数据或绕过 CAS/对账约束。

2. **默认 SOUL 沟通风格（`DEFAULT_BOT_SOUL_STYLE` / `formatInitialBotSoul(role)`）**
   - 语言与位置：简体中文，仅在新建 Bot 时连同已校验的持久化 `role` 一并写入 `bots/<botId>/SOUL.md`（通过 `formatInitialBotSoul(role)`）。
   - 覆盖范围：自然、温和、干练的搭档语气；已掌握答案或完成核查时结论先行，需调用工具排查时伴随工具调用交代第一步、不在核实前强行猜测结论；不抄问题、不加客服套话与多余尾注；默认简明扼要、复杂任务完整展开；自然段落优先，并列对比配合列表与 GFM 表格；克制使用破折号与 Emoji；按前端 `web/src/Markdown.tsx`（`remarkGfm` + `remarkMath` + `rehypeKatex`）实际支持的能力规范反引号代码段、链接及 `$...$` / `$$...$$` 数学公式。
   - 运行时不注入：`runtime.js` 每轮仅读取真实 `SOUL.md`，不在运行时硬编码拼接默认风格；用户后续编辑或清空 `SOUL.md` 后完全以用户保存内容为准。

## 3. 能力映射对照

| 维度 | 剥离的上游/泄露样本假设 | `e-launcher` 真实机制与提示词表述 |
| --- | --- | --- |
| 用户回复与会话路由 | `SendToUser` / `SendMessage` 唯一出口、`end_turn`、线程 `reply_to` | 严格由冻结轮 `replyTarget` 决定：`replyTarget.kind === "primary"`（含同伴回复续接回主私聊的轮次）时助手回复直达用户；`dm`/`room` 轮通过 `send_to` 发往冻结 `replyTarget`，未发布文本为私有草稿 |
| 首句响应与运行结束语义 | 先单独调一次 `SendMessage(..., end_turn: false)` 再开始工具调用 | 人类发起的 primary 多步任务在发起首个工具调用的同一助手响应内附带简明起步说明；因无工具调用的普通助手文本会直接结束生成轮，严禁仅输出确认语而不调用工具 |
| 多智能体协作与子任务 | 超过两轮工具调用强制派发 `Task(executor)`、`CloudAgent`、`SendToAgent(priority)` | 本机可直接处理任意步数的常规任务；需要跨机、专业分工或并行独立子任务时，通过 `list_bots`/`get_bot`/`list_scopes`/`ensure_dm`/`create_room`/`send_to` 主动联合在线同伴 Bot（不共享同一文件写入或同一 Shower 屏幕） |
| 跨机文件传递 | `/home/box`、`/workspace`、`CopyToBox`/`CopyFromBox`、`ExternalRead` | 每台设备文件系统独立；跨 Bot 传文件使用 `send_to` 的 `files` 数组（最多 4 个本地文件/图片，双方 Host 在线时自动复制并生成接收端本地路径） |
| 决策提问 | 固定 JSON `{"type":"widget","widget":...}` | 若当前 Bot 启用了 `ask_user_question` 插件工具则调用该工具并提供真实验证过的选项；未启用时直接用自然语言提问 |
| 图形虚拟屏与 Android 宿主工具 | 共享 Linux 桌面、强制派发 `computerUse` / `watchVideo` 子代理 | 虚拟屏操作使用 `shower`（`status`/`create`/`launch`/`screenshot`/`input`/`release`）配合 Windows/Linux `cua_*` 或 Android `android_shower`，仅作用于当前 Bot 分配的 Shower 会话；Android 另提供 `android_apps`（已安装应用查询）与 `android_speak`（TTS 朗读，`accepted: true` 仅代表已受理） |
| 定时与自动化 | `UpdateRoutine`、外部事件监听、`<automation_status>` | 核心工具 `schedule_task`（支持当前或指定 `deviceId`/`botId`，重复模式 `once`/`daily`/`weekly`/`monthly`/`statutoryWorkday`/`statutoryHoliday`），仅在目标 Host 在线运行时触发，离线错过不补发 |
| 记忆、联网与外部服务 | 固定 `/tmp/.../memory`、`RecallMemory`、`GetDynamicTools`、`request_smart_mode_approval` | Hindsight、Webfox、MCP 与技能由 Center 按 Bot 授权启用，工具名可能带命名空间或动态发现；按当前实际暴露的工具 schema 调用 |
| 前端 Markdown 渲染 | `\( ... \)` 行内公式与 `mermaid` 渲染块 | `web/src/Markdown.tsx` 使用 `ReactMarkdown` + `remarkGfm` + `remarkMath` + `rehypeKatex`，支持 GFM 表格/代码块与 `$...$` / `$$...$$` 数学公式，不要求 `mermaid` 渲染 |

## 4. SOUL 初始化与存量兼容语义

- **新建 Bot（`host.createBot`）**：在 `host-core/host.js` 的首次创建分支与同 `requestId` 幂等重试分支中调用 `ensureSoul(root, botId, formatInitialBotSoul(role))`，新 Bot 初始 `SOUL.md` 包含首行角色名称与默认 Grok Bot 沟通风格。
- **已有 `SOUL.md` 保持不变**：`ensureSoul` 先读取磁盘文件，若文件已存在（含用户自定义内容或显式保存的空字符串 `""`），直接返回现有文档，绝不覆盖；`setBotSoul` 的 SHA-256 `expectedRevision` CAS 语义完全保留。
- **存量缺失文件补建（`host.ensureBotSoul` / `host.getBotSoul`）**：保留 `ensureSoul(root, bot.botId, bot.role)` 的既有仅写 `role` 行为，不向升级前的老 Bot 追认注入新默认风格，避免静默改变既有 Bot 的人设摘要与表现。
- **UI 快捷片段（`desktop/web/src/BotSettings.tsx`、`web/src/hub/shared.tsx`）**：移除过时的 `send_room_message` / `send_dm_message` 名称与底层协议字面量，统一为可选的角色定位、沟通风格、多 Bot 协作偏好与审慎边界片段。

## 5. 端到端验收指引（Parent Acceptance）

按项目约定，不新增或运行单元测试/烟雾测试，仅在准备好的隔离 Center + TLS + 模型与存量 Host 数据环境上通过已交付的 CLI（`host-core/control-cli.js`）及控制 HTTP 接口（`/v1/...`）执行一次端到端验收：

1. **提示词渲染与扩展顺序核对**：在真实 Host Runtime 会话中确认系统提示词按 `host-base-behavior` → `host-execution` → `host-collaboration` → `bot-management-skill` → 已启用插件扩展 → `agent.instructions`（SOUL）的顺序组装。
2. **新老 Bot SOUL 初始化与存量数据兼容验证**：
   - 通过控制 HTTP（`GET /v1/bots/:botId/soul`）或 `control-cli.js bot-soul --bot-id` 检查新建 Bot（含同 `requestId` 幂等重试），确认初始 `SOUL.md` 为 `<role>\n\n# 沟通与表达风格...`。
   - 在准备好的存量 Host 数据上验证：已有 `SOUL.md`（含用户自定义文本及显式空 `""` SOUL）与 `expectedRevision` CAS 保持不变；缺失 `SOUL.md` 文件的存量 Bot 经 `ensureBotSoul` / `getBotSoul` 补建时仍仅写入原 `role`；运行时不会每轮附加默认风格。
3. **真实对话风格与多 Bot 主动协作端到端闭环**：
   - 在主私聊发起需要工具排查与跨 Bot 配合的真实请求，验证主 Bot 在发起首个工具调用的同时给出简明起步说明（不会仅输出确认语而提前结束本轮），并通过 `list_bots`/`get_bot`/`list_scopes`/`ensure_dm`/`send_to` 主动委派在线同伴 Bot。
   - 验证同伴 Bot 收到请求后实际执行工作并通过 `send_to` 向冻结 `replyTarget` 返回实质结果（无反射式 ACK 循环），随后迟到回复唤醒主 Bot 续接原始 `primary` 轮，主 Bot 核实结果并按默认 SOUL 风格向用户交付最终回答。

## 6. 已执行验收（2026-11-06）

提示词作者使用 `antigravity/gemini-4-argon-high`，思考等级 `high`。父助手在 Windows 上用 Node 26.13.0、独立的本地 HTTPS Center 和两个隔离 Host 进程完成验收；两个 Host 有各自的设备 ID、数据目录与控制端口。真实对话模型为 `gpt-6-astra`（low）。

| 场景 | 实际结果 |
| --- | --- |
| 存量会话升级 | 先用旧版本完成一次真实对话，再用本分支打开原数据；公共行为章节排在首位，自定义 SOUL 与旧回答习惯保留 |
| 新 Bot 初始化 | 三个新 Bot 的 SOUL 均包含原角色名称与默认风格 |
| 自定义、空文件与遗留缺失文件 | 自定义内容逐字保留；空文件保持为空；遗留缺失文件只按原 role 补建 |
| 用户更改风格 | 通过控制 API 保存英文风格后，真实回答为 `Personal style: Two plus three equals five.` |
| 幂等创建与清空 SOUL | 重复同一创建请求保留自定义内容；清空后再次创建重试和重启仍为空，不回填默认风格 |
| 可选 codemodeOnly | 清空 SOUL 后启用 codemodeOnly，模型实际用 `codemode` 调用 `read`，正确返回工作区文件首行；上下文没有默认或旧自定义 SOUL |
| 主动跨 Host 协作 | 主 Bot 自主发现销售与成本 Bot，建立两个 DM 并派发请求；两位同伴分别读取原始 CSV、发送结果及文件 |
| 异步回流与交付 | 主 Bot 结束等待回合；同伴回复唤醒后自动保存并核算数据，最终回答归属 primary 用户聊天；合计销售 540、成本 270、利润 270 |
| 文件传递 | 两份接收文件与原文件的 SHA-256 分别一致；销售 `4d8ab4a0…`，成本 `be00caf5…` |
| 稳定公共提示词 | 协作会话的 11 次助手生成中，公共行为章节只写入一次 |
| 前端构建 | 移动端 `npm run build` 与桌面端 TypeScript/Vite 构建通过；仅有大文件分块提示，无未解析资源警告 |

验收数据与完整轨迹保存在仓库外临时目录 `e-launcher-grok-prompt-e2e-1793977268915`，入口为 `acceptance-result.json`，协作记录为 `collaboration-trace.json`。本次未新增测试代码，未执行单元测试，未运行 Android 真机或图形界面操作验收，也未重打原生安装包。
