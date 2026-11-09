# 项目开发说明

## 目录职责

| 目录 | 内容 |
| --- | --- |
| `app/src/main/` | Android 原生入口、前台服务、通知、语音与 Shower 桥接 |
| `web/src/`、`mobile/` | 共享 React/TypeScript 界面与 Android Tauri 外壳 |
| `desktop/` | Windows/Linux Tauri 客户端、Host 启动器、NSIS/DEB 钩子 |
| `host-core/` | 多端 Host、客户端 broker、工具、固定 Pi SDK 集成 |
| `center-server/`、`center-web/`、`center-contract/` | 中心服务、管理页与契约 |
| `shower-server/` | Binder-only 虚拟屏服务，Gradle 构建后以 `shower-server.jar` 打入 APK assets |
| `web/test/`、`app/src/test/` | Node 行为测试与 Android JUnit/Robolectric 测试 |
| `scripts/` | 构建准备、网络诊断与发行校验 |

## 助手与迁移边界

- `MainActivity` 是普通应用入口，由它启动独立 `:tauri_ui` 进程内的 `TauriMainActivity`。保持助手范围，避免恢复 HOME、桌面网格/搜索、图标包、小组件宿主、导航手势与应用切换页。
- 保留 applicationId、签名、聊天/附件/Pi/偏好数据路径及旧草稿。保留助手用到的 AppCatalog/AppSearch、Shower 和系统语音组件名。
- 旧导航值只在 `gestures.pending_restore=true` 时恢复为 0，读回且 commit 清标成功才完成。权限不足时保留标记，并可用 ADB、系统设置或显式 Shizuku 救援入口。禁止自动写 1、更改无障碍列表或申请 HOME。 [Android 旧数据恢复](README.md#首次部署并跑通一个-bot)

## 构建环境与命令

使用 CI 的 **Node.js 26.13.0**，可用 `mise exec node@26.13.0 -- <命令>`。Rust **1.99.1** 由 `rust-toolchain.toml` 固定。桌面构建先装根目录与 `host-core` npm 依赖，中心镜像由 `scripts/center-build.sh` 构建。 [源码构建](README.md#从源码构建) · [桌面依赖](desktop/README.md#构建)

Android 使用 **JDK 21**、**Platform 36**、**Build-Tools 36.0.0**、**NDK 28.2.13676358**、**CMake 3.22.1** 和对应 Rust target。`JAVA_HOME` 指向 JDK 21，`ANDROID_HOME` 指向 SDK（Windows 的默认路径为 `$env:LOCALAPPDATA\Android\Sdk`）。使用 Gradle wrapper **8.14.3**。

全新工作区先接受 SDK 许可、按锁文件安装 npm 依赖并运行 `scripts/prepare-node-mobile.ps1`，再用 Gradle 构建。Android 的宿主构建工具 Node.js 与 APK 内 Node Mobile 分别固定版本。 [Android 完整命令](mobile/README.md#构建与先决条件)

后台 Gradle 命令统一加 `--no-daemon --console=plain`。通过 PowerShell 包装构建时，用 `exit $LASTEXITCODE` 传递最后一条外部命令的退出码。

## 按变更范围选择验证

| 改动范围 | 最小验证 |
| --- | --- |
| 共享前端 / Host / Center 行为 | 安装根、`host-core`、`center-server` 依赖后运行 `npm test`，前端变更再运行 `npm run build` |
| 中心管理页 | `npm ci --prefix center-web` 后运行 `npm run center:build` |
| 桌面专有前端 | `npx tsc -p desktop/web/tsconfig.json --noEmit` |
| Android Java 业务逻辑 | `./gradlew :app:testDebugUnitTest --no-daemon --console=plain` |
| Android 打包与静态检查 | `./gradlew :app:assembleDebug :app:lintDebug --no-daemon --console=plain` |
| Shower 服务端 | `./gradlew :shower-server:lintDebug --no-daemon --console=plain` |
| 发布版本一致性 | `node scripts/release-check.mjs` |

Windows 使用 `.\gradlew.bat`。调试 APK 输出至 `app/build/outputs/apk/debug/app-debug.apk`。模拟器选 `-PlauncherAbis=x86_64`。APK 的设备验收需用同签名安装包和独立测试设备或模拟器。

## 设备验证与自动测试的界限

- JUnit、Robolectric 与 Gradle 构建覆盖各自的代码或产物，设备交互需在对应设备单独验收。
- Android 系统导航恢复、通知点击、Shower 画面与触摸、后台任务和语音最终验收需要真机。ADB `input keyevent` 可验证按键分发，手指交互由真机实测。
- 历史设备验收按原记录的版本、环境与功能范围理解。当前验证入口以上表为准。 [Android 历史验收](mobile/README.md#验证边界父助手限定范围)

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
