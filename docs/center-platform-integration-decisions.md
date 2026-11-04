# 本轮集成决策（追加，优先于旧接口草案）

- 上传制品更新：UpdateRequest.source 可选 artifactRef，校验同 packageId/准确版本。中心准备成功后一起发布 targetVersion/source；各 Host 独立应用，失败留本机旧 active。无跨 Host 原子提交、无自动全局回滚。
- 执行目标：中心管理全部类别，中心仅执行 MCP；Native Durable 插件/Skill 执行目标是 Host。plugin/skill + center 返回 UNSUPPORTED_TARGET，UI 不显示该组合。
- 部署计划：相同 device+instance、相同目标语义的 reconcile 复用完整 plan。新管理 requestId 不要求生成新部署 plan；无变化请求可以按现有实际状态完成。变化必须递增 desiredRevision，替换 planId。
- 回执：API 存储验证当前 plan 后，按 operation 初始 deviceIds 汇总对应当前 planId/revision/operationId 的回执，推进终态；后来增加 Binding 不重开旧 Operation。
- 保留凭证前缀 center-internal-：仅内部 relay/OAuth 使用。管理读写/删除、Provider/plugin credential-ref 不可引用；Host 快照不能分发。内部 store API 仍允许服务使用。
- Runtime：prepare 只准备配置/资源，不能套在线执行门禁；首次 applyCenterSnapshot 离线完成，activate 延后到 online。工具、request hooks、后台实际执行仍受门禁保护。
- 安装激活：withCapabilityActivation 空闲时 quiesce/publish 后保持门禁关闭，appliedRevision=null；新快照重载完成才恢复 online。waiting-idle 延后成功也要触发 Host-service 重载，不能只等中心 revision 改变。
- 策略：BotPlugin.onPolicyChanged({enabled,effectiveConfig}) 可在 quiesce 后、close/替换前调用，只做本地策略持久化。普通 shutdown 不伪装策略禁用。getBotEntryWatermark(botId) 为只读通用能力；Hindsight 自己维护 lastWritable/floor。
- Host SDK：documents 包含 RequestKeys，提供 context/countMessageTokens/getBotEntryWatermark 等通用服务，SDK 工厂注入，不再创建 Hindsight 专用核心服务。旧配置解析可留在旧兼容文件，不把核心静态耦合回插件包。
- 迁移 initializeTarget(tempDataDir) 在传入临时目录创建并关闭旧 schema SQLite；迁移事务/完成标记/发布由 migration.js 处理。源库与未知归属请求保留。
- 远端状态 RPC：getServiceStatus({}) 返回已有 HostServiceStatus，ready 前也可查询。桌面只是 broker，无本机 Host，不传无消费者 npmPath、不额外打包 npm。Android 复用既有 npm 资产；独立 Node Host 用自己的 npm 依赖/可选 npmPath，缺失仅安装时报错。
- host-core Ajv 8.17.1 已由父助手安装并锁定；动作输入不强制类型转换、不补默认值。
- 用户批准临时 worker 配置 center-worker-no-context7-032539b1（同模型和开发工具，仅移除 Context7）恢复受影响分支；原 worker 模板与全局 MCP 未改。
