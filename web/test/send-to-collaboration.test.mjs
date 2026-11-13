import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GROUP_MAX_MEMBER_TURNS,
  GROUP_MAX_MESSAGES_PER_TURN,
  GROUP_MAX_ROUNDS,
  MAX_REPLY_NUDGES,
  buildAgentInboundWakePrompt,
  buildClosingSendNudgePrompt,
  buildGroupRedriveNote,
  buildGroupTurnWakePrompt,
  evaluateGroupTurnEligibility,
  isPassContent,
  isPotentialPassPrefix,
  orderRoundSpeakers,
  parseGroupMentions,
  resolveResponders,
} from '../../host-core/group-chat.js';
import { GroupChatOrchestrator, RoomTurnScheduler } from '../../host-core/group-chat-orchestrator.js';
import { openHost } from '../../host-core/host.js';
import { openMessageLog } from '../../host-core/messages.js';
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
  let opsRoomScopeId = '';
  let backlogRoomScopeId = '';
  let callSeq = 0;

  const models = createMockModels(async (reqContext) => {
    callSeq += 1;
    const messages = reqContext?.messages ?? [];
    const serialized = JSON.stringify(messages);
    const fullSerialized = JSON.stringify(reqContext ?? {});
    const lastMsg = messages[messages.length - 1];
    const lastIsToolResult = lastMsg?.role === 'toolResult';
    const lastUserMsg = [...messages].reverse().find((m) => m?.role === 'user');
    const wakePrompt = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg ?? {});
    const sysPrompt = typeof reqContext?.systemPrompt === 'string' ? reqContext.systemPrompt : '';
    const isNudge = wakePrompt.includes('[Host closing-reply check #');
    const isBotA = sysPrompt
      ? sysPrompt.includes('You are 总控助手.')
      : (fullSerialized.includes('You are 总控助手.') || serialized.includes(`"botId":${JSON.stringify(botA.botId)}`));
    const callerBotId = isBotA ? botA.botId : botB.botId;
    modelCalls.push({ callerBotId, isNudge, lastIsToolResult, serialized, wakePrompt, sysPrompt });

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

    if (scenario === 'cross_scope_publish_nudge') {
      if (callerBotId === botA.botId) {
        if (!isNudge) {
          if (!lastIsToolResult) {
            // Bot A sends to ANOTHER room instead of replying to Bot B's inbound 1v1 DM!
            return [
              {
                type: 'toolCall',
                id: `call_cross_pub_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: opsRoomScopeId, text: '大群播报：正在确认发布窗口' },
              },
            ];
          }
          return [{ type: 'text', text: '已先在大群播报，暂未回复私信。' }];
        }
        // DM closing nudge must still fire! Bot A now replies to Bot B's DM.
        if (!lastIsToolResult) {
          return [
            {
              type: 'toolCall',
              id: `call_dm_after_cross_pub_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: dmScopeId, text: '发布窗口已确认为今晚 22:00。' },
            },
          ];
        }
        return [{ type: 'text', text: '已在追问后私信回复研究助手。' }];
      }
      return [{ type: 'text', text: 'ack' }];
    }

    if (scenario === 'cross_scope_pass_nudge') {
      if (callerBotId === botA.botId) {
        if (!isNudge) {
          if (!lastIsToolResult) {
            // Bot A sends "(pass)" to ANOTHER room instead of passing/replying on Bot B's DM!
            return [
              {
                type: 'toolCall',
                id: `call_cross_pass_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: opsRoomScopeId, text: '(pass)' },
              },
            ];
          }
          return [{ type: 'text', text: '另一群聊无需发言。' }];
        }
        // DM closing nudge must still fire! Bot A now replies to Bot B's DM.
        if (!lastIsToolResult) {
          return [
            {
              type: 'toolCall',
              id: `call_dm_after_cross_pass_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: dmScopeId, text: '回滚预案已就绪。' },
            },
          ];
        }
        return [{ type: 'text', text: '已私信回复回滚预案状态。' }];
      }
      return [{ type: 'text', text: 'ack' }];
    }

    if (scenario === 'room_backlog_cursor') {
      if (!lastIsToolResult) {
        return [
          {
            type: 'toolCall',
            id: `call_backlog_pass_${callSeq}`,
            name: 'send_to',
            arguments: { scopeId: backlogRoomScopeId, text: '(pass)' },
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

    // --- 5) Cross-scope send_to / "(pass)" to another room does NOT satisfy inbound 1v1 DM replyRequired ---
    const opsRoomCreated = log.createScope({
      requestId: 'mk-ops-room-1',
      kind: 'room',
      title: '播报通知群',
      members: [
        { deviceId: host.deviceId, botId: botA.botId },
        { deviceId: host.deviceId, botId: botB.botId },
      ],
    });
    opsRoomScopeId = opsRoomCreated.scope.scopeId;
    await decisions.stopWork(botB.botId, opsRoomScopeId);

    // 5a: Cross-scope publish to opsRoomScopeId must keep DM pending.published = false and trigger DM closing nudge!
    scenario = 'cross_scope_publish_nudge';
    modelCalls.length = 0;
    const dmFromB1 = log.publish({
      messageId: 'dm-from-b-1',
      scopeId: dmScopeId,
      author: { kind: 'bot', botId: botB.botId },
      category: 'request',
      text: '请总控助手确认今晚发布窗口并私信回复我。',
      replyTo: null,
    });

    const settledCrossPub = await waitUntil(
      async () => {
        const actA = await decisions.getWorkActivity(botA.botId, dmScopeId);
        return actA.lastDecision?.throughLocalId === dmFromB1.localId && actA.pending === null ? actA : null;
      },
      { label: 'cross-scope room publish still triggers DM closing nudge' },
    );
    assert.equal(settledCrossPub.lastDecision.outcome, 'published');
    assert.ok(
      log.history(opsRoomScopeId, { order: 'ascending', limit: 10 }).items.some(
        (it) => it.message.text === '大群播报：正在确认发布窗口',
      ),
      'cross-scope room send_to still publishes to target room',
    );
    assert.ok(modelCalls.some((c) => c.callerBotId === botA.botId && !c.isNudge));
    assert.ok(
      modelCalls.some((c) => c.callerBotId === botA.botId && c.isNudge),
      'expected DM closing nudge when Bot A only published to another room in Turn 1',
    );
    assert.ok(
      log.history(dmScopeId, { order: 'ascending', limit: 20 }).items.some(
        (it) =>
          it.message.author.kind === 'bot' &&
          it.message.author.botId === botA.botId &&
          it.message.category === 'reply' &&
          it.message.replyTo === 'dm-from-b-1' &&
          it.message.text === '发布窗口已确认为今晚 22:00。',
      ),
    );

    // 5b: Cross-scope "(pass)" to opsRoomScopeId must keep DM pending.passed = false and trigger DM closing nudge!
    scenario = 'cross_scope_pass_nudge';
    modelCalls.length = 0;
    const dmFromB2 = log.publish({
      messageId: 'dm-from-b-2',
      scopeId: dmScopeId,
      author: { kind: 'bot', botId: botB.botId },
      category: 'request',
      text: '再确认一下回滚预案是否就绪？',
      replyTo: null,
    });

    const settledCrossPass = await waitUntil(
      async () => {
        const actA = await decisions.getWorkActivity(botA.botId, dmScopeId);
        return actA.lastDecision?.throughLocalId === dmFromB2.localId && actA.pending === null ? actA : null;
      },
      { label: 'cross-scope room "(pass)" still triggers DM closing nudge' },
    );
    assert.equal(settledCrossPass.lastDecision.outcome, 'published');
    assert.ok(modelCalls.some((c) => c.callerBotId === botA.botId && !c.isNudge));
    assert.ok(
      modelCalls.some((c) => c.callerBotId === botA.botId && c.isNudge),
      'expected DM closing nudge when Bot A only sent "(pass)" to another room in Turn 1',
    );
    assert.ok(
      log.history(dmScopeId, { order: 'ascending', limit: 20 }).items.some(
        (it) =>
          it.message.author.kind === 'bot' &&
          it.message.author.botId === botA.botId &&
          it.message.category === 'reply' &&
          it.message.replyTo === 'dm-from-b-2' &&
          it.message.text === '回滚预案已就绪。',
      ),
    );

    // --- 6) Room batchThrough cursor anchoring when >32 messages are backlogged ---
    const backlogRoomCreated = log.createScope({
      requestId: 'mk-backlog-room-1',
      kind: 'room',
      title: '积压游标锚定群',
      members: [
        { deviceId: host.deviceId, botId: botA.botId },
        { deviceId: host.deviceId, botId: botB.botId },
      ],
    });
    backlogRoomScopeId = backlogRoomCreated.scope.scopeId;
    await decisions.stopWork(botA.botId, backlogRoomScopeId);
    await decisions.stopWork(botB.botId, backlogRoomScopeId);

    // Seed 240 messages:
    // - Batch 1 (#1..#200, inbox page limit = 200) ends with #200 @研究助手 -> batchThrough = msg200.localId.
    // - Batch 2 (#201..#240, 40 newer messages > 32) sits after batchThrough and ends with 10 consecutive Bot A turns (GROUP_MAX_MEMBER_TURNS).
    for (let i = 1; i <= 199; i += 1) {
      log.publish({
        messageId: `backlog-m-${i}`,
        scopeId: backlogRoomScopeId,
        author: { kind: 'user' },
        category: 'public',
        text: `第一批背景记录 #${i}`,
        replyTo: null,
      });
    }
    const msg200 = log.publish({
      messageId: 'backlog-m-200',
      scopeId: backlogRoomScopeId,
      author: { kind: 'user' },
      category: 'public',
      text: '@研究助手 第一批第200条锚点问题：请确认游标锚定',
      replyTo: null,
    });
    for (let i = 201; i <= 229; i += 1) {
      log.publish({
        messageId: `backlog-m-${i}`,
        scopeId: backlogRoomScopeId,
        author: { kind: 'user' },
        category: 'public',
        text: `第二批过渡背景 #${i}`,
        replyTo: null,
      });
    }
    log.publish({
      messageId: 'backlog-m-230',
      scopeId: backlogRoomScopeId,
      author: { kind: 'user' },
      category: 'public',
      text: '第二批自由讨论开始',
      replyTo: null,
    });
    let msg240 = null;
    for (let i = 231; i <= 240; i += 1) {
      msg240 = log.publish({
        messageId: `backlog-m-${i}`,
        scopeId: backlogRoomScopeId,
        author: { kind: 'bot', botId: botA.botId },
        category: 'public',
        text: `总控尾部连续发言 #${i}`,
        replyTo: null,
      });
    }
    assert.ok(msg240.localId - msg200.localId >= 40, 'more than 32 messages backlogged after batchThrough');

    while ((await workContexts.syncWorkContext(botB.botId, backlogRoomScopeId, { limit: 200 })).hasMore) {
      /* pre-import all 240 messages into WorkContextState */
    }

    scenario = 'room_backlog_cursor';
    modelCalls.length = 0;
    await decisions.resumeWork(botB.botId, backlogRoomScopeId);

    await waitUntil(
      async () => {
        const actB = await decisions.getWorkActivity(botB.botId, backlogRoomScopeId);
        return actB.handledLocalId >= msg240.localId && actB.pending === null ? actB : null;
      },
      {
        timeoutMs: 10_000,
        label: 'backlog room Batch 1 + Batch 2 settled',
        onTimeout: async () => ({
          actB: await decisions.getWorkActivity(botB.botId, backlogRoomScopeId),
          calls: modelCalls.length,
        }),
      },
    );

    const backlogCallsB = modelCalls.filter(
      (c) => c.callerBotId === botB.botId && c.wakePrompt.includes('[Group chat: "积压游标锚定群"') && !c.lastIsToolResult,
    );
    assert.equal(
      backlogCallsB.length,
      1,
      `Bot B should wake once for Batch 1 (#1..#200) and skip Batch 2 (max_member_turns); got calls=${JSON.stringify(
        modelCalls.map((c) => ({
          callerBotId: c.callerBotId,
          lastIsToolResult: c.lastIsToolResult,
          sys: c.sysPrompt.slice(0, 40),
          wake: c.wakePrompt.slice(0, 160),
        })),
      )}`,
    );
    const firstBacklogWake = backlogCallsB[0];
    assert.equal(
      firstBacklogWake.wakePrompt.includes('第一批第200条锚点问题：请确认游标锚定'),
      true,
      `wake prompt must anchor public history at batchThrough (#200) even when 40 newer messages exist after it; got wakePrompt=${firstBacklogWake.wakePrompt}`,
    );
    assert.equal(
      firstBacklogWake.wakePrompt.includes('第一批背景记录 #199'),
      true,
      'recentHistory before batchThrough (#199) must be preserved in group prompt',
    );
    assert.equal(
      firstBacklogWake.wakePrompt.includes('总控尾部连续发言'),
      false,
      'messages after batchThrough (#231..#240) must not leak into Batch 1 wake prompt',
    );
    assert.equal(
      firstBacklogWake.wakePrompt.includes('第二批过渡背景'),
      false,
      'messages after batchThrough (#201..#229) must not leak into Batch 1 wake prompt',
    );
  } finally {
    await decisions.close();
    await workContexts.close();
    await harness.close(context);
    host.close();
  }
});

test('scope-offer tombstones & revisions: deleting member Bots before dissolving or updating a room does not trap zombie replicas', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-scope-tombstone-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const dirA = join(rootDir, 'host-a');
  const dirB = join(rootDir, 'host-b');
  const initA = openHost({ dataRoot: dirA });
  const primaryBotA = initA.createBot({ requestId: 'a-primary', role: 'A主助手', modelRef: 'mock/mock-chat', makePrimary: true });
  const secondBotA = initA.createBot({ requestId: 'a-second', role: 'A常驻成员', modelRef: 'mock/mock-chat' });
  const tempBotA = initA.createBot({ requestId: 'a-temp', role: 'A临时成员', modelRef: 'mock/mock-chat' });
  const deviceA = initA.deviceId;
  initA.close();

  const initB = openHost({ dataRoot: dirB });
  initB.createBot({ requestId: 'b-primary', role: 'B主助手', modelRef: 'mock/mock-chat', makePrimary: true });
  const tempBotB = initB.createBot({ requestId: 'b-temp', role: 'B临时成员', modelRef: 'mock/mock-chat' });
  const deviceB = initB.deviceId;
  initB.close();

  // 1) Create room on Host A, replicate rev=1 to Host B, publish a message, then delete both member Bots BEFORE deleteScope.
  let logA = openMessageLog({ dataRoot: dirA });
  let logB = openMessageLog({ dataRoot: dirB });
  let room1Id = '';
  try {
    const created = logA.createScope({
      requestId: 'req-create-zombie-room',
      kind: 'room',
      members: [
        { deviceId: deviceA, botId: tempBotA.botId },
        { deviceId: deviceB, botId: tempBotB.botId },
      ],
    });
    room1Id = created.scope.scopeId;
    const offer1 = logA.scopeOffers().items.find((o) => o.record.scope.scopeId === room1Id);
    assert.ok(offer1, 'Host A queues rev=1 offer for Host B');
    const ack1 = logB.acceptScopeOffer({ deviceId: deviceA }, offer1.record);
    logA.acknowledgeScope({ deviceId: deviceB }, ack1);

    const published = logA.publish({
      messageId: 'msg-before-bot-delete',
      scopeId: room1Id,
      author: { kind: 'user' },
      category: 'public',
      text: 'hello room',
    });
    logB.receive({ deviceId: deviceA }, published.message);
    assert.equal(logB.history(room1Id, { limit: 10 }).items.length, 1);
  } finally {
    logA.close();
    logB.close();
  }

  // Delete the participating member Bots on both hosts while the room still exists.
  const mutA = openHost({ dataRoot: dirA });
  mutA.deleteBot(tempBotA.botId);
  mutA.close();

  const mutB = openHost({ dataRoot: dirB });
  mutB.deleteBot(tempBotB.botId);
  mutB.close();

  logA = openMessageLog({ dataRoot: dirA });
  logB = openMessageLog({ dataRoot: dirB });
  try {
    // Updating title on an already-installed room whose local Bot was deleted succeeds,
    // while adding a brand-new nonexistent local Bot on Host B still rejects with BOT_NOT_FOUND.
    const renamed = logA.updateScope(room1Id, {
      requestId: 'req-rename-after-bot-delete',
      expectedRevision: 1,
      title: '改名后待解散',
    });
    assert.equal(renamed.scope.revision, 2);
    const renameOffer = logA.scopeOffers().items.find(
      (o) => o.record.scope.scopeId === room1Id && o.record.scope.revision === 2,
    );
    const renameAck = logB.acceptScopeOffer({ deviceId: deviceA }, renameOffer.record);
    logA.acknowledgeScope({ deviceId: deviceB }, renameAck);
    assert.equal(logB.getScopeState(room1Id).scope.title, '改名后待解散');

    assert.throws(
      () =>
        logB.acceptScopeOffer(
          { deviceId: deviceA },
          {
            authorityDeviceId: deviceA,
            scope: {
              scopeId: 'brand-new-invalid-room',
              kind: 'room',
              revision: 1,
              members: [
                { deviceId: deviceA, botId: 'any-remote-bot' },
                { deviceId: deviceB, botId: 'nonexistent-local-bot' },
              ],
            },
          },
        ),
      (err) => err?.code === 'BOT_NOT_FOUND',
    );

    // Dissolving the room on Host A produces a deletedAt tombstone that Host B accepts despite tempBotB being deleted.
    const dissolved = logA.deleteScope(room1Id, {
      requestId: 'req-dissolve-after-bot-delete',
      expectedRevision: 2,
    });
    assert.ok(dissolved.scope.deletedAt, 'authority records deletedAt tombstone');

    const tombstoneOffer = logA.scopeOffers().items.find(
      (o) => o.record.scope.scopeId === room1Id && o.record.scope.revision === 3,
    );
    assert.ok(tombstoneOffer, 'authority offers tombstone revision');

    const tombstoneAck = logB.acceptScopeOffer({ deviceId: deviceA }, tombstoneOffer.record);
    logA.acknowledgeScope({ deviceId: deviceB }, tombstoneAck);

    assert.equal(
      logB.listScopeStates().items.some((s) => s.scope.scopeId === room1Id),
      false,
      'Host B removes dissolved room from active listScopeStates',
    );
    assert.equal(logB.history(room1Id, { limit: 10 }).items.length, 0, 'Host B purges room message ledger on tombstone');
    assert.equal(logA.getScopeState(room1Id).delivery?.fullyAcknowledged, true, 'Host A delivery settles as fully acked');

    // 2) Head-of-line blocking guard: if rev=1 targeted a deleted Bot on Host B (never installed on B),
    // and rev=2 removed Host B before rev=3 dissolved the room while Host B was offline,
    // scopeOffers() skips obsolete pre-delete pending offers and delivers ONLY the terminal tombstone.
    const orphanCreated = logA.createScope({
      requestId: 'req-create-stale-target-room',
      kind: 'room',
      members: [
        { deviceId: deviceA, botId: primaryBotA.botId },
        { deviceId: deviceB, botId: tempBotB.botId },
      ],
    });
    const room2Id = orphanCreated.scope.scopeId;
    logA.updateScope(room2Id, {
      requestId: 'req-remove-b-before-delete',
      expectedRevision: 1,
      members: [
        { deviceId: deviceA, botId: primaryBotA.botId },
        { deviceId: deviceA, botId: secondBotA.botId },
      ],
    });
    logA.deleteScope(room2Id, {
      requestId: 'req-delete-room2',
      expectedRevision: 2,
    });

    const room2Offers = logA.scopeOffers().items.filter((o) => o.record.scope.scopeId === room2Id);
    assert.equal(room2Offers.length, 1, 'only the terminal tombstone offer remains active in scopeOffers');
    assert.equal(room2Offers[0].record.scope.revision, 3);
    assert.ok(room2Offers[0].record.scope.deletedAt);

    const room2Ack = logB.acceptScopeOffer({ deviceId: deviceA }, room2Offers[0].record);
    logA.acknowledgeScope({ deviceId: deviceB }, room2Ack);
    assert.equal(logA.scopeOffers().items.filter((o) => o.record.scope.scopeId === room2Id).length, 0);
    assert.equal(logB.listScopeStates().items.some((s) => s.scope.scopeId === room2Id), false);
  } finally {
    logA.close();
    logB.close();
  }
});

test('group-chat-orchestrator: RoomTurnScheduler enforces concurrency=1 per room and GroupChatOrchestrator rotates speakers, caps messages, and honors turnEpochs', async () => {
  const scheduler = new RoomTurnScheduler();
  let room1Active = 0;
  let room1MaxActive = 0;
  let totalParallel = 0;
  let maxParallelAcrossRooms = 0;
  const order = [];

  const mkTask = (roomId, label, delayMs) =>
    scheduler.enqueueExclusive(roomId, async () => {
      if (roomId === 'room-1') {
        room1Active += 1;
        room1MaxActive = Math.max(room1MaxActive, room1Active);
      }
      totalParallel += 1;
      maxParallelAcrossRooms = Math.max(maxParallelAcrossRooms, totalParallel);
      order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`end:${label}`);
      totalParallel -= 1;
      if (roomId === 'room-1') room1Active -= 1;
      return label;
    });

  const results = await Promise.all([
    mkTask('room-1', 'r1-a', 25),
    mkTask('room-1', 'r1-b', 15),
    mkTask('room-1', 'r1-c', 10),
    mkTask('room-2', 'r2-a', 20),
  ]);
  assert.deepEqual(results, ['r1-a', 'r1-b', 'r1-c', 'r2-a']);
  assert.equal(room1MaxActive, 1, 'same room must never exceed concurrency = 1');
  assert.ok(maxParallelAcrossRooms >= 2, 'distinct rooms remain independent');
  assert.deepEqual(
    order.filter((e) => e.includes('r1-')),
    ['start:r1-a', 'end:r1-a', 'start:r1-b', 'end:r1-b', 'start:r1-c', 'end:r1-c'],
  );

  assert.deepEqual(orderRoundSpeakers(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(orderRoundSpeakers(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
  assert.deepEqual(orderRoundSpeakers(['a', 'b', 'c'], 2), ['c', 'a', 'b']);

  const members = [
    { id: 'dev:a', name: 'Opus', description: '架构' },
    { id: 'dev:b', name: 'Astra', description: '后端' },
    { id: 'dev:c', name: 'Carbon', description: '测试' },
  ];
  const history = [{ id: 'u1', content: '大家讨论一下方案', speaker: { kind: 'user', name: 'Alice' } }];
  const callLog = [];
  const epoch1 = scheduler.nextTurnEpoch('room-1');

  const orchestrator = new GroupChatOrchestrator({
    resolveMembers: async () => members,
    readHistory: () => [...history],
    isCurrent: () => scheduler.currentTurnEpoch('room-1') === epoch1,
    postMemberMessage: (member, content) => {
      history.push({
        id: `m-${history.length}`,
        content,
        speaker: { kind: 'member', id: member.id, name: member.name },
      });
    },
    runMemberTurn: async ({ member, round, newMessages }) => {
      callLog.push({ id: member.id, round, seen: newMessages.map((m) => m.content) });
      if (round === 0) {
        if (member.id === 'dev:a') {
          // Returns 3 messages + a "(pass)" — orchestrator must strip "(pass)" and cap at 2!
          return ['(pass)', 'Opus观点1', 'Opus观点2', 'Opus超限观点3'];
        }
        if (member.id === 'dev:b') return ['Astra补充观点'];
        if (member.id === 'dev:c') return ['(pass)'];
      }
      // Round 1: speaker order rotates to [dev:b, dev:c, dev:a]; all pass -> stops early!
      return ['(pass)'];
    },
  });

  await orchestrator.run({
    group: { name: '技术委员会', description: '' },
    memberIds: members.map((m) => m.id),
  });

  // Round 0 order: a, b, c; Round 1 order: b, c, a (then stops because 0 messages in Round 1)
  assert.deepEqual(
    callLog.map((c) => `${c.round}:${c.id}`),
    ['0:dev:a', '0:dev:b', '0:dev:c', '1:dev:b', '1:dev:c', '1:dev:a'],
  );
  // Speaker 2 (Astra) in Round 0 saw Opus's 2 messages (and NOT the 3rd capped one)!
  assert.deepEqual(callLog[1].seen, ['大家讨论一下方案', 'Opus观点1', 'Opus观点2']);
  assert.deepEqual(callLog[2].seen, ['大家讨论一下方案', 'Opus观点1', 'Opus观点2', 'Astra补充观点']);

  // Epoch cancellation stops at the exact member boundary when nextTurnEpoch advances mid-turn:
  const epoch2 = scheduler.nextTurnEpoch('room-1');
  history.push({ id: 'u2', content: '新问题来了', speaker: { kind: 'user', name: 'Alice' } });
  const epochCalls = [];
  const epochOrchestrator = new GroupChatOrchestrator({
    resolveMembers: async () => members,
    readHistory: () => [...history],
    isCurrent: () => scheduler.currentTurnEpoch('room-1') === epoch2,
    postMemberMessage: (member, content) => {
      history.push({
        id: `m-${history.length}`,
        content,
        speaker: { kind: 'member', id: member.id, name: member.name },
      });
    },
    runMemberTurn: async ({ member }) => {
      epochCalls.push(member.id);
      if (member.id === 'dev:a') {
        // Simulate a new human message arriving while dev:a is speaking!
        scheduler.nextTurnEpoch('room-1');
        return ['Opus完成当前发言'];
      }
      return ['不应被调用'];
    },
  });
  await epochOrchestrator.run({
    group: { name: '技术委员会', description: '' },
    memberIds: members.map((m) => m.id),
  });
  assert.deepEqual(epochCalls, ['dev:a'], 'stale epoch stops cleanly after active speaker finishes');
  scheduler.dispose();
  await scheduler.drainAll();
});

test('3-bot room concurrency lock e2e: exclusive sequential turns (concurrency=1), per-turn cap=2, mid-turn human message epoch switch without STALE_INPUT, and 1:1 preemption redrive note', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-room-lock-e2e-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const host = openHost({ dataRoot: join(rootDir, 'host-data') });
  const rawBots = [
    host.createBot({ requestId: 'lock-bot-1', role: 'Tmp1', modelRef: 'mock/mock-chat', makePrimary: true }),
    host.createBot({ requestId: 'lock-bot-2', role: 'Tmp2', modelRef: 'mock/mock-chat' }),
    host.createBot({ requestId: 'lock-bot-3', role: 'Tmp3', modelRef: 'mock/mock-chat' }),
  ].sort((x, y) => x.botId.localeCompare(y.botId));

  // Scope members are normalized in ascending (deviceId, botId) order; assign roles in sorted order
  // so Round 0 speaker order [botA, botB, botC] is 100% deterministic across random UUIDs.
  const botA = host.updateBotProfile({
    botId: rawBots[0].botId,
    name: '架构师',
    description: '负责系统架构评审',
  });
  const botB = host.updateBotProfile({
    botId: rawBots[1].botId,
    name: '后端专家',
    description: '负责存储与并发实现',
  });
  const botC = host.updateBotProfile({
    botId: rawBots[2].botId,
    name: '测试专家',
    description: '负责回归与压测验收',
  });

  let roomScopeId = '';
  let phase = 'sequential_round_robin';
  let callSeq = 0;
  let activeInRoom = 0;
  let maxActiveInRoom = 0;
  const wakeRecords = [];
  const toolResultsSeen = [];
  let midTurnStartedResolve = null;
  let midTurnReleasePromise = null;
  let preemptTriggered = false;

  const models = createMockModels(async (reqContext) => {
    callSeq += 1;
    const messages = reqContext?.messages ?? [];
    const lastMsg = messages[messages.length - 1];
    const lastIsToolResult = lastMsg?.role === 'toolResult';
    const lastUserIdx = messages.findLastIndex((m) => m?.role === 'user');
    const lastUserMsg = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
    const currentTurnToolMessages = lastUserIdx >= 0
      ? messages.slice(lastUserIdx + 1).filter((m) => m?.role === 'toolResult')
      : [];
    const wakePrompt = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg ?? {});
    const fullSerialized = JSON.stringify(reqContext ?? {});

    let callerBotId = botC.botId;
    if (
      wakePrompt.includes(`"botId": ${JSON.stringify(botA.botId)}`) ||
      wakePrompt.includes(`"botId":${JSON.stringify(botA.botId)}`) ||
      fullSerialized.includes('You are 架构师.')
    ) {
      callerBotId = botA.botId;
    } else if (
      wakePrompt.includes(`"botId": ${JSON.stringify(botB.botId)}`) ||
      wakePrompt.includes(`"botId":${JSON.stringify(botB.botId)}`) ||
      fullSerialized.includes('You are 后端专家.')
    ) {
      callerBotId = botB.botId;
    }

    if (lastIsToolResult) {
      toolResultsSeen.push({
        callerBotId,
        phase,
        content: JSON.stringify(lastMsg),
      });
    }

    activeInRoom += 1;
    maxActiveInRoom = Math.max(maxActiveInRoom, activeInRoom);
    try {
      // Deliberate async delay so any parallel bot wakeup would overlap and push maxActiveInRoom > 1.
      await new Promise((r) => setTimeout(r, 35));

      if (!lastIsToolResult) {
        wakeRecords.push({ callerBotId, phase, wakePrompt });
      }

      if (phase === 'sequential_round_robin') {
        if (callerBotId === botA.botId) {
          const alreadySpoke = !wakePrompt.includes('请三位分别给出数据库迁移建议');
          if (!alreadySpoke) {
            // Bot A tries to send 3 messages in one turn to verify GROUP_MAX_MESSAGES_PER_TURN = 2!
            if (currentTurnToolMessages.length === 0) {
              return [{
                type: 'toolCall',
                id: `a_m1_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: roomScopeId, text: '架构师建议1：采用双写灰度迁移' },
              }];
            }
            if (currentTurnToolMessages.length === 1) {
              return [{
                type: 'toolCall',
                id: `a_m2_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: roomScopeId, text: '架构师建议2：保留回滚开关' },
              }];
            }
            if (currentTurnToolMessages.length === 2) {
              return [{
                type: 'toolCall',
                id: `a_m3_cap_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: roomScopeId, text: '架构师第3条超限消息（不应落库）' },
              }];
            }
            return [{ type: 'text', text: '架构师发言完毕。' }];
          }
          if (!lastIsToolResult) {
            return [{
              type: 'toolCall',
              id: `a_pass_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: roomScopeId, text: '(pass)' },
            }];
          }
          return [];
        }

        if (callerBotId === botB.botId) {
          const alreadySpoke = !wakePrompt.includes('请三位分别给出数据库迁移建议');
          if (!alreadySpoke) {
            if (!lastIsToolResult) {
              return [{
                type: 'toolCall',
                id: `b_m1_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: roomScopeId, text: '后端专家附议架构师双写方案，补充幂等校验' },
              }];
            }
            return [{ type: 'text', text: '后端专家发言完毕。' }];
          }
          if (!lastIsToolResult) {
            return [{
              type: 'toolCall',
              id: `b_pass_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: roomScopeId, text: '(pass)' },
            }];
          }
          return [];
        }

        if (callerBotId === botC.botId) {
          const alreadySpoke = !wakePrompt.includes('请三位分别给出数据库迁移建议');
          if (!alreadySpoke) {
            if (!lastIsToolResult) {
              return [{
                type: 'toolCall',
                id: `c_m1_${callSeq}`,
                name: 'send_to',
                arguments: { scopeId: roomScopeId, text: '测试专家收到架构师与后端方案，补充影子流量比对' },
              }];
            }
            return [{ type: 'text', text: '测试专家发言完毕。' }];
          }
          if (!lastIsToolResult) {
            return [{
              type: 'toolCall',
              id: `c_pass_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: roomScopeId, text: '(pass)' },
            }];
          }
          return [];
        }
      }

      if (phase === 'epoch_interrupt') {
        const hasFirstQuestion = wakePrompt.includes('第一版问题：用 Postgres 还是 MySQL？');
        const hasNewConstraint = wakePrompt.includes('补充约束：必须支持嵌入式单文件部署');
        if (hasFirstQuestion && !hasNewConstraint && callerBotId === botA.botId) {
          if (!lastIsToolResult) {
            midTurnStartedResolve?.();
            if (midTurnReleasePromise) await midTurnReleasePromise;
            return [{
              type: 'toolCall',
              id: `epoch_a_old_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: roomScopeId, text: '架构师初版回答：默认推荐 Postgres' },
            }];
          }
          return [{ type: 'text', text: '初版回答完成。' }];
        }
        if (hasNewConstraint) {
          if (!lastIsToolResult) {
            const replyByBot = {
              [botA.botId]: '架构师按嵌入式约束修正：改用 SQLite WAL',
              [botB.botId]: '后端专家按嵌入式约束确认：SQLite 单写多读',
              [botC.botId]: '测试专家按嵌入式约束确认：断电恢复压测',
            };
            return [{
              type: 'toolCall',
              id: `epoch_new_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: roomScopeId, text: replyByBot[callerBotId] },
            }];
          }
          return [{ type: 'text', text: '新约束回答完成。' }];
        }
        if (!lastIsToolResult) {
          return [{
            type: 'toolCall',
            id: `epoch_pass_${callSeq}`,
            name: 'send_to',
            arguments: { scopeId: roomScopeId, text: '(pass)' },
          }];
        }
        return [];
      }

      if (phase === 'preempt_redrive') {
        if (callerBotId === botA.botId) {
          if (!preemptTriggered) {
            preemptTriggered = true;
            midTurnStartedResolve?.();
            if (midTurnReleasePromise) await midTurnReleasePromise;
            return [{ type: 'text', text: '被抢占前的半途输出' }];
          }
          if (!lastIsToolResult) {
            return [{
              type: 'toolCall',
              id: `redrive_a_${callSeq}`,
              name: 'send_to',
              arguments: { scopeId: roomScopeId, text: '架构师重投完成：风险可控，准予上线' },
            }];
          }
          return [{ type: 'text', text: '重投完成。' }];
        }
      }

      return [];
    } finally {
      activeInRoom -= 1;
    }
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

  registry.install(
    defineExtension({
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
    }),
  );
  registry.install(
    defineExtension({
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
    }),
  );
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
    const createdRoom = log.createScope({
      requestId: 'mk-3bot-committee-room',
      kind: 'room',
      title: '技术方案委员会',
      members: [
        { deviceId: host.deviceId, botId: botA.botId },
        { deviceId: host.deviceId, botId: botB.botId },
        { deviceId: host.deviceId, botId: botC.botId },
      ],
    });
    roomScopeId = createdRoom.scope.scopeId;

    // --- A) Open human question in 3-bot room: concurrency strictly = 1, sequential visibility, per-turn cap = 2 ---
    phase = 'sequential_round_robin';
    maxActiveInRoom = 0;
    wakeRecords.length = 0;
    toolResultsSeen.length = 0;

    log.publish({
      messageId: 'committee-u-1',
      scopeId: roomScopeId,
      author: { kind: 'user' },
      category: 'public',
      text: '请三位分别给出数据库迁移建议',
      replyTo: null,
    });
    decisions.nudge();

    await waitUntil(
      async () => {
        const items = log.history(roomScopeId, { order: 'ascending', limit: 20 }).items;
        const latestId = items[items.length - 1]?.localId ?? 0;
        if (items.length < 5) return false;
        const [actA, actB, actC] = await Promise.all([
          decisions.getWorkActivity(botA.botId, roomScopeId),
          decisions.getWorkActivity(botB.botId, roomScopeId),
          decisions.getWorkActivity(botC.botId, roomScopeId),
        ]);
        return (
          actA.pending === null &&
          actB.pending === null &&
          actC.pending === null &&
          actA.handledLocalId >= latestId &&
          actB.handledLocalId >= latestId &&
          actC.handledLocalId >= latestId
        );
      },
      {
        label: '3-bot sequential round-robin settled',
        timeoutMs: 15_000,
        onTimeout: async () => ({
          texts: log.history(roomScopeId, { order: 'ascending', limit: 20 }).items.map((i) => ({ id: i.localId, text: i.message.text })),
          actA: await decisions.getWorkActivity(botA.botId, roomScopeId),
          actB: await decisions.getWorkActivity(botB.botId, roomScopeId),
          actC: await decisions.getWorkActivity(botC.botId, roomScopeId),
          wakes: wakeRecords.map((w) => ({ bot: w.callerBotId, p: w.wakePrompt.slice(0, 200) })),
        }),
      },
    );

    assert.equal(maxActiveInRoom, 1, 'room model concurrency must never exceed 1');
    assert.equal(
      toolResultsSeen.some((r) => r.content.includes('STALE_INPUT')),
      false,
      'no speaker should ever hit STALE_INPUT',
    );
    assert.equal(
      toolResultsSeen.some((r) => r.callerBotId === botA.botId && r.content.includes('turn_cap_reached')),
      true,
      `Bot A's 3rd send_to in one turn must return status=turn_cap_reached (cap=${GROUP_MAX_MESSAGES_PER_TURN})`,
    );

    const historyAfterA = log.history(roomScopeId, { order: 'ascending', limit: 20 }).items;
    const publishedTextsA = historyAfterA.map((i) => i.message.text);
    assert.deepEqual(publishedTextsA, [
      '请三位分别给出数据库迁移建议',
      '架构师建议1：采用双写灰度迁移',
      '架构师建议2：保留回滚开关',
      '后端专家附议架构师双写方案，补充幂等校验',
      '测试专家收到架构师与后端方案，补充影子流量比对',
    ]);

    // Verify sequential context visibility: Bot B saw Bot A's 2 messages; Bot C saw Bot A + Bot B!
    const firstWakeB = wakeRecords.find((w) => w.callerBotId === botB.botId);
    const firstWakeC = wakeRecords.find((w) => w.callerBotId === botC.botId);
    assert.ok(firstWakeB?.wakePrompt.includes('架构师建议1：采用双写灰度迁移'));
    assert.ok(firstWakeB?.wakePrompt.includes('架构师建议2：保留回滚开关'));
    assert.ok(firstWakeC?.wakePrompt.includes('架构师建议1：采用双写灰度迁移'));
    assert.ok(firstWakeC?.wakePrompt.includes('后端专家附议架构师双写方案，补充幂等校验'));

    // --- B) Mid-turn human message advances room turn epoch: active speaker finishes without STALE_INPUT, stale Round 0 halts at boundary, fresh Round 0 runs on new constraint ---
    phase = 'epoch_interrupt';
    maxActiveInRoom = 0;
    wakeRecords.length = 0;
    toolResultsSeen.length = 0;

    const botAEnteredTurn = new Promise((res) => {
      midTurnStartedResolve = res;
    });
    let releaseBotA;
    midTurnReleasePromise = new Promise((res) => {
      releaseBotA = res;
    });

    log.publish({
      messageId: 'committee-u-2',
      scopeId: roomScopeId,
      author: { kind: 'user' },
      category: 'public',
      text: '第一版问题：用 Postgres 还是 MySQL？',
      replyTo: null,
    });
    decisions.nudge();

    await botAEnteredTurn;

    // While Bot A is mid-turn, user sends a newer message into the room!
    log.publish({
      messageId: 'committee-u-3',
      scopeId: roomScopeId,
      author: { kind: 'user' },
      category: 'public',
      text: '补充约束：必须支持嵌入式单文件部署！',
      replyTo: null,
    });
    decisions.nudge();

    // Release Bot A to finish its in-flight send_to!
    releaseBotA();
    midTurnStartedResolve = null;
    midTurnReleasePromise = null;

    await waitUntil(
      async () => {
        const items = log.history(roomScopeId, { order: 'ascending', limit: 30 }).items;
        const texts = items.map((i) => i.message.text);
        if (
          !texts.includes('架构师初版回答：默认推荐 Postgres') ||
          !texts.includes('架构师按嵌入式约束修正：改用 SQLite WAL') ||
          !texts.includes('后端专家按嵌入式约束确认：SQLite 单写多读') ||
          !texts.includes('测试专家按嵌入式约束确认：断电恢复压测')
        ) {
          return false;
        }
        const latestId = items[items.length - 1]?.localId ?? 0;
        const [actA, actB, actC] = await Promise.all([
          decisions.getWorkActivity(botA.botId, roomScopeId),
          decisions.getWorkActivity(botB.botId, roomScopeId),
          decisions.getWorkActivity(botC.botId, roomScopeId),
        ]);
        return (
          actA.pending === null &&
          actB.pending === null &&
          actC.pending === null &&
          actA.handledLocalId >= latestId &&
          actB.handledLocalId >= latestId &&
          actC.handledLocalId >= latestId
        );
      },
      {
        label: 'epoch switch after mid-turn human message settled',
        timeoutMs: 15_000,
        onTimeout: async () => ({
          texts: log.history(roomScopeId, { order: 'ascending', limit: 30 }).items.map((i) => ({ id: i.localId, text: i.message.text })),
          actA: await decisions.getWorkActivity(botA.botId, roomScopeId),
          actB: await decisions.getWorkActivity(botB.botId, roomScopeId),
          actC: await decisions.getWorkActivity(botC.botId, roomScopeId),
          wakes: wakeRecords.map((w) => ({ bot: w.callerBotId, p: w.wakePrompt.slice(0, 220) })),
        }),
      },
    );

    assert.equal(maxActiveInRoom, 1, 'concurrency remains strictly 1 across epoch switch');
    assert.equal(
      toolResultsSeen.some((r) => r.content.includes('STALE_INPUT')),
      false,
      'active speaker must finish cleanly without STALE_INPUT when new human message arrives mid-turn',
    );
    // Neither Bot B nor Bot C wasted their initial turn on the stale pre-constraint epoch!
    const firstPhaseBWakeB = wakeRecords.find((w) => w.callerBotId === botB.botId);
    const firstPhaseBWakeC = wakeRecords.find((w) => w.callerBotId === botC.botId);
    assert.ok(
      firstPhaseBWakeB?.wakePrompt.includes('补充约束：必须支持嵌入式单文件部署'),
      'Bot B must skip stale epoch and first wake with the new human constraint visible',
    );
    assert.ok(
      firstPhaseBWakeC?.wakePrompt.includes('补充约束：必须支持嵌入式单文件部署'),
      'Bot C must skip stale epoch and first wake with the new human constraint visible',
    );

    // --- C) Direct 1:1 preemption redrive appends buildGroupRedriveNote(roomScopeId) ---
    phase = 'preempt_redrive';
    wakeRecords.length = 0;
    preemptTriggered = false;

    const botAStartedForPreempt = new Promise((res) => {
      midTurnStartedResolve = res;
    });
    let releasePreemptedTurn;
    midTurnReleasePromise = new Promise((res) => {
      releasePreemptedTurn = res;
    });

    log.publish({
      messageId: 'committee-peer-4',
      scopeId: roomScopeId,
      author: { kind: 'bot', botId: botB.botId },
      category: 'public',
      text: '@架构师 请给出最终上线风险结论',
      replyTo: null,
    });
    decisions.nudge();

    await waitUntil(() => preemptTriggered, {
      label: 'botA entered preemptible room turn',
      timeoutMs: 4_000,
      onTimeout: async () => ({
        actA: await decisions.getWorkActivity(botA.botId, roomScopeId),
        texts: log.history(roomScopeId, { order: 'ascending', limit: 30 }).items.map((i) => ({ id: i.localId, text: i.message.text })),
      }),
    });
    const preemptPromise = decisions.interruptBotWork(botA.botId, { reason: 'preempted', quiesce: false });
    releasePreemptedTurn();
    await preemptPromise;
    midTurnStartedResolve = null;
    midTurnReleasePromise = null;

    await waitUntil(
      async () => {
        const items = log.history(roomScopeId, { order: 'ascending', limit: 30 }).items;
        return items.some((i) => i.message.text === '架构师重投完成：风险可控，准予上线');
      },
      {
        label: 'preempted room turn redriven with redelivery note',
        timeoutMs: 15_000,
        onTimeout: async () => ({
          actA: await decisions.getWorkActivity(botA.botId, roomScopeId),
          wakes: wakeRecords.map((w) => ({ bot: w.callerBotId, p: w.wakePrompt.slice(0, 250) })),
        }),
      },
    );

    const redriveWake = wakeRecords.find(
      (w) => w.callerBotId === botA.botId && w.wakePrompt.includes(buildGroupRedriveNote(roomScopeId).trim()),
    );
    assert.ok(redriveWake, 'redriven room turn must include buildGroupRedriveNote(roomScopeId)');
  } finally {
    await decisions.close();
    await workContexts.close();
    await harness.close(context);
    host.close();
  }
});
