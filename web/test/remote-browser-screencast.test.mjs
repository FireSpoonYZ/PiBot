import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createControlClient } from '../../host-core/control-client.js';
import { openControlServer } from '../../host-core/control-server.js';
import { openDeviceLink } from '../../host-core/device-link.js';
import { openRelayRegistry } from '../../host-core/relay-registry.js';
import { openRelayServer } from '../../host-core/relay-server.js';
import { openRemoteControl } from '../../host-core/remote-control-client.js';
import { readClientFrame, readServerFrame } from '../../host-core/relay-protocol.js';
import { addressBrowserStreamPacket, encodeBrowserStreamPacket } from '../../host-core/bot-browser/stream-packet.js';

const JPEG_FIXTURE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const streamOptions = { liveExtensions: { browserScreencast: true } };

test('Center browser packet keeps Orca frame bytes and binds them to the intended watch', () => {
  const routeId = randomUUID();
  const watchId = randomUUID();
  const frame = { seq: 2, revision: 4, width: 1280, height: 800, mimeType: 'image/jpeg', data: JPEG_FIXTURE };
  const wire = encodeBrowserStreamPacket(routeId, frame);
  assert.throws(() => readClientFrame(wire, true), { code: 'INVALID_ARGUMENT' });
  const incoming = readClientFrame(wire, true, streamOptions);
  assert.equal(incoming.streamId, routeId);
  const outgoing = readServerFrame(addressBrowserStreamPacket(incoming, watchId), true, streamOptions);
  assert.equal(outgoing.streamId, watchId);
  assert.equal(incoming.bytes.toString('ascii', 4, 40), routeId);
  assert.equal(outgoing.seq, frame.seq);
  assert.equal(outgoing.revision, frame.revision);
  assert.equal(outgoing.image.toString('base64'), JPEG_FIXTURE);
  assert.throws(() => readClientFrame(wire.subarray(0, -4), true, streamOptions), { code: 'INVALID_ARGUMENT' });
});

test('two authenticated devices use one Host page and Center withholds private pixels and foreign input', { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pibot-center-browser-'));
  const dataRoot = join(root, 'host');
  const relayRoot = join(root, 'relay');
  const controlToken = randomBytes(24).toString('base64url');
  const pageId = 'page-shared';
  const sessionId = 'session-shared';
  const url = 'https://fixture.example.test/';
  let opened = false;
  let typed = 0;
  let formIsPrivate = false;
  let secretIsVisible = false;
  let control, relay, link, viewerA, viewerB;
  t.after(async () => {
    viewerA?.close();
    viewerB?.close();
    await link?.close();
    await relay?.close();
    await control?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  control = await openControlServer({
    dataRoot, token: controlToken, port: 0, deferResume: true,
    nativeBridge: async () => ({}),
    centerRuntime: {
      snapshot: { protocol: 1 },
      centerUrl: 'https://center.example.test',
      installer: {},
      getClient: () => ({ providerAuth: async () => ({ auth: { apiKey: 'fixture' }, source: 'center' }) }),
    },
    createBrowserProvider: () => ({
      async perform(input) {
        if (input.action === 'open') opened = true;
        if (input.action === 'input') typed += 1;
        const hints = {
          ...(formIsPrivate ? { hasPasswordInput: true } : {}),
          ...(secretIsVisible ? { clientSecretVisible: true } : {}),
        };
        const current = {
          available: true,
          canStreamInteract: true,
          pageId: opened ? pageId : null,
          sessionId: opened ? sessionId : null,
          tabs: opened ? [{ id: pageId, url, title: 'Shared fixture' }] : [],
          documentGeneration: 1,
          hints,
        };
        if (input.action !== 'frame') return current;
        return {
          ...current, url, title: 'Shared fixture', width: 20, height: 20, mimeType: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, typed, Number(formIsPrivate), Number(secretIsVisible), 0xff, 0xd9]).toString('base64'),
        };
      },
      async close() {},
    }),
  });
  await control.applyCenterSnapshot({
    protocol: 1, deviceId: control.deviceId, revision: 1, providers: [], models: {}, bots: [],
  });
  await control.setCenterOnline(true);
  await control.restoreTurns();
  control.resume();
  const local = createControlClient({ url: control.url, token: controlToken });
  const { botId } = await local.createBot({ requestId: 'create-fixture', role: 'Browser fixture', cwd: root });
  const registry = openRelayRegistry({ dataRoot: relayRoot });
  const hostToken = randomBytes(24).toString('base64url');
  const devices = ['desktop-viewer', 'android-viewer'].map(deviceId => ({
    deviceId, token: randomBytes(24).toString('base64url'),
  }));
  try {
    registry.register({ deviceId: control.deviceId, token: hostToken });
    for (const device of devices) registry.register(device);
  } finally {
    registry.close();
  }
  relay = await openRelayServer({ dataRoot: relayRoot, port: 0 });
  link = await openDeviceLink({ dataRoot, url: relay.url, token: hostToken, control: { url: control.url, token: controlToken } });
  const until = AbortSignal.timeout(5000);
  while (link.getStatus().phase !== 'online') await delay(20, undefined, { signal: until });
  viewerA = await openRemoteControl({ url: relay.url, ...devices[0] });
  viewerB = await openRemoteControl({ url: relay.url, ...devices[1] });

  const perform = (viewer, input) => viewer.call(control.deviceId, 'browserControl', { botId, ...input });
  const watch = (viewer, fields = {}) => viewer.live(control.deviceId, {
    kind: 'browser', botId, pageId, sessionId, ...fields,
  });
  const read = async (stream) => {
    const { value } = await stream.next();
    assert.equal(value?.type, 'browser-frame');
    assert.equal(value.frame.pageId, pageId);
    return value.frame;
  };

  await perform(viewerA, { action: 'open', url });
  await assert.rejects(watch(viewerA, { sessionId: 'expired-session' }).next(), { code: 'BROWSER_STALE_PAGE' });
  const watchingA = watch(viewerA);
  const watchingB = watch(viewerB);
  const [firstA, firstB] = await Promise.all([read(watchingA), read(watchingB)]);
  assert.equal(firstA.data, firstB.data);
  await watchingA.return();
  const owner = await perform(viewerA, { action: 'takeover', pageId });
  const ownedStream = watch(viewerA, { lease: owner.lease });
  const inputFrame = await read(ownedStream);
  const input = {
    action: 'input', pageId, lease: owner.lease, revision: inputFrame.revision, frameSeq: inputFrame.seq,
    event: { kind: 'text', text: 'unsaved fixture text' },
  };
  await assert.rejects(perform(viewerB, input), { code: 'BROWSER_LEASE_CONFLICT' });
  await perform(viewerA, input);
  assert.equal(typed, 1);
  const updatedB = await read(watchingB);
  assert.ok(updatedB.seq > firstB.seq);
  assert.notEqual(updatedB.data, firstB.data);

  formIsPrivate = true;
  await perform(viewerA, { action: 'status' });
  await assert.rejects(watchingB.next(), { code: 'BROWSER_SENSITIVE_BLOCKED' });
  await assert.rejects(watch(viewerB, { lease: owner.lease }).next(), { code: 'BROWSER_SENSITIVE_BLOCKED' });
  let privateFrame = await read(ownedStream);
  if (Buffer.from(privateFrame.data, 'base64')[3] === 0) privateFrame = await read(ownedStream);
  assert.equal(Buffer.from(privateFrame.data, 'base64')[3], 1);

  secretIsVisible = true;
  await perform(viewerA, { action: 'status' });
  await assert.rejects(ownedStream.next(), { code: 'BROWSER_SECRET_STEP_BLOCKED' });
});
