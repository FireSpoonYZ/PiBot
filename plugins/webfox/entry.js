import { readFileSync } from 'node:fs';
import { renderTextDocument } from './render.js';
import { createWebfox, WebfoxError } from 'webfox';
import { buildWebfoxConfig, buildWebfoxEnv, selectedCapabilities } from './webfox-config.js';
import { createWebfoxTools } from './webfox-tools.js';

const descriptors = JSON.parse(readFileSync(new URL('./capability.json', import.meta.url), 'utf8')).actions;
const failure = (code, message) => Object.assign(new Error(message), { code });

export function createPlugin({ installationId, version, dataDir, host }) {
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
      const actions = Object.fromEntries(descriptors.map(({ id, inputSchema }) => [id, {
        inputSchema,
        async execute(input, context) {
          check();
          context.abortSignal.throwIfAborted();
          if (id === 'readLearningSource') {
            let url;
            try { url = new URL(input.url); } catch { throw failure('INVALID_ARGUMENT', 'Expected an HTTP(S) source URL.'); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                /[\x00-\x20\x7f]/.test(input.url)) {
              throw failure('INVALID_ARGUMENT', 'Source URL must use HTTP(S) without credentials or whitespace.');
            }
            const provider = config.capabilities?.contents?.provider;
            if (!provider) throw failure('CAPABILITY_NOT_CONFIGURED', 'Configure a Webfox contents provider and credential in Center before learning from URLs.');
            let document;
            try {
              document = await client.contents({ provider, urls: [input.url],
                signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(30000)]) });
            } catch {
              context.abortSignal.throwIfAborted();
              throw failure('SOURCE_READ_FAILED', 'Webfox extraction failed; check the contents provider and credential in Center.');
            }
            check();
            context.abortSignal.throwIfAborted();
            if (document.results.length !== 1 || !document.results[0].ok ||
                !document.results[0].value.content?.trim()) {
              throw failure('SOURCE_READ_FAILED', 'Webfox returned no readable content; check provider access in Center.');
            }
            let rendered = renderTextDocument(document);
            for (const secret of Object.values(credentials ?? {})) {
              if (typeof secret === 'string' && secret) rendered = rendered.replaceAll(secret, '[redacted]');
            }
            const bytes = Buffer.from(rendered, 'utf8');
            return { url: input.url, content: new TextDecoder().decode(bytes.subarray(0, 48 * 1024), { stream: true }),
              ...(bytes.length > 48 * 1024 ? { truncated: true } : {}) };
          }
          const capability = config.capabilities?.search?.provider ? 'search'
            : config.capabilities?.contents?.provider ? 'contents' : null;
          if (!capability) throw failure('CAPABILITY_NOT_CONFIGURED', 'Probe needs a configured search or contents provider; answer/research are not probed.');
          const probeConfig = buildWebfoxConfig(config);
          probeConfig.execution = { ...probeConfig.execution, retries: 0, timeoutMs: 10000 };
          const probeClient = createWebfox({ config: probeConfig, cwd: dataDir, env: buildWebfoxEnv(config, credentials) });
          const request = { provider: config.capabilities[capability].provider,
            signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(10000)]) };
          let document;
          try {
            document = capability === 'search'
              ? await probeClient.search({ ...request, queries: ['example.com'], maxResults: 1 })
              : await probeClient.contents({ ...request, urls: ['https://example.com/'] });
          } catch {
            context.abortSignal.throwIfAborted();
            throw failure('PROBE_FAILED', 'Webfox read-only probe failed; check provider credentials/connectivity in Center.');
          }
          check();
          context.abortSignal.throwIfAborted();
          if (document.results.length !== 1 || !document.results[0].ok) {
            throw failure('PROBE_FAILED', 'Webfox read-only probe failed; check provider credentials/connectivity in Center.');
          }
          return { ok: true, version, operation: capability };
        },
      }]));
      const bot = {
        actions,
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
