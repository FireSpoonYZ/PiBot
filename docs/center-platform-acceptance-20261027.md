# 中心部署与三端验收（2026-10-27）

代码基线：中心分支 fe5d0ec，按用户选择合入 f5f7b74（本分支 d5a4af1），中心修复至 71d4420；Windows 启动与凭据复用修复至 ccf2787。父助手直接完成，未派子代理。下列结果均来自本轮实跑。

## 部署

- 管理入口：https://relay.firespoon.cn:3000；WSS 中继：同域名 /v1/link。
- Linux：/home/services/e-launcher，Compose 容器 e-launcher-center，镜像 e-launcher-center:71d4420。源程序 current 指向 releases/20261027-71d4420。
- 管理与中继分别只发布到回环 18443、17691，由既有 Ferron 转发。保留原泛域名证书。
- Docker Hub 构建前端拉取阻塞，部署使用仓库外 Dockerfile.deploy，移除 syntax 指令并使用已缓存 node:22.23.4-bookworm-slim；业务源码与仓库一致。
- Linux Host：e-launcher-host.service，控制端口 6279。Windows Host：D:/services/e-launcher/start-host.cmd，同端口。Android：Redmi K80 / zorn / 24117RK2CC，覆盖安装 ARM64 APK，保留原数据。
- 老中继服务停止并禁用；原注册表保留且已迁入 center-data。回滚备份：Linux backups/pre-center-fe5d0ec，Windows backups/pre-center-fe5d0ec，K80 原数据位于仓库外受限验收目录。
- 中心登录密码保存在服务器 secrets/center-owner-password，密钥与设备凭据在 secrets/，未写入仓库。

## K80 界面验收遗漏与补验（2026-10-28）

此前 K80 跨机任务主要通过原生桥执行，遗漏了普通启动后从中心连接表单进入首页的完整路径。原生桥可调用远端不能替代首页 Bot 列表验收。用户反馈 K80 看不到其他机器的 Bot 后，确认 UI 仍保留旧测试中继配置，中心认证也没有初始化首页使用的中继连接与 UI identity。

修复提交 a92c8ee：中心连接后读取仅含连接元数据的 `/api/host/connection`，接入中心指定中继，再初始化移动端连接配置和首页订阅。客户端不为发现中继地址获取包含 Host 凭据的配置快照。设置页默认选中当前连接。

补验使用 K80 实际 WebView 表单、Bot 行和聊天输入框（CDP 操作 DOM，未直接调用发送消息的原生桥）：首页显示 Windows/Linux 的四个 Bot；分别发送唯一标记并在聊天页收到模型回复。重新安装最终 APK 后，从 MAIN/LAUNCHER 入口打开，错误令牌显示连接失败；换回有效令牌后自动恢复四个远程 Bot，无需另外配置远程节点。应用进程重启后仍需重新输入客户端令牌，这是当前仅内存保存凭据的行为。

中心已更新为 e-launcher-center:a92c8ee，源码在 releases/20261028-a92c8ee；Linux Host 的 current 链接保持原版本。升级前备份在 backups/pre-k80-ui-a92c8ee。K80/K90 覆盖安装同一 APK，SHA-256 为 af6247fa8756a1c805e5e8a5ab39d7760f4a315c5a79e151852e0c7934a7916f。K90（myron / 25102RKBEC）安装前完整备份私有 files/shared_prefs/databases，安装及启动检查通过，当前停在首次连接中心页面，尚未配置中心身份或验收跨机聊天。

后续按用户要求完成 K90 中心配置：沿用原设备身份 `392d392e-8481-4c21-8f0e-c8f79458422f` 和已迁入注册表的令牌，未重建数据库或轮换其他设备凭据；显示名称设为 Redmi K90。客户端与本机 Host 均连接 `https://relay.firespoon.cn:3000`。Host 为 running、中心 ready、中继 online；中心下发 77 个模型，主助手继承中心配置，真实回复记录为 antigravity/gemini-3.8-flash-high。通过手机页面分别向本机、Windows、Linux Bot 发送唯一标记并读到模型回复；Linux CLI 也读取到 K90 的原临时 Bot 和主助手。期间发生一次连接中断，Host 自动恢复，客户端从连接表单重连后继续通过；中断原因未定位。Host 连接配置已持久化，客户端令牌仍仅在当前客户端进程内保存，进程退出或中心连接断开后需重新认证。

本轮截图、DOM 与私有备份在仓库外 e-launcher-k80-ui-1793129888940；目录包含凭据，禁止整体上传。

## 原有后端与分项验收

| 范围 | 本轮证据 |
| --- | --- |
| 六向跨机任务 | Windows→Linux/K80、Linux→Windows/K80、K80→Windows/Linux，真实模型写文件、读回、回传完成回执；独立读取目标设备文件确认标记。 |
| Bot 协作 | Windows Bot 使用 list_bots、ensure_dm、send_dm，与 Linux/K80 Bot 完成请求、落地文件、关联回复和结果汇总；两端文件为 PEER_LINUX_OK、PEER_ANDROID_OK。 |
| 中心模型配置 | 10 个 provider、77 个模型通过管理 API 导入；默认模型和 Bot 覆盖进入 Host 实际请求。覆盖模型的历史记录由 high 切换到 medium；medium 上游报 model_not_found，随后恢复有效 high。验收 Bot 最终恢复继承全局设置。 |
| Hindsight | 原生插件 1.0.0→1.0.1，三端安装/升级回执、状态及实际服务 recall 通过；只绑定验收 Bot，采用 read-only。Linux Bot 禁用后动作返回 403，重新启用后状态成功。 |
| MCP | 中心托管既有 Grok HTTP MCP，配置凭据后列出 3 个工具；Linux 模型实际调用 grok_list_models 返回 7 个模型。Host 快照不包含该中心托管 MCP 密钥。 |
| Skill | 既有 Ponytail SKILL.md 作为制品下发三端；Linux 模型读取实际受管路径并报告技能名称。 |
| Windows 客户端 | 原生 Tauri 应用实际运行、中心登录、连接配置保存、三端设备/Bot 聚合列表通过；原生桥向 K80 提交任务通过。 |
| 图形操作 | Linux 模型启动 zenity；K80→Linux、Windows→Linux 输入截图通过。K80 模型启动设置；Windows→K80、Linux→K80 输入截图通过。Linux→Windows、K80→Windows 的中文、键盘与点击也已读回验证；详见 Windows 补充报告。 |
| Android 旋转 | 设置应用转为竖屏后，源尺寸返回 1440×3200，与截图方向一致；按返回尺寸换算点击并输入成功。 |
| 断线恢复 | 停止中心，三端 Host 报告 CENTER_OFFLINE；重启中心后三端自动恢复 ready；Linux 另做一次停中心／启动中心复核，Host 无需重启。 |
| 构建 | Android ARM64 APK、Web、Center Web、Windows Tauri release exe、Linux Center 容器构建通过。 |

验收源端分别使用真实 Windows/Ubuntu CLI、K80 Tauri 原生客户端桥；Windows 客户端界面另行实跑。Linux 不是 WSL。

## 本轮发现并修复

- Docker 镜像遗漏 plugins，中心无法启动。
- K80 原数据 schema v4 与中心分支 v3 不兼容：按用户选择集成对应协作代码，未降级数据库。
- 能力激活回调重入同一生命周期队列，产生死锁。
- 部署回执触发配置通知，导致反复刷新及启动失败。
- Hindsight 迁移使用硬链接被 Android 拒绝：在 Host 所有权与串行激活保护下改用原子重命名。
- Host 错误解析中心托管 MCP 的凭据引用。
- 根目录 Skill 被自身绝对路径校验拒绝。
- Android 旋转后截图尺寸与坐标校验仍用创建尺寸。
- 客户端连接观察错误要求选定 Host，界面连接后立即显示离线。
- 停用能力动作的管理 API 明确返回 403。

## 未完成与限制

- Windows 图形输入和本机凭据自动复用已补充验收，见 [Windows 启动修复报告](windows-shower-startup-acceptance-20261027.md)。最终构建已通过冷启动和连续重建，首次初始化已由授权的管理员通道完成；Host 运行期间重建不再重复请求授权。
- Linux 原生桌面客户端 GUI 未在本轮构建/运行；已验证真实 Linux Host、CLI、私有 Xvnc。
- MCP OAuth、Node/stdio MCP、全版本回滚/卸载、长时间压力与物理触摸未覆盖。
- 导入的 antigravity/gemini-3.8-flash-medium 实际上游返回 400 model_not_found；保留目录原项，未将目录全部模型标记可用。
- 模型少量最终回复含 ACP 标签；任务文件内容正确，此显示问题尚未修复。

详细命令结果、私有备份与截图位于仓库外 e-launcher-center-acceptance-1793100557367。目录含受限凭据材料，不应整体上传或提交。验收 Bot 和三种能力实例保留用于复查，未绑定普通用户 Bot。
