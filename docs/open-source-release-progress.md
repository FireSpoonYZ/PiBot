# 开源发布与客户端更新进度

更新日期：2026-11-06。本文记录本次进度快照，整体实现和验收仍在进行。

实施依据：[开发方案](open-source-release-and-update-plan.md)；辅助资料：[方案调研](open-source-release-solutions-research.md)。

## 当前状态

主仓库已合入中心单入口、客户端版本管理、更新界面、Android 原生更新链路、桌面原生 updater 初步实现及发布基础。产品目标版本为 `1.1.0`，Android `versionCode=2`。

本提交保存主仓库当前代码、两份设计文档和本进度记录。隔离工作区中尚未验收的产物另列于下表。当前不是正式发布完成状态。

## 已合入主仓库

| 范围 | 进度 |
| --- | --- |
| 中心与 Relay | 共用单个 HTTP listener，默认端口 `8080`；公共 HTTPS origin 推导 WSS 地址；中心通过进程内入口调用 Relay；Compose 默认只发布宿主回环端口。 |
| 客户端版本服务 | SQLite schema v5；独立客户端发布记录；Owner 上传、发布、撤回；设备认证查询及下载；向前版本选择；流式保存安装包和计算摘要。 |
| 中心管理页 | 客户端版本列表、上传和发布操作；元数据及签名文件读取限额、平台组合等前端校验；契约类型和 API 接线。 |
| Host 身份 | `expectedDeviceId` 贯通存储、Host、服务和 CLI；新增 `identity`；新库可按指定 ID 初始化，已有库遇到不匹配时拒绝修改身份。 |
| 共享更新界面 | 状态、说明、进度、检查、下载、取消和安装；隔离旧操作结果；Android 授权返回后的继续安装入口；Host 连接页避免普通重连重新启用自启动。 |
| 桌面 updater | 五个原生命令；同源 HTTPS、重定向限制、大小和摘要校验；官方 updater 签名验证；连接代次和操作状态隔离。仍待完整 launcher、包生命周期及运行验收。 |
| Android updater | Rust/Kotlin/私有 Binder 接线；原生凭据快照及有界连接确认；下载、缓存校验；PackageInstaller 会话、权限引导、结果接收及重启后实际版本确认。 |
| Linux 服务 | 用户服务配置、受限登记 helper、DEB 生命周期脚本初稿；后续审查修正版尚待合入。 |
| 随包搜索工具 | 固定版本、摘要和许可材料的 rg/fd 构建期准备；桌面使用随包路径，Android 使用应用私有路径；取消 PATH/Pi 工具目录回退。 |
| 发布基础 | 根产品版本、Android debug/release 签名分离、Rust `1.99.1`、GitHub/GHCR 流水线初稿、元数据脚本及秘密文件忽略规则。流水线复核修正版尚待合入。 |
| 旧数据保留 | 移除首次清理时删除 `scheduled_tasks`、`schedule_calendar`、`task_widget`、`task_notifications` 偏好的代码；保留旧系统组件撤销及导航恢复逻辑。 |

桌面和移动端 Cargo 锁文件已更新。主仓库 Host launcher 仍为 `1.0.0`，待统一 launcher 实现合入后同步到 `1.1.0`。

## 已产出、尚待审查合入的工作

隔离工作区位于 `/workspace/e-launcher-release-lanes/`。这些修改尚未包含在本次主仓库提交中。

| 工作区 | 内容及状态 |
| --- | --- |
| `lane-4` | Windows SCM、受限 UAC、保护目录、原 owner 登记、身份接管及统一 launcher。首轮 worker 达到 30 分钟时限，已按同一 Terra max 模型恢复，继续现有修改。Linux 登记新增实际 XDG 配置目录的调用也由该 lane 接线。 |
| `lane-9` | 发布流水线复核修正版：固定 CLI 接入、Windows shell 参数、GHCR 小写命名及分支标签隔离、单一 Release 汇总、正式签名身份和 lineage 验证、实际 APK 元数据核对。 |
| `lane-11` | Host 更新维护门、真实活动量判断、停止与取消、关键异步入口复核；移除 Host 启动时主动等待 Shower 授权。 |
| `lane-12` | Windows per-machine NSIS 配置、固定 Tauri CLI 2.12.4 模板及安装、升级、恢复和卸载钩子。 |
| `lane-13` | Windows Shower 原 owner 会话代理和受限本机 IPC。独立审查发现路径重解析边界、授权超时后继续执行和重连清理窗口等问题，需修正后合入。 |
| `lane-14` | 当前安装与开发文档、许可来源盘点、GPLv3 和固定 Pi 提交的 MIT 文本；根 `LICENSE` 未改。需随最终代码及验收结果同步。 |
| `lane-19` | Linux DEB 脚本复核修正版：保留首次状态快照、失败留修复记录、登记实际 XDG 配置目录、以目标 UID 清理固定产品路径。需与 launcher 第二参数一起集成。 |

后续 worker 统一使用 `openai/gpt-6.1-terra:max`，并发上限为 10；worker 只做静态开发，运行验收由父助手执行。

## 已执行的验证

| 验证 | 结果及范围 |
| --- | --- |
| 中心管理端构建 | 最新已合入代码的 TypeScript 检查和 Vite 生产构建通过。 |
| 移动端 Web 构建 | 最新共享更新界面的生产构建通过。 |
| 中心 HTTPS 入口 | 实际反向代理下完成 Owner 登录；匿名发布 API 返回 `401`，错误元数据返回 `400`，缺 CSRF 的修改请求返回 `403`。 |
| 管理页交互 | 已验证登录、版本列表和上传对话框；最新校验修改仍需补交互复查。 |
| Host 与中心身份一致 | 以同一设备 ID 登记并启动 Host，中心显示在线，Host 的 Relay 为 online、配置为 ready。 |
| 进程内 Relay 调用 | Owner 查询不存在 Bot 的工作目录，经内部 `listBots` 返回预期 `404`，未通过公开 WSS 自连接。 |
| SQLite 身份保留 | 指定 ID 首次初始化和再次读取一致；不同预期 ID 返回 `IDENTITY_MISMATCH`，原身份保留。 |
| Android 工具准备 | x86_64 rg/fd 的 NDK 准备已通过；真实搜索验收待补。 |
| Android debug APK | 包含新增更新桥、管理器、安装器及旧偏好保留修改的 `assembleDebug` 通过；ABI 为 x86_64，无官方签名秘密。 |
| Android 模拟器基线 | Android 36 模拟器已安装并启动先前 debug 构建，核对版本 `1.1.0` / code `2`，未观察到 `AndroidRuntime` 崩溃。新增更新链路尚未在模拟器完成覆盖安装。 |
| 桌面构建 | 较早 Linux launcher 构建及资源准备通过。最新 prepare 遇到 Cargo 锁文件未更新，现已更新锁文件；完整桌面应用和安装包需重新构建。 |

详细日志、临时凭据和开发签名材料保存在仓库外的 `/tmp/e-launcher-release-20261106/`，不纳入 Git。未新增测试代码。

## 下一步

1. 完成并审查统一 launcher，合入 Host 维护门及 NSIS/DEB 钩子，核对各端 CLI、状态和安装恢复契约。
2. 补齐配对幂等协议：客户端先持久化固定设备 ID 和注册凭据；中心同 ID、同凭据重试可恢复，异凭据拒绝；显式重新配对单独旋转凭据。当前中心尚无该扩展或 HTTP 旋转端点。
3. 统一新设备 ID 的长度和 HTTP 头可承载字符校验，避免非法首次 ID 写入后无法连接。核对中心发布记录与实际制品架构、版本的一致性。
4. 修正 Windows Shower 独立审查问题，核对保护登记、数据根及原用户会话身份。
5. 完成三个产品 crate 的版本和锁文件同步，重跑桌面、Android 及可用 Windows 交叉构建；合入发布流水线复核修正版。
6. 执行 Linux DEB 安装、升级、禁用自启动、手动运行、失败恢复及卸载循环。
7. 在 Android 模拟器实际验证更新检查、认证下载、未知来源权限、系统确认、取消、失败、覆盖安装、下次启动确认及原身份和数据保留。
8. 验证随包 rg/fd 在没有系统或 Pi 工具回退的环境下完成真实搜索，检查各分发包的许可和源码材料，再更新最终验收记录。

## 外部材料与发布阻断

- 正式 Android 旧签名身份、必要旧私钥或有效 lineage 尚未取得和核实；开发签名验收单独记录。
- 正式桌面 updater 签名材料尚未配置。仓库外的临时开发密钥仅用于本地验收。
- Windows SCM、跨账户 UAC、会话代理、重启及实际安装恢复尚无 Windows 运行结果。
- Ogesture、其他 AGPL 来源及外部贡献的再许可权利仍需证据，根许可证继续保留现状，不能直接声明全部源码已改为 LGPLv3。
- 用户所指 Pi bugfix 的准确 PR/commit 及首个包含修复的正式版本尚未确认，继续保留现有固定提交。

未执行 push、公开发布或正式签名操作。
