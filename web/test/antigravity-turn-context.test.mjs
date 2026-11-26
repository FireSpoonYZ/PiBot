import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGY_HISTORY_CHANGED,
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
} from '../../center-contract/antigravity.js';
import { buildThinkingProfile, resolveSessionThoughtLevel } from '../../center-server/antigravity/catalog.ts';
import { AntigravityCursorDoc } from '../../host-core/antigravity-runner.js';
import { openHost } from '../../host-core/host.js';
import { openRuntime } from '../../host-core/runtime.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { DurableWaitIndex } from '../../host-core/runtime-waits.js';
import { apply as applyDelta } from '../../host-core/node_modules/@earendil-works/chord/dist/delta/index.js';
import {
  LiveDoc,
  ProviderDoc,
  UsageDoc,
} from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';
import { registerApiProvider } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/compat.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const MODEL_ID = 'gemini-3-pro';
const SECOND_MODEL_ID = 'second-model';
const MODEL_REF = `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}`;
const SECOND_MODEL_REF = `${ANTIGRAVITY_PROVIDER_ID}/${SECOND_MODEL_ID}`;
const USER_ORIGIN = { sender: { kind: 'user' }, replyTo: null };
const BASE_MODEL_SEL = { modelRef: MODEL_REF, thinkingLevel: 'off', codemode: false, codemodeOnly: false };
const PENDING_STATUSES = new Set(['queued', 'placed', 'running', 'pending', 'admitted']);

const hindsightRoot = fileURLToPath(new URL('../../plugins/hindsight/', import.meta.url));
const hindsightManifest = JSON.parse(fs.readFileSync(path.join(hindsightRoot, 'capability.json'), 'utf8'));
const questionnaireRoot = fileURLToPath(new URL('../../plugins/ask-user-question/', import.meta.url));
const questionnaireManifest = JSON.parse(fs.readFileSync(path.join(questionnaireRoot, 'capability.json'), 'utf8'));

test('ACP uses the selected model’s current thinking options for xhigh', () => {
  const thoughtOption = (...values) => ({ id: 'thought_level', options: values.map((value) => ({ value })) });
  const neon = thoughtOption('low', 'medium', 'high', 'xhigh');
  const argon = thoughtOption('low', 'medium', 'high');
  assert.equal(buildThinkingProfile(neon).thinkingLevelMap.xhigh, 'xhigh');
  assert.equal(buildThinkingProfile(argon).thinkingLevelMap.xhigh, null);
  assert.equal(resolveSessionThoughtLevel('xhigh', [neon]), 'xhigh');
  assert.equal(resolveSessionThoughtLevel('xhigh', [argon]), 'high');
  assert.equal(resolveSessionThoughtLevel('xhigh', [{ id: 'model' }]), undefined);
  assert.equal(resolveSessionThoughtLevel('xhigh', undefined), 'xhigh');
});

async function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function docKind(docOrKind) {
  return typeof docOrKind === 'string' ? docOrKind : (docOrKind?.definition?.kind ?? docOrKind?.kind);
}

function readDurableDoc(durableDbPath, kindOrDoc, scopeKind, ownerId = 0, key = undefined) {
  const kind = docKind(kindOrDoc);
  const db = new DatabaseSync(durableDbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT id FROM documents
         WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
           AND retired_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(JSON.stringify(kind), scopeKind, ownerId, key === undefined ? 0 : 1, JSON.stringify(key ?? ''));
    if (!row) return null;
    const base = db
      .prepare(
        `SELECT seq, content FROM document_revisions
         WHERE document_id = ? AND kind = 'base'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(row.id);
    if (!base) return null;
    let value = JSON.parse(base.content);
    const deltas = db
      .prepare(
        `SELECT seq, content FROM document_revisions
         WHERE document_id = ? AND kind = 'delta' AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(row.id, base.seq);
    for (const delta of deltas) {
      value = applyDelta(value, JSON.parse(delta.content));
    }
    return value;
  } finally {
    db.close();
  }
}

function readDurableTasks(durableDbPath, conversationId = null) {
  const db = new DatabaseSync(durableDbPath, { readOnly: true });
  try {
    const rows =
      conversationId === null
        ? db.prepare('SELECT id, conversation_id, status, record FROM tasks ORDER BY id ASC').all()
        : db
            .prepare('SELECT id, conversation_id, status, record FROM tasks WHERE conversation_id = ? ORDER BY id ASC')
            .all(conversationId);
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status,
      record: JSON.parse(row.record),
    }));
  } finally {
    db.close();
  }
}

function getPrimaryNativeId(durableDbPath, primaryConversationId) {
  const index = readDurableDoc(durableDbPath, PrimaryIndex.definition.kind, 'session', 0);
  return index?.byPrimary?.[primaryConversationId] ?? null;
}

function makeCapability(installationId, effectiveConfig, { targetVersion = '1.0.0', revision = 1 } = {}) {
  return {
    installationId,
    kind: 'plugin',
    target: 'host',
    targetVersion,
    enabled: true,
    authorized: true,
    revision,
    effectiveConfig,
    credentialRefs: [],
  };
}

function writeTestPlugins(rootDir) {
  const pluginDir = path.join(rootDir, 'plugins', 'test-agy-suite');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'entry.mjs'),
    `import fs from 'node:fs';
const PNG_1X1 = ${JSON.stringify(PNG_1X1)};

export function createPlugin({ host }) {
  const bots = new Set();
  return {
    async forBot({ effectiveConfig: cfg }) {
      const record = (event) => {
        if (cfg?.recordFile) fs.appendFileSync(cfg.recordFile, event + '\\n');
      };
      const getHook = () => (cfg?.hookKey ? globalThis[cfg.hookKey] : null);
      record('forBot');

      const tools = [];
      if (cfg?.enableProbeTool) {
        tools.push(host.sdk.defineTool({
          name: cfg?.toolName ?? 'ping_probe_tool',
          description: 'Deferred probe tool.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
          replay: 'safe',
          deferred: true,
          async execute(args) {
            return { output: [{ type: 'text', text: 'probe:' + String(args?.query ?? '') }] };
          },
        }));
      }
      if (cfg?.enableModelOnlyImageProbe) {
        tools.push(host.sdk.defineTool({
          name: 'model_only_image_probe',
          description: 'Model-only probe returning text and an image.',
          parameters: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
            additionalProperties: false,
          },
          callers: ['model'],
          deferred: true,
          replay: 'safe',
          async execute(args) {
            return {
              output: [
                { type: 'text', text: 'image-probe:' + String(args?.label ?? '') },
                { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
              ],
            };
          },
        }));
      }
      if (cfg?.enableModelOnlyProbe) {
        tools.push(host.sdk.defineTool({
          name: 'model_only_probe',
          description: 'Model-only probe with optional test gate.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          callers: ['model'],
          deferred: true,
          replay: 'safe',
          async execute(_args, _api, context) {
            const h = getHook();
            h?.onProbeStart?.();
            if (h?.waitProbeRelease) {
              await h.waitProbeRelease(context.abortSignal);
            }
            return { output: [{ type: 'text', text: 'model-only-ok' }] };
          },
        }));
      }
      if (cfg?.enableSlowBlockingTool) {
        tools.push(host.sdk.defineTool({
          name: 'slow_blocking_tool',
          description: 'Blocks until aborted or released by the test.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          callers: ['model'],
          deferred: true,
          replay: 'unsafe',
          async execute(_args, _api, context) {
            const h = getHook();
            h?.onSlowStart?.();
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                h?.onSlowAborted?.();
                const err = new Error('slow tool aborted');
                err.name = 'AbortError';
                reject(err);
              };
              if (context.abortSignal?.aborted) return onAbort();
              context.abortSignal?.addEventListener('abort', onAbort, { once: true });
              h?.releaseSlow?.then?.(resolve);
            });
            return { output: [{ type: 'text', text: 'slow-done' }] };
          },
        }));
      }

      const hooks = [];
      if (cfg?.observeToolHooks) {
        hooks.push(host.sdk.hook(host.sdk.ToolTask, {
          beforeTool(call) {
            getHook()?.onToolHook?.('beforeTool', call?.name ?? null);
          },
          afterTool(call) {
            getHook()?.onToolHook?.('afterTool', call?.name ?? null);
          },
        }));
      }

      const requestContributions = cfg?.enablePrepareContext
        ? {
            async prepareContext(request) {
              record('prepareContext');
              return request;
            },
          }
        : undefined;

      const bot = {
        durableContributions: {
          ...(tools.length > 0 ? { tools } : {}),
          ...(hooks.length > 0 ? { hooks } : {}),
        },
        ...(requestContributions ? { requestContributions } : {}),
        async prepare() { record('prepare'); },
        async activate() { record('activate'); },
        async quiesce() {},
        async close() { bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map((b) => b.close())); },
  };
}
`,
    'utf8',
  );

  const installed = new Map([
    [
      'test-bc-context',
      {
        version: '1.0.0',
        packageRoot: pluginDir,
        dataDir: path.join(pluginDir, 'bc-data'),
        manifest: { id: 'e-launcher.billion-context', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } },
      },
    ],
    [
      'test-context-rewriter',
      {
        version: '1.0.0',
        packageRoot: pluginDir,
        dataDir: path.join(pluginDir, 'rewriter-data'),
        manifest: { id: 'test.context-rewriter', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } },
      },
    ],
    [
      'test-probe-tools',
      {
        version: '1.0.0',
        packageRoot: pluginDir,
        dataDir: path.join(pluginDir, 'probe-data'),
        manifest: { id: 'test.probe-tools', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } },
      },
    ],
    [
      'test-hook-observer',
      {
        version: '1.0.0',
        packageRoot: pluginDir,
        dataDir: path.join(pluginDir, 'hook-data'),
        manifest: { id: 'test.hook-observer', kind: 'plugin', components: { host: { entry: 'entry.mjs' } } },
      },
    ],
    [
      'test-hindsight-recall',
      {
        version: hindsightManifest.version,
        packageRoot: hindsightRoot,
        dataDir: path.join(rootDir, 'hindsight-data'),
        manifest: hindsightManifest,
      },
    ],
    [
      'test-questionnaire',
      {
        version: questionnaireManifest.version,
        packageRoot: questionnaireRoot,
        dataDir: path.join(rootDir, 'questionnaire-data'),
        manifest: questionnaireManifest,
      },
    ],
  ]);

  return {
    async getInstalled(id, opts) {
      const entry = installed.get(id);
      return !entry || (opts?.version && entry.version !== opts.version) ? null : entry;
    },
  };
}

async function openTestRuntime({
  rootDir,
  antigravityClient,
  fixtureApi = null,
  webhookHooks = null,
}) {
  const installer = writeTestPlugins(rootDir);
  const hostDataRoot = path.join(rootDir, 'host-data');
  const meta = openHost({ dataRoot: hostDataRoot });
  const deviceId = meta.deviceId;
  meta.close();

  const durableDbPath = path.join(hostDataRoot, 'durable.sqlite');
  let currentSnapshot = null;

  const centerClient = {
    antigravity: antigravityClient,
    providerAuth: async () => ({ auth: { apiKey: 'center-managed' }, source: 'center' }),
    pollWebhookEvents: webhookHooks?.pollWebhookEvents ?? (async () => ({ items: [], nextCursor: null })),
    reportWebhookEvent: webhookHooks?.reportWebhookEvent ?? (async () => ({ ok: true })),
    stopWebhookEvents: webhookHooks?.stopWebhookEvents ?? (async ({ botId, stopEpoch }) => ({ botId, stopEpoch })),
  };

  const makeSnapshot = (revision, bots) => ({
    protocol: 1,
    deviceId,
    revision,
    providers: [
      {
        id: ANTIGRAVITY_PROVIDER_ID,
        name: 'Antigravity',
        api: ANTIGRAVITY_API,
        baseUrl: '',
        enabled: true,
        credentialRef: null,
        native: true,
        authMode: 'oauth',
      },
      ...(fixtureApi
        ? [
            {
              id: 'fixture',
              name: 'Fixture',
              api: fixtureApi,
              baseUrl: 'http://127.0.0.1:9',
              enabled: true,
              credentialRef: null,
            },
          ]
        : []),
    ],
    models: {
      [ANTIGRAVITY_PROVIDER_ID]: [MODEL_ID, SECOND_MODEL_ID].map((id) => ({
        id,
        name: id,
        api: ANTIGRAVITY_API,
        contextWindow: 128_000,
        maxTokens: 8_192,
        input: ['text', 'image'],
        reasoning: true,
        enabled: true,
        revision: 1,
      })),
      ...(fixtureApi
        ? {
            fixture: [
              {
                id: 'model',
                name: 'Fixture',
                api: fixtureApi,
                contextWindow: 128_000,
                maxTokens: 4096,
                input: ['text'],
                reasoning: false,
                enabled: true,
                revision: 1,
              },
            ],
          }
        : {}),
    },
    credentials: {},
    bots,
  });

  const runtime = await openRuntime({
    dataRoot: hostDataRoot,
    nativeBridge: async () => ({}),
    centerRuntime: {
      snapshot: { protocol: 1 },
      installer,
      getClient: () => centerClient,
      prepareTurn: async () => ({ setId: `set-rev-${currentSnapshot.revision}`, snapshot: currentSnapshot }),
      confirmTurn: async ({ requestId, setId }) => ({ admissionId: `adm-${requestId}`, setId }),
      restoreTurn: async () => ({ setId: `set-rev-${currentSnapshot.revision}`, snapshot: currentSnapshot }),
    },
  });

  const applySnapshot = async (snapshot) => {
    currentSnapshot = snapshot;
    await waitUntil(
      async () => {
        const res = await runtime.applyCenterSnapshot(snapshot);
        if (res.status === 'failed') {
          throw new Error(`applyCenterSnapshot failed: ${JSON.stringify(res)}`);
        }
        return res.status === 'applied';
      },
      { label: `applyCenterSnapshot rev=${snapshot.revision}` },
    );
  };

  const waitForSubmission = (botId, requestId) =>
    waitUntil(
      async () => {
        const sub = await runtime.getSubmission(botId, requestId);
        return sub && !PENDING_STATUSES.has(sub.status) ? sub : null;
      },
      { label: `submission ${requestId}` },
    );

  try {
    await applySnapshot(makeSnapshot(1, []));
    await runtime.setCenterOnline(true);
    await runtime.restoreTurns();
    runtime.resume();
    return { runtime, deviceId, durableDbPath, makeSnapshot, applySnapshot, waitForSubmission };
  } catch (err) {
    try {
      await runtime.close();
    } catch {
      /* preserve startup error */
    }
    throw err;
  }
}

test('Real ToolTask executes model-only image tools and codemode, records final usage once, and keeps tool declarations stable', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-tools-usage-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const runCalls = [];
  const toolResultCalls = [];
  const toolResultResolvers = new Map();

  const antigravityClient = {
    run(payload) {
      const cloned = JSON.parse(JSON.stringify(payload));
      runCalls.push(cloned);
      const turnNumber = runCalls.length;
      return (async function* () {
        if (turnNumber === 1) {
          yield { type: 'text_delta', delta: 'Inspecting image and running code.' };

          const waitImg = Promise.withResolvers();
          toolResultResolvers.set('tc-img-1', waitImg);
          yield {
            type: 'tool_request',
            callId: 'tc-img-1',
            name: 'model_only_image_probe',
            args: { label: 'shot-1' },
          };
          const imgRes = await waitImg.promise;
          assert.equal(imgRes.isError, false);
          assert.deepEqual(imgRes.content, [
            { type: 'text', text: 'image-probe:shot-1' },
            { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
          ]);

          const waitCode = Promise.withResolvers();
          toolResultResolvers.set('tc-code-1', waitCode);
          yield {
            type: 'tool_request',
            callId: 'tc-code-1',
            name: 'codemode',
            args: {
              code: `
                if ((await searchTools("model_only_image_probe", { limit: 20 })).some(t => t.name === "model_only_image_probe")) {
                  throw new Error("model-only tool leaked into codemode");
                }
                const [probe] = await searchTools("ping_probe_tool", { limit: 1 });
                if (probe?.name !== "ping_probe_tool") throw new Error("missing deferred ping_probe_tool");
                text(await tools[probe.name]({ query: "native-turn" }));
              `,
            },
          };
          const codeRes = await waitCode.promise;
          assert.equal(codeRes.isError, false, JSON.stringify(codeRes));
          assert.match(JSON.stringify(codeRes.content), /probe:native-turn/);

          yield { type: 'text_delta', delta: 'FINAL_TOOL_ANSWER' };
          yield {
            type: 'turn_done',
            conversationId: 'native-conv-tools-1',
            usage: { input: 320, output: 80, cacheRead: 10, cacheWrite: 5, totalTokens: 415 },
          };
        } else {
          yield { type: 'text_delta', delta: 'SECOND_TURN_STABLE' };
          yield {
            type: 'turn_done',
            conversationId: 'native-conv-tools-1',
            usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50 },
          };
        }
      })();
    },
    async toolResult(payload) {
      const cloned = JSON.parse(JSON.stringify(payload));
      toolResultCalls.push(cloned);
      toolResultResolvers.get(cloned.callId)?.resolve(cloned);
      return { ok: true };
    },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openTestRuntime({ rootDir, antigravityClient });
    const bot = await env.runtime.createBot({ requestId: 'tools-bot', role: 'Tools Usage', cwd, makePrimary: true });
    await env.applySnapshot(
      env.makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd,
          model: BASE_MODEL_SEL,
          capabilities: [
            makeCapability('test-probe-tools', {
              enableProbeTool: true,
              enableModelOnlyImageProbe: true,
            }),
          ],
        },
      ]),
    );

    await env.runtime.submit(bot.botId, { requestId: 'tools-t1', text: 'Run image probe and codemode', origin: USER_ORIGIN });
    const receipt1 = await env.waitForSubmission(bot.botId, 'tools-t1');
    assert.equal(receipt1.status, 'done', JSON.stringify(receipt1));
    assert.equal(receipt1.answerText, 'FINAL_TOOL_ANSWER');

    assert.equal(runCalls.length, 1, 'entire multi-tool turn runs inside one /run stream');
    assert.equal(toolResultCalls.length, 2);

    // Outer tools: codemode + model-only tools only; deferred non-model-only tools stay inside codemode.
    const declaredNames = runCalls[0].tools.map((t) => t.name);
    assert.ok(declaredNames.includes('codemode'));
    assert.ok(declaredNames.includes('model_only_image_probe'));
    assert.equal(declaredNames.includes('ping_probe_tool'), false);
    assert.equal(declaredNames.includes('tool_search'), false);

    // Real ToolTasks created with abandonOnRestart: true (model-issued calls; codemode also spawns nested ToolTask).
    const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
    const allToolTasks = readDurableTasks(env.durableDbPath, nativeId).filter((t) => t.record.kind === 'pi.tool');
    const modelToolTasks = allToolTasks.filter((t) => t.record.input?.kind === 'model');
    assert.equal(modelToolTasks.length, 2);
    assert.ok(allToolTasks.some((t) => t.record.input?.kind === 'nested'), 'codemode should spawn nested ToolTask for ping_probe_tool');
    for (const task of modelToolTasks) {
      assert.equal(task.record.abandonOnRestart, true);
      assert.equal(task.status, 'terminal');
    }

    // Intermediate AssistantEntry records have zero usage; final answer records turn_done usage once.
    const history = await env.runtime.history(bot.botId, { limit: 50 });
    const assistants = history.items.flatMap((entry) => entry.model ?? []).filter((msg) => msg?.role === 'assistant');
    const intermediate = assistants.filter((msg) => msg.stopReason === 'toolUse');
    const finals = assistants.filter((msg) => msg.stopReason === 'stop');
    assert.equal(intermediate.length, 2);
    assert.equal(finals.length, 1);
    for (const msg of intermediate) {
      assert.equal(msg.usage.input, 0);
      assert.equal(msg.usage.output, 0);
      assert.equal(msg.usage.totalTokens, 0);
    }
    assert.equal(finals[0].usage.input, 320);
    assert.equal(finals[0].usage.output, 80);
    assert.equal(finals[0].usage.cacheRead, 10);
    assert.equal(finals[0].usage.cacheWrite, 5);
    assert.equal(finals[0].usage.totalTokens, 415);

    const usageDoc = readDurableDoc(env.durableDbPath, UsageDoc, 'conversation', nativeId);
    const modelBuckets = Object.values(usageDoc?.models ?? {});
    assert.equal(modelBuckets.length, 1);
    assert.equal(modelBuckets[0].input, 320);
    assert.equal(modelBuckets[0].output, 80);
    assert.equal(modelBuckets[0].cacheRead, 10);
    assert.equal(modelBuckets[0].cacheWrite, 5);
    assert.equal(modelBuckets[0].totalTokens, 415);

    // Turn 2 keeps identical stable tool declarations.
    await env.runtime.submit(bot.botId, { requestId: 'tools-t2', text: 'Follow up', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'tools-t2')).status, 'done');
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, runCalls[0].sessionId);
    assert.deepEqual(runCalls[1].tools, runCalls[0].tools);
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Non-bridge native_tool_start/native_tool_end projects live.tools and history without ToolTask or tool hooks', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-native-tool-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const hookKey = `__agy_native_tool_hook_${path.basename(rootDir)}`;
  const hookEvents = [];
  globalThis[hookKey] = {
    onToolHook(phase, name) {
      hookEvents.push({ phase, name });
    },
  };

  const releaseNativeToolEnd = Promise.withResolvers();
  const toolResultCalls = [];
  const antigravityClient = {
    run() {
      return (async function* () {
        yield {
          type: 'native_tool_start',
          toolCallId: 'res-1',
          name: 'read_resource',
          args: { uri: 'file:///demo/spec.md' },
        };
        await releaseNativeToolEnd.promise;
        yield {
          type: 'native_tool_end',
          toolCallId: 'res-1',
          name: 'read_resource',
          args: { uri: 'file:///demo/spec.md' },
          output: 'NATIVE_RESOURCE_BODY_77',
          isError: false,
        };
        yield { type: 'text_delta', delta: 'Read complete.' };
        yield { type: 'turn_done', usage: { input: 20, output: 10, totalTokens: 30 } };
      })();
    },
    async toolResult(payload) {
      toolResultCalls.push(payload);
      return { ok: true };
    },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  let watch;
  try {
    env = await openTestRuntime({ rootDir, antigravityClient });
    const bot = await env.runtime.createBot({ requestId: 'native-tool-bot', role: 'Native Tool', cwd, makePrimary: true });
    await env.applySnapshot(
      env.makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd,
          model: BASE_MODEL_SEL,
          capabilities: [makeCapability('test-hook-observer', { observeToolHooks: true, hookKey })],
        },
      ]),
    );

    watch = await env.runtime.watch(bot.botId);
    watch.start(() => {});

    await env.runtime.submit(bot.botId, { requestId: 'native-t1', text: 'Read resource natively', origin: USER_ORIGIN });

    // Observe running slot projected in live.tools before native_tool_end arrives.
    const liveSlot = await waitUntil(
      () =>
        watch.value.state.tools.find(
          (slot) => slot.callId === 'agy-native:res-1' && slot.name === 'read_resource' && slot.status === 'running',
        ),
      { label: 'native_tool_start projection in live.tools' },
    );
    assert.equal(liveSlot.callId, 'agy-native:res-1');
    assert.equal(liveSlot.name, 'read_resource');
    assert.equal(liveSlot.status, 'running');

    releaseNativeToolEnd.resolve();
    const receipt = await env.waitForSubmission(bot.botId, 'native-t1');
    assert.equal(receipt.status, 'done', JSON.stringify(receipt));

    await waitUntil(() => watch.value.state.tools.length === 0, { label: 'live.tools cleared after native_tool_end' });

    // History projects both the synthetic toolCall and toolResult.
    const historyMsgs = (await env.runtime.history(bot.botId, { limit: 30 })).items.flatMap((e) => e.model ?? []);
    const callBlock = historyMsgs
      .filter((m) => m?.role === 'assistant')
      .flatMap((m) => m.content ?? [])
      .find((b) => b?.type === 'toolCall' && b.id === 'agy-native:res-1');
    assert.ok(callBlock);
    assert.equal(callBlock.name, 'read_resource');
    assert.deepEqual(callBlock.arguments, { uri: 'file:///demo/spec.md' });

    const resMsg = historyMsgs.find((m) => m?.role === 'toolResult' && m.toolCallId === 'agy-native:res-1');
    assert.ok(resMsg);
    assert.equal(resMsg.isError, false);
    assert.match(JSON.stringify(resMsg.content), /NATIVE_RESOURCE_BODY_77/);

    // No ToolTask created, no toolResult callback, and no ToolTask hooks fired.
    const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
    const toolTasks = readDurableTasks(env.durableDbPath, nativeId).filter((t) => t.record.kind === 'pi.tool');
    assert.equal(toolTasks.length, 0);
    assert.equal(toolResultCalls.length, 0);
    assert.deepEqual(hookEvents, []);
  } finally {
    delete globalThis[hookKey];
    try {
      await watch?.stop();
    } catch {
      /* ignore watch close */
    }
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Real-time steer advances cursor and settles with active run while followUp queues; 409 INVALID_STATE rolls back cursor and retries as next turn', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-steer-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const runCalls = [];
  const steerCalls = [];
  const run1Started = Promise.withResolvers();
  const releaseRun1 = Promise.withResolvers();
  const run3Started = Promise.withResolvers();
  const releaseRun3 = Promise.withResolvers();
  const steerAcceptedObserved = Promise.withResolvers();

  let env;
  let bot;
  let steerMode = 'accept';
  let cursorAtAcceptedSteer = null;
  let liveAtAcceptedSteer = null;
  let cursorAtRejectedSteer = null;

  const waitOrAbort = (promise, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });

  const antigravityClient = {
    run(payload, opts) {
      const cloned = JSON.parse(JSON.stringify(payload));
      runCalls.push(cloned);
      const turn = runCalls.length;
      return (async function* () {
        if (turn === 1) {
          run1Started.resolve();
          await waitOrAbort(releaseRun1.promise, opts?.signal);
          yield { type: 'text_delta', delta: 'TURN_1_SETTLED_WITH_STEER' };
          yield { type: 'turn_done', usage: { input: 30, output: 10, totalTokens: 40 } };
        } else if (turn === 2) {
          yield { type: 'text_delta', delta: 'TURN_2_FOLLOWUP_DONE' };
          yield { type: 'turn_done', usage: { input: 15, output: 5, totalTokens: 20 } };
        } else if (turn === 3) {
          run3Started.resolve();
          await waitOrAbort(releaseRun3.promise, opts?.signal);
          yield { type: 'text_delta', delta: 'TURN_3_ORIGINAL_DONE' };
          yield { type: 'turn_done', usage: { input: 20, output: 5, totalTokens: 25 } };
        } else {
          yield { type: 'text_delta', delta: 'TURN_4_RECOVERED_STEER' };
          yield { type: 'turn_done', usage: { input: 25, output: 8, totalTokens: 33 } };
        }
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer(payload) {
      const cloned = JSON.parse(JSON.stringify(payload));
      steerCalls.push(cloned);
      const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
      if (steerMode === 'accept') {
        cursorAtAcceptedSteer = readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId);
        liveAtAcceptedSteer = readDurableDoc(env.durableDbPath, LiveDoc, 'conversation', nativeId);
        steerAcceptedObserved.resolve();
        return { ok: true };
      }
      cursorAtRejectedSteer = readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId);
      throw Object.assign(new Error('Run already finishing'), { statusCode: 409, code: 'INVALID_STATE' });
    },
    async cancel() { return { ok: true }; },
  };

  try {
    env = await openTestRuntime({ rootDir, antigravityClient });
    bot = await env.runtime.createBot({ requestId: 'steer-bot', role: 'Steer Test', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));

    // Part A: Active Turn 1 receives queued followUp + real-time steer.
    await env.runtime.submit(bot.botId, { requestId: 'turn-1', text: 'Initial long turn', origin: USER_ORIGIN });
    await run1Started.promise;

    const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
    const cursorAtRun1Start = readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId);
    assert.ok(cursorAtRun1Start?.dispatchedThrough > 0);

    await env.runtime.submit(bot.botId, {
      requestId: 'followup-1',
      text: 'Queued followUp message',
      delivery: 'followUp',
      origin: USER_ORIGIN,
    });
    await env.runtime.submit(bot.botId, {
      requestId: 'steer-1',
      text: 'Urgent mid-turn steer',
      delivery: 'steer',
      origin: USER_ORIGIN,
    });

    await steerAcceptedObserved.promise;
    assert.equal(steerCalls.length, 1);
    assert.equal(steerCalls[0].sessionId, runCalls[0].sessionId);
    assert.equal(steerCalls[0].runId, runCalls[0].runId);
    assert.deepEqual(steerCalls[0].inputs, [{ text: 'Urgent mid-turn steer' }]);
    assert.ok(
      cursorAtAcceptedSteer.dispatchedThrough > cursorAtRun1Start.dispatchedThrough,
      'cursor must advance durably BEFORE antigravityClient.steer is invoked',
    );
    assert.equal(liveAtAcceptedSteer?.run?.inputs?.length, 2, 'steer submission must join live.run.inputs');
    assert.equal(runCalls.length, 1, 'followUp must stay queued until turn 1 ends');

    releaseRun1.resolve();
    const [rTurn1, rSteer1, rFollowUp1] = await Promise.all([
      env.waitForSubmission(bot.botId, 'turn-1'),
      env.waitForSubmission(bot.botId, 'steer-1'),
      env.waitForSubmission(bot.botId, 'followup-1'),
    ]);
    assert.equal(rTurn1.status, 'done');
    assert.equal(rTurn1.answerText, 'TURN_1_SETTLED_WITH_STEER');
    assert.equal(rSteer1.status, 'done');
    assert.equal(rSteer1.answerText, 'TURN_1_SETTLED_WITH_STEER');
    assert.equal(rFollowUp1.status, 'done');
    assert.equal(rFollowUp1.answerText, 'TURN_2_FOLLOWUP_DONE');
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, runCalls[0].sessionId);
    assert.deepEqual(runCalls[1].inputs, [{ text: 'Queued followUp message' }]);

    // Part B: Center returns 409 INVALID_STATE for steer -> cursor rolls back and message runs as next turn without loss.
    steerMode = 'reject-409';
    await env.runtime.submit(bot.botId, { requestId: 'turn-3', text: 'Turn racing with steer', origin: USER_ORIGIN });
    await run3Started.promise;

    const cursorBeforeRace = readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId);
    await env.runtime.submit(bot.botId, {
      requestId: 'steer-race',
      text: 'Late steer during finish race',
      delivery: 'steer',
      origin: USER_ORIGIN,
    });

    await waitUntil(
      () => {
        if (steerCalls.length < 2) return false;
        const cur = readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId);
        return cur?.dispatchedThrough === cursorBeforeRace.dispatchedThrough;
      },
      { label: 'cursor rollback after 409 INVALID_STATE steer rejection' },
    );
    assert.ok(
      cursorAtRejectedSteer?.dispatchedThrough > cursorBeforeRace.dispatchedThrough,
      'steer must advance cursor before Center call and roll it back on 409 INVALID_STATE',
    );

    releaseRun3.resolve();
    const [rTurn3, rSteerRace] = await Promise.all([
      env.waitForSubmission(bot.botId, 'turn-3'),
      env.waitForSubmission(bot.botId, 'steer-race'),
    ]);
    assert.equal(rTurn3.status, 'done');
    assert.equal(rTurn3.answerText, 'TURN_3_ORIGINAL_DONE');
    assert.equal(rSteerRace.status, 'done');
    assert.equal(rSteerRace.answerText, 'TURN_4_RECOVERED_STEER');
    assert.equal(runCalls.length, 4);
    assert.equal(runCalls[3].sessionId, runCalls[0].sessionId);
    assert.deepEqual(runCalls[3].inputs, [{ text: 'Late steer during finish race' }]);
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('runtime.abort during active tool cancels local ToolTask and Center run while keeping ProviderDoc.sessionId intact', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-abort-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const hookKey = `__agy_abort_hook_${path.basename(rootDir)}`;
  const slowStarted = Promise.withResolvers();
  let slowAborted = false;
  globalThis[hookKey] = {
    onSlowStart() {
      slowStarted.resolve();
    },
    onSlowAborted() {
      slowAborted = true;
    },
  };

  const runCalls = [];
  const cancelCalls = [];

  const antigravityClient = {
    run(payload, opts) {
      const cloned = JSON.parse(JSON.stringify(payload));
      runCalls.push(cloned);
      const turn = runCalls.length;
      return (async function* () {
        if (turn === 1) {
          yield { type: 'tool_request', callId: 'slow-1', name: 'slow_blocking_tool', args: {} };
          await new Promise((resolve) => {
            if (opts?.signal?.aborted) return resolve();
            opts?.signal?.addEventListener('abort', resolve, { once: true });
          });
        } else {
          yield { type: 'text_delta', delta: 'CONTINUED_SAME_SESSION' };
          yield { type: 'turn_done', usage: { input: 15, output: 5, totalTokens: 20 } };
        }
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer() { return { ok: true }; },
    async cancel(payload) {
      cancelCalls.push(JSON.parse(JSON.stringify(payload)));
      return { ok: true };
    },
  };

  let env;
  try {
    env = await openTestRuntime({ rootDir, antigravityClient });
    const bot = await env.runtime.createBot({ requestId: 'abort-bot', role: 'Abort Test', cwd, makePrimary: true });
    await env.applySnapshot(
      env.makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd,
          model: BASE_MODEL_SEL,
          capabilities: [makeCapability('test-probe-tools', { enableSlowBlockingTool: true, hookKey })],
        },
      ]),
    );

    await env.runtime.submit(bot.botId, { requestId: 'abort-t1', text: 'Start slow tool', origin: USER_ORIGIN });
    await slowStarted.promise;

    const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
    const sessionIdBefore = readDurableDoc(env.durableDbPath, ProviderDoc, 'conversation', nativeId)?.sessionId;
    assert.equal(sessionIdBefore, runCalls[0].sessionId);

    await env.runtime.abort(bot.botId);

    const abortedReceipt = await env.waitForSubmission(bot.botId, 'abort-t1');
    assert.equal(abortedReceipt.status, 'unanswered');
    assert.equal(abortedReceipt.reason, 'aborted');
    assert.equal(slowAborted, true, 'local ToolTask must receive abort signal');
    assert.ok(
      cancelCalls.some((c) => c.sessionId === runCalls[0].sessionId && c.runId === runCalls[0].runId),
      `expected cancel call for active run, got: ${JSON.stringify(cancelCalls)}`,
    );

    const sessionIdAfter = readDurableDoc(env.durableDbPath, ProviderDoc, 'conversation', nativeId)?.sessionId;
    assert.equal(sessionIdAfter, sessionIdBefore, 'abort must preserve ProviderDoc.sessionId');

    await env.runtime.submit(bot.botId, { requestId: 'abort-t2', text: 'Continue after cancel', origin: USER_ORIGIN });
    const nextReceipt = await env.waitForSubmission(bot.botId, 'abort-t2');
    assert.equal(nextReceipt.status, 'done', JSON.stringify(nextReceipt));
    assert.equal(nextReceipt.answerText, 'CONTINUED_SAME_SESSION');
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, sessionIdBefore);
    assert.deepEqual(runCalls[1].inputs, [{ text: 'Continue after cancel' }]);
  } finally {
    delete globalThis[hookKey];
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('ask_user_question creates DurableWait even with concurrent sibling tools in primary chat and terminates immediately on non-primary turns', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-questionnaire-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const hookKey = `__agy_q_hook_${path.basename(rootDir)}`;
  const siblingStarted = Promise.withResolvers();
  const siblingRelease = Promise.withResolvers();
  globalThis[hookKey] = {
    onProbeStart() {
      siblingStarted.resolve();
    },
    waitProbeRelease(signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
        siblingRelease.promise.then(resolve);
      });
    },
  };

  const runCalls = [];
  const toolResultResolvers = new Map();
  const deliveredToolResults = [];

  const antigravityClient = {
    run(payload) {
      const cloned = JSON.parse(JSON.stringify(payload));
      runCalls.push(cloned);
      const turn = runCalls.length;
      return (async function* () {
        if (turn === 1) {
          // Primary chat: sibling tool + ask_user_question concurrently in one turn.
          const waitSibling = Promise.withResolvers();
          const waitQuestion = Promise.withResolvers();
          toolResultResolvers.set('sibling-1', waitSibling);
          toolResultResolvers.set('ask-primary-1', waitQuestion);

          yield { type: 'tool_request', callId: 'sibling-1', name: 'model_only_probe', args: {} };
          await siblingStarted.promise;
          yield {
            type: 'tool_request',
            callId: 'ask-primary-1',
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  header: 'Design',
                  question: 'Pick a finish',
                  options: [
                    { label: 'Copper', description: 'Warm' },
                    { label: 'Steel', description: 'Cool' },
                  ],
                },
              ],
            },
          };

          // ask_user_question must finish and return terminate hint WHILE sibling-1 is still running.
          const qRes = await waitQuestion.promise;
          assert.equal(qRes.isError, false, JSON.stringify(qRes));
          assert.match(JSON.stringify(qRes.content), /End this turn now without further tool calls/);

          siblingRelease.resolve();
          const sibRes = await waitSibling.promise;
          assert.equal(sibRes.isError, false);

          // Spurious post-terminate text must be ignored by finishExternalTerminate (no forged second assistant reply).
          yield { type: 'text_delta', delta: 'FORGED_SECOND_REPLY_MUST_NOT_COMMIT' };
          yield { type: 'turn_done', usage: { input: 20, output: 10, totalTokens: 30 } };
        } else if (turn === 2) {
          yield { type: 'text_delta', delta: 'COPPER_CHOICE_CONFIRMED' };
          yield { type: 'turn_done', usage: { input: 15, output: 5, totalTokens: 20 } };
        } else {
          // Non-primary task_dispatch turn where waits.open returns null.
          const waitNonPrimary = Promise.withResolvers();
          toolResultResolvers.set('ask-nonprimary-1', waitNonPrimary);
          yield {
            type: 'tool_request',
            callId: 'ask-nonprimary-1',
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  header: 'Mode',
                  question: 'Select execution mode',
                  options: [
                    { label: 'Fast', description: 'Quick' },
                    { label: 'Careful', description: 'Thorough' },
                  ],
                },
              ],
            },
          };
          const npRes = await waitNonPrimary.promise;
          assert.equal(npRes.isError, false, JSON.stringify(npRes));
          assert.match(JSON.stringify(npRes.content), /End this turn now/);
          yield { type: 'text_delta', delta: 'IGNORED_NONPRIMARY_AFTER_TERMINATE' };
          yield { type: 'turn_done', usage: { input: 10, output: 5, totalTokens: 15 } };
        }
      })();
    },
    async toolResult(payload) {
      const cloned = JSON.parse(JSON.stringify(payload));
      deliveredToolResults.push(cloned);
      toolResultResolvers.get(cloned.callId)?.resolve(cloned);
      return { ok: true };
    },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openTestRuntime({ rootDir, antigravityClient });
    const bot = await env.runtime.createBot({ requestId: 'q-bot', role: 'Questionnaire', cwd, makePrimary: true });
    await env.applySnapshot(
      env.makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd,
          model: BASE_MODEL_SEL,
          capabilities: [
            makeCapability('test-probe-tools', { enableModelOnlyProbe: true, hookKey }),
            makeCapability('test-questionnaire', {}, { targetVersion: questionnaireManifest.version }),
          ],
        },
      ]),
    );

    // Part A: Primary chat with concurrent sibling tool.
    await env.runtime.submit(bot.botId, { requestId: 'q-primary-input', text: 'Pick a finish first', origin: USER_ORIGIN });
    const r1 = await env.waitForSubmission(bot.botId, 'q-primary-input');
    assert.equal(r1.status, 'done', JSON.stringify(r1));

    const historyItems = (await env.runtime.history(bot.botId, { limit: 30 })).items;
    assert.equal(
      JSON.stringify(historyItems).includes('FORGED_SECOND_REPLY_MUST_NOT_COMMIT'),
      false,
      'finishExternalTerminate must not commit a forged second assistant reply',
    );
    const pendingMsg = historyItems
      .flatMap((entry) => entry.model ?? [])
      .find((msg) => msg?.durableWait === true);
    const question = pendingMsg?.details?.presentation;
    assert.equal(question?.status, 'pending');

    const { result } = await env.runtime.callCapabilityAction('test-questionnaire', 'answerQuestionnaire', {
      requestId: 'q-primary-answer',
      deviceId: env.deviceId,
      botId: bot.botId,
      input: {
        conversationId: question.conversationId,
        requestId: question.requestId,
        cancelled: false,
        answers: [{ questionIndex: 0, selectedOptions: [0] }],
      },
    });
    assert.equal(result.status, 'answered');

    const waitKey = createHash('sha256')
      .update(JSON.stringify([bot.primaryConversationId, question.installationId, question.conversationId, question.requestId]))
      .digest('hex');
    const rContinuation = await env.waitForSubmission(bot.botId, `wait-${waitKey.slice(0, 40)}`);
    assert.equal(rContinuation.status, 'done', JSON.stringify(rContinuation));
    assert.equal(rContinuation.answerText, 'COPPER_CHOICE_CONFIRMED');

    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, runCalls[0].sessionId);
    assert.match(runCalls[1].inputs[0].text, /Pick a finish.*Copper/);
    assert.doesNotMatch(runCalls[1].inputs[0].text, /Pick a finish first/);

    // Part B: Non-primary task_dispatch turn where waits.open returns null -> terminates without blocking.
    const activeWaitsBeforeNonPrimary = new Set(
      Object.keys(
        readDurableDoc(
          env.durableDbPath,
          DurableWaitIndex,
          'session',
          0,
          bot.primaryConversationId,
        )?.active ?? {},
      ),
    );
    await env.runtime.submitTaskDispatch(bot.botId, {
      requestId: 'q-nonprimary-td',
      text: 'Task step needs confirmation',
    });
    const rNonPrimary = await env.waitForSubmission(bot.botId, 'q-nonprimary-td');
    assert.equal(rNonPrimary.status, 'done', JSON.stringify(rNonPrimary));
    assert.equal(runCalls.length, 3);

    const waitIndex = readDurableDoc(
      env.durableDbPath,
      DurableWaitIndex,
      'session',
      0,
      bot.primaryConversationId,
    );
    const newlyOpenedWaits = Object.keys(waitIndex?.active ?? {}).filter(
      (waitId) => !activeWaitsBeforeNonPrimary.has(waitId),
    );
    assert.deepEqual(newlyOpenedWaits, [], 'non-primary AGY questionnaire must not open a DurableWait');
    const historyItemsAfterNonPrimary = (await env.runtime.history(bot.botId, { limit: 50 })).items;
    const nonPrimaryToolResult = historyItemsAfterNonPrimary
      .flatMap((entry) => entry.model ?? [])
      .find((msg) => msg?.role === 'toolResult' && msg.toolCallId === 'ask-nonprimary-1');
    assert.ok(nonPrimaryToolResult);
    assert.notEqual(nonPrimaryToolResult.durableWait, true);
    assert.equal(JSON.stringify(historyItemsAfterNonPrimary).includes('IGNORED_NONPRIMARY_AFTER_TERMINATE'), false);
  } finally {
    delete globalThis[hookKey];
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Model switch guard allows AGY-to-AGY switching in the same session and blocks cross-provider switches until /clear', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-model-switch-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const agyRunCalls = [];
  const ordinaryCalls = [];
  const fixtureApi = `agy-switch-fixture-${path.basename(rootDir)}`;
  const ordinaryStream = (model, context) => {
    ordinaryCalls.push(structuredClone(context));
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = {
        role: 'assistant',
        provider: model.provider,
        api: model.api,
        model: model.id,
        content: [{ type: 'text', text: 'ordinary reply' }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      events.push({ type: 'done', reason: 'stop', message });
      events.end(message);
    });
    return events;
  };
  registerApiProvider({ api: fixtureApi, stream: ordinaryStream, streamSimple: ordinaryStream }, fixtureApi);

  const antigravityClient = {
    run(payload) {
      agyRunCalls.push(JSON.parse(JSON.stringify(payload)));
      return (async function* () {
        yield { type: 'text_delta', delta: `agy:${payload.modelId}` };
        yield { type: 'turn_done', usage: { input: 10, output: 5, totalTokens: 15 } };
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openTestRuntime({ rootDir, antigravityClient, fixtureApi });
    const bot = await env.runtime.createBot({ requestId: 'switch-bot', role: 'Model Switch', cwd, makePrimary: true });
    const ordinarySel = { modelRef: 'fixture/model', thinkingLevel: 'off', codemode: false, codemodeOnly: false };
    const agyModelB = { ...BASE_MODEL_SEL, modelRef: SECOND_MODEL_REF };
    const snap = (rev, model) => env.makeSnapshot(rev, [{ botId: bot.botId, cwd, model, capabilities: [] }]);
    const isHistoryChanged = (err) => err?.code === AGY_HISTORY_CHANGED && /\/clear/.test(err.message);

    // 1. Non-empty non-AGY -> AGY blocked until /clear.
    await env.applySnapshot(snap(2, ordinarySel));
    await env.runtime.submit(bot.botId, { requestId: 'ord-1', text: 'Ordinary turn 1', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'ord-1')).status, 'done');
    assert.equal(ordinaryCalls.length, 1);

    await assert.rejects(() => env.runtime.assertModelSelectionAllowed(bot.botId, MODEL_REF), isHistoryChanged);
    const blockedEnter = await env.runtime.applyCenterSnapshot(snap(3, BASE_MODEL_SEL));
    assert.equal(blockedEnter.status, 'failed');
    assert.match(JSON.stringify(blockedEnter), new RegExp(AGY_HISTORY_CHANGED));
    assert.equal(agyRunCalls.length, 0);

    // 2. /clear allows switching to AGY Model A.
    await env.runtime.clearHistory(bot.botId);
    assert.deepEqual(await env.runtime.assertModelSelectionAllowed(bot.botId, MODEL_REF), { botId: bot.botId, allowed: true });
    await env.applySnapshot(snap(4, BASE_MODEL_SEL));
    await env.runtime.submit(bot.botId, { requestId: 'agy-a-1', text: 'Run on AGY model A', origin: USER_ORIGIN });
    const rA = await env.waitForSubmission(bot.botId, 'agy-a-1');
    assert.equal(rA.status, 'done');
    assert.equal(rA.answerText, `agy:${MODEL_ID}`);
    assert.equal(agyRunCalls.length, 1);
    assert.equal(agyRunCalls[0].modelId, MODEL_ID);

    // 3. Same-session AGY Model A -> AGY Model B is ALLOWED (same sessionId, new modelId).
    assert.deepEqual(await env.runtime.assertModelSelectionAllowed(bot.botId, SECOND_MODEL_REF), { botId: bot.botId, allowed: true });
    await env.applySnapshot(snap(5, agyModelB));
    await env.runtime.submit(bot.botId, { requestId: 'agy-b-1', text: 'Continue on AGY model B', origin: USER_ORIGIN });
    const rB = await env.waitForSubmission(bot.botId, 'agy-b-1');
    assert.equal(rB.status, 'done');
    assert.equal(rB.answerText, `agy:${SECOND_MODEL_ID}`);
    assert.equal(agyRunCalls.length, 2);
    assert.equal(agyRunCalls[1].modelId, SECOND_MODEL_ID);
    assert.equal(agyRunCalls[1].sessionId, agyRunCalls[0].sessionId);

    // 4. Non-empty AGY -> non-AGY blocked until /clear.
    await assert.rejects(() => env.runtime.assertModelSelectionAllowed(bot.botId, 'fixture/model'), isHistoryChanged);
    const blockedLeave = await env.runtime.applyCenterSnapshot(snap(6, ordinarySel));
    assert.equal(blockedLeave.status, 'failed');
    assert.match(JSON.stringify(blockedLeave), new RegExp(AGY_HISTORY_CHANGED));

    // 5. /clear allows switching back to non-AGY provider.
    await env.runtime.clearHistory(bot.botId);
    assert.deepEqual(await env.runtime.assertModelSelectionAllowed(bot.botId, 'fixture/model'), { botId: bot.botId, allowed: true });
    await env.applySnapshot(snap(7, ordinarySel));
    await env.runtime.submit(bot.botId, { requestId: 'ord-2', text: 'Back on ordinary provider', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'ord-2')).status, 'done');
    assert.equal(ordinaryCalls.length, 2);
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('AGY disables Billion Context, Hindsight autoRecall, Pi threshold/overflow compaction, compact(), and editMessage() while keeping autoRetain and explicit recall', async (t) => {
  const recalledText = 'Verified memory GAMMA-42.';
  const memoryRequests = [];
  const retained = [];
  const banks = new Set();
  const operations = new Set();

  const memoryServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const bank = parts[3];
    memoryRequests.push({ method: req.method, path: url.pathname, body });
    let status = 200;
    let result;
    if (req.method === 'GET' && url.pathname.endsWith('/banks')) {
      result = { banks: [...banks].map((bank_id) => ({ bank_id })), total: banks.size };
    } else if (req.method === 'PUT' && parts.length === 4) {
      banks.add(bank);
      result = { bank_id: bank };
    } else if (req.method === 'GET' && parts[4] === 'operations') {
      result = { operation_id: parts[5], status: operations.has(parts[5]) ? 'completed' : 'not_found' };
    } else if (req.method === 'POST' && parts[4] === 'memories' && parts.length === 5) {
      retained.push({ bank, body });
      operations.add(body.operation_id);
      result = { success: true, bank_id: bank, async: true, operation_id: body.operation_id };
    } else if (req.method === 'POST' && url.pathname.endsWith('/memories/recall')) {
      result = { results: [{ id: 'mem-gamma', text: recalledText, type: 'observation' }], source_facts: {} };
    } else {
      status = 404;
      result = { error: 'Unexpected fixture request' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => memoryServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    memoryServer.close(resolve);
    memoryServer.closeAllConnections();
  }));

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-disabled-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const bcRecord = path.join(rootDir, 'bc-activity.txt');
  const rewriterRecord = path.join(rootDir, 'rewriter-activity.txt');

  const runCalls = [];
  const toolResultResolvers = new Map();
  let memoryToolName = '';

  const antigravityClient = {
    run(payload) {
      runCalls.push(JSON.parse(JSON.stringify(payload)));
      const turn = runCalls.length;
      return (async function* () {
        if (turn === 1) {
          // Cross Pi's threshold compaction limit (127_000 on 128_000 context window).
          yield { type: 'text_delta', delta: 'Noted GAMMA-42.' };
          yield { type: 'turn_done', usage: { input: 127_000, output: 20, totalTokens: 127_020 } };
        } else if (turn === 2) {
          const waitCode = Promise.withResolvers();
          toolResultResolvers.set('mem-code-1', waitCode);
          yield {
            type: 'tool_request',
            callId: 'mem-code-1',
            name: 'codemode',
            args: {
              code: `
                if ((await searchTools("bc_probe_tool", { limit: 20 })).some(tool => tool.name === "bc_probe_tool")) {
                  throw new Error("BC tool must not be exposed");
                }
                if (!(await describeTool(${JSON.stringify(memoryToolName)}))) {
                  throw new Error("Missing explicit Hindsight recall tool");
                }
                text(await tools[${JSON.stringify(memoryToolName)}]({ query: "GAMMA-42" }));
              `,
            },
          };
          const codeRes = await waitCode.promise;
          assert.equal(codeRes.isError, false, JSON.stringify(codeRes));
          assert.match(JSON.stringify(codeRes.content), /Verified memory GAMMA-42/);
          yield { type: 'text_delta', delta: 'Recalled explicitly.' };
          yield { type: 'turn_done', usage: { input: 127_100, output: 20, totalTokens: 127_120 } };
        } else {
          // Simulate provider context overflow error -> Pi must NOT run overflow compaction.
          yield { type: 'error', code: 'CONTEXT_OVERFLOW', message: 'maximum context length exceeded' };
        }
      })();
    },
    async toolResult(payload) {
      toolResultResolvers.get(payload.callId)?.resolve(JSON.parse(JSON.stringify(payload)));
      return { ok: true };
    },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openTestRuntime({ rootDir, antigravityClient });
    const bot = await env.runtime.createBot({ requestId: 'disabled-bot', role: 'Disabled Checks', cwd, makePrimary: true });
    memoryToolName =
      'hindsight_' +
      createHash('sha256').update(JSON.stringify(['test-hindsight-recall', bot.botId])).digest('hex').slice(0, 32) +
      '_recall';

    await env.applySnapshot(
      env.makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd,
          model: BASE_MODEL_SEL,
          capabilities: [
            makeCapability('test-bc-context', {
              recordFile: bcRecord,
              enableProbeTool: true,
              toolName: 'bc_probe_tool',
              enablePrepareContext: true,
            }),
            makeCapability('test-context-rewriter', {
              recordFile: rewriterRecord,
              enablePrepareContext: true,
            }),
            makeCapability(
              'test-hindsight-recall',
              { baseUrl: `http://127.0.0.1:${memoryServer.address().port}`, mode: 'read-write' },
              { targetVersion: hindsightManifest.version },
            ),
          ],
        },
      ]),
    );

    // Turn 1: BC disabled, non-BC prepareContext skipped, Hindsight autoRecall disabled, autoRetain still active.
    await env.runtime.submit(bot.botId, { requestId: 'dis-1', text: 'Remember codeword GAMMA-42', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'dis-1')).status, 'done');

    assert.equal(fs.existsSync(bcRecord), false, 'Billion Context must not instantiate or run prepareContext for AGY');
    assert.match(fs.readFileSync(rewriterRecord, 'utf8'), /activate/);
    assert.doesNotMatch(fs.readFileSync(rewriterRecord, 'utf8'), /prepareContext/);
    assert.equal(runCalls[0].tools.some((tool) => tool.name === 'bc_probe_tool'), false);
    assert.equal(memoryRequests.filter((r) => r.path.endsWith('/memories/recall')).length, 0, 'Hindsight autoRecall must be disabled');
    await waitUntil(() => retained.some((r) => JSON.stringify(r.body).includes('GAMMA-42')), {
      label: 'Hindsight autoRetain still runs for AGY',
    });

    const firstAssistant = (await env.runtime.history(bot.botId, { limit: 30 })).items
      .flatMap((e) => e.model ?? [])
      .find((m) => m?.role === 'assistant');
    assert.equal(firstAssistant?.usage?.input, 127_000, 'Turn 1 must cross Pi threshold compaction watermark');

    // Turn 2: threshold compaction did NOT trigger; explicit recall via codemode succeeds and bc_probe_tool stays absent.
    await env.runtime.submit(bot.botId, { requestId: 'dis-2', text: 'Explicitly recall GAMMA-42', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'dis-2')).status, 'done');
    assert.equal(runCalls.length, 2, 'threshold compaction must not execute');
    assert.equal(memoryRequests.filter((r) => r.path.endsWith('/memories/recall')).length, 1);

    // Turn 3: provider overflow does NOT trigger Pi overflow compaction.
    await env.runtime.submit(bot.botId, { requestId: 'dis-3', text: 'Trigger overflow', origin: USER_ORIGIN });
    const overflowReceipt = await env.waitForSubmission(bot.botId, 'dis-3');
    assert.equal(overflowReceipt.status, 'unanswered');
    assert.equal(overflowReceipt.reason, 'model_error');
    assert.equal(runCalls.length, 3, 'overflow compaction must not retry or summarize');

    // Manual compact() and editMessage() throw AGY_HISTORY_CHANGED and leave history intact.
    const historyBefore = await env.runtime.history(bot.botId, { limit: 100 });
    const historyJson = JSON.stringify(historyBefore.items);
    assert.match(historyJson, /Remember codeword GAMMA-42/);
    assert.doesNotMatch(historyJson, /compacted into the following summary/);

    const isHistoryChanged = (err) => err?.code === AGY_HISTORY_CHANGED && /\/clear/.test(err.message);
    await assert.rejects(() => env.runtime.compact(bot.botId), isHistoryChanged);

    const editableEntry = historyBefore.items.find((entry) => entry.data?.requestId === 'dis-1');
    assert.ok(editableEntry);
    await assert.rejects(
      () => env.runtime.editMessage(bot.botId, { entryId: editableEntry.id, requestId: 'edit-dis-1', text: 'Rewritten' }),
      isHistoryChanged,
    );
    assert.deepEqual((await env.runtime.history(bot.botId, { limit: 100 })).items, historyBefore.items);
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Scheduled turns forward transient routeNote and isolated mcp-dispatch runs with zero tools and no turnContext', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-route-mcp-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const runCalls = [];
  const pendingWebhookEvents = new Map();
  const webhookReceipts = [];

  const antigravityClient = {
    run(payload) {
      const cloned = JSON.parse(JSON.stringify(payload));
      runCalls.push(cloned);
      const isMcp = cloned.inputs.some((i) => i.text.includes('MCP_ISOLATED_QUERY_99'));
      return (async function* () {
        yield {
          type: 'text_delta',
          delta: isMcp ? 'MCP_ISOLATED_ANSWER_99' : `primary-ack-${runCalls.length}`,
        };
        yield { type: 'turn_done', usage: { input: 10, output: 5, totalTokens: 15 } };
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openTestRuntime({
      rootDir,
      antigravityClient,
      webhookHooks: {
        async pollWebhookEvents() {
          return {
            items: [...pendingWebhookEvents.values()].map((evt) => ({ ...evt })),
            nextCursor: null,
          };
        },
        async reportWebhookEvent(eventId, receipt) {
          webhookReceipts.push({ eventId, receipt: JSON.parse(JSON.stringify(receipt)) });
          const current = pendingWebhookEvents.get(eventId);
          if (current) {
            if (receipt.status === 'succeeded' || receipt.status === 'failed' || receipt.status === 'cancelled') {
              pendingWebhookEvents.delete(eventId);
            } else {
              current.status = receipt.status;
            }
          }
          return { ok: true };
        },
      },
    });

    const bot = await env.runtime.createBot({ requestId: 'route-bot', role: 'Route and MCP', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));

    // 1. Human primary turn: no routeNote, no turnContext.
    await env.runtime.submit(bot.botId, {
      requestId: 'human-1',
      text: 'Private note: PRIVATE_PRIMARY_SECRET_88',
      origin: USER_ORIGIN,
    });
    assert.equal((await env.waitForSubmission(bot.botId, 'human-1')).status, 'done');
    assert.equal(runCalls[0].routeNote, undefined);
    assert.equal(Object.hasOwn(runCalls[0], 'turnContext'), false);

    // 2. Scheduled turn: forwards transient routeNote and source='schedule' without leaking into sections.
    const fence = await env.runtime.getScheduleFence(bot.botId);
    await env.runtime.submitScheduled(bot.botId, {
      requestId: 'sched-1',
      text: 'Run periodic health check',
      stopEpoch: fence.stopEpoch,
    });
    assert.equal((await env.waitForSubmission(bot.botId, 'sched-1')).status, 'done');
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, runCalls[0].sessionId);
    assert.match(runCalls[1].routeNote, /Host scheduled run or signal/);
    assert.equal(runCalls[1].inputs[0].source, 'schedule');
    assert.equal((runCalls[1].sections ?? []).some((s) => s.key === 'host-turn-routing'), false);
    assert.equal(Object.hasOwn(runCalls[1], 'turnContext'), false);

    // 3. Subsequent human turn: routeNote is cleared.
    await env.runtime.submit(bot.botId, { requestId: 'human-2', text: 'Back to human chat', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'human-2')).status, 'done');
    assert.equal(runCalls[2].routeNote, undefined);

    // 4. Isolated mcp-dispatch: separate sessionId, strictly 0 tools, no turnContext, no primary history leakage.
    pendingWebhookEvents.set('evt-mcp-iso-1', {
      id: 'evt-mcp-iso-1',
      botId: bot.botId,
      deviceId: env.deviceId,
      requestId: 'mcp-iso-req-1',
      status: 'dispatching',
      routeName: 'External MCP',
      instruction: 'Answer directly without using tools.',
      payload: { query: 'MCP_ISOLATED_QUERY_99' },
      trustedSource: 'mcp-dispatch',
      toolPolicy: 'mcp-safe',
      sessionIsolation: 'isolated',
    });
    env.runtime.notifyWebhookReady();

    const succeeded = await waitUntil(
      () => webhookReceipts.find((r) => r.eventId === 'evt-mcp-iso-1' && r.receipt.status === 'succeeded'),
      { label: 'isolated mcp-dispatch succeeded receipt' },
    );
    assert.equal(succeeded.receipt.result?.answerText, 'MCP_ISOLATED_ANSWER_99');

    assert.equal(runCalls.length, 4);
    const mcpRun = runCalls[3];
    assert.notEqual(mcpRun.sessionId, runCalls[0].sessionId, 'isolated mcp-dispatch must use its own sessionId');
    assert.deepEqual(mcpRun.tools, [], 'isolated mcp-dispatch must declare strictly 0 tools');
    assert.equal(Object.hasOwn(mcpRun, 'turnContext'), false);
    assert.equal(mcpRun.routeNote, undefined);
    assert.match(mcpRun.inputs[0].text, /MCP_ISOLATED_QUERY_99/);
    assert.equal(JSON.stringify(mcpRun).includes('PRIVATE_PRIMARY_SECRET_88'), false);

    const primaryHistory = JSON.stringify((await env.runtime.history(bot.botId, { limit: 50 })).items);
    assert.equal(primaryHistory.includes('MCP_ISOLATED_QUERY_99'), false);
    assert.equal(primaryHistory.includes('MCP_ISOLATED_ANSWER_99'), false);
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
