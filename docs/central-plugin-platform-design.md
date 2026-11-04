# 中心插件管理技术方案

版本：0.5，技术设计稿。日期：2026-10-27。
架构选择已由用户确认。实施以 [优先复用的最终开发计划](reuse-first-development-plan.md) 为准：Linux Compose、HTTP/Node MCP、连接现有 Hindsight。本文不表示功能已经实现。

## 1. 目标与已确认决策

插件、MCP、Skill 全部通过中心服务器安装、配置、更新和卸载。每个 Bot 独立决定是否启用每个安装项。每项能力有独立管理页面。Hindsight 是普通插件，与其他插件使用同一契约。

| 决策 | 已确认结论 |
| --- | --- |
| 安装与执行 | 中心安装管理，按需自动下发组件到 Host；通用服务可在中心执行 |
| 代码插件兼容 | 第一版采用 Durable 原生插件契约，不做旧 coding-agent ExtensionAPI 通用兼容 |
| 配置范围 | global 基础配置 + Bot 部分覆盖；Bot 优先，两级共用同一 Schema |
| 版本策略 | 每个安装实例一个目标版本；不提供每 Bot 长期固定不同版本 |
| 模型管理 | Provider、Model、默认模型和 Bot 模型选择统一保存在中心 |
| 在线要求 | App/Host 连接并认证中心后才能使用，不提供离线模式 |

用户不用分别登录各设备安装软件包或维护插件配置文件。设备侧的包、配置和凭证都是中心管理的部署结果。

中心统一保存包、插件配置、Provider/Model、凭证、Bot 分配和部署状态。Bot 的代理循环、聊天历史和 BC 状态继续由 Host 管理。模型请求复用现有 Host → Provider 直连，不增加中心模型代理。

配置采用 [global → Bot 两级覆盖](plugin-configuration-design.md)；启动、断连及模型管理见 [Provider/Model 与在线运行架构](central-models-online-architecture.md)。

## 2. 架构与工程边界

```text
浏览器 / 桌面和手机的管理入口
                  │
                  ▼
中心服务：一个部署，按职责分模块
 ├─ 管理 Web + 管理 API
 ├─ 包、版本、安装实例
 ├─ 配置、凭证、Bot 分配
 ├─ Provider / Model 目录与 Bot 模型选择
 ├─ 安装/更新任务、期望状态、应用回执
 ├─ 中心执行模块：共享 MCP、插件服务组件
 └─ 现有设备注册与认证中继
                  │
          认证通知 / 状态同步
          HTTPS 制品下载
                  │
                  ▼
各设备 Host
 ├─ 部署客户端：在线获取、检查、激活、回报
 ├─ 通用插件管理器：配置、生命周期、按 Bot 选择
 ├─ 三种驱动：native-plugin / mcp / skill
 └─ Pi Durable + BC + 本机工具/原生桥
```

建议新增 `center-server/`，组合现有 relay 实现；新增中心管理前端 `center-web/`，沿用 React/TypeScript。现有客户端提供管理入口和 Bot 插件页，使用同一管理 API，不维护第二套配置权威。

首版一个中心服务加受管子进程足够。使用 SQLite 和文件存储，不引入消息队列、集群或插件市场。保留单所有者、多设备模型。

设备注册继续使用原 `relay.sqlite`；中心业务使用独立 `center.sqlite`，避免改变注册库的严格 schema 约定。制品按内容摘要保存为文件。

## 3. 统一模型：包、安装实例、Bot 分配

### 3.1 三类能力共用管理模型

内部称“能力包”，界面保留“插件 / MCP / Skill”类型标签：

| 类型 | 内容 | 驱动职责 |
| --- | --- | --- |
| 原生插件 | manifest、代码、配置 schema、工具/钩子/后台工作、管理动作 | 适配 Durable 与 Host 生命周期 |
| MCP | 服务定义、必要的固定版本制品、连接配置、凭证引用 | stdio/Streamable HTTP、工具调用、连接/进程管理 |
| Skill | 完整目录、版本、元数据及运行需求 | 列表、按需读取、相对资源解析、平台可用性 |

三类共用安装、版本、配置修订、Bot 分配、部署回执和页面。Hindsight 是原生插件，不增加专用驱动或核心例外。

包内部代码依赖随制品固定；如果依赖另一项 MCP/插件能力，只声明缺失状态，不暗中为 Bot 开启。

### 3.2 三个独立概念

1. **包版本**：不可变的代码/资源、manifest 与摘要。
2. **安装实例**：中心安装的包、目标版本、global 配置和凭证，例如“GitHub 工作账号”。
3. **Bot 分配**：某 Bot 是否使用某实例、配置覆盖项、修订号。

默认安装产生一个实例。同一 MCP 需要两个账号，或同一插件需要两个后端时，可“复制为新实例”；这是可选操作。

不同实例拥有独立配置、状态目录和工具命名空间。同一实例在同一执行端只激活一个版本；各执行端升级过程中可短暂处于不同版本，页面明确显示。Bot 选择实例，不选择任意包版本。

新安装默认不对已有 Bot 自动启用。

### 3.3 管理版本与外部服务版本

- 原生插件更新：更新连接器、逻辑、schema、界面声明等包内容。
- stdio MCP 更新：更新固定版本的服务制品及适配配置。
- 远端 MCP 更新：更新管理定义与适配器；外部服务由供应方升级。
- Hindsight 更新：连接器与 Hindsight 后端分别显示版本；安装连接器不自动等于部署整个后端。

包可声明受管中心组件。中心自身使用 Linux Docker Compose 部署；首版不自动编排 Docker/Python MCP，Hindsight 连接已有后端。

## 4. 安装来源与 Manifest

### 4.1 安装入口

统一“安装能力”页面按类型接受：

- 原生插件：带 manifest 的固定版本 npm 包或上传的制品包。
- MCP：远端 URL，或目标平台可运行的固定版本 stdio 服务包。
- Skill：完整目录包，或指定仓库与确定 commit/发布版本。

中心完成下载、解析、依赖解析和版本检查。锁定版本与 digest 后才进入制品库；Git 分支名或 latest 不能作为已部署版本的唯一身份。

中心固定版本和安装计划；需要 npm 依赖时由实际执行端在受管部署目录调用现有 npm CLI，不在每个 Bot 启动时临时安装，也不跨平台复制 node_modules。首版自动安装 HTTP/Node npm MCP；Python/容器环境不自动编排，不支持的平台显示 unsupported。

归档导入校验路径、大小和摘要，禁止目录穿越及越界符号链接。暂存完成并验证后原子发布，运行中不读取半包。

### 4.2 Manifest 示例

以下为拟议契约，不是现有 Pi API；版本号仅说明格式。

```json
{
  "manifestVersion": 1,
  "id": "example.hindsight",
  "version": "1.0.0",
  "kind": "plugin",
  "displayName": "Hindsight",
  "hostApi": "^1.0",
  "durableApi": "1.3.0",
  "components": {
    "host": { "entry": "dist/host.mjs" }
  },
  "platforms": ["windows", "linux", "android"],
  "configSchema": "schemas/config.json",
  "uiSchema": "schemas/ui.json",
  "stateVersion": 1,
  "contributions": ["tools", "context", "background", "actions"]
}
```

components.center 可声明中心组件。纯 Skill/MCP 由驱动生成管理描述，不要求用户编写原生插件代码。

平台兼容还需记录体系结构和运行环境约束。原生插件优先预打包 JS，二进制依赖提供目标平台制品。声明用于装载检查，最终以设备验收确认可运行。

schema 与 UI 声明随包版本保存，加载表单不执行插件代码；旧配置使用对应 schema，新版本不能静默改写旧配置。

## 5. 管理页面

### 5.1 能力列表

路由：`/capabilities`。

展示名称、类型、来源、当前/目标版本、全局状态、配置状态、启用 Bot 数、部署异常数。支持安装、搜索、按类型筛选、检查更新、停用和卸载。

“已安装”“已启用”“连接正常”“全部设备已更新”分别展示。

### 5.2 每项独立详情页

路由：`/capabilities/:installationId`。

```text
Hindsight                         当前 1.0.0 → 目标 1.1.0
普通插件 · 中心已安装 · 2/3 设备已应用      [检查更新] [更新]

[概览] [配置] [Bot 分配] [版本] [运行状态] [操作]

配置
  后端地址       [https://memory.example/                  ]
  API Key        [已配置 · 替换 · 清除                      ]
  请求超时       [30000 ms                                ]
  读写模式       [读写 · Bot 可覆盖                       ]

  配置修订 12 · 将影响 3 个 Bot
                                    [验证连接] [保存并应用]
```

| 页签 | 内容与操作 |
| --- | --- |
| 概览 | 描述、来源、位置、平台、工具/钩子、依赖、数据位置 |
| 配置 | global 配置、凭证、校验错误、连接验证、应用修订 |
| Bot 分配 | 独立开关、配置覆盖/恢复继承、设备、期望/实际修订、未生效原因 |
| 版本 | 当前/目标版本、变更说明、升级资格、执行端进度、可用回退 |
| 运行状态 | 中心/Host 进程和连接、最近错误、脱敏日志、重连/重启 |
| 操作 | 插件声明的管理动作，例如记忆查询、修正、任务状态 |

没有参数的 Skill 显示“无需配置”，仍有版本、分配和状态。MCP 页由驱动提供传输、命令/URL、环境变量引用、超时、OAuth 登录/注销和工具列表。远端不报告版本时明确显示“未报告”。

表单使用 RJSF + Ajv 根据 JSON Schema 生成，复用现有 React/Radix 样式，只增加继承/覆盖和凭证字段适配。其他管理页面优先迁移 Resources.tsx、Mcp.tsx 的已有表单与交互。首版不执行第三方前端 JavaScript，不为 Hindsight 写专属表单。

“操作”使用声明式输入/输出 schema，保留已有记忆查询和修正功能。复杂专属交互后续有实际需求再扩展。

### 5.3 Bot 插件页

路由：`/devices/:deviceId/bots/:botId/capabilities`。

```text
调研 Bot · Windows
名称                   开启     Bot 配置          实际状态
Hindsight               是      读写 / 研究主题    已应用 r12
GitHub 工作账号         是      仓库范围           等待设备上线
网页调研 Skill          是      输出语言：中文     已应用 r4
本机浏览器 MCP          否      —                  已关闭
```

两个页面修改同一 Binding。显示字段来自 global 还是 Bot 覆盖，并提供最终配置预览。App 必须连接中心才能操作；未连接的 Host 显示不在线，上线后读取中心当前配置。

中心保存管理所需的 Bot 目标引用与名称，运行状态向在线 Host 查询；未连接的 Host 显示不在线。App 不提供离线 Bot 列表或历史浏览。

## 6. 配置与凭证

### 6.1 Global → Bot 两级配置

每个安装实例保存 globalConfig，每个 BotBinding 只保存 overrides。中心统一计算：

```text
effectiveConfig = merge(globalConfig, overrides)
```

Bot 未提供的字段继承 global；对象按字段递归合并；数组整体替换；标量由 Bot 覆盖。false、0、空字符串和空数组都是明确值；null 仅在 Schema 允许时作为显式值。恢复继承就是删除对应覆盖字段。

每个插件版本只提供一份 configSchema，两级使用相同字段，包括地址、凭证引用和行为参数。校验合并后的最终配置，不要求部分覆盖项单独满足所有 required 字段。

包初始值在安装时写入 globalConfig，不增加运行时第三层默认值。Bot 没有覆盖时保存空对象，不复制 global。配置变更沿用已有同步与应用回执。

中心向执行端提供每 Bot 的最终配置；工具、钩子、后台工作和管理动作统一使用，不再直接读取 global。凭证在合并后按最终引用解析。插件启用状态独立于配置内容。

详细数据流、例子、页面和接口见 [插件两级配置架构](plugin-configuration-design.md)。

### 6.2 中心统一凭证管理

中心加密存储密钥，主密钥由部署环境提供并与数据库备份分开保管。普通 GET 返回 configured/credentialId，不返回秘密原值。

只有需要的中心/Host 执行组件取得秘密。Host 在线时在内存使用所需凭证，不保存用于离线运行的副本；普通设置、日志、提示词和 Skill 文件不包含密钥。

OAuth 从中心页面发起；令牌由中心管理，按授权身份协调刷新，避免多个 Host 竞争 refresh token。具体服务的回调、客户端注册和设备授权步骤由 MCP 驱动适配，并在页面显示完成状态。

全局停用拒绝新的插件调用。Host 与中心断开后同样停止新工作，重新连接并读取当前配置后才恢复服务。

## 7. Durable 原生插件 SDK

### 7.1 薄适配，不另造运行时

继续使用 Durable Extension/Tool/Task/Doc；Host SDK 只补实例、配置、身份和生命周期。

拟议出口：

```text
createPlugin(instanceContext) -> {
  durableContributions,     // 工具、sections、具名 tasks/docs
  requestContributions,     // 受管理的上下文增强
  actions,                  // 带 schema 的管理操作
  lifecycle                 // prepare、activate、quiesce、close
}
```

instanceContext 包含稳定实例 ID、版本、数据目录、配置解析入口、凭证入口、日志和 Host 能力。每次调用传入可信 Bot 上下文及其 effectiveConfig，工具、钩子和后台工作共用。带配置的客户端资源按 Bot 创建并复用，不靠共享全局变量切换 Bot，也不让 global 初始化的客户端忽略 Bot 覆盖。

生命周期：

- 装载定义：连接中心并取得当前配置后注册所需定义，不因文件已安装就独立启动服务或后台写入。
- prepare：检查环境、配置、数据版本。
- activate：启用所需连接和工作资源。
- quiesce：拒绝新工作，报告未结束调用/任务。
- close：释放资源，可重复调用。

可恢复的插件启动错误只影响对应实例；同进程受信插件导致的进程级崩溃，不属于这一生命周期能够隔离的错误。

### 7.2 实例命名空间与 Registry

Durable 一个 Host 共用 registry，默认会选择已注册扩展。新插件必须通过“核心扩展 + 此 Bot 已启用实例”的明确选择接入，不能注册后自动暴露给所有 Bot。

installationId 对应稳定 extension/tool/task/doc 命名空间。命名器处理模型工具名长度和字符限制；冲突在安装前拒绝，不依赖后注册覆盖。

历史恢复定义可继续注册，但不因此授予调用权限。包按不可变版本路径加载，避免模块缓存复用旧代码。同一实例同执行端只激活一个版本。

### 7.3 工具、Hook 和后台工作共用启用策略

```text
允许启动 =
  中心已连接且当前配置已加载
  AND 实例全局启用
  AND BotBinding 启用
  AND 配置完整
  AND 执行端已激活匹配快照
  AND 平台与依赖可用
```

工具入口从真实 conversation 映射 Bot，不采信模型自报 botId。direct、deferred、codemode/嵌套调用共用策略。仅过滤 modelTools 不足以阻止嵌套调用，还需控制 tools/扩展选择并在执行时检查。

Durable 自定义 tasks 在 registry 按名称解析，不自动受会话选中的扩展限制。因此受管后台任务的执行阶段也要检查 Binding；停用停止新调度、暂停未开始工作，并处理在途任务。

原生插件是所有者安装的受信代码，具有所在进程权限。SDK 的作用域约束用于减少误用，不是恶意代码沙盒；首版不实现容器隔离。

### 7.4 请求准备与 BC

固定阶段：

```text
Bot 已应用快照
 → 工作策略/来源检查
 → BC 准备
 → 已启用插件的上下文增强
 → 最终请求预算检查
 → 模型调用
```

增强插件读取只读投影、来源引用和预算，返回追加内容。首版提供固定阶段，不提供任意优先级图；多个插件按稳定实例顺序串行组合，记录来源，最终预算检查包含全部新增内容。

普通增强失败可按声明跳过并记录；当前请求必需的插件失败需由核心统一中止该次请求。Durable 1.3.0 普通 beforeRequest 抛错可能被报告后跳过，不能只靠 throw 拦截；沿用项目已验证的同 invocation context 取消当前任务方式。

Hindsight 的捕获、召回、幂等追踪和留存属于插件，核心仅提供通用来源与生命周期接口。

## 8. MCP 与 Skill 驱动

### 8.1 MCP

复用 pi-mcp 客户端，驱动负责连接/进程、OAuth、工具列表变化、参数/结果转换和诊断。

- HTTP 实例可 Host 直连或中心执行，位置明确配置。
- stdio 在选定中心/Host 启动；本机文件、浏览器和设备能力在所属 Host。
- 连接按实例、执行位置、凭证身份及 cwd/roots/Bot 参数等访问上下文区分，不能只按包名共享。
- 工具名稳定并按实例隔离；新增远端工具只对已启用该实例的 Bot 可用。
- 旧 SSE-only 服务显示不支持，不冒充 Streamable HTTP。
- 第一阶段先交付 tools；resources/prompts 分别接线并显示支持范围。

中心执行通过受认证的专用插件调用协议提供服务，不必先开发通用对外 MCP 网关。Host 将调用包装为 Durable 工具任务。

### 8.2 Skill

中心保存完整不可变目录；Host 发布到实例专属路径，保留 scripts/references/assets 的相对结构。

Bot section 只列已启用项。受管加载入口验证 Bot、读取当前版本并给出资源基址。脚本使用该 Bot 已允许的执行工具，不自动获得依赖 MCP 或额外权限。

关闭停止新的列表展示与加载，已进入历史的内容保留。任务使用已激活版本，更新不覆写旧目录。开放的 read/bash 仍可访问其权限内文件，所以 Skill 开关不是文件系统保密机制。

## 9. 状态同步与生效

### 9.1 在线读取与应用

1. App 和 Host 先连接并认证中心，成功后才进入业务流程。
2. 中心保存管理页面提交的最新配置。
3. 在线 Host 获取完整当前配置及制品摘要。
4. 下载、验证、prepare，在安全边界激活。
5. 回报实际版本和配置修订。
6. Host 下次连接时直接读取中心当前状态，不重放停机期间逐条变更。

不提供离线配置、本地优先模式或离线待发送队列。中心保存唯一配置，Host 当前运行配置只在在线期间使用。

Bot 主私聊、群、DM 一起应用，新建上下文继承。沿用已有 Bot 准入队列、配置修订和应用回执。

### 9.2 区分更新与停用

- 新启用/普通配置变更：安全边界切换，忙时 waiting-idle。
- 停用：收到后拒绝新工具调用、hook 和后台工作；取消或排空在途调用，显示 draining。已有外部效果不回滚。
- 恢复：按插件声明的恢复契约继续，不默认补执行停用期间全部历史。
- 中心断开：App 进入重连页；Host 停止新工作并通过现有取消机制停止在途调用。重新连接后读取最新配置，不自动重发未确认请求。
- 旧协议：requires-host-upgrade，不猜测性回退。

旧快照可用于解释/恢复历史，但不能覆盖最新收到的拒绝新调用策略。

### 9.3 三类状态

- 期望：全局/每 Bot enabled、目标版本、目标修订。
- 部署：queued、downloading、preparing、waiting-idle、activating、applied、failed、removed。
- 健康：ready、disconnected、needs-auth、unsupported、disabled，加最近错误。

HTTP 受理回执只返回 operationId，不能直接显示所有设备完成。

## 10. 安装、更新、回退和卸载

### 10.1 安装

获取确定制品 → 校验契约 → 保存包与实例 → 配置 → 分配 Bot → 自动部署至需要的执行端。

无 Bot 使用时可 installed/inactive。显式验证连接可短暂启动诊断资源，结束后释放。

### 10.2 更新

每实例一个目标版本。检查更新不自动激活；用户点击更新才生成部署任务，不在推理中隐式跟随 latest。

```text
暂存新版本
 → API/平台兼容检查
 → 新 schema 配置迁移预检
 → 停止受影响的新准入，等待安全点
 → 数据迁移与原子切换
 → 启动/健康检查
 → 上报
```

prepare 失败保留旧版。共享状态迁移前静止旧写入者，做可恢复备份/迁移；本地持久部署阶段日志支持崩溃对账，避免代码与状态版本错配。

首版允许原生插件升级重开 Host runtime，控制和部署服务保持可查询；只有明确验证的包才使用不重开的激活方式，不默认承诺热升级。

运行调用完成前不换实现。持久任务即使暂未运行也可能在重启恢复；插件声明 stateVersion 和兼容/迁移能力。无法迁移的未完成任务阻止升级。长期后台任务需要 checkpoint/migrate，不能等待一个永不自然结束的任务。

中心组件与 Host 组件使用兼容协议；版本不兼容的 Host 先完成升级再进入 ready，不增加离线旧版本运行路径。

### 10.3 回退

同时检查包、配置和持久数据。prepare 失败可自动保留旧版本；迁移后或新写入后仅在契约允许时回退。

旧包存在不等于数据可降级。恢复旧快照若会丢失新写入，必须明确展示，不能作为默认失败处理。

### 10.4 卸载

全局停用 → 撤销分配 → 静止调用/后台工作 → 移除执行组件 → 回报。

默认保留数据。仍有 Durable 任务依赖定义时先终止或迁移，不能删除 registry 项导致永久挂起。“清除数据”独立操作，说明本地、中心和外部数据范围；卸载连接器不默认删除远端 Hindsight 事实库。

未连接的 Host 无法运行插件；再次连接时按中心当前安装清单整理本机文件，完成后报告结果，不维护离线卸载操作重放队列。

## 11. 数据模型与 API

### 11.1 中心最小存储

| 对象 | 主要内容 |
| --- | --- |
| package_versions | packageId、version、digest、kind、manifest、artifactRef |
| installations | installationId、packageId、targetVersion、enabled、revision |
| configuration_revisions | instance、revision、schemaVersion、globalConfig（含凭证引用） |
| bot_bindings | deviceId、botId、instance、enabled、overrides、revision |
| deployment_targets | target、instance、desired/applied 修订、实际版本、phase、error |
| operations | operationId、requestId、动作、目标、阶段、结果 |
| credentials | credentialId、类型、加密内容、修订和必要元数据 |

operation 兼作安装/更新诊断记录，不另建通用工作流。Host 保留设备身份、安装文件、部署记录和插件工作数据；当前业务配置由中心在线获取并在内存使用。制品不进 Durable 数据库。

### 11.2 管理 API 草案

以下均为新增建议：

| 接口 | 用途 |
| --- | --- |
| GET /api/capabilities | 能力与实例列表 |
| POST /api/installations | 安装，返回 operationId |
| GET /api/installations/:id | 详情、schema、版本及状态 |
| PUT /api/installations/:id/config | CAS 更新 globalConfig |
| POST /api/installations/:id/validate | 配置/连接验证 |
| POST /api/installations/:id/updates/check | 查询更新 |
| POST /api/installations/:id/update | 指定目标版本 |
| POST /api/installations/:id/rollback | 兼容检查后回退 |
| POST /api/installations/:id/disable | 全局停用 |
| DELETE /api/installations/:id | 卸载，默认保留数据 |
| PUT /api/devices/:deviceId/bots/:botId/capabilities/:id | Bot 开关/overrides、CAS |
| POST /api/installations/:id/actions/:action | 执行已声明的管理动作 |
| GET /api/operations/:id | 进度与结果 |

凭证和 OAuth 独立端点，普通配置只返回引用。动作受 schema、身份、输入输出上限和超时约束，不接受任意 URL/文件/函数转发。

变更带 requestId，同 ID 不同内容冲突；超时后查 operation，不盲重发外部副作用。

Host 新增协商能力 capabilityProtocol:1（拟议版本），与现有控制协议独立声明。制品通过 HTTPS 按设备身份与分配检查下载，不塞入现有有界 WebSocket 控制帧。

### 11.3 中心调用与外部副作用

中心执行调用由 Host 注入 deviceId、botId、installationId、配置版本和稳定 callId。中心核对认证设备、Binding、版本兼容及参数；执行端记录受理/已完成/结果未知状态。

网络超时不是未执行。只能在远端本身支持操作 ID 去重或查询时安全恢复；普通 MCP 写操作默认 unsafe，不因 Durable 或中心调用记录存在就自动重放。

### 11.4 管理认证

中心 Web 使用单所有者管理会话。设备认证仅允许自己的下载、同步、状态和已分配调用，不自动取得安装代码权限。

浏览器采用同源 API、HttpOnly 会话和变更请求 CSRF 防护；原 /v1/link 的设备连接规则保持，不为 Web 管理页面直接放开其 Origin 限制。可由同一外部站点路由到不同处理模块。

## 12. Hindsight 去特殊化

### 12.1 当前耦合与目标

| 当前耦合 | 迁移后 |
| --- | --- |
| extension-manager 只接受 hindsight | 通用 manifest/schema 实例管理 |
| runtime-models 解析地址与凭证 | 通用配置解析，字段语义归插件 |
| runtime 创建 memory、直接调用 beforeRequest | 通用生命周期与上下文增强 |
| 核心 Bot 设置持有 retentionFloor | 插件私有 Bot 状态 |
| 固定 hindsight 工具与 memory RPC | 插件贡献工具及 actions |
| 前端写死字段、模式、工具名 | schema 表单和通用分配页 |
| 记忆 topic 写入 SOUL | 插件配置字段，Bot 可覆盖，SOUL 专注人格 |

Hindsight 包内部负责读写模式、bank 派生、来源跟踪、召回、留存、纠正、重试、retentionFloor 和后台投递；不把这些字段改名后留在通用核心。

原 memoryStatus/recall/reflect/retain/get/source/correct/retry 迁到 actions。过渡期旧 RPC 由兼容适配器转发；新版核心和前端不依赖专用方法。

### 12.2 迁移步骤

1. 导入旧 Host 配置、Bot 开关/模式及凭证，生成实例与 Binding。
2. 后端或账号不同则生成不同实例；相同 URL 不足以合并凭证和数据。
3. 插件迁移器接管原 hindsight.sqlite，保留 deviceId/endpoint、bankId、epoch、outbox、operationId、来源和纠正数据，不创建新 bank 冒充原库。
4. 初期可由通用 legacyDataRef 引用原文件，插件一次性导入；核心不识别其表名。SQLite 移动需静止连接并正确备份/迁移，不复制仍在写入的单个主文件。
5. retentionFloor 与恢复读写语义迁入插件状态，不补留存停用期间内容。
6. SOUL 仅转换可识别的程序生成主题块，保留其他人格文本，提供迁移差异。
7. 旧工具/状态名由插件声明 legacy aliases 兼容，不能改名丢失恢复路径。

迁移前本机旧配置保持有效；Host 确认中心分配并完成迁移后，旧设置停止写入。禁止中心与旧本机配置长期双向覆盖。

### 12.3 去特殊化完成标准

- 没有安装 Hindsight，核心能正常启动聊天，不解析其秘密、不建其库、不跑其后台任务。
- 新增第二个原生插件，无须改核心 ID 白名单或前端表单。
- Hindsight 通过相同安装、配置、启用、更新、卸载 API 管理。
- 旧记忆、Bot 模式和恢复行为连续保留。
- 删除实例只影响相关插件能力，不破坏核心运行。

## 13. 分阶段实施

| 阶段 | 交付 | 验收出口 |
| --- | --- | --- |
| A：通用 Host | manifest/schema、实例/Binding、命名空间、生命周期、调用检查 | 两个原生插件按 Bot 独立启停，无 Hindsight 白名单 |
| B：中心管理 | 存储、制品、凭证、Provider/Model、管理页、在线准入 | 连接中心后使用，Host 读取并应用配置，模型配置统一管理 |
| C：三类接入 | MCP、Skill、Hindsight 包及迁移 | 三类独立页面与开关可用，旧记忆数据连续 |
| D：版本生命周期 | 更新、配置/数据迁移、回退资格、卸载清理 | 中断可恢复，不兼容明确阻塞，不丢旧数据 |
| E：多端交付 | 桌面/Android、客户端入口、错误状态 | 真机完成核心用户流程 |

这是实施顺序，不将中心安装、独立管理页和版本更新降为可选功能。仅完成 Host 适配不算整体交付。

核心修改涉及 host-core 的 extension-manager/runtime/runtime-docs、配置/存储、协议及类型；新增中心服务/前端与驱动。现有 Hindsight 文件逐步归入插件包，迁移兼容层独立且标明退出条件。

## 14. 端到端验收

| 场景 | 必须观察到的结果 |
| --- | --- |
| 中心安装三类能力 | 独立页面、真实版本、配置与操作结果 |
| 同 Host 两 Bot 不同分配 | 工具、Skill、hook、后台工作均按 Bot 区分 |
| 主私聊、群、DM | 已有及新建上下文使用一致 Bot 策略 |
| Global/Bot 配置编辑 | 对象合并、数组替换、恢复继承正确；运行路径共用最终配置 |
| 停用在用插件 | 新调用被拒绝，在途状态可见，direct/nested 一致 |
| 中心断连/重新连接 | 断连无法继续使用；重连读取中心当前配置后恢复服务 |
| 下载中断/摘要错误 | 半包不激活，旧版可用 |
| 有持久任务时升级 | 迁移/等待/阻塞正确，不用错误实现恢复 |
| 迁移后回退 | 仅兼容时允许，不静默丢弃新数据 |
| MCP 写操作中断 | 报告未知/中断，不盲目重放 |
| Hindsight 迁移 | bank/outbox/模式/纠正记录连续 |
| 卸载、重装、清数据 | 默认保留，显式清理遵守声明范围 |
| Windows/Linux/Android | 实测远端 MCP、本机能力及带引用 Skill |
| OAuth 和秘密字段 | 登录刷新有效，普通回执/日志不泄露凭证 |

采用实际端到端、协议和设备观测；本方案阶段不新增测试代码或运行生产服务。

## 15. 证据与交付范围

项目源码基线：refactor/bot-host-core 的 07777d83315dd5b3eef6c5606397170778800a42。前端 Host.tsx 当时有用户未提交修改，仅只读识别耦合。

进一步核查：

- host-core/runtime.js:100–279：Hindsight 初始化、registry、BC/记忆顺序。
- host-core/runtime-hindsight.js:451–529：请求捕获、召回、预算和留存。
- host-core/runtime-models.js:197–255：专用配置解析。
- host-core/store.js:234–260：扩展设置持久化与 CAS。
- host-core/hindsight-store.js:1–37：SQLite v2、身份、outbox 迁移约束。
- web/src/HostBotSettings.tsx:1–110：专用类型、工具和界面。
- Durable 1.3.0 dist/harness/types.d.ts:295–325：扩展与 task 解析契约。
- Durable 1.3.0 dist/harness/tool.js:100–137：重放策略和工具解析。

完整上游证据与 worktree 基线见 [前置调研](pi-durable-mcp-skills-research.md)。本文新增的接口、路径和 manifest 均为设计建议，不冒充现有能力。

本次仅更新独立研究 worktree 的文档，没有实现业务代码、部署服务或执行多设备验收。
