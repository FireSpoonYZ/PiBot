import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDeviceLink } from '../../host-core/device-link.js';
import { openMessageLog } from '../../host-core/messages.js';
import { openRelayRegistry } from '../../host-core/relay-registry.js';
import { openRelayServer } from '../../host-core/relay-server.js';
import { openRemoteControl } from '../../host-core/remote-control-client.js';
import {
  LIVE_EXTENSIONS_HEADER,
  NO_LIVE_EXTENSIONS,
  normalizeLiveSnapshot,
} from '../../host-core/remote-live-protocol.js';
import {
  encodeRelayFrame,
  readClientFrame,
  readServerFrame,
  RELAY_CLOSE,
} from '../../host-core/relay-protocol.js';
import { projectLiveState, diffLiveState } from '../../host-core/runtime-live-projection.js';
import { questionnaireWaitKey } from '../../host-core/bot-session-context.js';
import { requestDetails, settledDetails } from '../../plugins/ask-user-question/presentation.js';
import { mergeHistoryWaitProjection } from '../src/chatTurnModel.ts';

// ws is installed inside host-core; resolve from host-core/package.json.
const wsModule = createRequire(new URL('../../host-core/package.json', import.meta.url))('ws');
const WebSocket = wsModule.default ?? wsModule;
const { WebSocketServer } = wsModule;

const BOT_ID = 'bot-live-upgrade';
const CONVERSATION_ID = 'public-conv-1';
const QUESTIONS = [{
  header: 'Mode',
  question: 'Proceed with rollout?',
  options: [
    { label: 'Yes', description: 'Continue' },
    { label: 'No', description: 'Pause' },
  ],
}];
const WAIT_DETAILS = requestDetails('ask-installation', 11, '55', QUESTIONS);
const WAIT_IDENTITY = { installationId: 'ask-installation', conversationId: 11, requestId: '55' };
const WAIT_KEY = questionnaireWaitKey(WAIT_DETAILS, 55, 11);
const SETTLED_DETAILS = settledDetails(WAIT_DETAILS, 'answered', { answers: [], cancelled: false });

const ASSISTANT_ENTRY = {
  id: 21,
  kind: 'pi.assistant',
  model: [{
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'q1', name: 'ask_user_question', arguments: { questions: QUESTIONS } }],
  }],
};
const WAIT_ENTRY = {
  id: 22,
  kind: 'pi.tool-result',
  byTaskId: 55,
  model: [{
    role: 'toolResult',
    toolName: 'ask_user_question',
    toolCallId: 'q1',
    content: [{ type: 'text', text: 'Waiting for user.' }],
    details: WAIT_DETAILS,
  }],
};

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function buildLiveStates() {
  const entries = [
    {
      id: 10,
      kind: 'host.user-message',
      data: { attribution: { kind: 'host', channel: 'primary', name: 'Rule · Mail', sourceType: 'google-workspace-rule' } },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Google rule event' }] }],
    },
    {
      id: 11,
      kind: 'host.user-message',
      data: { attribution: { kind: 'host', channel: 'primary', name: '定时任务', sourceType: 'schedule' } },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Scheduled event' }] }],
    },
    {
      id: 12,
      kind: 'host.user-message',
      data: { attribution: { kind: 'host', channel: 'primary', name: '任务 · Rollout', sourceType: 'task_dispatch' } },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Task dispatch event' }] }],
    },
    ASSISTANT_ENTRY,
    WAIT_ENTRY,
  ];
  const baseView = {
    entries,
    docs: { 'pi.live': { run: null, tools: [], nestedTools: [] }, 'pi.inbox': { items: [] } },
  };
  const pendingState = projectLiveState(baseView, null, {
    waitPresentations: new Map([[WAIT_KEY, { details: WAIT_DETAILS, live: true, status: 'pending' }]]),
    durableWaits: [WAIT_IDENTITY],
  });
  const settledState = projectLiveState(baseView, null, {
    waitPresentations: new Map([[WAIT_KEY, { details: SETTLED_DETAILS, live: false, status: 'answered' }]]),
    durableWaits: [],
  });
  return {
    pendingState: { ...pendingState, googleSetupRevision: 4 },
    settledState: { ...settledState, googleSetupRevision: 5 },
  };
}

/** Loopback mock local control server speaking real /v1/host + /v1/bots/:botId/live SSE. */
async function startMockControlServer({ deviceId, token, defaultWorkspace, initialState }) {
  const subscribers = new Set();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/host') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        protocolVersion: 1,
        deviceId,
        defaultWorkspace,
        displayName: 'Test Host',
        platform: process.platform,
        arch: process.arch,
      }));
      return;
    }
    if (req.method === 'GET' && req.url === `/v1/bots/${BOT_ID}/live`) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      const sub = { res, seq: 1 };
      subscribers.add(sub);
      const snapshot = {
        type: 'snapshot',
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        sequence: sub.seq,
        state: initialState,
      };
      res.write(`event: bot-live\ndata: ${JSON.stringify(snapshot)}\n\n`);
      res.on('close', () => subscribers.delete(sub));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    pushUpdate(changes) {
      for (const sub of subscribers) {
        sub.seq += 1;
        const frame = {
          type: 'update',
          botId: BOT_ID,
          conversationId: CONVERSATION_ID,
          sequence: sub.seq,
          changes,
        };
        sub.res.write(`event: bot-live\ndata: ${JSON.stringify(frame)}\n\n`);
      }
    },
    pushEnd(reason = 'stopped') {
      for (const sub of subscribers) {
        const frame = {
          type: 'end',
          botId: BOT_ID,
          conversationId: CONVERSATION_ID,
          sequence: sub.seq,
          reason,
        };
        sub.res.write(`event: bot-live\ndata: ${JSON.stringify(frame)}\n\n`);
        sub.res.end();
      }
      subscribers.clear();
    },
    async close() {
      for (const sub of subscribers) {
        try { sub.res.end(); } catch { /* ignore */ }
      }
      subscribers.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

function waitForOnline(link) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`device link did not become online (phase=${link.getStatus().phase}, lastError=${link.getStatus().lastError})`)), 5000);
    const poll = setInterval(() => {
      const status = link.getStatus();
      if (status.phase === 'online') {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      } else if (status.phase === 'blocked') {
        clearTimeout(deadline);
        clearInterval(poll);
        reject(new Error(`device link blocked: ${status.lastError}`));
      }
    }, 15);
  });
}

function createHostIdentity(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const log = openMessageLog({ dataRoot: dir });
  const deviceId = log.deviceId;
  log.close();
  return { dir, deviceId };
}

/**
 * Legacy strict relay simulator reproducing pre-upgrade D behavior:
 * - Never echoes X-PiBot-Live-Extensions on 101 upgrade.
 * - Parses every inbound client/host frame with NO_LIVE_EXTENSIONS (rejects
 *   durableWaits even [], durableWait, schedule, task_dispatch -> 4400 BAD_FRAME).
 */
async function startLegacyStrictRelay({ devices }) {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const hosts = new Map();
  const routes = new Map(); // routeId -> { clientWs, watchId, hostWs, targetDeviceId, target }
  const observedHostFrames = [];
  let badFrameCloses = 0;

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/v1/link') {
      socket.destroy();
      return;
    }
    // Intentionally ignores req.headers[LIVE_EXTENSIONS_HEADER] and emits NO extension header.
    wss.handleUpgrade(req, socket, head, (ws) => {
      let authed = null;
      ws.on('message', (data, isBinary) => {
        let frame;
        try {
          frame = readClientFrame(data, isBinary, { liveExtensions: NO_LIVE_EXTENSIONS });
        } catch {
          badFrameCloses += 1;
          ws.close(RELAY_CLOSE.BAD_FRAME);
          return;
        }
        if (!authed) {
          if (frame.type !== 'hello' || devices.get(frame.deviceId) !== frame.token) {
            ws.close(RELAY_CLOSE.UNAUTHORIZED);
            return;
          }
          authed = { deviceId: frame.deviceId, role: frame.role ?? 'host' };
          if (authed.role === 'host') hosts.set(authed.deviceId, ws);
          const ready = { type: 'ready', protocolVersion: 1, deviceId: authed.deviceId };
          if (authed.role === 'client') ready.role = 'client';
          if (frame.scopeProtocol === 1) ready.scopeProtocol = 1;
          if (frame.controlProtocol === 2) ready.controlProtocol = 2;
          ws.send(encodeRelayFrame(ready));
          return;
        }
        if (frame.type === 'live-open') {
          const hostWs = hosts.get(frame.targetDeviceId);
          if (!hostWs) {
            ws.send(encodeRelayFrame({ type: 'live-end', watchId: frame.watchId, targetDeviceId: frame.targetDeviceId, reason: 'error', code: 'OFFLINE' }));
            return;
          }
          const routeId = `legacy-route-${routes.size + 1}`;
          routes.set(routeId, { clientWs: ws, watchId: frame.watchId, hostWs, targetDeviceId: frame.targetDeviceId, target: frame.target });
          hostWs.send(encodeRelayFrame({ type: 'live-request', routeId, fromDeviceId: authed.deviceId, target: frame.target }));
          return;
        }
        if (frame.type === 'live-frame') {
          const route = routes.get(frame.routeId);
          if (!route) return;
          // Strict legacy D validation.
          let normalized;
          try {
            normalized = normalizeLiveSnapshot(frame.frame, route.target, { liveExtensions: NO_LIVE_EXTENSIONS });
          } catch {
            badFrameCloses += 1;
            ws.close(RELAY_CLOSE.BAD_FRAME);
            return;
          }
          observedHostFrames.push(normalized);
          route.clientWs.send(encodeRelayFrame({
            type: 'live-frame',
            watchId: route.watchId,
            targetDeviceId: route.targetDeviceId,
            frame: normalized,
          }));
          return;
        }
        if (frame.type === 'live-end') {
          const route = routes.get(frame.routeId);
          if (!route) return;
          routes.delete(frame.routeId);
          route.clientWs.send(encodeRelayFrame({
            type: 'live-end',
            watchId: route.watchId,
            targetDeviceId: route.targetDeviceId,
            reason: frame.reason,
            ...(frame.code !== undefined ? { code: frame.code } : {}),
          }));
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/v1/link`,
    observedHostFrames,
    get badFrameCloses() { return badFrameCloses; },
    async close() {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

/** Connect a raw WebSocket peer simulating an old strict D host or client (no upgrade extension header). */
function connectRawLegacyPeer({ url, hello }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    let upgradeHeaders = null;
    const queue = [];
    const waiters = [];
    let closedCode = null;
    const closeWaiters = [];

    const deliver = (item) => {
      if (waiters.length > 0) waiters.shift()(item);
      else queue.push(item);
    };

    ws.on('upgrade', (res) => {
      upgradeHeaders = res.headers;
    });
    ws.on('open', () => {
      ws.send(encodeRelayFrame(hello));
    });
    ws.on('message', (data, isBinary) => {
      try {
        const frame = readServerFrame(data, isBinary, { liveExtensions: NO_LIVE_EXTENSIONS });
        deliver({ ok: true, frame });
      } catch (err) {
        deliver({ ok: false, err });
      }
    });
    ws.on('close', (code) => {
      closedCode = code;
      while (closeWaiters.length > 0) closeWaiters.shift()(code);
    });
    ws.on('error', reject);

    const nextFrame = () => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting for raw WS frame')), 5000);
      const wrap = (item) => {
        clearTimeout(timer);
        if (item.ok) res(item.frame);
        else rej(item.err);
      };
      if (queue.length > 0) wrap(queue.shift());
      else waiters.push(wrap);
    });

    const waitClose = () => new Promise((res, rej) => {
      if (closedCode !== null) return res(closedCode);
      const timer = setTimeout(() => rej(new Error('timed out waiting for raw WS close')), 5000);
      closeWaiters.push((code) => { clearTimeout(timer); res(code); });
    });

    nextFrame().then((ready) => {
      resolve({
        ws,
        ready,
        upgradeHeaders,
        sendRaw: (obj) => ws.send(encodeRelayFrame(obj)),
        nextFrame,
        waitClose,
        close: () => { try { ws.terminate(); } catch { /* ignore */ } },
      });
    }, reject);
  });
}

test('new Host -> new Relay -> new Client retains extended live fields and forwards revision-only SSE updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-live-new-new-'));
  const relayDir = join(root, 'relay');
  mkdirSync(relayDir, { recursive: true });
  const { dir: hostDir, deviceId: hostDeviceId } = createHostIdentity(root, 'host');
  const clientDeviceId = 'client-new-1';
  const hostToken = makeToken();
  const clientToken = makeToken();
  const controlToken = makeToken();

  const reg = openRelayRegistry({ dataRoot: relayDir });
  reg.register({ deviceId: hostDeviceId, token: hostToken });
  reg.register({ deviceId: clientDeviceId, token: clientToken });
  reg.close();

  const { pendingState, settledState } = buildLiveStates();
  const control = await startMockControlServer({
    deviceId: hostDeviceId,
    token: controlToken,
    defaultWorkspace: hostDir,
    initialState: pendingState,
  });
  const relay = await openRelayServer({ dataRoot: relayDir, port: 0, listenHost: '127.0.0.1' });
  let link = null;
  let client = null;
  try {
    link = await openDeviceLink({
      dataRoot: hostDir,
      url: relay.url,
      token: hostToken,
      control: { url: control.url, token: controlToken },
    });
    await waitForOnline(link);

    client = await openRemoteControl({ deviceId: clientDeviceId, url: relay.url, token: clientToken });
    const stream = client.live(hostDeviceId, { kind: 'primary', botId: BOT_ID });
    const first = (await stream.next()).value;
    assert.equal(first.type, 'snapshot');
    assert.deepEqual(first.state.durableWaits, [WAIT_IDENTITY]);
    assert.equal(first.state.googleSetupRevision, 4);
    assert.equal(first.state.history[4].messages[0].durableWait, true);
    assert.deepEqual(
      first.state.history.slice(0, 3).map((item) => item.attribution?.sourceType),
      ['google-workspace-rule', 'schedule', 'task_dispatch'],
    );

    control.pushUpdate({ googleSetupRevision: 5 });
    const revisionOnly = (await stream.next()).value;
    assert.equal(revisionOnly.type, 'snapshot');
    assert.equal(revisionOnly.state.googleSetupRevision, 5);
    assert.deepEqual(revisionOnly.state.history, first.state.history);

    // Trigger a durableWaits-only SSE update (previously failed host-live STATE_KEYS with BAD_FRAME).
    control.pushUpdate({ durableWaits: [] });
    const second = (await stream.next()).value;
    assert.equal(second.type, 'snapshot');
    assert.deepEqual(second.state.durableWaits, []);

    // Trigger full settled diff update.
    const settledDiff = diffLiveState({ ...pendingState, durableWaits: [], googleSetupRevision: 5 }, settledState);
    control.pushUpdate(settledDiff);
    const third = (await stream.next()).value;
    assert.equal(third.type, 'snapshot');
    assert.deepEqual(third.state.durableWaits, []);
    assert.equal(third.state.history[4].messages[0].presentation.status, 'answered');
    assert.equal(third.state.history[4].messages[0].durableWait, undefined);

    control.pushEnd('stopped');
    const ended = (await stream.next()).value;
    assert.deepEqual(ended, { type: 'end', reason: 'stopped' });
  } finally {
    client?.close();
    await link?.close();
    await relay.close();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('new Host -> old strict Relay -> new Client negotiates legacy downgrade without disconnecting and yields durableWaits: undefined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-live-old-relay-'));
  const { dir: hostDir, deviceId: hostDeviceId } = createHostIdentity(root, 'host');
  const clientDeviceId = 'client-new-2';
  const hostToken = makeToken();
  const clientToken = makeToken();
  const controlToken = makeToken();

  const { pendingState } = buildLiveStates();
  const control = await startMockControlServer({
    deviceId: hostDeviceId,
    token: controlToken,
    defaultWorkspace: hostDir,
    initialState: pendingState,
  });
  const legacyRelay = await startLegacyStrictRelay({
    devices: new Map([[hostDeviceId, hostToken], [clientDeviceId, clientToken]]),
  });
  let link = null;
  let client = null;
  try {
    link = await openDeviceLink({
      dataRoot: hostDir,
      url: legacyRelay.url,
      token: hostToken,
      control: { url: control.url, token: controlToken },
    });
    await waitForOnline(link);

    client = await openRemoteControl({ deviceId: clientDeviceId, url: legacyRelay.url, token: clientToken });
    assert.throws(() => client.live(hostDeviceId, {
      kind: 'browser', botId: BOT_ID, pageId: 'page-1', sessionId: 'session-1',
    }), { code: 'CONTROL_UNAVAILABLE' });
    const stream = client.live(hostDeviceId, { kind: 'primary', botId: BOT_ID });
    const first = (await stream.next()).value;

    assert.equal(legacyRelay.badFrameCloses, 0);
    assert.equal(first.type, 'snapshot');
    assert.equal(first.state.durableWaits, undefined);
    assert.equal('durableWaits' in first.state, false);
    assert.equal('googleSetupRevision' in first.state, false);
    assert.equal('durableWait' in first.state.history[4].messages[0], false);
    assert.equal(first.state.history[0].attribution.sourceType, 'google-workspace-rule');
    assert.equal('sourceType' in first.state.history[1].attribution, false);
    assert.equal(first.state.history[1].attribution.kind, 'host');
    assert.equal(first.state.history[2].attribution.sourceType, 'webhook');

    // UI merge treats undefined durableWaits as read-only degraded remote card.
    const merged = mergeHistoryWaitProjection(WAIT_ENTRY, first.state.history[4], first.state.durableWaits);
    assert.equal(merged.model[0].durableWait, false);

    // Even when Host pushes a durableWaits-only SSE update, downgraded wire stays valid and connected.
    control.pushUpdate({ durableWaits: [] });
    const second = (await stream.next()).value;
    assert.equal(second.type, 'snapshot');
    assert.equal(second.state.durableWaits, undefined);
    assert.equal(legacyRelay.badFrameCloses, 0);

    control.pushEnd('stopped');
    const ended = (await stream.next()).value;
    assert.deepEqual(ended, { type: 'end', reason: 'stopped' });
  } finally {
    client?.close();
    await link?.close();
    await legacyRelay.close();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('new Host -> new Relay serves downgraded legacy frames to old Client and full frames to new Client concurrently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-live-mixed-clients-'));
  const relayDir = join(root, 'relay');
  mkdirSync(relayDir, { recursive: true });
  const { dir: hostDir, deviceId: hostDeviceId } = createHostIdentity(root, 'host');
  const oldClientId = 'client-old-1';
  const newClientId = 'client-new-3';
  const hostToken = makeToken();
  const oldClientToken = makeToken();
  const newClientToken = makeToken();
  const controlToken = makeToken();

  const reg = openRelayRegistry({ dataRoot: relayDir });
  reg.register({ deviceId: hostDeviceId, token: hostToken });
  reg.register({ deviceId: oldClientId, token: oldClientToken });
  reg.register({ deviceId: newClientId, token: newClientToken });
  reg.close();

  const { pendingState } = buildLiveStates();
  const control = await startMockControlServer({
    deviceId: hostDeviceId,
    token: controlToken,
    defaultWorkspace: hostDir,
    initialState: pendingState,
  });
  const relay = await openRelayServer({ dataRoot: relayDir, port: 0, listenHost: '127.0.0.1' });
  let link = null;
  let newClient = null;
  let oldClient = null;
  try {
    link = await openDeviceLink({
      dataRoot: hostDir,
      url: relay.url,
      token: hostToken,
      control: { url: control.url, token: controlToken },
    });
    await waitForOnline(link);

    oldClient = await connectRawLegacyPeer({
      url: relay.url,
      hello: { type: 'hello', protocolVersion: 1, deviceId: oldClientId, token: oldClientToken, role: 'client', controlProtocol: 2 },
    });
    // Legacy client did not request extensions -> 101 must not echo extension header.
    assert.equal(oldClient.upgradeHeaders?.[LIVE_EXTENSIONS_HEADER], undefined);
    assert.equal(oldClient.ready.type, 'ready');
    assert.equal(oldClient.ready.controlProtocol, 2);

    newClient = await openRemoteControl({ deviceId: newClientId, url: relay.url, token: newClientToken });

    oldClient.sendRaw({
      type: 'live-open',
      watchId: 'watch-old-1',
      targetDeviceId: hostDeviceId,
      target: { kind: 'primary', botId: BOT_ID },
    });
    const oldLiveMsg = await oldClient.nextFrame();
    assert.equal(oldLiveMsg.type, 'live-frame');
    assert.equal('durableWaits' in oldLiveMsg.frame.state, false);
    assert.equal('googleSetupRevision' in oldLiveMsg.frame.state, false);
    assert.equal('durableWait' in oldLiveMsg.frame.state.history[4].messages[0], false);
    assert.equal(oldLiveMsg.frame.state.history[0].attribution.sourceType, 'google-workspace-rule');
    assert.equal('sourceType' in oldLiveMsg.frame.state.history[1].attribution, false);
    assert.equal(oldLiveMsg.frame.state.history[2].attribution.sourceType, 'webhook');

    const newStream = newClient.live(hostDeviceId, { kind: 'primary', botId: BOT_ID });
    const newFirst = (await newStream.next()).value;
    assert.deepEqual(newFirst.state.durableWaits, [WAIT_IDENTITY]);
    assert.equal(newFirst.state.googleSetupRevision, 4);
    assert.equal(newFirst.state.history[4].messages[0].durableWait, true);
    assert.deepEqual(
      newFirst.state.history.slice(0, 3).map((item) => item.attribution?.sourceType),
      ['google-workspace-rule', 'schedule', 'task_dispatch'],
    );
    await newStream.return();
  } finally {
    oldClient?.close();
    newClient?.close();
    await link?.close();
    await relay.close();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('old Host -> new Relay -> new Client delivers durableWaits: undefined and rejects unnegotiated/forged extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-live-old-host-'));
  const relayDir = join(root, 'relay');
  mkdirSync(relayDir, { recursive: true });
  const oldHostId = 'host-old-1';
  const clientDeviceId = 'client-new-4';
  const oldHostToken = makeToken();
  const clientToken = makeToken();

  const reg = openRelayRegistry({ dataRoot: relayDir });
  reg.register({ deviceId: oldHostId, token: oldHostToken });
  reg.register({ deviceId: clientDeviceId, token: clientToken });
  reg.close();

  const relay = await openRelayServer({ dataRoot: relayDir, port: 0, listenHost: '127.0.0.1' });
  let oldHost = null;
  let client = null;
  try {
    oldHost = await connectRawLegacyPeer({
      url: relay.url,
      hello: {
        type: 'hello',
        protocolVersion: 1,
        deviceId: oldHostId,
        token: oldHostToken,
        role: 'host',
        controlProtocol: 2,
        scopeProtocol: 1,
      },
    });
    assert.equal(oldHost.upgradeHeaders?.[LIVE_EXTENSIONS_HEADER], undefined);

    client = await openRemoteControl({ deviceId: clientDeviceId, url: relay.url, token: clientToken });
    const stream = client.live(oldHostId, { kind: 'primary', botId: BOT_ID });
    await assert.rejects(client.live(oldHostId, {
      kind: 'browser', botId: BOT_ID, pageId: 'page-1', sessionId: 'session-1',
    }).next(), { code: 'CONTROL_UNAVAILABLE' });
    const req = await oldHost.nextFrame();
    assert.equal(req.type, 'live-request');

    const legacyState = {
      history: [{
        id: 1,
        kind: 'host.user-message',
        attribution: { kind: 'host', channel: 'primary', name: 'Rule · Drive', sourceType: 'google-workspace-rule' },
        messages: [{ role: 'user', text: 'Legacy host event', truncated: false }],
      }],
      historyTruncated: false,
      lastEntryId: 1,
      generation: null,
      tools: [],
      toolsTruncated: false,
      busy: false,
      queuedCount: 0,
      activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
    };
    oldHost.sendRaw({
      type: 'live-frame',
      routeId: req.routeId,
      frame: {
        type: 'snapshot',
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        sequence: 1,
        state: legacyState,
      },
    });

    const first = (await stream.next()).value;
    assert.equal(first.type, 'snapshot');
    assert.equal(first.state.durableWaits, undefined);
    assert.equal('durableWaits' in first.state, false);
    assert.equal(first.state.history[0].attribution.sourceType, 'google-workspace-rule');

    // Old host did NOT negotiate durableWaits; smuggling durableWaits: [] must close it with 4400 BAD_FRAME.
    oldHost.sendRaw({
      type: 'live-frame',
      routeId: req.routeId,
      frame: {
        type: 'snapshot',
        botId: BOT_ID,
        conversationId: CONVERSATION_ID,
        sequence: 2,
        state: { ...legacyState, durableWaits: [] },
      },
    });
    const closeCode = await oldHost.waitClose();
    assert.equal(closeCode, RELAY_CLOSE.BAD_FRAME);
    await assert.rejects(() => stream.next(), (err) => err?.code === 'DISCONNECTED');
  } finally {
    oldHost?.close();
    client?.close();
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('new Client rejects unnegotiated extension injection from an untrusted legacy relay', async () => {
  const clientDeviceId = 'client-new-5';
  const clientToken = makeToken();

  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    // Does NOT echo X-PiBot-Live-Extensions header.
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'hello') {
          ws.send(encodeRelayFrame({
            type: 'ready',
            protocolVersion: 1,
            deviceId: msg.deviceId,
            role: 'client',
            controlProtocol: 2,
          }));
        } else if (msg.type === 'live-open') {
          // Malicious/misbehaving legacy relay injects durableWaits without negotiating.
          ws.send(encodeRelayFrame({
            type: 'live-frame',
            watchId: msg.watchId,
            targetDeviceId: msg.targetDeviceId,
            frame: {
              type: 'snapshot',
              botId: BOT_ID,
              conversationId: CONVERSATION_ID,
              sequence: 1,
              state: {
                history: [],
                historyTruncated: false,
                lastEntryId: null,
                generation: null,
                tools: [],
                toolsTruncated: false,
                busy: false,
                queuedCount: 0,
                durableWaits: [],
              },
            },
          }));
        }
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let client = null;
  try {
    client = await openRemoteControl({
      deviceId: clientDeviceId,
      url: `ws://127.0.0.1:${port}/v1/link`,
      token: clientToken,
    });
    const stream = client.live('target-host', { kind: 'primary', botId: BOT_ID });
    await assert.rejects(() => stream.next(), (err) => err?.code === 'BAD_FRAME');
  } finally {
    client?.close();
    for (const c of wss.clients) {
      try { c.terminate(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
});
