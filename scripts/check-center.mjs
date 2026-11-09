import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { validateCenterUrl } from '../host-core/center-client.js';

const timeoutMs = 5_000;

function probeRelay(base) {
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(new URL('/v1/link', base), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    }, response => {
      response.destroy();
      reject(new Error('expected WebSocket upgrade, received HTTP ' + response.statusCode));
    });
    request.once('error', reject);
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      if (response.statusCode === 101 && response.headers['sec-websocket-accept'] === accept) resolve();
      else reject(new Error('invalid WebSocket upgrade response'));
    });
  });
}

async function main() {
  let base;
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-center.mjs <Center origin>');
    base = validateCenterUrl(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const healthUrl = new URL('/api/health', base);
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const { status } = await response.json();
    if (status === 'setup') {
      console.error('[WAIT] ' + healthUrl + ' · complete Center setup in the browser.');
      return 1;
    }
    if (status !== 'ready') throw new Error('expected Center health status ready');
    console.log('[OK] ' + healthUrl + ' · ready');
  } catch (error) {
    const reason = error.cause?.code ?? error.message;
    console.error('[FAIL] ' + healthUrl + ' · ' + reason);
    return 1;
  }

  try {
    await probeRelay(base);
    console.log('[OK] /v1/link · WebSocket upgrade accepted');
    return 0;
  } catch (error) {
    console.error('[FAIL] /v1/link · ' + (error.code ?? error.message));
    return 1;
  }
}

process.exitCode = await main();
