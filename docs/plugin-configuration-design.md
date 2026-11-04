# 插件两级配置架构

状态：设计稿。优先级已由用户确认：Bot 配置覆盖 global 配置。
适用于插件、MCP、Skill；Hindsight 使用同一套规则。App 和 Host 必须连接中心才能运行；Provider/Model 也由中心管理，见 [在线运行架构](central-models-online-architecture.md)。

## 1. 配置模型

每个安装实例只有两份配置来源：

- **globalConfig**：中心维护，作为该实例对所有 Bot 的基础配置。
- **botOverrides**：中心按 Bot 保存，只包含该 Bot 明确覆盖的字段。

```text
effectiveConfig = merge(globalConfig, botOverrides)
```

effectiveConfig 是计算结果，在线运行时在内存使用，不能单独编辑，也不是第三层配置。

global 的范围是“这个插件安装实例”，不把所有插件的字段混在一起。插件版本、安装状态、Bot 启用开关属于管理信息，与配置内容分开存放。

包提供的初始值在安装时写入 globalConfig；运行时不再叠加包默认值、Host 默认值或 Bot 默认值。整个系统只保留 global → Bot 两级。

## 2. 数据流

```text
插件配置页面                       Bot 插件页面
编辑 globalConfig                  编辑 botOverrides
         │                              │
         └──────────────┬───────────────┘
                        ▼
             中心配置服务 ConfigService
             读取 → 合并 → Schema 校验
                        │
                        ▼
              每 Bot 的 effectiveConfig
                        │
              已有配置同步 / 应用回执
                        │
           ┌────────────┴────────────┐
           ▼                         ▼
      Host 插件运行上下文        中心插件运行上下文
           └────────────┬────────────┘
                        ▼
         工具、请求钩子、后台工作、管理操作
```

合并逻辑只在中心配置服务实现一次。Host 和插件收到最终配置，直接使用，不重复实现优先级。

## 3. 合并规则

采用普通 JSON 对象合并，规则固定：

| 数据 | 行为 |
| --- | --- |
| Bot 未提供字段 | 继承 global |
| 两边都是对象 | 按字段递归合并 |
| 字符串、数字、布尔 | Bot 值覆盖 global |
| 数组 | Bot 数组整体替换，不拼接 |
| null | 是显式值；配置 Schema 允许时覆盖 global |

false、0、空字符串和空数组都是明确配置，不能用真值判断是否继承。

“恢复继承”就是从 botOverrides 删除该字段，不使用 null 或额外删除标记。即便 Bot 值碰巧与 global 相同，只要用户选择了覆盖，就保留覆盖关系。

不做表达式、变量引用链或可选合并策略。

### 示例：Hindsight

globalConfig：

```json
{
  "baseUrl": "https://memory.example.com",
  "apiKeyRef": "memory-shared",
  "mode": "read-write",
  "recall": {
    "maxResults": 10,
    "tags": ["general"]
  }
}
```

某 Bot 的 botOverrides：

```json
{
  "mode": "read-only",
  "recall": {
    "tags": ["research"]
  }
}
```

最终 effectiveConfig：

```json
{
  "baseUrl": "https://memory.example.com",
  "apiKeyRef": "memory-shared",
  "mode": "read-only",
  "recall": {
    "maxResults": 10,
    "tags": ["research"]
  }
}
```

之后 global 将 maxResults 改为 20，这个 Bot 随之变为 20；mode 和 tags 仍使用自己的覆盖值。删除 Bot 的 mode 覆盖后，重新继承 global 的 read-write。

## 4. 统一 Schema

每个插件版本只提供一份 configSchema。global 和 Bot 页面展示同一套配置字段，不再有 installationConfigSchema/botConfigSchema 两套业务字段分类，也不增加 overrideable 白名单。

- global 页面编辑基础配置。
- Bot 页面编辑同一 Schema 的部分字段。
- 校验对象是合并后的 effectiveConfig；不能要求 botOverrides 自己提供所有 required 字段。
- 采用 RJSF + Ajv 8（draft-07）表单和校验；合并直接使用 deepmerge，arrayMerge 显式设为整体替换，不自写递归合并器或配置 DSL。

地址、凭证引用和行为参数都可以被 Bot 覆盖。插件自己的管理状态、代码版本及执行部署信息不属于 configSchema。

## 5. 存储

复用已有安装实例与 Bot 分配模型，配置只需两个 JSON 字段：

```text
Installation
  installationId
  globalConfig
  revision

BotBinding
  deviceId
  botId
  installationId
  enabled
  overrides
  revision
```

Bot 未覆盖任何字段时保存 overrides = {}。不要把 global 完整复制一份写入每个 Bot，否则后续 global 修改无法自然继承。

中心按需计算 effectiveConfig 并下发在线执行端；不新增第三份可编辑配置表，也不保存离线备用配置。继续使用已有修订号和应用回执。

## 6. 页面交互

### Global 配置页

显示完整基础表单。保存修改后，继承相关字段的 Bot 使用新值；有覆盖的字段保留自己的值。页面显示该实例的使用 Bot 和应用状态。

### Bot 配置页

每个字段显示“继承 global”或“单独设置”，并提供最终配置预览：

```text
Hindsight · 调研 Bot                           [已启用]

字段              最终值                        来源
后端地址          https://memory.example.com     global  [覆盖]
API Key           已配置                        global  [覆盖]
读写模式          只读                          Bot     [恢复继承]
召回数量          10                            global  [覆盖]
召回标签          research                      Bot     [恢复继承]

[查看最终配置]                 [全部恢复继承] [保存]
```

“全部恢复继承”将 overrides 设为 {}，不关闭插件。嵌套对象按叶字段显示来源；数组作为一个整体编辑。RJSF 展示最终值，但只把用户选择覆盖的路径写入 overrides，不能直接保存整个 formData。

插件详情的 Bot 分配页与 Bot 自己的插件页使用同一组件和接口，不各自实现覆盖逻辑。

## 7. API

沿用中心管理 API，调整数据形状即可：

| 接口 | 内容 |
| --- | --- |
| GET /api/installations/:id/config | globalConfig、configSchema、revision |
| PUT /api/installations/:id/config | expectedRevision、globalConfig |
| GET /api/devices/:deviceId/bots/:botId/capabilities/:id | enabled、globalConfig、overrides、effectiveConfig、revision |
| PUT /api/devices/:deviceId/bots/:botId/capabilities/:id | expectedRevision、enabled、overrides |

PUT 保存完整的“覆盖项对象”，不用引入 JSON Patch。恢复继承时，前端删掉 overrides 中对应字段后保存。

effectiveConfig 只由中心计算，不接受客户端提交。配置读取中的凭证继续返回引用和已配置状态，不返回密钥值。

## 8. 运行时如何使用

插件使用按 Bot 解析好的运行上下文：

```text
BotPluginContext
  botId
  installationId
  config             // effectiveConfig
  credentials        // 按 config 内的引用获取
```

工具、请求钩子、后台工作和管理操作共用这个上下文，不允许其中一条路径直接回读 globalConfig。

包代码和定义按安装实例装载；带配置的客户端及运行资源按 Bot 创建并复用。这样不同 Bot 覆盖了地址、账号或参数时，不会仍使用一个根据 global 创建的共享客户端。首版不做跨 Bot 连接池优化，也不要求每 Bot 启动独立进程。

中心执行与 Host 执行遵守相同规则。管理页面的“验证 global 配置”使用 global；验证某个 Bot 时使用该 Bot 的 effectiveConfig。

global 或 overrides 保存后，中心重算相关 Bot 的最终配置并下发在线 Host，新配置在运行边界切换。Host 连接中心后才加载配置并运行，断开后停止新工作；重新连接直接获取最新配置，不沿用离线备用配置。

## 9. 凭证与启用开关

凭证使用普通引用字段，例如 apiKeyRef：

- global 可引用共用凭证。
- Bot 可覆盖成自己的凭证引用。
- 合并完成后才解析最终引用，覆盖地址和凭证的处理方式相同。

启用开关不参与 JSON 合并：

```text
可用 = 安装实例启用 AND BotBinding.enabled
配置 = merge(globalConfig, botOverrides)
```

关闭 Bot 插件时保留 overrides，下次启用继续使用；“恢复继承”和“关闭插件”是两个操作。

## 10. 对现有方案的调整

1. 用一份 configSchema 替代两份配置 Schema。
2. 安装实例保存 globalConfig，BotBinding 保存 overrides。
3. 中心配置服务提供统一合并与最终配置校验。
4. 表单增加继承/覆盖切换，提供最终配置预览。
5. 运行时改为每 Bot 取得最终配置，Hindsight 同样接入。
6. 安装、版本、同步和回执沿用原方案，不因两级配置重建一套系统。

设计核对只需覆盖常用行为：直接继承、标量覆盖、嵌套对象、数组替换、恢复继承、global 修改后的继承，以及不同 Bot 使用不同凭证。实现时用这些场景做端到端验证。

本次只更新架构文档，尚未实现配置服务或运行验证。
