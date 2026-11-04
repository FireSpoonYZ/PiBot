# Provider、Model 中心管理与在线运行架构

状态：设计稿。
已确认：Provider/Model 配置统一放在中心；连接并认证中心服务后才能使用 App，不提供离线模式。

## 1. 整体结构

```text
App / 中心管理 Web
       │ 必须连接中心
       ▼
中心服务器
 ├─ Provider：协议、地址、凭证
 ├─ Model：模型目录与能力参数
 ├─ Global 默认模型 + Bot 覆盖
 ├─ 插件 / MCP / Skill：安装与两级配置
 └─ 设备连接与控制
       │ 配置、凭证、Bot 指令
       ▼
Host（必须与中心保持连接）
 ├─ 内存中的当前运行配置
 ├─ Pi Durable / BC
 ├─ 插件与工具
 └─ 通过 pi-ai 直连模型 Provider
```

中心是所有业务配置的唯一来源。Host 本地只保留连接中心所需的地址、设备身份和认证信息，以及实际工作数据。

模型调用先保留现有 Host → Provider 路径，复用 pi-ai；中心不增加转发模型流量的代理。这样集中管理配置的同时，无须重写流式响应和取消链路。

## 2. Provider 与 Model 的职责

### Provider

中心保存：

- providerId、显示名称。
- API 类型，例如 OpenAI-compatible、Anthropic。
- baseUrl。
- credentialRef。
- 启用状态。

同一服务的不同账号可建立不同 Provider。普通管理接口只返回凭证引用和已配置状态。

### Model

模型归属于 Provider，中心保存：

- 上游 modelId 与显示名称。
- contextWindow、maxTokens。
- 输入能力，例如文本、图片。
- reasoning 与 thinkingLevelMap。
- 价格和已有 compat/inputLimits 字段。
- 启用状态。

复用当前 host-core/runtime-models.js 已支持的字段，不另设计一套模型描述格式。模型 discovery 用于辅助导入目录，用户可以手动补充上游没有返回的能力参数。

模型引用沿用 providerId/modelId，作为一个完整值选择，避免 Provider 与 Model 分开覆盖产生不匹配。

## 3. Global 默认值与 Bot 覆盖

模型选择也采用简单的两级结构：

```json
{
  "global": {
    "modelRef": "openai/main-model",
    "thinkingLevel": "medium"
  },
  "botOverrides": {
    "modelRef": "anthropic/research-model"
  }
}
```

这个 Bot 使用 research-model，thinkingLevel 继承 medium。删除 Bot 的 modelRef 覆盖就恢复全局模型。

中心使用与插件配置相同的字段覆盖规则；Provider/Model 目录是引用对象，Bot 不在本机另建目录或修改 API Key。

Provider/Model 管理是中心基础模块，与插件管理并列。Hindsight 仍属于普通插件，模型目录不依赖其存在。

## 4. 管理页面

### Provider 列表与详情

路由建议：/providers、/providers/:providerId。

列表显示名称、协议、地址、模型数和启用状态。详情提供连接配置、凭证、模型目录、连接验证和模型发现。

连接验证与发现通过选定的在线 Host 执行，使测试路径与实际模型请求一致；普通页面不接收 Provider 密钥。

### Model 详情

路由建议：/providers/:providerId/models/:modelId。

可编辑上下文窗口、输出上限、输入能力、推理参数、价格和兼容字段。

### Global 模型设置

选择默认模型、默认思考档位。中心所有可用模型来自同一目录。

### Bot 模型设置

每项显示“继承 global”或“单独设置”，并展示最终模型。保存到中心，所有客户端访问同一份配置。

现有 App 中逐设备编辑 Provider 的入口迁为中心管理入口，不再写本机 host-settings 的模型配置。

## 5. 运行时接线

中心配置服务为目标 Host 生成当前 Bot 的运行配置，包括有效模型选择、需要的 Provider/Model 定义、插件最终配置和所需凭证。

Host 收到后复用现有能力：

- 创建/更新 pi-ai Models registry。
- 使用现有模型目录解析、模型切换和 Bot profile 更新逻辑。
- 主私聊、群和 DM 使用该 Bot 的有效模型。
- Provider 密钥从注入的运行凭证读取，不再要求用户逐台维护 apiKeyEnv。

配置和秘密仅用于当前在线运行，Host 不保存一份供离线使用的业务配置。修改时更新在线 Host，新请求使用已应用配置；界面展示是否应用成功。

Provider/Model 被停用时，使用它的 Bot 显示需要重新选择，不自动偷偷切换到另一模型。

## 6. 必须在线的使用规则

只使用三个客户端状态：

```text
未连接 → 正在连接 → 已就绪
                      │
                    断开
                      ▼
                    未连接
```

### App 启动

1. 读取中心地址并连接、认证。
2. 成功后加载中心配置和在线设备。
3. 进入主界面。

连接失败只显示登录/连接设置与重试入口，不进入本地聊天或离线管理页。

### Host 启动

1. 用本地设备身份连接中心。
2. 获取最新业务配置及所需凭证。
3. 准备插件，建立 Models registry，启动 Runtime。
4. 向中心报告 ready 后接受工作。

不从旧本机设置启动可运行的备用 Host。必要的启动顺序调整属于这次实施范围。

### 中心断开

- App 进入断连/重连页面，业务操作不可用。
- Host 停止接受新工作，拒绝启动新的模型请求、工具和后台工作。
- 已发出的调用通过现有取消机制停止；已经产生的结果正常保存。
- 重新连接后读取中心当前配置，再恢复服务；不重发结果未确认的用户请求。

沿用现有连接状态、心跳和取消机制，不新增租约协议或离线授权系统。

App 与中心连接正常、某个 Host 未连接时，中心管理功能仍可用，该 Host 的 Bot 显示“不在线”，无法向其发送工作。

## 7. 可以直接删除的设计

不再实现：

- 离线浏览 Bot/历史的缓存模式。
- 离线修改业务配置和本地优先配置。
- 离线消息待发送队列及自动补发。
- 中心不可达时沿用上次配置继续运行。
- Host 与中心配置双向合并、离线冲突处理。
- 为离线部署保存逐条变更并按历史顺序重放。

中心自身保存最新配置。某个 Host 下次上线时直接读取当前状态，不追逐停机期间每一次编辑。

插件安装文件、聊天历史、Durable 状态和实际工作文件继续持久保存，供在线运行及恢复使用；这些不是 App 的离线服务入口。

对已存在的待发送记录或旧配置，迁移时保留原数据供核查，不继续使用旧的离线执行路径，也不自动补发历史请求。

## 8. 中心存储与 API 增量

最少新增：

```text
providers
models
global_model_config
bot_model_overrides
```

凭证复用中心 credentials；插件继续使用 globalConfig + botOverrides。

管理接口：

| 接口 | 用途 |
| --- | --- |
| GET/POST /api/providers | 列表/新增 Provider |
| GET/PUT /api/providers/:id | 读取/编辑 Provider |
| POST /api/providers/:id/validate | 经选定 Host 验证连接 |
| POST /api/providers/:id/discover | 获取模型目录 |
| GET/POST /api/providers/:id/models | 模型列表/添加 |
| PUT /api/providers/:id/models/:modelId | 编辑模型 |
| GET/PUT /api/model-config | Global 模型选择 |
| GET/PUT /api/devices/:deviceId/bots/:botId/model-config | Bot 覆盖及最终选择 |

运行配置使用已认证的设备接口下发；浏览器管理接口不返回密钥。

## 9. 实施调整

1. 中心增加 Provider/Model 页面、存储与模型选择服务；将现有 Host 配置导入中心，并更新 Bot 的模型引用。本机旧配置仅作为迁移来源，迁移后停止写入。
2. App 先经过中心连接页再进入业务界面。
3. Host 改为先连接中心、取配置，再启动 Runtime。
4. 复用 pi-ai 与现有模型加载/切换功能，把配置来源改为中心。
5. 插件配置沿用已确认的 global → Bot 两级合并。
6. 移除离线备用配置、离线待发送和离线缓存使用路径。

验收聚焦常用流程：中心配置模型、两个 Bot 选择不同模型、global 变更与覆盖、中心连接失败不能进入业务、断连停止新工作、重连读取当前配置。

本次只更新架构文档，没有实施模型配置迁移或运行验证。
