import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openHost } from '../../host-core/host.js';
import {
  computeOverflowRecoveryBudget,
  computePreflightTargetTokens,
  countMessageTokens,
  setBillionContextOutputBudget,
  withBillionContextOutputRepair,
} from '../../host-core/request-context.js';
import { openRuntime } from '../../host-core/runtime.js';
import { openAICompletionsApi } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js';
import { openAIResponsesApi } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js';
import { registerApiProvider } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/compat.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';
import { getCurrentTools } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js';
import { estimateMessageTokens } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/estimate.js';

const BC_PACKAGE_ROOT = fileURLToPath(new URL('../../plugins/billion-context', import.meta.url));
const BC_INSTALLATION_ID = 'inst-billion-context';
const BC_VERSION = '1.0.4';
const BC_MANIFEST = {
  ...JSON.parse(fs.readFileSync(path.join(BC_PACKAGE_ROOT, 'capability.json'), 'utf8')),
  version: BC_VERSION,
};

const SIDE_EFFECT_INSTALLATION_ID = 'inst-side-effect-tool';
const SIDE_EFFECT_TOOL_NAME = 'side_effect_action';
const PROVIDER_ID = 'mock-non-agy';
const MODEL_ID = 'mock-context-model';
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
const PENDING_STATUSES = new Set(['queued', 'placed', 'running', 'pending', 'admitted']);
const USER_ORIGIN = { sender: { kind: 'user' }, replyTo: null };

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function sendProjectedRequest({
  api = 'openai-responses', compat, tokenCount = 494_900, billionContext = true, options,
} = {}) {
  const responses = api === 'openai-responses';
  const provider = withBillionContextOutputRepair(responses ? openAIResponsesApi() : openAICompletionsApi());
  const model = {
    id: MODEL_ID, api, provider: 'openai', baseUrl: 'https://openai.example.test/v1',
    reasoning: false, input: ['text'], contextWindow: 500_000, maxTokens: 1_024,
    cost: ZERO_USAGE.cost, compat,
  };
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Retained reply' }], stopReason: 'stop', timestamp: 1,
      api, provider: model.provider, model: model.id, usage: { ...ZERO_USAGE, totalTokens: 499_000 } },
    { role: 'user', content: 'Current question', timestamp: 2 },
  ];
  if (billionContext) setBillionContextOutputBudget(messages, tokenCount, model.contextWindow);

  let body;
  const result = await provider.streamSimple(model, { messages: [...messages] }, {
    apiKey: 'sk-fixture',
    ...options,
    async fetch(_url, request) {
      body = JSON.parse(request.body);
      const event = responses
        ? { type: 'response.completed', response: { status: 'completed', output: [] } }
        : { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  }).result();
  return { body, result };
}

test('Billion Context reserves output and a near-window margin for OpenAI preflight and recovery', () => {
  assert.equal(computePreflightTargetTokens(500_000, 1_024, 'openai-responses'), 494_880);
  assert.equal(computePreflightTargetTokens(500_000, 16, 'openai-completions'), 495_888);
  assert.equal(computePreflightTargetTokens(500_000, 200_000, 'openai-responses'), 370_904);
  assert.equal(computePreflightTargetTokens(500_000, 1_024, 'anthropic-messages'), 500_000);
  assert.equal(computePreflightTargetTokens(4_096, 1_024, 'openai-responses'), 3_072);
  const { targetTokens, effectiveContextWindow } = computeOverflowRecoveryBudget({
    configuredContextWindow: 500_000, modelMaxTokens: 1_024, api: 'openai-responses',
    sentEstimatedTokens: 480_000, errorMessage: 'maximum context length is 64000 tokens',
  });
  assert.equal(effectiveContextWindow, 64_000);
  assert.equal(targetTokens, 58_880);
});

test('Billion Context restores SDK-clamped OpenAI wire limits from the projected input', async (t) => {
  for (const [api, field, minimum] of [
    ['openai-responses', 'max_output_tokens', 16],
    ['openai-completions', 'max_completion_tokens', 1],
    ['openai-completions', 'max_tokens', 1],
  ]) {
    await t.test(field, async () => {
      const { body, result } = await sendProjectedRequest({
        api,
        compat: api === 'openai-completions' ? { maxTokensField: field } : undefined,
        options: { onPayload: (payload) => {
          assert.equal(payload[field], minimum, 'the stale assistant usage should trigger the SDK clamp');
          return payload;
        } },
      });
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.equal(body[field], 1_004);
    });
  }
});

test('Billion Context sends overestimated requests with the configured output cap', async (t) => {
  for (const [api, field] of [
    ['openai-responses', 'max_output_tokens'],
    ['openai-completions', 'max_completion_tokens'],
    ['openai-completions', 'max_tokens'],
  ]) {
    for (const tokenCount of [496_002, 500_000, 600_000]) {
      await t.test(`${field}: ${tokenCount}`, async () => {
        const { body, result } = await sendProjectedRequest({
          api, tokenCount,
          compat: api === 'openai-completions' ? { maxTokensField: field } : undefined,
        });
        assert.equal(result.stopReason, 'stop', result.errorMessage);
        assert.equal(body[field], 1_024);
        assert.ok(JSON.stringify(body).includes('Current question'));
      });
    }
  }
});

test('Billion Context preserves explicit and omitted OpenAI Responses limits', async (t) => {
  for (const [name, settings, expected] of [
    ['ordinary request', { billionContext: false }, 16],
    ['explicit request cap', { options: { maxTokens: 16 } }, 16],
    ['explicit cap above the floor', { options: { maxTokens: 32 } }, 32],
    ['explicit cap without estimated room', { tokenCount: 600_000, options: { maxTokens: 32 } }, 32],
    ['configured model cap', { tokenCount: 400_000, options: { maxTokens: 2_048 } }, 1_024],
    ['sampling override', { options: { samplingParams: { max_output_tokens: 16 } } }, 16],
    ['replacement hook', { options: { onPayload: (payload) => ({ ...payload, max_output_tokens: 16 }) } }, 16],
    ['unsupported field', { compat: { supportsMaxOutputTokens: false } }, undefined],
  ]) {
    await t.test(name, async () => {
      const { body, result } = await sendProjectedRequest(settings);
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.equal(body.max_output_tokens, expected);
      if (expected === undefined) assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
    });
  }
});

async function waitUntil(predicate, { timeoutMs = 30_000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  let lastErr = null;
  while (performance.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function makeFoldableText(prefix, targetChars) {
  const header = `${prefix} `;
  const unit = 'plain archive narrative record alpha beta gamma delta epsilon zeta eta theta iota kappa. ';
  const padLen = Math.max(0, targetChars - header.length);
  const body = padLen > 0 ? unit.repeat(Math.ceil(padLen / unit.length)).slice(0, padLen) : '';
  return header + body;
}

function findLastRealUserMessage(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    if (msg.bcContextMaterial === true || msg.bcSummaryMaterial === true) continue;
    if (msg.timestamp === 0) continue;
    return msg;
  }
  return null;
}

function findNudgeMessages(messages) {
  return (messages ?? []).filter((msg) => {
    if (!msg || msg.role !== 'user') return false;
    if (msg.bcContextMaterial === true) return true;
    if (msg.timestamp === 0 && msg.bcSummaryMaterial !== true) {
      const text = extractMessageText(msg);
      return /compress|context|nudge/i.test(text);
    }
    return false;
  });
}

const invalidCompressArgs = {
  content: [{ startId: 'm999999', endId: 'm999999', summary: 'A valid summary for a deliberately nonexistent block reference.' }],
};

function readCounter(counterFile) {
  if (!fs.existsSync(counterFile)) return { count: 0, calls: [] };
  return JSON.parse(fs.readFileSync(counterFile, 'utf8'));
}

function countPresentArchiveMarkers(messages, warmupCount) {
  const joined = (messages ?? []).map((msg) => extractMessageText(msg)).join('\n');
  let present = 0;
  for (let i = 1; i <= warmupCount; i += 1) {
    if (joined.includes(`OLD_ARCHIVE_USER_${i}`)) present += 1;
  }
  return present;
}

function makeCapability(installationId, effectiveConfig, targetVersion, revision = 1) {
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

function createManagedPluginInstaller(rootDir) {
  const bcDataDir = path.join(rootDir, 'bc-data');
  fs.mkdirSync(bcDataDir, { recursive: true });

  const sideEffectDir = path.join(rootDir, 'plugins', 'test-side-effect-tool');
  fs.mkdirSync(sideEffectDir, { recursive: true });
  fs.writeFileSync(
    path.join(sideEffectDir, 'entry.mjs'),
    `import fs from 'node:fs';

export function createPlugin({ host }) {
  const bots = new Set();
  return {
    async forBot({ effectiveConfig: cfg }) {
      const counterFile = cfg?.counterFile;
      const tools = [
        host.sdk.defineTool({
          name: ${JSON.stringify(SIDE_EFFECT_TOOL_NAME)},
          description: 'Execute a side-effectful test action once and return a sized plain text payload.',
          parameters: {
            type: 'object',
            properties: {
              tag: { type: 'string' },
              payloadChars: { type: 'integer', minimum: 0 },
            },
            required: ['tag', 'payloadChars'],
            additionalProperties: false,
          },
          replay: 'unsafe',
          outputLimits: { maxBytes: 256 * 1024 },
          async execute(args) {
            const tag = String(args?.tag ?? 'default');
            const payloadChars = Math.max(0, Number(args?.payloadChars ?? 0));
            let state = { count: 0, calls: [] };
            if (counterFile && fs.existsSync(counterFile)) {
              state = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
            }
            state.count += 1;
            state.calls.push({ tag, payloadChars });
            if (counterFile) {
              fs.writeFileSync(counterFile, JSON.stringify(state));
            }
            const prefix = 'SIDE_EFFECT_RESULT_MARKER_' + tag + '_RUN_' + state.count + ' ';
            const unit = 'tool payload observation record alpha beta gamma delta epsilon zeta eta theta. ';
            const padLen = Math.max(0, payloadChars - prefix.length);
            const body = padLen > 0 ? unit.repeat(Math.ceil(padLen / unit.length)).slice(0, padLen) : '';
            return { output: [{ type: 'text', text: prefix + body }] };
          },
        }),
      ];
      const bot = {
        durableContributions: { tools },
        async prepare() {},
        async activate() {},
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
      BC_INSTALLATION_ID,
      {
        version: BC_VERSION,
        packageRoot: BC_PACKAGE_ROOT,
        dataDir: bcDataDir,
        manifest: BC_MANIFEST,
      },
    ],
    [
      SIDE_EFFECT_INSTALLATION_ID,
      {
        version: '1.0.0',
        packageRoot: sideEffectDir,
        dataDir: path.join(sideEffectDir, 'data'),
        manifest: {
          id: 'test.side-effect-tool',
          version: '1.0.0',
          kind: 'plugin',
          components: { host: { entry: 'entry.mjs' } },
        },
      },
    ],
  ]);

  return {
    async getInstalled(id, opts) {
      const entry = installed.get(id);
      if (!entry) return null;
      if (opts?.version && entry.version !== opts.version) return null;
      return entry;
    },
  };
}

async function openRecoveryFixture({
  label,
  contextWindow,
  maxTokens = 1_024,
  bcEffectiveConfig = {},
}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `pibot-bc-recovery-${label}-`));
  const botCwd = path.join(rootDir, 'workspace');
  const hostDataRoot = path.join(rootDir, 'host-data');
  const counterFile = path.join(rootDir, 'side-effect-counter.json');
  fs.mkdirSync(botCwd, { recursive: true });

  const apiName = `mock-bc-recovery-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const allRequests = [];
  const mainRequests = [];
  const summaryRequests = [];
  let llmHandler = async () => [{ type: 'text', text: 'ok' }];

  const makeStream = (model, reqContext, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;
    queueMicrotask(async () => {
      const abortMessage = () => ({
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
        timestamp: Date.now(),
      });
      if (signal?.aborted) {
        const msg = abortMessage();
        stream.push({ type: 'error', reason: 'aborted', error: msg });
        stream.end(msg);
        return;
      }
      let settled = false;
      const finishAbort = () => {
        if (settled) return;
        settled = true;
        const msg = abortMessage();
        stream.push({ type: 'error', reason: 'aborted', error: msg });
        stream.end(msg);
      };
      signal?.addEventListener('abort', finishAbort, { once: true });

      try {
        const tools = getCurrentTools(reqContext.messages);
        const toolNames = tools.map((tool) => tool.name);
        const hasMainTool = toolNames.length > 0;
        const estTokens = reqContext.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        const serializedBytes = Buffer.byteLength(JSON.stringify(reqContext.messages));
        const record = {
          seq: allRequests.length + 1,
          kind: hasMainTool ? 'main' : 'summary',
          estTokens,
          maxTokens: options?.maxTokens ?? 0,
          serializedBytes,
          toolNames,
          hasMainTool,
          messages: structuredClone(reqContext?.messages ?? []),
        };
        allRequests.push(record);
        if (hasMainTool) mainRequests.push(record);
        else summaryRequests.push(record);

        const rawResult = await llmHandler({ ...reqContext, tools }, model, signal, record);
        if (settled || signal?.aborted) {
          finishAbort();
          return;
        }
        settled = true;
        const blocks = Array.isArray(rawResult) ? rawResult : rawResult.blocks;
        const hasToolCall = blocks.some((block) => block?.type === 'toolCall');
        const outTokens = Math.max(10, countMessageTokens({ text: JSON.stringify(blocks) }));
        const inputTokens = Math.max(10, estTokens);
        const usage =
          !Array.isArray(rawResult) && rawResult?.usage
            ? rawResult.usage
            : {
                input: inputTokens,
                output: outTokens,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: inputTokens + outTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              };
        const message = {
          role: 'assistant',
          content: blocks,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: hasToolCall ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        stream.push({
          type: 'done',
          reason: hasToolCall ? 'toolUse' : 'stop',
          message,
        });
        stream.end(message);
      } catch (err) {
        if (settled) return;
        if (signal?.aborted) {
          finishAbort();
          return;
        }
        settled = true;
        const errMsg = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason: 'error', error: errMsg });
        stream.end(errMsg);
      } finally {
        signal?.removeEventListener('abort', finishAbort);
      }
    });
    return stream;
  };

  registerApiProvider(
    {
      api: apiName,
      stream: makeStream,
      streamSimple: makeStream,
    },
    `billion-context-recovery-${label}`,
  );

  const meta = openHost({ dataRoot: hostDataRoot });
  const deviceId = meta.deviceId;
  meta.close();

  const installer = createManagedPluginInstaller(rootDir);
  let currentSnapshot = null;
  const centerClient = {
    providerAuth: async () => ({ auth: { apiKey: 'mock-center-key' }, source: 'center' }),
  };

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

  const makeSnapshot = (revision, bots) => ({
    protocol: 1,
    deviceId,
    revision,
    providers: [
      {
        id: PROVIDER_ID,
        name: 'Mock Non-AGY Provider',
        api: apiName,
        baseUrl: 'http://127.0.0.1:9',
        enabled: true,
        credentialRef: null,
      },
    ],
    models: {
      [PROVIDER_ID]: [
        {
          id: MODEL_ID,
          name: 'Mock Context Model',
          api: apiName,
          contextWindow,
          maxTokens,
          input: ['text'],
          reasoning: false,
          enabled: true,
          revision: 1,
        },
      ],
    },
    credentials: {},
    bots,
  });

  const applySnapshot = async (snapshot) => {
    currentSnapshot = snapshot;
    await waitUntil(async () => {
      const res = await runtime.applyCenterSnapshot(snapshot);
      if (res.status === 'failed') {
        throw new Error(`applyCenterSnapshot failed: ${JSON.stringify(res)}`);
      }
      return res.status === 'applied';
    }, { label: `applyCenterSnapshot rev=${snapshot.revision}` });
  };

  const waitForSubmission = (botId, requestId) =>
    waitUntil(async () => {
      const sub = await runtime.getSubmission(botId, requestId);
      return sub && !PENDING_STATUSES.has(sub.status) ? sub : null;
    }, { label: `submission ${requestId}` });

  try {
    await applySnapshot(makeSnapshot(1, []));
    await runtime.setCenterOnline(true);
    await runtime.restoreTurns();
    runtime.resume();

    const bot = await runtime.createBot({
      requestId: `create-bot-${label}`,
      role: 'RecoveryAssistant',
      cwd: botCwd,
      makePrimary: true,
    });

    await applySnapshot(
      makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd: botCwd,
          model: {
            modelRef: MODEL_REF,
            thinkingLevel: 'off',
            codemode: false,
            codemodeOnly: false,
          },
          capabilities: [
            makeCapability(BC_INSTALLATION_ID, bcEffectiveConfig, BC_VERSION, 1),
            makeCapability(SIDE_EFFECT_INSTALLATION_ID, { counterFile }, '1.0.0', 1),
          ],
        },
      ]),
    );

    return {
      runtime,
      bot,
      botCwd,
      rootDir,
      counterFile,
      allRequests,
      mainRequests,
      summaryRequests,
      setHandler(fn) {
        llmHandler = fn;
      },
      waitForSubmission,
      async close(hadError = false) {
        const errors = [];
        try {
          await runtime.close();
        } catch (err) {
          errors.push(err);
        }
        try {
          fs.rmSync(rootDir, { recursive: true, force: true });
        } catch (err) {
          errors.push(err);
        }
        if (!hadError && errors.length > 0) throw errors[0];
      },
    };
  } catch (err) {
    try {
      await runtime.close();
    } catch {
      /* preserve startup error */
    }
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

async function plantFoldableHistory({
  fixture,
  botId,
  prefix,
  targetNextTurnTokens,
  contextWindow,
  charsPerMessage = 6_400,
  maxTurns = 18,
}) {
  const replyTokens = Math.ceil(charsPerMessage / 4);
  let warmupTurns = 0;
  let nextMaxTokens = 0;
  let lastReqTokens = 0;
  let bcTokens = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const reqId = `${prefix}-warmup-${turn}`;
    await fixture.runtime.submit(botId, {
      requestId: reqId,
      text: makeFoldableText(`WARMUP_TURN_${turn} OLD_ARCHIVE_USER_${turn}`, charsPerMessage),
      origin: USER_ORIGIN,
    });
    const sub = await fixture.waitForSubmission(botId, reqId);
    assert.equal(sub.status, 'done', `warmup turn ${turn} must succeed before overflow test`);

    warmupTurns = turn;
    lastReqTokens = fixture.mainRequests.at(-1)?.estTokens ?? 0;
    const status = await fixture.runtime.contextStatus(botId);
    bcTokens = status?.prepared?.tokenCount ?? 0;
    nextMaxTokens = Math.max(lastReqTokens, bcTokens) + replyTokens;

    if (nextMaxTokens >= targetNextTurnTokens || nextMaxTokens + replyTokens * 2 >= contextWindow - 4_000) {
      break;
    }
  }

  return { warmupTurns, nextMaxTokens, lastReqTokens, bcTokens };
}

// ============================================================================
// 1) Preflight compaction after large foldable plain-text history + real tool:
//    - The main request uses the smaller context when compaction succeeds
//    - Chunked summary requests stay within budget and carry no main tools
//    - Original requestId finishes as done via Runtime.wait & getSubmission with full answerText
//    - Side-effectful test tool executes exactly once (count === 1)
// ============================================================================
test('Billion Context preflight folds old history via budgeted tool-less summaries without re-running side-effect tool', async () => {
  const MODEL_CONTEXT_WINDOW = 64_000;
  const fixture = await openRecoveryFixture({
    label: 's1-local-overflow',
    contextWindow: MODEL_CONTEXT_WINDOW,
    maxTokens: 1_024,
    bcEffectiveConfig: {}, // optional autoFold/autoFoldTargetTokens default false
  });

  let hadError = false;
  try {
    let summaryCounter = 0;
    let chosenPayloadChars = 0;
    let preToolReq = null;
    const postToolReqs = [];

    fixture.setHandler(async (reqContext, _model, _signal, record) => {
      if (record.kind === 'summary') {
        summaryCounter += 1;
        return [
          {
            type: 'text',
            text: `Chunk summary #${summaryCounter}: preserved archive facts concisely.`,
          },
        ];
      }

      const messages = reqContext?.messages ?? [];
      const hasToolResult = messages.some(
        (msg) =>
          msg?.role === 'toolResult' &&
          msg.toolName === SIDE_EFFECT_TOOL_NAME &&
          extractMessageText(msg).includes('SIDE_EFFECT_RESULT_MARKER_s1'),
      );
      if (hasToolResult) {
        postToolReqs.push(record);
        return [
          {
            type: 'text',
            text: 'RECOVERY_S1_COMPLETE: side effect executed once and recovered from local budget overflow.',
          },
        ];
      }

      const lastUser = findLastRealUserMessage(messages);
      const lastUserText = extractMessageText(lastUser);
      const warmupMatch = lastUserText.match(/WARMUP_TURN_(\d+)/);
      if (warmupMatch) {
        return [
          {
            type: 'text',
            text: makeFoldableText(`OLD_ARCHIVE_ASSISTANT_${warmupMatch[1]}`, 3_400),
          },
        ];
      }

      if (lastUserText.includes('TURN_S1_TRIGGER')) {
        preToolReq = record;
        const neededTokens = Math.max(14_000, MODEL_CONTEXT_WINDOW - record.estTokens + 8_000);
        chosenPayloadChars = neededTokens * 4;
        return [
          {
            type: 'toolCall',
            id: 'call_side_effect_s1',
            name: SIDE_EFFECT_TOOL_NAME,
            arguments: { tag: 's1', payloadChars: chosenPayloadChars },
          },
        ];
      }

      return [{ type: 'text', text: 'unexpected fallback' }];
    });

    const planted = await plantFoldableHistory({
      fixture,
      botId: fixture.bot.botId,
      prefix: 's1',
      targetNextTurnTokens: 58_000,
      contextWindow: MODEL_CONTEXT_WINDOW,
      charsPerMessage: 3_400,
      maxTurns: 40,
    });
    assert.ok(planted.warmupTurns >= 4, `expected multiple foldable plain-text turns, got ${planted.warmupTurns}`);

    const targetRequestId = 'req-s1-local-overflow';
    await fixture.runtime.submit(fixture.bot.botId, {
      requestId: targetRequestId,
      text: 'TURN_S1_TRIGGER: run side_effect_action once and summarize final status.',
      origin: USER_ORIGIN,
    });

    const terminal = await fixture.waitForSubmission(fixture.bot.botId, targetRequestId);
    assert.equal(terminal.status, 'done');

    const waited = await fixture.runtime.wait(fixture.bot.botId, targetRequestId);
    const fetched = await fixture.runtime.getSubmission(fixture.bot.botId, targetRequestId);
    assert.equal(waited.status, 'done');
    assert.equal(waited.requestId, targetRequestId);
    assert.ok(
      typeof waited.answerText === 'string' && waited.answerText.includes('RECOVERY_S1_COMPLETE'),
      `expected complete answerText from runtime.wait, got: ${JSON.stringify(waited)}`,
    );
    assert.equal(fetched.status, 'done');
    assert.equal(fetched.requestId, targetRequestId);
    assert.equal(fetched.answerText, waited.answerText);

    // Side-effectful tool must have executed exactly once.
    const counter = readCounter(fixture.counterFile);
    assert.equal(counter.count, 1, `expected side_effect_action count=1, got ${JSON.stringify(counter)}`);

    // Oversized main request must never be sent to provider.
    assert.ok(preToolReq, 'expected pre-tool main request to reach provider');
    const uncompactedEstimate = preToolReq.estTokens + Math.ceil(chosenPayloadChars / 4);
    assert.ok(
      uncompactedEstimate >= MODEL_CONTEXT_WINDOW,
      `sanity check: uncompacted post-tool estimate (${uncompactedEstimate}) must exceed contextWindow (${MODEL_CONTEXT_WINDOW})`,
    );
    for (const req of fixture.mainRequests) {
      assert.ok(
        req.estTokens < MODEL_CONTEXT_WINDOW,
        `main request #${req.seq} must not exceed contextWindow (${req.estTokens} >= ${MODEL_CONTEXT_WINDOW})`,
      );
    }
    assert.ok(postToolReqs.length >= 1, 'expected recovered post-tool main request to reach provider');
    const recoveredReq = postToolReqs.at(-1);
    assert.ok(
      recoveredReq.estTokens < uncompactedEstimate - 4_000,
      `recovered main request (${recoveredReq.estTokens}) must be substantially smaller than uncompacted body (${uncompactedEstimate})`,
    );
    assert.ok(
      countPresentArchiveMarkers(recoveredReq.messages, planted.warmupTurns) < planted.warmupTurns,
      'expected old foldable plain-text history to be folded/compacted out of recovered main request',
    );

    // Chunked summarization requests must exist, stay within budget, and carry no main tools.
    assert.ok(
      fixture.summaryRequests.length >= 1,
      'expected chunked summarization request(s) during local overflow recovery',
    );
    for (const sumReq of fixture.summaryRequests) {
      assert.equal(
        sumReq.hasMainTool,
        false,
        `summary request #${sumReq.seq} must not include main tools, saw: ${JSON.stringify(sumReq.toolNames)}`,
      );
      assert.ok(
        sumReq.estTokens + sumReq.maxTokens < MODEL_CONTEXT_WINDOW,
        `summary request #${sumReq.seq} must leave output room within contextWindow`,
      );
    }
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await fixture.close(hadError);
  }
});

// ============================================================================
// 2) Provider-side context_length_exceeded after local estimation passed:
//    - Non-AGY provider rejects first post-tool main request (windowless overflow error)
//    - Same requestId retries with a strictly smaller main request and finishes done
//    - Side-effectful test tool does NOT re-run (count === 1)
// ============================================================================
test('Billion Context recovery (2): non-AGY provider context_length_exceeded after passing local estimate retries smaller on same requestId without re-running tool', async () => {
  const MODEL_CONTEXT_WINDOW = 64_000;
  const fixture = await openRecoveryFixture({
    label: 's2-provider-overflow',
    contextWindow: MODEL_CONTEXT_WINDOW,
    maxTokens: 1_024,
    bcEffectiveConfig: {}, // optional autoFold/autoFoldTargetTokens default false
  });

  let hadError = false;
  try {
    let summaryCounter = 0;
    const postToolReqs = [];

    fixture.setHandler(async (reqContext, _model, _signal, record) => {
      if (record.kind === 'summary') {
        summaryCounter += 1;
        return [
          {
            type: 'text',
            text: `Provider-overflow chunk summary #${summaryCounter}: retained archive highlights.`,
          },
        ];
      }

      const messages = reqContext?.messages ?? [];
      const hasToolResult = messages.some(
        (msg) =>
          msg?.role === 'toolResult' &&
          msg.toolName === SIDE_EFFECT_TOOL_NAME &&
          extractMessageText(msg).includes('SIDE_EFFECT_RESULT_MARKER_s2'),
      );
      if (hasToolResult) {
        postToolReqs.push(record);
        if (postToolReqs.length === 1) {
          // Simulate a stricter provider limit with no explicit window in error payload.
          throw new Error('context_length_exceeded: maximum context length exceeded');
        }
        return [
          {
            type: 'text',
            text: 'RECOVERY_S2_COMPLETE: succeeded on smaller retry after provider context_length_exceeded.',
          },
        ];
      }

      const lastUser = findLastRealUserMessage(messages);
      const lastUserText = extractMessageText(lastUser);
      const warmupMatch = lastUserText.match(/WARMUP_TURN_(\d+)/);
      if (warmupMatch) {
        return [
          {
            type: 'text',
            text: makeFoldableText(`OLD_ARCHIVE_ASSISTANT_${warmupMatch[1]}`, 6_400),
          },
        ];
      }

      if (lastUserText.includes('TURN_S2_TRIGGER')) {
        return [
          {
            type: 'toolCall',
            id: 'call_side_effect_s2',
            name: SIDE_EFFECT_TOOL_NAME,
            arguments: { tag: 's2', payloadChars: 8_000 },
          },
        ];
      }

      return [{ type: 'text', text: 'unexpected fallback' }];
    });

    const planted = await plantFoldableHistory({
      fixture,
      botId: fixture.bot.botId,
      prefix: 's2',
      targetNextTurnTokens: 47_000,
      contextWindow: MODEL_CONTEXT_WINDOW,
      charsPerMessage: 6_400,
    });
    assert.ok(planted.warmupTurns >= 4, `expected multiple foldable plain-text turns, got ${planted.warmupTurns}`);

    const targetRequestId = 'req-s2-provider-overflow';
    await fixture.runtime.submit(fixture.bot.botId, {
      requestId: targetRequestId,
      text: 'TURN_S2_TRIGGER: run side_effect_action once and answer after provider overflow recovery.',
      origin: USER_ORIGIN,
    });

    const terminal = await fixture.waitForSubmission(fixture.bot.botId, targetRequestId);
    assert.equal(terminal.status, 'done');

    const waited = await fixture.runtime.wait(fixture.bot.botId, targetRequestId);
    const fetched = await fixture.runtime.getSubmission(fixture.bot.botId, targetRequestId);
    assert.equal(waited.status, 'done');
    assert.equal(waited.requestId, targetRequestId);
    assert.ok(
      typeof waited.answerText === 'string' && waited.answerText.includes('RECOVERY_S2_COMPLETE'),
      `expected complete answerText from runtime.wait, got: ${JSON.stringify(waited)}`,
    );
    assert.equal(fetched.status, 'done');
    assert.equal(fetched.requestId, targetRequestId);
    assert.equal(fetched.answerText, waited.answerText);

    // Side-effectful tool must not re-run across the overflow retry.
    const counter = readCounter(fixture.counterFile);
    assert.equal(counter.count, 1, `expected side_effect_action count=1, got ${JSON.stringify(counter)}`);

    // First post-tool request passed local estimation and reached provider; retry is strictly smaller.
    assert.ok(
      postToolReqs.length >= 2,
      `expected rejected post-tool request plus smaller retry, got ${postToolReqs.length}`,
    );
    const rejectedReq = postToolReqs[0];
    const retriedReq = postToolReqs.at(-1);
    assert.ok(
      rejectedReq.estTokens < MODEL_CONTEXT_WINDOW,
      `first post-tool request (${rejectedReq.estTokens}) must have passed local estimation (< ${MODEL_CONTEXT_WINDOW})`,
    );
    assert.ok(
      retriedReq.estTokens < rejectedReq.estTokens,
      `retried request tokens (${retriedReq.estTokens}) must be smaller than rejected request (${rejectedReq.estTokens})`,
    );
    assert.ok(
      retriedReq.serializedBytes < rejectedReq.serializedBytes,
      `retried request bytes (${retriedReq.serializedBytes}) must be smaller than rejected request (${rejectedReq.serializedBytes})`,
    );

    for (const sumReq of fixture.summaryRequests) {
      assert.equal(
        sumReq.hasMainTool,
        false,
        `summary request #${sumReq.seq} must not include main tools, saw: ${JSON.stringify(sumReq.toolNames)}`,
      );
      assert.ok(
        sumReq.estTokens + sumReq.maxTokens < MODEL_CONTEXT_WINDOW,
        `summary request #${sumReq.seq} must leave output room within contextWindow`,
      );
    }
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await fixture.close(hadError);
  }
});

// ============================================================================
// 3A) Failed / 0-block same-turn compress must NOT infinitely re-inject nudge:
//     - Under high context pressure, BC injects a compress nudge on Call 1
//     - Model invokes compress with schema-valid uncompressible ref -> fails / 0 blocks
//     - Call 2 of the SAME turn receives 0 BC nudge messages, does not call compress again,
//       and finishes cleanly as done
// ============================================================================
test('Billion Context recovery (3A): failed/0-block same-turn compress does not re-inject nudge in a loop', async () => {
  const MODEL_CONTEXT_WINDOW = 48_000;
  const fixture = await openRecoveryFixture({
    label: 's3a-nudge-loop',
    contextWindow: MODEL_CONTEXT_WINDOW,
    maxTokens: 1_024,
    bcEffectiveConfig: {},
  });

  let hadError = false;
  try {
    let probePhase = false;
    let nudgeTriggered = false;
    let sameTurnCompressCalls = 0;
    let sawZeroBlockOrErrorCompressResult = false;
    const postCompressNudgeCounts = [];

    fixture.setHandler(async (reqContext, _model, _signal, record) => {
      if (record.kind === 'summary') {
        return [{ type: 'text', text: 'Summary chunk.' }];
      }

      const messages = reqContext?.messages ?? [];
      const nudges = findNudgeMessages(messages);
      const lastUser = findLastRealUserMessage(messages);
      const lastUserText = extractMessageText(lastUser);

      if (probePhase && lastUserText.includes('PROBE_NUDGE_TURN_')) {
        const compressResultMsg = messages.findLast(
          (msg) => msg?.role === 'toolResult' && msg.toolName === 'compress',
        );

        if (compressResultMsg) {
          postCompressNudgeCounts.push(nudges.length);
          const resultText = extractMessageText(compressResultMsg);
          sawZeroBlockOrErrorCompressResult ||= compressResultMsg.isError === true || /"blocksCreated":\s*0\b/.test(resultText);

          if (nudges.length > 0 && sameTurnCompressCalls < 4) {
            // Expose an infinite nudge re-injection bug while capping attempts so test terminates.
            sameTurnCompressCalls += 1;
            return [
              {
                type: 'toolCall',
                id: `call_compress_retry_${sameTurnCompressCalls}`,
                name: 'compress',
                arguments: invalidCompressArgs,
              },
            ];
          }
          return [
            {
              type: 'text',
              text: 'S3_NO_NUDGE_LOOP_DONE: completed cleanly without repeated nudge.',
            },
          ];
        }

        if (nudges.length > 0) {
          nudgeTriggered = true;
          sameTurnCompressCalls += 1;
          const compressTool = (reqContext?.tools ?? []).find((tool) => tool?.name === 'compress');
          assert.ok(compressTool, 'expected BC compress tool to be registered in main request');
          return [
            {
              type: 'toolCall',
              id: 'call_compress_fail_1',
              name: 'compress',
              arguments: invalidCompressArgs,
            },
          ];
        }

        return [
          {
            type: 'text',
            text: makeFoldableText('PROBE_ASSISTANT_NO_NUDGE_YET', 1_600),
          },
        ];
      }

      const warmupMatch = lastUserText.match(/WARMUP_TURN_(\d+)/);
      if (warmupMatch) {
        return [
          {
            type: 'text',
            text: makeFoldableText(`OLD_ARCHIVE_ASSISTANT_${warmupMatch[1]}`, 5_600),
          },
        ];
      }

      return [{ type: 'text', text: 'ok' }];
    });

    await plantFoldableHistory({
      fixture,
      botId: fixture.bot.botId,
      prefix: 's3a',
      targetNextTurnTokens: 36_000,
      contextWindow: MODEL_CONTEXT_WINDOW,
      charsPerMessage: 5_600,
    });

    probePhase = true;
    let nudgeTurnRequestId = null;
    for (let step = 1; step <= 10; step += 1) {
      const reqId = `req-s3a-probe-${step}`;
      await fixture.runtime.submit(fixture.bot.botId, {
        requestId: reqId,
        text: makeFoldableText(`PROBE_NUDGE_TURN_${step}`, 1_600),
        origin: USER_ORIGIN,
      });
      const sub = await fixture.waitForSubmission(fixture.bot.botId, reqId);
      assert.equal(sub.status, 'done');

      if (nudgeTriggered) {
        nudgeTurnRequestId = reqId;
        break;
      }

      const status = await fixture.runtime.contextStatus(fixture.bot.botId);
      const nextEst = Math.max(fixture.mainRequests.at(-1)?.estTokens ?? 0, status?.prepared?.tokenCount ?? 0) + 800;
      if (nextEst >= MODEL_CONTEXT_WINDOW - 2_500) break;
    }

    assert.ok(nudgeTriggered && nudgeTurnRequestId, 'expected BC to inject a compress nudge before overflow');
    assert.equal(
      sawZeroBlockOrErrorCompressResult,
      true,
      'expected same-turn compress call to fail or create 0 blocks',
    );
    assert.equal(
      postCompressNudgeCounts[0],
      0,
      `failed/0-block same-turn compress must not re-inject BC nudge, observed counts: ${JSON.stringify(postCompressNudgeCounts)}`,
    );
    assert.equal(
      sameTurnCompressCalls,
      1,
      `expected exactly 1 compress call in the turn without nudge loop, got ${sameTurnCompressCalls}`,
    );

    const status = await fixture.runtime.contextStatus(fixture.bot.botId);
    assert.equal((status?.blocks ?? []).length, 0, 'expected 0 blocks persisted after failed/0-block compress');

    const waited = await fixture.runtime.wait(fixture.bot.botId, nudgeTurnRequestId);
    const fetched = await fixture.runtime.getSubmission(fixture.bot.botId, nudgeTurnRequestId);
    assert.equal(waited.status, 'done');
    assert.equal(waited.requestId, nudgeTurnRequestId);
    assert.ok(
      typeof waited.answerText === 'string' && waited.answerText.includes('S3_NO_NUDGE_LOOP_DONE'),
      `expected final completion text, got: ${JSON.stringify(waited)}`,
    );
    assert.equal(fetched.status, 'done');
    assert.equal(fetched.answerText, waited.answerText);
  } catch (err) {
    hadError = true;
    throw err;
  } finally {
    await fixture.close(hadError);
  }
});

// ============================================================================
// 3B) An irreducible input still reaches the provider intact despite its local estimate.
// ============================================================================
test('A latest user input above the estimated window is sent intact', async (t) => {
  const fixture = await openRecoveryFixture({ label: 'irreducible', contextWindow: 24_000 });
  t.after(() => fixture.close());
  const requestId = 'req-irreducible';
  const input = makeFoldableText('THIS_USER_INPUT_MUST_STAY_INTACT', 120_000);
  await fixture.runtime.submit(fixture.bot.botId, { requestId, text: input, origin: USER_ORIGIN });
  const result = await fixture.waitForSubmission(fixture.bot.botId, requestId);
  assert.equal(result.status, 'done');
  assert.equal(fixture.mainRequests.length, 1);
  assert.equal(fixture.summaryRequests.length, 0);
  const request = fixture.mainRequests[0];
  assert.ok(request.estTokens > 24_000);
  const received = extractMessageText(findLastRealUserMessage(request.messages));
  assert.ok(received.endsWith(input), 'the full user text follows the Billion Context reference tag');
});

test('Opt-in autoFold compacts below the hard window without adding model nudges', async (t) => {
  const fixture = await openRecoveryFixture({
    label: 'growth',
    contextWindow: 64_000,
    bcEffectiveConfig: { autoFold: true, autoFoldTargetTokens: 22_000 },
  });
  t.after(() => fixture.close());
  fixture.setHandler(async (_request, _model, _signal, record) => record.kind === 'summary'
    ? [{ type: 'text', text: 'Archived the older conversation details while retaining its decisions and open tasks.' }]
    : [{ type: 'text', text: makeFoldableText('GROWTH_REPLY', 6400) }]);
  await plantFoldableHistory({
    fixture, botId: fixture.bot.botId, prefix: 'growth',
    contextWindow: 64_000, targetNextTurnTokens: 60_000, maxTurns: 10,
  });
  assert.ok(fixture.summaryRequests.length > 0, 'the host must fold below its hard limit');
  assert.ok(fixture.mainRequests.every((request) => request.estTokens < 64_000));
  assert.ok(fixture.mainRequests.every((request) => findNudgeMessages(request.messages).length === 0));
  const status = await fixture.runtime.contextStatus(fixture.bot.botId);
  assert.ok(status.blocks.some((block) => block.topic === 'preflight auto-fold (growth)'));
});
