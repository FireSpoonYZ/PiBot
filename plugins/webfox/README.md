# Webfox — Host 受管插件

联网插件，基于 [webfox](https://github.com/mavam/webfox) **4.8.0** 库 API（`createWebfox` + `inspectCapability`）经 host SDK 注册 Durable 工具。npm 包名 `@e-launcher/webfox`，能力 ID `e-launcher.webfox`，要求 Host API `^1.0.0`、Durable API `1.4.0`。

## 工具

只为**显式配置了 provider** 的能力注册工具；未配置的能力不出现，也不会回落到其他 provider：

| 工具 | 能力 | 输入 |
| --- | --- | --- |
| `web_search` | 搜索 | `queries`（≤10）、可选 `maxResults`、`options` |
| `web_contents` | 网页内容提取 | `urls`、`options` |
| `web_answer` | 联网问答 | `queries`（≤10）、`options` |
| `web_research` | 前台深度调研 | `input`、`options` |

provider 专属参数放在工具调用的 `options` 字段；未声明选项的 provider 不出现该字段。搜索与内容查询可分别选择不同 provider。超时、取消、按输入进度、部分失败（status `partial`）与结构化结果沿用 Webfox 语义；`options` 中放错位置的参数在调用前被拒绝并给出建议路径。模型可见输出限 50 KiB / 2000 行：任一超限时完整结果（渲染文本 + 结构文档）写入插件数据目录下的私有文件（`webfox-output/`，0600），输出开头附文件路径与字节数，可用 read 分段读取；`structuredOutput` 始终携带完整结果文档供 codemode 使用。

## 配置

在中心按 Bot 配置；配置只保存引用，不保存密钥明文。

- **capabilities.<能力>.provider**：为每个能力选择 provider。可选 `brave`、`cloudflare`、`exa`、`firecrawl`、`gemini`、`linkup`、`ollama`、`openai`、`parallel`、`perplexity`、`serpbase`、`serper`、`tavily`、`valyu`、`youcom`。各 provider 支持的能力见上游 provider 文档；选错能力/provider 组合会在启用绑定时报错。
- **capabilities.search.maxResults**：可选默认结果数。
- **providers.<id>.baseUrl**：自建端点（如 Ollama、Firecrawl 自托管）时填写。
- **providers.<id>.options.<能力>**：provider 专属默认选项，键名与上游一致（如 serpbase 的 `mode`/`gl`/`hl`）。
- **credentials.***：凭据库引用（credential-ref）。名称与上游环境变量对应：`braveSearch`（BRAVE_SEARCH_API_KEY）、`braveAnswers`（BRAVE_ANSWERS_API_KEY，answer/research）、`cloudflareToken` + `cloudflareAccountId`（CLOUDFLARE_API_TOKEN/ACCOUNT_ID）、`exa`、`firecrawl`、`gemini`（GOOGLE_API_KEY）、`linkup`、`ollama`、`openai`、`parallel`、`perplexity`、`serpbase`、`serper`、`tavily`、`valyu`、`youcom`（YDC_API_KEY）。Ollama 云端模式可选填；其余 provider 缺凭据会在启用绑定时报错。
- **timeoutMs / researchTimeoutMs / retries / concurrency**：整体执行参数；research 前台等待，不设后台任务。

不支持任意自定义命令 provider（`providers.custom.commands`）；不读取宿主用户的全局 webfox 配置文件，也不改 `process.env`。

## 打包与安装

流程与 billion-context 一致：仓库根目录 `npm pack ./plugins/webfox --pack-destination <仓库外目录>` 得 `.tgz`；中心上传（类型 `plugin`、来源本地制品、目标 `host`）创建实例后，在目标 Bot 的绑定中启用并填写配置。中心为制品生成锁文件，Host managed installer 以 `npm ci --omit=peer` 安装 `webfox`、`typebox` 及其运行时依赖（含各 provider SDK）。启用绑定需该 Bot 对应 provider 的凭据已在凭据库保存并被配置引用；缺失或无效凭据会使绑定启用失败而不是注册一个无凭据工具。

kind 为 `plugin` 的锁生成与安装使用 `--legacy-peer-deps`：npm 11 默认 peer 解析会把也是 direct dependency 的 `typebox` 误标 `peer:true`，`--omit=peer` 安装时会漏装它并导致 `ERR_MODULE_NOT_FOUND`。该模式只对新打包的原生插件生效；由旧中心生成的错误锁文件不会被改写，对应制品需重新上传/部署才能拿到修正后的锁。

## 边界

- 无独立后台任务；research 在前台等待直到完成、超时或取消（取消不一定撤销远端已计费任务，与上游一致）。
- 四个工具全部 `replay:'unsafe'`：网络请求有副作用/计费，与上游一致，主机重启后不自动重放已中断的执行。
- 工具 details 只包含能力/provider/各输入状态的有界投影，不含完整结果文档或凭据。

## 许可

`render.js` 与 `webfox-tools.js` 的参数纠错逻辑移植自上游 webfox 4.8（`src/render.ts`、`src/pi-validation.ts`），上游 MIT 许可文本见 `LICENSE`。
