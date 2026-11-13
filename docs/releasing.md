# 发布说明（release）

实现细节以 `docs/open-source-release-and-update-plan.md` §9 为准。

## 版本模型

- 根 `package.json` 的 `version`（当前 `0.0.19`）是唯一对外产品版本。
- `desktop/src-tauri/tauri.conf.json`、`mobile/src-tauri/tauri.conf.json`、
  `mobile/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.toml`、
  `desktop/host-launcher/Cargo.toml` 保存同一字面量；`app/build.gradle` 的
  `versionName` 直接读取根 `package.json`（`rootProject.file('package.json')`，
  Gradle 根即仓库根）。
- `scripts/release-check.mjs` 核对全部上述字段 + `android.versionCode`
  为正整数；`--tag vX.Y.Z` 额外核对 tag 与产品版本一致。
- Android `versionCode` 独立于产品版本（当前 `25`，正式 0.0.18 使用 `24`，正式 0.0.17 使用 `23`，正式 0.0.16 使用 `22`，正式 0.0.15 使用 `21`，正式 0.0.14 使用 `20`，正式 0.0.13 使用 `19`，正式 0.0.12 使用 `18`，正式 0.0.11 使用 `17`，正式 0.0.10 使用 `16`，正式 0.0.9 使用 `15`，正式 0.0.8 使用 `14`，正式 0.0.7 使用 `13`，正式 0.0.6 使用 `12`，正式 0.0.5 使用 `11`，正式 0.0.4 使用 `10`，正式 0.0.3 使用 `9`，首轮 0.0.3 候选使用 `8`，正式 0.0.2 使用 `7`），见
  `gradle.properties` 的 `android.versionCode`，每个已分发 APK 单调递增、
  不复用、不回退。

## Android 签名

- debug：默认标准用户 debug key（`~/.android/debug.keystore`，AGP 自动生成）。
  维护者覆盖安装旧 debug 包用 `-Pandroid.debugKeystore` 等属性；不需要、
  也不生成仓库 `debug.keystore`。
- release：配置阶段**不抛错**——四个值 `android.releaseKeystore` /
  `android.releaseStorePassword` / `android.releaseKeyAlias` /
  `android.releaseKeyPassword`（-P 属性或对应 `ANDROID_RELEASE_KEYSTORE` /
  `ANDROID_RELEASE_STORE_PASSWORD` / `ANDROID_RELEASE_KEY_ALIAS` /
  `ANDROID_RELEASE_KEY_PASSWORD` 环境变量）任一缺失时 signingConfig 为空，
  并由 `packageRelease`/`assembleRelease` 等打包任务的 doFirst 守卫在执行期
  失败。debug 构建、lint/test 与纯配置永远不需要这些值；缺 key 不会产出
  debug 签名或未签名的"正式"APK。
- 正式私钥不在仓库，发布必须沿用已配置的正式 keystore，不得重新生成。
  `0.0.1` 起的官方 APK 使用同一正式签名，可按递增 versionCode 覆盖安装。
  旧开发签名与正式签名不兼容，需先备份并完成数据迁移；不要卸载用户数据后直接替换。

## CI 渠道

- `master` push、面向 `develop/master` 的 PR 与手动构建：`apk.yml` 构建
  debug APK artifact；`desktop.yml` 运行 `npm test` 与启动器 Rust 测试，构建无 updater
  签名的 NSIS/DEB artifact，并在 Linux 构建后运行桌面 crate 单元测试。
  这些构建不发布 GitHub Release。
- macOS 客户端（Apple Silicon）为**实验性发布项**，由独立的 `desktop-macos.yml` 在
  `macos-15`（Apple Silicon）上构建 ad-hoc 签名的 App 与 DMG。普通运行用作业内临时生成的 updater 密钥
  （不使用正式私钥）签名 `PiBot.app.tar.gz`，再用 `scripts/verify-updater-artifact.mjs`
  校验签名、元数据及进程内中心的上传、发布、查询与下载；随后以测试专用 LaunchAgent
  标签在真实 launchd 上运行 `scripts/macos-update-cycle-test.sh`（停止 Host、替换 App、恢复）。
  任一步失败时 PR 检查显示失败，但不影响其他工作流。
- `v*` tag：`release.yml` 通过 `workflow_call` 并行调用 `apk.yml`
  （签名 APK）、`desktop.yml`（安装包 + updater `.sig`）、`desktop-macos.yml`
  （DMG 与签名的 `PiBot.app.tar.gz`）与 `center.yml`。
  Android、Windows/Linux 桌面与中心全部成功后，由唯一 `publish` job 汇总产物、逐件生成
  `<file>.metadata.json`、创建**一次不可变** GitHub Release（已存在则拒绝）。
  macOS 不在必需条件内：发布模式下其作业失败不会让运行失败（候选运行仍可复用）；`publish`
  只在 DMG、更新包与 `.sig` 齐全且通过元数据校验时附上 macOS 产物，否则照常发布其他平台，
  并在作业摘要、警告注解和 Release 说明中写明“macOS 本版本未提供”及原因。
- `center.yml` 为唯一中心工作流，同时构建多架构容器镜像与自包含 Linux DEB 安装包（`pibot-center` `amd64`/`arm64`，内置固定版本 Node.js `26.13.0` 与 `@bitwarden/cli@2026.10.1`）并执行冒烟验证。普通 `master`/PR/手动运行构建镜像与 DEB artifact；
  release 调用先推送 `ghcr.io/<owner>/pibot-center:sha-<sourceCommit>`、产出
  `center-image.json` 与中心 DEB。全部平台成功后，`publish` 将同一镜像 digest 标记为版本号和
  `latest`，生成精确提交对应的源码归档（`PiBot-<VERSION>-source.tar.gz` 与 `.zip`），并连同中心 DEB 一起写入 `SHA256SUMS` 创建 GitHub Release。发布 Tag 不移动；失败重试继续使用同一 Tag。

## 需要配置的 GitHub secrets / variables

Secrets（仅 tag/release 构建读取）：

- `ANDROID_RELEASE_KEYSTORE_BASE64`：正式 APK keystore 的 base64。
- `ANDROID_RELEASE_STORE_PASSWORD` / `ANDROID_RELEASE_KEY_ALIAS` /
  `ANDROID_RELEASE_KEY_PASSWORD`。
- `TAURI_SIGNING_PRIVATE_KEY`（可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）：
  Tauri updater 签名私钥（`tauri signer generate` 产生）。

Variables（非秘密，编译进客户端的 updater 公钥）：

- `E_LAUNCHER_UPDATER_PUBLIC_KEY`：与私钥配对的公钥。
- `ANDROID_RELEASE_CERT_SHA256`：已核实的正式 APK 签名证书摘要；缺失或与实际签名不匹配时发布失败。

Fork/外部贡献者不需要以上任何 secret 即可构建 debug 包。

## 中心导入元数据

- `scripts/release-artifact.mjs` 为每件制品输出**单个** JSON 对象：
  `{version, platform, arch, format, size, sha256, signature?, notes,
  sourceCommit, versionCode?}`。`sha256` 对真实文件流式计算（不信 sidecar）；
  `signature` 是同目录 `.sig` 的**文本内容**（桌面制品必须提供，且签名绑定版本需一致）；
  `notes` 必填非空字符串；`versionCode` 仅 Android。
- APK 元数据读取 SDK aapt 的真实包名、versionName、versionCode 与单一 ABI；需设置 ANDROID_HOME。DEB 使用 dpkg-deb 核对 Package、Version 与 Architecture。macOS 更新包（`format: app`，`macos`/`aarch64`）读取 `PiBot.app.tar.gz` 内 `PiBot.app/Contents/Info.plist`，核对 bundle identifier `io.github.firespoonyz.pibot` 与 `CFBundleShortVersionString`；中心导入时同样核对版本。
- macOS DMG（`PiBot-<VERSION>-macos-arm64.dmg`）只用于首次安装，随 Release 发布但不生成元数据、不导入中心；应用内更新只使用 `PiBot-<VERSION>-macos-arm64.app.tar.gz` 及其 `.sig`。
- release job 把每个 `*.metadata.json` 与制品一起传到 GitHub Release，
  中心管理员逐件导入。
- 中心镜像元数据见 `center.yml` 产出的 `center-image.json`。

## 覆盖升级验收后发布同一批产物

需要先验证安装器升级时，在发布源码已合入 master 后，运行 Release 的手动构建，设置 `tag=vX.Y.Z`、`candidate=true`。它构建正式签名 APK、带 updater 签名的桌面安装包和中心 sha 镜像，生成完整 `candidate-assets-<sourceCommit>` 附件，不创建 Release 或更新 latest。

从该附件安装并验收。通过后，在同一源码提交创建带注解的 `vX.Y.Z` Tag，注解单独一行写 `Candidate-Run: <runId>`。Tag 发布会校验候选运行的仓库、工作流、版本标题、成功状态及精确源码提交，再复用它的安装包、签名与镜像 digest，避免验收后重新构建出另一批字节。普通无此注解的 Tag 仍走原来的完整构建发布流程。

候选产物保留 30 天。若验收需要修改源码，提交修复并重新构建、验收；不要提前创建或移动正式 Tag。Android 已安装过的候选若发生内容变化，需继续递增 versionCode。

### 桌面覆盖升级身份

Linux 保留 Debian/RPM 包身份 `e-launcher-desktop` 和资源目录 `/usr/lib/e-launcher-desktop`，桌面入口仍显示 pibot，命令为 `pibot` / `pibot-host`。不要用 Conflicts/Replaces 改包名：APT 会先完整移除旧包，其 postrm 会清除 Host 自启动与恢复状态，新包的 preinst 来不及接管。

Windows 从旧 NSIS 版本升级时直接覆盖原安装目录，避免默认先运行旧卸载器删除 Host 登录任务。覆盖前关闭当前及旧名客户端，再停止 Host；完成后为已配对 Host 启用登录自启动并立即启动，确认运行后才报告成功，同时清除旧名可执行文件。

DEB 和 NSIS 的安装（含覆盖升级）都负责为已配对 Host 启用自启动并立即启动；配置或启动失败时安装返回错误。Linux 保留既有 linger 设置，失败回退仍使用升级前的状态快照。未配对的新安装在首次配对完成后自动启动。

macOS 没有安装器钩子：bundle identifier `io.github.firespoonyz.pibot` 与 LaunchAgent 标签 `io.github.firespoonyz.pibot.host` 是覆盖升级身份，不得更改。应用内更新由客户端停止 Host、原位替换 `PiBot.app`，再刷新登录项并重新启动 Host；用户从 DMG 手动覆盖 `/Applications/PiBot.app` 时，Host 不会被自动停止，应先在设置页停止服务。
