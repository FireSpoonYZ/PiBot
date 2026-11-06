# 开源发布改造：现成方案逐项调研与修订建议

> **选型已定稿：**用户已授权助手决定剩余选型。最终采用 DEB、Windows 原生服务与专用虚拟账户、Tauri 桌面更新、Android PackageInstaller、中心内版本管理和 GitHub/GHCR 发布。服务身份、安装权限、Shower 会话及升级恢复责任见[实施定稿](open-source-release-and-update-plan.md)。下文保留调研时的候选比较与建议措辞，不再作为当前未决事项清单。

调研日期：2026-11-06。仓库基线：`3319c53`。

评审对象：[开源发布、中心整合与客户端升级改造方案](open-source-release-and-update-plan.md)。本报告按其中的实际工作项比较官方机制、现成组件和当前仓库可复用的实现；不修改业务代码，也不把候选选型当作用户已确认的决定。

## 1. 最重要的更正与建议

### 1.1 必须更正：Tauri updater 已经支持 DEB / RPM

前一轮“官方 updater 在 Linux 只支持 AppImage”的判断错误。入门文档未完整列举所有产物，因此本次继续检查了发布记录、固定版本源码和构建端实现：

- 官方 `updater v2.10.0` 更新日志明确宣布支持 Linux Deb、Rpm、AppImage，以及 Windows NSIS、MSI。[S01]
- 已发布的 Rust `tauri-plugin-updater 2.14.1` 含 `install_deb`、`install_rpm` 和按包格式选取产物的逻辑；不是仅存在于未发布分支的功能。[S02][S03]
- 仓库已使用的 Tauri CLI `2.12.4`，其 `sign_updaters` 已包含 `PackageType::Deb`、`PackageType::Rpm`，可以为这些包产生更新签名。[S04]
- updater `2.14.1` 要求 Rust 1.90，依赖 Tauri `^2.12`；当前桌面 Tauri 为 `2.12.5`，版本范围匹配，仍需实际安装依赖和构建确认。[S03][S05]

**修订建议：Linux 优先保留现有 DEB + systemd，接官方 updater。AppImage 保留为候选，不再作为应用内升级的必要前提。** 用户原本只是表示可以考虑 AppImage，应在这次事实更正后重新选择。

这能省去 AppImage 自复制安装、固定路径迁移、独立挂载生命周期以及 DEB 向 AppImage 数据和服务迁移等工作。

### 1.2 Windows 有成熟服务组件，但账户和安装权限仍须设计

现有 Rust Host 启动器适合接 `windows-service`，无需手写完整 Win32 服务协议。WinSW 也是成熟替代方案。[S10][S12]

不过，现有 NSIS 是 `currentUser` 安装，Host 路径从当前用户环境变量解析。系统服务采用另一身份后，目录、凭据、工作区访问和图形会话都会变化。这些问题不会因为使用服务库自动解决。

**修订建议：先确定服务账户、程序目录权限和数据归属，再接服务组件。** 保留“首次连接自动配置，开机无需登录运行”的需求，不用登录启动插件替代。

### 1.3 应用更新本身尽量复用，服务协调保留最小项目逻辑

下载、签名校验和安装器调用可交给官方 updater 或 Android 平台。中心的“哪个版本供哪台设备下载”、首次配对，以及更新时停止和恢复 Host，属于本项目的业务衔接。

没有找到一个成熟组件能直接包办本项目的中心、设备身份、跨平台 Host 服务与更新流程。合理目标是复用成熟基础能力，只实现必要衔接，不另建通用部署平台。

## 2. 调研方法与成熟度判断

搜索用于发现候选，关键结论以官方文档、固定版本源码、发布记录和当前仓库接线为依据。版本支持不只看产品首页；更新器的 DEB 支持就是本次进一步查源码后修正的例子。

评估顺序：当前仓库已经实现的能力、操作系统标准接口、项目官方组件、有实际产品使用的第三方组件，最后才是自行实现。比较内容包括功能适配、维护状态、许可证、引入的运行组件及仍需自写的工作。

部分候选的维护快照如下。星标只作采用范围参考，不作为质量结论；`pushed_at` 也只表示仓库更新时间。

| 候选 | 本次核对结果 | 对本项目的意义 |
| --- | --- | --- |
| Tauri updater | 已发布 `2.14.1`；MIT / Apache-2.0 | 桌面首选；支持 DEB/RPM/NSIS/AppImage；不支持 Android 安装 |
| `windows-service` | Mullvad 维护，未归档；仓库 2026-10 有更新；Mullvad daemon 实际依赖 | 适合现有 Rust 启动器 |
| WinSW | MIT；GitHub latest 稳定版为 `2.12.0`（2023-01）；v3 页面对应 alpha 发布线 | 成熟包装器，但不能把 v3 文档特性直接当作 v2 稳定版能力 |
| `jenly1314/AppUpdater` | MIT；`2.2.0` 于 2026-08-04 发布；约 972 星 | Android 下载与安装辅助的有效候选 |
| XUpdate | Apache-2.0；约 2409 星；API 显示最近 push 为 2024-03；README 明确列出的兼容范围到 Android 12 | 有采用量；适配当前 targetSdk36 需另核实 |
| FaynoSync | Apache-2.0；2026-11 仍有更新；约 158 星 | 功能较完整的独立更新服务器，部署规模超出本项目需求 |

维护信息来自项目 API 和发布页，见来源区，不代表本次运行过这些项目。[S46][S47]

## 3. 与原方案逐项对应的结论

| 原文工作项 | 成熟方案 | 本次建议 | 仍需项目处理 |
| --- | --- | --- | --- |
| §4 单端口中心与 Relay | Fastify + 已使用的 `ws` | 复用 `noServer` / `handleUpgrade`，不换 Socket.IO | server 生命周期、现有认证与路由接线 |
| §4 HTTPS 外置 | Caddy / Nginx 等反向代理 | 只给部署示例，不打包进服务、不管理证书 | 公共 URL、可信代理、Cookie / OAuth / WSS 地址 |
| §4 中心内部控制 Host | 当前 Relay 控制路由 | 复用请求关联、超时与断线逻辑 | 增加明确的内部调用入口 |
| §5 首次连接自动配置 | 当前配对和 Host 启动器 | 保留并补齐可恢复步骤 | 系统授权、状态显示、重复配置处理 |
| §5.3 Windows 开机服务 | `windows-service`；备选 WinSW | 优先在现有 Rust 启动器接 `windows-service` | 账户、数据 ACL、Shower 会话、升级权限 |
| §5.4 Linux 开机服务 | systemd 用户服务 + linger | 保留已有机制，优先从 DEB 安装位置运行 | 首次启用、授权、状态核实 |
| §5.4 AppImage 安装 | AppImageLauncher、XDG desktop 文件、systemd | AppImage 为候选；不强制用户安装 AppImageLauncher | 无窗口入口、稳定路径及挂载协调 |
| §6 中心版本管理 | Tauri 标准更新 JSON + 已有 Fastify 上传与静态文件能力 | 中心内少量新增接口；不部署完整更新平台 | 上传、版本记录、发布状态、平台选择 |
| §7 Windows 更新 | Tauri updater + NSIS hooks | 直接采用 | 停止和恢复 Host、授权失败处理 |
| §7 Linux 更新 | Tauri updater 的 DEB/RPM/AppImage 支持 | 优先 DEB，复用包管理与安装钩子 | 用户服务生命周期与依赖变更处理 |
| §7 Android 更新 | Android PackageInstaller；可比较 AppUpdater | 默认已有 OkHttp + PackageInstaller | Tauri 桥、界面进度、自更新结果恢复 |
| §7.5 更新签名 | Tauri signer / updater；Android APK 签名 | 复用标准，不自定义签名协议 | 密钥保管、信任公钥与 fork 发布约定 |
| §8 发布流水线 | `tauri-action`、Docker 官方 Actions、GitHub Releases | 使用现成构建发布组件 | 现有准备脚本接线、平台产物关联 |
| §8 版本同步 | release-please 或简单版本文件 | 先单一产品版本；需要自动 Release PR 时用 release-please | Android versionCode 独立递增规则 |
| §8.4 Android 签名迁移 | `apksigner rotate` 与 lineage | 先核实旧私钥，再选迁移方案 | 真实覆盖升级验证 |
| §9 rg / fd | Tauri externalBin / resources + 原有构建脚本 | 专用版本随包，构建校验 | 各平台路径、原生 ABI、许可证 |
| §10 Pi 正式版 | npm 精确版本 + lockfile + npm ci | 修复发布后删除临时构建链 | 确认具体修复包含在哪个版本 |
| §11 LGPL 和来源 | SPDX / REUSE、ScanCode；现有许可打包器 | 一次性来源盘点，保留当前有效收集逻辑 | 再许可权利判断、派生范围 |
| §12 文档与敏感文件 | Markdown、lychee、Git ignore；可用 Gitleaks | 修正文档，按真实路径忽略；工具按需使用 | 文档的事实准确性 |
| §12.3 学习开关 | 现有设置和后端 | 产品决策，不需要新 SDK | 精确定位要移除的入口与调用 |
| §13–15 顺序与验收 | 平台工具、现有运行入口 | 先解决 Linux 格式和 Windows 身份；保持端到端验收 | 不新增测试体系，不把文档调研当运行验收 |

## 4. 中心整合：已有依赖足够

### 4.1 Fastify + ws，或 @fastify/websocket

`ws` 官方文档直接提供“多个 WebSocket server 共用一个 HTTP server”的示例：`noServer: true`、监听 HTTP server 的 `upgrade`、调用 `handleUpgrade`。[S06]

`@fastify/websocket` 是另一种成熟方案，基于 ws，能把 WebSocket 连接与 Fastify 路由/hooks 整合。[S07]

本项目的 Relay 已有完整的首帧认证、连接角色、消息协议和背压控制，也已经使用 `noServer`。**选择直接挂接 Fastify 的底层 server 更小**，无需为了合并端口再添加一层插件并迁移认证生命周期。

不能假定原生 `upgrade` 会自动经过普通 Fastify API 路由 hooks；Relay 原有身份校验继续保留。Socket.IO 会带来新协议和客户端改动，不适合只为统一监听端口引入。

### 4.2 反向代理无需自行实现

Caddy 的 `reverse_proxy` 原生支持 WebSocket，部署文档可提供一个单上游示例；已有 Nginx、Ferron 等代理的用户沿用自己的配置。[S09]

项目服务保持 HTTP/WS，公共地址仍由部署者设置。需要检查真实代理下的 secure cookie、登录、OAuth 回调、SSE 和 WSS。Fastify `trustProxy` 应按可信代理部署范围配置，不无条件信任任意客户端的转发头。[S08]

当前 `center-server/auth.js` 已使用 secure cookie。外部 HTTPS 与内部 HTTP 是正常部署组合，不应为让内部 HTTP 工作而把所有 Cookie 和 TLS 校验关闭。

### 4.3 不需要额外消息总线

中心与 Relay 在同一进程，内部调用复用当前 `relay-control` 的请求路由即可。引入 Redis、NATS 或 RabbitMQ 不会减少本次改动，反而新增部署组件。

## 5. Windows：优先接现有 Rust 服务库

### 5.1 比较

| 方案 | 解决的问题 | 限制或成本 | 结论 |
| --- | --- | --- | --- |
| `windows-service` | 注册 ServiceMain、SCM 状态、停止事件、服务管理 | 需要在 Rust 启动器中接入 | 首选 |
| WinSW | 将现有可执行程序包装为 Windows 服务，配置重启、日志、停止命令 | 多一份包装器和配置，与现有监督器存在重叠 | 有效备选 |
| `service-manager` | 跨平台安装、启动、停止、卸载服务 | Windows 有 sc.exe/WinSW 等后端；注册服务与实现服务入口不是同一件事 | 当前只支持 Windows/systemd，不必先加统一抽象 |
| Tauri autostart | 应用随用户登录启动 | 不满足“未登录桌面时运行 Host” | 不用于本需求 |
| 直接 sc.exe 注册普通 exe | 写服务配置 | 普通程序不因此具备 ServiceMain 和控制处理 | 不作为完整方案 |

`windows-service` 的 README 有完整的入口、状态转换和停止事件示例；Mullvad VPN 的 daemon manifest 实际使用该 crate，这是比单看星标更有价值的采用证据。[S10][S11]

WinSW 可配置 `stoparguments` / `stopexecutable`，可以调用项目现有停止路径，适合希望尽量不改启动器的方案。但它默认使用 LocalSystem；选用时必须明确账户，不能直接套默认值。[S12][S13]

**推荐新增的运行时依赖是 `windows-service`，不同时叠加 WinSW 和 service-manager。** 最终版本按兼容性固定。

### 5.2 需要先于编码决定的服务身份

现有事实：

- NSIS `installMode` 为 `currentUser`。
- Host 配置默认位于 `%LOCALAPPDATA%/e-launcher/host-service`。
- Host 会执行模型工具，包括文件读写和 shell。
- Shower 使用当前用户、父/子会话与凭据管理器，已有文档注明依赖交互式用户会话。

因此至少需要明确：服务以谁的身份执行、访问哪些原有工作目录、凭据如何读取、程序文件谁能修改，以及客户端如何请求停止和升级。

如果高权限服务直接运行普通用户可改写的安装目录中的程序，替换该程序就可能借服务权限执行。使用低权限服务身份可减少权限，但不会自动获得原用户工作目录和凭据权限。[S14][S15]

“使用原用户账户作为服务账户”也需要处理服务登录权和凭据；中心登录口令不是 Windows 账户凭据。不能预先承诺只登记服务就保留所有当前用户执行语义。

**这一项应从原文的普通“实现核实”提升为服务化前的设计决定。** 可以自动完成注册和授权流程，但账户方案需先明确。

### 5.3 Shower 与服务分工

Microsoft 明确说明现代 Windows 服务不能直接与用户桌面交互，推荐用户会话进程通过 IPC 与服务协作。[S15]

本项目已有 Shower 的 guardian 和会话归属机制，应复用和调整它，而不是让 Node Agent 整体以 SYSTEM 权限运行来绕过会话问题。仓库 `docs/windows-shower-startup-acceptance-20261027.md` 的既有验收没有覆盖无人登录的整机重启。

### 5.4 登录启动插件不能替代服务

Tauri autostart 的源码将自身能力描述为 launch at login，底层使用 `auto-launch`。[S16] 本项目明确需要开机运行，应使用 Windows SCM 与 Linux systemd，而不是因为插件名字叫 autostart 就认为已经满足要求。

## 6. Linux：重新比较 DEB 与 AppImage

### 6.1 推荐保留 DEB

| 项目 | DEB + systemd | AppImage + systemd |
| --- | --- | --- |
| 官方 updater | 已支持 | 已支持 |
| 当前仓库接线 | 已有安装路径和单元文件 | 已有打包，但缺服务安装流程 |
| 程序安装位置 | 包管理器负责 | 应用需要自行固定位置 |
| 应用菜单、图标 | Tauri bundler 生成 | 需要集成或用户借助工具 |
| Host 开机运行 | 直接运行安装好的启动器 | 需要无窗口 AppImage 入口和独立挂载生命周期 |
| 升级权限 | 包管理通常需要系统授权 | 用户目录通常可直接替换文件 |
| 更新依赖 | DEB 声明依赖；当前 updater 使用 dpkg 安装 | FUSE、系统库和无图形启动条件仍要处理 |
| 现有用户迁移 | 延续当前包和数据路径 | 需额外处理旧包、旧单元与新路径 |

本项目既有 DEB，又强调后台 Host 服务。**保留 DEB 的集成成本更低，且更符合已有部署方式。** AppImage 的用户级更新优势仍存在，但它不是规避 DEB updater 缺失的必要迁移。

### 6.2 官方 DEB 更新具体怎样工作

updater `2.14.1` 会识别当前包格式，并为 DEB 使用 `dpkg -i`，为 RPM 使用 `rpm -U`。授权路径先尝试 `pkexec`，随后有图形密码输入和 sudo 的回退。[S02]

这意味着：

- 包选择必须包含包格式，不能只以 `linux-x86_64` 混发 DEB 和 AppImage；使用官方支持的格式键或等价动态端点选择。
- 需要在支持的桌面发行版验证授权提示及取消行为，不能把“插件支持”写成“无授权静默安装”。
- `dpkg -i` 不是 `apt` 的完整依赖求解流程。新版本引入额外系统依赖时，要有相应安装策略和明确失败信息。
- 服务升级前后操作继续由项目接线。Tauri 的 `DebConfig` 提供 pre/post install/remove 脚本入口，当前仓库仅打包了单元文件，尚未配置这些钩子。[S18]
- 包安装脚本通常以 root 运行，不能直接把 `systemctl --user` 当成已选中的应用用户服务。需明确已配置用户的身份和恢复方式，或由现有客户端/启动器协调自己的用户服务。

Linux 构建应使用足够旧且满足 WebKitGTK 要求的发行版基线。AppImage 也不会自动消除较新 glibc 带来的兼容问题。[S19]

### 6.3 systemd + linger 是成熟机制

systemd 官方 `loginctl` 手册明确：启用 linger 后，用户 manager 在开机时产生，并在退出登录后保留，可以运行长期服务。[S17]

沿用用户服务和用户数据是 Linux 上最小的改动。首次中心连接时自动写入/识别单元、启用 linger、enable/start，再查询真实状态即可。

linger 作用于整个用户，不是本应用专用开关。移除本应用服务时，不能无条件关闭用户原有 linger，影响其他服务。home 在开机阶段是否可访问、systemd 用户 manager 是否可用，也应作为实际支持环境的验证内容。

### 6.4 如果最终仍选 AppImage

AppImageLauncher 可以把 AppImage 放到固定目录并创建桌面入口；AppImageUpdate 提供基于嵌入更新信息的更新机制。但它们不负责本项目的中心配对、Host 服务注册、凭据和升级时任务协调。[S20][S21]

不建议要求所有用户再安装 AppImageLauncher，也不建议在 Tauri updater 之外再加入 AppImageUpdate，形成两套更新来源。

原方案的单包 `--host` 路线仍可作为候选：在初始化 Tauri GUI 之前分流到已有 Host 启动器，systemd 指向固定的 AppImage 本体。`APPIMAGE` 是文件路径，`APPDIR` 是运行时挂载目录，不能混用。[S22]

FUSE 不可用时的 extract-and-run 会产生临时展开目录并在退出后清理，后台 Host 不能依赖即将被客户端清理的文件。[S23] 因而这条路线必须先做实际无图形启动、关闭窗口继续运行、重启恢复和更新衔接验证，再承诺全面替代 DEB。

## 7. 中心更新服务：有现成产品，但不适合整套引入

### 7.1 比较

| 方案 | 能力 | 与当前需求的差距 | 结论 |
| --- | --- | --- | --- |
| Tauri 静态 JSON / 动态更新协议 | 标准版本查询、产物 URL、签名 | 需接现有管理端上传和发布 | 首选协议 |
| FaynoSync | 自托管更新服务器、Dashboard、版本/通道/制品管理，支持 Tauri | Quickstart 引入 API、MongoDB、Redis、S3 兼容存储 Garage 等；另有自己的管理体系 | 可参考 API，不整套部署 |
| vonPB/tauri-update-server | 代理私有 GitHub Releases，不暴露 GitHub token | 以 GitHub 为制品来源，不解决本中心直接上传和现有认证整合 | 不采用 |
| CrabNebula Cloud | 与 Tauri 更新协议集成的发布服务 | 本次用户要求中心自托管并上传安装包 | 不作为默认依赖 |
| Velopack | 另一套桌面安装、自动更新与差分更新框架 | 不是 Tauri server 插件；需调整打包和客户端生命周期 | 不为本次需求替换 Tauri |

这些候选分别已核对官方 README 或文档。[S24][S25][S26][S27]

### 7.2 最小合理实现

复用中心现有的 Fastify、multipart、静态文件服务、数据库和所有者认证。新增客户端 release 记录和发布状态，遵循 Tauri 标准响应即可。

上传大文件时使用流式写入和摘要计算，不把整份安装包读进 API JSON。上传限制要适配实际 Node/Host 安装包大小。文件成功保存后再公布版本记录。

平台、架构、格式、版本、签名和摘要从构建产物清单导入比纯手填更可靠；管理员仍可上传，但中心要核对真实产物与元数据的一致性。

客户端安装包记录与受管插件的 installation/deployment 是不同业务。可以复用文件保存和摘要校验代码，不应为复用而让应用升级触发 Bot 插件部署流程。

这部分写少量业务代码比引入完整第三方更新平台更省维护成本。

## 8. 桌面 updater：官方负责安装，项目负责 Host 生命周期

使用固定兼容版本的 Tauri updater。当前已核实 `2.14.1`，其平台支持、签名和最低工具链条件足够明确。[S02][S03][S05]

官方提供分离的下载和安装 API，因此可以先完成下载和签名校验，接着停止 Host，再执行安装，不必在下载过程中让服务停机。

### 8.1 Windows 更新

保留 NSIS 的安装钩子，可靠停止服务后才替换文件。当前钩子直接丢弃 Host 命令退出码，实施时要改为处理真实失败。

updater 文档区分 passive/basicUi/quiet，quiet 模式不能自行请求管理员权限。[S28] 一旦 Windows 采用系统服务或受保护安装目录，更新授权和服务控制权限必须一起设计，不能继续假定所有步骤都能在 currentUser 模式静默完成。

### 8.2 Linux 更新

DEB 可复用安装路径和包管理脚本；AppImage 则由 updater 替换对应文件。两者都要保留升级前 Host 状态，并在失败或完成后恢复应有状态。

原方案“新 UI 启动后恢复 Host”覆盖不足：如果安装后 UI 没启动，Host 可能一直停着。恢复责任需要由安装生命周期或独立的受控协调步骤承担，不能只放在前端组件的挂载回调。

不需要自建通用事务框架，但下载、服务暂停、安装、恢复各阶段必须明确谁负责，且失败后能查到状态。

### 8.3 更新源与认证

Tauri 支持运行时配置 endpoint、headers 和 HTTP client 配置，适合中心地址由用户选择的产品。[S28] 认证与下载应从原生侧复用已建立的中心身份，避免为接 updater 再把秘密落到网页存储。

不同公开中心可以使用同一组已签名官方安装包。证书信任与更新公钥信任是两个独立配置；内部服务使用 HTTP 不意味着外部下载需要跳过 TLS 校验。

## 9. Android：认真比较现成库后，仍推荐平台 API

### 9.1 候选比较

| 方案 | 已有能力 | 仍缺少或重叠的部分 | 建议 |
| --- | --- | --- | --- |
| Android PackageInstaller | 系统安装 session、状态回调、用户确认 | 需查询版本、下载及桥接 | 首选安装机制 |
| Android DownloadManager | 系统下载、下载状态、网络恢复 | 自定义证书和网络配置与现有中心连接的兼容性需核实 | 真需要系统后台下载时使用 |
| 现有 OkHttp + PackageInstaller | 已有网络库，支持项目自己的请求配置 | 写小型下载及安装桥接 | 当前默认推荐 |
| jenly1314/AppUpdater | 核心下载和可选 UI 分离，进度、取消、通知、安装 Intent | 需与 React 更新界面及中心鉴权接线；现有安装帮助代码为 ACTION_VIEW/FileProvider | 如果希望复用下载通知模块，可只采用核心包 |
| XUpdate | 检查、解析、提示、下载、安装监听等完整框架 | 与共享 React UI、统一元数据重叠较多；Android 13–16 支持需核实 | 不作为默认方案 |
| javiersantos/AppUpdater | 检查商店或服务器版本并提示 | 更偏版本检查/提示，不是本项目完整安装流程 | 不采用 |
| tauri-plugin-android-installer | 将本地 APK 交给安装 Intent | README 明确不追踪取消和安装失败，仅报告是否启动安装器 | 不满足原文完整结果处理要求 |

候选已有一定采用量，不能概括为“Android 没有现成方案”。本项目不选整套更新框架的原因是已有网络层和共享界面，重复部分多。[S29][S30][S31][S32]

### 9.2 为什么仍选 PackageInstaller

PackageInstaller 是操作系统提供的成熟安装机制，不是重新实现 APK 安装。我们只实现 Tauri 到 Kotlin 的桥接与界面衔接。

本次核对 `jenly1314/AppUpdater` 的 `AppUtils.kt`，安装逻辑使用 `Intent.ACTION_VIEW` 与 FileProvider；其默认校验能力包含 MD5，主要用于文件识别。若目标是明确区分取消、失败和需要用户操作的状态，直接接 PackageInstaller session 更符合原文要求。[S30][S33]

实际结果处理仍需考虑自更新会替换并终止原应用进程。保存必要的待更新版本，在下次启动读取已安装版本来完成最终确认。安装器已打开只能显示“等待系统安装”，不能显示“升级完成”。

APK 包名、versionCode 和签名身份校验由 Android 平台最终执行；SHA-256 用于下载完整性。MD5 或同一服务器返回的摘要不能替代发布签名身份。

这次不增加 Android 开机保活，不引入无用户确认的安装方案。

## 10. 签名：采用标准机制，并区分用途

### 10.1 桌面更新签名

用 Tauri CLI 生成和验证更新签名，不自造 RSA/Ed25519 协议。构建流程签名，中心存储安装包及 `.sig`，客户端内置可信公钥。[S28]

当前 CLI `2.12.4` 的构建端会把产品版本纳入签名，手动签名支持 `--app-version`；updater `2.14.1` 有 `requireSignedVersion`，可要求元数据声明版本与签名内版本一致。[S02][S04][S34]

本项目尚未建立正式 updater 用户基线，适合在第一次正式接入时使用匹配的 CLI/updater 并核对启用这一机制，省去自己实现“版本与文件绑定”。这是推荐配置，需与实际构建签名共同验证。

Tauri 更新签名、Windows Authenticode 和 Android APK 签名用途不同。采用 Tauri 签名不等于 Windows 已显示受信任发行者；是否申请 Windows 代码签名证书不在本轮自动扩大为硬要求。

### 10.2 Android 既有签名迁移

Android 官方 `apksigner rotate` 可以生成签名 lineage；v3.1 的轮换行为覆盖 Android 13+，项目 minSdk33 与这个方向相符。[S35]

先检查旧私钥和当前 APK 的签名身份，再决定保留身份或轮换。不能通过修改 Gradle 的签名文件路径就完成迁移，也不要把 Play 的 upload key 重置与直接分发 APK 的身份迁移混为一谈。

### 10.3 用户自托管与 fork

“官方构建内置官方公钥，fork 构建内置自己的公钥，中心只分发”的方案符合 Tauri 的标准使用方式。无需部署者持有官方私钥。

如果用户希望已安装官方客户端接受任意第三方签名包，那是另一项信任管理产品需求，不能由安装包上传入口默认获得。原文已将信任方案列为待确认，应继续保留这个状态。

## 11. 发布流水线与版本：复用官方 Actions

### 11.1 桌面发布

`tauri-apps/tauri-action` 支持构建、上传已有 Release、生成更新 JSON 和上传签名。[S36]

本仓库有特殊的 Host 和 Pi 准备脚本，仍需在 Action 前或现有构建入口中运行，不能用一段通用示例替换全部准备工作。

如果同时生成 MSI 与 NSIS，Action 有 `updaterJsonPreferNsis`，默认是 false。项目决定用 NSIS 更新时应明确配置，避免自动清单指向缺少既定钩子的 MSI。

DEB/RPM/AppImage 的清单要按实际选用的格式生成和核验；中心动态响应可直接使用同一批签名制品，不依赖某个静态 latest.json 的默认格式选择。

### 11.2 Android 和容器

Android 当前由自有 Gradle 项目构建，继续使用 Gradle 和 Android SDK 签名工具，不为了统一工作流迁移成另一套标准 Tauri Android 工程。

容器发布使用 Docker 官方 login/build-push/metadata Actions 和 GHCR。现有 Dockerfile 继续复用。[S37] 不增加 Watchtower 或自更新中心，用户仍选择何时升级服务端。

### 11.3 版本管理

release-please 的 manifest 与 extra-files 能管理多文件产品版本，并生成可审阅的 Release PR。[S38] 比自己写通用版本更新机器人更合适。

本期也可以采用更小的方式：一个产品版本来源、显式修改版本、tag 触发发布。只有需要自动化版本建议时才接 release-please；不再叠加 semantic-release、Changesets 等多套机制。

Android versionCode 独立保持递增。当前自有 Gradle 构建不会因为修改 Tauri 配置就自动获得标准 Tauri Android CLI 的版本推导，需要明确接线。

开发构建使用 Android 默认 debug 签名，官方构建用受保护配置。Fork 无发布 Secret 时应仍能构建开发包，不要求其取得维护者私钥。

## 12. rg / fd 与 Pi 依赖

### 12.1 专用搜索程序

Tauri `externalBin` 和 `resources` 是官方提供的随包分发方式，已有 Node 与 Host 正在使用它们。[S39]

rg/fd 可以放进现有 Host 资源布局，Host 按自身安装位置解析专用路径。无需因为是可执行程序就引入 Tauri shell 插件，已有原生进程调用路径可以继续使用。

构建阶段下载固定版本并比对固定 SHA-256；Android 复用已存在的 NDK 源码编译与摘要校验流程。不要把工具替换成面向终端用户的 mise、apt、winget 安装步骤，也不要改回运行时下载。

现有准备脚本大部分能力可复用，没有必要引入 cargo-dist 或新的通用二进制包管理器来解决两份程序的打包。

### 12.2 Pi 正式版本

采用 npm 精确版本、提交 lockfile、构建时 npm ci，是成熟标准路径。[S40]

当前所需修复的具体上游引用尚未提供。不能因为 npm 有更新版本就假定它已包含修复。确认修复进入正式包后，再整体处理相关 Pi 包和构建脚本。

`overrides` 不能自动把未发布源码变成正式包；patch-package 会引入另一套补丁维护。在现有固定 SHA 构建已满足临时需求时，不为“用现成工具”再替换临时方案。

Renovate 支持 npm、Cargo、Gradle、Dockerfile、GitHub Actions 等管理器，可作今后的更新提醒工具；保持默认不开自动合并。这是可选建议，未提升为本轮必做项。[S41]

## 13. LGPL、依赖通知与源码来源

### 13.1 能直接采用的工具

- **SPDX / REUSE**：描述每个文件或目录的许可证和版权来源；`REUSE.toml` 可用于不宜改写的第三方文件。[S42]
- **ScanCode Toolkit**：扫描许可证、版权与依赖元数据，适合作为一次性来源盘点的辅助工具。[S43]
- **cargo-about**：生成 Rust 依赖许可清单。[S44]
- **AboutLibraries**：收集 Gradle 依赖许可，提供生成数据和可选展示能力。[S45]

### 13.2 本仓库应怎么用

先用来源声明、Git 历史和必要的扫描核对 AGPL 派生代码范围。工具没有发现标记，也不能据此自动把第三方派生代码重新授权；文件改名、改写语言或删除注释也不会自动改变来源。

确定授权范围后，用标准标识和许可证文本整理项目。LGPLv3 本身引用 GPLv3，两个完整文本一同处理。[S48]

当前构建脚本已经按实际 bundle / Cargo 图收集许可，并包含精确 fallback。**优先补缺口，不立刻用新工具重写整套收集器。** cargo-about、AboutLibraries 可用来交叉盘点，只有现有维护成本明显过高时再替换对应部分。

AboutLibraries 的 Compose UI 与项目的 Tauri/React 界面无直接需求，不应为显示许可证引入新的原生 UI 栈。用既有界面显示生成的许可资料即可。

## 14. 文档、秘密文件与学习设置

### 14.1 文档

本轮先保持 Markdown，不需要部署 MkDocs/Docusaurus 文档站。lychee 能检查 Markdown/HTML 链接，适合发现已不存在的本地文档和外部链接。[S49]

链接工具无法判断“Widget 已移除但 README 仍在介绍”这类事实错误，仍需按当前源码人工修正文档。

### 14.2 敏感文件

`.gitignore` 按实际文件补齐即可，不需要秘密管理平台。Docker build context 的排除和 Git 提交的排除分别检查。

若做一次发布前历史秘密扫描，Gitleaks CLI 是成熟候选。本次读取的上游 README 已说明进入功能完成、主要做安全补丁维护阶段，并提到 Betterleaks；不能照搬旧资料称其持续扩展新功能。[S50]

不要求为了本轮引入付费扫描服务或新增整套 CI 门禁，也没有在本次调研中执行历史秘密扫描。

### 14.3 学习设置

这是已经讨论的产品范围，无需寻找新的 SDK。实施前应精确定位所指设置入口与后端语义，不把“无需学习上传隐私开关”扩大成删除学习作业取消、配置或所有插件启停能力。

保持用户已经排除的隐私政策、同意弹窗和社区运营事项不进入本轮。

## 15. 哪些工作仍需要自己实现

以下是业务接线，成熟组件不能代替：

1. 首次连接中心时依次完成设备身份、服务配置、Host 启动，并处理部分完成后的重试。
2. 中心上传产物、发布版本、按设备平台/架构/格式返回版本。
3. 更新时协调本机 Host、活动任务和系统安装器。
4. Windows 的执行身份、原用户数据和 Shower 会话关系。
5. Android 的 Tauri 桥、共享界面与自更新后的状态恢复。
6. 旧服务、旧安装位置和旧签名的迁移。

这些工作应复用现有配对、存储、认证、状态和启动器。不要因此引入通用工作流引擎、消息队列或跨平台服务抽象框架。

## 16. 推荐技术组合与优先顺序

### 16.1 推荐组合

| 层次 | 推荐 |
| --- | --- |
| 中心 HTTP/WebSocket | 当前 Fastify + ws |
| TLS 部署 | 用户自己的代理；文档给 Caddy/Nginx 等示例 |
| Windows 服务 | 现有 Rust 启动器 + windows-service |
| Linux 服务 | 现有 systemd 用户服务 + linger |
| Windows 分发/更新 | NSIS + Tauri updater |
| Linux 分发/更新 | 优先现有 DEB + Tauri updater；AppImage 留作候选 |
| Android 更新 | 现有 OkHttp + PackageInstaller + Kotlin/Tauri 桥 |
| 中心版本服务 | Tauri 标准协议 + 现有中心小型管理模块 |
| 发布 | tag / GitHub Releases + tauri-action + Docker 官方 Actions |
| 版本自动化 | 可选 release-please |
| 许可整理 | REUSE/SPDX + 一次性 ScanCode 辅助 + 现有许可收集器 |
| 文档链接与秘密扫描 | 可选 lychee / Gitleaks CLI，按需运行 |

### 16.2 先解决三件事

1. **重新确定 Linux 主分发格式。** 本次建议回到 DEB，保留用户最初的选择；不是未经确认自动取消 AppImage。
2. **确定 Windows 服务身份和文件权限。** 在此之前不承诺当前用户的所有工具、凭据和 Shower 能直接搬入后台服务。
3. **核实实际更新和恢复路径。** 优先验证 DEB 授权、Windows 服务停止/恢复、Android 覆盖更新；通过后再扩展中心上传界面。

这三件事比先实现所有更新管理 UI 更能降低返工。

### 16.3 对原文建议的具体修订

- 将“Linux 必须 AppImage 才能使用官方 updater”对应结论删除，修订为 DEB/AppImage 两条可选路线，推荐 DEB。
- 将 Windows 服务账户与安装目录从普通实现细节提升为明确设计前提。
- 标出 Tauri autostart 只适合登录启动，不作为开机服务方案。
- 中心版本选择包含安装格式，防止 DEB/AppImage 或 NSIS/MSI 混发。
- 将 Host 恢复责任放在安装生命周期或独立协调步骤，不只依赖新 UI 成功启动。
- 补充官方 CLI/updater 的版本绑定签名能力，避免另写签名协议。
- 保留 Android 平台 API 推荐，但记录已比较的成熟第三方库及不默认引入的原因。
- 原定排除项不变：不新增测试体系、隐私授权体系、社区运营或通用更新平台。

## 17. 调研范围与未执行事项

本次进行了多轮广泛搜索，检查了官方文档、发布 API、固定版本源码、项目 README 和当前仓库接线。部分搜索请求限流后改用其他搜索来源与直接获取官方材料；404 或无法核实的页面未作为支持性依据。

本次未安装候选依赖、未运行构建、未配置 Windows/systemd 服务、未操作真实升级，也未执行 ScanCode、Gitleaks 等扫描。维护快照与功能支持是静态证据；端到端行为仍按原方案在实施后验证，不新增测试代码。

最需要运行确认的风险是 Windows 服务身份与现有 Shower 的兼容，以及 Linux DEB updater 的授权、包依赖和用户服务恢复。AppImage 迁移不应再由错误的平台支持判断推动。

## 来源

[S01]: https://github.com/tauri-apps/plugins-workspace/releases/tag/updater-v2.10.0
[S02]: https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.14.1/plugins/updater/src/updater.rs
[S03]: https://crates.io/api/v1/crates/tauri-plugin-updater/2.14.1
[S04]: https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/bundle.rs
[S05]: https://crates.io/api/v1/crates/tauri-plugin-updater/2.14.1/dependencies
[S06]: https://github.com/websockets/ws#multiple-servers-sharing-a-single-https-server
[S07]: https://github.com/fastify/fastify-websocket
[S08]: https://fastify.dev/docs/latest/Reference/Server/#trustproxy
[S09]: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
[S10]: https://github.com/mullvad/windows-service-rs
[S11]: https://github.com/mullvad/mullvadvpn-app/blob/main/mullvad-daemon/Cargo.toml
[S12]: https://github.com/winsw/winsw/blob/v2/README.md
[S13]: https://github.com/winsw/winsw/blob/v2/doc/xmlConfigFile.md
[S14]: https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights
[S15]: https://learn.microsoft.com/en-us/windows/win32/services/interactive-services
[S16]: https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/autostart/src/lib.rs
[S17]: https://github.com/systemd/systemd/blob/main/man/loginctl.xml
[S18]: https://docs.rs/tauri-utils/latest/tauri_utils/config/struct.DebConfig.html
[S19]: https://v2.tauri.app/distribute/debian/
[S20]: https://github.com/TheAssassin/AppImageLauncher
[S21]: https://github.com/AppImageCommunity/AppImageUpdate
[S22]: https://docs.appimage.org/packaging-guide/environment-variables.html
[S23]: https://docs.appimage.org/user-guide/troubleshooting/fuse.html
[S24]: https://github.com/ku9nov/faynoSync
[S25]: https://github.com/vonPB/tauri-update-server
[S26]: https://docs.crabnebula.dev/cloud/updater-configuration/
[S27]: https://github.com/velopack/velopack
[S28]: https://v2.tauri.app/plugin/updater/
[S29]: https://github.com/jenly1314/AppUpdater
[S30]: https://github.com/jenly1314/AppUpdater/blob/master/app-updater/src/main/kotlin/com/king/app/updater/util/AppUtils.kt
[S31]: https://github.com/xuexiangjys/XUpdate
[S32]: https://github.com/iMalFect/tauri-plugin-android-installer
[S33]: https://developer.android.com/reference/android/content/pm/PackageInstaller
[S34]: https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/signer/sign.rs
[S35]: https://developer.android.com/tools/apksigner
[S36]: https://github.com/tauri-apps/tauri-action
[S37]: https://docs.docker.com/build/ci/github-actions/push-multi-registries/
[S38]: https://github.com/googleapis/release-please/blob/main/docs/customizing.md
[S39]: https://v2.tauri.app/develop/sidecar/
[S40]: https://docs.npmjs.com/cli/v11/commands/npm-ci/
[S41]: https://docs.renovatebot.com/modules/manager/
[S42]: https://reuse.software/spec-3.3/
[S43]: https://github.com/aboutcode-org/scancode-toolkit
[S44]: https://github.com/EmbarkStudios/cargo-about
[S45]: https://github.com/mikepenz/AboutLibraries
[S46]: https://api.github.com/repos/winsw/winsw/releases/latest
[S47]: https://api.github.com/repos/jenly1314/AppUpdater/releases/latest
[S48]: https://www.gnu.org/licenses/lgpl-3.0.html
[S49]: https://github.com/lycheeverse/lychee
[S50]: https://github.com/gitleaks/gitleaks

维护快照补充入口：

- [windows-service 仓库元数据](https://api.github.com/repos/mullvad/windows-service-rs)
- [XUpdate 仓库元数据](https://api.github.com/repos/xuexiangjys/XUpdate)
- [AppUpdater 仓库元数据](https://api.github.com/repos/jenly1314/AppUpdater)
- [FaynoSync 仓库元数据](https://api.github.com/repos/ku9nov/faynoSync)
- [WinSW 发布列表](https://api.github.com/repos/winsw/winsw/releases?per_page=5)
- [Tauri updater 固定版本更新日志](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.14.1/plugins/updater/CHANGELOG.md)
- [service-manager](https://github.com/chipsenkbeil/service-manager-rs)
- [javiersantos/AppUpdater](https://github.com/javiersantos/AppUpdater)
