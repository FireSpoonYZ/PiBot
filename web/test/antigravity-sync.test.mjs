import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  AGY_HISTORY_CHANGED,
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
} from '../../center-contract/antigravity.js';
import { createAntigravityProvider } from '../../host-core/antigravity-provider.js';
import { AntigravityCursorDoc, collectSectionDiff } from '../../host-core/antigravity-runner.js';
import { openHost } from '../../host-core/host.js';
import { openRuntime } from '../../host-core/runtime.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { apply as applyDelta } from '../../host-core/node_modules/@earendil-works/chord/dist/delta/index.js';
import { ProviderDoc, SystemEntry } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const MODEL_ID = 'gemini-3-pro';
const MODEL_REF = `${ANTIGRAVITY_PROVIDER_ID}/${MODEL_ID}`;
const USER_ORIGIN = { sender: { kind: 'user' }, replyTo: null };
const BASE_MODEL_SEL = { modelRef: MODEL_REF, thinkingLevel: 'off', codemode: false, codemodeOnly: false };
const PENDING_STATUSES = new Set(['queued', 'placed', 'running', 'pending', 'admitted']);

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

function overwriteCursorDoc(durableDbPath, conversationId, nextValue) {
  const db = new DatabaseSync(durableDbPath);
  try {
    const row = db
      .prepare(
        `SELECT id FROM documents
         WHERE kind = ? AND scope_kind = 'conversation' AND owner_id = ? AND family = 0 AND key_value = ?
           AND retired_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(JSON.stringify(AntigravityCursorDoc.definition.kind), conversationId, JSON.stringify(''));
    assert.ok(row, 'expected existing AntigravityCursorDoc row to mutate');
    const base = db
      .prepare(
        `SELECT seq FROM document_revisions
         WHERE document_id = ? AND kind = 'base'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(row.id);
    assert.ok(base, 'expected base revision for AntigravityCursorDoc');
    db.prepare('DELETE FROM document_revisions WHERE document_id = ? AND seq > ?').run(row.id, base.seq);
    db.prepare('UPDATE document_revisions SET content = ? WHERE document_id = ? AND seq = ?').run(
      JSON.stringify(nextValue),
      row.id,
      base.seq,
    );
  } finally {
    db.close();
  }
}

function deleteCursorDocs(durableDbPath, conversationId) {
  const db = new DatabaseSync(durableDbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id FROM documents
         WHERE kind = ? AND scope_kind = 'conversation' AND owner_id = ?`,
      )
      .all(JSON.stringify(AntigravityCursorDoc.definition.kind), conversationId);
    for (const row of rows) {
      db.prepare('DELETE FROM document_revisions WHERE document_id = ?').run(row.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
    }
  } finally {
    db.close();
  }
}

function writeDynamicSectionInstaller(rootDir) {
  const pluginDir = path.join(rootDir, 'plugins', 'test-dynamic-section');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'entry.mjs'),
    `import fs from 'node:fs';
export function createPlugin({ host }) {
  const bots = new Set();
  return {
    async forBot({ effectiveConfig: cfg }) {
      const bot = {
        durableContributions: {
          sections: [
            host.sdk.section('test-dynamic-ctx', () => {
              if (!cfg?.stateFile || !fs.existsSync(cfg.stateFile)) return undefined;
              const raw = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
              return typeof raw.value === 'string' ? raw.value : undefined;
            }),
          ],
        },
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
      'test-dynamic-section',
      {
        version: '1.0.0',
        packageRoot: pluginDir,
        dataDir: path.join(pluginDir, 'data'),
        manifest: {
          id: 'test.dynamic-section',
          kind: 'plugin',
          components: { host: { entry: 'entry.mjs' } },
        },
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

function makeCapability(installationId, effectiveConfig, revision = 1) {
  return {
    installationId,
    kind: 'plugin',
    target: 'host',
    targetVersion: '1.0.0',
    enabled: true,
    authorized: true,
    revision,
    effectiveConfig,
    credentialRefs: [],
  };
}

async function openSyncRuntime({
  rootDir,
  hostDataRoot = path.join(rootDir, 'host-data'),
  antigravityClient,
  installer = null,
  initialSnapshot = null,
  waitForInitialApply = true,
}) {
  const meta = openHost({ dataRoot: hostDataRoot });
  const deviceId = meta.deviceId;
  meta.close();

  const durableDbPath = path.join(hostDataRoot, 'durable.sqlite');
  let currentSnapshot = null;

  const centerClient = {
    antigravity: antigravityClient,
    providerAuth: async () => ({ auth: { apiKey: 'center-managed' }, source: 'center' }),
    pollWebhookEvents: async () => ({ items: [], nextCursor: null }),
    reportWebhookEvent: async () => ({ ok: true }),
    stopWebhookEvents: async ({ botId, stopEpoch }) => ({ botId, stopEpoch }),
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
    ],
    models: {
      [ANTIGRAVITY_PROVIDER_ID]: [MODEL_ID, 'second-model'].map((id) => ({
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
    },
    credentials: {},
    bots,
  });

  const runtime = await openRuntime({
    dataRoot: hostDataRoot,
    nativeBridge: async () => ({}),
    centerRuntime: {
      snapshot: { protocol: 1 },
      installer: installer ?? { async getInstalled() { return null; } },
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
    const bootSnap = initialSnapshot ?? makeSnapshot(1, []);
    currentSnapshot = bootSnap;
    if (waitForInitialApply) {
      await applySnapshot(bootSnap);
    } else {
      await runtime.applyCenterSnapshot(bootSnap);
    }
    await runtime.setCenterOnline(true);
    await runtime.restoreTurns();
    runtime.resume();
    return { runtime, deviceId, hostDataRoot, durableDbPath, makeSnapshot, applySnapshot, waitForSubmission };
  } catch (err) {
    try {
      await runtime.close();
    } catch {
      /* preserve startup error */
    }
    throw err;
  }
}

test('collectSectionDiff extracts initialSystemPrompt on first turn and emits only changed/deleted sections later', () => {
  const sys = (id, sections) => ({
    id,
    kind: SystemEntry.kind,
    model: [{ role: 'system', content: '', sections, timestamp: id }],
  });

  const entries = [
    sys(1, {
      instructions: '<instructions>\nBase SOUL\n</instructions>',
      'host-base-behavior': '<host-base-behavior>\nBehavior v1\n</host-base-behavior>',
      'host-turn-routing': 'Transient routing note 1',
      ephemeral: '<ephemeral>\nSoon removed\n</ephemeral>',
    }),
    { id: 2, kind: 'host.user-message', model: [{ role: 'user', content: 'turn 1', timestamp: 2 }] },
    sys(3, {
      ephemeral: null,
      'dynamic-a': '<dynamic-a>\nAlpha v1\n</dynamic-a>',
    }),
    // Reorder by remove-all + re-add-all with unchanged values plus one changed key and one routing key.
    sys(5, {
      instructions: null,
      'host-base-behavior': null,
      'dynamic-a': null,
    }),
    sys(6, {
      'dynamic-a': '<dynamic-a>\nAlpha v1\n</dynamic-a>',
      'host-base-behavior': '<host-base-behavior>\nBehavior v1\n</host-base-behavior>',
      instructions: '<instructions>\nUpdated SOUL\n</instructions>',
      'host-turn-routing': 'Transient routing note 2',
    }),
    // Later deletion of SOUL and dynamic-a plus addition of dynamic-b.
    sys(8, {
      instructions: null,
      'dynamic-a': null,
      'dynamic-b': '<dynamic-b>\nBeta v1\n</dynamic-b>',
      'host-turn-routing': null,
    }),
  ];

  // First turn (prevCutoff === null) up to cutoff=3:
  const first = collectSectionDiff(entries, null, 3);
  assert.equal(first.initialSystemPrompt, '<instructions>\nBase SOUL\n</instructions>');
  assert.deepEqual(first.sections, [
    { key: 'host-base-behavior', value: '<host-base-behavior>\nBehavior v1\n</host-base-behavior>' },
    { key: 'dynamic-a', value: '<dynamic-a>\nAlpha v1\n</dynamic-a>' },
  ]);
  assert.equal(first.sections.some((s) => s.key === 'instructions' || s.key === 'host-turn-routing' || s.key === 'ephemeral'), false);

  // First turn without instructions returns empty initialSystemPrompt.
  const noInstructions = collectSectionDiff([sys(1, { alpha: 'A', 'host-turn-routing': 'R' })], null, 1);
  assert.equal(noInstructions.initialSystemPrompt, '');
  assert.deepEqual(noInstructions.sections, [{ key: 'alpha', value: 'A' }]);

  // Subsequent turn (prevCutoff=3, cutoff=6): reordered unchanged keys are suppressed; only changed instructions emitted.
  const second = collectSectionDiff(entries, 3, 6);
  assert.equal(second.initialSystemPrompt, undefined);
  assert.deepEqual(second.sections, [
    { key: 'instructions', value: '<instructions>\nUpdated SOUL\n</instructions>' },
  ]);

  // Subsequent turn (prevCutoff=6, cutoff=8): cleared SOUL and deleted dynamic-a emit value: null, dynamic-b added, routing ignored.
  const third = collectSectionDiff(entries, 6, 8);
  assert.equal(third.initialSystemPrompt, undefined);
  assert.deepEqual(third.sections, [
    { key: 'dynamic-b', value: '<dynamic-b>\nBeta v1\n</dynamic-b>' },
    { key: 'dynamic-a', value: null },
    { key: 'instructions', value: null },
  ]);
});

test('Host persists AntigravityCursorDoc before /run and never re-dispatches prior user, assistant, toolResult, or image content', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-sync-cursor-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const runCalls = [];
  const cursorsObservedAtRun = [];
  const toolResultResolvers = new Map();
  let env;
  let bot;

  const antigravityClient = {
    run(payload) {
      const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
      const cursorSnapshot = readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId);
      cursorsObservedAtRun.push(cursorSnapshot);
      const cloned = JSON.parse(JSON.stringify(payload));
      runCalls.push(cloned);

      const turnNumber = runCalls.length;
      return (async function* () {
        if (turnNumber === 1) {
          const waitTool = Promise.withResolvers();
          toolResultResolvers.set('cursor-tool-1', waitTool);
          yield {
            type: 'tool_request',
            callId: 'cursor-tool-1',
            name: 'codemode',
            args: { code: 'text("TOOL_SECRET_MARKER_T1");' },
          };
          const delivered = await waitTool.promise;
          assert.equal(delivered.isError, false);
          assert.match(JSON.stringify(delivered.content), /TOOL_SECRET_MARKER_T1/);
          yield { type: 'text_delta', delta: 'ASSISTANT_SECRET_REPLY_T1' };
          yield { type: 'turn_done', usage: { input: 50, output: 10, totalTokens: 60 } };
        } else {
          yield { type: 'text_delta', delta: 'ASSISTANT_REPLY_T2' };
          yield { type: 'turn_done', usage: { input: 20, output: 5, totalTokens: 25 } };
        }
      })();
    },
    async toolResult(payload) {
      toolResultResolvers.get(payload.callId)?.resolve(JSON.parse(JSON.stringify(payload)));
      return { ok: true };
    },
    async steer() {
      return { ok: true };
    },
    async cancel() {
      return { ok: true };
    },
  };

  try {
    env = await openSyncRuntime({ rootDir, antigravityClient });
    bot = await env.runtime.createBot({ requestId: 'cursor-bot', role: 'Cursor Test', cwd, makePrimary: true });
    await env.applySnapshot(env.makeSnapshot(2, [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }]));

    const attachment = await env.runtime.uploadAttachment(bot.botId, {
      name: 'pixel.png',
      mimeType: 'image/png',
      data: PNG_1X1,
    });

    await env.runtime.submit(bot.botId, {
      requestId: 'cursor-turn-1',
      text: 'USER_SECRET_PROMPT_T1',
      attachments: [attachment.id],
      origin: USER_ORIGIN,
    });
    const receipt1 = await env.waitForSubmission(bot.botId, 'cursor-turn-1');
    assert.equal(receipt1.status, 'done', JSON.stringify(receipt1));

    assert.equal(runCalls.length, 1);
    assert.ok(cursorsObservedAtRun[0], 'AntigravityCursorDoc must be persisted before antigravityClient.run is called');
    assert.equal(cursorsObservedAtRun[0].sessionId, runCalls[0].sessionId);
    assert.equal(Number.isSafeInteger(cursorsObservedAtRun[0].dispatchedThrough), true);
    assert.ok(cursorsObservedAtRun[0].dispatchedThrough > 0);
    assert.equal(typeof runCalls[0].initialSystemPrompt, 'string');
    assert.ok(runCalls[0].initialSystemPrompt.length > 0);
    assert.equal(runCalls[0].inputs.length, 1);
    assert.match(runCalls[0].inputs[0].text, /USER_SECRET_PROMPT_T1/);
    assert.deepEqual(runCalls[0].inputs[0].images, [{ data: PNG_1X1, mimeType: 'image/png' }]);

    await env.runtime.submit(bot.botId, {
      requestId: 'cursor-turn-2',
      text: 'FRESH_PROMPT_T2',
      origin: USER_ORIGIN,
    });
    const receipt2 = await env.waitForSubmission(bot.botId, 'cursor-turn-2');
    assert.equal(receipt2.status, 'done', JSON.stringify(receipt2));

    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, runCalls[0].sessionId);
    assert.equal(cursorsObservedAtRun[1].sessionId, runCalls[0].sessionId);
    assert.ok(
      cursorsObservedAtRun[1].dispatchedThrough > cursorsObservedAtRun[0].dispatchedThrough,
      'cursor must advance durably before turn 2 dispatches',
    );
    assert.equal(runCalls[1].initialSystemPrompt, undefined);
    assert.deepEqual(runCalls[1].inputs, [{ text: 'FRESH_PROMPT_T2' }]);
    const secondPayloadJson = JSON.stringify(runCalls[1]);
    assert.equal(secondPayloadJson.includes('USER_SECRET_PROMPT_T1'), false);
    assert.equal(secondPayloadJson.includes('ASSISTANT_SECRET_REPLY_T1'), false);
    assert.equal(secondPayloadJson.includes('TOOL_SECRET_MARKER_T1'), false);
    assert.equal(secondPayloadJson.includes(PNG_1X1), false);
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Dynamic SOUL and section updates send only changed or deleted section deltas without recreating the session', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-sync-sections-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const stateFile = path.join(rootDir, 'dynamic-section.json');
  fs.writeFileSync(stateFile, JSON.stringify({ value: 'DYNAMIC_CTX_V1' }), 'utf8');

  const runCalls = [];
  const antigravityClient = {
    run(payload) {
      runCalls.push(JSON.parse(JSON.stringify(payload)));
      return (async function* () {
        yield { type: 'text_delta', delta: `ack-${runCalls.length}` };
        yield { type: 'turn_done', usage: { input: 10, output: 5, totalTokens: 15 } };
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openSyncRuntime({
      rootDir,
      antigravityClient,
      installer: writeDynamicSectionInstaller(rootDir),
    });
    const bot = await env.runtime.createBot({ requestId: 'section-bot', role: 'Section Delta', cwd, makePrimary: true });
    await env.applySnapshot(
      env.makeSnapshot(2, [
        {
          botId: bot.botId,
          cwd,
          model: BASE_MODEL_SEL,
          capabilities: [makeCapability('test-dynamic-section', { stateFile })],
        },
      ]),
    );

    const send = async (requestId, text) => {
      await env.runtime.submit(bot.botId, { requestId, text, origin: USER_ORIGIN });
      const receipt = await env.waitForSubmission(bot.botId, requestId);
      assert.equal(receipt.status, 'done', JSON.stringify(receipt));
    };

    // Turn 1: baseline initialSystemPrompt + initial sections.
    await send('sec-t1', 'First turn');
    assert.equal(runCalls.length, 1);
    assert.match(runCalls[0].initialSystemPrompt, /Section Delta/);
    assert.equal(runCalls[0].sections.some((s) => s.key === 'instructions'), false);
    assert.ok(runCalls[0].sections.some((s) => s.key === 'test-dynamic-ctx' && s.value.includes('DYNAMIC_CTX_V1')));

    // Modify SOUL (instructions) and dynamic section -> Turn 2 sends ONLY those two keys on same sessionId.
    const soul1 = await env.runtime.getBotSoul(bot.botId);
    await env.runtime.setBotSoul(bot.botId, {
      expectedRevision: soul1.revision,
      text: `${soul1.text}\nSOUL_UPDATED_RULE_V2`,
    });
    fs.writeFileSync(stateFile, JSON.stringify({ value: 'DYNAMIC_CTX_V2' }), 'utf8');

    await send('sec-t2', 'Second turn after SOUL and section update');
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].sessionId, runCalls[0].sessionId);
    assert.equal(runCalls[1].initialSystemPrompt, undefined);
    const turn2Keys = runCalls[1].sections.map((s) => s.key).sort();
    assert.deepEqual(turn2Keys, ['instructions', 'test-dynamic-ctx']);
    assert.match(
      runCalls[1].sections.find((s) => s.key === 'instructions').value,
      /SOUL_UPDATED_RULE_V2/,
    );
    assert.match(
      runCalls[1].sections.find((s) => s.key === 'test-dynamic-ctx').value,
      /DYNAMIC_CTX_V2/,
    );

    // Clear SOUL to empty string and omit dynamic section -> Turn 3 emits null deletions on same sessionId.
    const soul2 = await env.runtime.getBotSoul(bot.botId);
    await env.runtime.setBotSoul(bot.botId, {
      expectedRevision: soul2.revision,
      text: '',
    });
    fs.writeFileSync(stateFile, JSON.stringify({ value: null }), 'utf8');

    await send('sec-t3', 'Third turn after clearing SOUL and dynamic section');
    assert.equal(runCalls.length, 3);
    assert.equal(runCalls[2].sessionId, runCalls[0].sessionId);
    assert.equal(runCalls[2].initialSystemPrompt, undefined);
    const turn3ByKey = Object.fromEntries(runCalls[2].sections.map((s) => [s.key, s.value]));
    assert.deepEqual(turn3ByKey, {
      instructions: null,
      'test-dynamic-ctx': null,
    });
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Legacy AGY bindings with mismatched or missing AntigravityCursorDoc require /clear before continuing', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-sync-legacy-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const hostDataRoot = path.join(rootDir, 'host-data');

  let runCalls = [];
  const makeClient = () => ({
    run(payload) {
      runCalls.push(JSON.parse(JSON.stringify(payload)));
      return (async function* () {
        yield { type: 'text_delta', delta: `reply-${runCalls.length}` };
        yield { type: 'turn_done', usage: { input: 12, output: 4, totalTokens: 16 } };
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  });

  let env;
  try {
    // 1. Establish real assistant history and cursor.
    env = await openSyncRuntime({ rootDir, hostDataRoot, antigravityClient: makeClient() });
    const bot = await env.runtime.createBot({ requestId: 'legacy-bot', role: 'Legacy Check', cwd, makePrimary: true });
    const botSpec = [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }];
    await env.applySnapshot(env.makeSnapshot(2, botSpec));

    await env.runtime.submit(bot.botId, { requestId: 'legacy-t1', text: 'Initial history', origin: USER_ORIGIN });
    assert.equal((await env.waitForSubmission(bot.botId, 'legacy-t1')).status, 'done');
    assert.equal(runCalls.length, 1);

    const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
    const originalSessionId = readDurableDoc(env.durableDbPath, ProviderDoc, 'conversation', nativeId)?.sessionId;
    assert.equal(originalSessionId, runCalls[0].sessionId);

    await env.runtime.close();
    env = null;

    // 2. Mismatched cursor sessionId with existing assistant history -> AGY_HISTORY_CHANGED, no Center call, cursor untouched.
    const staleCursor = { sessionId: 'stale-other-session', dispatchedThrough: 1 };
    overwriteCursorDoc(path.join(hostDataRoot, 'durable.sqlite'), nativeId, staleCursor);

    runCalls = [];
    env = await openSyncRuntime({ rootDir, hostDataRoot, antigravityClient: makeClient() });
    await env.applySnapshot(env.makeSnapshot(2, botSpec));

    await env.runtime.submit(bot.botId, { requestId: 'legacy-mismatch', text: 'Continue with stale cursor', origin: USER_ORIGIN });
    const mismatchReceipt = await env.waitForSubmission(bot.botId, 'legacy-mismatch');
    assert.equal(mismatchReceipt.status, 'unanswered');
    assert.equal(mismatchReceipt.reason, 'model_error');
    assert.equal(runCalls.length, 0, 'mismatched cursor must not dispatch to Center');
    assert.deepEqual(
      readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId),
      staleCursor,
      'mismatched cursor must not advance',
    );
    const mismatchHistory = JSON.stringify((await env.runtime.history(bot.botId, { limit: 30 })).items);
    assert.match(mismatchHistory, new RegExp(`${AGY_HISTORY_CHANGED}.*\\/clear`));

    await env.runtime.close();
    env = null;

    // 3. Missing AntigravityCursorDoc with existing assistant history -> AGY_HISTORY_CHANGED, no Center call, cursor stays absent.
    deleteCursorDocs(path.join(hostDataRoot, 'durable.sqlite'), nativeId);

    runCalls = [];
    env = await openSyncRuntime({ rootDir, hostDataRoot, antigravityClient: makeClient() });
    await env.applySnapshot(env.makeSnapshot(2, botSpec));

    await env.runtime.submit(bot.botId, { requestId: 'legacy-missing', text: 'Continue without cursor', origin: USER_ORIGIN });
    const missingReceipt = await env.waitForSubmission(bot.botId, 'legacy-missing');
    assert.equal(missingReceipt.status, 'unanswered');
    assert.equal(missingReceipt.reason, 'model_error');
    assert.equal(runCalls.length, 0, 'missing cursor with legacy history must not dispatch to Center');
    assert.equal(
      readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId),
      null,
      'missing cursor must remain uncreated on rejection',
    );

    // 4. Explicit /clear rotates ProviderDoc.sessionId and restores normal execution.
    await env.runtime.clearHistory(bot.botId);
    const rotatedSessionId = readDurableDoc(env.durableDbPath, ProviderDoc, 'conversation', nativeId)?.sessionId;
    assert.ok(rotatedSessionId);
    assert.notEqual(rotatedSessionId, originalSessionId);

    await env.runtime.submit(bot.botId, { requestId: 'legacy-after-clear', text: 'Fresh after clear', origin: USER_ORIGIN });
    const recoveredReceipt = await env.waitForSubmission(bot.botId, 'legacy-after-clear');
    assert.equal(recoveredReceipt.status, 'done', JSON.stringify(recoveredReceipt));
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].sessionId, rotatedSessionId);
    assert.equal(typeof runCalls[0].initialSystemPrompt, 'string');
    assert.ok(runCalls[0].initialSystemPrompt.length > 0);
    assert.equal(
      readDurableDoc(env.durableDbPath, AntigravityCursorDoc, 'conversation', nativeId)?.sessionId,
      rotatedSessionId,
    );
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Pi Durable disables automatic retry on retryable errors and marks restarted external turns interrupted without resending', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-sync-noretry-'));
  const cwd = path.join(rootDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const hostDataRoot = path.join(rootDir, 'host-data');

  const runCalls = [];
  const inFlightStarted = Promise.withResolvers();
  let mode = 'event-503';

  const antigravityClient = {
    run(payload, opts) {
      runCalls.push(JSON.parse(JSON.stringify(payload)));
      if (mode === 'event-503') {
        return (async function* () {
          yield { type: 'error', code: 'UPSTREAM_503', message: '503 Service temporarily unavailable' };
        })();
      }
      if (mode === 'throw-network') {
        return (async function* () {
          throw new Error('socket hang up');
        })();
      }
      return (async function* () {
        inFlightStarted.resolve();
        await new Promise((resolve) => {
          if (opts?.signal?.aborted) return resolve();
          opts?.signal?.addEventListener('abort', resolve, { once: true });
        });
      })();
    },
    async toolResult() { return { ok: true }; },
    async steer() { return { ok: true }; },
    async cancel() { return { ok: true }; },
  };

  let env;
  try {
    env = await openSyncRuntime({ rootDir, hostDataRoot, antigravityClient });
    const bot = await env.runtime.createBot({ requestId: 'noretry-bot', role: 'No Retry', cwd, makePrimary: true });
    const botSpec = [{ botId: bot.botId, cwd, model: BASE_MODEL_SEL, capabilities: [] }];
    await env.applySnapshot(env.makeSnapshot(2, botSpec));

    // A1: Center emits retryable 503 error event -> run called exactly once, no automatic retry.
    mode = 'event-503';
    await env.runtime.submit(bot.botId, { requestId: 'retry-503', text: 'Trigger 503', origin: USER_ORIGIN });
    const receipt503 = await env.waitForSubmission(bot.botId, 'retry-503');
    assert.equal(receipt503.status, 'unanswered');
    assert.equal(receipt503.reason, 'model_error');
    assert.equal(runCalls.length, 1, 'retryable 503 must not be retried automatically');

    // A2: Network error thrown from stream -> run called exactly once, no automatic retry.
    mode = 'throw-network';
    await env.runtime.submit(bot.botId, { requestId: 'retry-net', text: 'Trigger socket hang up', origin: USER_ORIGIN });
    const receiptNet = await env.waitForSubmission(bot.botId, 'retry-net');
    assert.equal(receiptNet.status, 'unanswered');
    assert.equal(receiptNet.reason, 'model_error');
    assert.equal(runCalls.length, 2, 'retryable network error must not be retried automatically');

    // B: Simulated crash/restart while GenerationTask is in phase 'request' -> settles interrupted without resending.
    mode = 'hang';
    await env.runtime.submit(bot.botId, { requestId: 'restart-turn', text: 'In-flight when host crashes', origin: USER_ORIGIN });
    await inFlightStarted.promise;
    assert.equal(runCalls.length, 3);

    const nativeId = getPrimaryNativeId(env.durableDbPath, bot.primaryConversationId);
    const durableDbPath = env.durableDbPath;
    await env.runtime.close();
    env = null;

    // Simulate abrupt process crash by leaving the generation task in 'running' state on disk.
    const db = new DatabaseSync(durableDbPath);
    let crashedTaskId;
    try {
      const pendingTasks = db
        .prepare('SELECT id, record FROM tasks WHERE conversation_id = ? AND status != ? ORDER BY id DESC')
        .all(nativeId, 'terminal')
        .map((row) => ({ id: row.id, record: JSON.parse(row.record) }))
        .filter((row) => row.record.kind === 'pi.generation');
      assert.equal(pendingTasks.length, 1, 'expected one live generation task');
      assert.equal(pendingTasks[0].record.state?.checkpoint?.phase, 'request');
      crashedTaskId = pendingTasks[0].id;
      pendingTasks[0].record.state.status = 'running';
      db.prepare('UPDATE tasks SET status = ?, record = ? WHERE id = ?').run(
        'running',
        JSON.stringify(pendingTasks[0].record),
        crashedTaskId,
      );
    } finally {
      db.close();
    }

    const runsAfterRestart = [];
    const postRestartClient = {
      run(payload) {
        runsAfterRestart.push(JSON.parse(JSON.stringify(payload)));
        return (async function* () {
          yield { type: 'text_delta', delta: 'unexpected resend' };
          yield { type: 'turn_done', usage: { input: 1, output: 1, totalTokens: 2 } };
        })();
      },
      async toolResult() { return { ok: true }; },
      async steer() { return { ok: true }; },
      async cancel() { return { ok: true }; },
    };

    const meta = openHost({ dataRoot: hostDataRoot });
    const deviceId = meta.deviceId;
    meta.close();
    const restartSnapshot = {
      protocol: 1,
      deviceId,
      revision: 2,
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
      ],
      models: {
        [ANTIGRAVITY_PROVIDER_ID]: [
          {
            id: MODEL_ID,
            name: MODEL_ID,
            api: ANTIGRAVITY_API,
            contextWindow: 128_000,
            maxTokens: 8_192,
            input: ['text', 'image'],
            reasoning: true,
            enabled: true,
            revision: 1,
          },
        ],
      },
      credentials: {},
      bots: botSpec,
    };

    env = await openSyncRuntime({
      rootDir,
      hostDataRoot,
      antigravityClient: postRestartClient,
      initialSnapshot: restartSnapshot,
      waitForInitialApply: false,
    });

    const restartedReceipt = await env.waitForSubmission(bot.botId, 'restart-turn');
    assert.equal(restartedReceipt.status, 'unanswered');
    assert.equal(restartedReceipt.reason, 'interrupted');
    assert.equal(runsAfterRestart.length, 0, 'restarted external turn must not resend native prompt');

    const tasksAfter = readDurableTasks(durableDbPath, nativeId);
    const settledTask = tasksAfter.find((t) => t.id === crashedTaskId);
    assert.ok(settledTask);
    assert.equal(settledTask.status, 'terminal');
    assert.equal(settledTask.record.state?.outcome?.status, 'failed');
  } finally {
    try {
      await env?.runtime?.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('Standalone createAntigravityProvider exposes runExternalTurn and rejects direct streamSimple/stream calls', () => {
  const provider = createAntigravityProvider({
    provider: { id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', api: ANTIGRAVITY_API, baseUrl: '' },
    models: [
      {
        id: MODEL_ID,
        name: 'Gemini 3 Pro',
        api: ANTIGRAVITY_API,
        contextWindow: 128_000,
        maxTokens: 8_192,
        input: ['text', 'image'],
        reasoning: true,
      },
    ],
    antigravityClient: {
      run() {
        return (async function* () {})();
      },
      async toolResult() { return { ok: true }; },
      async steer() { return { ok: true }; },
      async cancel() { return { ok: true }; },
    },
  });

  assert.equal(typeof provider.runExternalTurn, 'function');
  assert.deepEqual(provider.auth.apiKey.check(), { source: 'center', type: 'api_key' });
  const model = provider.getModels()[0];
  assert.throws(
    () => provider.streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, { sessionId: 's-1' }),
    /does not support stateless streamSimple|runExternalTurn/i,
  );
  assert.throws(
    () => provider.stream(model, { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, { sessionId: 's-1' }),
    /does not support stateless streamSimple|runExternalTurn/i,
  );

  const withoutClient = createAntigravityProvider({
    provider: { id: ANTIGRAVITY_PROVIDER_ID, name: 'Antigravity', api: ANTIGRAVITY_API, baseUrl: '' },
    models: [],
    antigravityClient: null,
  });
  assert.equal(withoutClient.auth.apiKey.check(), undefined);
});
