<p><a href="assets/logo.png"><img src="assets/icon.png" alt="e-launcher" width="112" height="112"></a></p>

# e-launcher 独立 AI 助手

自托管中心管理模型、设备、Bot、插件、MCP、Skill 与客户端版本，Windows、Linux 和 Android 客户端连接同一中心。每台设备上的 Host 执行模型与工具，聊天、文件和设备能力保留在对应设备。Android 是普通助手应用，不申请默认 HOME，不提供桌面网格、图标包、小组件宿主或导航手势。

当前产品版本为 **1.1.0**，Android `versionCode=2`。发布与升级仍有未完成事项，见[开发及验收进度](docs/open-source-release-progress.md)；本机验收包使用独立开发签名，不作为正式发布包。

## 开始使用

1. 按[Linux 中心部署](docs/center-linux-deployment.md)启动中心，在自己的反向代理上配置 HTTPS/WSS。
2. 新数据目录首次启动时，从本地日志取得一次性初始化码，在网页设置所有者密码。随后在中心登记模型服务商、凭据和模型。
3. 安装客户端，填写中心地址与所有者密码。高级模式也可使用已有设备 ID、令牌和私有 CA。
4. 创建 Bot 并选择该设备上实际存在的工作目录。模型和能力在中心配置，设备回执显示实际应用状态。

中心网页、API、事件流和 `/v1/link` 共用内部 HTTP `8080`。对外只需一个 HTTPS origin；WebSocket 地址由该 origin 推导。中心进程通过内部调用控制 Relay，不向公网地址连接自己。

桌面程序关闭窗口后，已经运行的 Host 继续工作。Linux 使用 systemd 用户服务与 linger；Windows 当前实现仍是受保护的登录任务，Windows SCM、虚拟服务账户与用户会话代理尚未交付。首次配置和普通重连分别处理，用户关闭的自启动不会因普通重连而重新开启。详细操作见[桌面客户端](desktop/README.md)。

Android 客户端运行在独立 `:tauri_ui` 进程，Host 在默认进程管理的 Node Mobile 子进程内执行。关闭界面不停止已经受理的任务；退出客户端会停止对应生命周期。Android 未增加开机保活，Shower 操作仍需 Shizuku。见[Android 客户端](mobile/README.md)。

## Webhook 自动任务

中心管理页的“Webhook”可创建通用 JSON Bearer 入口，绑定固定设备、Bot 和任务指令；n8n、curl 等调用方提交事件后，由该设备的 Host 加入 Bot 现有主会话队列执行，结果回到 Bot 聊天。离线已登记的 Bot 也可作为目标，未派发事件最多等待 24 小时。

入口支持启停、删除、token 轮换和最近 100 个事件状态。token 仅创建或轮换时显示，离开详情即清除；停用不会中断已派发任务。请求必须带稳定的 `Idempotency-Key`，`202` 只代表接收成功。请求格式、n8n/curl 示例、幂等与生命周期语义见 [Webhook 使用说明](docs/webhooks.md)。

## Bot 看板

桌面侧栏「看板」与 Android 主页「Bot 看板」共用同一视图，汇总各设备的未归档 Bot：需要你（当前问卷或失败）、工作中、待查看（尚未查看的最新成功结果）、空闲；主动停止显示「已停止」，停止中的控制状态优先于尚未退役的问卷。窄屏可按状态筛选，支持搜索及隐藏空闲。

状态来自 Host 的只读 `getBotBoard`，不读取完整聊天、不启动模型或恢复任务，也不新增逐 Bot 实时订阅。页面可见时每轮结束约 2 秒后刷新，按 Host 每批最多 64 个 Bot、最多 4 个并发查询；离开或隐藏页面后停止发起查询，晚到旧身份响应丢弃。离线和读取失败保留本次客户端会话的最后已知摘要与更新时间，不代表当前已完成；不支持接口的旧中心或 Host 会显示不可用，并提示检查连接或更新中心与 Host。

点卡进入现有聊天回答问卷或停止任务，同时将卡上的成功结果标为已查看；同一已提交结果的正文经主聊天归属和当前搜索过滤后实际显示，也会同步标记（不追踪逐像素视口）；被过滤的 DM／群聊协作结果和搜索隐藏的结果不会自动标记。查看状态只在本客户端保存，按中心／profile、设备和 Bot 隔离，以 `lastResult.id` 去重，重连不重置。不会由空闲、预览文本或本机时间推断成功；摘要缓存不跨客户端进程持久化。

## 客户端更新

中心管理页的“客户端版本”支持上传安装包与构建元数据，保存草稿、发布和撤回。客户端连接中心后自动检查，持续连接时每 24 小时最多自动检查一次，也可手动检查。下载与安装由用户发起。

桌面端通过原生 Tauri updater 验证发布公钥、签名中的版本、摘要和大小。下载与验证不停止 Host；安装准备阶段暂停新任务准入，显示活动任务，可等待或显式停止后继续。Linux 安装包钩子负责保存、停止和恢复服务状态。

Android 使用原生认证下载、私有缓存和 PackageInstaller。安装未知应用权限与系统确认由 Android 提供；取消保留旧应用与数据。更新成功后，下次启动读取实际已安装版本确认结果。

正式发布的签名、版本、CI 和元数据命令见[发布说明](docs/releasing.md)。正式 Android 签名迁移、Windows 服务迁移及许可证来源核对的剩余项见[进度记录](docs/open-source-release-progress.md)。

## 目录与数据

| 目录 | 职责 |
| --- | --- |
| `center-server/`、`center-web/`、`center-contract/` | 中心服务、管理页与契约 |
| `host-core/` | 多端 Host、客户端 broker、工具、受管能力与固定 Pi 集成 |
| `desktop/` | Windows/Linux Tauri 客户端、Host 启动器及安装包钩子 |
| `mobile/`、`web/src/` | Android Tauri 外壳及共享 React 界面 |
| `app/src/main/`、`shower-server/` | Android 原生桥、生命周期、Widget、语音、更新与虚拟屏 |
| `pi-runtime/` | 保留的旧 Pi 集成与旧数据兼容 |
| `scripts/`、`docs/` | 构建辅助、操作说明及带范围的验收记录 |

Android 保留 `applicationId=com.example.launcherprobe`。Host 数据在应用私有 `files/bot-host`，客户端数据在 `files/bot-client`；旧聊天 SharedPreferences、`files/chat-attachments`、`files/pi-contexts`、`files/pi-workspaces` 和旧草稿继续保留。覆盖升级不清除这些路径。

桌面 Host 的配置和凭据分别为 `config.json` 与 `secrets.env`，已有 `dataRoot` 保留。桌面客户端身份、草稿、待发送记录与 Host 数据分开存放。凭据不放进命令行或 localStorage；手动配对的待确认凭据先保存到原生私有目录，以便响应丢失后沿用同一身份重试。

Pi 的六个核心包由 `scripts/pi-main.json` 固定到提交 `35dfa757378bd7a8570670e99c2687bdd1039a06`，显示版本为 `1.4.0-main.35dfa757378b`。尚未确认所需 bugfix 对应的首个正式版本，继续保留此 pin。rg/fd 按版本、摘要和许可随包分发，运行时只使用产品专用路径。

## 构建

需要 Node ≥ 22.19、固定 Rust `1.99.1`。Android 还需要 JDK 21、SDK Platform 36、NDK `28.2.13676358` 和 CMake `3.22.1`。开发运行时由 mise 管理；Rust 版本另由仓库 `rust-toolchain.toml` 固定。

```sh
mise exec node@22.19.0 -- npm ci
mise exec node@22.19.0 -- npm run prepare:pi-main
mise exec node@22.19.0 -- npm ci --prefix host-core
mise exec node@22.19.0 -- npm run center:build
mise exec node@22.19.0 -- npm run mobile:web
mise exec node@22.19.0 -- npm run desktop:build -- --bundles nsis
# Linux 使用 --bundles deb；系统依赖见 desktop/README.md。
```

Android 在 Windows PowerShell 中构建：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"
rustup target add --toolchain 1.99.1 aarch64-linux-android x86_64-linux-android
mise exec node@22.19.0 -- .\gradlew.bat :app:assembleDebug --no-daemon --console=plain
exit $LASTEXITCODE
```

默认构建 arm64-v8a；模拟器使用 `-PlauncherAbis=x86_64`。Gradle 会准备固定 Pi、Host、Tauri 前端与原生资源，不需要已不存在的 `npm run sync:android`。调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`，桌面安装包位于 `desktop/build/target/release/bundle/`。

外部开发者默认使用标准本地 debug key。维护者覆盖旧开发包时，显式传入 `-Pandroid.debugKeystore=<原密钥绝对路径>`，不能重新生成仓库 `debug.keystore` 或换包名来绕过签名检查。正式发布使用独立的受保护配置。

## 安装与旧导航恢复

使用匹配原签名的 APK 覆盖安装：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial = '<已授权设备序列号>'
& $adb -s $serial install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb -s $serial shell am start -n com.example.launcherprobe/.MainActivity
```

只有旧标记 `gestures.pending_restore=true` 存在时，应用才尝试把 `Settings.Global.force_fsg_nav_bar` 恢复为 `0`。读回成功且清除标记提交成功才完成；失败保留标记。没有标记不写导航值，不写 `1`，不修改无障碍服务列表或申请 HOME。

权限不足时，可使用设置页的 ADB、系统设置或显式 Shizuku 救援入口：

```powershell
& $adb -s $serial shell pm grant com.example.launcherprobe android.permission.WRITE_SECURE_SETTINGS
& $adb -s $serial shell settings put global force_fsg_nav_bar 0
& $adb -s $serial shell settings get global force_fsg_nav_bar
& $adb -s $serial shell am start -a android.settings.SETTINGS
```

完成后重开助手，确认系统导航可用并让应用清除恢复标记。旧版若曾成为 HOME，请在系统默认应用设置中选择系统桌面。

## 设备能力与验收

Android 保留原生语音、定时任务、分享草稿、系统助手和 RemoteViews 任务 Widget。Widget 不嵌入输入框或虚拟屏，点击打开客户端、详情或语音界面；冷态只读最后快照，不启动 Pi、Shizuku、Shower 或前台服务。普通事件至少 1000 ms 尾沿节流，开始、问卷、停止与终态及时刷新。

Shower 按 Bot/会话使用独立虚拟屏，保留授权、归属校验及空闲回收。Linux 使用私有 Xvnc 与轻量桌面；Windows 图形能力需要所属用户的交互会话，Android 需要 Shizuku。截图、输入、语音、Widget 和后台调度分别按实际设备验收，详见[跨平台 Shower](docs/shower-cross-platform.md)与[Android 客户端](mobile/README.md)。

本次三端运行结果与未覆盖项见[进度记录](docs/open-source-release-progress.md)。历史模块验收以各文档记载的提交与范围为准。截图、日志、备份和开发密钥保存在仓库外；本轮未新增测试代码。

## 源码与许可证

根 [LICENSE](LICENSE) 保留现有 AGPLv3，未直接改为 LGPL。Operit Shower 的 LGPL 派生源码、其他第三方代码及固定版本归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [licenses/](licenses/)。分发修改版时须提供适用许可证要求的对应源码与构建材料。
