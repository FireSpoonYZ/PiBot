# Always-on Runtime 验收记录

对应 [架构与迁移说明](always-on-runtime.md)，目标分支为 `refactor/always-on-runtime-20261115`，起点为
`develop@f8593e40cf0d963dd55496f598fad044f0c3c8ad`。交付前同步到随后新增的
`develop@efec5522ce27a41cd29af0c38bcc25c114bac1fc`，解决测试 fixture 的重叠修改后重新运行全量测试。

验收日期：2026-11-15。最终 Node 全量测试 **156 项通过，0 失败**。运行验收由父代理执行；开发 worker 只做静态实现、测试编写和审阅。以下结果对应本重构分支，Android 尚未完成运行验收。

## 执行环境与已知结果

父代理在独立工作区使用仓库固定的 Node.js **26.13.0**，根目录、`host-core`、`center-server` 均已按锁文件安装依赖。命令以 110 秒为有界步骤执行；该环境不能创建 tmux socket。

| 验证 | 结果 | 证据范围 |
| --- | --- | --- |
| 接线前 `npm test`，新增回归尚未纳入 | 94 项：92 通过，2 失败 | 两项失败均在既有 Center 路径，见下文 |
| 执行协议与定时交接专项 | 15 项通过，0 失败 | `always-on-runtime.test.mjs`；真实 SQLite 调度恢复 |
| 任务上下文专项 | 9 项通过，0 失败 | `task-context-projection.test.mjs` |
| 持久等待专项 | 22 项通过，0 失败 | `durable-waits.test.mjs`；取消、重启、事务回滚与升级路径 |
| Live/历史与身份投影专项 | 6 项通过，0 失败 | `always-on-projections.test.mjs`；包含客户端撤权与严格协议 |
| 真实 Host/SDK 集成 | 8 项通过，0 失败 | `always-on-host-integration.test.mjs`，约 2.22 秒；见下文 |
| 最终 `npm test` | **156 项通过，0 失败，约 20.91 秒** | 同步最新 develop 后再次执行，普通测试命令正常退出；基线的两项失败已修复并新增事务故障回归 |
| 前端构建 | 通过，约 4.76 秒 | `npm run build`；Vite 保留既有的大 chunk 提示 |
| 桌面类型检查 | 通过 | `node node_modules/typescript/bin/tsc -p desktop/web/tsconfig.json --noEmit` |
| 内置插件打包 | 通过，生成 6 个归档 | `node scripts/prepare-builtin-plugins.mjs`；问卷和 Tasks 均为 `1.1.0` |
| Android `:app:testDebugUnitTest` | 已尝试，未执行到测试阶段 | Gradle 8.14.3 下载失败：`java.net.SocketException: Network is unreachable` |
| Android 真机验收 | 未执行 | AlarmManager、进程回收、问卷操作、通知与前后台恢复 |

Android 环境有 JRE 21，未发现可用的 JDK 编译器和 Android SDK。Java 新增的 9 项 Robolectric 用例属于已写测试，不能记为通过。

接线前全量测试的两个失败：

- `web/test/center-pairing.test.mjs` 的 schema 8 升级用例：`table tasks already exists`，错误位于 Center 数据迁移。
- `web/test/main-bot-sync.test.mjs` 的数据同步用例：`cannot start a transaction within a transaction`，出现在 `replaceDeviceBots` 调用任务派发取消路径时。

该轮基线测试前没有改动 Center 实现。随后修正迁移用例，使其真正移除 schema 8 之后的表再升级；生产迁移没有用 `IF NOT EXISTS` 掩盖错误。Bot 删除复用明确要求已有事务的任务派发取消 helper，独立取消入口仍自行包事务。新增两项故障注入测试验证删除、取消、seq 和配置版本一起回滚，最终全量测试中两类失败均已消除。

交付时 develop 的 `efec552` 为通用事务包装增加了嵌套 savepoint，并修正了测试 fixture 与跨平台归档路径。本分支保留该实现，同时保留删除路径明确参与外层事务的 helper；两者不会重复取消或独立提交。迁移 fixture 合并时继续使用动态 `currentVersion`，没有重复执行 `DROP TABLE`。独立静态复审和合并后的 156 项全量测试均通过。

真实集成测试使用生产 `openControlServer`、插件加载器、Pi Durable 1.5.0 和 SQLite，只替换 Center 服务与模型 provider。覆盖：旧调度代次跨重启保持取消；问卷结束 SDK Run 后另一输入继续执行；重启后回答且重复回答只产生一次续轮；Center 准入暂失败后的持久恢复；多工具轮拒绝；Stop 后迟到回答；历史编辑 fork 的原子清理；以及 SDK 已 placed、取消尚未执行的冷启动故障点。最后一项仅在造故障的 fixture 使用固定 SDK 的内部 admission 函数，生产实现仍使用公开 API。

## 必须覆盖的行为

| 边界 | 预期结果 | 测试入口 |
| --- | --- | --- |
| SDK generation handoff | 逻辑 Run 锚点稳定，当前 SDK task 可变化 | `always-on-projections.test.mjs` |
| 多输入 steering | 保留各 event/request/submission；不猜业务 task | `always-on-runtime.test.mjs` |
| 送达、原生完成与等待 | ACK 不完成业务任务；原生 done 不吞掉独立待答记录 | 执行协议及持久等待投影用例 |
| 冻结交接后崩溃、claim 后尚未发送 | 重启先查回执，再以相同输入和代次补投 | `always-on-runtime.test.mjs` |
| 接受回执丢失 | 查询确认后不再提交第二次 | 同上 |
| `queued + submissionId:null` 后查询缺失 | 已接受证据保持，不重投 | Node 与 `BotHostSchedulesTest` |
| 超时、空对象、缺少 ID 字段、错误归属 | 不视为明确缺失，不授权补投 | Node 与 Android 交接用例 |
| 旧代次交接撞 Stop | Runtime 持久返回取消；旧事件不能复活 | 调度专项与真实 Host 跨重启集成均通过 |
| legacy ambiguous / 未捕获交接的离线 occurrence | 前者只查回执，后者沿用跳过策略 | Node 与 Android 交接用例 |
| 删除/取消期间迟到结果 | 不覆盖终态 | Node 与 Android 交接用例 |
| 新问卷等待 | 原生 Run 结束，Bot 可处理另一输入，卡片仍可答 | 持久等待与 UI 投影集成 |
| 回答落盘后崩溃、回执丢失、重复回答 | 同一续接请求恢复，首个有效答案胜出 | 持久等待用例 |
| Stop 与回答并发 | 停止关闭旧等待，迟到回答不唤醒旧工作 | 持久等待与 Runtime 集成 |
| scope 取消意图落盘后崩溃，SDK 已 placed | 先恢复精确取消，再恢复调度；不产生模型调用 | 真实 Host 冷启动故障用例 |
| 编辑历史成功或事务失败 | 成功取消旧 native 会话等待；失败一同回滚 | 真实 Host fork 与持久等待事务用例 |
| 旧 task-scoped 及旧 nested 问卷 | 升级后沿旧协议完成；新 nested/multi-tool 请求不建 Wait | 插件恢复用例 |
| 伪造历史可答标记 | Host 清除非权威标记；仅真实 pending Wait 可答 | Live/历史投影用例 |
| 大任务集、中文与代理对、无焦点 | 总预算受限，输入不变、输出确定、待确认约束保留 | `task-context-projection.test.mjs` |

测试文件中的局部 mock 只能证明对应接口行为。实际 Runtime 停止屏障、SDK 工具轮结束和 UI 交互应有接线层证据；Android Robolectric 不代替真机的后台调度验收。

## 复现入口

按 [AGENTS.md](../AGENTS.md) 配好依赖，在固定 Node 版本下运行：

```sh
node --test web/test/always-on-runtime.test.mjs web/test/task-context-projection.test.mjs
node --test web/test/durable-waits.test.mjs web/test/always-on-projections.test.mjs
node --test web/test/always-on-host-integration.test.mjs
npm test
npm run build
node node_modules/typescript/bin/tsc -p desktop/web/tsconfig.json --noEmit
node scripts/prepare-builtin-plugins.mjs
./gradlew :app:testDebugUnitTest --no-daemon --console=plain
```

远程命令遵守 120 秒超时；本次实际采用 110 秒上限，全部通过项目均在上限内正常退出。预计超过时限的构建使用可用的 tmux 管理，不把超时当作完成。Android 记录的是实际下载失败阶段。

## 交付范围

本轮共有 8 个开发子任务：执行协议、Host 定时交接、Android 定时交接、持久等待、任务上下文、故障回归、运行/界面投影和文档。平台同时只提供 3 个 worker 槽位，按依赖分波次推进；集成和运行验收由父代理负责。没有把 8 个子任务计为 8 路同时运行。

交付分支为 `refactor/always-on-runtime-20261115`，基于上述 develop 提交。架构文档、插件 README、回归测试和实现一同交付。上线需要同步升级 Host、Center 和客户端；Android 单测、打包及真机调度恢复仍需在具备工具链的环境完成。
