# 开源发布、中心整合与客户端升级改造方案（实施定稿）

定稿日期：2026-11-06。源码核对基线：`3319c53`。

用户已授权助手决定剩余选型。本文是后续实施的主文档；[现成方案调研报告](open-source-release-solutions-research.md)保留候选比较和来源依据。与前期讨论不一致时，以本定稿为准。

本文描述目标与实施边界。业务代码和本机三端运行验证已有进展；实际已完成、未完成与外部发布材料以[开发及验收进度](open-source-release-progress.md)为准。Windows SCM、虚拟服务账户和会话代理仍属未完成实现，不视为已交付。

## 1. 项目定位与最终选型

本项目供用户自托管中心，连接自己的 Windows、Linux 和 Android 设备。首次使用、长期运行和升级以现有应用、Host 和中心为基础，不另建云服务运营平台或通用部署系统。

| 工作项 | 最终决定 |
| --- | --- |
| 中心与 Relay | 现有 Fastify + ws 共用一个 HTTP server；保留原有协议与认证 |
| TLS | 服务自身不处理 HTTPS；由用户的反向代理提供外部 HTTPS/WSS |
| 中心监听 | 默认一个内部 HTTP 端口 `8080`，公共地址独立配置 |
| Windows 安装包 | NSIS，改为 `perMachine`，程序安装到受保护的 Program Files |
| Windows Host | 现有 Rust 启动器接 `windows-service`；使用专用虚拟服务账户 |
| Linux 安装包 | **保留 DEB**，复用已有安装路径和 systemd 单元 |
| Linux Host | systemd 用户服务 + linger，按所属用户运行 |
| AppImage | 不迁移，不增加自复制安装和 `--host` 挂载方案 |
| Android 安装包 | APK，保留应用身份及现有数据路径 |
| 桌面更新 | 固定 `tauri-plugin-updater` Rust/JS `2.14.1`，复用当前 CLI `2.12.4`，构建时核对依赖兼容 |
| Android 更新 | 现有 OkHttp 下载 + Android PackageInstaller + Kotlin/Tauri 桥 |
| 更新服务 | 在现有中心增加客户端版本与制品管理，使用 Tauri 标准更新协议 |
| 更新信任 | 客户端信任发布者公钥，中心只分发已签名产物；fork 使用自己的密钥 |
| 更新触发 | 连接中心后自动检查，持续连接时每 24 小时最多自动检查一次；保留手动检查；用户点击后下载和安装 |
| Host 配置 | 桌面首次连接中心时自动完成配置、服务注册、立即启动和开机自启动 |
| 开机运行 | Windows/Linux 无需先打开客户端或登录图形桌面即可启动 Host |
| 发布 | GitHub Actions / Releases + Docker 官方 Actions / GHCR；采用不可变版本 |
| 版本管理 | 单一产品版本来源 + 显式版本变更 + tag 发布，本轮不接 release-please |
| rg / fd | 随各平台产品打包，固定使用专用路径，不依赖系统安装 |
| Pi | 常态为精确正式版本；当前固定 SHA 仅保留到所需修复正式发布 |
| 主项目许可证 | 自有代码目标为 `LGPL-3.0-only`；变更前完成来源与再许可核对 |
| 文档与秘密文件 | 修正当前说明，补齐实际敏感路径忽略规则 |
| 本轮不增加 | 新测试体系、社区运营、隐私授权体系、灰度/强制更新、通用自动回滚、额外更新服务器 |

### Linux 选型的事实更正

此前“官方 updater 不支持 DEB/RPM”的判断错误。官方从 `2.10.0` 起已支持；已发布 `2.14.1` 含 DEB/RPM 安装逻辑，CLI `2.12.4` 也可为这些包生成更新签名。因此没有必要为应用内升级迁移到 AppImage。

本轮正式发布以 NSIS、DEB、APK 为主，不为 MSI、RPM、AppImage 建设额外更新流程。已有非主格式构建能力可以暂留，但不作为本轮正式发布或验收承诺。

## 2. 首次使用与长期运行的统一行为

### 2.1 首次连接流程

Windows 和 Linux 用户安装并打开客户端后，填写中心地址和认证信息，点击连接：

```text
验证中心地址与认证
        ↓
登记或复用设备身份，保存本机 Host 配置
        ↓
自动配置本机后台服务与开机启动
        ↓
立即启动 Host
        ↓
显示中心连接状态、服务状态及 Host 在线状态
```

不再设置单独的“启用本机 Host”步骤。需要操作系统权限时使用系统授权流程；应用内不重复设计一套审批向导。

### 2.2 共同要求

- 初次成功配置默认启用开机自启动。自动启动 Host，不要求自动打开客户端窗口。
- 关闭客户端窗口不停止 Host；主机重启后由系统启动 Host。
- 普通重连复用原身份、凭据和数据，不重新登记设备。
- 同一数据目录只允许一个 Host 所有者；服务化迁移不能同时启动旧、新两套 Host。
- 中途失败保留成功步骤和数据，重试按实际状态继续。
- 中心认证成功、服务注册成功、Host 进程运行、Host 连接中心分别显示，不能互相代替。
- 用户后来主动关闭自启动，重连和升级尊重该选择。
- 设置页保留状态、启动、停止、自启动管理及服务移除入口。
- 切换中心走既有的显式重新配置流程，不因查看另一中心而静默改写本机 Host 归属。
- 正常网络未就绪时复用已有重连机制，不因开机瞬时离线重建设备身份或重置数据。

### 2.3 本地所有者

Windows 一个系统安装对应一个本机 Host，由首次完成配置的用户 SID 作为本地管理所有者；本轮不增加多个 Windows 用户各自注册系统级 Host 的产品模式。

Linux 沿用用户级 Host，身份由首次配置用户的 UID 和实际 Host 数据目录确定。安装包升级需要识别已经配置的用户服务，不通过猜测当前 root 会话来决定目标。

中心设备认证与操作系统本地服务管理是两套权限：连接中心不赋予任意本机提权能力。

## 3. 中心与 Relay 单入口

### 3.1 结构

```text
客户端 → 用户的公共 HTTPS/WSS 地址
                    │
             用户自己的反向代理
                    │
           中心 HTTP :8080
          ┌─────────┼─────────┐
        管理网页    /api/*   /v1/link
                            WebSocket
```

使用现有 Fastify 和 ws 的 `noServer` / `handleUpgrade` 接线。中心与 Relay 共享底层 HTTP server，关闭所有权集中到中心。

### 3.2 修改范围

- 去掉中心启动对 TLS 证书和独立 Relay 证书的强制要求。
- Compose 仅暴露一个应用端口。默认宿主机发布到回环地址供本机代理使用；容器代理可走 Docker 网络。
- 保留单一公共中心 origin 配置，从中推导 WebSocket、下载和 OAuth 回调地址。
- 不增加子路径部署模式；公共入口使用域名根路径，避免同时维护路径重写规则。
- 中心控制 Host 改用进程内路由入口，不再每次连接自己的公开 WSS 地址。
- 内部调用复用既有请求关联、目标身份、方法限制、超时、断线和背压处理。
- 原生 WebSocket upgrade 不假定自动经过普通 Fastify hooks，原有设备认证继续执行。
- `trustProxy` 按实际可信代理范围配置，保留外部 HTTPS 下的 secure cookie 与客户端证书校验。

不增加 Socket.IO、消息队列、独立中继容器或新的数据库体系。

### 3.3 旧入口迁移

升级前备份中心数据与配置，保留设备注册和凭据。迁移时先更新中心和代理，再让客户端重新取得中心公布的连接信息。

不在产品内长期保留第二个 Relay 监听端口。如现网设备需要过渡，由部署者暂时在反向代理上转发旧端口到新的 `/v1/link`；客户端完成迁移后移除这条部署规则。

## 4. Windows：系统服务、身份与安装权限

### 4.1 服务实现

在现有 Rust `e-launcher-host` 中接入 `windows-service`，实现 ServiceMain、SCM 状态报告和停止处理，复用当前配置、进程监督、日志与状态逻辑。

不同时引入 WinSW、NSSM、service-manager 或 Tauri autostart。服务设置为自动启动；现有监督器负责 Node 子进程，SCM 只负责服务进程本身，避免多层同时重启同一进程。

首次连接时在一次受控的系统授权操作中完成服务注册、必要目录授权和启动。日常启动/停止使用授予本地所有者的有限服务控制权限；改变可执行路径、服务账户等管理操作仍需系统授权。

### 4.2 采用虚拟服务账户

服务名固定为 `ELauncherHost`，运行账户为：

```text
NT SERVICE\ELauncherHost
```

这是 Windows 自带的虚拟服务账户，不需要用户提供或应用保存 Windows 登录密码。它不是 LocalSystem，也不加入 Administrators。

Agent 的文件和 shell 工具以该服务身份执行。工作目录的访问通过普通 Windows ACL 明确授予，不能把“服务化”解释为自动继承当前用户的全部文件、Git 凭据、网络盘和交互式环境。

默认工作区由产品创建并授予服务访问。用户选择其他本机工作目录时，在该具体目录范围内完成授权；不足的权限显示为明确错误，不由模型触发通用提权操作。迁移时核对现有 Bot 工作目录，保留路径，并处理所需访问权。

### 4.3 程序和数据目录

| 内容 | 决定 |
| --- | --- |
| 安装模式 | NSIS `perMachine` |
| 程序、Node、Host 源码和内置工具 | Program Files 下的产品安装目录，普通用户与服务只有运行所需的读取/执行权 |
| 新安装的 Host 状态 | `%PROGRAMDATA%\e-launcher\host-service` |
| 已有 Host 状态 | 保留现有绝对路径，用显式 Host home 配置接管，不为服务化直接搬动数据库 |
| 本地所有者与服务登记 | ProgramData 中管理员控制的登记信息，记录所有者 SID 和数据路径，不存中心登录口令 |
| 客户端界面状态 | 继续使用原用户的客户端数据目录 |

新 Host 数据目录由安装/配置逻辑设置准确 ACL，授予服务、本地所有者及管理员必要权限，不继承面向所有本机用户的读取权限。安装程序的写权限与运行数据的写权限分开。

Host 不再根据服务账户的 `%LOCALAPPDATA%` 猜测用户数据位置，而是读取已经登记的显式路径。旧目录的接管只授权实际数据和工作区，不把整个用户配置目录或系统目录递归开放。

需要提权的安装和服务配置逻辑来自受保护安装目录，只接受有限的产品操作。不开通任意命令执行、任意服务注册或通用 ACL 修改接口。

### 4.4 Shower 与用户会话

Host 核心在开机后即可运行聊天、文件、命令和远程协作。Shower 继续依赖适用的用户交互式会话，不在 Session 0 中直接创建交互式桌面。

使用现有原生 Shower 组件和 guardian，在所属用户登录会话中运行一个无主窗口的会话代理，通过受本机所有者 SID 与服务身份约束的本地 IPC 接入 Host。沿用固定 Shower 操作协议和已有归属校验，不新增通用远程执行通道。

用户会话代理随所属用户登录启动，并可由当前客户端立即启动。它不打开聊天窗口、不创建第二个 Host，也不自行持有另一套中心身份。

现有实现会在 Host 启动时执行 Shower `prepare`，授权失败会使 Host 启动失败。服务化后必须拆开这两个生命周期：未登录、Shower 未授权或代理未就绪时，主 Host 正常在线，图形能力报告不可用；用户会话就绪后再连接图形能力。

旧的 Host `HKCU Run` 自启动移除。用于用户会话代理的登录入口单独命名，不能与主 Host 开机服务混淆。保留现有 Shower 所需的系统授权和凭据管理方式。

### 4.5 NSIS 与旧安装迁移

NSIS 安装受保护的程序文件，不在安装向导收集中心地址或配对凭据。首次连接中心时配置服务。

升级由 NSIS 负责：记录此前服务状态、可靠停止、替换文件、恢复应恢复的服务状态。停止失败阻止继续替换运行文件，不能继续忽略退出码。

从旧 `currentUser` 安装升级时，先识别旧安装和旧 Host，停用旧启动项，保留原设备身份及 Host home，再切换到受保护的程序目录。旧卸载流程不得删除新登记的服务或数据。

卸载停止并注销服务及用户会话代理入口，默认保留业务数据；移除数据必须是明确的独立用户操作。

## 5. Linux：保留 DEB 与 systemd 用户服务

### 5.1 安装与开机启动

继续由 DEB 安装客户端、Host 启动器、Node、运行资源和已有 systemd 用户单元。沿用 `/usr/bin/e-launcher-host` 与 `/usr/lib/e-launcher-desktop/host-runtime/` 等布局。

首次连接中心成功后，按实际 UID、XDG 路径与 Host home 保存配置，执行用户服务加载、启用和启动，同时配置 linger。必要时使用系统授权机制。

linger 使用户 manager 在开机时启动并在登出后保留。主 Host 不依赖客户端窗口或图形桌面登录；Linux Shower 仍按原私有 Xvnc 方案报告依赖与状态。

保持当前用户的数据目录和运行身份。本轮支持既有 systemd、DEB 系统部署范围，不新增 OpenRC 等适配。数据目录在开机时必须可访问；加密 home 等环境限制需要如实报告，不能把仅登录后可用的配置显示成开机服务已验证。

### 5.2 升级钩子和用户归属

使用 Tauri 的 DEB pre/post install/remove 钩子。安装包的系统级逻辑只处理文件、服务升级协调和受保护登记信息；首次中心配对仍由用户客户端完成。

维护一份系统可识别的已配置 Host 用户登记，至少包含 UID 和实际 Host home。其用途仅限包升级定位目标，不保存模型或中心秘密。

包脚本以 root 运行时，通过明确目标 UID 的标准用户切换方式调用该用户的 systemd manager；不直接执行 root 的 `systemctl --user`，不执行用户提供的任意命令或脚本。

升级前保存目标服务原有启用/运行状态，停止并确认退出；升级后恢复该状态，升级不会重新打开用户主动关闭的自启动。

linger 是用户级属性。卸载仅移除本产品服务，不无条件关闭用户 linger，以免影响其他服务。

### 5.3 DEB 应用内更新

官方 updater 负责验签并调用 DEB 安装路径。授权由系统处理，前端显示进度及结果。

当前插件使用 `dpkg -i`，并不负责完整 APT 依赖求解。首次安装通过系统包安装器处理依赖；以后如版本增加系统依赖，必须在发布说明和实际安装流程中覆盖，安装未完成时不显示成功。

本轮不新增 APT 仓库或自行维护另一套包更新器，不迁移至 AppImage。

## 6. Android：保持 APK 与原生生命周期

继续使用当前 Gradle 项目、Tauri 界面和 Kotlin/Java 原生桥，保持 applicationId、已有数据路径和覆盖安装能力。

客户端连接中心与本机 Host 配置采用一致、可恢复的流程；后台运行沿用 Android 原生服务与权限机制，不把 Windows/Linux 的系统服务方案复制到 Android，不新增开机保活功能。

内置更新采用已有 OkHttp 下载和 PackageInstaller session。共享 React 界面负责版本、说明和进度，Kotlin 负责下载文件、调用系统安装、处理状态和必要权限。

不引入 XUpdate、AppUpdater、第三方 Android Tauri 安装插件或额外弹窗框架。

## 7. 中心客户端版本管理

### 7.1 管理流程

在现有中心管理端增加客户端版本页面：

```text
上传安装包和发布元数据
          ↓
核对文件、摘要、平台、架构、格式与版本
          ↓
保存为未发布版本
          ↓
管理员点击发布
          ↓
适用客户端可查询并下载
```

采用单一稳定发布序列，不增加 beta/nightly 通道产品配置。三端可以分别上传和发布，不要求同一次集齐全部平台。

保留历史版本，同一平台/架构/格式/版本身份的已发布文件不静默覆盖。管理端可撤回某版本的可见性；客户端只接受正常向前更新，不因此自动降级。

### 7.2 元数据与存储

记录至少包括：产品版本、平台、架构、安装格式、大小、SHA-256、签名信息、更新说明、发布时间、源码提交及 Android versionCode。

构建流程输出可导入的发布元数据，减少管理员手填。平台选择包含 `nsis`、`deb`、`apk`，避免仅按操作系统和架构混发不同格式。

大文件流式保存并计算摘要；中心生成路径，先落盘完成再公布版本。上传限制按实际发布产物设置，不沿用插件制品的小文件上限。

复用 Fastify、数据库、认证、multipart 和文件服务，不引入独立更新平台、MongoDB、Redis 或对象存储服务。安装包与 Bot 插件分别建业务记录，只复用通用文件保存能力。

中心验证文件与元数据完整性，保留更新签名；客户端使用自己信任的发布公钥验证发布身份。上传权限不等于可以替客户端更换信任公钥。

### 7.3 查询与下载

桌面端使用 Tauri 标准动态更新协议；Android 读取同一版本记录对应的 APK 信息。查询端点根据当前平台、架构、格式和已安装版本选择结果。

客户端使用当前已连接中心作为更新源，通过原生侧既有认证信息发起查询和下载。不另把秘密写入 localStorage，也不新增全局匿名上传或信任管理接口。

用户首次取得安装包可通过中心管理页面或 GitHub Release 下载，不依赖已经安装的客户端。

中心程序自身仍通过版本化 Docker 镜像更新，不增加自动替换自身容器的功能。

## 8. 客户端检查、安装与 Host 恢复

### 8.1 统一更新体验

- 客户端成功连接中心后检查一次；持续连接期间每 24 小时最多自动检查一次。
- 提供手动“检查更新”，不受自动检查间隔限制。
- 自动检查只获取元数据并提示；用户点击后才下载和安装。
- 显示版本、更新说明、下载进度和安装状态，不强制退出、不后台静默重启。
- 切换中心或设备连接状态后，过期查询结果不得覆盖当前更新状态。
- 使用完整安装包更新，不增加前端热更新、差分包或单独 Host 更新通道。

### 8.2 桌面更新协调

先下载并验签，再准备安装。准备阶段阻止新任务进入本机 Host，等待活动任务结束，或由用户明确停止后继续。

客户端负责展示和任务协调，真正的 Host 停止、文件替换、状态恢复由 NSIS/DEB 安装生命周期负责。两端不同时争夺“升级前运行状态”的记录所有权。

安装前记录服务启用与运行状态；停止未成功则不继续替换。安装失败应按实际程序文件状态恢复可用的 Host 并报告错误，安装成功恢复原来应运行的服务。

**Host 的恢复不依赖新客户端窗口是否成功打开。** 保留有界的安装状态记录，使失败后能恢复或给出明确的修复入口，不建设通用事务引擎。

Windows updater 使用可请求系统权限的安装模式，不使用无法自行提权的 quiet 作为正式默认值。Linux 使用 DEB 的系统授权流程。

### 8.3 Android 自更新

下载 APK 后核对摘要、包名和 versionCode，通过 PackageInstaller 发起安装，处理需要用户操作、取消和失败状态。需要时引导授予本应用安装未知应用的权限。

最终 APK 签名和覆盖安装关系由 Android 平台验证。保存待更新版本，下次启动读取真实已安装版本完成结果确认；不把“安装器已启动”显示为“升级完成”。

用户取消或失败时保留旧应用和数据。应用被替换时原进程及本机 Host 会受到系统安装生命周期影响，重新启动后按已有配置恢复。

### 8.4 运行组件一并升级

NSIS、DEB、APK 同时交付本平台客户端、Host、Node 和专用工具。不允许界面已经升级但长期运行的 Host 仍悄悄使用另一套旧安装目录。

保留旧产物可以辅助修复，但不承诺任意版本数据库自动回滚；本轮不实现自动降级。

## 9. 签名、版本与正式发布

### 9.1 更新签名与信任

桌面使用 Tauri signer/updater，客户端内置官方发布公钥。采用相匹配的 CLI/updater 并启用 `requireSignedVersion`，使声明版本与实际签名版本一致。手工签名必须包含 `--app-version`。

中心不保管官方发布私钥。Fork 使用自己的更新密钥重新构建客户端和安装包；官方客户端不会因为中心上传了另一把密钥签名的文件就自动信任它。

Android 使用标准 APK 签名和系统覆盖安装验证，不额外发明 APK 签名协议。Tauri 更新签名、Android APK 签名、Windows Authenticode 分别管理。Windows 代码签名证书不作为本轮必须采购事项。

### 9.2 开发与官方构建分离

外部贡献者使用 Android 标准本地 debug key 或自己的开发配置，fork CI 不依赖官方 Secret。维护者需要原开发签名覆盖安装时使用显式配置。

官方发布使用独立受保护签名配置。不重新生成或提交现有 `debug.keystore`，也不把正式密钥放入仓库或中心镜像。

### 9.3 Android 既有签名迁移

采用新正式发布密钥，并优先使用已有旧私钥通过 `apksigner rotate` 建立合法 lineage，实现现有 Android 13+ 安装的覆盖升级。

实施时先核实旧签名、可用私钥和版本，再实际覆盖验证。缺少必要旧私钥时，暂停更换已部署应用的签名身份，不通过卸载清数据或偷偷换包名规避。

### 9.4 产品版本

根 `package.json` 的产品版本作为唯一对外版本来源；Tauri 配置、Host 启动器和发布信息同步或读取该值，发布前核对一致。

当前对外已有 `1.0.0`，后续向前递增；这一轮改造以 `1.1.0` 为目标正式版本。开发构建保留构建提交信息，正式发布由明确 tag 触发。

Android versionCode 在现有 Gradle 发布配置中独立单调递增，任何已经分发的正式 APK 编号不复用。不能假定当前自有 Gradle 项目会自动使用标准 Tauri Android CLI 的版本推导。

本轮采用显式版本变更和 tag，不引入 release-please、semantic-release 或自建通用版本机器人。只同步项目已经存在的产品版本字段。

### 9.5 发布渠道

- GitHub Releases 保留不可变版本 tag、安装包、签名、校验文件、更新说明与源码关联。
- 停止删除重建唯一 `latest` Release；最新版本使用 GitHub 的最新 Release 入口，历史版本可下载。
- 桌面采用 `tauri-action`，在之前运行既有 Host/资源准备脚本。Windows 明确选择 NSIS 更新产物。
- Android 保留当前 Gradle/SDK 构建，不迁移为另一套 Android 工程。
- Docker 使用官方构建发布 Actions，镜像发布到 `ghcr.io/<仓库所有者>/e-launcher-center:<版本>`，另更新稳定 `latest` 标签。
- 安装包签名和上传由受保护发布流程完成；中心管理员再选择上传并发布哪些版本，不把用户中心凭据放进官方 CI。

官方首批沿用现有主要平台：Windows x64、Linux x64、Android arm64-v8a；Android x86_64 保留开发验收用途。不因本轮发布改造增加桌面 ARM、多 init 系统或新移动平台支持。

## 10. 专用 rg / fd 与 Pi 依赖

### 10.1 rg / fd

rg 为内容搜索、fd 为文件查找提供能力，是运行时组件。

- 构建阶段准备固定版本和目标架构，校验可信来源的固定 SHA-256。
- 放入现有 Host 运行资源布局，随 NSIS、DEB、APK 分发。
- 运行时按本产品确定的安装路径调用，不查询系统 PATH 或其他 Pi 安装目录，不临时下载。
- Android 复用当前 NDK 编译、源码摘要和 ABI 校验流程。
- 完整许可证随对应二进制分发。

复用现有资源打包与下载脚本，不增加终端用户工具安装步骤、通用二进制包管理器或新的 shell 插件。

### 10.2 Pi

以精确正式版本、lockfile 和 npm ci 为常态。当前 `scripts/pi-main.json` 固定 SHA 保留到用户需要的 bug fix 正式发布，不改成浮动 main。

实施时定位该修复的上游 PR/commit，记录第一个包含修复的发布版本。确认后整体核对 Durable、chord、pi-ai、pi-codemode、pi-mcp、pi-telemetry，切回精确发布版本，并删除本次例外的源码构建、重打包及 Docker/Gradle 准备步骤。

不新增源码版/正式版用户开关，不用 patch-package 建第二套临时维护方式。Renovate/Dependabot 本轮不引入。

## 11. LGPLv3、来源和分发材料

自有代码选用 `LGPL-3.0-only`。Operit 派生代码及其他第三方代码保留其真实许可，不强行改写为项目许可。

改动根许可证前，核对 Ogesture 的现存派生范围、其他 AGPL 来源、自有代码及外部贡献的再许可权利。历史版本已有授权继续有效。若发现仍须保留 AGPL 的代码，先处理对应来源或授权，不能直接覆盖许可证文本。

采用 SPDX 和清晰来源声明；不宜改写的 vendored 文件可用 REUSE 外部注释方式标识。ScanCode 仅辅助盘点，来源判断结合实际代码和 Git 历史。

保留当前按实际 bundle/Cargo 图收集许可的实现，补缺失文本和版本映射；不整体替换为 cargo-about 或 AboutLibraries，也不增加新的原生许可 UI。

LGPLv3 与其引用的 GPLv3 完整文本、项目声明和第三方通知随 APK、桌面包及中心镜像分发。客户端提供许可和对应源码入口，发布版本能关联实际源码与构建材料。

Pi 当前固定 SHA 与后续发布版的许可分别核对，不继续用过时版本说明冒充当前来源。

## 12. 文档、敏感文件与范围边界

### 12.1 文档

更新 README、`AGENTS.md`、中心部署、桌面、移动端和升级说明。明确当前架构、有效命令、支持平台、首次连接自动配置、服务身份、开机行为、更新和数据位置。

删除不存在的命令、链接以及已移除功能的当前使用说明。历史验收记录保留提交和范围，不能作为当前版本已通过的证明。

继续使用仓库 Markdown，不建设文档站。需要链接检查时使用 lychee，不另写通用链接扫描器。

### 12.2 敏感文件

补齐 `center.env`、`center-certs/`、适用的本地 `.env`、Android 签名私钥和 Tauri 更新私钥的忽略规则。保留不含秘密的示例。

分别核对 `.gitignore` 和 `.dockerignore`，不以 Docker 排除代替 Git 排除。可以按需用 Gitleaks CLI 做一次历史盘点，但不新增扫描平台或强制 CI 体系。

### 12.3 学习和隐私设置

按用户决定，不围绕向自托管中心发送学习数据增加隐私政策、上传同意弹窗或独立上传开关。讨论中认为无必要的该设置入口不保留，实施时精确核对前后端调用并同步说明。

这一决定不扩展为删除学习任务取消、状态管理或全部插件启停能力，不改变本轮未讨论的其他功能。

### 12.4 明确不做

- 新测试框架、覆盖率目标、全量持续回归矩阵。
- 社区运营、英文推广、Issue 模板或贡献者治理体系。
- 多租户云服务、额外账户和隐私授权体系。
- 灰度、多通道、强制更新、差分更新、通用自动回滚。
- 独立更新服务器、独立 Linux Host 下载包、中心自更新或运维平台。
- AppImage 迁移、永久双 Relay 端口、长期 Pi 双依赖模式。
- 给模型工具默认管理员/SYSTEM 权限，或创建通用本机提权接口。

## 13. 实施顺序与交付边界

| 阶段 | 交付 | 完成标准 |
| --- | --- | --- |
| 1. 基线盘点 | 旧服务、数据路径、签名身份、许可来源、Pi 修复引用 | 有可执行迁移记录，保留现有数据与身份 |
| 2. Windows 服务基础 | windows-service、虚拟账户、受保护安装目录、数据 ACL、Shower 会话衔接 | 无图形登录时 Host 能运行；已有用户会话可按原能力接入 Shower |
| 3. Linux 服务与包生命周期 | 保留 DEB，完善首次连接启用、linger、升级钩子与用户归属 | 重启运行、状态保留及包升级恢复可实际验证 |
| 4. 中心单入口 | 单 HTTP server、代理配置、内部路由 | 网页、API、SSE、WebSocket 经同一公共地址可用 |
| 5. 发布基础 | 产品版本、签名、专用工具、许可材料、GitHub/GHCR 产物 | 无维护者秘密可构建开发包，正式产物身份与版本一致 |
| 6. 更新服务与客户端 | 中心上传发布、桌面 updater、Android 安装桥 | 三端真实更新、取消和失败路径可用，数据保留 |
| 7. 文档收尾 | 当前安装、迁移、服务和更新说明 | 外部用户能按文档完成既定操作 |

Pi 切回正式版本取决于修复发布，单独跟踪，不阻塞其他阶段。所有任务保持小范围修改，复用现有代码，不为本轮建立新的通用架构层。

## 14. 端到端验收与完成条件

不新增测试代码或测试体系。实现后由父助手执行与改动直接相关的端到端验收，分别记录静态检查、构建和真实运行结果。

必须覆盖：

1. 全新 Windows/Linux 安装，首次连接中心后自动配置、立即启动并实际上线。
2. 机器重启，未打开客户端、未登录图形桌面时，Host 按设计启动；Windows 核心能力与 Shower 会话能力分别验证。
3. 关闭界面不停止 Host，重连不重复登记，用户关闭的自启动不被升级恢复成开启。
4. Windows 从旧 currentUser 安装迁移到服务模式，原设备身份、数据库和已配置工作目录保持可用，无双实例。
5. Linux 包脚本定位正确用户，未错误操作 root 的用户服务，linger 和已有其他服务不被误改。
6. 中心内部 HTTP 经用户代理提供 HTTPS/WSS，登录、OAuth 回调、事件流、设备连接和更新下载可用。
7. 管理端上传并发布 NSIS、DEB、APK，实际产物与版本/平台/架构/格式匹配。
8. 下载和验签失败不停止可用 Host；安装前停止失败不继续替换；成功或失败后的服务恢复不依赖客户端窗口打开。
9. 桌面更新后的客户端和 Host 来自同一版本，数据、凭据、配对和用户设置保留。
10. Android 实际覆盖更新，验证权限、用户确认、取消、失败及下次启动版本确认，原数据保留。
11. 不预装 rg/fd、不存在其他 Pi 工具目录时，随包工具完成真实搜索。
12. 外部 clone 不持有官方秘密也能开发构建；正式签名、版本、许可和对应源码材料完整。

截图、日志、私有备份和运行资料保存在仓库外。本文及后续验收记录只写版本、范围、结果和可公开证据，不提交凭据。

## 15. 执行检查：核实事实，不重新选型

以下项目已经有处理原则，实施时需要取得实际证据：

- 旧 Android 签名与私钥是否可用于 lineage，覆盖升级是否实际通过。
- 自有代码改 LGPL 的来源与权利是否满足条件。
- Windows 虚拟账户对已登记 Host home 和工作区的访问是否正确，服务程序目录是否受保护。
- Shower 用户代理、现有 guardian 和服务之间的身份及会话归属是否正确。
- Linux systemd/linger、开机数据可用性、DEB 授权和依赖安装是否符合目标部署环境。
- Pi 所需修复的准确引用和正式发布版本。
- Rust 工具链、锁文件和 updater/CLI 的实际兼容性；固定满足要求的正式工具链，不以浮动 nightly 作为发布基础。

若事实核实失败，记录具体原因并停止受影响的发布步骤，不改用清数据、换应用身份、关闭验签或提高 Agent 权限来绕过。

## 16. 相关文档、源码与依据

完整比较与 50 条来源索引见[现成方案调研报告](open-source-release-solutions-research.md)。

本次新增决定的主要依据：

- [Windows CreateServiceW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew)：虚拟服务账户 `NT SERVICE\ServiceName` 与无需账户密码的配置方式。
- [Windows Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)：服务与用户会话进程分工。
- [Tauri NSIS 配置](https://v2.tauri.app/reference/config/#nsisconfig)：`perMachine` 安装到 Program Files，需系统权限。
- [systemd loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)：linger 的开机与登出行为。
- [Tauri updater 2.14.1](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.14.1/plugins/updater/src/updater.rs)：包格式、验签与安装路径。
- [CLI 2.12.4 更新签名](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/bundle.rs)：DEB/NSIS 签名及版本绑定。
- [Android PackageInstaller](https://developer.android.com/reference/android/content/pm/PackageInstaller)、[apksigner](https://developer.android.com/tools/apksigner)：原生安装与签名轮换。

主要改动入口：

- `center-server/server.js`、`cli.js`、`host-bridge.js`、`routes.js`、`center-web/`
- `host-core/relay-server.js`、`relay-control.js`、`center-client.js`
- `desktop/web/src/CenterGate.tsx`、`desktop/src-tauri/src/host_service.rs`
- `desktop/host-launcher/src/main.rs`、`autostart.rs`、`paths.rs`、`supervisor.rs`
- `host-core/native/windows/`、现有 Shower 管理和启动代码
- `desktop/windows/installer-hooks.nsh`、`desktop/linux/e-launcher-host.service`
- `desktop/src-tauri/tauri.conf.json`、`tauri.windows.conf.json`、`tauri.linux.conf.json`
- `host-core/build-desktop.js`、`build-android.js`、`build-mobile.js`
- `host-core/prepare-tools.js`、`prepare-android-tools.js`、`search-bin.js`
- `app/build.gradle`、`app/src/main/AndroidManifest.xml`、Android Tauri 插件与 Host 桥
- `scripts/pi-main.json`、`scripts/prepare-pi-main.mjs`、相关 manifest 和 lockfile
- `compose.yaml`、`Dockerfile`、`.github/workflows/`
- `LICENSE`、`THIRD_PARTY_NOTICES.md`、`licenses/`、`.gitignore`、`.dockerignore`
