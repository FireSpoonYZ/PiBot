# 发布说明（release）

实现细节以 `docs/open-source-release-and-update-plan.md` §9 为准。

## 版本模型

- 根 `package.json` 的 `version`（当前 `0.0.2`）是唯一对外产品版本。
- `desktop/src-tauri/tauri.conf.json`、`mobile/src-tauri/tauri.conf.json`、
  `mobile/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.toml`、
  `desktop/host-launcher/Cargo.toml` 保存同一字面量；`app/build.gradle` 的
  `versionName` 直接读取根 `package.json`（`rootProject.file('package.json')`，
  Gradle 根即仓库根）。
- `scripts/release-check.mjs` 核对全部上述字段 + `android.versionCode`
  为正整数；`--tag vX.Y.Z` 额外核对 tag 与产品版本一致。
- Android `versionCode` 独立于产品版本（当前 `7`，验收包使用过 `6`），见
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
  debug APK artifact；`desktop.yml` 构建无 updater 签名的 NSIS/DEB artifact。
  这些构建不发布 GitHub Release。
- `v*` tag：`release.yml` 通过 `workflow_call` 并行调用 `apk.yml`
  （签名 APK）、`desktop.yml`（安装包 + updater `.sig`）与 `center.yml`，
  全部成功后由唯一 `publish` job 汇总产物、逐件生成
  `<file>.metadata.json`、创建**一次不可变** GitHub Release（已存在则拒绝）。
- `center.yml` 为唯一中心镜像工作流。普通 `master`/PR/手动运行只构建；
  release 调用先推送 `ghcr.io/<owner>/pibot-center:sha-<sourceCommit>` 并产出
  `center-image.json`。全部平台成功后，`publish` 将同一 digest 标记为版本号和
  `latest`，并创建 GitHub Release。发布 Tag 不移动；失败重试继续使用同一 Tag。

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
- APK 元数据读取 SDK aapt 的真实包名、versionName、versionCode 与单一 ABI；需设置 ANDROID_HOME。DEB 使用 dpkg-deb 核对 Package、Version 与 Architecture。
- release job 把每个 `*.metadata.json` 与制品一起传到 GitHub Release，
  中心管理员逐件导入。
- 中心镜像元数据见 `center.yml` 产出的 `center-image.json`。
