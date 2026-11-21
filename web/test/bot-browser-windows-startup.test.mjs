import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { launchDesktopChromium } from '../../host-core/bot-browser/desktop-cdp.js';
import { readWindowsDevToolsEndpoint, windowsCommandLineArgs } from '../../host-core/bot-browser/desktop-windows-endpoint.js';

const endpoint = { url: 'ws://127.0.0.1:43123/devtools/browser/current-launch', contents: '43123\n/devtools/browser/current-launch', mtimeMs: Number.MAX_SAFE_INTEGER };

function fakeLaunch({ exitCode = 0, stderr = '' } = {}) {
  let connected = 0;
  const methods = [];
  return {
    methods,
    get connected() { return connected; },
    options: {
      executablePath: 'C:\\Browser\\chrome.exe', profilePath: 'C:\\Bot\\profile',
      platform: 'win32', transport: 'loopback', startupTimeoutMs: 1_000,
      spawnImpl(_file, args) {
        assert.match(args[0], /^--pibot-launch-nonce=[a-f0-9]{64}$/);
        const child = new EventEmitter();
        Object.assign(child, { exitCode: null, signalCode: null, stderr: new PassThrough(), pid: 123 });
        setImmediate(() => {
          if (stderr) child.stderr.write(stderr);
          child.exitCode = exitCode;
          child.emit('exit', exitCode, null);
        });
        return child;
      },
      createWebSocket() {
        connected++;
        const socket = new EventEmitter();
        socket.readyState = 1;
        socket.send = text => {
          const command = JSON.parse(text);
          methods.push(command.method);
          queueMicrotask(() => socket.emit('message', JSON.stringify({ id: command.id, result: {} })));
        };
        socket.close = () => socket.emit('close');
        socket.terminate = socket.close;
        setImmediate(() => socket.emit('open'));
        return socket;
      },
    },
  };
}

test('Windows clean launcher exit waits for fresh endpoint, proves ownership, and closes via CDP', async () => {
  const fake = fakeLaunch();
  let reads = 0;
  let verified = false;
  const handle = await launchDesktopChromium({
    ...fake.options,
    readWindowsEndpoint: async () => ++reads < 3 ? null : endpoint,
    verifyWindowsOwner: async ({ url, nonce, executablePath }) => {
      assert.equal(fake.connected, 0);
      assert.equal(url, endpoint.url);
      assert.match(nonce, /^[a-f0-9]{64}$/);
      assert.equal(executablePath, fake.options.executablePath);
      verified = true;
    },
  });
  assert.equal(verified, true);
  assert.equal(handle.client.closed, false);
  await handle.close();
  assert.deepEqual(fake.methods, ['Browser.getVersion', 'Browser.close']);
});

test('Windows inherited stderr remains usable without an ancillary profile file or WMI', async () => {
  const fake = fakeLaunch({ stderr: `DevTools listening on ${endpoint.url}\n` });
  const handle = await launchDesktopChromium({
    ...fake.options,
    readWindowsEndpoint: async () => { throw new Error('ancillary file unreadable'); },
    verifyWindowsOwner: async () => assert.fail('direct stderr must not require WMI'),
  });
  await handle.close();
});

test('Windows unchanged stale endpoint never connects and signals that the profile can be recovered', async () => {
  const fake = fakeLaunch();
  await assert.rejects(launchDesktopChromium({
    ...fake.options,
    startupTimeoutMs: 75,
    readWindowsEndpoint: async () => endpoint,
    verifyWindowsOwner: async () => assert.fail('stale endpoint must not be queried'),
  }), error => error.code === 'BROWSER_TIMEOUT' && error.data?.profileInUse === true &&
    /existing browser/.test(error.message));
  assert.equal(fake.connected, 0);
});

test('Windows profile-in-use exit is recoverable without connecting to the existing browser', async () => {
  const fake = fakeLaunch({ exitCode: 21 });
  await assert.rejects(launchDesktopChromium({
    ...fake.options,
    readWindowsEndpoint: async () => null,
    verifyWindowsOwner: async () => assert.fail('an occupied profile must not be queried'),
  }), error => error.code === 'BROWSER_START_FAILED' && error.data?.profileInUse === true);
  assert.equal(fake.connected, 0);
});

test('Windows fresh foreign endpoint, nonzero exit, and cancellation never connect', async () => {
  for (const scenario of ['foreign', 'nonzero', 'abort']) {
    const fake = fakeLaunch({ exitCode: scenario === 'nonzero' ? 1 : 0 });
    const controller = new AbortController();
    let reads = 0;
    await assert.rejects(launchDesktopChromium({
      ...fake.options, signal: controller.signal,
      readWindowsEndpoint: async () => ++reads === 1 ? null : endpoint,
      verifyWindowsOwner: async () => {
        if (scenario === 'abort') controller.abort();
        else throw Object.assign(new Error('Foreign listener'), { code: 'BROWSER_UNSAFE_ENDPOINT' });
      },
    }), error => error.code === (scenario === 'foreign' ? 'BROWSER_UNSAFE_ENDPOINT' : scenario === 'abort' ? 'CANCELLED' : 'BROWSER_START_FAILED'));
    assert.equal(fake.connected, 0);
  }
});

test('DevToolsActivePort parsing is bounded and strict; nonce is a complete Windows argument', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pibot-endpoint-'));
  try {
    const filename = path.join(directory, 'DevToolsActivePort');
    await writeFile(filename, '43123\n/devtools/browser/current-launch\n');
    assert.equal((await readWindowsDevToolsEndpoint(directory)).url, endpoint.url);
    for (const invalid of ['0\n/devtools/browser/id', '65536\n/devtools/browser/id', '43123\n/devtools/browser/id?query', '43123\n/devtools/browser/id\nextra']) {
      await writeFile(filename, invalid);
      assert.equal(await readWindowsDevToolsEndpoint(directory), null);
    }
    await writeFile(filename, 'x'.repeat(513));
    await assert.rejects(readWindowsDevToolsEndpoint(directory), { code: 'BROWSER_UNSAFE_ENDPOINT' });
    assert.deepEqual(windowsCommandLineArgs('"C:\\Browser App\\chrome.exe" --pibot-launch-nonce=abc'), ['C:\\Browser App\\chrome.exe', '--pibot-launch-nonce=abc']);
    assert.equal(windowsCommandLineArgs('chrome.exe "--other= --pibot-launch-nonce=abc"').includes('--pibot-launch-nonce=abc'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
