# PiBot 内置操作与远程 MCP

Bot 可通过 `tool_search` 按需加载内置管理工具。Center 可以把同一套操作通过 HTTPS `/mcp` 提供给 Gemini Apps 等 MCP 客户端。远程 OAuth MCP **默认关闭**（`CENTER_MCP_ENABLED=false`），仅在显式设置 `CENTER_MCP_ENABLED=true`（仅接受字面量 `true`）并提供有效客户端配置后才会开放。即使已有客户端配置文件，未显式开启时也不会读取该文件，`/mcp`、`/oauth/mcp/*` 与 `/.well-known/oauth-*` 均返回 404（不会回落到管理页 HTML）；开启但缺少有效客户端配置，或 `CENTER_MCP_ENABLED` 为非法值时，Center 会拒绝启动以避免暴露空入口。Center 内置 Bot 工具与既有上游 MCP/OAuth 不受此开关影响。**不使用配对 token、`pboauth_` 或管理员 Cookie 连接 MCP。**

## 登记客户端

1. 让 MCP 客户端能访问 Center 的公网 HTTPS 地址，使用其信任的证书；反向代理同时转发 `/mcp`、`/.well-known/oauth-*` 与 `/oauth/mcp/*`。不要在这些路径记录认证头、表单或回执正文。
2. 在服务器上创建只有所有者与 Center 服务可读的 JSON 文件（下例为占位值，密钥应独立随机生成）。同时设置 `CENTER_MCP_ENABLED=true` 与 `CENTER_MCP_CLIENTS_FILE`（服务看到的绝对路径）后重启。容器部署可在 `center` 的 `volumes` 增加 `./center-mcp-clients.json:/run/secrets/pibot-mcp-clients.json:ro`，配置为容器内路径。不要把该文件提交到 Git。
3. 将 `https://你的中心/mcp` 添加到 MCP 客户端。对于 [Gemini Apps 的自定义应用](https://support.google.com/gemini/answer/17209137)，使用网页版添加，并按 [手动客户端注册方式](https://developers.google.com/connected-apps/mcp/dev-mode/usage) 填入客户端 ID 和密钥。以客户端显示的实际回调地址为准，必须逐字匹配配置；不支持动态注册。跳转到 Center 后由所有者登录并确认同意。
4. 如需撤销单次授权，可由客户端向 OAuth 撤销端点撤销；管理员移除客户端配置并重启可撤销该客户端（若要完全关闭远程 MCP，将 `CENTER_MCP_ENABLED` 设为 `false` 或移除该项后重启即可）。当前 access token 和 refresh token 状态在内存中，**Center 重启后客户端需重新授权**。

```json
[
  {
    "clientId": "gemini-personal",
    "clientSecret": "REPLACE_WITH_AN_INDEPENDENT_RANDOM_SECRET",
    "redirectUris": ["https://client.example.com/oauth/callback"],
    "scopes": ["pibot:bots:read", "pibot:messages:read", "pibot:messages:write"],
    "botTargets": [{ "deviceId": "your-device-id", "botId": "your-bot-id" }]
  }
]
```

权限按业务分组（`bots`、`capabilities`、`collaboration`、`automation`、`center`、`messages`），每组有独立 `read` / `write`；写权限不隐含读权限。**除 `messages` 限定到 `botTargets` 外，管理类 scope 可能影响整个 Center**（例如更改全局配置、提交自动化、向真实群发信）。不要给只需要聊天的客户端发管理权限。用户确认、配对、信任证书、密钥和连接授权不在操作目录。

## 发消息和取回复

1. 调用 `dispatch_send_bot_message`，指定已授权的 `deviceId`、`botId`、`message` 和稳定的 `requestId`。回执表示已受理；Host 离线时等待上线，不会由 Center 代跑模型。
2. 用相同的目标和 `requestId` 调用 `dispatch_get_bot_message`。只有执行成功才返回该请求的答复；查询不返回 Bot 的私聊历史或工具结果。重复提交同一请求不会生成第二次执行。
3. Bot 本身在对话中仍用 `send_to` 发送 DM 或群消息，保留发送 Bot 的身份和原始回复关系；MCP 不冒充该 Bot。

开发时在 [操作契约](../center-contract/operations/index.js) 注册名称和 schema，在 [Center 操作服务](../center-server/operations/index.js) 提供实现。不要把 owner 路由或 Host RPC 整体暴露为通用工具。详见 [AGENTS.md](../AGENTS.md#内置能力与授权)。
