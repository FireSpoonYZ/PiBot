import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normalizeHindsightConfig } from './hindsight-client.js';
import { hindsightBankId } from './hindsight-format.js';
import { openHindsightStore } from './hindsight-store.js';
import { createRuntimeHindsight } from './runtime-hindsight.js';
import { createHindsightTools } from './hindsight-tools.js';
import { migrateLegacyHindsight } from './migration.js';
import { createHindsightClient as createPiHindsightClient } from './client/client.js';
import { DEFAULT_CONFIG } from './config/config-defaults.js';
import { merge, normalizeConfig } from './config/config-normalize.js';
import { readConfigFile } from './config/config.js';

const descriptors = JSON.parse(readFileSync(new URL('./capability.json', import.meta.url), 'utf8')).actions;
const WRITE_ACTIONS = new Set(['retainMemory', 'correctMemory', 'retryMemory']);

export function createPlugin({ installationId, dataDir, host }) {
  const bots = new Set();
  const botKey = (botId) => createHash('sha256').update(botId).digest('hex');
  const policyFile = (botId) => join(dataDir, botKey(botId) + '.policy.json');
  const readPolicy = (botId) => existsSync(policyFile(botId))
    ? JSON.parse(readFileSync(policyFile(botId), 'utf8'))
    : { writable: false, floor: host.host.getBotExtensions(botId)?.retentionFloor ?? 0 };
  async function writePolicy(botId, writable) {
    const current = readPolicy(botId);
    const floor = writable && !current.writable
      ? Math.max(current.floor, await host.getBotEntryWatermark(botId)) : current.floor;
    const next = { writable, floor };
    mkdirSync(dataDir, { recursive: true });
    const path = policyFile(botId);
    const temporary = path + '.tmp';
    writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return next;
  }
  return {
    async onBotPolicyChanged({ botId, enabled }) {
      if (!enabled) await writePolicy(botId, false);
    },
    async forBot({ deviceId, botId, effectiveConfig, credentials }) {
      // projectId 是 topic 的新名称；旧配置仍可能只有 topic，优先 projectId。
      const { baseUrl, apiKeyRef, mode = 'read-write', sharedMemory, agentUse, timeoutMs, reflectTimeoutMs, projectId, topic } = effectiveConfig;
      const effectiveTopic = projectId ?? topic;
      const normalized = normalizeHindsightConfig({ baseUrl, ...(sharedMemory === undefined ? {} : { sharedMemory }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(reflectTimeoutMs === undefined ? {} : { reflectTimeoutMs }),
        ...(effectiveTopic === undefined ? {} : { topic: effectiveTopic }) });
      const apiKey = apiKeyRef === undefined ? undefined : credentials[apiKeyRef];
      if (apiKeyRef !== undefined && (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey))) {
        throw Object.assign(new Error('Hindsight credential is unavailable or invalid.'), { code: 'INVALID_ARGUMENT' });
      }
      const config = { ...normalized, apiKey, timeoutMs: normalized.timeoutMs ?? 30000, reflectTimeoutMs: normalized.reflectTimeoutMs ?? 120000 };
      const botDataDir = join(dataDir, botKey(botId));
      const namespace = 'hindsight_' + createHash('sha256')
        .update(JSON.stringify([installationId, botId])).digest('hex').slice(0, 32);
      let policy = readPolicy(botId);
      let active = false;
      let closed = false;
      const check = () => {
        if (!active || closed) throw Object.assign(new Error('Hindsight is not active.'), { code: 'EXTENSION_DISABLED' });
        host.assertCapabilityAllowed(botId, installationId);
      };
      const getBotPolicy = (id) => {
        if (id !== botId || !active || closed) return { enabled: false, canWrite: false };
        try { host.assertCapabilityAllowed(botId, installationId); } catch { return { enabled: false, canWrite: false }; }
        return { enabled: true, canRead: true, canWrite: mode === 'read-write', mode, retentionFloor: policy.floor };
      };
      const localHost = Object.create(host.host);
      Object.defineProperty(localHost, 'dataRoot', { value: botDataDir });
      const memory = createRuntimeHindsight({ host: localHost, getHarness: host.getHarness,
        getWorkContexts: host.getWorkContexts, getWorkActivity: host.getWorkActivity,
        context: host.context, documents: host.documents, countMessageTokens: host.countMessageTokens,
        tryRunBackgroundTask: (id, task) => host.tryRunBackgroundTask(id, task), config, getBotPolicy });
      const projectBankId = hindsightBankId(deviceId, botId, { kind: 'primary' }, config.topic);
      const sharedBankId = hindsightBankId(deviceId, botId, { kind: 'shared' }, config.topic);
      const buildPiConfig = (cwd = botDataDir) => {
        const diskCfg = readConfigFile(join(cwd, '.pi', 'hindsight'));
        const patch = {
          enabled: true,
          setupComplete: Boolean(config.baseUrl),
          ...(agentUse === undefined ? {} : { agentUse }),
          ...(config.topic ? { scope: { projectId: config.topic } } : {}),
          hindsight: {
            baseUrl: config.baseUrl,
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
            timeoutMs: config.timeoutMs,
          },
          banks: {
            project: {
              enabled: true,
              bankId: projectBankId,
              derive: 'manual',
            },
            user: {
              enabled: Boolean(config.sharedMemory),
              ...(config.sharedMemory ? { bankId: sharedBankId } : {}),
            },
          },
        };
        const merged = merge(merge({}, DEFAULT_CONFIG), merge(diskCfg || {}, patch));
        return normalizeConfig(merged, merged, process.env);
      };
      let piConfig = buildPiConfig(botDataDir);
      let piClient = createPiHindsightClient(piConfig);
      const piDeps = {
        getClient: () => piClient,
        getConfig: () => piConfig,
        getProjectBankId: () => projectBankId,
        getInitHealth: () => ({ ok: true }),
        reloadConfig: (cwd = botDataDir) => {
          piConfig = buildPiConfig(cwd);
          piClient = createPiHindsightClient(piConfig);
        },
      };
      const controller = {
        piDeps,
        botDataDir,
        async fromTool(api, context, operation, input) {
          check();
          if (await host.resolveConversationBot(api.conversationId) !== botId) {
            throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
          }
          check();
          return memory.fromTool(api, context, operation, input);
        },
        async runPiTool(api, _context, isWrite, runFn) {
          check();
          if (await host.resolveConversationBot(api.conversationId) !== botId) {
            throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
          }
          check();
          if (isWrite && mode !== 'read-write') {
            throw Object.assign(new Error('Hindsight is read-only.'), { code: 'EXTENSION_READ_ONLY' });
          }
          return await runFn();
        },
      };
      const actions = Object.fromEntries(descriptors.map(({ id, inputSchema }) => [id, {
        inputSchema,
        async execute(input, invocationContext) {
          check();
          if (WRITE_ACTIONS.has(id) && mode !== 'read-write') {
            throw Object.assign(new Error('Hindsight is read-only.'), { code: 'EXTENSION_READ_ONLY' });
          }
          return id === 'retainMemory' || id === 'correctMemory'
            ? memory[id](botId, input, undefined, invocationContext)
            : memory[id](botId, input, invocationContext);
        },
      }]));
      const bot = {
        durableContributions: { tools: createHindsightTools(controller, host.sdk.defineTool, namespace) },
        requestContributions: {
          async beforeRequest(request, api, context) {
            check();
            if (await host.resolveConversationBot(api.conversationId) !== botId) return undefined;
            check();
            return memory.beforeRequest(request, api, context);
          },
        },
        actions,
        async prepare() {
          await migrateLegacyHindsight({ legacyDataRoot: host.host.dataRoot, dataDir: botDataDir, deviceId, botId,
            endpoint: config.baseUrl, initializeTarget: (tempDataDir) => {
              const endpointHash = createHash('sha256').update(config.baseUrl).digest('hex');
              openHindsightStore({ dataRoot: tempDataDir, deviceId, endpointHash }).close();
            } });
        },
        async onPolicyChanged({ enabled, effectiveConfig: nextConfig }) {
          const writable = enabled && (nextConfig?.mode ?? 'read-write') === 'read-write';
          policy = await writePolicy(botId, writable);
        },
        async activate() { host.assertCapabilityAllowed(botId, installationId); active = true; memory.resume(); },
        async quiesce() { active = false; closed = true; await memory.quiesce(); },
        async close() { await bot.quiesce(); await memory.close(); bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map(bot => bot.close())); },
  };
}
