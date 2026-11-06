# 开源发布与客户端更新进度

更新日期：2026-11-06。本轮按用户要求收敛到主要功能与正常安装、升级流程，不再扩展极限边界测试。

合并来源为 `origin/FireSpoonYZ/bot-management-hermes`（`34e2133`），目标为 `develop`（合并前 `856a20f`）。保留 develop 的首次初始化、配对和界面修复，同时接入 Hermes、客户端版本管理与更新。未使用子代理。

产品源码版本统一为 **1.1.0**，Android **versionCode=2**，Rust 固定 **1.99.1**。隔离升级包 `1.1.1/code 3` 只用于开发签名验收，不是正式发布。

## 本轮交付

| 范围 | 当前实现 |
| --- | --- |
| 中心入口 | 网页、API、SSE 与 `/v1/link` 共用 HTTP 8080；公共 HTTPS origin 推导 WSS；中心通过内部入口调用 Relay。Compose 只向宿主回环发布端口。 |
| 配对与身份 | 客户端先保存固定设备 ID 与待确认令牌；同 ID、同令牌重试恢复原登记，异令牌冲突，显式重配才轮换。设备 ID 限 1–200 个可见 ASCII 字符；expectedDeviceId 贯通初始化、接管与 supervisor。 |
| 客户端与 Host | 保留原身份及业务数据；首次配置与普通重连分开，普通重连不重新开启自启动。原生状态显示实际 Host home、进程、本机控制和中心连接情况。 |
| Hermes | 接入 Bot 级受管 Skill、安装管理与学习工具；后台 review 在独立受限上下文执行，回执与主回复分开。 |
| 版本管理 | Owner 上传、草稿、发布与撤回；设备认证查询、下载；中心流式核对制品大小与摘要，客户端原生验证安装包。 |
| 更新维护门 | launcher 提供 prepare-update/cancel-update，本机认证端点暂停新准入；统计主聊、scope、插件和独立学习作业。显式停止等待取消结算，取消更新恢复准入及延后的学习上报。 |
| Linux 生命周期 | 用户服务、实际 Host/XDG 目录登记、首次状态快照、升级后启用/运行状态恢复、失败时保留修复依据；清理用户路径时以该 UID 执行。 |
| Linux 首次自启动 | 受限 root helper 只为调用者 UID 启用 linger，原生 launcher 读回验证。sudoers 与 Linux 安装文件固定 LF，避免 Windows 工作区构建出的配置无法解析。 |
| Windows 当前模式 | 保留受保护的登录任务与现有原生校验；启动核心 Host 不再主动等待 Shower 授权。NSIS 仍为 per-machine；SCM/会话代理尚未交付。 |
| 发布与许可 | 统一中心镜像工作流及标签策略、修正产物路径和带空格文件上传、校验 APK 正式证书摘要；元数据 CLI 读取真实 APK/DEB 信息并检查 updater 签名版本。加入完整 GPLv3、固定 Pi 提交 MIT 文本及随包许可。根 LICENSE 保持原状。 |

原进度所列 `/workspace/e-launcher-release-lanes/` 不在本次可用环境中。本轮在合并工作区完成上述修正，没有把未取得的 lane 产物记为已合入。旧 lane-4/12/13 对应的 Windows 服务与会话代理目标保留在后续任务中。

## 主要功能验收结果

| 项目 | 实际结果 |
| --- | --- |
| 最终构建 | 中心、桌面和移动前端生产构建通过；Windows NSIS、Linux DEB、Android x86_64 debug APK 均成功出包。 |
| 中心正常使用 | 独立数据目录首次初始化、Owner 登录、版本页上传和发布已实际执行；同一 HTTPS/WSS 入口连接设备。 |
| 三端 Host 与模型 | Windows、Linux、Android 均以自己的固定设备身份上线，中心配置 ready、Relay online；真实模型分别返回 WINDOWS_SEARCH_OK、LINUX_SEARCH_OK、ANDROID_SEARCH_OK。搜索使用随包 find/grep（fd/rg）。 |
| 三端 Hermes 工具 | 三端模型实际调用 manage_bot_skill/list 与 manage_bot_learning/status，分别返回 HERMES_WINDOWS_OK、HERMES_LINUX_OK、HERMES_ANDROID_OK。 |
| 最后一次共享运行时回归 | 最终源码在 Windows 与 Android 再次运行主聊天及学习状态工具，分别返回 FINAL_WINDOWS_OK、FINAL_ANDROID_OK。Android 保留原设备 ID、Bot 与此前已完成回复。 |
| 自动学习 | Windows 自动 review 作业真实完成，中心记录 jobsCompleted=1。 |
| 更新维护门 | 实际在途主任务和学习作业都使 ready=false、activeCount=1；显式停止后 ready=true、activeCount=0；取消更新恢复准入。维护期间新提交返回 RUNTIME_BUSY。 |
| Windows 更新 | 原生检查发现 1.1.1；下载中取消后 Host 保持在线；随后认证下载并验证完整安装包成功。未执行 Windows 安装器覆盖升级。 |
| Linux 安装与升级 | 在独立 systemd 容器安装 1.1.0、升级 1.1.1，最终源码 DEB 另做重装；配置与 secrets 的 SHA-256 保持一致。关闭自启动但正在运行的 Host 在重装后仍为 disabled/active。 |
| Linux 自启动与卸载 | 新用户通过 launcher 正常启用后返回 autostart=true、linger=true、registered=true；实际登记正确 Host/XDG 目录。最终包卸载 exit 0，产品用户单元移除，配置、凭据和 linger 保留。 |
| Android 更新 | 模拟器通过原生检查、认证下载、未知来源授权和 PackageInstaller 确认，从 1.1.0/code 2 覆盖到 1.1.1/code 3；已验证用户取消后重试安装。重开读取实际 1.1.1，原身份与聊天仍在，Host 恢复 ready/online。 |
| Android 最终源码 | 升级验收后，以 adb install -r -d 安装最终源码 debug 1.1.0/code 2；旧结果仍可读取，新增主聊天与 Hermes 查询成功。此操作仅针对指定模拟器。 |
| 发布元数据 | 实际 APK 包名、versionName、versionCode 和 ABI 与记录匹配；错误 APK 版本与 updater 签名版本会被拒绝。 |

配对恢复协议、维护门和正常卸载均已验收；先前已运行的失败恢复检查保留日志，不再增加故障注入。本轮未新增测试代码，只做端到端运行验证与必要构建。

## 环境与记录

- Windows：`D:/tmp/e-launcher-acceptance/`，含最终源码 APK、NSIS、历史和维护门记录。
- Linux：`/tmp/e-launcher-acceptance-20261106/`，含源码、DEB、安装/升级/卸载日志及隔离中心数据。
- Android：API 36 x86_64，固定选择 `emulator-5554`；操作前备份保留在 Windows 隔离目录。
- 临时中心 HTTPS 为 `https://localhost:28443`，后端为回环 `28543`；独立代理转发模型流量，未改现网模型服务。
- 测试凭据、备份和开发签名密钥只在仓库外私有目录。现网中心、Host 数据、设备凭据与公网路由保持原位。

收尾时停止隔离中心、测试 Host 和三个验收容器，保留日志与制品供复查。桌面和模拟器安装验证不替代物理机整机重启验收。

## 后续独立任务

1. Windows SCM、虚拟服务账户、原用户会话代理及跨账户 UAC；当前仍为登录任务模式。这些是未完成实现。
2. Windows 安装器完整覆盖升级与安装后恢复循环；当前只通过下载、验签、取消和维护门。
3. 正式 Android 旧签名身份/lineage、正式桌面 updater 签名材料及 GitHub/GHCR 云端发布。当前开发密钥不进入正式发布。
4. 再许可所需的 Ogesture、AGPL 来源及外部贡献权利证据；根许可继续保留。Pi 继续固定提交 35dfa757378bd7a8570670e99c2687bdd1039a06，待确认目标 bugfix 的正式版本后再切换。
5. ARM64 真机、Shower/语音/Widget 的完整发行回归与长期运行，另行按实际变更安排。

当前结果是本机主要功能验收与合并交付，不是上述后续任务或正式发行已经完成。未执行 push、公开发布或正式签名操作。
