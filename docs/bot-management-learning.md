# Bot 管理与 Hermes 学习：源码复用边界与验收步骤

Bot 管理工具面包括 Bot 自有 Skill、能力安装管理与 Hermes 学习中心。控制工具与既有管理 UI 走同一后端；本文记录上游源码复用与适配边界、资源打包方式、设置与状态语义和验收步骤。

## 结构总览

- 既有管理工具（`list_bots`、`get_bot`、`create_bot`、`update_bot_profile`、`get/set_bot_soul`、`get/set_bot_model`、`get/set_bot_capability`、`abort_bot`、`clear_bot_history`、`compact_bot`、`archive_bot`、`unarchive_bot`、`delete_bot`）保持不变，仍经 `host-core/communication-tools.js` → `collaboration-service.js` → 中心路由。
- 新增三个管理工具：`manage_bot_skill`、`manage_bot_learning`、`manage_bot_installation`（实现见 `center-server/skills`、`learning` 与 `bot-management`；字段以工具 schema 为准）。
- Bot 自有 Skill 由中心按 (deviceId, botId) 管理：草稿为版本化文件与元数据，发布复用既有 kind=skill 制品/包安装与 Bot 绑定；Host 上的受管包目录是不可变部署产物。修改流程为读草稿 → 改 → 发布，不直接写 SKILL 文件系统。
- Hermes 上游学习模块原样 vendored，仅在中心 Python 执行；实际模型/工具循环由发起方的 Host 用既有 Durable 与已配置模型执行。

## 上游源码复用与适配边界

上游为 Nous Research 的 **hermes-agent**（https://github.com/NousResearch/hermes-agent），MIT，精确固定在 commit `71736c9f32597bbca9d89cede5aa136e55946b2f`，许可文本随 vendored 源保留在 `center-server/hermes/vendor/LICENSE`，署名见 `THIRD_PARTY_NOTICES.md`。

**原样复用（不改字节、不翻译为 JS）：**

| 上游模块 | 用途 |
| --- | --- |
| `agent/background_review.py` | 回合后后台审查；`spawn_background_review_thread` 目标函数原样执行，含 fork/工具白名单/预算/汇总逻辑 |
| `agent/learn_prompt.py` | `build_learn_prompt(user_request)` 手动学习提示词 |
| `agent/curator.py` | Skill 策展（stale/archive/consolidate、pin/lock 语义） |
| `tools/` 中上述模块原样依赖的辅助文件 | 与上游保持同一 commit 的未改字节 |

**项目适配层（新增代码，非上游）：**

- Node↔Python 传输：有界 NDJSON、方法白名单、错误/取消/退出透传；`agent.run` 回调经已认证设备 HTTP 长轮询（≤20s，客户端 30s 超时）交给发起方 Host，显式应答。
- Skill 回调桥：上游 `skills_list`/`skill_view`/`skill_manage` 与 `skill_usage.*`（curated_report/set_state/archive 等）映射到中心 Skill 服务，保留上游成功结果形状（`success` + `_change`）；读后再写与 locked 防护在适配侧执行。Hermes 从不直接写本地 skill 文件。
- Memory：当前学习快照不暴露 memory 工具，`memoryEnabled` 固定为 false，仅执行 skill 范围，不创建第二套记忆库。
- 上游 import 可能需要适配；不支持的功能显式失败，不用假成功。

**运行环境：** Python 只在中心侧。中心 Docker 最终镜像安装 `python3`（Debian bookworm 为 3.11，满足上游 `requires-python >=3.11,<3.15`），保持非 root `USER node`；Android/桌面 Host 不含也不依赖 Python。适配层以环境变量 `HERMES_PYTHON` 启动解释器，默认 `python3`；Windows 可设置解释器绝对路径覆盖。

## 自动与手动学习语义

- 自动学习在**已完成的成功用户提交之后**启动，独立模型上下文；不递归触发学习，每个 Bot 同时最多一个活跃任务；Host 断开/关机或配置停用时取消；不阻塞前台回复、不占 Bot 准入。
- 默认按 Bot 启用学习，间隔遵循上游风格的有界节流（阈值以 vendored 源码为准，`agent_init.py` 中 nudge 默认 10）；显式 `learn`/`review`/`curate` 与自动审查在记录中区分。
- 计数器与任务回执重启后保留；被打断的工作如实标记 interrupted。学习绝不改写 SOUL——SOUL 只是用户请求的管理面。
- 所有应答区分 `saved` / `queued`·`waiting-idle` / `applied` / `failed`；排队或受理中的部署/任务不得报为成功。

## 内置管理 Skill 资源与打包

`host-core/builtin-skills/bot-management/` 是随 Host 发布的内置 Skill（SKILL.md + references/ 渐进目录），向模型讲授上述全部管理工具与三个新工具的目标身份、`expectedRevision`、激活回执与停止/自身修改语义。`host-core/bot-management-skill.js` 导出 `createBotManagementSkillSection()`：按模块运行时位置解析 SKILL.md 绝对路径，渲染仅含 name/description/location 的目录 section（`{tag:false}`，与受管 skill 目录同形），完整正文经 `read` 工具按需加载，不把整本手册放进系统提示。通过 runtime 内 `defineExtension` 注册。

打包覆盖两处：

- **Android**：`build-android.js` 把 `host-core/builtin-skills/**/*.md` 复制为 `bot-host/builtin-skills/...` payload 同级文件，写入既有 `payload.json` sha256 清单；`BotHostAssets` 按清单安装并校验，路径段校验天然兼容。
- **桌面**：`build-desktop.js` 在 `collectHostRuntimeSources()` 中按独立扩展名清单（`.md`）递归暂存 `host-core/builtin-skills/`，进入既有 sources 内容哈希与 host-runtime 暂存/复用逻辑。

两边均使模块的 sibling 相对解析命中同一布局；缺目录/无资源是构建期显式错误。

## 端到端验收步骤

以下操作需要在真实环境进行：

1. 中心镜像构建并启动后，确认容器内 `python3 --version` ≥3.11、`HERMES_PYTHON` 未设置时适配层能拉起 vendored 模块；缺失/错误解释器时显式报错。
2. 通过 `manage_bot_skill` 对目标 Bot：create→read→update（CAS 冲突返回 409）→publish；确认产物安装、只绑定目标 Bot、`operation`/`deployments` 回执到位后才判 live；失败发布保留草稿且同 requestId 幂等重试。
3. `manage_bot_learning status` 显示配置/计数/任务；`learn`/`review`/`curate` 返回 `{jobId,status}` 受理回执；完成后状态如实反映成功/失败/中断；`cancel` 终止指定任务；Host 断连取消活跃任务。
4. 一次真实成功提交后自动审查启动（独立上下文、单 Bot 串行、不递归），Skill 写入经中心服务且 locked 拒绝；SOUL 不被学习改动。
5. `manage_bot_installation` inspect/install/update/rollback/enable/disable/uninstall 与 deployments 回执一致；跨 Bot 共享包改动返回显式错误并指向 admin 路径。
6. Android payload.json 含 `builtin-skills/**` 条目且安装校验通过；桌面 staged host-runtime 含同路径文件；模型经 `read` 能打开 SKILL.md 与 references。
7. 校验 vendored 文件与上游 commit 的哈希清单一致、LICENSE 在场；适配层方法白名单外调用被拒绝。

## 部署说明

`HERMES_PYTHON` 可按部署需要覆盖，默认使用镜像 PATH 内的 `python3`。Hermes 技能写入先保存草稿再尝试发布；`queued`/`activating` 尚未完成，发布失败保留草稿，可使用 `manage_bot_skill publish` 重试。策展快照记录在中心数据库中，单个技能可通过 history/rollback 恢复内容。
