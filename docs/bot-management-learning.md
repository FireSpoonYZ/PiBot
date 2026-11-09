# Bot 管理、学习与 Skill 审阅

PiBot 在 Bot 所在的 Host 执行模型和工具。Center 协调学习作业、保存 Skill 草稿和版本，并沿用现有能力部署流程把已发布版本交给目标 Host。

## 审阅和发布

1. 在 Windows/Linux 的 Bot 设置或 Android 的 Bot 档案中打开「Skill 审阅」。
2. 选择一个待审阅 Skill。面板显示学习模式、作业 ID，以及可用的来源会话 ID 和历史条目范围。打开文件查看相对已发布版本的变化。首次发布时，各文件都显示为新增。
3. 确认内容后点击发布。Center 校验当前草稿修订号；草稿在你阅读期间更新时，刷新后重新审阅。关闭面板会保留草稿。
4. 根据发布回执查看排队、激活中或失败状态。Center 完成发布后，可在「设备与 Bot → 能力分配」查看目标 Host 是否已应用。重试沿用该版本的发布操作。

学习创建或修改的 Skill 进入待审阅列表。已有已发布版本继续供 Bot 使用。策展可以查阅使用记录和定时任务中的 Skill 引用，也可以提出新的 Skill 内容。人工管理仍可归档、恢复或回滚技能。对待审阅内容的进一步编辑会更新审阅版本。

## 学习何时运行

- Bot 学习常开。成功的用户回合结束后，Host 向 Center 发送有界的会话增量快照。Center 按已累积的用户回合和模型工具迭代分别安排记忆与 Skill 审查；默认间隔各为 10。具备已授权 Hindsight 记忆能力时才使用相应记忆工具。
- 每个 Bot 同时最多一个学习作业。自动审查使用独立模型上下文，作业取消、Host 断开和 Center 重启会产生对应的取消或中断回执。Center 在活跃作业中使用会话快照，数据库保留作业摘要和回调记录。回调记录可能包含提交给 Host 的会话上下文。
- `manage_bot_learning` 支持查看状态、调整正数间隔和预算、指定模型、手动运行及取消单次作业。`reviewModelRef` 和 `curatorModelRef` 为 `null` 时跟随 Bot。指定模型必须已配置并可由目标 Host 使用。
- 手动 `learn` 可通过 `sources` 提供本地文件、目录或 HTTP(S) URL。网页读取使用 Bot 已获授权的 Webfox 能力。来源文件的访问限制见内置管理 Skill 的 `references/learning.md`。
- 老版本保存的关闭设置会按常开规则读取，旧的零间隔恢复到默认值。模型、预算和作业历史沿用既有记录。

## 管理接口与部署

| 工具 | 用途 |
| --- | --- |
| `manage_bot_skill` | 读取、编辑和管理 Bot 自有 Skill 及版本，发布人工草稿 |
| `manage_bot_learning` | 查看学习状态、配置间隔和模型、运行或取消作业 |
| `manage_bot_installation` | 管理 Bot 使用的受管能力，查看安装、更新和部署回执 |

Bot 的 Skill 草稿按设备和 Bot 存在 Center。发布将选定修订打包为不可变的 Skill 制品，并复用目标 Bot 的能力绑定。审阅面板的专用接口与模型的管理工具分别处理审阅和日常 Skill 管理。

Python 学习执行器位于 `center-server/learning-engine/`。它通过有界 NDJSON 与 Center 交换请求，目标 Host 负责模型循环。Center 容器自带 Python 3.11，非容器部署可通过 `PIBOT_LEARNING_PYTHON` 指定解释器路径。上游模块的来源提交及 MIT 版权见 `THIRD_PARTY_NOTICES.md`。

内置 Bot 管理 Skill 位于 `host-core/builtin-skills/bot-management/`。Android 构建将其纳入 `bot-host` 资源清单，桌面构建将其与 Host 源码一起打包。模型先看到目录项，再按需读取 `SKILL.md` 和参考页。

## 验收一条学习流程

1. 选一个有可用模型的 Bot，完成一轮任务。使用 `manage_bot_learning` 的 `status` 检查计数和作业。需要立即验证时，手动运行 `learn` 并提供一份可形成 Skill 的资料。
2. 打开审阅面板，核对 Skill 来源、增删改文件和原有发布版本。阅读期间再生成一次草稿，确认旧修订的发布请求会要求刷新。
3. 发布当前修订，核对回执及目标 Host 的应用状态。再运行一轮任务，确认 Bot 使用的是已审阅的版本。
4. 要恢复旧内容时，在 `manage_bot_skill` 中查看历史并回滚为新草稿，再按需要审阅或发布。
