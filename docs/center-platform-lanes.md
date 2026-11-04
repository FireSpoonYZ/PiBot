# 中心平台并行实施分工

开始实现前必须读取 [父助手派发补充](center-platform-dispatch-addendum.md) 和 [第二轮接线补充](center-platform-contract-addendum.md)，其中包含最新接口与文件职责，优先于首次任务消息中的旧路径列举。

基线：c92a80dc5244be1df6d040494fe2366b094e0a33。集成目录：C:/Users/firespoon/orca/workspaces/e-launcher/center-platform-development。

所有 worker 使用 openai/gpt-6.1-terra:xhigh，框架为每人创建独立 managed worktree。允许静态开发和提交自己的代码；禁止测试、构建、类型/语法检查、依赖安装、运行服务以及自行派发代理。父助手负责合并与全部运行验证。原工作区不写入。

先由 contracts worker 冻结共享 DTO/接口与依赖清单，父助手审阅接收后以下模块并行。

| Lane | 所有权（职责优先） | 交付 | 隔离/权限/后续门槛 |
|---|---|---|---|
| center-data | center-server/data/** | SQLite、凭证、global/Bot 配置、模型目录与设备运行快照 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| center-api | center-server/{server,cli,auth,routes,host-bridge}*.js | Fastify HTTPS、单所有者登录、业务路由、原 relay 组合 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| host-plugins | host-core/runtime.js; host-core/runtime-docs.js; host-core/extension-manager.js; host-core/store.js; host-core/plugins/**; plugins/hindsight/** | 通用插件及 Hindsight 去特殊化 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| host-center | host-core/host-service.js; host-core/host-settings.js; host-core/runtime-models.js; host-core/center-client*.js | 中心 bootstrap、模型配置/凭证注入、在线准入 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| mcp-skills | host-core/capabilities/**; host-core/third-party/** | pi-mcp Durable bridge、Skill 移植及按 Bot 策略 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| package-install | center-server/packages/**; host-core/managed-install/** | pacote/npm 安装更新、制品、部署协议 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| admin-shell | center-web/main*; center-web/App*; center-web/api*; center-web/styles*; center-web/pages/{Login,Providers,Models,Devices}* | 管理 UI 框架、登录、Provider/Model | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| plugin-ui | center-web/components/Config*; center-web/pages/{Capabilities,Installation,BotCapabilities}* | RJSF 两级配置、插件详情、Bot 分配 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| app-online | web/src/Host.tsx; web/src/native/**; desktop/**; mobile/**; app/src/main/java/** | App 中心连接门槛、管理入口与本机桥接 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |
| deployment | compose*.yaml; Dockerfile*; scripts/center-*; docs/center-*deployment*.md; THIRD_PARTY_NOTICES.md; licenses/** | Linux Compose、构建入口、运行说明与许可证 | 独立 worktree；只写本模块；提交 handoff；父助手验证 |

共享契约位于 center-contract/ 与 docs/center-platform-contracts.md。模块需要更改其他模块时联系父助手，不跨界修改；不得撤销他人改动。root package.json、center-server/package.json、host-core/package.json 由 contracts lane 首次统一写入，锁文件由父助手生成。

静态报告不是测试通过。架构和产品要求见 docs/reuse-first-development-plan.md，其余 docs/*architecture.md 是补充。
