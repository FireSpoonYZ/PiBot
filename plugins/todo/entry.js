// plugins/todo/entry.js
// Native host plugin: per-conversation todo list for enabled Bots. Lifecycle and
// authorization follow plugins/billion-context: the manager wraps contributions
// with runAccepted + conversation ownership checks; this entry adds its own
// active/closed gate and re-checks the per-Bot grant.

import { readFileSync } from 'node:fs';
import { createTodoState, presentation, sectionText } from './todo-state.js';
import { createTodoTool } from './todo-tool.js';

const statusSchema = JSON.parse(readFileSync(new URL('./capability.json', import.meta.url), 'utf8')).actions[0].inputSchema;

export function createPlugin({ installationId, host }) {
  const bots = new Set();
  const { Todos } = createTodoState(host.sdk.defineDoc);

  return {
    async forBot({ botId }) {
      let active = false;
      let closed = false;
      const check = () => {
        if (!active || closed) throw Object.assign(new Error('Todo is not active.'), { code: 'EXTENSION_DISABLED' });
        host.assertCapabilityAllowed(botId, installationId);
      };
      const bot = {
        durableContributions: {
          tools: [createTodoTool({ defineTool: host.sdk.defineTool, installationId, Todos })],
          // 每次模型请求前注入当前列表；无文档或空列表不渲染。
          sections: [host.sdk.section('todo', async (input, renderContext) => {
            const doc = await input.read.snapshot(Todos, input.conversationId, renderContext);
            return sectionText(doc);
          })],
        },
        actions: {
          todoStatus: {
            inputSchema: statusSchema,
            async execute(input, invocationContext) {
              check();
              invocationContext.abortSignal.throwIfAborted();
              const harness = host.getHarness();
              let nativeId;
              let conversationId = null;
              if (input.scopeId !== undefined) {
                const { binding } = await host.getWorkContexts().resolveWorkContext(botId, input.scopeId);
                nativeId = binding?.nativeId;
                conversationId = binding?.conversationId ?? null;
              } else {
                const botRecord = host.host.getBot(botId);
                const index = await harness.snapshot(host.documents.PrimaryIndex, host.context);
                nativeId = index?.byPrimary?.[botRecord.primaryConversationId];
                conversationId = botRecord.primaryConversationId;
              }
              const doc = nativeId === undefined
                ? undefined
                : await harness.snapshot(Todos, nativeId, host.context);
              invocationContext.abortSignal.throwIfAborted();
              check();
              return {
                botId,
                conversationId,
                ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
                presentation: presentation(installationId, doc),
              };
            },
          },
        },
        async prepare() {},
        async activate() { host.assertCapabilityAllowed(botId, installationId); active = true; },
        async quiesce() { active = false; closed = true; },
        async close() { await bot.quiesce(); bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map((bot) => bot.close())); },
  };
}
