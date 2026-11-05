<p><a href="assets/logo.png"><img src="assets/icon.png" alt="e-launcher" width="112" height="112"></a></p>

# e-launcher 独立 AI 助手

普通 Android AI 助手应用，安装后显示为 **AI Assistant**，保留 Pi SDK 数据、后台与定时任务、通知、分享草稿、语音会话、系统语音助手、唤醒和朗读，以及 Shower 虚拟屏与接管。可把标准 Android App Widget 添加到其他桌面，不再充当默认 HOME，不提供桌面布局、应用网格／全局桌面搜索、壁纸／图标包管理、小组件宿主、模拟导航手势或自定义应用切换页。

## 界面与数据

普通桌面图标、旧聊天 Intent 和 Host 入口启动 `TauriMainActivity`（独立 `:tauri_ui` 进程，`exported=false`），由 Tauri 承载 `mobile/web/` 与既有 `web/src/` 的 HostPage；`MainActivity` 仍是导出的 singleTask Capacitor `BridgeActivity`，保留旧设置、定时任务和显式旧 Host 待确认入口，不再打开旧聊天界面。任务详情、语音会话和分享确认使用 Android Java Activity；Widget 使用 Java `AppWidgetProvider` + `RemoteViews`/XML。应用目录查询与显式启动仍服务于助手和 Shower，不是桌面功能。`LauncherVoiceInteractionService` 等三个原系统语音组件名有意保留，以保持系统助手身份。界面架构、命令与构建见 [Tauri Android 界面](mobile/README.md)。

覆盖安装保留 `applicationId=com.example.launcherprobe`、包名、原签名及数据路径：聊天仍在私有 `chat` SharedPreferences，附件在 `files/chat-attachments`，Pi 上下文在 `files/pi-contexts`，全局配置在 `files/node/.pi/agent`，会话工作区在 `files/pi-workspaces`。旧未发送草稿及附件保留；不要清除数据、卸载重装或换签名来完成迁移。

## Pi Agent 与设置

Pi 模式接入固定版本 **1.1.0** 的完整 coding-agent SDK，提供模型、思考强度、原生工具与扩展、压缩重试、资源及包管理和 OAuth。当前聊天的模型选择与启动默认值分开保存。聊天输入栏的历史分支和思考强度按钮仅在键盘显示时出现；调整思考强度后浮窗保持打开，点击窗外返回输入栏。

独立设置页保留通用、外观、服务商、技能、MCP、扩展、关于七类，其余配置放入高级配置，覆盖文档中的 71 个 settings 字段。MCP 页管理真实 stdio／Streamable HTTP 服务器，支持工具检查、启停、作用域、exposure 与 OAuth；不再把安装扩展当成连接 MCP。检查状态只代表最近一次探测，聊天通过 Pi 官方 MCP 工具管道连接；设备验证与命令支持边界见 [Pi runtime](pi-runtime/README.md#mcp-servers)。所有 Pi 设置表单、资源／包和 JSON 编辑器统一使用应用全局私有配置，跨会话共享；旧工作区配置保留但不再生效，不自动迁移或删除。每个会话仍有独立工作目录、附件／工作文件、AGENTS 上下文和当前模型选择。支持自动格式化、未知字段和数字写法保留、草稿、冲突检查及上一版。开放式模型与兼容性结构可直接编辑完整 models.json。

界面支持跟随系统／中英文、浅色／深色、助手背景图片预览和遮罩。扩展页可直接输入 npm 包名安装，“更新全部”会更新所有未固定版本的包，扩展社区使用 npm 公开元数据并提供搜索和分页；配置状态、SDK 找到的安装路径与成功加载分别说明。APK 内置与 Node 24 兼容的官方 npm 11.6.2，无需 Termux 或系统 npm；Git 来源仍需要对应系统命令。安装第三方包可能执行 lifecycle 脚本和代码，请仅使用可信来源。安装成功后会重新读取资源并报告加载、停用／过滤或错误状态，当前聊天下一次发送时使用新扩展。

内置 `conversation-title` 扩展在每轮正常回复完成后生成概括性短标题，对话选择页与任务 Widget 共用该标题。在「高级配置 → 模型与思考 → 标题生成模型」填写 `provider/modelId`，也可编辑全局 `~/.pi/agent/settings.json` 或工作区 `.pi/settings.json`：

```json
{
  "conversationTitle": {
    "model": "openai/gpt-4o-mini"
  }
}
```

请填写 Pi 模型目录中实际可用的服务商和模型 ID；模型沿用 Pi 的 `models.json`、API key 或 OAuth 配置，与聊天模型单独选择。工作区设置覆盖全局设置，下次发送生效。未配置或填空字符串时停用自动标题；生成失败、超时或取消时保留原标题。生成请求仅包含原始目标和最近几条对话文本，最多等待 15 秒，不作为聊天消息保存。标题写入原生 `session_info`，随会话上下文持久保存。

运行时集成和依赖准备见 [运行时与构建说明](pi-runtime/README.md)。

## 远程终端

会话抽屉中的“远程终端”可连接 e-desktop 托管的 PowerShell、Bash 或 Nushell 会话，也可控制其中运行的 Pi、其他 agent 和 TUI 程序。电脑端先打开“终端”生成五分钟一次性配对信息，在手机端粘贴并选择可达地址；默认端口 7768，支持局域网 / Tailscale。连接使用证书指纹固定的 WSS，设备令牌仅保存在 Android 原生私有存储中。

终端页提供查看 / 接管、辅助按键、Ctrl/Alt/Shift 组合、中文输入和硬件键盘、TUI 滚动、字体与视口调整。快捷预设可新增、编辑、排序和删除，支持组合键与文本宏；文本宏是否追加 Enter 必须明确设置。预设只保存在本机。离开页面或手机断线不会结束电脑 shell；重连读取同一会话的终端快照。当前仅支持文本终端，不包含远程桌面画面或终端图片协议。

远程终端独立于现有本机 Pi SDK 聊天。原生接口与校验说明见 [Android 连接层](docs/remote-terminal-android.md)，Orca 复用来源及限制见 [来源说明](web/src/RemoteTerminal/ATTRIBUTION.md)。

## Linux Shower 虚拟桌面

Linux Host 的 Shower 在独立 Xvnc 显示中启动轻量桌面，包含 `xfdesktop` 背景和 `xfce4-panel` 的应用菜单、窗口任务切换；应用菜单显示本机已安装且可在该会话运行的应用。必须预先手动安装 `Xvnc` 或 `Xtigervnc`、`xfwm4` 或 `openbox`、`xfdesktop`、`xfce4-panel`（含应用菜单与任务列表插件及其 XFCE 配置服务）、`xfce4-terminal`、`xauth`、`dbus-daemon`、`xdotool` 和支持 `x11grab` 的 `ffmpeg`。缺少程序时报告依赖错误，不自动安装；具体包名依发行版而异。

每个环境使用私有 DISPLAY、Xauthority、运行目录和 D-Bus；桌面配置放在会话私有目录并预置面板和配置版本，避免首次配置向导及修改真实桌面设置；`VNC-0` 显示器的工作区 0 默认使用深灰蓝纯色背景，并将 XFCE 默认终端设为 `xfce4-terminal`。其他显示器名称不受该背景配置覆盖。面板启动的应用继承该桌面配置目录；通过 Shower 进程启动的应用保留原有配置环境。创建成功需要桌面和面板窗口就绪，关键进程退出会报告错误；不以全黑画面作为故障判据。释放或创建失败时清理本会话启动的组件及私有目录，不连接或回退到物理桌面。背景、菜单、窗口切换与输入仍需在目标 Linux 机器人工验收。

## Android 平台能力

Pi Agent 是聊天的唯一执行路径。内置 `shower` 工具使用 Operit Shower：按需通过现有 Shizuku 授权启动应用自有的 Binder-only 服务，为每个聊天分别创建一块虚拟屏，并在该屏启动 App、截图、点击、滑动、输入中文等 Unicode 文字、复制粘贴、发送受限按键和释放屏幕。宿主根据已登记的请求绑定聊天归属，不接受模型传入的聊天或屏幕 ID；服务端只接受本应用 UID 对非零虚拟屏的操作。不会退回或转发到手机主屏。历史会话中的旧工具调用与结果保留用于显示；继续对话时会作为不重新执行的历史上下文交给 Pi。

`shower` 必须先 `create`，服务未运行时会自动启动，同一聊天可复用已有屏幕。每块屏幕独立计算空闲时间：5 分钟没有工具操作后自动销毁，执行中的操作不会被回收；最后一块屏幕关闭后服务空闲 15 秒退出。`release` 和删除聊天只释放对应屏幕，切换聊天、停止生成及回复结束不会立即释放。超时后的操作会提示重新 `create`，需要重新启动应用并截图定位。同一应用不能被不同聊天的虚拟屏同时占用；系统剪贴板仍共享，但一次 `text` 的写入与粘贴会串行完成，避免被另一聊天的输入插入。默认虚拟尺寸和密度采用手机主屏当前设置的完整逻辑分辨率与密度；坐标始终是 create 返回的虚拟屏坐标。截图通过 Binder 文件描述符传输，避免大 PNG 进入 Binder 事务，并可按 `maxWidth` / `maxHeight` 等比缩小；工具结果同时返回虚拟屏与图片尺寸，PNG 作为 image content 保存到聊天附件。先点击输入框，再用 `text` 全选并粘贴替换全部内容；空文本或 `clear` 清空输入框。`copy(text)` 写入系统剪贴板，`paste` 在光标处粘贴或替换选区；`key COPY/CUT` 操作选区，`key A` 配合 `CTRL` 全选。系统剪贴板与主屏应用共享，`text` / `copy` 会覆盖剪贴板；触摸和按键仍只发往虚拟屏。网页、虚拟屏和工具输出均是不可信数据，动作被系统接受后仍须再次截图验证。继续对话时，每次模型调用只带上最新一张 Shower 截图的图片；更早的截图图片会从这次上下文副本里去掉，并保留原有文字、调用编号和其他图片。已经保存的会话消息和附件不会被改写。

当前聊天使用 Tauri 客户端。旧聊天界面入口已停用，旧会话、草稿与附件仍保留原路径，不自动迁移到新客户端；旧 Host 待确认和显式导入入口仍可使用。系统分享需确认，仅保存到所选旧会话草稿、不自动发送或转入当前客户端，保存后可打开客户端。旧语音与任务详情中的客户端入口不再定位旧会话。发送内容及工具结果会交给用户配置的模型服务；公开网页请求会直接访问相应站点。

### 标准任务 Widget

在系统桌面的小组件选择器中添加任务 Widget；可调整宽高，多个实例分别记住所选会话。卡片沿用原任务卡的圆角、配色、状态胶囊、任务计数和步骤条；上下箭头切换会话，点击正文进入该任务详情。底部为「归档／停止」与「打开客户端」；前者绑定当前卡片，后者打开 Tauri 而不定位旧会话。停止中禁用左侧按钮；空态也可打开客户端。旧归档列表入口不再显示，删除 Widget 不删除任务或聊天。

卡片尺寸和外部间距由桌面宿主分配；步骤条保留原节点图形和文字，以静态图显示当前步骤附近的内容。标准 `RemoteViews` 未复刻旧桌面的实时壁纸模糊、节点旋转动画与条内横向滚动。

`RemoteViews` **不能内嵌可编辑的聊天输入框**，也不展示虚拟屏或嵌入问卷作答。需要打字时打开客户端，出现问卷时打开详情回答；没有伪装成输入框的 `EditText`。虚拟屏预览与手动接管仍在详情页。

更新来自任务事件：开始、问卷、停止、终态、归档和删除及时更新，普通状态与文字流采用至少 1000ms 的尾沿节流，不跟随 40ms 文字流刷新。系统定时刷新关闭（`updatePeriodMillis=0`）。私有 `task_widget` 偏好仅保存有界展示快照；系统恢复或进程不存在时仅读最后快照，保存时间与「上次状态」保留在无障碍描述中。卡片状态不作实时运行保证，刷新不会启动 Pi、Shizuku、Shower 或前台服务。

### 任务详情与实时桌面

Widget 不显示虚拟桌面；进入任务详情页后，有关联虚拟屏的会话优先显示大画面，任务步骤和最新回复可从底部展开。画面使用 Android `VirtualDisplay.setSurface` 直接送入本机 `TextureView`，无截图轮询、网络传输或额外视频解码。画面按实际虚拟分辨率等比显示，可切换全屏；返回详情或切换应用后会解绑预览并恢复原 Surface，AI 截图和原屏幕继续可用。详情页只观察已存在的虚拟屏，不启动 Node、Shizuku 或新建屏幕。

点击「接管操作」后可直接点击、长按、拖动、滑动和多指操作。该会话后续的 `shower` 工具调用等待接管结束；已等待的非截图操作不会直接重放，而是提示 AI 先截图重新定位。结束接管、离开详情或画面释放都会解除等待。导航栏提供虚拟屏返回、应用列表、最近打开的应用和文字输入；最近应用来自本虚拟屏成功启动记录，不是手机系统任务列表。应用列表替代全局 HOME/RECENTS，避免某些 ROM 将按键送往主屏。文字输入可替换当前焦点输入框（最多 1000 字符），并提供退格、回车。页面给手机系统侧边和底部手势留出空间。

### 新界面的 Bot 屏幕

新版（Tauri）界面里，聊天页「更多 → 右侧控制面板」或 Bot 资料页「电脑 / 屏幕控制」打开右抽屉，显示该 Bot 的工作屏幕，可一键全屏。新 Host 中**每个 Bot 一块屏**，主私聊、群与 DM 共用；面板只观看已存在的屏幕，不创建屏幕，也不启动 Host、Shizuku 或 Shower，观看期间屏幕不会被空闲回收。画面由独立进程 `:tauri_ui` 的原生 `TextureView` 覆盖在网页占位区上，Surface 经私有 Binder 服务 `BotScreenService` 交给 Shower 直接写入，无截图轮询或编解码。

右下角唯一的「接管操作」按钮：先中断该 Bot 当前对话（与停止按钮相同），再中断其在途屏幕动作并等其结束，然后才接受触摸（点击、长按、拖动、多指）。没有「交还」按钮，之后 Bot 与用户可以同时操作，冲突由用户自行处理；Bot 接管后第一次非截图动作会返回未执行错误，必须先截图按当前画面继续。关闭面板、离开聊天或切到后台会解绑画面并结束本次接管，重新打开后需再次接管。远端 Host 的 Bot 暂不支持预览，跨设备协议只定义了接口（`web/src/screen/types.ts` 的 `RemoteScreenMethods`）。

模拟器／设备检查需已运行并授权 Shizuku，安装 `:app:assembleDebug` 和 `:app:assembleDebugAndroidTest` 的 APK 后执行：

```powershell
& $adb shell am instrument -w -e checks shower-preview -e artifactDir /sdcard/Android/data/com.example.launcherprobe/files/acceptance com.example.launcherprobe.test/com.example.launcherprobe.ChatStoreChecks
```

此检查使用临时会话和系统设置应用，不调用模型；验证连续画面、触摸后画面变化、预览期间 AI 截图及退出后继续操作。测试会删除临时会话，截图写到显式 `artifactDir` 参数目录中的 `shower-preview-check.png`；拉取到电脑时必须使用仓库外目录。历史设备结果不能代表此次迁移通过，刷新率、键盘与 ROM 差异仍需设备验收。

锁屏检查使用 `checks=shower-lockscreen`，开始前解锁测试设备并授权 Shizuku：

```powershell
& $adb -s <serial> shell am instrument -w -e checks shower-lockscreen -e artifactDir /sdcard/Android/data/com.example.launcherprobe/files/lockscreen-check com.example.launcherprobe.test/com.example.launcherprobe.ChatStoreChecks
```

检查会暂时启用系统锁屏，将显示超时设为 15 秒并关闭充电常亮，随后锁屏闲置 30 秒，验证虚拟屏截图有内容、滑动改变画面、主屏保持锁定和关闭、释放后屏幕消失。结束时恢复这些设置并唤醒测试设备；若配置了密码，需要人工解锁。证据包含操作前后 PNG 和 display/power/window 状态，拉取到仓库外保存。ADB 按键与输入仅验证自动化路径，模拟器结果不代表厂商 ROM 真机通过。

Shower 对存活的独立虚拟屏每约 4 秒报告显示活动，保留原有 5 分钟空闲回收。Android 14+ 截图直接调用 WindowManager 获取目标虚拟屏，避免临时镜像屏随主屏休眠；Android 13 保留原截图路径。

### 定时任务

聊天页左侧会话抽屉的「新会话」下方提供「定时任务」入口。管理页支持创建、编辑、启用／暂停、删除及执行记录；周期设置与主表单共用一个底部面板，返回时保留主表单，关闭未保存的修改时会确认。助手内置 `schedule_task`，可 list、create、update 和 delete。update 只提交要改的字段，宿主按当前 revision 合并未提供的规则并保留启用或暂停；revision 不一致或任务已删除会返回错误，不会自动再提交一次。返回里的 `exactAlarmGranted` 为 false 或 `schedulingError` 非空只表示任务已保存，精确闹钟尚未排上，不能当成到点一定会执行。

- **每天**：指定时、分。
- **每周**：指定周一至周日中的一天或多天及时间；固定「周一至周五」「周六日」保持原任务语义，不会升级为法定规则。
- **法定工作日 / 法定节假日**：独立保存的规则。工作日包含周末调休补班；节假日表示全部休息日（普通周末与公告放假，排除补班），不是工资计算中的法定节日本日。
- **每月**：指定 1–31 日及时间；当月没有该日期时跳过当月。例如每月 31 日在 4 月不执行，下一次为 5 月 31 日。

中国大陆日历内置已核验的 **2026 年** 国务院放假、补班安排，无网络也可执行；来源和 MIT 许可见 `THIRD_PARTY_NOTICES.md`。打开／编辑法定任务及法定任务闹钟执行后，后台每日最多尝试一次从 NateScarlet/holiday-cn 获取当前年、次年已公布安排并原子缓存到应用私有存储，不必等待应用更新；空占位、网络失败或坏数据保留最后有效缓存和内置数据。本次预览／触发不等待网络，成功刷新只重排未来法定任务。大陆设备时区 `Asia/Shanghai`、`Asia/Urumqi`、`Asia/Chongqing`、`Asia/Harbin`、`Asia/Kashgar` 与 `PRC` 使用当地日期查询，不以语言或 UTC 偏移判断国家。其他时区（含香港、澳门、新加坡、台湾）选择法定规则时显示「所在国家或地区暂不支持法定节假日查询」，分别暂按周一至周五／周六日执行；未知年份、数据加载失败也明确提示退化，不猜测安排。预览显示可用数据覆盖年份；切换时区保留法定意图，切回大陆恢复日历判断。时间跟随设备时区，界面通过原生规则预览下次执行；修改系统时间或时区后重新安排。夏令时不存在的本地时间由 `java.time` 向后调整，重复的本地时间只选择第一次。

任务仅使用 Android `AlarmManager`，不新增 WorkManager、非精确闹钟兜底或常驻保活；定义和执行记录保存在应用私有存储。新建任务默认 `alarmMode: 'alarmClock'`，使用 `setAlarmClock`，系统可显示下一次闹钟，点击系统入口打开对应任务页 `/schedules?taskId=<id>`（支持冷／热启动）。旧任务缺少该字段时保留为 `exact`，使用 `setExactAndAllowWhileIdle`，不提供系统下一次闹钟入口。页面和工具均可切换模式，更新未提供 `alarmMode` 时继承原值；两种模式分别安排最早的闹钟，不互相遮挡。需要在系统「闹钟与提醒」中授权；权限不足仍保存任务并显示等待授权，调度错误保留供重新打开页面查看。

闹钟迟到与恢复共用 **15 分钟（含边界）** 上限：窗口内只补跑一次，超过窗口记录 `skipped / missed`，不重放多个历史周期。开机、应用更新或回到前台恢复时，只保存待执行记录并重新注册近期闹钟，不直接启动 Agent 或前台服务；恢复授权后重新排程。显式修改系统时间或时区按新本地规则重排，不补跑旧时区事件。同一任务上次尚未结束时，本次按 `overlap` 跳过，避免重复提交。

待执行记录 `queued` 持久保存后可在进程恢复时继续安排；调用 Pi 前先保存 `starting`。仅确定尚未提交到 Pi 的同步启动失败允许有限重试：**总计最多 3 次尝试**，两次重试分别延迟 **60 秒、120 秒**，且不得超过原定执行时间后 15 分钟。执行记录展示等待／启动状态、尝试次数和下次重试时间。已被 Pi 接受的请求不重放；旧进程遗留的 `starting / running` 结果不明，恢复时记为 `interrupted`，不自动重试不确定的外部操作。

每次执行创建独立会话，使用全局默认模型，不改变当前聊天或未发送草稿；旧执行会话与记录保留，但不再提供旧聊天界面入口。历史保留最近 100 条，活动的 `queued / starting / running` 不因该上限被截断。暂停、删除或修改定义会取消尚未开始的旧待执行项，不停止已启动的会话，也不删除会话或历史；一次性任务到点自动停用不会取消自身待执行项。勾选「完成后删除」（`deleteAfterRun`）后，仅在 `completed` 终态删除对应且未被用户修改或重新启用的定义，失败或中断保留。`completed` 只表示 Pi 回合正常结束，不保证外部操作目标已达成。

强行停止应用（force-stop）、撤销权限及系统后台限制仍可能阻止或中断执行；不保证关机或重启后首次解锁前运行。Node 启动故障可能持续到应用进程重启，有限重试不是 Node 自愈机制，也不新增独立 Node 进程。普通定时任务不需要 Shizuku，仅任务中的 Shower 手机操作需要对应授权与服务。

浏览器界面检查：`node scripts/check-schedules.mjs`，使用 Chrome／Edge 和内存原生桥接样例验证真实 React 页面，截图保存到系统临时目录；`--serve` 可打开本地设计对照页面。此检查不会创建 Android 闹钟或调用模型，不能替代真机后台执行验证。原生周期和持久化回归见 `ScheduleRuleTest` 与 `ScheduledTasksTest`。

设备定时执行检查：构建并覆盖安装对应 ABI 的调试 APK，配置默认模型后，运行 `node scripts/check-scheduled-alarms-device.mjs --serial=<设备序列号>`。脚本同时支持明确指定的手机或模拟器，先确认没有运行中的会话，再分别创建系统闹钟和精确定时短回复任务，验证后台进程回收、锁屏触发、实际 Pi/模型回复、无重复记录及完成后删除，并检查任务入口。它不强行停止应用、不替换模型配置或整份定时偏好，只清理自己创建的任务定义，保留执行会话和记录，不切换当前聊天。验收前后比对已安装 APK 与当前 worktree 调试包的 SHA-256，截图和报告写入系统临时目录。ROM 忽略 `am kill` 时，脚本通过调试应用自身 UID 的 `SIGKILL` 模拟进程丢失，不设置应用的强行停止状态。此检查不覆盖关机、强行停止、长时间 Doze、Shizuku 手机操作或启动失败重试的故障注入。

## Android Host（Bot/Host 核心）

Android 应用内集成 Host 核心：在受监督的独立 Node Mobile 子进程中运行 Pi Durable/chord/pi-ai **1.3.0** 与内嵌 acp-kernel **0.0.101**，旧 Capacitor 入口保持不变。Host 提供 Bot 登记、持久消息账本、工具（含 grep/find）、工作上下文与长期记忆；旧数据迁移已交付（父限定范围验收，见 host-core 模块 16）；M18 的 Tauri 只提供独立 `:tauri_ui` 界面外壳（见 [mobile/README.md](mobile/README.md)），Host 仍在默认进程的 Node Mobile 子进程运行。

- **使用入口**：打开客户端时启动 `specialUse` 前台生命周期并尝试启动本机 Host；Host 所需中心配置尚未设置或启动失败时在状态/通知中显示错误，保存配置后重新启动。冷启动仍须中心完成初始化；网络恢复或客户端重新连接中心后会延迟重试失败的已配置 Host。客户端在后台、锁屏或中心断网时仍持有已运行的 Host；Host 子进程意外退出后按退出事件延迟重启。通知或设置中的「退出客户端」先撤销恢复并回收子进程，保留凭据和业务数据；断开中心只断开中心。没有新增开机自启、轮询或闹钟保活。
- **首次绑定与引导**：新装后按引导只输入中心地址与所有者密码即完成绑定并自动连接（本地桥 `pairCenter`，原生侧完成 owner 登录与 Android 设备注册）；密码不落盘、设备 token 只存原生加密存储，手动高级模式保留。引导同时只读检查通知、电池与 Shizuku 状态（`onboardingStatus`/`onboardingAction`，仅前台显式动作）；设备重启后 Shizuku 服务停止，需重新启动。中心自部署见 [Linux 中心部署](docs/center-linux-deployment.md)，接口细节见 [mobile/README.md](mobile/README.md)。
- **旧聊天导入与新 Host 定时任务**：设置中的 Local Host / Legacy import 面板可列出旧会话，显式预览（单独选 role/cwd/model）后导入；导入的草稿仅手动追加到对应 Bot，不自动发送。新 Host 定时任务（schedule_task）只在 Host 运行时执行，离线错过不补发。详见 [host-core/README.md](host-core/README.md) 模块 16。
- **配置与数据**：Host 运行数据位于独立 `files/bot-host`；模型凭据与语音偏好分别在 `bot_host_credentials`、`bot_host_voice`、`bot_host_voice_secrets` SharedPreferences（不在 files/bot-host 内），与旧聊天数据隔离；模型/语音由用户配置，系统语音入口仍走 Android 原生路径。
- **构建与许可**：构建命令与前提（JDK/AGP/NDK/CMake/Node/Rust 目标及自动 prepare/bundle）见 [host-core/README.md](host-core/README.md) 模块 15，M18 界面见 [mobile/README.md](mobile/README.md)；依赖与 NDK 搜索工具（rg/fd）许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 构建与检查（Windows PowerShell）

JDK 21、Gradle 8.14.3（仓库内 `gradlew`）、Node **≥ 22.19**、SDK Platform 36、AGP 8.13.0 / NDK 28.2.13676358，最低支持 Android 13（minSdk33）、targetSdk36；Android 10–12 不再支持。运行时网络使用 OkHttp 3.14.9。首次构建需下载 Gradle 发行包与构建依赖并接受 SDK 许可。先运行 `scripts/prepare-pi-runtime.ps1` 准备 Node Mobile、SDK 资源和锁定完整性的官方 npm 11.6.2 payload；JavaScript 改动后运行 `npm --prefix pi-runtime test` 重建并测试 bundle。Gradle 从 `shower-server/` 的固定来源构建精简 Binder-only APK，并以 `shower-server.jar` 生成到 App assets；不需要 Python、Lamda payload 或外部部署脚本。构建还会把真实 arm64 Node executable 以 `libnode_launcher.so` 打入 APK 的 native library 目录；npm 的完整目录保存在版本化 asset 中并仅在版本首次使用时原子展开。

首次构建或修改前端后，先安装依赖、构建并同步 Web 资源。Host 核心的六个 `@earendil-works/*` 包固定为上游 main SHA（`scripts/pi-main.json`）构建的 `build/pi-main/*.tgz`；`installHostDependencies` Gradle 任务已在 `npm ci` 前自动运行 `scripts/prepare-pi-main.mjs` 生成它们，手动准备可用 `npm run prepare:pi-main`：

```powershell
npm ci
npm run build
npm run sync:android
```

Tauri Android 界面（M18）在首次 Gradle 调用前需要本机 Rust：`settings.gradle` 的 SDK 引导只跑 `cargo metadata`（只需 Cargo，不需要 Android target/NDK），而 `buildMobileUi` 实际编译 Rust cdylib 时才需要两个 Android target 与 NDK。SDK include 片段 `mobile/build/tauri-sdk.gradle` 是生成物且被忽略，缺失时会在配置阶段用 `providers.exec` 同步执行 `node host-core/build-mobile.js --sdk-path` 后再 apply（plain Gradle、CI 与 `scripts/verify.ps1` 都走同一条引导）。因此首次构建前要准备好：

```powershell
rustup target add aarch64-linux-android x86_64-linux-android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

手动先跑 `node host-core/build-mobile.js --sdk-path` 仍可提前定位问题，但不是必需。若 `node`/`cargo` 本身无法启动，Gradle 会直接以 Exec 失败报错；只有 helper 跑完仍未生成片段时才报带退出码与修复指引的 missing 错误。两者都是真实构建失败，不会猜 cargo registry 路径或刷新 lock。

界面前端单独构建用 `npm run mobile:web`；完整界面构建、单/双 ABI 命令与产物路径见 [mobile/README.md](mobile/README.md)。

Windows PowerShell 下使用仓库内的 Gradle Wrapper 编译：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"
.\gradlew.bat build --no-daemon --console=plain
exit $LASTEXITCODE
```

需要完整检查时再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

脚本要求 `JAVA_HOME` 指向 JDK 21，`ANDROID_HOME` 未设置时使用 `$env:LOCALAPPDATA\Android\Sdk`。`scripts/verify.ps1` 运行纯 Java `AgentChecks`、`ConversationTreeChecks`，Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug :shower-server:lintDebug`，APK 的 Pi/SDK/npm 资源检查，Shower 单 dex／必需类检查，以及旧实现残留、Widget 注册/XML 和空白/行尾检查。`-JavaOnly` 可只运行纯 Java 断言；`-StaticOnly` 可只检查源码、注册和格式，不启动 Gradle。

纯 Java 检查保留 Agent 循环、取消、恢复、历史、搜索及 URL 边界，不再编译已删除的手势/Pager/旧无障碍工具。Robolectric 覆盖持久化、普通入口、导航恢复、Widget 与通知等原生逻辑。APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。构建不证明 Widget 在任意桌面上的呈现、后台时限、语音或虚拟屏行为。

迁移后的 instrumentation 编译：

```powershell
.\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --console=plain
exit $LASTEXITCODE
```

安装应用及测试 APK 后，由验收者选择 `checks=store`、`migration`、`widget`、`questionnaire`、`notifications`、`share-intake`、`share-ui`、`voice-continuity`、`search-consistency`、`shower-preview`、`workbench` 或 `npm`。不传 `checks` 时运行持久化、普通 Capacitor 入口及无 Activity 的协调器文字流检查。`search-consistency` 是聊天／归档历史搜索，不是桌面搜索。Widget 检查只用 instrumentation 临时 `AppWidgetHost` 和短暂 `BIND_APPWIDGET` shell identity，结束时删除自有测试实例，不改变用户已有 Widget；验证真实 RemoteViews、两实例选择、详情／新对话点击和语音 PendingIntent 身份，不启动语音识别或注入系统桌面触摸。新建 provider 对象读取快照不是实际进程死亡，系统桌面添加／点击与真实进程重建由验收者另行记录。

`store` 检查使用目标应用缓存下的独立目录与专用偏好命名空间，不触碰真实聊天；instrumentation 与测试 APK 的 UID 不同，不能直接使用测试 APK 的私有目录。`migration` 检查需要预先授予 `WRITE_SECURE_SETTINGS`，验证实际系统设置在无标记、有标记和恢复完成后的行为，并在结束时恢复原导航值与标记。

产生截图的检查必须传 `-e artifactDir <设备绝对可写目录>`；`workbench` 的 ready/stop/answer 文件也在此目录。示例设备目录为 `/sdcard/Android/data/com.example.launcherprobe/files/acceptance`。截图、日志及拉取后的证据均在仓库外；测试生成物只放已忽略的 `build/`。详情／通知检查需预先授予通知权限，避免首次授权弹窗遮挡；语音连续性检查需录音权限。Shower 检查需 Shizuku 已运行并授权。独立构建、ADB 注入与真实手指体验不是同一层验收；本迁移文档不宣称设备检查已通过。

日常开发在 `develop`。每次 push 会构建 debug APK，在对应 GitHub Actions run 的 Artifacts 里下载，保留 7 天。合并或推到 `main` 时额外构建 release APK，并覆盖 GitHub Release [`latest`](https://github.com/FireSpoonYZ/e-launcher/releases/tag/latest)。CI 需要仓库 secret `DEBUG_KEYSTORE_BASE64`（项目根目录 `debug.keystore` 的 base64）。APK 工作流（`.github/workflows/apk.yml`）现在在 Gradle 之前用 runner 自带 `rustup` 安装 stable（minimal profile）与 `aarch64-linux-android`、`x86_64-linux-android` 两个 target；该步骤属于已实现的接线，**尚未在真实 GitHub runner 上执行验证**，不改本机工具链、不新增 action 依赖。

纯 Java 检查的编译产物位于 `build/test-classes/`。思考强度浮窗的真机触摸回归脚本为 `scripts/check-thinking-slider.mjs`，设备连接和运行方式见文件开头的说明。

### 跨电脑使用同一开发签名

Debug 构建固定使用项目根目录的 `debug.keystore`，不再使用各电脑自动生成的 `~/.android/debug.keystore`。该文件已加入 `.gitignore`，需要通过私密渠道将**同一份文件**复制到其他电脑的项目根目录；缺失时 Gradle 会报错，不会自动生成替代密钥。首次配置沿用本机已有开发密钥，因此签名与本机此前构建的 APK 一致。

这是标准 Android debug 密钥，别名为 `androiddebugkey`，存储和密钥密码均为公开默认值 `android`，仅用于开发，不用于正式发布。本地 debug 构建和 CI 的 debug/release APK 都用这一份密钥，因此可以互相覆盖安装。不要在另一台电脑重新生成密钥或随意替换此文件，否则旧签名的应用无法覆盖更新。当前开发证书 SHA-256：

```text
6f6ff43d800aa2eb8444a78d4f3992a0157f5bae2ca0a31a97da753187d01ffb
```

## 安装与迁移救援

使用原开发签名覆盖安装，然后像普通 App 一样打开。不请求 HOME，不修改任何无障碍服务列表，也不会重新启用旧导航手势。需要系统语音助手时由用户在设置中显式选择；Shower 保留既有 Shizuku 授权链路，仅在工具需要时创建虚拟屏。

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial = '<已授权设备序列号>'
& $adb -s $serial install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb -s $serial shell am start -n com.example.launcherprobe/.MainActivity
```

旧版可能留下 `gestures.pending_restore=true`。只有存在该标记时，`LegacyNavigationRecovery` 才在 Activity 恢复时尝试把 `Settings.Global.force_fsg_nav_bar` 写为 `0` 并读回；这是旧版停用手势的三键恢复契约，不是猜测用户此前的任意导航值。只有读回成功且清除标记提交成功才完成，失败保留恢复责任以供重试。没有标记绝不写导航设置，也绝不写 `1`。`WRITE_SECURE_SETTINGS` 保留用于这次迁移与用户显式救援。

权限不足时设置页显示恢复状态、可复制 ADB 命令、系统设置入口及显式 Shizuku 重试。`WRITE_SECURE_SETTINGS` 不是普通运行时权限；ROM 是否接受必须以实际结果为准。恢复不启用／重绑无障碍，不申请默认桌面。若旧版曾设为 HOME，请在系统默认应用设置中选择系统桌面，不要禁用或卸载系统桌面。

```powershell
& $adb -s $serial shell pm grant com.example.launcherprobe android.permission.WRITE_SECURE_SETTINGS
& $adb -s $serial shell settings put global force_fsg_nav_bar 0
& $adb -s $serial shell settings get global force_fsg_nav_bar
& $adb -s $serial shell am start -a android.settings.SETTINGS
```

ADB 写入为用户显式救援；之后重开助手重试并清除恢复标记。读回 `0` 不等于已看到导航键，必须确认系统 Home/Back/Recents 和导航可用后再撤权或卸载。进程被杀、强行停止及 ROM 限制不能保证清理回调运行，保留电脑授权或系统设置救援入口。

Shower 依赖隐藏 display/input API 和 ROM 的虚拟屏 Activity 支持；Binder 断开或工具超时不会自动重放动作，应重新 `create` / `screenshot` 检查。虚拟屏预览与触摸、后台定时执行、语音唤醒和朗读仍需模拟器／真机分别验收。

## 自部署 Kokoro 朗读

在设置 → 语音 → 远程朗读模型中选择“使用自部署 Kokoro”，填写该服务的独立 API Key，再把朗读引擎设为远程。预设使用 `model=kokoro`、`voice=zf_xiaoxiao`；音色下拉框提供 8 个固定中文音色。更换接口地址时不会沿用旧服务的密钥。

Kokoro 路径请求流式 PCM（24 kHz、单声道、16 位小端），使用 AudioTrack 边接收边播放，一段回复复用音频输出；停止时取消请求并清空播放缓冲。流式失败会显示错误，不切换系统声音或从头重读。其他模型继续走原有压缩音频播放路径。仅填写模型名不会自动迁移已保存的服务地址或 API Key。

唤醒后的“我在”使用当前朗读配置合成，远程音频首次生成后保存在应用缓存中，后续唤醒直接复用；地址、模型、音色、语速或问候文本变化时生成对应的新缓存。缓存命中时不请求服务，清理应用缓存后会重新生成。系统朗读引擎直接使用系统 TTS。生成失败会提示并继续聆听，不回退到旧录音。

当前自部署服务使用 Kokoro v1.0 权重；音色固定不代表韵律和发音已经通过试听。验收时应测试中文夹英文、数字、长回复、连续打断和网络中断，区分 HTTP 响应头时间、首个音频块时间与手机实际出声时间。

下一代多端 Bot 架构与实施进度见 [下一代架构与实施进度](docs/next-generation-architecture.md)。[Bot/Host 核心](host-core/README.md) 已独立实现本机登记、Durable 长期主私聊与内嵌 Billion Context，并已作为 Android Host（M15）在应用内运行；旧数据迁移（M16）与 Windows/Linux 桌面客户端（M17，[`desktop/`](desktop/README.md)）已交付并获父助手限定范围验收；Tauri Android 界面（M18，[`mobile/`](mobile/README.md)）已交付，运行在独立 `:tauri_ui` 进程、通过私有同 UID socket 桥接默认进程的本机 Host。当前本期为 **18/19**（原 20 模块中 M19 按用户决定移出本期、模块编号保留）：M19（Windows/Linux TUI）本期不交付，原规格保留为历史/后续计划，未验收代码只在 git stash `02f1396f`（仅未来草稿，本期不恢复，保留草稿），不计完成；M20（跨设备集成、打包与真机验收）进行中，已交付 M20-01 手机远端入口（手机界面“其他设备”页，复用桌面客户端与 37 个 Host 方法）及限定范围跨设备联调，M20 本身未完成（跨端创建续聊已按手机→Windows 桌面 GUI 有限验证；其后补充验收已跑 9 组 GUI→Host 矩阵、Windows MSI/NSIS 与 Linux DEB/RPM 安装相关检查及 AppImage 两种运行模式、K80 真机 Shower/Widget/通知删除、Host/回执故障、群/DM、BC 与认证撤销，仍未验收项见 [docs/refactor-roadmap.md](docs/refactor-roadmap.md) 末节）。桌面客户端与本机 Android 应用都不打包模型推理。本期还保留每 Bot `SOUL.md` 技术契约：SOUL 是 `dataRoot/bots/<botId>/SOUL.md` 的真实文件（CAS 保存）；Bot 级扩展/能力管理已由中心权威接口接管，旧本机扩展目录与每 Bot 扩展/模型写入入口已移除，Host 方法表为 37 个，见 [host-core/README.md](host-core/README.md#bot-级扩展与-soulmdhost-契约增量)。

## 源码与许可证

本项目保留 AGPLv3 项目许可及 Ogesture 历史归属，当前已删除其导航手势派生实现；仍包含 Operit Shower 的 LGPL-3.0 派生源码。主项目完整许可证见 [LICENSE](LICENSE)，Operit 许可证副本见 [licenses/Operit-LGPL-3.0.txt](licenses/Operit-LGPL-3.0.txt)；固定上游版本、真实移植文件和修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。分发 APK 时须遵守对应源码与构建材料提供义务，仅给未修改上游链接不足以满足本修改版的义务。

Host 记忆适配器使用官方 `@vectorize-io/hindsight-client@0.9.2`（npm gitHead `ebad478240d3171bb88201ececda5e8d9883d22d`），其仓库根 LICENSE 为 MIT，Copyright (c) 2025 Vectorize AI, Inc.；逐字副本保存在 [licenses/hindsight-client-0.9.2-MIT.txt](licenses/hindsight-client-0.9.2-MIT.txt)。该包只通过公开 `dist` 导出使用（`createClient`/`createConfig`/`sdk`），不修改上游源码。

M18 还调整了打包阶段的法务资源接线：`android.packaging.resources` 只从 AGP 默认排除集合里移除 `/META-INF/LICENSE`、`/META-INF/LICENSE.txt`、`/META-INF/NOTICE`、`/META-INF/NOTICE.txt`、`/LICENSE`、`/LICENSE.txt`、`/NOTICE`、`/NOTICE.txt` 这 8 项，并用标准 `resources.merges` 合并同名文件（签名/MANIFEST 等其余排除不动，不使用 `pickFirst`）。已按限定范围验收：双 ABI `assembleDebug`+`assembleDebugAndroidTest` exit 0，新 APK 仅多出 `META-INF/LICENSE`、`META-INF/LICENSE.txt`、`META-INF/NOTICE` 三个条目，其余全部原条目按相同 ZIP 顺序单次解压 SHA256 完全一致，4 个 Jackson 2.15.3 依赖的 `LICENSE`/`NOTICE` 共 8 项均含于合并文本，zipalign `-P16` 与原签名通过；远端 CI 未验证。

标准 Widget 不授予跨应用自动化权限；Shower 仍需用户明确授予的 Shizuku 权限。应用目录查询保留当前用户可启动应用，工作资料及多用户边界仍受 Android 平台约束。
