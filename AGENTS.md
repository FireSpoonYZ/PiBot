# 项目开发说明

## 目录职责

| 目录 | 内容 |
| --- | --- |
| `app/src/main/` | Android 原生 Java（独立助手入口、App Widget、语音、Shower、Pi 桥接） |
| `web/src/` | React + TypeScript 前端（聊天、设置，Capacitor 桥接） |
| `pi-runtime/` | Pi coding-agent SDK 集成，esbuild 打包为 `pi-runtime.cjs` |
| `shower-server/` | Binder-only 虚拟屏服务，Gradle 构建后以 `shower-server.jar` 打入 App assets |
| `tests/` | 纯 Java 断言检查（AgentChecks、ConversationTreeChecks），不依赖 Android stub |
| `app/src/test/` | Robolectric 单元测试 |
| `app/src/androidTest/` | 设备端 instrumentation 检查 |
| `scripts/` | 可重复运行的验证与辅助脚本 |

## 助手与迁移边界

- MainActivity 是普通 Capacitor 入口；不恢复 HOME、桌面网格/搜索、图标包、小组件宿主、导航手势或应用切换页。
- TaskWidgetProvider 使用 RemoteViews/XML；不内嵌 EditText、问卷输入或虚拟屏。点击打开现有聊天/详情/语音 Activity，多个实例按会话分别选择任务。
- 普通事件至少 1000ms 尾沿节流，开始/问卷/停止/终态及时刷新；冷状态只显示私有 `task_widget` 最后快照及更新时间，不启动 Pi/Shizuku/Shower/FGS。
- 保留 applicationId、签名、聊天/附件/Pi/偏好数据路径及旧草稿。AppCatalog/AppSearch、Shower 和原系统语音组件名不是桌面残留。
- 仅 `gestures.pending_restore=true` 可自动恢复旧导航值为 0，读回且 commit 清标成功才完成；不写 1，不改无障碍列表或申请 HOME。权限不足时保留标记与 ADB/系统设置/显式 Shizuku 救援入口，具体命令见 README。

## 构建先决条件

- **JDK 21**（`JAVA_HOME` 必须指向 JDK 21）
- **Android SDK Platform 36**（`ANDROID_HOME` 未设置时使用 `$env:LOCALAPPDATA\Android\Sdk`）
- **NDK 28.2.13676358、CMake 3.22.1**（构建 node_launcher）
- **Node ≥ 22.19**（前端构建和 pi-runtime）
- Gradle 8.14.3 通过仓库内 `gradlew.bat` 自动下载
- 首次构建需下载 Gradle 发行包、构建依赖和 sherpa-onnx 模型，并接受 SDK 许可

## 构建命令

后台构建统一加上 `--no-daemon --console=plain`，避免 Gradle Daemon 影响后台工具结束判定。通过 PowerShell 包装构建命令时，末尾加上 `exit $LASTEXITCODE`，将 Gradle 退出码传给后台工具。

```powershell
# 环境变量
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"

# 首次安装前端依赖并同步 Capacitor；之后新增或修改原生插件时重新同步
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run sync:android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 首次准备 Node Mobile、SDK 和 npm 资源；更新这些资源时重新运行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-pi-runtime.ps1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 日常编译：Gradle preBuild 会重新构建并复制 Web 资源、构建 Pi runtime
.\gradlew.bat build --no-daemon --console=plain
exit $LASTEXITCODE
```

成功构建的调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 按变更范围选择验证

| 改动范围 | 最小验证 |
| --- | --- |
| 纯 Java 逻辑（Agent、历史、搜索） | `scripts/verify.ps1` 中的纯 Java 检查会覆盖 |
| Android 业务逻辑 | `.\gradlew.bat :app:testDebugUnitTest --no-daemon --console=plain`（Robolectric） |
| 前端 TypeScript/React | `npm test`（Node 行为测试）和 `npm run build`（tsc + vite） |
| pi-runtime JS | `npm --prefix pi-runtime test` |
| Shower 服务端 | `.\gradlew.bat :shower-server:lintDebug --no-daemon --console=plain` |
| 定时任务 UI | `node scripts/check-schedules.mjs`（浏览器检查，不需要设备） |
| Android 完整检查 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1` |

`scripts/verify.ps1` 执行纯 Java 断言检查、`:app:testDebugUnitTest :app:assembleDebug :app:lintDebug :shower-server:lintDebug`、APK 运行时资源检查、Shower 单 dex 与必需类检查、旧引用、HOME/桌面残留、Widget 注册/XML 检查和空白/行尾风格检查。可用 `-StaticOnly` 或 `-JavaOnly` 单独执行轻量检查。它不运行根目录的 `npm test`、`npm --prefix pi-runtime test`、浏览器交互检查或设备检查；涉及这些范围时按表补充。

## 设备验证与自动测试的界限

- 纯 Java 检查和 Robolectric 测试覆盖逻辑正确性，不能证明真实桌面 Widget 呈现、MotionEvent 或虚拟屏行为。
- Instrumentation 编译用 `:app:assembleDebugAndroidTest`。`ChatStoreChecks` 提供 `widget`、`questionnaire`、`notifications`、`share-intake`、`share-ui`、`voice-continuity`、`search-consistency` 等检查；`shower-preview`/`workbench` 还需 Shizuku。实际运行需要安装应用及测试 APK 的设备或模拟器，编译不等于已运行。
- 截图检查必须传 `-e artifactDir <设备绝对可写目录>`；拉取到电脑时放仓库外。`workbench` 的控制/回答文件也使用此目录。
- Widget 点击/系统恢复、Shower 画面、定时任务后台执行、朗读等功能的最终验收必须在真机上进行，不能仅凭构建通过判定。
- ADB 触摸注入不等于真实手指验收；`input keyevent` 仅证明按键路径。

## 临时文件与密钥

- 设计稿、真机截图、录像、日志和一次性脚本放在**仓库外**的临时目录，不在项目中建立 `design/` 或 `evidence/`。
- 构建与测试的生成文件放在已忽略的 `build/` 目录；可重复运行的验证脚本保留在 `scripts/`。
- **不要提交 `local.properties`**。需要代理时写在用户级 `~/.gradle/gradle.properties`。
- **不要提交或重新生成 `debug.keystore`**；缺失时从其他开发机复制。

## 子代理约定

- worker 只做静态开发，不执行测试、构建、类型检查、语法检查或其他运行验证，最终验收由父助手负责。

- scout 只负责现有代码探索。开发方案由父助手确定，代码实现交给 worker；父助手负责集成和运行验收。
- 输出由框架保存到仓库外的任务产物目录，不能让 scout 写 `context.md`、`progress.md` 或修改代码；其工具仅限静态读取与联系父助手。
- 接收结果时检查真实模型、精确源码行号及事实/探索建议分离；不合格时要求原子代理修正，不直接交给开发 worker。scout 的 recommendations/steps 仅限继续阅读和核实代码，不包含开发方案。静态盘点不记为运行验收。
