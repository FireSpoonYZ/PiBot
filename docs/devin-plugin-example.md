# Devin Host 插件示例（伪代码）

这个示例展示如何用 PiBot 原生 Host 插件调用 [Devin Cloud v3](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions)。它只作接入参考，不注册插件，也不修改运行时。

- `devin_start({ prompt })` 提交用户明确指定的任务，立即返回会话 ID、状态和 Devin 链接。它只发送传入的任务文本，不会自动附带 PiBot 的本机仓库或聊天记录。
- `devin_status({ sessionId })` 手动查询当前 PiBot 会话创建的任务，不做后台轮询。Host 重启后，仍可通过之前返回的 Devin 链接查看任务。

打包时，令 `capability.json` 的 `components.host.entry` 指向 `entry.js`、`contributions` 包含 `tools`。Bot 配置提供 `orgId` 和 `apiKeyRef`（`format: "credential-ref"`）；API Key 只存 Center 凭据库。

创建任务可能计费。POST 超时不代表任务未创建；先到 Devin 检查，不要自动重试。

## `plugins/devin/entry.js`

```js
export function createPlugin({ installationId, host }) {
  return {
    async forBot({ botId, effectiveConfig, credentials }) {
      const { orgId, apiKeyRef } = effectiveConfig ?? {};
      const apiKey = credentials?.[apiKeyRef];
      if (typeof orgId !== 'string' || !/^org-[\w-]+$/.test(orgId) ||
          typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey)) {
        throw new Error('请在 Center 设置 Devin orgId 和 API Key 凭据引用');
      }

      const base = 'https://api.devin.ai/v3/organizations/' + orgId + '/sessions';
      let active = false;
      // shortcut: 会话归属只存在内存；若需跨重启查询，再写入 Durable 会话文档。
      const owners = new Map();
      const result = session => ({
        output: [{ type: 'text', text: JSON.stringify(session) }],
      });

      async function request(path, abortSignal, body) {
        if (!active) throw new Error('Devin 插件未启用');
        host.assertCapabilityAllowed(botId, installationId);
        const response = await fetch(base + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([abortSignal, AbortSignal.timeout(15_000)]),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Devin API HTTP ' + response.status);
        const data = await response.json();
        if (typeof data?.session_id !== 'string' || !data.session_id ||
            typeof data.status !== 'string' || typeof data.url !== 'string') {
          throw new Error('Devin API 未返回有效的会话');
        }
        host.assertCapabilityAllowed(botId, installationId);
        return { sessionId: data.session_id, status: data.status, url: data.url };
      }

      const start = host.sdk.defineTool({
        name: 'devin_start',
        description: '只在用户明确要求时，把指定的开发任务交给 Devin。可能计费；超时不要自动重试。',
        parameters: {
          type: 'object',
          properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } },
          required: ['prompt'],
          additionalProperties: false,
        },
        replay: 'unsafe',
        async execute({ prompt }, api, { abortSignal }) {
          const task = prompt.trim();
          if (!task) throw new Error('任务不能为空');
          const session = await request('', abortSignal, { prompt: task });
          owners.set(session.sessionId, api.conversationId);
          return result(session);
        },
      });

      const status = host.sdk.defineTool({
        name: 'devin_status',
        description: '按 sessionId 查询当前 PiBot 会话启动的 Devin 任务。',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string', minLength: 1, maxLength: 128 } },
          required: ['sessionId'],
          additionalProperties: false,
        },
        async execute({ sessionId }, api, { abortSignal }) {
          if (owners.get(sessionId) !== api.conversationId) {
            throw new Error('只能查询当前会话启动的 Devin 任务');
          }
          return result(await request('/' + encodeURIComponent(sessionId), abortSignal));
        },
      });

      return {
        durableContributions: { tools: [start, status] },
        async prepare() {},
        async activate() {
          host.assertCapabilityAllowed(botId, installationId);
          active = true;
        },
        async quiesce() { active = false; },
        async close() { active = false; owners.clear(); },
      };
    },
    async close() {},
  };
}
```
