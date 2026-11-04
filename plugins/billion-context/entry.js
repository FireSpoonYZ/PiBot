import { readFileSync } from 'node:fs';
import { buildCompressSystemPrompt } from 'acp-kernel';
import { createContextState } from './context-state.js';
import { createContextManager, emptyContextStatus } from './context-manager.js';
import { createContextTools } from './context-tools.js';

const statusSchema = JSON.parse(readFileSync(new URL('./capability.json', import.meta.url), 'utf8')).actions[0].inputSchema;

export function createPlugin({ installationId, host }) {
  const bots = new Set();
  const ContextState = createContextState(host.sdk.defineDoc);

  return {
    async forBot({ botId }) {
      const manager = createContextManager({ getHarness: host.getHarness, models: host.models, ContextState });
      let active = false;
      let closed = false;
      const check = () => {
        if (!active || closed) throw Object.assign(new Error('Billion Context is not active.'), { code: 'EXTENSION_DISABLED' });
        host.assertCapabilityAllowed(botId, installationId);
      };
      const controller = Object.fromEntries(['compress', 'decompress', 'search', 'status'].map((method) => [method,
        async (args, api, context) => {
          check();
          if (await host.resolveConversationBot(api.conversationId) !== botId) {
            throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
          }
          check();
          return manager[method](args, api, context);
        },
      ]));
      const bot = {
        durableContributions: {
          tools: createContextTools(controller, host.sdk.defineTool),
          sections: [host.sdk.section('billion-context', () => buildCompressSystemPrompt())],
        },
        requestContributions: {
          async prepareContext(request, api, context) {
            check();
            if (await host.resolveConversationBot(api.conversationId) !== botId) {
              throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
            }
            check();
            return manager.prepare(request, api, context);
          },
        },
        actions: {
          contextStatus: {
            inputSchema: statusSchema,
            async execute(input, invocationContext) {
              check();
              invocationContext.abortSignal.throwIfAborted();
              const harness = host.getHarness();
              let binding;
              let result;
              if (input.scopeId !== undefined) {
                ({ binding } = await host.getWorkContexts().resolveWorkContext(botId, input.scopeId));
                const status = binding ? await manager.inspect(binding.nativeId, host.context) : emptyContextStatus();
                result = { botId, scopeId: input.scopeId, conversationId: binding?.conversationId ?? null, ...status };
              } else {
                const bot = host.host.getBot(botId);
                const index = await harness.snapshot(host.documents.PrimaryIndex, host.context);
                const nativeId = index?.byPrimary[bot.primaryConversationId];
                const status = nativeId === undefined ? emptyContextStatus() : await manager.inspect(nativeId, host.context);
                result = { botId, conversationId: bot.primaryConversationId, ...status };
              }
              invocationContext.abortSignal.throwIfAborted();
              check();
              return result;
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
