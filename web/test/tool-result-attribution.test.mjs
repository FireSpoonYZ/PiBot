import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  TASK_OWNER_CHAIN_DEPTH,
  USER_MESSAGE_KIND,
  augmentSessionTurnByTask,
  deriveEntryAttribution,
} from '../../host-core/bot-session-context.js';
import { readPrimaryHistory } from '../../host-core/runtime-history.js';
import { createRuntimeLive } from '../../host-core/runtime-live.js';
import { parseHistoryEntries } from '../src/chatTurnModel.ts';

function makeSessionState() {
  return {
    schema: 1,
    lastImportedLocalId: 0,
    importedCount: 0,
    clearedThroughEntryId: 0,
    activeTurn: null,
    turnByTask: {
      '100': 'req-dm',
      '200': 'req-primary',
      '300': 'req-room',
    },
    outgoing: {},
    completedTurns: {
      'req-dm': {
        requestId: 'req-dm',
        taskId: '100',
        kind: 'dm',
        scopeId: 'dm-1',
        botId: 'bot-b',
        deviceId: 'dev-1',
        triggerMessageId: 'msg-dm-1',
        rootId: 'root-dm-1',
        sender: { kind: 'bot', botId: 'bot-a', deviceId: 'dev-1' },
        replyTarget: { kind: 'dm', scopeId: 'dm-1', botId: 'bot-a' },
      },
      'req-primary': {
        requestId: 'req-primary',
        taskId: '200',
        kind: 'primary',
        scopeId: null,
        botId: 'bot-b',
        deviceId: 'dev-1',
        triggerMessageId: 'msg-user-1',
        sender: { kind: 'user', deviceId: 'dev-1' },
        replyTarget: { kind: 'primary' },
      },
      'req-room': {
        requestId: 'req-room',
        taskId: '300',
        kind: 'room',
        scopeId: 'room-1',
        botId: 'bot-b',
        deviceId: 'dev-1',
        triggerMessageId: 'msg-room-1',
        sender: { kind: 'user', deviceId: 'dev-1' },
        replyTarget: { kind: 'room', scopeId: 'room-1' },
      },
    },
    updatedAt: null,
  };
}

function makeToolResultEntry(id, byTaskId, toolCallId, toolName, text, extra = {}) {
  return {
    id,
    kind: 'pi.tool-result',
    byTaskId,
    model: [{
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text }],
    }],
    ...extra,
  };
}

function createWaitUntil() {
  let currentState = null;
  let lastFrameType = null;
  let frameCount = 0;
  const waiters = [];
  const onFrame = (frame) => {
    frameCount += 1;
    lastFrameType = frame.type;
    currentState = frame.type === 'snapshot' ? frame.state : { ...currentState, ...frame.changes };
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i](currentState, lastFrameType, frameCount)) waiters.splice(i, 1);
    }
  };
  const waitUntil = (predicate) => new Promise((resolve, reject) => {
    if (currentState !== null && predicate(currentState, lastFrameType, frameCount)) {
      return resolve(currentState);
    }
    const timer = setTimeout(() => reject(new Error('timed out waiting for runtime-live frame')), 5000);
    waiters.push((state, frameType, count) => {
      if (predicate(state, frameType, count)) {
        clearTimeout(timer);
        resolve(state);
        return true;
      }
      return false;
    });
  });
  return { onFrame, waitUntil };
}

test('augmentSessionTurnByTask resolves direct child and multi-hop nested tool tasks for DM, primary, and room turns without mutating sessionState', async () => {
  const sessionState = makeSessionState();
  Object.freeze(sessionState.turnByTask);
  Object.freeze(sessionState);

  const tasks = new Map([
    [101, { id: 101, conversationId: 11, owner: 100 }],
    [102, { id: 102, conversationId: 11, owner: 101 }],
    [103, { id: 103, conversationId: 11, owner: 102 }],
    [201, { id: 201, conversationId: 11, owner: 200 }],
    [301, { id: 301, conversationId: 11, owner: 300 }],
  ]);
  const calls = [];
  const harness = {
    async getTask(id) {
      calls.push(id);
      return tasks.get(id) ?? null;
    },
  };
  const cache = new Map();

  const explicitEntry = {
    id: 1,
    kind: USER_MESSAGE_KIND,
    byTaskId: 999,
    data: { attribution: { kind: 'user', channel: 'primary' } },
  };
  const directGenEntry = {
    id: 2,
    kind: 'pi.assistant',
    byTaskId: 100,
  };
  const dmDirectTool = makeToolResultEntry(3, 101, 'c-dm-1', 'read', 'dm direct');
  const dmNestedTool = makeToolResultEntry(4, 103, 'c-dm-2', 'grep', 'dm nested', {
    data: { attribution: null },
  });
  const primaryTool = makeToolResultEntry(5, 201, 'c-p-1', 'ls', 'primary result');
  const roomTool = makeToolResultEntry(6, 301, 'c-r-1', 'find', 'room result');

  const augmented = await augmentSessionTurnByTask(
    [explicitEntry, directGenEntry, dmDirectTool, dmNestedTool, primaryTool, roomTool],
    sessionState,
    { harness, context: {}, cache, conversationId: 11 },
  );

  // Original sessionState and its turnByTask must never be mutated.
  assert.notEqual(augmented, sessionState);
  assert.deepEqual(Object.keys(sessionState.turnByTask).sort(), ['100', '200', '300']);
  assert.equal('101' in sessionState.turnByTask, false);

  // Entries with explicit attribution or already in turnByTask must not trigger getTask.
  assert.equal(calls.includes(999), false);
  assert.equal(calls.includes(100), false);
  // Multi-hop 103 -> 102 -> 101 hits cached 101 after 101 was already resolved!
  assert.deepEqual(calls, [101, 103, 102, 201, 301]);

  assert.deepEqual(deriveEntryAttribution(dmDirectTool, augmented), {
    kind: 'bot',
    channel: 'dm',
    direction: 'outgoing',
    botId: 'bot-b',
    deviceId: 'dev-1',
    scopeId: 'dm-1',
    replyTo: 'msg-dm-1',
    rootId: 'root-dm-1',
  });
  assert.deepEqual(deriveEntryAttribution(dmNestedTool, augmented), {
    kind: 'bot',
    channel: 'dm',
    direction: 'outgoing',
    botId: 'bot-b',
    deviceId: 'dev-1',
    scopeId: 'dm-1',
    replyTo: 'msg-dm-1',
    rootId: 'root-dm-1',
  });
  assert.deepEqual(deriveEntryAttribution(primaryTool, augmented), {
    kind: 'bot',
    channel: 'primary',
    direction: 'outgoing',
    botId: 'bot-b',
    deviceId: 'dev-1',
    replyTo: 'msg-user-1',
  });
  assert.deepEqual(deriveEntryAttribution(roomTool, augmented), {
    kind: 'bot',
    channel: 'room',
    direction: 'outgoing',
    botId: 'bot-b',
    deviceId: 'dev-1',
    scopeId: 'room-1',
    replyTo: 'msg-room-1',
  });

  // Intermediate node 102 was populated in cache during the 103 -> 102 -> 101 walk.
  const callsBeforeIntermediate = calls.length;
  const intermediateEntry = makeToolResultEntry(7, 102, 'c-dm-mid', 'bash', 'mid');
  const augmentedMid = await augmentSessionTurnByTask([intermediateEntry], sessionState, {
    harness,
    context: {},
    cache,
    conversationId: 11,
  });
  assert.equal(calls.length, callsBeforeIntermediate);
  assert.equal(deriveEntryAttribution(intermediateEntry, augmentedMid)?.scopeId, 'dm-1');

  // When no new mappings are needed, returns the exact original sessionState reference.
  const unchanged = await augmentSessionTurnByTask([explicitEntry, directGenEntry], sessionState, {
    harness,
    context: {},
    cache,
    conversationId: 11,
  });
  assert.equal(unchanged, sessionState);
});

test('augmentSessionTurnByTask enforces depth limit 8, cycle safety, conversation isolation, LRU bound, and graceful degradation', async () => {
  assert.equal(TASK_OWNER_CHAIN_DEPTH, 8);
  const sessionState = makeSessionState();
  Object.freeze(sessionState.turnByTask);
  Object.freeze(sessionState);

  // Build a 9-hop chain: 909 -> 908 -> ... -> 901 -> 100 (where 100 is in turnByTask).
  // 908 -> ... -> 100 is 8 hops (must resolve); 909 -> ... -> 100 is 9 hops (must NOT resolve).
  const tasks = new Map([
    [901, { id: 901, conversationId: 11, owner: 100 }],
    [902, { id: 902, conversationId: 11, owner: 901 }],
    [903, { id: 903, conversationId: 11, owner: 902 }],
    [904, { id: 904, conversationId: 11, owner: 903 }],
    [905, { id: 905, conversationId: 11, owner: 904 }],
    [906, { id: 906, conversationId: 11, owner: 905 }],
    [907, { id: 907, conversationId: 11, owner: 906 }],
    [908, { id: 908, conversationId: 11, owner: 907 }],
    [909, { id: 909, conversationId: 11, owner: 908 }],
    // Self-cycle and 2-node cycle.
    [700, { id: 700, conversationId: 11, owner: 700 }],
    [701, { id: 701, conversationId: 11, owner: 702 }],
    [702, { id: 702, conversationId: 11, owner: 701 }],
    // Cross-conversation task pointing at a valid generation task ID.
    [800, { id: 800, conversationId: 99, owner: 100 }],
  ]);

  let shouldThrow = false;
  let lookupCount = 0;
  const harness = {
    async getTask(id) {
      lookupCount += 1;
      if (shouldThrow) throw new Error('transient storage error');
      return tasks.get(id) ?? null;
    },
  };

  // 1) 9-hop chain hits depth limit -> returns original sessionState without poisoning 902 in cache.
  const sharedCache = new Map();
  const tooDeepEntry = makeToolResultEntry(1, 909, 'c-deep', 'bash', 'too deep');
  const tooDeepResult = await augmentSessionTurnByTask([tooDeepEntry], sessionState, {
    harness,
    context: {},
    cache: sharedCache,
    conversationId: 11,
  });
  assert.equal(tooDeepResult, sessionState);
  assert.equal(sharedCache.get('909'), null);
  assert.equal(sharedCache.has('902'), false);

  // Intermediate node 902 (2 hops to 100) still resolves cleanly via the same cache!
  const midEntry = makeToolResultEntry(2, 902, 'c-mid', 'bash', '2 hops');
  const midResult = await augmentSessionTurnByTask([midEntry], sessionState, {
    harness,
    context: {},
    cache: sharedCache,
    conversationId: 11,
  });
  assert.equal(deriveEntryAttribution(midEntry, midResult)?.scopeId, 'dm-1');

  // Exact 8-hop chain (908 -> ... -> 100) resolves on a fresh cache.
  const eightHopEntry = makeToolResultEntry(3, 908, 'c-8', 'bash', '8 hops');
  const eightHopResult = await augmentSessionTurnByTask([eightHopEntry], sessionState, {
    harness,
    context: {},
    conversationId: 11,
  });
  assert.equal(deriveEntryAttribution(eightHopEntry, eightHopResult)?.scopeId, 'dm-1');

  // 2) Cycles, missing tasks, and cross-conversation tasks degrade safely to original sessionState.
  const safetyEntries = [
    makeToolResultEntry(4, 700, 'c-self', 'bash', 'self cycle'),
    makeToolResultEntry(5, 701, 'c-loop', 'bash', '2-node cycle'),
    makeToolResultEntry(6, 777, 'c-miss', 'bash', 'missing task'),
    makeToolResultEntry(7, 800, 'c-cross', 'bash', 'wrong conversation'),
  ];
  const safetyResult = await augmentSessionTurnByTask(safetyEntries, sessionState, {
    harness,
    context: {},
    conversationId: 11,
  });
  assert.equal(safetyResult, sessionState);

  // 3) Null harness or harness without getTask degrades safely without throwing.
  assert.equal(await augmentSessionTurnByTask([midEntry], sessionState, { harness: null, context: {} }), sessionState);
  assert.equal(await augmentSessionTurnByTask([midEntry], sessionState, { harness: {}, context: {} }), sessionState);

  // 4) Transient getTask rejection degrades to original sessionState and must NOT poison cache.
  const retryCache = new Map();
  shouldThrow = true;
  const failedResult = await augmentSessionTurnByTask([midEntry], sessionState, {
    harness,
    context: {},
    cache: retryCache,
    conversationId: 11,
  });
  assert.equal(failedResult, sessionState);
  assert.equal(retryCache.has('902'), false);

  shouldThrow = false;
  const recoveredResult = await augmentSessionTurnByTask([midEntry], sessionState, {
    harness,
    context: {},
    cache: retryCache,
    conversationId: 11,
  });
  assert.equal(deriveEntryAttribution(midEntry, recoveredResult)?.scopeId, 'dm-1');

  // 5) Bounded LRU cache keeps size <= maxCacheSize.
  const boundedCache = new Map();
  tasks.set(951, { id: 951, conversationId: 11, owner: 100 });
  tasks.set(952, { id: 952, conversationId: 11, owner: 200 });
  tasks.set(953, { id: 953, conversationId: 11, owner: 300 });
  await augmentSessionTurnByTask(
    [
      makeToolResultEntry(10, 951, 'c1', 'ls', '1'),
      makeToolResultEntry(11, 952, 'c2', 'ls', '2'),
    ],
    sessionState,
    { harness, context: {}, cache: boundedCache, conversationId: 11, maxCacheSize: 2 },
  );
  // Touch 951 so 952 becomes the oldest key.
  await augmentSessionTurnByTask([makeToolResultEntry(10, 951, 'c1', 'ls', '1')], sessionState, {
    harness,
    context: {},
    cache: boundedCache,
    conversationId: 11,
    maxCacheSize: 2,
  });
  await augmentSessionTurnByTask([makeToolResultEntry(12, 953, 'c3', 'ls', '3')], sessionState, {
    harness,
    context: {},
    cache: boundedCache,
    conversationId: 11,
    maxCacheSize: 2,
  });
  assert.equal(boundedCache.size, 2);
  assert.equal(boundedCache.has('951'), true);
  assert.equal(boundedCache.has('952'), false);
  assert.equal(boundedCache.has('953'), true);
  assert.ok(lookupCount > 0);
});

test('readPrimaryHistory resolves tool-result task.owner chains across channels, split pages, and chunked continuations', async () => {
  const sessionState = makeSessionState();
  Object.freeze(sessionState.turnByTask);
  Object.freeze(sessionState);

  const tasks = new Map([
    [101, { id: 101, conversationId: 11, owner: 100 }],
    [102, { id: 102, conversationId: 11, owner: 101 }],
    [201, { id: 201, conversationId: 11, owner: 200 }],
    [301, { id: 301, conversationId: 11, owner: 300 }],
  ]);

  const dmAssistant = {
    id: 10,
    kind: 'pi.assistant',
    byTaskId: 100,
    model: [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-dm', name: 'read', arguments: { path: 'a.txt' } }],
    }],
  };
  const dmToolResult = makeToolResultEntry(11, 102, 'tc-dm', 'read', 'dm nested tool output');
  const primaryToolResult = makeToolResultEntry(12, 201, 'tc-p', 'ls', 'primary tool output');
  const roomToolResult = makeToolResultEntry(13, 301, 'tc-r', 'grep', 'room tool output');
  const oversizedDmToolResult = makeToolResultEntry(14, 102, 'tc-big', 'read', 'x'.repeat(300 * 1024));

  const stored = [dmAssistant, dmToolResult, primaryToolResult, roomToolResult, oversizedDmToolResult];
  const storedBefore = structuredClone(stored);
  const conversation = {
    id: 11,
    async entries(query, limit, cursor) {
      if (query.order === 'descending') {
        return { items: [...stored].reverse(), next: null };
      }
      const visible = stored.filter((item) => item.id >= (query.minEntryId ?? 0));
      const start = cursor?.index ?? 0;
      const items = visible.slice(start, start + limit);
      const next = start + items.length < visible.length ? { index: start + items.length } : null;
      return { items, next };
    },
  };

  let failGetTask = false;
  const harness = {
    async snapshot(token) {
      if (token.definition.kind === 'host.bot-session') return sessionState;
      return null;
    },
    async getTask(id) {
      if (failGetTask) throw new Error('getTask unavailable');
      return tasks.get(id) ?? null;
    },
  };

  // 1) Split pagination: page 1 ends on pi.assistant; page 2 starts on orphan pi.tool-result!
  const page1 = await readPrimaryHistory(conversation, { limit: 1 }, {}, { harness });
  assert.equal(page1.items.length, 1);
  assert.equal(page1.items[0].id, 10);
  assert.equal(page1.items[0].data.attribution.channel, 'dm');

  const page2 = await readPrimaryHistory(conversation, { limit: 3, cursor: page1.nextCursor }, {}, { harness });
  assert.deepEqual(page2.items.map((item) => item.id), [11, 12, 13]);
  assert.deepEqual(page2.items[0].data.attribution, {
    kind: 'bot',
    channel: 'dm',
    direction: 'outgoing',
    botId: 'bot-b',
    deviceId: 'dev-1',
    scopeId: 'dm-1',
    replyTo: 'msg-dm-1',
    rootId: 'root-dm-1',
  });
  assert.equal(page2.items[1].data.attribution.channel, 'primary');
  assert.equal(page2.items[2].data.attribution.channel, 'room');
  assert.equal(page2.items[2].data.attribution.scopeId, 'room-1');

  // Orphan pi.tool-result on page 2 is preserved (NOT dropped!) by parseHistoryEntries because it has attribution.
  const splitTurns = parseHistoryEntries([page2.items[0]], 0);
  assert.equal(splitTurns.length, 1);
  assert.equal(splitTurns[0].role, 'assistant');
  assert.equal(splitTurns[0].attribution?.channel, 'dm');
  assert.equal(splitTurns[0].attribution?.scopeId, 'dm-1');
  assert.equal(splitTurns[0].tools?.[0]?.name, 'read');

  // 2) Chunked pagination determinism: oversized pi.tool-result resolves the exact same attribution across chunks.
  const firstChunkedPage = await readPrimaryHistory(conversation, { chunked: true, limit: 10 }, {}, { harness });
  assert.deepEqual(firstChunkedPage.items.map((item) => item.id), [10, 11, 12, 13]);
  assert.equal(firstChunkedPage.items[1].data.attribution.scopeId, 'dm-1');
  assert.ok(firstChunkedPage.nextCursor);

  let chunkCursor = firstChunkedPage.nextCursor;
  const pieces = [];
  let chunkCount = 0;
  while (chunkCursor) {
    const chunkPage = await readPrimaryHistory(
      conversation,
      { chunked: true, limit: 10, cursor: chunkCursor },
      {},
      { harness },
    );
    assert.ok(chunkPage.entryChunk);
    assert.equal(chunkPage.entryChunk.entryId, 14);
    pieces.push(chunkPage.entryChunk.json);
    chunkCount += 1;
    chunkCursor = chunkPage.nextCursor;
  }
  assert.ok(chunkCount >= 5);
  const reassembled = JSON.parse(pieces.join(''));
  assert.equal(reassembled.id, 14);
  assert.deepEqual(reassembled.data.attribution, {
    kind: 'bot',
    channel: 'dm',
    direction: 'outgoing',
    botId: 'bot-b',
    deviceId: 'dev-1',
    scopeId: 'dm-1',
    replyTo: 'msg-dm-1',
    rootId: 'root-dm-1',
  });

  // 3) Graceful degradation when harness.getTask throws or is omitted.
  failGetTask = true;
  const degradedThrowing = await readPrimaryHistory(conversation, { limit: 2 }, {}, { harness });
  assert.equal(degradedThrowing.items[0].data.attribution.channel, 'dm');
  assert.equal(degradedThrowing.items[1].data?.attribution ?? null, null);
  failGetTask = false;

  const degradedNoGetTask = await readPrimaryHistory(conversation, { limit: 2 }, {}, {
    sessionState,
    harness: { async snapshot() { return sessionState; } },
  });
  assert.equal(degradedNoGetTask.items[1].data?.attribution ?? null, null);

  // Stored entries and original sessionState remain completely unmutated.
  assert.deepEqual(stored, storedBefore);
  assert.deepEqual(Object.keys(sessionState.turnByTask).sort(), ['100', '200', '300']);
});

test('createRuntimeLive resolves tool-result attribution with bounded tail scan, per-watch cache, split-window preservation, and graceful degradation', async () => {
  const sessionState = makeSessionState();
  Object.freeze(sessionState.turnByTask);
  Object.freeze(sessionState);

  const tasks = new Map([
    [50, { id: 50, conversationId: 11, owner: 100 }], // pre-reset (must not be fetched)
    [51, { id: 51, conversationId: 11, owner: 100 }], // older than 50-entry window (must not be fetched)
    [101, { id: 101, conversationId: 11, owner: 100 }],
    [201, { id: 201, conversationId: 11, owner: 200 }],
    [202, { id: 202, conversationId: 11, owner: 201 }],
    [301, { id: 301, conversationId: 11, owner: 300 }],
  ]);

  // Construct 50 displayable post-reset entries where entry 100 is a pi.assistant JUST outside
  // the 50-entry window and entry 101 is its pi.tool-result as the oldest entry INSIDE the window.
  const preResetTool = makeToolResultEntry(5, 50, 'tc-pre', 'ls', 'before reset');
  const resetMarker = { id: 10, kind: 'pi.reset', model: [] };
  const outsideWindowTool = makeToolResultEntry(20, 51, 'tc-old', 'ls', 'outside 50 window');
  const droppedAssistant = {
    id: 100,
    kind: 'pi.assistant',
    byTaskId: 100,
    model: [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-split', name: 'read', arguments: { path: 'split.txt' } }],
    }],
  };
  const splitDmTool = makeToolResultEntry(101, 101, 'tc-split', 'read', 'split dm output');
  const fillerEntries = Array.from({ length: 47 }, (_, index) => ({
    id: 102 + index,
    kind: USER_MESSAGE_KIND,
    data: { attribution: { kind: 'user', channel: 'primary' } },
    model: [{ role: 'user', content: [{ type: 'text', text: `msg-${index}` }] }],
  }));
  const nestedPrimaryTool = makeToolResultEntry(149, 202, 'tc-primary', 'grep', 'nested primary output');
  const roomTool = makeToolResultEntry(150, 301, 'tc-room', 'find', 'room output');

  const initialEntries = [
    preResetTool,
    resetMarker,
    outsideWindowTool,
    droppedAssistant,
    splitDmTool,
    ...fillerEntries,
    nestedPrimaryTool,
    roomTool,
  ];

  const makeView = (generationText = null) => ({
    entries: initialEntries,
    docs: {
      'pi.live': {
        run: generationText === null ? null : { taskId: 100, first: 100, inputs: [] },
        generation: generationText === null
          ? null
          : { message: { role: 'assistant', content: [{ type: 'text', text: generationText }] } },
        tools: [],
        nestedTools: [],
      },
      'pi.inbox': { items: [] },
    },
  });

  let emitView = null;
  const fetchedIds = [];
  const harness = {
    async snapshot(token) {
      if (token.definition.kind === 'host.primary-index') return { byPrimary: { 'public-b': 11 } };
      if (token.definition.kind === 'host.bot-session') return sessionState;
      return null;
    },
    async getTask(id) {
      fetchedIds.push(id);
      return tasks.get(id) ?? null;
    },
    async conversation() {
      return {
        id: 11,
        async watch() {
          return {
            value: makeView(null),
            closed: new Promise(() => {}),
            start(callback) { emitView = callback; },
            async stop() {},
          };
        },
      };
    },
  };

  const runtimeLive = createRuntimeLive({
    host: { getBot: () => ({ botId: 'bot-b', deviceId: 'dev-1', primaryConversationId: 'public-b' }) },
    getHarness: () => harness,
    resolveWorkContext: async () => null,
  });

  const { onFrame, waitUntil } = createWaitUntil();
  const watch = await runtimeLive.watch('bot-b');
  try {
    watch.start(onFrame);
    const snapshot = await waitUntil((state) => state.history.length === 51 && state.lastEntryId === 150);

    // Pre-reset (50) and outside-window (51) tool tasks must NEVER be fetched.
    assert.equal(fetchedIds.includes(50), false);
    assert.equal(fetchedIds.includes(51), false);
    assert.deepEqual([...fetchedIds].sort((a, b) => a - b), [101, 201, 202, 301]);

    // history[0] is pi.reset; history[1] is splitDmTool (id 101, oldest in 50-entry window).
    assert.equal(snapshot.history[0].kind, 'pi.reset');
    assert.equal(snapshot.history[1].id, 101);
    assert.deepEqual(snapshot.history[1].attribution, {
      kind: 'bot',
      channel: 'dm',
      direction: 'outgoing',
      botId: 'bot-b',
      deviceId: 'dev-1',
      scopeId: 'dm-1',
      replyTo: 'msg-dm-1',
      rootId: 'root-dm-1',
    });
    assert.equal(snapshot.history[49].id, 149);
    assert.equal(snapshot.history[49].attribution?.channel, 'primary');
    assert.equal(snapshot.history[50].id, 150);
    assert.equal(snapshot.history[50].attribution?.channel, 'room');
    assert.equal(snapshot.history[50].attribution?.scopeId, 'room-1');

    // Live split-window orphan pi.tool-result (without its dropped pi.assistant) is kept by parseHistoryEntries!
    const parsedLive = parseHistoryEntries(snapshot.history.slice(1, 2), 0);
    assert.equal(parsedLive.length, 1);
    assert.equal(parsedLive[0].role, 'assistant');
    assert.equal(parsedLive[0].attribution?.channel, 'dm');
    assert.equal(parsedLive[0].attribution?.scopeId, 'dm-1');
    assert.equal(parsedLive[0].tools?.[0]?.name, 'read');

    // Subsequent streaming frames must reuse the per-watch cache with ZERO extra getTask calls!
    const lookupsAfterSnapshot = fetchedIds.length;
    emitView({ value: makeView('Streaming chunk 1') });
    const frame2 = await waitUntil((state) => state.generation?.text === 'Streaming chunk 1');
    assert.equal(frame2.history[1].attribution?.scopeId, 'dm-1');
    assert.equal(fetchedIds.length, lookupsAfterSnapshot);

    emitView({ value: makeView('Streaming chunk 2') });
    const frame3 = await waitUntil((state) => state.generation?.text === 'Streaming chunk 2');
    assert.equal(frame3.history[49].attribution?.channel, 'primary');
    assert.equal(fetchedIds.length, lookupsAfterSnapshot);

    // Original sessionState was never mutated.
    assert.deepEqual(Object.keys(sessionState.turnByTask).sort(), ['100', '200', '300']);
  } finally {
    await watch.stop();
    await runtimeLive.close();
  }

  // Graceful degradation when harness.getTask throws inside createRuntimeLive.
  const failingHarness = {
    async snapshot(token) {
      if (token.definition.kind === 'host.primary-index') return { byPrimary: { 'public-b': 11 } };
      if (token.definition.kind === 'host.bot-session') return sessionState;
      return null;
    },
    async getTask() {
      throw new Error('task table temporarily unavailable');
    },
    async conversation() {
      return {
        id: 11,
        async watch() {
          return {
            value: {
              entries: [splitDmTool],
              docs: { 'pi.live': { run: null, tools: [], nestedTools: [] }, 'pi.inbox': { items: [] } },
            },
            closed: new Promise(() => {}),
            start() {},
            async stop() {},
          };
        },
      };
    },
  };
  const degradedLive = createRuntimeLive({
    host: { getBot: () => ({ botId: 'bot-b', deviceId: 'dev-1', primaryConversationId: 'public-b' }) },
    getHarness: () => failingHarness,
    resolveWorkContext: async () => null,
  });
  const degraded = createWaitUntil();
  const degradedWatch = await degradedLive.watch('bot-b');
  try {
    degradedWatch.start(degraded.onFrame);
    const frame = await degraded.waitUntil((state) => state.history.length === 1);
    assert.equal(frame.history[0].id, 101);
    assert.equal(frame.history[0].attribution, undefined);
    assert.equal(degradedWatch.ended, false);
  } finally {
    await degradedWatch.stop();
    await degradedLive.close();
  }
});

test('createRuntimeLive keeps silent proactive suppression accurate with resolved child tool tasks and preserves DM tool results', async () => {
  const sessionState = {
    schema: 1,
    lastImportedLocalId: 0,
    importedCount: 0,
    clearedThroughEntryId: 0,
    activeTurn: null,
    turnByTask: {
      '501': 'req-proactive',
      '502': 'req-dm',
    },
    outgoing: {},
    completedTurns: {
      'req-proactive': {
        requestId: 'req-proactive',
        taskId: '501',
        kind: 'primary',
        scopeId: null,
        botId: 'bot-b',
        deviceId: 'dev-1',
        triggerMessageId: 'req-proactive',
        sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
        replyTarget: { kind: 'primary' },
      },
      'req-dm': {
        requestId: 'req-dm',
        taskId: '502',
        kind: 'dm',
        scopeId: 'dm-1',
        botId: 'bot-b',
        deviceId: 'dev-1',
        triggerMessageId: 'msg-dm-2',
        sender: { kind: 'bot', botId: 'bot-a', deviceId: 'dev-1' },
        replyTarget: { kind: 'dm', scopeId: 'dm-1', botId: 'bot-a' },
      },
    },
    updatedAt: null,
  };

  const tasks = new Map([
    [601, { id: 601, conversationId: 11, owner: 501 }],
    [602, { id: 602, conversationId: 11, owner: 502 }],
  ]);

  const entries = [
    {
      id: 1,
      kind: USER_MESSAGE_KIND,
      data: {
        requestId: 'req-proactive',
        attribution: {
          kind: 'host',
          channel: 'primary',
          sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
          messageId: 'req-proactive',
        },
      },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Sweep batch' }] }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      byTaskId: 501,
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-gmail', name: 'gmail_search', arguments: { q: 'is:unread' } }],
      }],
    },
    {
      id: 3,
      kind: 'host.scope-message',
      data: {
        message: { text: 'Peer DM arrived mid-sweep', createdAt: '2026-11-26T00:00:00.000Z' },
        attribution: { kind: 'bot', channel: 'dm', direction: 'incoming', botId: 'bot-a', scopeId: 'dm-1' },
      },
    },
    makeToolResultEntry(4, 601, 'tc-gmail', 'gmail_search', '[]'),
    {
      id: 5,
      kind: 'pi.assistant',
      byTaskId: 501,
      model: [{ role: 'assistant', content: [{ type: 'text', text: '(pass)' }] }],
    },
    makeToolResultEntry(6, 602, 'tc-dm-2', 'send_to', '{"ok":true}'),
  ];

  const harness = {
    async snapshot(token) {
      if (token.definition.kind === 'host.primary-index') return { byPrimary: { 'public-b': 11 } };
      if (token.definition.kind === 'host.bot-session') return sessionState;
      return null;
    },
    async getTask(id) {
      return tasks.get(id) ?? null;
    },
    async conversation() {
      return {
        id: 11,
        async watch() {
          return {
            value: {
              entries,
              docs: { 'pi.live': { run: null, tools: [], nestedTools: [] }, 'pi.inbox': { items: [] } },
            },
            closed: new Promise(() => {}),
            start() {},
            async stop() {},
          };
        },
      };
    },
  };

  const runtimeLive = createRuntimeLive({
    host: { getBot: () => ({ botId: 'bot-b', deviceId: 'dev-1', primaryConversationId: 'public-b' }) },
    getHarness: () => harness,
    resolveWorkContext: async () => null,
  });

  const { onFrame, waitUntil } = createWaitUntil();
  const watch = await runtimeLive.watch('bot-b');
  try {
    watch.start(onFrame);
    const snapshot = await waitUntil((state) => state.lastEntryId === 6);
    // Proactive sweep entries (1, 2, 4, 5) — including tool-result 4 after interleaved scope-message 3 —
    // are cleanly suppressed; DM scope-message 3 and DM tool-result 6 remain visible with DM attribution!
    assert.deepEqual(snapshot.history.map((item) => item.id), [3, 6]);
    assert.equal(snapshot.history[0].attribution?.channel, 'dm');
    assert.equal(snapshot.history[1].attribution?.channel, 'dm');
    assert.equal(snapshot.history[1].attribution?.scopeId, 'dm-1');
    assert.equal(snapshot.history[1].attribution?.replyTo, 'msg-dm-2');
  } finally {
    await watch.stop();
    await runtimeLive.close();
  }
});
