# 发布说明（release）

实现细节以 `docs/open-source-release-and-update-plan.md` §9 为准。

## 版本模型

- 根 `package.json` 的 `version`（当前 `1.1.0`）是唯一对外产品版本。
- `desktop/src-tauri/tauri.conf.json`、`mobile/src-tauri/tauri.conf.json`、
  `mobile/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.toml`、
  `desktop/host-launcher/Cargo.toml` 保存同一字面量；`app/build.gradle` 的
  `versionName` 直接读取根 `package.json`（`rootProject.file('package.json')`，
  Gradle 根即仓库根）。
- `scripts/release-check.mjs` 核对全部上述字段 + `android.versionCode`
  为正整数；`--tag vX.Y.Z` 额外核对 tag 与产品版本一致。
- Android `versionCode` 独立于产品版本（当前 `2`，已分发过 1），见
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
- 旧私钥不在仓库：没有正式 keystore 时只能构建 debug 包；官方正式发布
  必须先配置上述 secrets 并完成 `apksigner rotate` lineage（需旧私钥），
  未完成前不得以新身份发布覆盖安装包。

## CI 渠道

- 普通分支 push：`apk.yml` 只构建 debug APK artifact；`desktop.yml` 只构建
  无签名 NSIS/DEB bundle artifact；均不需要 secret。
- `v*` tag：`release.yml` 通过 `workflow_call` 依次调用 `apk.yml`
  （签名 APK）与 `desktop.yml`（tauri-action 构建 + updater `.sig`），
  全部成功后由唯一 `release` job 汇总产物、逐件生成
  `<file>.metadata.json`、创建**一次不可变** GitHub Release（已存在则拒绝）。
- `center.yml` 为唯一中心镜像工作流。main 仅推送不可变 sha 标签，其他分支/PR 只构建；版本 tag 通过 Docker 官方 build-push Actions 推送
  `ghcr.io/<owner>/e-launcher-center:<version>` 与 `latest`，tag 另产出
  `center-image.json` 元数据 artifact；不创建 GitHub Release。

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
