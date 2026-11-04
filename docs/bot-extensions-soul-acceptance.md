# Bot 扩展与 SOUL：交付与端到端验收

本轮基于 `12ab286` 开发，产品代码截至 `36d1298`。八个 worker 在独立 worktree 静态实现，父助手合并；worker 未编写测试或验收脚本、未执行构建与测试。三路独立代码审查的有效问题已修正并复审，最后的关闭准入小修由父助手核对。

## 交付范围

- Host 管理扩展目录、可用性、公共连接与凭据引用。首个接入扩展为 Hindsight，使用官方 `@vectorize-io/hindsight-client@0.9.2`。
- 每个 Bot 保存独立的启用与读写策略。新 Bot 复制默认值，后续修改默认值不改变既有 Bot。
- 每个 Bot 的文件位于 Host 数据目录的 `bots/<botId>/SOUL.md`，与工作目录分离。支持 UTF-8、多行、空内容和摘要 CAS；主会话与工作会话使用该人格。
- 新增五个 additive v2 控制方法，原有 35 个方法保留，当前共 40 个。手机本机与桌面/手机远端界面提供扩展设置和 SOUL 编辑。
- 普通 Hindsight 请求与 reflect 使用独立可配置期限，纠错 GET/PATCH 共用操作预算，相关传输期限已对齐。

## 父助手实际验收

| 场景 | 结果 |
| --- | --- |
| 同一工作目录内三个 Bot | 真实 DeepSeek 分别按各自 SOUL 回答；文件路径独立 |
| 主会话和群聊工作会话 | 人格与 Hindsight 工具可用性均按 Bot 区分 |
| 关闭→开启、只读→读写 | 原生工具变更记录显示正确移除与恢复，核心工具仍存在 |
| 首次只读聊天 | 正常完成、零自动 retain；显式写入返回 403 / EXTENSION_READ_ONLY |
| 忙碌时编辑 | 返回 409 / RUNTIME_BUSY，原文不被改写 |
| SOUL 与默认值持久化 | Unicode、空 SOUL 重启后保留；旧 Bot 开关不随新默认值改变 |
| 桌面实际界面 | 保存影响下一次真实回答；过期 CAS 保留草稿，显式采用远端后读到新内容 |
| REDMI K80 | 覆盖安装签名一致；本机界面保存扩展开关和 SOUL；真实模型回答“手机青竹”，两条记忆写入完成 |
| K80 远端桥 | 新 SOUL 读写与扩展查询接口通过 |
| 长 reflect | 声明的 Mockoon 延迟夹具：HTTP 35.04 秒、K80 远端桥 35.25 秒后成功，未被旧 30 秒限制截断 |
| 纠错总预算 | 500 ms 预算下，300 ms GET + 400 ms PATCH 在约 512 ms 返回 unconfirmed；重复请求返回同一回执 |
| K80 数据兼容 | Host schema 2→3、Hindsight 1→2；原两条 Bot 登记逐字段一致，原 84 条 Durable entries 导出摘要一致 |

长延迟和纠错预算使用受控合成后端；人格、实际记忆读写使用用户授权的真实服务。没有新增或修改测试代码。

## 产物与清理

- APK：`app/build/outputs/apk/debug/app-debug.apk`，SHA-256：`d1f44df7721c447f6a98f4299cbbe971f323e2e3f185b9f58dfd534c3524bbbf`，已安装到 K80。
- 桌面调试版：`desktop/build/target/debug/e-launcher-desktop.exe`，已实际运行界面验收。
- 四个专用测试 bank 已删除，并通过精确 bank 查询确认不存在；未动 Pi 原项目/用户 bank。
- K80 原 Host 配置恢复为 revision 19，临时凭据别名清空，原运行状态与通知权限恢复；麦克风仍未授权，省电设置未改。
- 自有 Windows Host、延迟夹具、桌面界面、ADB 转发及终端已关闭。本地合成 Bot 历史与 SOUL 示例保留。
- 源码与验收资料已保留；未推送、未触发 CI，M19 stash 未动。

证据位于仓库外目录 basename `e-launcher-extensions-soul-1792931166997`，入口为 `acceptance-result.json`、`cleanup-complete.json`。关键资料包括 `initial-bot-isolation.json`、`toggle-result.json`、`defaults-and-restart.json`、`desktop-ui-cas-conflict.json`、`k80-real-result.json`、`k80-remote-long-reflect.json`、`deadline-budget-result.json`、`k80-migration-result.json`。

真人语音继续暂缓。本轮没有重打桌面正式安装包/Linux 包，也没有重新跑全量跨设备安装矩阵或冷门压力场景；此前 M20 的限定记录及暂停状态保持。
