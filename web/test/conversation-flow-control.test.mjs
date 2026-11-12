import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  HOST_ATTACHED_IMAGE_LINE_PREFIX,
  dedupeAttachmentMetas,
  extractEditableUserText,
  isEditablePrimaryUserTurn,
  mergeQueuedStripItems,
  mergeWithdrawnIntoDraft,
  resolveAttachmentMetasByIds,
} from '../src/composerFlowControl.ts';

import { createControlClient } from '../../host-core/control-client.js';
import { openControlServer } from '../../host-core/control-server.js';
import { createLocalControlAdapter } from '../../host-core/local-control-adapter.js';
import { openPendingClient } from '../../host-core/pending-client.js';
import { openPendingStore } from '../../host-core/pending-store.js';
import { normalizeControlCall } from '../../host-core/remote-control-protocol.js';
import { normalizeLiveSnapshot, readLiveHostFrame } from '../../host-core/remote-live-protocol.js';

import { registerApiProvider } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/compat.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';

// Valid 1x1 transparent PNG (canonical base64)
const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 30, label = 'condition', onTimeout } = {}) {
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
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}${debug ? `\nDebug: ${JSON.stringify(debug)}` : ''}`,
  );
}

test('composerFlowControl: extractEditableUserText, isEditablePrimaryUserTurn, mergeWithdrawnIntoDraft, attachment dedupe/resolve, and mergeQueuedStripItems', async () => {
  // 1. extractEditableUserText strips Host-appended image lines + separator blanks only
  const withTwoImages = [
    '请帮我看下这两张截图',
    '',
    '重点看第二张报错',
    '',
    `${HOST_ATTACHED_IMAGE_LINE_PREFIX}/data/attachments/bot1/abc`,
    `${HOST_ATTACHED_IMAGE_LINE_PREFIX}/data/attachments/bot1/def`,
  ].join('\n');
  assert.equal(extractEditableUserText(withTwoImages), '请帮我看下这两张截图\n\n重点看第二张报错');

  const imageOnly = `${HOST_ATTACHED_IMAGE_LINE_PREFIX}/data/attachments/bot1/abc`;
  assert.equal(extractEditableUserText(imageOnly), '');
  assert.equal(extractEditableUserText('普通多行文本\n\n保留末尾换行前内容'), '普通多行文本\n\n保留末尾换行前内容');

  // 2. isEditablePrimaryUserTurn enforces persisted primary user turn boundaries
  assert.equal(
    isEditablePrimaryUserTurn({
      role: 'user',
      entryId: 12,
      attribution: { kind: 'user', channel: 'primary' },
      isStreaming: false,
    }),
    true,
  );
  assert.equal(
    isEditablePrimaryUserTurn({
      role: 'user',
      entryId: 5,
      isStreaming: false,
    }),
    true,
  );
  assert.equal(
    isEditablePrimaryUserTurn({
      role: 'assistant',
      entryId: 13,
      isStreaming: false,
    }),
    false,
  );
  assert.equal(
    isEditablePrimaryUserTurn({
      role: 'user',
      entryId: Number.NaN,
      attribution: { kind: 'user', channel: 'primary' },
      isStreaming: false,
    }),
    false,
  );
  assert.equal(
    isEditablePrimaryUserTurn({
      role: 'user',
      entryId: 14,
      attribution: { kind: 'user', channel: 'room' },
      isStreaming: false,
    }),
    false,
  );
  assert.equal(
    isEditablePrimaryUserTurn({
      role: 'user',
      entryId: 15,
      attribution: { kind: 'host', channel: 'primary' },
      isStreaming: false,
    }),
    false,
  );

  // 3. mergeWithdrawnIntoDraft prepends recalled messages ahead of unsent draft
  assert.equal(
    mergeWithdrawnIntoDraft('正在输入半截草稿', ['第一条排队消息', '  ', '第二条排队消息']),
    '第一条排队消息\n\n第二条排队消息\n\n正在输入半截草稿',
  );
  assert.equal(mergeWithdrawnIntoDraft('', ['唯一撤回消息']), '唯一撤回消息');
  assert.equal(mergeWithdrawnIntoDraft('原草稿不变', []), '原草稿不变');

  // 4. resolveAttachmentMetasByIds strips base64 data & dedupeAttachmentMetas prepends recalled
  const idA = 'a'.repeat(64);
  const idB = 'b'.repeat(64);
  const idC = 'c'.repeat(64);
  const resolved = await resolveAttachmentMetasByIds([idA, idA, idB, 'missing'], async (id) => {
    if (id === 'missing') throw new Error('not found');
    return {
      id,
      name: `${id.slice(0, 4)}.png`,
      mimeType: 'image/png',
      size: 68,
      width: 1,
      height: 1,
      data: ONE_BY_ONE_PNG_BASE64,
    };
  });
  assert.equal(resolved.length, 2);
  assert.equal('data' in resolved[0], false);
  assert.equal(resolved[0].id, idA);
  assert.equal(resolved[1].id, idB);

  const existingAtt = [{ id: idB, name: 'b.png', mimeType: 'image/png', size: 68, width: 1, height: 1 }, { id: idC, name: 'c.png', mimeType: 'image/png', size: 68, width: 1, height: 1 }];
  const deduped = dedupeAttachmentMetas(existingAtt, resolved, 4);
  assert.deepEqual(deduped.map((x) => x.id), [idA, idB, idC]);

  // Default maxCount (no 3rd argument) retains up to 16 images (does NOT truncate >4 items such as 6)
  const makeAtt = (idx) => ({
    id: idx.toString(16).padStart(64, '0'),
    name: `img-${idx}.png`,
    mimeType: 'image/png',
    size: 68,
    width: 1,
    height: 1,
  });
  const sixDefault = dedupeAttachmentMetas(
    [makeAtt(5), makeAtt(6)],
    [makeAtt(1), makeAtt(2), makeAtt(3), makeAtt(4)],
  );
  assert.equal(sixDefault.length, 6);
  assert.deepEqual(
    sixDefault.map((x) => x.name),
    ['img-1.png', 'img-2.png', 'img-3.png', 'img-4.png', 'img-5.png', 'img-6.png'],
  );

  const cappedAtSixteen = dedupeAttachmentMetas(
    Array.from({ length: 8 }, (_, i) => makeAtt(100 + i)),
    Array.from({ length: 12 }, (_, i) => makeAtt(1 + i)),
  );
  assert.equal(cappedAtSixteen.length, 16);

  // 5. mergeQueuedStripItems deduplicates Host live items + unsent pending outbox records
  const merged = mergeQueuedStripItems(
    [
      {
        requestId: 'req-1',
        preview: 'Host 排队一',
        delivery: 'followUp',
        attachmentCount: 0,
      },
    ],
    [
      {
        id: '00000000-0000-4000-8000-000000000001',
        deviceId: 'dev-client',
        kind: 'primary',
        targetDeviceId: 'dev-host',
        botId: 'bot-1',
        requestId: 'req-1',
        text: '重复项应去重',
        state: 'pending',
        receipt: null,
        lastError: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        deviceId: 'dev-client',
        kind: 'primary',
        targetDeviceId: 'dev-host',
        botId: 'bot-1',
        requestId: 'req-2',
        text: '',
        attachments: [idA, idB],
        delivery: 'steer',
        state: 'pending',
        receipt: null,
        lastError: null,
        createdAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        deviceId: 'dev-client',
        kind: 'primary',
        targetDeviceId: 'dev-host',
        botId: 'bot-other',
        requestId: 'req-other',
        text: '其他 Bot 不混入',
        state: 'pending',
        receipt: null,
        lastError: null,
        createdAt: '2026-01-01T00:00:02.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
    ],
    'bot-1',
    'dev-host',
  );
  assert.deepEqual(
    merged.map((m) => ({
      requestId: m.requestId,
      preview: m.preview,
      delivery: m.delivery,
      attachmentCount: m.attachmentCount,
      source: m.source,
    })),
    [
      {
        requestId: 'req-1',
        preview: 'Host 排队一',
        delivery: 'followUp',
        attachmentCount: 0,
        source: 'host',
      },
      {
        requestId: 'req-2',
        preview: '[图片 ×2]',
        delivery: 'steer',
        attachmentCount: 2,
        source: 'outbox',
      },
    ],
  );
});

test('remote-control-protocol & remote-live-protocol: validate delivery, withdrawQueued, steerQueued, editMessage, and queuedItems', () => {
  const steerSubmit = normalizeControlCall('submit', {
    botId: 'bot-1',
    requestId: 'req-steer',
    text: '立刻打断',
    delivery: 'steer',
  });
  assert.equal(steerSubmit.params.delivery, 'steer');

  assert.throws(
    () =>
      normalizeControlCall('submit', {
        botId: 'bot-1',
        requestId: 'req-bad',
        text: '非法模式',
        delivery: 'urgent',
      }),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  const withdrawAll = normalizeControlCall('withdrawQueued', { botId: 'bot-1' });
  assert.deepEqual(withdrawAll.params, { botId: 'bot-1' });

  const withdrawOne = normalizeControlCall('withdrawQueued', {
    botId: 'bot-1',
    requestId: 'req-1',
  });
  assert.deepEqual(withdrawOne.params, { botId: 'bot-1', requestId: 'req-1' });

  const steerQueuedCall = normalizeControlCall('steerQueued', {
    botId: 'bot-1',
    requestId: 'req-1',
  });
  assert.deepEqual(steerQueuedCall.params, { botId: 'bot-1', requestId: 'req-1' });

  const editCall = normalizeControlCall('editMessage', {
    botId: 'bot-1',
    entryId: 7,
    requestId: 'req-edit-7',
    text: '编辑后的问题',
  });
  assert.equal(editCall.params.entryId, 7);

  assert.throws(
    () =>
      normalizeControlCall('editMessage', {
        botId: 'bot-1',
        entryId: 0,
        requestId: 'req-edit-0',
        text: 'bad',
      }),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  const longAsciiReqId = 'req-' + 'a'.repeat(196); // 200 UTF-8 bytes (>128 chars)
  const emojiReqId = 'req-' + '🚀'.repeat(40); // 164 UTF-8 bytes (<=256), surrogate pairs
  const longEmojiReqId = 'req-' + 'b'.repeat(75) + '-' + '🚀'.repeat(40); // 240 UTF-8 bytes, 160 UTF-16 code units (>128)
  assert.ok(Buffer.byteLength(longAsciiReqId, 'utf8') === 200);
  assert.ok(Buffer.byteLength(emojiReqId, 'utf8') <= 256);
  assert.ok(Buffer.byteLength(longEmojiReqId, 'utf8') <= 256);

  for (const id of [longAsciiReqId, emojiReqId, longEmojiReqId]) {
    assert.equal(
      normalizeControlCall('submit', { botId: 'bot-1', requestId: id, text: 'ok' }).params.requestId,
      id,
    );
    assert.equal(
      normalizeControlCall('withdrawQueued', { botId: 'bot-1', requestId: id }).params.requestId,
      id,
    );
  }

  const baseLiveState = {
    history: [],
    historyTruncated: false,
    lastEntryId: null,
    generation: null,
    tools: [],
    toolsTruncated: false,
    busy: true,
    queuedCount: 4,
    queuedItems: [
      {
        requestId: 'req-q1',
        preview: '排队摘要',
        delivery: 'steer',
        attachmentCount: 2,
      },
      {
        requestId: longAsciiReqId,
        preview: '200字节ASCII请求ID',
        delivery: 'followUp',
        attachmentCount: 0,
      },
      {
        requestId: emojiReqId,
        preview: 'Emoji代理对请求ID',
        delivery: 'followUp',
        attachmentCount: 0,
      },
      {
        requestId: longEmojiReqId,
        preview: '超128码元含Emoji请求ID',
        delivery: 'steer',
        attachmentCount: 1,
      },
    ],
    turnAdmission: null,
  };

  const snapshotFrame = normalizeLiveSnapshot(
    {
      type: 'snapshot',
      botId: 'bot-1',
      conversationId: 'conv-1',
      sequence: 1,
      state: baseLiveState,
    },
    { kind: 'primary', botId: 'bot-1' },
  );
  assert.equal(snapshotFrame.state.queuedItems.length, 4);
  assert.equal(snapshotFrame.state.queuedItems[0].delivery, 'steer');
  assert.deepEqual(
    snapshotFrame.state.queuedItems.map((q) => q.requestId),
    ['req-q1', longAsciiReqId, emojiReqId, longEmojiReqId],
  );

  const hostLiveFrame = readLiveHostFrame({
    type: 'live-frame',
    routeId: 'route-1',
    frame: {
      type: 'snapshot',
      botId: 'bot-1',
      conversationId: 'conv-1',
      sequence: 1,
      state: baseLiveState,
    },
  });
  assert.deepEqual(
    hostLiveFrame.frame.state.queuedItems.map((q) => q.requestId),
    ['req-q1', longAsciiReqId, emojiReqId, longEmojiReqId],
  );

  assert.throws(
    () =>
      normalizeLiveSnapshot(
        {
          type: 'snapshot',
          botId: 'bot-1',
          conversationId: 'conv-1',
          sequence: 2,
          state: {
            ...baseLiveState,
            queuedItems: [{ requestId: 'req-q1', preview: 'bad', delivery: 'invalid', attachmentCount: 0 }],
          },
        },
        { kind: 'primary', botId: 'bot-1' },
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );
});

test('pending-store & pending-client: legacy v1 migration, delivery: steer persistence, conflict detection, submit forwarding, and cancel', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-pending-steer-'));
  let pendingClient = null;
  try {
    // 1. Legacy schema v1 DB without attachments_json or delivery columns migrates smoothly
    const legacyDir = join(rootDir, 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    {
      const db = new DatabaseSync(join(legacyDir, 'client-pending.sqlite'));
      db.exec(`
        CREATE TABLE pending_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          device_id TEXT NOT NULL
        );
        CREATE TABLE pending_rows (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('primary', 'room')),
          target_device_id TEXT NOT NULL,
          bot_id TEXT,
          scope_id TEXT,
          request_id TEXT,
          message_id TEXT,
          text TEXT NOT NULL,
          reply_to TEXT,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'unconfirmed', 'accepted', 'rejected')),
          receipt_json TEXT,
          last_error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_pending_primary_key ON pending_rows(target_device_id, bot_id, request_id)
          WHERE kind = 'primary';
        CREATE UNIQUE INDEX idx_pending_room_key ON pending_rows(target_device_id, scope_id, message_id)
          WHERE kind = 'room';
        INSERT INTO pending_identity (id, device_id) VALUES (1, 'dev-client');
        PRAGMA user_version = 1;
      `);
      db.close();
    }

    const migratedStore = openPendingStore(legacyDir, 'dev-client');
    const migratedRow = migratedStore.enqueue({
      kind: 'primary',
      targetDeviceId: 'dev-host',
      botId: 'bot-1',
      requestId: 'req-migrated-steer',
      text: '平滑迁移后的打断消息',
      delivery: 'steer',
    });
    assert.equal(migratedRow.delivery, 'steer');
    migratedStore.close();

    // 2. openPendingClient forwards delivery: 'steer', detects delivery conflicts, and supports local cancel
    const calls = [];
    const clientDir = join(rootDir, 'client');
    pendingClient = openPendingClient({
      dataRoot: clientDir,
      deviceId: 'dev-client',
      call: async (targetDeviceId, method, params) => {
        calls.push({ targetDeviceId, method, params });
        return {
          botId: params.botId,
          conversationId: 'conv-primary',
          requestId: params.requestId,
          submissionId: null,
          status: 'queued',
          admission: { requestId: params.requestId, phase: 'queued' },
          answerText: null,
          reason: null,
        };
      },
    });

    const recSteer = await pendingClient.enqueue({
      kind: 'primary',
      targetDeviceId: 'dev-host',
      botId: 'bot-1',
      requestId: 'req-steer-1',
      text: '立刻插队发送',
      delivery: 'steer',
    });
    assert.equal(recSteer.delivery, 'steer');

    // Idempotent enqueue with matching delivery succeeds
    const recSteerAgain = await pendingClient.enqueue({
      kind: 'primary',
      targetDeviceId: 'dev-host',
      botId: 'bot-1',
      requestId: 'req-steer-1',
      text: '立刻插队发送',
      delivery: 'steer',
    });
    assert.equal(recSteerAgain.id, recSteer.id);

    // Conflicting delivery mode on same requestId throws REQUEST_CONFLICT
    await assert.rejects(
      pendingClient.enqueue({
        kind: 'primary',
        targetDeviceId: 'dev-host',
        botId: 'bot-1',
        requestId: 'req-steer-1',
        text: '立刻插队发送',
        delivery: 'followUp',
      }),
      (err) => err?.code === 'REQUEST_CONFLICT',
    );

    const sent = await pendingClient.send(recSteer.id);
    assert.equal(sent.state, 'accepted');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      targetDeviceId: 'dev-host',
      method: 'submit',
      params: {
        botId: 'bot-1',
        requestId: 'req-steer-1',
        text: '立刻插队发送',
        delivery: 'steer',
      },
    });

    // Unsent pending item can be locally cancelled on Stop/withdraw
    const recCancel = await pendingClient.enqueue({
      kind: 'primary',
      targetDeviceId: 'dev-host',
      botId: 'bot-1',
      requestId: 'req-cancel-local',
      text: '断网尚未发出的排队消息',
    });
    const cancelled = await pendingClient.cancel(recCancel.id);
    assert.equal(cancelled.state, 'rejected');
    assert.equal(cancelled.lastError?.code, 'CANCELLED');
    assert.equal(cancelled.lastError?.outcome, 'not-sent');
  } finally {
    if (pendingClient) await pendingClient.close();
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('end-to-end full stack: followUp queue, withdrawQueued without stopping, steerQueued + delivery:steer postTools injection, abort recall, and editMessage (strict RUNTIME_BUSY + rewind + reset boundary + live rebind)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-flow-e2e-'));
  const botCwd = mkdtempSync(join(tmpdir(), 'pibot-flow-cwd-'));
  const liveAbort = new AbortController();
  let liveLoopPromise = Promise.resolve();
  let server = null;
  try {

  const apiName = `mock-flow-api-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let llmHandler = async () => [{ type: 'text', text: 'ok' }];

  const makeStream = (model, reqContext, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;
    const baseUsage = {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    queueMicrotask(async () => {
      const abortMessage = () => ({
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: baseUsage,
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
        const blocks = await llmHandler(reqContext, model, signal);
        if (settled || signal?.aborted) {
          finishAbort();
          return;
        }
        settled = true;
        const hasToolCall = blocks.some((b) => b.type === 'toolCall');
        const message = {
          role: 'assistant',
          content: blocks,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: baseUsage,
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
          usage: baseUsage,
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
    'conversation-flow-control-test',
  );

  let currentSnapshot = null;
  const centerClient = {
    providerAuth: async () => ({ auth: { apiKey: 'mock-center-key' }, source: 'center' }),
  };
  const centerRuntime = {
    snapshot: { protocol: 1 },
    installer: {},
    getClient: () => centerClient,
    prepareTurn: async () => ({
      setId: `set-rev-${currentSnapshot.revision}`,
      snapshot: currentSnapshot,
    }),
    confirmTurn: async ({ requestId, setId }) => ({
      admissionId: `adm-${requestId}`,
      setId,
    }),
    restoreTurn: async () => ({
      setId: `set-rev-${currentSnapshot.revision}`,
      snapshot: currentSnapshot,
    }),
  };

  const token = 'test_control_token_0123456789abcdef0123456789';
  server = await openControlServer({
    port: 0,
    token,
    deferResume: true,
    dataRoot: join(rootDir, 'host-data'),
    nativeBridge: async () => ({}),
    centerRuntime,
  });

  const makeSnapshot = (revision, bots) => ({
    protocol: 1,
    deviceId: server.deviceId,
    revision,
    providers: [
      {
        id: 'mock-center',
        name: 'Mock Center',
        api: apiName,
        baseUrl: 'http://127.0.0.1:9',
        enabled: true,
        credentialRef: null,
      },
    ],
    models: {
      'mock-center': [
        {
          id: 'mock-vision',
          name: 'Mock Vision',
          api: apiName,
          contextWindow: 128_000,
          maxTokens: 4_096,
          input: ['text', 'image'],
          reasoning: false,
          enabled: true,
          revision: 1,
        },
      ],
    },
    credentials: {},
    bots,
  });

  currentSnapshot = makeSnapshot(1, []);
  await server.applyCenterSnapshot(currentSnapshot);
  await server.setCenterOnline(true);
  await server.restoreTurns();
  server.resume();

  const controlClient = createControlClient({ url: server.url, token });
  const localAdapter = createLocalControlAdapter({ url: server.url, token });

  const bot = await controlClient.createBot({
    requestId: 'create-flow-bot',
    role: 'FlowAssistant',
    cwd: botCwd,
    makePrimary: true,
  });

  currentSnapshot = makeSnapshot(2, [
    {
      botId: bot.botId,
      cwd: botCwd,
      model: {
        modelRef: 'mock-center/mock-vision',
        thinkingLevel: 'off',
        codemode: false,
        codemodeOnly: false,
      },
      capabilities: [],
    },
  ]);
  const applied = await server.applyCenterSnapshot(currentSnapshot);
  assert.equal(applied.status, 'applied');

  // Start a persistent live watcher across the entire test (including editMessage rebind!)
  let liveState = null;
  let liveSeq = 0;
  let liveEnded = false;
  liveLoopPromise = (async () => {
    try {
      for await (const frame of localAdapter.live(server.deviceId, { kind: 'primary', botId: bot.botId }, { signal: liveAbort.signal })) {
        liveSeq = frame.sequence;
        if (frame.type === 'snapshot') {
          liveState = frame.state;
        } else if (frame.type === 'update' && liveState) {
          liveState = { ...liveState, ...frame.changes };
        }
      }
    } catch {
      /* aborted at test teardown */
    } finally {
      liveEnded = true;
    }
  })();

  await waitUntil(() => liveState !== null, { label: 'initial live snapshot' });

  // Upload a 1x1 PNG attachment for recall/queue verification
  const uploadedAtt = await controlClient.uploadAttachment(bot.botId, {
    name: 'diagram.png',
    mimeType: 'image/png',
    data: ONE_BY_ONE_PNG_BASE64,
  });
  assert.equal(uploadedAtt.width, 1);
  assert.equal(uploadedAtt.height, 1);

  // =========================================================================
  // Scenario A: Default followUp queue + withdrawQueued without stopping +
  // steerQueued promotion + mid-turn delivery:'steer' injection at postTools
  // =========================================================================
  const turn1FirstCallStarted = createDeferred();
  const releaseTurn1ToolCall = createDeferred();
  const seenRequests = [];

  llmHandler = async (reqContext) => {
    const messages = reqContext?.messages ?? [];
    const serialized = JSON.stringify(messages);
    const lastMsg = messages.at(-1);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastUserSerialized = JSON.stringify(lastUser?.content ?? '');
    seenRequests.push({ role: lastMsg?.role, serialized });

    if (lastUserSerialized.includes('排队保留到下一轮')) {
      return [{ type: 'text', text: '第二轮按 FIFO 完成回答' }];
    }
    if (serialized.includes('请先检查目录再回答')) {
      if (lastMsg?.role !== 'toolResult' && !serialized.includes('补充打断条件A')) {
        turn1FirstCallStarted.resolve(true);
        await releaseTurn1ToolCall.promise;
        return [
          {
            type: 'toolCall',
            id: 'call_ls_1',
            name: 'ls',
            arguments: { path: botCwd },
          },
        ];
      }
      return [{ type: 'text', text: '已结合打断指令完成第一轮回答' }];
    }
    return [{ type: 'text', text: 'ok' }];
  };

  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-turn-1',
    text: '请先检查目录再回答',
  });
  await turn1FirstCallStarted.promise;
  await waitUntil(() => liveState?.activity?.phase === 'running', { label: 'Turn 1 running' });

  // Enqueue two default followUp messages while Turn 1 is running
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-follow-keep',
    text: '排队保留到下一轮',
  });
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-follow-withdraw',
    text: '这条准备不停止直接撤回修改',
    attachments: [uploadedAtt.id],
  });

  await waitUntil(
    () => (liveState?.queuedItems?.length ?? 0) === 2,
    { label: '2 followUp items projected in live.queuedItems', onTimeout: () => liveState },
  );
  assert.deepEqual(
    liveState.queuedItems.map((q) => ({
      requestId: q.requestId,
      delivery: q.delivery,
      attachmentCount: q.attachmentCount,
    })),
    [
      { requestId: 'req-follow-keep', delivery: 'followUp', attachmentCount: 0 },
      { requestId: 'req-follow-withdraw', delivery: 'followUp', attachmentCount: 1 },
    ],
  );

  // Withdraw ONLY req-follow-withdraw WITHOUT stopping Turn 1!
  const singleWithdraw = await localAdapter(server.deviceId, 'withdrawQueued', {
    botId: bot.botId,
    requestId: 'req-follow-withdraw',
  });
  assert.deepEqual(singleWithdraw, {
    botId: bot.botId,
    withdrawn: [
      {
        requestId: 'req-follow-withdraw',
        text: '这条准备不停止直接撤回修改',
        attachments: [uploadedAtt.id],
        delivery: 'followUp',
      },
    ],
  });
  assert.equal(liveState?.activity?.phase, 'running');
  await waitUntil(() => (liveState?.queuedItems?.length ?? 0) === 1, { label: '1 item left in queue' });
  assert.equal(liveState.queuedItems[0].requestId, 'req-follow-keep');

  // Verify 200-byte ASCII requestId & emoji surrogate-pair requestId survive submit -> live.queuedItems -> single withdrawQueued intact!
  const e2eLongAsciiReqId = 'req-' + 'a'.repeat(196);
  const e2eEmojiReqId = 'req-' + '🚀'.repeat(40);
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: e2eLongAsciiReqId,
    text: '长200字节ASCII排队撤回验证',
  });
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: e2eEmojiReqId,
    text: '含Emoji代理对排队撤回验证',
  });
  await waitUntil(
    () => (liveState?.queuedItems?.length ?? 0) === 3,
    { label: 'long ASCII + emoji requestIds projected in live.queuedItems', onTimeout: () => liveState },
  );
  assert.equal(liveEnded, false, 'live SSE stream must not break on long or emoji requestId');
  assert.deepEqual(
    liveState.queuedItems.map((q) => q.requestId),
    ['req-follow-keep', e2eLongAsciiReqId, e2eEmojiReqId],
  );

  const withdrawnLongAscii = await localAdapter(server.deviceId, 'withdrawQueued', {
    botId: bot.botId,
    requestId: e2eLongAsciiReqId,
  });
  assert.deepEqual(withdrawnLongAscii, {
    botId: bot.botId,
    withdrawn: [
      {
        requestId: e2eLongAsciiReqId,
        text: '长200字节ASCII排队撤回验证',
        delivery: 'followUp',
      },
    ],
  });

  const withdrawnEmoji = await localAdapter(server.deviceId, 'withdrawQueued', {
    botId: bot.botId,
    requestId: e2eEmojiReqId,
  });
  assert.deepEqual(withdrawnEmoji, {
    botId: bot.botId,
    withdrawn: [
      {
        requestId: e2eEmojiReqId,
        text: '含Emoji代理对排队撤回验证',
        delivery: 'followUp',
      },
    ],
  });
  await waitUntil(() => (liveState?.queuedItems?.length ?? 0) === 1, { label: 'back to 1 item after long/emoji withdraw' });
  assert.equal(liveState.queuedItems[0].requestId, 'req-follow-keep');

  // Enqueue req-promote and promote it to steer via steerQueued, plus send a direct delivery:'steer'
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-promote-steer',
    text: '补充打断条件A',
  });
  const promoted = await localAdapter(server.deviceId, 'steerQueued', {
    botId: bot.botId,
    requestId: 'req-promote-steer',
  });
  assert.equal(promoted.status, 'steered');

  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-direct-steer',
    text: '补充打断条件B',
    delivery: 'steer',
  });

  // Wait until both steer items are placed into pi.inbox before releasing Turn 1's tool call
  await waitUntil(
    async () => {
      const subA = await controlClient.getSubmission(bot.botId, 'req-promote-steer');
      const subB = await controlClient.getSubmission(bot.botId, 'req-direct-steer');
      return (
        (subA?.status === 'queued' || subA?.status === 'placed') &&
        subA?.admission === undefined &&
        (subB?.status === 'queued' || subB?.status === 'placed') &&
        subB?.admission === undefined
      );
    },
    { label: 'steer submissions placed into native pi.inbox' },
  );

  // Release Turn 1's ls tool call -> SDK runs ls -> injects steer items at postTools boundary!
  releaseTurn1ToolCall.resolve();

  await waitUntil(
    async () => {
      const s1 = await controlClient.getSubmission(bot.botId, 'req-turn-1');
      const sKeep = await controlClient.getSubmission(bot.botId, 'req-follow-keep');
      return s1?.status === 'done' && sKeep?.status === 'done';
    },
    {
      label: 'Turn 1 and followUp Turn 2 completed',
      onTimeout: async () => ({
        s1: await controlClient.getSubmission(bot.botId, 'req-turn-1'),
        sKeep: await controlClient.getSubmission(bot.botId, 'req-follow-keep'),
        liveState,
      }),
    },
  );

  // Verify Turn 1's post-tool LLM request saw both steer messages BEFORE req-follow-keep!
  const postToolCall = seenRequests.find(
    (r) => r.serialized.includes('补充打断条件A') && r.serialized.includes('补充打断条件B'),
  );
  assert.ok(postToolCall, 'active run received both steer messages at postTools boundary');
  assert.equal(
    postToolCall.serialized.includes('排队保留到下一轮'),
    false,
    'followUp item stayed in FIFO queue until active run finished',
  );

  const followUpCallIndex = seenRequests.findIndex((r) => r.serialized.includes('排队保留到下一轮'));
  const postToolCallIndex = seenRequests.indexOf(postToolCall);
  assert.ok(followUpCallIndex > postToolCallIndex, 'followUp ran after steered primary turn finished');

  // =========================================================================
  // Scenario B: Stop (abort) recalls BOTH pi.inbox steer items & TurnQueue
  // followUp items in order with raw user text & attachments
  // =========================================================================
  const slowTurnStarted = createDeferred();
  llmHandler = async (_req, _model, signal) => {
    slowTurnStarted.resolve(true);
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return [{ type: 'text', text: 'aborted' }];
  };

  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-slow-run',
    text: '执行一个很慢的任务',
  });
  await slowTurnStarted.promise;
  await waitUntil(() => liveState?.activity?.phase === 'running', { label: 'slow turn running' });

  // 1) Steer item -> lands in pi.inbox (with image attachment -> Host appends path line to content,
  //    but sourceMessageEntry.data.userText preserves raw user text!)
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-abort-inbox',
    text: '已进收件箱的打断消息',
    attachments: [uploadedAtt.id],
    delivery: 'steer',
  });
  await waitUntil(
    async () => {
      const sub = await controlClient.getSubmission(bot.botId, 'req-abort-inbox');
      return sub && sub.admission === undefined;
    },
    { label: 'req-abort-inbox admitted to pi.inbox' },
  );

  // 2) FollowUp item -> stays in TurnQueue
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-abort-queue',
    text: '仍在队列里的后续消息',
  });

  await waitUntil(
    () => (liveState?.queuedItems?.length ?? 0) === 2,
    { label: 'both inbox + queue items visible in live.queuedItems', onTimeout: () => liveState },
  );

  const abortResult = await localAdapter(server.deviceId, 'abort', { botId: bot.botId });
  assert.deepEqual(abortResult, {
    botId: bot.botId,
    withdrawn: [
      {
        requestId: 'req-abort-inbox',
        text: '已进收件箱的打断消息',
        attachments: [uploadedAtt.id],
        delivery: 'steer',
      },
      {
        requestId: 'req-abort-queue',
        text: '仍在队列里的后续消息',
        delivery: 'followUp',
      },
    ],
  });
  await waitUntil(
    () => (liveState?.queuedItems?.length ?? 0) === 0 && liveState?.activity?.phase !== 'running',
    { label: 'queue cleared and run stopped after abort' },
  );

  // =========================================================================
  // Scenario C: Historical message editing (editMessage)
  //   1) Strict RUNTIME_BUSY rejection whenever Bot is busy
  //   2) Middle-message rewind (forkConversation) + live watcher rebind
  //   3) First-message rewind (createConversation)
  //   4) Post-/clear (pi.reset) boundary enforcement
  // =========================================================================
  // Clear prior history first so Scenario C has a clean slate
  const initialClear = await controlClient.clearHistory(bot.botId);
  assert.ok(Number.isSafeInteger(initialClear.clearedThroughEntryId));

  const latestUserPromptJson = (reqContext) => {
    const msgs = [...(reqContext?.messages ?? [])].reverse();
    for (const m of msgs) {
      if (m?.role !== 'user') continue;
      const s = JSON.stringify(m.content ?? '');
      if (s.includes('<host-turn-context>') || s.includes('replyTarget')) continue;
      return s;
    }
    return '';
  };

  llmHandler = async (reqContext) => {
    const txt = latestUserPromptJson(reqContext);
    if (txt.includes('第一问原版')) return [{ type: 'text', text: '第一答原版' }];
    if (txt.includes('第二问原版')) return [{ type: 'text', text: '第二答原版' }];
    if (txt.includes('第二问修改版')) return [{ type: 'text', text: '第二答修改版' }];
    if (txt.includes('第一问彻底重写')) return [{ type: 'text', text: '第一答重写版' }];
    if (txt.includes('清空后新问题')) return [{ type: 'text', text: '清空后新回答' }];
    if (txt.includes('清空后修改问题')) return [{ type: 'text', text: '清空后修改回答' }];
    return [{ type: 'text', text: '通用回答' }];
  };

  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-c-1',
    text: '第一问原版',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot.botId, 'req-c-1'))?.status === 'done',
    { label: 'req-c-1 done' },
  );

  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-c-2',
    text: '第二问原版',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot.botId, 'req-c-2'))?.status === 'done',
    { label: 'req-c-2 done' },
  );

  const histBefore = await controlClient.history(bot.botId, { limit: 50 });
  const userEntriesBefore = histBefore.items.filter((it) => it.kind === 'host.user-message');
  assert.equal(userEntriesBefore.length, 2);
  const firstEntryId = userEntriesBefore[0].id;
  const secondEntryId = userEntriesBefore[1].id;

  // C.1: Start a slow turn and verify editMessage is STRICTLY rejected with RUNTIME_BUSY while busy!
  const busyTurnStarted = createDeferred();
  llmHandler = async (_req, _model, signal) => {
    busyTurnStarted.resolve(true);
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    return [{ type: 'text', text: 'aborted' }];
  };
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-c-busy',
    text: '忙碌中尝试编辑历史',
  });
  await busyTurnStarted.promise;

  await assert.rejects(
    localAdapter(server.deviceId, 'editMessage', {
      botId: bot.botId,
      entryId: secondEntryId,
      requestId: 'req-edit-while-busy',
      text: '不允许在忙碌时编辑',
    }),
    (err) => err?.code === 'RUNTIME_BUSY' && err?.outcome === 'responded',
  );

  await localAdapter(server.deviceId, 'abort', { botId: bot.botId });
  await waitUntil(() => liveState?.activity?.phase !== 'running', { label: 'busy turn aborted' });

  // Restore deterministic reply handler
  llmHandler = async (reqContext) => {
    const serialized = JSON.stringify(reqContext?.messages ?? []);
    const txt = latestUserPromptJson(reqContext);
    if (txt.includes('第二问修改版')) {
      // Confirm rewound context still has 第一问原版, and does NOT have 第二问原版!
      assert.equal(serialized.includes('第一问原版'), true);
      assert.equal(serialized.includes('第二问原版'), false);
      return [{ type: 'text', text: '第二答修改版' }];
    }
    if (txt.includes('第一问彻底重写')) {
      assert.equal(serialized.includes('第一问原版'), false);
      assert.equal(serialized.includes('第二问修改版'), false);
      return [{ type: 'text', text: '第一答重写版' }];
    }
    if (txt.includes('分叉重写首轮并保留未读收件')) {
      assert.equal(serialized.includes('第一问原版'), false);
      assert.equal(serialized.includes('第二问原版'), false);
      assert.equal(serialized.includes('未导入的群聊上下文：端口改为 9091'), true);
      return [{ type: 'text', text: '首轮分叉且保留未读收件回答' }];
    }
    if (txt.includes('清空后新问题')) return [{ type: 'text', text: '清空后新回答' }];
    if (txt.includes('清空后修改问题')) return [{ type: 'text', text: '清空后修改回答' }];
    return [{ type: 'text', text: '通用回答' }];
  };

  // C.2: Edit the SECOND user message (forkConversation before secondEntryId)
  const seqBeforeEdit = liveSeq;
  const editSecondReceipt = await localAdapter(server.deviceId, 'editMessage', {
    botId: bot.botId,
    entryId: secondEntryId,
    requestId: 'req-edit-second',
    text: '第二问修改版',
  });
  assert.equal(editSecondReceipt.requestId, 'req-edit-second');
  await waitUntil(
    async () => (await controlClient.getSubmission(bot.botId, 'req-edit-second'))?.status === 'done',
    { label: 'req-edit-second done' },
  );

  const histAfterSecondEdit = await controlClient.history(bot.botId, { limit: 50 });
  const textsAfterSecondEdit = histAfterSecondEdit.items
    .filter((it) => it.kind === 'host.user-message' || it.kind === 'pi.assistant')
    .map((it) => JSON.stringify(it.model));
  assert.equal(textsAfterSecondEdit.some((s) => s.includes('第一问原版')), true);
  assert.equal(textsAfterSecondEdit.some((s) => s.includes('第一答原版')), true);
  assert.equal(textsAfterSecondEdit.some((s) => s.includes('第二问修改版')), true);
  assert.equal(textsAfterSecondEdit.some((s) => s.includes('第二答修改版')), true);
  assert.equal(textsAfterSecondEdit.some((s) => s.includes('第二问原版')), false);
  assert.equal(textsAfterSecondEdit.some((s) => s.includes('第二答原版')), false);

  // Verify the persistent live watcher stayed open across rebind and advanced sequence!
  assert.equal(liveEnded, false, 'live SSE watcher survived conversation fork + rebind');
  await waitUntil(() => liveSeq > seqBeforeEdit, { label: 'live sequence advanced after rebind' });

  // C.3: Edit the FIRST user message in the forked conversation!
  // Note: after InitialClear earlier, firstEntryId had a resetEntry before it; let's get the current first user entry
  // AND also test editing the very first entry of a brand-new conversation (beforeEntryId === null -> createConversation)!
  const userEntriesInFork = histAfterSecondEdit.items.filter((it) => it.kind === 'host.user-message');
  const forkedFirstEntryId = userEntriesInFork[0].id;

  await localAdapter(server.deviceId, 'editMessage', {
    botId: bot.botId,
    entryId: forkedFirstEntryId,
    requestId: 'req-edit-first-after-reset',
    text: '第一问彻底重写',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot.botId, 'req-edit-first-after-reset'))?.status === 'done',
    { label: 'req-edit-first-after-reset done' },
  );

  const histAfterFirstEdit = await controlClient.history(bot.botId, { limit: 50 });
  const textsAfterFirstEdit = histAfterFirstEdit.items
    .filter((it) => it.kind === 'host.user-message' || it.kind === 'pi.assistant')
    .map((it) => JSON.stringify(it.model));
  assert.equal(textsAfterFirstEdit.length, 2);
  assert.equal(textsAfterFirstEdit[0].includes('第一问彻底重写'), true);
  assert.equal(textsAfterFirstEdit[1].includes('第一答重写版'), true);

  // C.4: Test /clear (pi.reset) boundary + editing on a fresh Bot with zero prior entries (beforeEntryId === null)
  const postEditClear = await controlClient.clearHistory(bot.botId);
  await localAdapter(server.deviceId, 'submit', {
    botId: bot.botId,
    requestId: 'req-post-clear-1',
    text: '清空后新问题',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot.botId, 'req-post-clear-1'))?.status === 'done',
    { label: 'req-post-clear-1 done' },
  );

  // Editing an entryId <= clearedThroughEntryId must fail with INVALID_ARGUMENT
  await assert.rejects(
    localAdapter(server.deviceId, 'editMessage', {
      botId: bot.botId,
      entryId: postEditClear.clearedThroughEntryId,
      requestId: 'req-edit-before-reset',
      text: '尝试编辑已清空之前的条目',
    }),
    (err) => err?.code === 'INVALID_ARGUMENT' && err?.outcome === 'responded',
  );

  // Create a brand-new second Bot (zero reset entries -> entry #1 has beforeEntryId === null -> createConversation branch!)
  const bot2 = await controlClient.createBot({
    requestId: 'create-fresh-bot',
    role: 'FreshBot',
    cwd: botCwd,
    makePrimary: false,
  });
  currentSnapshot = makeSnapshot(3, [
    ...currentSnapshot.bots,
    {
      botId: bot2.botId,
      cwd: botCwd,
      model: {
        modelRef: 'mock-center/mock-vision',
        thinkingLevel: 'off',
        codemode: false,
        codemodeOnly: false,
      },
      capabilities: [],
    },
  ]);
  await server.applyCenterSnapshot(currentSnapshot);

  await localAdapter(server.deviceId, 'submit', {
    botId: bot2.botId,
    requestId: 'req-fresh-1',
    text: '第一问原版',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot2.botId, 'req-fresh-1'))?.status === 'done',
    { label: 'req-fresh-1 done' },
  );

  await localAdapter(server.deviceId, 'submit', {
    botId: bot2.botId,
    requestId: 'req-fresh-2',
    text: '第二问原版',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot2.botId, 'req-fresh-2'))?.status === 'done',
    { label: 'req-fresh-2 done' },
  );

  const bot2Hist = await controlClient.history(bot2.botId, { limit: 20 });
  const bot2UserEntries = bot2Hist.items.filter((it) => it.kind === 'host.user-message');
  assert.equal(bot2UserEntries.length, 2, 'fresh bot has 2 user turns before edit');
  const bot2FirstUser = bot2UserEntries[0];

  // C.5: Unimported scope message protection across editMessage!
  // Create a room scope for bot2 (with background work paused so no work decision races)
  // and publish an inbound message to the ledger right before editing Turn #1.
  const unimportedRoom = await controlClient.createScope({
    requestId: 'mk-unimported-edit-room',
    kind: 'room',
    title: '收件保护验证群',
    members: [
      { deviceId: server.deviceId, botId: bot.botId },
      { deviceId: server.deviceId, botId: bot2.botId },
    ],
  });
  await controlClient.stopWork(bot.botId, unimportedRoom.scope.scopeId);
  await controlClient.stopWork(bot2.botId, unimportedRoom.scope.scopeId);

  await controlClient.publishUserMessage(unimportedRoom.scope.scopeId, {
    messageId: 'unimported-room-msg-1',
    text: '未导入的群聊上下文：端口改为 9091',
  });

  await localAdapter(server.deviceId, 'editMessage', {
    botId: bot2.botId,
    entryId: bot2FirstUser.id,
    requestId: 'req-fresh-edit-1',
    text: '分叉重写首轮并保留未读收件',
  });
  await waitUntil(
    async () => (await controlClient.getSubmission(bot2.botId, 'req-fresh-edit-1'))?.status === 'done',
    { label: 'req-fresh-edit-1 done' },
  );

  const bot2HistRewound = await controlClient.history(bot2.botId, { limit: 20 });
  const importedScopeEntries = bot2HistRewound.items.filter((it) => it.kind === 'host.scope-message');
  assert.equal(
    importedScopeEntries.some(
      (it) =>
        it.data?.message?.messageId === 'unimported-room-msg-1' &&
        JSON.stringify(it.data?.message ?? {}).includes('未导入的群聊上下文：端口改为 9091'),
    ),
    true,
    'unimported ledger message must not be lost by editMessage and must sync into the new forked primary history',
  );

  const bot2Msgs = bot2HistRewound.items.filter((it) => it.kind === 'host.user-message' || it.kind === 'pi.assistant');
  assert.equal(bot2Msgs.length, 2);
  assert.equal(JSON.stringify(bot2Msgs[0].model).includes('分叉重写首轮并保留未读收件'), true);
  assert.equal(JSON.stringify(bot2Msgs[1].model).includes('首轮分叉且保留未读收件回答'), true);
  assert.equal(JSON.stringify(bot2Msgs).includes('第一问原版'), false);
  assert.equal(JSON.stringify(bot2Msgs).includes('第二问原版'), false);
  } finally {
    liveAbort.abort();
    await liveLoopPromise.catch(() => {});
    if (server) await server.close();
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(botCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
