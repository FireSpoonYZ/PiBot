# Bot 管理、学习与已学技能

PiBot 在 Bot 所在的 Host 执行模型和工具。Center 协调学习作业、保存 Skill 版本历史与使用记录，并在反思生成或更新技能后自动发布部署到源 Bot，同时支持在中心配置跨 Bot 共享范围。

## 自动发布、生命周期与已学技能面板

1. 学习作业（`review`、`learn`、`curate`）创建或修改的 Skill 会写入不可变版本历史（`skill_revisions`），并**自动发布**绑定到源 Bot（无需人工审阅草稿门禁）。
2. 在桌面端（Windows/Linux/macOS）的会话检查器 / Bot 设置或 Android 的会话菜单 / Bot 档案中打开「✨ 已学技能」，可按活跃（`active`）、陈旧（`stale`）、已归档（`archived`）筛选查看技能文件、版本历史，并可执行**回滚到此版本**、`Pin`（置顶防过期）、`Lock`（锁定防改写）、手动归档或恢复。
3. **技能过期与整理（Curator）**：
   - 默认每 168 小时且 Bot 空闲满 2 小时触发一次生命周期维护（也可在中心「设备与 Bot → 自学习与整理」立即手动执行）。
   - **14 天未使用**（`staleAfterDays=14`）自动标为 `stale`；**30 天未使用**（`archiveAfterDays=30`）自动归档（`archived`）并停用 Bot 绑定，保留完整历史以便随时一键恢复。一旦被再次读取使用，自动恢复为 `active`。
   - **LLM 同类技能合并精简**（`curator.consolidate`）默认关闭（`false`），可在中心管理页按 Bot 手动开启。开启后整理前自动保存 `skill_snapshots` 快照，再对高度重复的私有技能执行合并归档；`Pin`、`Lock`、定时任务引用及跨 Bot 共享技能始终受保护。
4. **归属与三档共享范围**：
   - 反思生成的技能记录 `ownerBot`，默认可见范围为 **`private`（仅源 Bot 私有）**，对其他 Bot 完全隐藏且不可绑定。
   - 在中心「插件、MCP 与 Skill → 能力详情 → 分配」页可切换为 **`assigned`（指定 Bot 共享）** 或 **`global`（全局默认可用，对所有未显式关闭的现有 Bot 及未来新建 Bot 自动默认开启）**。
   - 非源 Bot 以只读已安装技能形态使用共享技能；共享状态下自动豁免单 Bot 闲置自动归档，且任意 Bot 的实际使用都会回流计入源技能活跃度。

## 空闲触发、抢占让路与计数恢复

- Bot 学习常开，涵盖主会话回合与委派的 Scope 工作回合。回合完成后需经过 **15 秒空闲静置窗口**（无运行回合且队列为空）才向 Center 提交会话增量快照并启动后台 `review`。
- **前台零延迟抢占**：一旦用户发送新消息、新工作回合启动或主动停止 Bot，Host 立即取消空闲静置计时器并中断正在运行的自动反思作业；若自动 `review` 尚未产生技能或记忆写入即被取消/中断，Center 自动恢复已扣除的轮次与工具步计数，待下次空闲窗口重新复盘。
- 空闲反思期间，聊天底部与顶栏精灵头像会展示平静的思考/翻阅/记录动画，输入框保持正常发送态；当实际习得或更新了技能/记忆时，精灵短暂展示得意反馈并弹出可点击摘要条直达「✨ 已学技能」；若无新内容保存则静默收起。
- `manage_bot_learning` 支持查看状态、调整间隔（默认 `memoryEvery=10`、`skillEvery=10`）与过期阈值、开关 `consolidate`、指定模型、手动运行及取消单次作业。`reviewModelRef` 和 `curatorModelRef` 为 `null` 时跟随 Bot 当前有效模型。
- 手动 `learn` 可通过 `sources` 提供本地文件、目录或 HTTP(S) URL。网页读取使用 Bot 已获授权的 Webfox 能力。来源文件的访问限制见内置管理 Skill 的 `references/learning.md`。

## 管理接口与部署

| 工具 | 用途 |
| --- | --- |
| `manage_bot_skill` | 读取、编辑、回滚、Pin/Lock、归档/恢复 Bot 自有 Skill 及快照 |
| `manage_bot_learning` | 查看学习状态、配置复盘/整理策略与模型、运行或取消作业 |
| `manage_bot_installation` | 管理 Bot 使用的受管能力，查看安装、更新和部署回执 |

Python 学习执行器位于 `center-server/learning-engine/`（同步上游 Hermes Agent 提示词与生命周期算法）。它通过有界 NDJSON 与 Center 交换请求，目标 Host 负责模型循环。Center 容器自带 Python 3.11，非容器部署可通过 `PIBOT_LEARNING_PYTHON` 指定解释器路径。上游模块的来源提交及 MIT 版权见 `THIRD_PARTY_NOTICES.md`。

内置 Bot 管理 Skill 位于 `host-core/builtin-skills/bot-management/`。Android 构建将其纳入 `bot-host` 资源清单，桌面构建将其与 Host 源码一起打包。模型先看到目录项，再按需读取 `SKILL.md` 和参考页。

## 验收一条学习流程

1. 选一个有可用模型的 Bot，完成一轮多步工具任务并静置 15 秒（或在中心「设备与 Bot → 自学习与整理」手动点击复盘 / 运行 `learn`）。
2. 观察空闲反思动画与习得提示，打开「✨ 已学技能」面板，核对已自动发布的技能文件、版本历史及目标 Host 的部署状态。
3. 在中心打开该技能的「分配」页，验证从「仅源 Bot 私有」切换为「指定 Bot 共享」或「全局默认可用」后其他 Bot 的可见与绑定表现。
4. 在「✨ 已学技能」面板测试版本回滚、`Pin`/`Lock` 保护及归档与恢复。
