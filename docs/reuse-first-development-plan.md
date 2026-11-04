# 优先复用的技术选型与开发计划

版本：1.0，最终开发计划。日期：2026-10-27。
本稿汇总已经确认的架构与本轮实施选择，优先复用项目代码、成熟库和可移植的开源实现。作为实施依据；较早设计中的重复造轮子和离线设计以本稿为准。本阶段只做方案，未开始开发。

## 1. 已确认的产品范围

- 中心统一安装/管理插件、MCP、Skill，提供独立配置、版本和状态页面。
- 每 Bot 独立启用；配置只有 global → Bot 两级覆盖。
- Hindsight 是普通插件，原记忆功能和数据保留。
- Provider/Model 统一由中心管理；模型调用保留 Host → Provider。
- App/Host 连接中心后才可运行，不做离线模式。
- 原生插件采用 Durable 契约；一个安装实例统一目标版本。
- 中心首发 Linux + Docker Compose；首版 MCP 自动安装覆盖 HTTP 与 Node/npm。
- Hindsight 连接现成服务，本期不部署其后端或数据库。

## 2. 技术选型

| 模块 | 选择 | 自己只做什么 |
| --- | --- | --- |
| Agent/模型/上下文 | 现有 pi-durable/pi-ai/chord 1.3.0、acp-kernel 0.0.101 | 接中心配置、Bot 策略和插件贡献 |
| 设备连接/远程控制 | 原有 ws 8.22.0、relay/device-link/control 协议 | 加中心配置读取与在线准入 |
| 中心 API | Fastify 5 + @fastify/static、multipart、secure-session、csrf-protection、rate-limit | 业务路由、所有者口令检查与路由授权 |
| 数据库 | 现有 node:sqlite 和事务/CAS 写法 | 中心几张业务表，不引入 ORM |
| 管理前端 | 现有 React 19、Vite、Router、Radix、Tailwind、Lucide | 迁移已有页面的数据接口，增加详情页 |
| 配置表单 | @rjsf/core + utils + validator-ajv8，同版 6.x | 继承/覆盖 FieldTemplate、凭证控件 |
| 配置校验 | Ajv 8，统一 JSON Schema draft-07 | 校验合并后的 effectiveConfig |
| 两级合并 | deepmerge 4.3.1 | arrayMerge 配成整体替换 |
| MCP | 官方 pi-mcp；优先与现有 Pi 版本配套 | Durable tool 桥、Bot 配置、中心管理接线 |
| Skill | 移植 Pi 的 metadata 校验、读取和提示词格式化；yaml 2.x 解析 frontmatter | 受管目录入口与 Bot 过滤 |
| 包获取 | npm 的 pacote 21.x + semver | 固定版本、记录 resolved/integrity、安装实例 |
| npm 依赖树 | 复用 npm CLI，项目已有 11.6.2 | 中心指定版本/锁文件，实际执行平台受控安装 |
| Hindsight | 现有 hindsight-* 模块与官方 client 0.9.2 | 移入普通插件并保留数据身份 |

不为了“复用开源应用”引入另一套 Agent、MongoDB、多租户平台或模型代理。

### 版本依据

@rjsf/core 6.11.0 的 registry 元数据已核对：Node >=20、React >=18，覆盖项目声明的版本范围。React 19 的实际表单表现放在首个浏览器验收中确认，尤其覆盖按钮和数组编辑。

deepmerge 默认拼接数组，必须显式设置 arrayMerge 返回源数组。禁止直接使用默认行为，也不用 JSON Merge Patch：后者把 null 当删除，与当前显式 null 语义不同。

pacote 负责取 manifest、解析/下载/解包，不安装依赖树。npm 依赖必须由 npm CLI 完成，不能把解包成功当安装完成。

Fastify 官方 secure-session 使用 sodium-native，仅进入中心依赖，不打入 Android Host。中心镜像采用 Node 22 的 Debian 系列基础镜像，在 P0 验证依赖安装。单所有者模式不引入 Better Auth 的账号/适配器体系；口令用 node:crypto.scrypt 校验，Cookie/CSRF 和登录限速使用官方插件。

控制 API 普通数据存 node:sqlite；API Key 加密复用 Node 标准 crypto 与外部注入的中心密钥，不引入 Vault。浏览器管理会话、设备认证、上游 Provider/MCP 凭证保持各自用途。

新增依赖在第一阶段锁定经过验证的确切版本；不把 web 搜索结果中的“latest”直接写成生产依赖范围。

## 3. 哪些代码直接复用

### 本项目

- web/src/Resources.tsx：ProvidersPage、ProviderForm、LoginFlow、资源安装/更新列表。
- web/src/Mcp.tsx：传输配置、连接检查、工具列表、OAuth 流程。
- web/src/components/ui、现有 Router、图标与 CSS：作为管理页基础。
- host-core/runtime-models.js：模型规范化、发现与 registry 更新。
- host-core/runtime.js：Bot profile、模型切换、运行准入与恢复入口。
- host-core/extension-manager.js、store.js：把 Hindsight 单项管理改为通用实例/Binding。
- relay/device-link/控制客户端：保留现有设备认证和传输。
- Hindsight 现有工具、来源追踪、留存 outbox、bank 身份与存储迁移。

旧 UI 不能原样继续调用 NativeSettings 或写 models.json/mcp.json：先抽出纯 React 展示/表单，把数据调用换成中心 API。只抽当前复用到的组件，不建立新的通用 UI 框架。

### Pi：可直接移植的源码

候选来源为 v1.3.0 的 packages/coding-agent/src/core/skills.ts：

- validateName / validateDescription。
- loadSkillFromFile 的 frontmatter、诊断和元数据解析。
- formatSkillsForPrompt。
- 必要的 frontmatter 辅助代码。

只保留显式受管 Skill 目录，不复制用户 HOME/项目目录扫描、不引入 coding-agent 全部运行时。frontmatter/YAML 使用其成熟库路径，文件读取仍使用 Node 标准库。

复制时从原始仓库/发布包取代码，不从网页提取后的文本复制；记录 tag/commit、文件与许可证。Pi MIT 许可证已经在本项目 licenses 中保留。

### 开源应用：已核查，但不整搬

- OpenClaw：采用“静态 manifest + configSchema + UI hints，在执行代码前读取”的设计。已读 src/plugins/install.ts、install-npm.ts、manifest.ts；当前实现依赖很多内部模块，直接搬入安装器会扩大范围。实际安装交给 pacote/npm，薄 manifest 解析按本项目字段完成。
- LibreChat：已读 packages/api/src/mcp/MCPManager.ts。其 app/user 连接与 UI 状态值得参考，但耦合 OAuth、用户、调度和其他服务；本项目先使用每 Bot 配置对应的客户端，不搬整个连接池。
- 两个项目根许可证均为 MIT。具体摘取源码时仍需记录所取文件及其附带通知；本轮尚未复制第三方代码。
- Provider 页面本项目已经存在，不从另一应用再搬一套模型目录和请求层。

## 4. 剩下确实要自己写的部分

1. 中心数据库与管理路由。
2. global + overrides 的读取/保存，以及最终配置下发。
3. RJSF 字段的“继承/覆盖/恢复继承”交互。
4. 每 Bot 的 Durable 插件选择和执行检查。
5. 包安装结果与设备部署状态之间的连接。
6. App/Host 的中心在线门槛。
7. 旧 Provider 和 Hindsight 数据的迁移入口。

这些是本产品的业务连接代码，不再抽象出新插件引擎、新包管理器或新工作流平台。

## 5. 开发顺序

### P0：固定依赖与接口，验证复用接缝

依赖：无。完成后再冻结实现所用库版本。

- 在实际 Host 开发基线上工作；研究 worktree 的旧 main 仅保留设计文档。
- 锁定新依赖，记录复制来源和许可证。
- 建立最小中心入口，复用已有 UI 组件展示一张 RJSF 配置表单。
- 验证 global/Bot 继承、嵌套字段、数组替换及凭证引用。
- 验证中心依赖不会进入 Android/桌面 Host bundle。
- 用一个普通 Node stdio MCP 包验证 npm 11.6.2 的受控安装：中心 Linux、桌面执行端、Android 现有 Node/npm 资源。
- 从已读的 Pi 文件中确认最小可移植代码，记录原始 commit 和本地改动；不从网页转换内容粘贴源码。

出口：真实浏览器能保存/读取配置，React 19 表单交互正确。

### P1：中心登录、模型管理与在线启动

依赖：P0。

- Fastify 管理接口、静态页面、单所有者登录。
- 迁移 Provider/Model 表单和 runtime-models 逻辑。
- 中心保存默认模型与 Bot 覆盖。
- Host 先认证中心并获取配置，再启动 Runtime。
- App 进入业务前必须连接中心；断开后禁用业务，Host 停止新调用。

出口：两个 Bot 从中心选择不同模型，真实 Host 发出请求；断连和重新连接行为符合在线要求。

### P2：通用插件与 Hindsight 去特殊化

依赖：P1；先做一个可安装的本地制品入口，供 Hindsight 普通包使用。

- 安装实例、BotBinding、通用生命周期与贡献接口。
- Hindsight 拆出为普通包；移除核心与 UI 中专用 ID/字段分支。
- 保留现有 bank、outbox、请求键和 Bot 读写语义。
- 通用插件详情页的概览/配置/Bot 分配/状态/操作。

出口：Hindsight 能安装、配置、按 Bot 开关；移除后核心正常启动。

### P3：MCP 与 Skill

依赖：P2 的通用配置、Binding 和运行接口。

- pi-mcp → Durable 工具桥，direct 和嵌套调用共用策略。
- Skill 使用移植的 Pi 解析/提示词代码，完整目录分发。
- 迁移现有 MCP 检查、OAuth、工具展示界面。
- global/Bot 覆盖必须作用于实际客户端，不只是页面值。

出口：真实 MCP 可调用，两个 Bot 的开关和配置不同；Skill 引用/脚本路径正确。

### P4：安装、版本更新和卸载

依赖：P2 的最小安装入口；可与 P3 的协议接入分别实施，最后一起验收。

- pacote 解析确定版本与制品；npm 负责需要的依赖安装。
- 复用现有安装进度 UI；中心保存 operation 与目标版本。
- 暂存后切换、忙时等待、旧文件保留、卸载默认保留数据。
- 不做通用状态迁移引擎；插件自己提供确有需要的迁移方法。
- 明确 HTTP 服务登记与可安装 stdio 包的不同处理。

出口：从中心完成安装→配置→启用→更新→卸载；更新失败保留可用旧版。

### P5：多端整合与交付

依赖：P3、P4 完成。

- 中心管理与 App 共用表单/页面，不写两套业务状态。
- Windows/Linux/Android 验证在线准入和插件/model 配置。
- 完成旧设置导入及旧离线入口停用。
- 输出部署命令、运行说明和版本升级步骤。

出口：中心实际部署，一台桌面 Host 和 Android 真机完成整条用户流程。

## 6. 已确认的部署与安装方案

### 中心部署

Linux + Docker Compose。首版一个 center 容器，包含 Node 管理 API、原 relay 和 Node MCP 子进程；挂载持久数据目录与 HTTPS 证书/密钥。

优先保留现有 relay 的独立 TLS listener，Fastify 使用独立管理 HTTPS listener，在同一 Node 进程/容器统一启动关闭。使用同一证书并由中心连接信息返回 linkUrl，不为合并一个端口先改造整套 relay。用户可在现有反向代理后部署，项目不自研代理。

不加入 Redis、MongoDB、PostgreSQL 或独立任务调度服务。Hindsight 是现有外部服务，不放入这份 Compose。

### 安装执行位置

中心保存源、确切版本、manifest、锁文件与安装操作。安装目标是中心或 Host，用户始终只在中心页面操作。

- HTTP MCP：登记端点、凭证和配置，不假装下载安装远端服务。
- 中心 Node stdio：中心调用已固定的 npm CLI 安装依赖并启动进程。
- Host Node stdio：中心下发确定安装计划，Host 在受管目录调用 npm 安装；复用项目已有 npm/Node Mobile 资源。
- 原生插件：使用带契约的发布包，安装依赖同样交给 npm；不打包重复的 Host 引擎，Durable/Host API 作为明确的运行契约。
- Skill：安装完整目录并读取 SKILL.md，使用资源文件不需要 npm 依赖树。

跨平台不复制 Linux 的 node_modules，不自建交叉打包系统；由目标平台 npm 准备适合的依赖。需要额外编译链或不支持 Android 的包报告对应平台不可用，不另做通用运行环境安装器。

Python/uv、Docker 容器型 MCP 不在首版自动安装范围；已经提供 HTTP MCP 端点的服务照常连接。

这是对前稿“Host 绝不执行 npm”的修正：允许中心控制的部署阶段安装，禁止每次 Bot 启动临时安装。业务配置仍全部来自在线中心。

## 7. 接口与代码组织的最小约定

- 中心数据：providers/models、global 模型配置、插件 installations/globalConfig、botBindings/overrides、credentials、operations。
- 配置合并：一处 deepmerge 调用，数组替换；最终值由 Ajv 校验。插件只接收 effectiveConfig。
- RJSF 编辑有效值，但保存仅写用户勾选的覆盖路径；不要把整个 formData 当作 overrides，否则继承会失效。Schema default 只在安装初始化 global 时使用。
- 插件 SDK 只覆盖当前需要的 tools/sections、上下文增强、后台工作停止/关闭及管理 actions；复用 Durable 的 task/doc，不重新定义执行引擎。
- 先移出 Hindsight 的现有实现，不顺便重写召回/留存算法。BC 后增强、最终预算检查的顺序保持。
- 安装任务串行执行，operation 表显示阶段与结果；不引入通用任务 DAG。
- 更新先下载/安装到新目录，完成后在空闲边界切换；不可迁移状态显示阻塞，不实现无需求的通用降级框架。
- App 的管理入口打开中心 Web 页面，聊天仍使用现有原生桥/Host 通道。表单共用纯 React 组件，避免 WebView 跨域 Cookie 与 NativeSettings 双配置。
- Host bootstrap 先读取设备身份，再通过认证中心接口取运行配置并建立链路，最后启动 Runtime；不让新在线要求与旧“Runtime 先于 DeviceLink”顺序形成循环依赖。

## 8. 验收与完成条件

本期不新增单元测试框架或专门测试文件，使用实际端到端运行。P0 先验证库与运行环境；各阶段在真实中心/Host/浏览器上验证本阶段出口。

最终必过的用户路径：

1. Compose 启动中心，登录管理页，登记并连接设备。
2. 添加 Provider/Model，两个 Bot 分别继承和覆盖默认模型。
3. 安装 Hindsight，global 配置后一个 Bot 覆盖读写模式/凭证，验证实际调用结果。
4. 安装一个 HTTP MCP 和一个 Node stdio MCP，按 Bot 开关，直接与嵌套调用一致。
5. 安装完整 Skill，按需加载并正确访问引用文件。
6. 修改 global 后继承字段变化，覆盖字段保持；恢复继承、数组替换正确。
7. 中心更新/卸载插件，实际版本和数据保留状态可见。
8. 中心断开时 App 不可继续业务、Host 停止新工作；重连取当前配置。
9. 桌面与 Android 真机使用同一中心，旧 Provider/Hindsight 数据迁移后可继续使用。

所有插件类别、独立页面、global/Bot 配置、版本更新和在线门槛都完成，才算本计划交付；不能用仅完成后端代替。

## 9. 复制源码的执行规则

成熟库优先作为依赖使用，不把库源码复制进仓库。独立的小模块才 vendor：

- Pi Skill 解析/格式化代码放到明确的 third-party/adapted 目录，记录原始路径、tag/commit 和改动。
- 现有项目代码优先直接移动/抽出，不复制成两个长期分叉。
- 所有复制保留版权及许可证，更新 THIRD_PARTY_NOTICES.md；RJSF 为 Apache-2.0，Pi/OpenClaw/LibreChat/deepmerge 为 MIT，pacote 为 ISC。
- OpenClaw/LibreChat 此次是已核实的设计参考与候选代码源，没有把大型内部模块列为必须移植的交付项。

项目现有许可证为 AGPL-3.0；本次保持项目许可，不因引入 MIT/Apache/ISC 组件改变整个项目的许可证。

## 10. 核查来源

- [RJSF 6.11.0 registry](https://registry.npmjs.org/@rjsf/core/6.11.0)，Apache-2.0。
- [RJSF validation](https://rjsf-team.github.io/react-jsonschema-form/docs/usage/validation)。
- [deepmerge README](https://github.com/TehShrike/deepmerge#arraymerge)，MIT。
- [pacote README](https://github.com/npm/pacote)，ISC；npm CLI 也是其调用者。
- [Fastify secure-session](https://github.com/fastify/fastify-secure-session)，MIT，已读依赖和使用方式。
- [Fastify CSRF](https://github.com/fastify/csrf-protection)，MIT，官方支持 Fastify 5。
- [Pi skills.ts v1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/skills.ts)，MIT。
- [OpenClaw manifest](https://docs.openclaw.ai/plugins/manifest)、[安装入口](https://github.com/openclaw/openclaw/blob/main/src/plugins/install.ts)、[MIT license](https://github.com/openclaw/openclaw/blob/main/LICENSE)。
- [LibreChat MCPManager](https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/mcp/MCPManager.ts)、[MIT license](https://github.com/danny-avila/LibreChat/blob/main/LICENSE)。

本轮已做静态源码与官方文档核查，未安装依赖、复制实现代码、构建或运行兼容性验证。实际版本与依赖组合在 P0 锁定。
