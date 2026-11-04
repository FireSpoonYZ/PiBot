# 父助手并行接线补充（第二轮）

本补充是父助手对各worker实际接缝问题的统一决定。最终以此与已批准主管回复为准，不扩大产品范围。

## 服务/协议
- 设备HTTP认证为 Authorization: Bearer <deviceToken> + X-Device-Id。
- 匿名GET /api/session建立cookie并返回csrfToken；修改请求（含登录）使用x-csrf-token；登录后更新session/token。
- bootstrap先SSE与冷读Bots，control listener/runtime可先创建但centerOnline=false且不resume；原DeviceLink接通后apply snapshot→online→resume。
- Runtime输入centerRuntime={snapshot,getClient:()=>当前CenterClient|null,installer}；模型转换applyCenterModels(snapshot,existingModels?)原位更新既有registry。
- Runtime增withCapabilityActivation(id,publish):Promise<boolean>，原子准入保护，忙返回false不publish。installer和中心execution分别提供withActivation；在线阶段约1秒串行重试waiting-idle。
- Native/App桥允许最多约1秒状态轮询，Host实际执行入口仍立即检查在线。旧/chat转HostPage；保留旧数据与迁移，不继续旧本机配置写入口。
- HostService可选npmPath为npm-cli.js绝对路径；未配置仅安装时报告NPM_UNAVAILABLE，不阻止无安装计划的Host。
- 固定管理RPC validateCenterProvider/discoverCenterProviderModels接收{provider,models,credential?}；这是所有者显式测试的TLS控制帧窄例外，不入库/历史/日志，测试未保存配置须先保存。
- 中心建专用内部relay client（身份元数据非秘密，token由store加密）调用目标Host，不假冒Host。

## 配置与存储
- 凭证标记是JSON Schema string+format:'credential-ref'；普通properties/items及additionalProperties字典支持。值就是credentialId字符串。
- EffectiveCapability新增credentialRefs:string[]，data按该Bot/实例最终配置计算。Host只挑本能力这些引用。center目标/disabled不向Host发秘密；中心execution直接store.resolveCredential。
- PackageVersion保存已解析configSchema/uiSchema。先putPackageVersion再putInstallation；新global允许未完整配置，不启用、不启动。
- center-data增put/listDeploymentPlan、updateOperation、listOperations、put/getRuntimeReceipt。putOperation只做创建及requestId幂等；阶段更新走updateOperation。
- DeploymentPlan新增packageId、manifest、planId、desiredRevision；Receipt加planId。desiredRevision是device+instance计划单调版本，只有语义变化才换planId和递增。operation.deviceIds不是永久权限依据，当前plan决定回执有效性。

## 包与驱动
- 原生manifest固定capability.json；允许skills相对路径数组及actions静态描述{id,title,inputSchema,outputSchema?}。
- tgz支持标准npm package/前缀，packageRoot指向实际含package.json的包目录。
- MCP config为url/command/args/cwd/env/headers/timeoutMs/可选transport；envRefs/headerRefs/apiKeyRef是凭证ID，refs覆盖普通同名值，apiKeyRef仅在未显式Authorization时生成Bearer。单一JS bin用process.execPath启动，多bin选config.bin。
- Skill优先根SKILL.md，再capability.json.skills，再package.json.pi.skills，否则仅扫描受管根。
- 原生插件通过host.sdk获取宿主Durable/Chord工厂，不能运行时import/安装第二份宿主引擎。不使用跨目录symlink或自定义ESM loader。
- NativePlugin.durableTasks每实例只注册一次，由插件工厂以installationId命名；不自动重命名definition。
- BotPlugin.durableContributions={tools?,sections?,hooks?,wraps?}，不含name和非空tasks。每Bot extension由Host稳定命名并显式选择。
- requestContributions={beforeRequest?:async(request,api,context)=>request|undefined}。
- actions为Record<id,{inputSchema,execute(input,invocationContext):Promise<JsonValue>}>。管理动作按真实Bot执行，Runtime先查策略。
- package manager增getInstalled/reconcileDevice/withActivation/onChange(installationId)。Binding是Host部署分配依据；异步操作真正持久化后通知，不能只在202通知。
- Host tar7.5.22已由父助手安装（BlueOak-1.0.0）；没有安装命令授权给worker。

## 新增窄职责
- host-plugins继续通用loader/runtime/manager，不再负责Hindsight文件搬迁与SQL迁移。
- hindsight-adapter拥有plugins/hindsight/**（排除migration.js）及host-core/hindsight-*、runtime-hindsight.js的必要兼容迁移；提供普通createPlugin和8个memory actions，不改runtime.js。
- hindsight-migration仅写plugins/hindsight/migration.js。API migrateLegacyHindsight({legacyDataRoot,dataDir,deviceId,botId,endpoint,initializeTarget})→Promise<{migrated,unassignedRequests}>；initializeTarget由adapter提供，创建并关闭目标schema。保留原bank/outbox/request键；未知归属保留legacy库、不复制给其他Bot、不自动重放。
- oauth-service仅写center-server/oauth/**。openMcpOAuth({store,publicUrl})返回start/status/complete/logout/getAuthProvider/close。首版仅中心托管HTTP OAuth，官方pi-mcp完成协议，加密状态借store credentials。
- OAuth routes：owner POST /api/installations/:id/oauth/start，GET /api/oauth/mcp/flows/:flowId，POST /api/installations/:id/oauth/logout；公开GET /api/oauth/mcp/callback验证state/PKCE后固定完成提示。
- GET /api/installations/:id/actions列静态ActionDescriptor；validateInstallation选deviceId+botId。没有validate动作明确不支持连接验证。
- admin-shell补listActions/OAuth API方法；plugin-ui补OAuth按钮/流程并读取动作元数据。
- app-online补npmPath启动字段和原有npm资产准备；deployment补相应打包资源，.dockerignore允许修改。

## 部署输入
CENTER_DATA_ROOT=/data、CENTER_LISTEN_HOST=0.0.0.0、CENTER_PORT=8443、CENTER_RELAY_PORT=8790、CENTER_PUBLIC_URL、CENTER_LINK_URL、CENTER_WEB_ROOT=/app/center-web/dist、CENTER_TLS_CERT_FILE/KEY_FILE。
CENTER_ENCRYPTION_KEY_HEX和CENTER_SESSION_KEY_HEX各为独立32字节的64hex。
CENTER_OWNER_PASSWORD_HASH=scrypt$<16字节salt hex>$<64字节key hex>，Node scrypt默认参数；CLI password-hash从stdin读口令。
CENTER_NPM_PATH可选绝对npm-cli.js路径，中心默认解析所依赖npm包。

## 来源
Pi官方npm发布包1.3.0已下载至 C:/Users/firespoon/AppData/Local/Temp/e-launcher-center-platform-1793078116443/upstream-pi-1.3.0/package。
原始tgz SHA256 ae2785e870b81a8c8e1d44510a57b5ee0bfc9e974679ac2faaada4aabee3d3c0；tag v1.3.0，MIT。复制dist/core/skills.js与dist/utils/frontmatter.js独立函数，保留出处，不虚构gitHead。
