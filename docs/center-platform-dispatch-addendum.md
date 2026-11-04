# 父助手派发补充

本文件为接口冻结后的父助手最新职责确认，优先于首次派发任务中的旧文件列举。各 lane 仍只能修改自己的职责。

- center-api 额外负责 center-server/execution.js，实现中心托管 MCP 的 tools/list、tools/call。设备认证与 Binding 检查不得省略；复用 pi-mcp。
- host-center 负责 host-core/control-server.js、local-control-adapter.js、remote-control-protocol.js、control-client.js、index.d.ts、control-client.d.ts 的必要新接口接线。
- app-online 负责 host-core/android-runtime.js、desktop-client.js、desktop-client-cli.js、desktop-ui-store.js 的启动桥/连接档案接线；不要改 runtime.js 或 host-service.js。新增中心配置类型与 cold 状态读取要覆盖 desktop/Android，不让“没有本机Host”阻止远程客户端连接中心。
- deployment 负责 host-core/build-android.js、build-desktop.js、build-mobile.js 及 app/build.gradle 的必要打包接线，避免与 app-online 的 Java/UI 改动重叠。
- center-data 不修改 root/center-server/host-core 包清单；需要依赖更改交给父助手协调 contracts worker。
- PackageVersion 的 schema 必须是安装时解析后的 JSON；snapshot 仅按实际 Bot 分配解析凭证。
- 管理页面与所有 HTTP/工厂命名以 docs/center-platform-contracts.md 第三版为准。中心变更通知使用认证 SSE，原 relay 保留消息与控制协议。
- 非ASCII源码使用UTF-8。只允许静态开发、git提交；所有运行检查由父助手执行。

父助手已核查两份 scout 的模型、Schema、事实引用与职责分离；host 报告个别引用正在原代理补正，没有把该未修正报告作为开发方案交给 worker。共享契约由父助手确定。
