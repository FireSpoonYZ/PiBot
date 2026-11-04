import { createWebfox, WebfoxError } from 'webfox';
import { buildWebfoxConfig, buildWebfoxEnv, selectedCapabilities } from './webfox-config.js';
import { createWebfoxTools } from './webfox-tools.js';

export function createPlugin({ installationId, dataDir, host }) {
  const bots = new Set();
  return {
    async forBot({ botId, effectiveConfig, credentials }) {
      const config = effectiveConfig ?? {};
      const client = createWebfox({ config: buildWebfoxConfig(config), cwd: dataDir, env: buildWebfoxEnv(config, credentials) });
      const selected = selectedCapabilities(config).map(({ capability, provider, maxResults }) => {
        let inspection;
        try {
          inspection = client.inspectCapability(capability, provider);
        } catch (error) {
          if (error instanceof WebfoxError) {
            throw Object.assign(new Error(
              `Webfox ${capability}/${provider} is not usable: ${error.message}`), { code: 'INVALID_ARGUMENT' });
          }
          throw error;
        }
        if (!inspection.provider) {
          throw Object.assign(new Error(
            `Webfox provider ${provider} does not support ${capability}.`), { code: 'INVALID_ARGUMENT' });
        }
        if (!inspection.configured) {
          throw Object.assign(new Error(
            `Webfox provider ${provider} for ${capability} has no usable credential.`), { code: 'INVALID_ARGUMENT' });
        }
        return { inspection, maxResults };
      });
      let active = false;
      let closed = false;
      const check = () => {
        if (!active || closed) throw Object.assign(new Error('Webfox is not active.'), { code: 'EXTENSION_DISABLED' });
        host.assertCapabilityAllowed(botId, installationId);
      };
      const controller = {
        async run(capability, request, api, context) {
          check();
          if (await host.resolveConversationBot(api.conversationId) !== botId) {
            throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
          }
          check();
          return client[capability](request);
        },
      };
      const bot = {
        durableContributions: { tools: createWebfoxTools(controller, selected, host.sdk.defineTool, dataDir) },
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
