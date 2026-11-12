import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GROUP_MAX_MEMBER_TURNS,
  GROUP_MAX_ROUNDS,
  MAX_REPLY_NUDGES,
  buildAgentInboundWakePrompt,
  buildClosingSendNudgePrompt,
  buildGroupTurnWakePrompt,
  evaluateGroupTurnEligibility,
  isPassContent,
  isPotentialPassPrefix,
  parseGroupMentions,
  resolveResponders,
} from '../../host-core/group-chat.js';
import { openHost } from '../../host-core/host.js';
import { applyAgentProfile, getPrimaryConversation } from '../../host-core/runtime-docs.js';
import { readPrimaryHistory } from '../../host-core/runtime-history.js';
import { createBotSessionRuntime } from '../../host-core/runtime-bot-session.js';
import { createWorkContextRuntime } from '../../host-core/runtime-work-contexts.js';
import { createWorkDecisionRuntime } from '../../host-core/runtime-work-decisions.js';
import { createCommunicationTools } from '../../host-core/communication-tools.js';
import { parseHistoryEntries } from '../src/chatTurnModel.ts';

import { BACKGROUND_CONTEXT as context } from '../../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { createModels } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';
import {
  Harness,
  createRegistry,
  defineExtension,
  hook,
  GenerationTask,
} from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';
import { openNodeSqliteStorage } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js';

test('group-chat: @mention parsing handles English, CJK longest-prefix disambiguation, email exclusion, and @everyone/@所有人', () => {
  const members = [
    { id: 'dev:1', name: '助手' },
    { id: 'dev:2', name: '助手二号' },
    { id: 'dev:3', name: 'Data Analyst' },
  ];

  // Longest handle claims the @-span so "@助手二号" does not wake "@助手"
  assert.deepEqual(parseGroupMentions('请 @助手二号 帮忙看一下', members), {
    isEveryone: false,
    memberIds: ['dev:2'],
  });

  // CJK handle followed immediately by Chinese text/punctuation matches cleanly
  assert.deepEqual(parseGroupMentions('@助手，你也看看 @data', members), {
    isEveryone: false,
    memberIds: ['dev:1', 'dev:3'],
  });

  // Email addresses do not trigger @mentions
  assert.deepEqual(parseGroupMentions('联系 dev@data.com 即可', members), {
    isEveryone: false,
    memberIds: [],
  });

  // @everyone / @所有人
  assert.equal(parseGroupMentions('@everyone sync up', members).isEveryone, true);
  assert.equal(parseGroupMentions('请 @所有人 确认', members).isEveryone, true);
});

test('group-chat: evaluateGroupTurnEligibility enforces @mention routing, GROUP_MAX_ROUNDS, and GROUP_MAX_MEMBER_TURNS', () => {
  const members = [
    { id: 'dev:a', name: 'Architect' },
    { id: 'dev:b', name: 'Builder' },
  ];

  const directHistory = [
    { id: 'm1', content: '@Builder 请执行构建', speaker: { kind: 'user' } },
  ];
  assert.deepEqual(resolveResponders(members, directHistory).map((m) => m.id), ['dev:b']);
  assert.deepEqual(
    evaluateGroupTurnEligibility({
      memberId: 'dev:a',
      members,
      recentHistory: directHistory,
      unreadMessages: directHistory,
    }),
    { eligible: false, reason: 'other_member_mentioned' },
  );
  assert.deepEqual(
    evaluateGroupTurnEligibility({
      memberId: 'dev:b',
      members,
      recentHistory: directHistory,
      unreadMessages: directHistory,
    }),
    { eligible: true, reason: 'direct_mention' },
  );

  // Per-member round cap (GROUP_MAX_ROUNDS = 3) since latest user message
  const roundCappedHistory = [
    { id: 'u1', content: '大家讨论一下', speaker: { kind: 'user' } },
    ...Array.from({ length: GROUP_MAX_ROUNDS }, (_, idx) => ({
      id: `b_${idx}`,
      content: `Builder round ${idx + 1}`,
      speaker: { kind: 'member', id: 'dev:b', name: 'Builder' },
    })),
    { id: 'a_1', content: '@Builder 再补充一下？', speaker: { kind: 'member', id: 'dev:a', name: 'Architect' } },
  ];
  assert.deepEqual(
    evaluateGroupTurnEligibility({
      memberId: 'dev:b',
      members,
      recentHistory: roundCappedHistory,
      unreadMessages: [roundCappedHistory.at(-1)],
    }),
    { eligible: false, reason: 'max_rounds' },
  );

  // Total consecutive bot turns cap (GROUP_MAX_MEMBER_TURNS = 10)
  const totalCappedHistory = [
    { id: 'u1', content: '自由讨论', speaker: { kind: 'user' } },
    ...Array.from({ length: GROUP_MAX_MEMBER_TURNS }, (_, idx) => ({
      id: `m_${idx}`,
      content: `msg ${idx}`,
      speaker: { kind: 'member', id: `dev:peer_${idx}`, name: `Peer${idx}` },
    })),
  ];
  assert.deepEqual(
    evaluateGroupTurnEligibility({
      memberId: 'dev:a',
      members,
      recentHistory: totalCappedHistory,
      unreadMessages: [totalCappedHistory.at(-1)],
    }),
    { eligible: false, reason: 'max_member_turns' },
  );

  // A fresh user message resets the caps
  const resetHistory = [
    ...totalCappedHistory,
    { id: 'u2', content: '继续下一阶段', speaker: { kind: 'user' } },
  ];
  assert.equal(
    evaluateGroupTurnEligibility({
      memberId: 'dev:a',
      members,
      recentHistory: resetHistory,
      unreadMessages: [resetHistory.at(-1)],
    }).eligible,
    true,
  );
});

test('group-chat: silent pass detection and wake/nudge prompts format cleanly', () => {
  assert.equal(isPassContent('(pass)'), true);
  assert.equal(isPassContent('  PASS. '), true);
  assert.equal(isPassContent(''), true);
  assert.equal(isPassContent('pass the salt'), false);
  assert.equal(isPotentialPassPrefix('(pa'), true);
  assert.equal(isPotentialPassPrefix('Here is the result'), false);

  const wake = buildAgentInboundWakePrompt({
    peerName: '总控助手',
    scopeId: 'scope_dm_1',
    category: 'request',
    text: '查一下磁盘空间',
    replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: 'bot_a' },
  });
  assert.ok(wake.includes('[agent]'));
  assert.ok(wake.includes('总控助手'));
  assert.ok(wake.includes('send_to'));

  const nudge = buildClosingSendNudgePrompt({
    peerName: '总控助手',
    scopeId: 'scope_dm_1',
    attempt: 1,
  });
  assert.ok(nudge.includes('closing-reply check #1'));
  assert.ok(nudge.includes('总控助手'));

  const groupWake = buildGroupTurnWakePrompt({
    memberName: '研究助手',
    memberId: 'dev:bot_b',
    group: { name: '产品评审群' },
    peers: [{ name: '总控助手', description: '负责任务编排' }],
    newMessages: [{ id: '1', content: '请评估方案', speaker: { kind: 'user' } }],
    scopeId: 'scope_room_1',
  });
  assert.ok(groupWake.includes('[Group chat: "产品评审群" - with 总控助手]'));
  assert.ok(groupWake.includes('User: 请评估方案'));
});

function createMockModels(handler) {
  const models = createModels();
  const modelDef = {
    id: 'mock-chat',
    name: 'Mock Chat',
    provider: 'mock',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:0',
    contextWindow: 128_000,
    maxTokens: 4_096,
    input: ['text'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const makeStream = (model, reqContext) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const blocks = await handler(reqContext, model);
        const hasToolCall = blocks.some((b) => b.type === 'toolCall');
        const message = {
          role: 'assistant',
          content: blocks,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: hasToolCall ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        stream.push({
          type: 'done',
          reason: hasToolCall ? 'toolUse' : 'stop',
          message,
        });
      } catch (err) {
        stream.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          },
        });
      }
    });
    return stream;
  };
  models.setProvider({
    id: 'mock',
    name: 'Mock Provider',
    auth: {
      apiKey: {
        resolve: async () => ({ auth: { apiKey: 'mock-key' }, source: 'mock' }),
      },
    },
    getModels: () => [modelDef],
    stream: makeStream,
    streamSimple: makeStream,
  });
  return models;
}

async function waitUntil(predicate, { timeoutMs = 8_000, intervalMs = 40, label = 'condition', onTimeout } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const debug = onTimeout ? await Promise.resolve(onTimeout()).catch((e) => String(e)) : '';
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}${debug ? `\nDebug: ${JSON.stringify(debug)}` : ''}`);
}

test('end-to-end runtime: full user -> Bot A -> Bot B DM task with closing nudge & resumed primary reply, "(pass)" suppression, exhausted nudges, and room @mention', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-collab-e2e-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const host = openHost({ dataRoot: join(rootDir, 'host-data') });
  const botA = host.createBot({
    requestId: 'create-a',
    role: '总控助手',
    description: '负责任务派发与汇总',
    modelRef: 'mock/mock-chat',
    makePrimary: true,
  });
  const botB = host.createBot({
    requestId: 'create-b',
    role: '研究助手',
    description: '负责数据调研',
    modelRef: 'mock/mock-chat',
  });

  const modelCalls = [];
  let scenario = 'nudge_then_reply';
  let dmScopeId = '';
  let roomScopeId = '';
  let callSeq = 0;

  const models = createMockModels(async (reqContext) => {
    callSeq += 1;
    const messages = reqContext?.messages ?? [];
    const serialized = JSON.stringify(messages);
    const fullSerialized = JSON.stringify(reqContext ?? {});
    const lastMsg = messages[messages.length - 1];
    const lastIsToolResult = lastMsg?.role === 'toolResult';
    const lastUserMsg = [...messages].reverse().find((m) => m?.role === 'user');
    const isNudge = JSON.stringify(lastUserMsg ?? {}).includes('[Host closing-reply check #');
    const isBotA = fullSerialized.includes('You are 总控助手.') || serialized.includes(`"botId":${JSON.stringify(botA.botId)}`);
    const callerBotId = isBotA ? botA.botId : botB.botId;
    modelCalls.push({ callerBotId, isNudge, lastIsToolResult, serialized });

    if (scenario === 'nudge_then_reply') {
      if (callerBotId === botA.botId) {
        const hasReplyFromB = serialized.includes('Q2 营收核实结果为 380 万');
        if (!hasReplyFromB) {
          if (!lastIsToolResult) {
            return [
              {
                type: 'toolCall',
                id: `call_dispatch_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: dmScopeId, text: '请帮我核实一下 Q2 营收数据并回传。' },
              },
            ];
          }
          return [{ type: 'text', text: '我已派发给研究助手核实，请稍候。' }];
        }
        // Resumed primary turn on Bot A after receiving Bot B's DM reply:
        // Bot A answers the user directly WITHOUT calling send_to!
        return [{ type: 'text', text: '研究助手已回传结果：Q2 营收为 380 万。' }];
      }

      // Bot B handling Bot A's DM request:
      if (!isNudge) {
        // Turn 1: Bot B writes working text in its 1v1 chat but forgets to call send_to!
        return [{ type: 'text', text: '我已核实 Q2 营收为 380 万，准备汇报。' }];
      }
      if (!lastIsToolResult) {
        // Closing Nudge #1: Bot B sees the nudge and calls send_to back to Bot A!
        return [
          {
            type: 'toolCall',
            id: `call_send_${callSeq}`,
            name: 'send_to',
            arguments: { scopeId: dmScopeId, text: 'Q2 营收核实结果为 380 万。' },
          },
        ];
      }
      return [{ type: 'text', text: '已通过 send_to 将结果回传给总控助手。' }];
    }

    if (scenario === 'silent_pass') {
      if (callerBotId === botA.botId) return [{ type: 'text', text: 'ack' }];
      if (!lastIsToolResult) {
        return [
          {
            type: 'toolCall',
            id: `call_pass_${callSeq}`,
            name: 'send_to',
            arguments: { scopeId: dmScopeId, text: '(pass)' },
          },
        ];
      }
      return [];
    }

    if (scenario === 'exhaust_nudges') {
      // Never calls send_to even across nudges
      return [{ type: 'text', text: '仅在本地思考，未调用 send_to。' }];
    }

    if (scenario === 'room_mention') {
      if (!lastIsToolResult) {
        return [
          {
            type: 'toolCall',
            id: `call_room_${callSeq}`,
            name: 'send_to',
            arguments: { scopeId: roomScopeId, text: '收到点名，研究进度正常！' },
          },
        ];
      }
      return [];
    }

    return [{ type: 'text', text: 'done' }];
  });

  const registry = createRegistry();
  let harness = null;
  let workContexts = null;
  let sessions = null;
  let decisions = null;
  let coreExtensions = [];

  const makeProfile = (bot) => ({
    instructions: `You are ${bot.role}.`,
    thinkingLevel: 'off',
    removeTools: [],
    selectedExtensions: coreExtensions,
    codemodeOnly: false,
  });

  sessions = createBotSessionRuntime({
    host,
    getHarness: () => harness,
    getMessageLog: () => workContexts.getMessageLog(),
    context,
    getPrimary: async (bot) => {
      const profile = makeProfile(bot);
      const conversation = await getPrimaryConversation(
        harness,
        bot,
        {
          create: true,
          defaultModel: 'mock/mock-chat',
          thinkingLevel: profile.thinkingLevel,
          instructions: profile.instructions,
          removeTools: profile.removeTools,
          selectedExtensions: profile.selectedExtensions,
          codemodeOnly: profile.codemodeOnly,
        },
        context,
      );
      await applyAgentProfile(harness, conversation.id, profile, context);
      return conversation;
    },
  });

  const botQueues = new Map();
  const admitBot = (botId, fn) => {
    const prev = botQueues.get(botId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    botQueues.set(botId, next.catch(() => {}));
    return next;
  };

  decisions = createWorkDecisionRuntime({
    sessions,
    host,
    getHarness: () => harness,
    getWorkContexts: () => workContexts,
    models,
    defaultModel: 'mock/mock-chat',
    context,
    admitBot,
    getProfile: (botId) => makeProfile(host.getBot(botId) ?? { role: 'Assistant' }),
  });

  const commExtension = defineExtension({
    name: 'host.communication',
    tools: createCommunicationTools({
      host,
      getHarness: () => harness,
      getMessageLog: () => workContexts.getMessageLog(),
      publishWork: decisions.publishWork,
      passWork: decisions.passWork,
      collaboration: null,
      sessions,
    }),
  });
  const sessionHooksExtension = defineExtension({
    name: 'host.session-hooks',
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(req, api, ctx) {
          const out = await sessions.beforeRequest(req, api, ctx);
          await decisions.beforeRequest(out, api, ctx);
          return out;
        },
      }),
    ],
  });
  registry.install(commExtension);
  registry.install(sessionHooksExtension);
  coreExtensions = registry.snapshot().installed();

  const storage = await openNodeSqliteStorage(join(rootDir, 'durable.sqlite'));
  harness = await Harness.open(storage, {
    registry,
    models,
    settings: { extensions: coreExtensions },
  }, context);
  workContexts = createWorkContextRuntime({
    host,
    harness,
    context,
    sessions,
    getProfile: () => ({ instructions: 'Work coord', removeTools: [], selectedExtensions: coreExtensions }),
  });

  try {
    await harness.resume(context);
    decisions.resume();

    const log = workContexts.getMessageLog();
    const dmCreated = log.createScope({
      requestId: 'mk-dm-1',
      kind: 'dm',
      members: [
        { deviceId: host.deviceId, botId: botA.botId },
        { deviceId: host.deviceId, botId: botB.botId },
      ],
    });
    dmScopeId = dmCreated.scope.scopeId;

    // --- 1) User -> Bot A (send_to request) -> Bot B (1v1 work + Closing Nudge #1 + send_to reply) -> Bot A (resumed primary, 0 nudges)! ---
    scenario = 'nudge_then_reply';
    modelCalls.length = 0;

    const primaryConvA = await getPrimaryConversation(
      harness,
      botA,
      {
        create: true,
        defaultModel: 'mock/mock-chat',
        thinkingLevel: 'off',
        instructions: `You are ${botA.role}.`,
        removeTools: [],
        selectedExtensions: coreExtensions,
        codemodeOnly: false,
      },
      context,
    );
    await applyAgentProfile(harness, primaryConvA.id, makeProfile(botA), context);
    await primaryConvA.submit(
      {
        type: 'input',
        content: '请让研究助手核实一下 Q2 营收数据并告诉我。',
        requestId: 'user-req-1',
        whenBusy: 'reject',
      },
      context,
    );

    const { settledA, settledB } = await waitUntil(
      async () => {
        const items = log.history(dmScopeId, { order: 'ascending', limit: 20 }).items;
        if (items.length < 2) return null;
        const replyItem = items[1];
        const actB = await decisions.getWorkActivity(botB.botId, dmScopeId);
        const actA = await decisions.getWorkActivity(botA.botId, dmScopeId);
        if (actB.lastDecision?.outcome !== 'published' || actB.pending !== null) return null;
        if (actA.lastDecision?.throughLocalId !== replyItem.localId || actA.pending !== null) return null;
        return { settledA: actA, settledB: actB };
      },
      {
        label: 'round-trip DM dispatch + nudge + resumed primary reply',
        onTimeout: async () => ({
          dmItems: log.history(dmScopeId, { order: 'ascending', limit: 20 }).items.map((i) => ({ localId: i.localId, cat: i.message.category, text: i.message.text })),
          actA: await decisions.getWorkActivity(botA.botId, dmScopeId),
          actB: await decisions.getWorkActivity(botB.botId, dmScopeId),
          calls: modelCalls.map((c) => ({ bot: c.callerBotId === botA.botId ? 'A' : 'B', isNudge: c.isNudge, lastIsToolResult: c.lastIsToolResult })),
        }),
      },
    );

    assert.equal(settledB.lastDecision.outcome, 'published');
    // Bot A resumed its primary user turn and answered the user in plain text -> settles as 'silent' with ZERO nudges!
    assert.equal(settledA.lastDecision.outcome, 'silent');
    assert.equal(modelCalls.filter((c) => c.callerBotId === botA.botId && c.isNudge).length, 0);
    // Bot B ran initial turn + Closing Nudge #1!
    assert.ok(modelCalls.some((c) => c.callerBotId === botB.botId && !c.isNudge));
    assert.ok(modelCalls.some((c) => c.callerBotId === botB.botId && c.isNudge));

    const dmHistoryAfter1 = log.history(dmScopeId, { order: 'ascending', limit: 20 }).items;
    assert.equal(dmHistoryAfter1.length, 2);
    assert.equal(dmHistoryAfter1[0].message.author.botId, botA.botId);
    assert.equal(dmHistoryAfter1[0].message.category, 'request');
    assert.equal(dmHistoryAfter1[1].message.author.botId, botB.botId);
    assert.equal(dmHistoryAfter1[1].message.category, 'reply');
    assert.equal(dmHistoryAfter1[1].message.replyTo, dmHistoryAfter1[0].message.messageId);
    assert.equal(dmHistoryAfter1[1].message.text, 'Q2 营收核实结果为 380 万。');

    // Verify 1v1 chat UI projection on Bot B's primary conversation!
    const knownBots = [
      { botId: botA.botId, deviceId: host.deviceId, role: botA.role },
      { botId: botB.botId, deviceId: host.deviceId, role: botB.role },
    ];
    const primaryConvB = await getPrimaryConversation(harness, botB, {}, context);
    const rawHistoryB = await readPrimaryHistory(primaryConvB, { limit: 50 }, context, { harness });
    const uiTurnsB = parseHistoryEntries(rawHistoryB.items, 0, {
      selfBotId: botB.botId,
      knownBots,
    });
    assert.ok(uiTurnsB.some((turn) => turn.role === 'user' && turn.attribution?.name === '总控助手' && turn.text.includes('核实一下 Q2 营收数据')));
    assert.ok(uiTurnsB.some((turn) => turn.role === 'assistant' && turn.text.includes('380 万')));
    assert.ok(
      uiTurnsB.some((turn) =>
        turn.tools?.some(
          (tool) =>
            tool.name === 'send_to' &&
            tool.sendTo?.category === 'reply' &&
            tool.sendTo?.targetName === '总控助手',
        ),
      ),
    );

    // Verify 1v1 chat UI projection on Bot A's primary conversation!
    const rawHistoryA = await readPrimaryHistory(primaryConvA, { limit: 50 }, context, { harness });
    const uiTurnsA = parseHistoryEntries(rawHistoryA.items, 0, {
      selfBotId: botA.botId,
      knownBots,
    });
    assert.ok(
      uiTurnsA.some((turn) =>
        turn.tools?.some(
          (tool) =>
            tool.name === 'send_to' &&
            tool.sendTo?.category === 'request' &&
            tool.sendTo?.targetName === '研究助手',
        ),
      ),
    );
    assert.ok(uiTurnsA.some((turn) => turn.role === 'user' && turn.attribution?.name === '研究助手' && turn.text.includes('Q2 营收核实结果为 380 万')));
    assert.ok(uiTurnsA.some((turn) => turn.role === 'assistant' && turn.text.includes('研究助手已回传结果：Q2 营收为 380 万')));

    // --- 2) DM Request with "(pass)" -> No publication, zero nudges! ---
    scenario = 'silent_pass';
    modelCalls.length = 0;
    const req2 = log.publish({
      messageId: 'dm-req-2',
      scopeId: dmScopeId,
      author: { kind: 'bot', botId: botA.botId },
      category: 'request',
      text: 'FYI：今晚维护窗口已取消，无需回复。',
      replyTo: null,
    });

    const settled2 = await waitUntil(async () => {
      const act = await decisions.getWorkActivity(botB.botId, dmScopeId);
      return act.lastDecision?.throughLocalId === req2.localId && act.pending === null ? act : null;
    });
    assert.equal(settled2.lastDecision.outcome, 'silent');
    assert.equal(modelCalls.filter((c) => c.callerBotId === botB.botId && c.isNudge).length, 0);
    // Only req1, reply1, req2 exist in ledger — "(pass)" published nothing!
    assert.equal(log.history(dmScopeId, { order: 'ascending', limit: 20 }).items.length, 3);

    // --- 3) DM Request exhausting MAX_REPLY_NUDGES -> Settles cleanly as 'silent' ---
    scenario = 'exhaust_nudges';
    modelCalls.length = 0;
    const req3 = log.publish({
      messageId: 'dm-req-3',
      scopeId: dmScopeId,
      author: { kind: 'bot', botId: botA.botId },
      category: 'request',
      text: '请再查一下 Q3 预测。',
      replyTo: null,
    });

    const settled3 = await waitUntil(async () => {
      const act = await decisions.getWorkActivity(botB.botId, dmScopeId);
      return act.lastDecision?.throughLocalId === req3.localId && act.pending === null ? act : null;
    });
    assert.equal(settled3.lastDecision.outcome, 'silent');
    const botBCalls3 = modelCalls.filter((c) => c.callerBotId === botB.botId);
    assert.equal(botBCalls3.length, 1 + MAX_REPLY_NUDGES);
    // Still only 4 messages (req1, reply1, req2, req3) — no synthetic fallback message published!
    assert.equal(log.history(dmScopeId, { order: 'ascending', limit: 20 }).items.length, 4);

    // --- 4) Room @mention routing: only mentioned Bot B runs; unmentioned Bot A skips LLM call ---
    const roomCreated = log.createScope({
      requestId: 'mk-room-1',
      kind: 'room',
      title: '项目协作群',
      members: [
        { deviceId: host.deviceId, botId: botA.botId },
        { deviceId: host.deviceId, botId: botB.botId },
      ],
    });
    roomScopeId = roomCreated.scope.scopeId;
    scenario = 'room_mention';
    modelCalls.length = 0;

    const roomMsg1 = log.publish({
      messageId: 'room-msg-1',
      scopeId: roomScopeId,
      author: { kind: 'user' },
      category: 'public',
      text: '@研究助手 请在群里同步一下进度',
      replyTo: null,
    });

    await waitUntil(async () => {
      const actA = await decisions.getWorkActivity(botA.botId, roomScopeId);
      const actB = await decisions.getWorkActivity(botB.botId, roomScopeId);
      return (
        actA.handledLocalId >= roomMsg1.localId &&
        actA.pending === null &&
        actB.lastDecision?.outcome === 'published' &&
        actB.pending === null
      );
    });

    // Unmentioned Bot A made ZERO model calls for @研究助手's message!
    assert.equal(modelCalls.filter((c) => c.callerBotId === botA.botId).length, 0);
    assert.ok(modelCalls.filter((c) => c.callerBotId === botB.botId).length >= 1);

    const roomHistory = log.history(roomScopeId, { order: 'ascending', limit: 20 }).items;
    assert.ok(
      roomHistory.some(
        (it) => it.message.author.kind === 'bot' && it.message.author.botId === botB.botId && it.message.text.includes('进度正常'),
      ),
    );
  } finally {
    await decisions.close();
    await workContexts.close();
    await harness.close(context);
    host.close();
  }
});
