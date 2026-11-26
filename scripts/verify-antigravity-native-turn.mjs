#!/usr/bin/env node
// scripts/verify-antigravity-native-turn.mjs — Real `agy 1.5.12` native-turn E2E verification.
//
// Scope: exercises the full Center HTTP + WebSocket Relay + Pi Durable Harness +
// host-core/antigravity-runner.js + center-server/antigravity + real `agy acp` stack
// in a strictly isolated temp workspace outside the repo (never reads/writes daily ~/.gemini):
//   1. Catalog discovery + multi-turn memory without session rebuild (Turn 1 -> Turn 2).
//   2. Dynamic section / SOUL update without session rebuild or AGY_HISTORY_CHANGED (Turn 3).
//   3. Real Host ToolTask (codemode read) + tool image via standard MCP image block, no recall-hook (Turn 4).
//   4. Center restart + cold `session/resume` preserving conversationId & memory/image (Turn 5).
//   5. In-session AGY model switch (`modelA -> modelB`) via `set_config_option` without `/clear` (Turn 6).
//   6. Mid-turn Stop (`abort`) preserving `convId1`, followed by continuation on same session (Turn 7 -> Turn 8).
//   7. Mid-turn `steer` during active tool execution, converging into final reply on same session (Turn 9).
//   8. `/clear` rotating ProviderDoc.sessionId and creating a fresh `convId2 !== convId1` (Turn 10).
//
// Usage:
//   node scripts/verify-antigravity-native-turn.mjs
//   node scripts/verify-antigravity-native-turn.mjs --bin C:\path\to\agy.exe
//   PIBOT_AGY_BIN=/usr/local/bin/agy PIBOT_AGY_E2E_ROOT=/tmp/my-e2e node scripts/verify-antigravity-native-turn.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  X509Certificate,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSecureContext } from 'node:tls';
import zlib from 'node:zlib';

import {
  AGY_HISTORY_CHANGED,
  ANTIGRAVITY_PROVIDER_ID,
} from '../center-contract/antigravity.js';
import { hashOwnerPassword } from '../center-server/config.js';
import { openCenterServer } from '../center-server/server.js';
import { createControlClient } from '../host-core/control-client.js';
import { openHost } from '../host-core/host.js';
import { openHostService } from '../host-core/host-service.js';

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_SYNC_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 300;
const PREFERRED_MODEL_ORDER = [
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-3-flash',
  'gemini-3-pro',
];
const IMAGE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const STRIP_ENV_PATTERNS = [/^ANTIGRAVITY_/i, /^ORCA_/i, /^HINDSIGHT_/i];
const STRIP_EXACT_ENV_KEYS = ['PI_AGY_RECALL_PORT', 'PI_AGY_RECALL_KEY'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

function parsePositiveInt(raw, label, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  assert.ok(Number.isInteger(parsed) && parsed > 0, `${label} must be a positive integer`);
  return parsed;
}

function parseCliArgs(argv) {
  const opts = {
    bin: undefined,
    root: undefined,
    timeoutMs: undefined,
    modelA: undefined,
    modelB: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    const nextValue = (flag) => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
      }
      return value;
    };
    if (arg === '--bin') opts.bin = nextValue('--bin');
    else if (arg.startsWith('--bin=')) opts.bin = arg.slice('--bin='.length);
    else if (arg === '--root') opts.root = nextValue('--root');
    else if (arg.startsWith('--root=')) opts.root = arg.slice('--root='.length);
    else if (arg === '--timeout-ms') opts.timeoutMs = nextValue('--timeout-ms');
    else if (arg.startsWith('--timeout-ms=')) opts.timeoutMs = arg.slice('--timeout-ms='.length);
    else if (arg === '--model-a') opts.modelA = nextValue('--model-a');
    else if (arg.startsWith('--model-a=')) opts.modelA = arg.slice('--model-a='.length);
    else if (arg === '--model-b') opts.modelB = nextValue('--model-b');
    else if (arg.startsWith('--model-b=')) opts.modelB = arg.slice('--model-b='.length);
    else throw new Error(`Unknown CLI argument: ${arg}`);
  }
  return opts;
}

function printUsage() {
  console.log([
    'Usage: node scripts/verify-antigravity-native-turn.mjs [options]',
    '',
    'Options:',
    '  --bin <path>          Path or binary name for agy CLI (default: PIBOT_AGY_BIN or "agy")',
    '  --root <dir>          Isolated temp workspace root (default: PIBOT_AGY_E2E_ROOT or <tmpdir>/agy-e2e-<ts>)',
    '  --timeout-ms <ms>     Per-turn timeout in milliseconds (default: PIBOT_AGY_TIMEOUT_MS or 120000)',
    '  --model-a <modelId>   Override initial AGY model id (default: PIBOT_AGY_MODEL_A or auto-selected)',
    '  --model-b <modelId>   Override switch target AGY model id (default: PIBOT_AGY_MODEL_B or auto-selected)',
    '  -h, --help            Show this help message',
  ].join('\n'));
}

function normalizePathForCompare(p) {
  const resolved = existsSync(p) ? realpathSync(p) : path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertIsolatedGeminiDir(geminiDir) {
  const dailyGemini = path.join(os.homedir(), '.gemini');
  const candidate = normalizePathForCompare(geminiDir);
  const daily = normalizePathForCompare(dailyGemini);
  assert.notEqual(
    candidate,
    daily,
    `Refusing to use daily ~/.gemini profile (${dailyGemini})`,
  );
  const rel = path.relative(daily, candidate);
  const insideDaily = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  assert.equal(
    insideDaily,
    false,
    `Refusing to place isolated geminiDir inside daily ~/.gemini (${dailyGemini})`,
  );
}

function createRedactor() {
  const literals = new Set();
  const addSecret = (value) => {
    if (typeof value === 'string' && value.length >= 8) {
      literals.add(value);
    }
  };
  const redactString = (input) => {
    let text = String(input ?? '');
    for (const secret of literals) {
      if (text.includes(secret)) {
        text = text.split(secret).join('<REDACTED>');
      }
    }
    text = text
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <REDACTED>')
      .replace(/pboauth_[A-Za-z0-9_-]+/g, 'pboauth_<REDACTED>')
      .replace(
        /(["']?(?:access_token|refresh_token|id_token|api_key|apiKey|client_secret|deviceToken|controlToken|password|csrfToken|x-bridge-token)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi,
        '$1<REDACTED>',
      );
    return text;
  };
  const redactValue = (value) => {
    if (typeof value === 'string') {
      if (value.length > 1024 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 128))) {
        return `<base64 len=${value.length}>`;
      }
      return redactString(value);
    }
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (/^(authorization|cookie|set-cookie|x-csrf-token|x-bridge-token|devicetoken|controltoken|password|encryptionkey|sessionkey)$/i.test(k)) {
          out[k] = '<REDACTED>';
        } else {
          out[k] = redactValue(v);
        }
      }
      return out;
    }
    return value;
  };
  return { addSecret, redactString, redactValue };
}

// ---------- Pure-Node X.509 v3 self-signed loopback TLS certificate ----------

function derLen(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items) {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(...items) {
  return derTag(0x31, Buffer.concat(items));
}

function derBitString(buf) {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derOctetString(buf) {
  return derTag(0x04, buf);
}

function derUtf8String(text) {
  return derTag(0x0c, Buffer.from(text, 'utf8'));
}

function derPositiveInteger(rawBuf) {
  let i = 0;
  while (i < rawBuf.length - 1 && rawBuf[i] === 0) i++;
  let slice = rawBuf.subarray(i);
  if (slice[0] & 0x80) {
    slice = Buffer.concat([Buffer.from([0x00]), slice]);
  }
  return derTag(0x02, slice);
}

function derOid(dotted) {
  const arcs = dotted.split('.').map(Number);
  assert.ok(arcs.length >= 2, `Invalid OID: ${dotted}`);
  const out = [arcs[0] * 40 + arcs[1]];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i];
    if (v === 0) {
      out.push(0);
      continue;
    }
    const base128 = [];
    while (v > 0) {
      base128.push(v & 0x7f);
      v >>>= 7;
    }
    base128.reverse();
    for (let j = 0; j < base128.length - 1; j++) {
      out.push(base128[j] | 0x80);
    }
    out.push(base128[base128.length - 1]);
  }
  return derTag(0x06, Buffer.from(out));
}

function derTime(date) {
  const year = date.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const tail =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  if (year >= 1950 && year < 2050) {
    return derTag(0x17, Buffer.from(String(year).slice(-2) + tail, 'ascii'));
  }
  return derTag(0x18, Buffer.from(String(year).padStart(4, '0') + tail, 'ascii'));
}

function derExtension(oid, critical, valueDer) {
  const fields = [derOid(oid)];
  if (critical) fields.push(Buffer.from([0x01, 0x01, 0xff]));
  fields.push(derOctetString(valueDer));
  return derSeq(...fields);
}

function generateSelfSignedLoopbackCert() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 0x01;

  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2) has omitted parameters per RFC 5758 §3.2.
  const sigAlg = derSeq(derOid('1.2.840.10045.4.3.2'));
  const subjectName = derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8String('PiBot AGY E2E Loopback CA'))));

  const now = Date.now();
  const notBefore = new Date(now - 5 * 60 * 1000);
  const notAfter = new Date(now + 7 * 24 * 60 * 60 * 1000);
  const validity = derSeq(derTime(notBefore), derTime(notAfter));

  const extBasicConstraints = derExtension('2.5.29.19', true, derSeq(Buffer.from([0x01, 0x01, 0xff])));
  // digitalSignature (bit 0) | keyEncipherment (bit 2) | keyCertSign (bit 5) = 0xa4 (2 unused trailing bits).
  const extKeyUsage = derExtension('2.5.29.15', true, Buffer.from([0x03, 0x02, 0x02, 0xa4]));
  const extExtKeyUsage = derExtension('2.5.29.37', false, derSeq(derOid('1.3.6.1.5.5.7.3.1')));
  const extSan = derExtension(
    '2.5.29.17',
    false,
    derSeq(
      derTag(0x82, Buffer.from('localhost', 'ascii')),
      derTag(0x87, Buffer.from([127, 0, 0, 1])),
    ),
  );
  const extensions = derTag(0xa3, derSeq(extBasicConstraints, extKeyUsage, extExtKeyUsage, extSan));

  const tbsCert = derSeq(
    derTag(0xa0, derPositiveInteger(Buffer.from([0x02]))), // v3
    derPositiveInteger(serial),
    sigAlg,
    subjectName,
    validity,
    subjectName,
    spkiDer,
    extensions,
  );

  const signature = cryptoSign('sha256', tbsCert, privateKey);
  const certDer = derSeq(tbsCert, sigAlg, derBitString(signature));
  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;

  // Fail fast if generated cert does not pass OpenSSL / Node TLS validation.
  const x509 = new X509Certificate(certPem);
  assert.equal(x509.ca, true, 'generated loopback cert must have CA=true');
  assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1', 'generated loopback cert must cover 127.0.0.1');
  assert.equal(x509.verify(x509.publicKey), true, 'generated loopback cert signature must self-verify');
  createSecureContext({ cert: certPem, key: keyPem, ca: certPem });

  return { certPem, keyPem };
}

// ---------- Loopback HTTPS/WSS reverse proxy -> plain HTTP Center ----------

async function createTlsReverseProxy({ cert, key }) {
  let targetPort = null;
  const activeClientSockets = new Set();
  const activeTunnelSockets = new Set();
  const activeUpstreamReqs = new Set();

  const destroyAllActive = () => {
    for (const req of [...activeUpstreamReqs]) {
      try { req.destroy(); } catch {}
    }
    activeUpstreamReqs.clear();
    for (const sock of [...activeTunnelSockets]) {
      try { sock.destroy(); } catch {}
    }
    activeTunnelSockets.clear();
    for (const sock of [...activeClientSockets]) {
      try { sock.destroy(); } catch {}
    }
    activeClientSockets.clear();
  };

  const server = https.createServer({ cert, key }, (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    const port = targetPort;
    if (!port) {
      res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"error":{"code":"CENTER_OFFLINE","message":"Center upstream is stopped"}}');
      return;
    }

    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    const upReq = http.request({
      hostname: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers,
    });
    upReq.setTimeout(0);
    activeUpstreamReqs.add(upReq);
    upReq.once('close', () => activeUpstreamReqs.delete(upReq));

    upReq.on('response', (upRes) => {
      if (res.destroyed || res.writableEnded) {
        upRes.destroy();
        return;
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      res.flushHeaders?.();
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });

    upReq.on('error', () => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
        res.end('{"error":{"code":"CENTER_OFFLINE","message":"Center upstream unreachable"}}');
      } else {
        res.destroy();
      }
    });

    const abortUpstream = () => {
      if (!upReq.destroyed) upReq.destroy();
    };
    req.once('aborted', abortUpstream);
    res.once('close', () => {
      if (!res.writableFinished) abortUpstream();
    });

    req.pipe(upReq);
  });

  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 60_000;

  server.on('secureConnection', (sock) => {
    activeClientSockets.add(sock);
    sock.setTimeout(0);
    sock.once('close', () => activeClientSockets.delete(sock));
  });

  server.on('upgrade', (req, clientSocket, head) => {
    const port = targetPort;
    if (!port) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    clientSocket.setTimeout(0);
    const upSocket = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        if (name.toLowerCase() === 'host') {
          lines.push(`${name}: 127.0.0.1:${port}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      upSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length > 0) upSocket.write(head);
      clientSocket.pipe(upSocket);
      upSocket.pipe(clientSocket);
    });
    upSocket.setTimeout(0);

    activeTunnelSockets.add(clientSocket);
    activeTunnelSockets.add(upSocket);
    const cleanup = () => {
      activeTunnelSockets.delete(clientSocket);
      activeTunnelSockets.delete(upSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upSocket.destroyed) upSocket.destroy();
    };
    clientSocket.once('error', cleanup);
    clientSocket.once('close', cleanup);
    upSocket.once('error', cleanup);
    upSocket.once('close', cleanup);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && address.port > 0, 'TLS proxy failed to bind loopback port');

  return {
    port: address.port,
    publicUrl: `https://127.0.0.1:${address.port}`,
    setTarget(nextPort) {
      const prev = targetPort;
      targetPort = nextPort ?? null;
      if (nextPort === null || (prev !== null && prev !== nextPort)) {
        destroyAllActive();
      }
    },
    async close() {
      targetPort = null;
      destroyAllActive();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------- Pure-Node crisp PNG generator (5x7 bitmap font + corner shape) ----------

const FONT_5X7 = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function generateTestPng({ code, shape = 'circle', colorName = 'red', corner = 'bottom-right' }) {
  const W = 720;
  const H = 440;
  const COLORS = {
    red: [220, 20, 20],
    blue: [20, 75, 230],
    green: [20, 170, 50],
    purple: [145, 30, 210],
    orange: [245, 130, 10],
  };
  const rgb = COLORS[colorName];
  if (!rgb) throw new Error(`Unknown color: ${colorName}`);

  const pixels = Buffer.alloc(W * H * 3, 255);
  const setPx = (x, y, r, g, b) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = (y * W + x) * 3;
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
  };

  // Crisp dark border so corners are unmistakable.
  for (let x = 0; x < W; x++) {
    for (let t = 0; t < 4; t++) {
      setPx(x, t, 40, 40, 40);
      setPx(x, H - 1 - t, 40, 40, 40);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let t = 0; t < 4; t++) {
      setPx(t, y, 40, 40, 40);
      setPx(W - 1 - t, y, 40, 40, 40);
    }
  }

  // Draw centered 6-character code.
  const scale = 11;
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const gap = 16;
  const totalW = code.length * glyphW + (code.length - 1) * gap;
  const startX = Math.floor((W - totalW) / 2);
  const startY = Math.floor((H - glyphH) / 2);

  for (let ci = 0; ci < code.length; ci++) {
    const ch = code[ci];
    const bitmap = FONT_5X7[ch];
    if (!bitmap) throw new Error(`Unsupported glyph: ${ch}`);
    const ox = startX + ci * (glyphW + gap);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (bitmap[row][col] === '1') {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPx(ox + col * scale + dx, startY + row * scale + dy, 0, 0, 0);
            }
          }
        }
      }
    }
  }

  // Draw corner geometric shape.
  const CORNERS = {
    'top-left': [88, 78],
    'top-right': [W - 88, 78],
    'bottom-left': [88, H - 78],
    'bottom-right': [W - 88, H - 78],
  };
  const center = CORNERS[corner];
  if (!center) throw new Error(`Unknown corner: ${corner}`);
  const [cx, cy] = center;
  const rad = 48;

  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      const dx = x - cx;
      const dy = y - cy;
      let inside = false;
      if (shape === 'circle') {
        inside = dx * dx + dy * dy <= rad * rad;
      } else if (shape === 'square') {
        inside = Math.abs(dx) <= rad && Math.abs(dy) <= rad;
      } else if (shape === 'triangle') {
        const progress = (y - (cy - rad)) / (2 * rad);
        inside = progress >= 0 && progress <= 1 && Math.abs(dx) <= rad * progress;
      } else {
        throw new Error(`Unknown shape: ${shape}`);
      }
      if (inside) setPx(x, y, rgb[0], rgb[1], rgb[2]);
    }
  }

  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    pixels.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function randomImageCode(length = 6) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += IMAGE_CODE_ALPHABET[bytes[i] % IMAGE_CODE_ALPHABET.length];
  }
  return out;
}

// ---------- Center owner HTTP client ----------

function createOwnerHttpClient(baseUrl, timeoutMs) {
  const cookies = new Map();
  let csrfToken = '';

  const absorbCookies = (headers) => {
    const rawList = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of rawList) {
      const pair = String(raw).split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies.set(pair.slice(0, eq).trim(), pair.trim());
      }
    }
  };

  const cookieHeader = () => Array.from(cookies.values()).join('; ');

  async function requestRaw(method, pathname, body, overrideTimeoutMs) {
    const headers = {};
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD') {
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(overrideTimeoutMs ?? timeoutMs),
    });
    absorbCookies(res.headers);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok && json && typeof json.csrfToken === 'string' && json.csrfToken) {
      csrfToken = json.csrfToken;
    }
    return { status: res.status, ok: res.ok, json };
  }

  async function request(method, pathname, body, overrideTimeoutMs) {
    const result = await requestRaw(method, pathname, body, overrideTimeoutMs);
    if (!result.ok) {
      const code = result.json?.error?.code ? ` ${result.json.error.code}` : '';
      const msg = result.json?.error?.message ? `: ${result.json.error.message}` : '';
      throw Object.assign(
        new Error(`Center HTTP ${method} ${pathname} failed (${result.status}${code})${msg}`),
        { status: result.status, code: result.json?.error?.code },
      );
    }
    return result.json;
  }

  return {
    request,
    requestRaw,
    async login(password) {
      await request('GET', '/api/session');
      const loginRes = await request('POST', '/api/session', { password });
      assert.equal(loginRes?.authenticated, true, 'owner login must authenticate');
      const verifyRes = await request('GET', '/api/session');
      assert.equal(verifyRes?.authenticated, true, 'owner session cookie must stay authenticated');
    },
  };
}

// ---------- Center sessions.json & filesystem inspection helpers ----------

function readDeviceSessions(sessionsPath, deviceId) {
  if (!existsSync(sessionsPath)) return [];
  const raw = readFileSync(sessionsPath, 'utf8');
  const parsed = JSON.parse(raw);
  const out = [];
  for (const [key, value] of Object.entries(parsed)) {
    let pair;
    try {
      pair = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== deviceId) continue;
    if (!value || typeof value !== 'object') continue;
    out.push({
      key,
      deviceId: pair[0],
      sessionId: pair[1],
      conversationId: value.conversationId,
      agentName: value.agentName,
    });
  }
  return out;
}

function findFilesByName(rootDir, fileName) {
  const found = [];
  if (!existsSync(rootDir)) return found;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) found.push(full);
    }
  }
  return found;
}

// ---------- Residual isolated agy process cleanup (strictly scoped to geminiDir) ----------

function cleanupResidualAgyProcesses(geminiDir) {
  const cleaned = [];
  if (!geminiDir) return cleaned;
  try {
    if (process.platform === 'win32') {
      const psScript = [
        '$marker = $env:PIBOT_E2E_GEMINI_MARKER',
        'if (-not $marker) { exit 0 }',
        '$selfPid = [int]$env:PIBOT_E2E_NODE_PID',
        '$procs = Get-CimInstance Win32_Process | Where-Object {',
        '  $_.CommandLine -and $_.ProcessId -ne $PID -and $_.ProcessId -ne $selfPid -and',
        '  $_.CommandLine.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0',
        '}',
        'foreach ($p in $procs) { Write-Output $p.ProcessId }',
      ].join('\n');
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
          env: {
            ...process.env,
            PIBOT_E2E_GEMINI_MARKER: geminiDir,
            PIBOT_E2E_NODE_PID: String(process.pid),
          },
        },
      );
      const pids = out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      for (const pid of pids) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 10_000,
            windowsHide: true,
          });
          cleaned.push(pid);
        } catch {
          // Process already exited.
        }
      }
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,args='], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const pids = [];
      for (const line of out.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const args = match[2];
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        if (args.includes(geminiDir)) pids.push(pid);
      }
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
          cleaned.push(pid);
        } catch {
          // Process already exited.
        }
      }
    }
  } catch {
    // Best-effort cleanup; never mask primary test outcome.
  }
  return cleaned;
}

// ---------- Host / Center polling & live observation helpers ----------

async function waitUntil(predicate, { timeoutMs, intervalMs = POLL_INTERVAL_MS, label }) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = '';
  while (Date.now() < deadline) {
    const res = await predicate();
    if (res && typeof res === 'object' && res.done === true) {
      return res.value;
    }
    if (res && typeof res === 'object' && typeof res.detail === 'string') {
      lastDetail = res.detail;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastDetail ? ` (${lastDetail})` : ''}`);
}

async function waitForHostSynced({
  ownerHttp,
  control,
  deviceId,
  botId,
  minRevision = 0,
  requireBotApplied = true,
  timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
  label = 'host runtime sync',
}) {
  return waitUntil(
    async () => {
      try {
        const [devices, runtimeStatus, serviceStatus] = await Promise.all([
          ownerHttp.request('GET', '/api/devices'),
          ownerHttp.request('GET', `/api/devices/${encodeURIComponent(deviceId)}/runtime-status`),
          control.getServiceStatus(),
        ]);
        const dev = Array.isArray(devices) ? devices.find((d) => d.deviceId === deviceId) : null;
        const botReceipt = Array.isArray(runtimeStatus?.bots)
          ? runtimeStatus.bots.find((b) => b.botId === botId)
          : null;
        const botOk = !requireBotApplied || (
          runtimeStatus?.status === 'applied' &&
          runtimeStatus.appliedRevision === runtimeStatus.desiredRevision &&
          botReceipt?.status === 'applied' &&
          botReceipt.appliedRevision === botReceipt.desiredRevision
        );
        const ready =
          dev?.online === true &&
          runtimeStatus?.online === true &&
          Number.isSafeInteger(runtimeStatus?.desiredRevision) &&
          runtimeStatus.desiredRevision >= minRevision &&
          botOk &&
          serviceStatus?.center?.state === 'ready' &&
          serviceStatus?.relay?.phase === 'online';
        if (ready) {
          return { done: true, value: { device: dev, runtimeStatus, serviceStatus } };
        }
        return {
          done: false,
          detail: `devOnline=${dev?.online} rtStatus=${runtimeStatus?.status} rtErr=${runtimeStatus?.error?.code ?? ''} desired=${runtimeStatus?.desiredRevision} applied=${runtimeStatus?.appliedRevision} botStatus=${botReceipt?.status} botErr=${botReceipt?.error?.code ?? ''} capErrs=${(runtimeStatus?.capabilityErrors ?? []).map((e) => e?.error?.code).filter(Boolean).join(',')} svcCenter=${serviceStatus?.center?.state} relay=${serviceStatus?.relay?.phase}`,
        };
      } catch (err) {
        return { done: false, detail: err?.message ?? String(err) };
      }
    },
    { timeoutMs, label },
  );
}

async function readAllHistory(control, botId) {
  const items = [];
  let cursor;
  let clearedThroughEntryId = 0;
  for (;;) {
    const page = await control.history(botId, { limit: 200, ...(cursor ? { cursor } : {}) });
    if (typeof page.clearedThroughEntryId === 'number') {
      clearedThroughEntryId = page.clearedThroughEntryId;
    }
    if (Array.isArray(page.items)) {
      items.push(...page.items);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { items, clearedThroughEntryId };
}

function lastEntryIdOf(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items[items.length - 1]?.id ?? 0;
}

function inspectEntries(items) {
  const assistantMessages = [];
  const toolCalls = [];
  const toolResults = [];
  const errorMessages = [];
  for (const entry of items) {
    for (const msg of entry?.model ?? []) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'assistant') {
        assistantMessages.push({
          entryId: entry.id,
          provider: msg.provider,
          api: msg.api,
          model: msg.model,
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage ?? null,
          content: msg.content,
        });
        if (msg.stopReason === 'error' || msg.errorMessage) {
          errorMessages.push(msg.errorMessage || `assistant stopReason=${msg.stopReason}`);
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === 'toolCall') {
              toolCalls.push({ entryId: entry.id, id: block.id, name: block.name });
            }
          }
        }
      } else if (msg.role === 'toolResult') {
        const imageBlocks = Array.isArray(msg.content)
          ? msg.content.filter((block) => block?.type === 'image' && typeof block.data === 'string' && block.data.length > 0).length
          : 0;
        toolResults.push({
          entryId: entry.id,
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          isError: msg.isError === true,
          imageBlocks,
        });
      }
    }
  }
  return { assistantMessages, toolCalls, toolResults, errorMessages };
}

async function waitForSubmissionTerminal(control, botId, requestId, timeoutMs, label) {
  return waitUntil(
    async () => {
      const sub = await control.getSubmission(botId, requestId);
      if (!sub) return { done: false, detail: 'submission not yet visible' };
      if (sub.status === 'done' || sub.status === 'unanswered') {
        return { done: true, value: sub };
      }
      if (sub.admission?.phase === 'failed') {
        const code = sub.admission.error?.code ?? 'TURN_SYNC_FAILED';
        const message = sub.admission.error?.message ?? 'turn admission failed';
        const nonRetryable = new Set([
          AGY_HISTORY_CHANGED,
          'MODEL_NO_VISION',
          'INVALID_ARGUMENT',
          'ATTACHMENT_NOT_FOUND',
        ]);
        if (nonRetryable.has(code)) {
          throw Object.assign(new Error(`Turn admission failed (${code}): ${message}`), { code });
        }
        return { done: false, detail: `admission failed (${code}): ${message}` };
      }
      return {
        done: false,
        detail: `status=${sub.status} admission=${sub.admission?.phase ?? 'none'}`,
      };
    },
    { timeoutMs, label },
  );
}

async function waitForBotIdle(control, botId, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('waitForBotIdle timeout')), timeoutMs);
  timer.unref?.();
  try {
    let state = null;
    for await (const frame of control.live(botId, { signal: ac.signal })) {
      if (frame.type === 'snapshot') state = { ...frame.state };
      else if (frame.type === 'update' && state) state = { ...state, ...frame.changes };
      else if (frame.type === 'end') break;
      if (state && state.busy === false && (state.queuedCount ?? 0) === 0) {
        return state;
      }
    }
    throw new Error('Live stream ended before bot became idle');
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

function startLiveConditionWaiter(control, botId, predicate, timeoutMs, label) {
  const ac = new AbortController();
  let timer = null;
  let lastState = null;

  const promise = (async () => {
    timer = setTimeout(() => {
      ac.abort(new Error(`Timed out after ${timeoutMs}ms waiting for live condition (${label})`));
    }, timeoutMs);
    timer.unref?.();
    let state = null;
    for await (const frame of control.live(botId, { signal: ac.signal })) {
      if (frame.type === 'snapshot') state = { ...frame.state };
      else if (frame.type === 'update' && state) state = { ...state, ...frame.changes };
      else if (frame.type === 'end') break;
      if (state) {
        lastState = state;
        const matched = predicate(state);
        if (matched) return { state, matched };
      }
    }
    throw new Error(`Live stream ended before condition matched (${label})`);
  })().finally(() => {
    if (timer) clearTimeout(timer);
    ac.abort();
  });

  return {
    promise,
    getLastState: () => lastState,
    cancel() {
      if (timer) clearTimeout(timer);
      ac.abort();
    },
  };
}

function pickTwoAgyModels(models, overrideA, overrideB) {
  const enabled = models.filter((m) => m && typeof m.id === 'string' && m.enabled !== false);
  const byId = new Map(enabled.map((m) => [m.id, m]));
  assert.ok(enabled.length >= 2, `Expected at least 2 enabled AGY models from discover, got ${enabled.length}`);

  let modelA = null;
  let modelB = null;
  if (overrideA) {
    modelA = byId.get(overrideA);
    assert.ok(modelA, `Requested modelA "${overrideA}" not found among discovered models: ${enabled.map((m) => m.id).join(', ')}`);
  }
  if (overrideB) {
    modelB = byId.get(overrideB);
    assert.ok(modelB, `Requested modelB "${overrideB}" not found among discovered models: ${enabled.map((m) => m.id).join(', ')}`);
  }

  const ordered = [
    ...PREFERRED_MODEL_ORDER.map((id) => byId.get(id)).filter(Boolean),
    ...enabled.filter((m) => !PREFERRED_MODEL_ORDER.includes(m.id)),
  ];

  if (!modelA) {
    modelA = ordered.find((m) => !modelB || m.id !== modelB.id);
  }
  if (!modelB) {
    modelB = ordered.find((m) => m.id !== modelA.id);
  }
  assert.ok(modelA && modelB && modelA.id !== modelB.id, 'Failed to pick two distinct AGY models');
  return { modelA, modelB };
}

function defaultThinkingLevelForModel(model) {
  if (!model?.reasoning) return null;
  const map = model.thinkingLevelMap;
  if (map && typeof map === 'object') {
    for (const tier of ['low', 'minimal', 'medium', 'high', 'xhigh', 'max']) {
      if (typeof map[tier] === 'string' && map[tier].length > 0) return tier;
    }
  }
  return 'low';
}

// ---------- Main E2E runner ----------

async function run() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printUsage();
    return;
  }

  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const turnTimeoutMs = parsePositiveInt(
    cli.timeoutMs ?? process.env.PIBOT_AGY_TIMEOUT_MS,
    'PIBOT_AGY_TIMEOUT_MS',
    DEFAULT_TURN_TIMEOUT_MS,
  );
  const agyBin = (cli.bin ?? process.env.PIBOT_AGY_BIN ?? 'agy').trim();
  assert.ok(agyBin.length > 0, 'agy binary path/name must not be empty');

  const e2eRoot = path.resolve(
    cli.root ?? process.env.PIBOT_AGY_E2E_ROOT ?? path.join(os.tmpdir(), `agy-e2e-${formatTimestamp()}`),
  );
  const centerDataDir = path.join(e2eRoot, 'center-data');
  const hostDataDir = path.join(e2eRoot, 'host-data');
  const workspaceDir = path.join(e2eRoot, 'workspace');
  const geminiDir = path.join(e2eRoot, 'gemini');
  const logsDir = path.join(e2eRoot, 'logs');
  const summaryPath = path.join(logsDir, 'summary.json');
  const runLogPath = path.join(logsDir, 'run.log');
  const sessionsPath = path.join(centerDataDir, 'antigravity', 'sessions.json');

  // Strict isolation check BEFORE creating/touching anything.
  assertIsolatedGeminiDir(geminiDir);
  for (const dir of [e2eRoot, centerDataDir, hostDataDir, workspaceDir, geminiDir, logsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Re-check with realpath now that geminiDir exists.
  assertIsolatedGeminiDir(geminiDir);

  // Strip inherited ANTIGRAVITY_*, ORCA_*, HINDSIGHT_*, and legacy recall env vars.
  const strippedEnvKeys = [];
  for (const key of Object.keys(process.env)) {
    if (STRIP_ENV_PATTERNS.some((re) => re.test(key)) || STRIP_EXACT_ENV_KEYS.includes(key)) {
      delete process.env[key];
      strippedEnvKeys.push(key);
    }
  }
  strippedEnvKeys.sort();
  process.env.PIBOT_AGY_HOME = geminiDir;
  process.env.PIBOT_AGY_BIN = agyBin;
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = '1';

  const redactor = createRedactor();
  const logLine = (msg) => {
    const safe = redactor.redactString(msg);
    const line = `[${new Date().toISOString()}] ${safe}`;
    console.log(line);
    try {
      writeFileSync(runLogPath, line + '\n', { flag: 'a' });
    } catch {
      /* best effort log file */
    }
  };

  const summary = {
    startedAt: startedAtIso,
    finishedAt: null,
    durationMs: 0,
    ok: false,
    e2eRoot,
    centerDataDir,
    hostDataDir,
    workspaceDir,
    geminiDir,
    sessionsPath,
    agyBin,
    nodeVersion: process.version,
    platform: process.platform,
    turnTimeoutMs,
    strippedEnvKeys,
    models: { discoveredCount: 0, discoveredIds: [], modelA: null, modelB: null },
    deviceId: null,
    botId: null,
    sessionsEvidence: {
      sessionId1: null,
      convId1: null,
      agentName1: null,
      sessionId2: null,
      convId2: null,
      agentName2: null,
    },
    scenarios: [],
    cleanup: {
      hostServiceClosed: false,
      hostClosed: false,
      centerClosed: false,
      tlsProxyClosed: false,
      residualAgyCleaned: [],
      errors: [],
    },
    error: null,
  };

  const writeSummary = () => {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAtMs;
    writeFileSync(summaryPath, JSON.stringify(redactor.redactValue(summary), null, 2) + '\n', 'utf8');
  };

  let tlsProxy = null;
  let center = null;
  let host = null;
  let hostService = null;
  let control = null;
  let activeScenarioName = 'bootstrap';
  let primaryError = null;

  const runScenario = async (id, name, fn) => {
    activeScenarioName = `Scenario ${id}: ${name}`;
    const sStart = Date.now();
    const record = {
      id,
      name,
      status: 'running',
      durationMs: 0,
      assertions: [],
      details: {},
    };
    summary.scenarios.push(record);
    logLine(`=== [SCENARIO ${id}/8] ${name} ===`);
    const assertRecord = (label, checkFn) => {
      checkFn();
      record.assertions.push({ label, passed: true });
    };
    try {
      const details = await fn({ assertRecord, record });
      record.details = details ?? {};
      record.status = 'passed';
      record.durationMs = Date.now() - sStart;
      logLine(`[PASS ${id}/8] ${name} (${record.durationMs}ms)`);
      writeSummary();
    } catch (err) {
      record.status = 'failed';
      record.durationMs = Date.now() - sStart;
      record.error = {
        code: err?.code ?? null,
        message: redactor.redactString(err?.message ?? String(err)),
      };
      writeSummary();
      throw err;
    }
  };

  logLine(`[INIT] e2eRoot=${e2eRoot} agyBin=${agyBin} turnTimeoutMs=${turnTimeoutMs}`);
  logLine(`[INIT] isolated geminiDir=${geminiDir} strippedEnvKeys=${strippedEnvKeys.length}`);

  try {
    // --- Bootstrap Center (with loopback TLS reverse proxy) + Host + HostService ---
    const { certPem, keyPem } = generateSelfSignedLoopbackCert();
    tlsProxy = await createTlsReverseProxy({ cert: certPem, key: keyPem });
    const publicUrl = tlsProxy.publicUrl;

    const encryptionKey = randomBytes(32);
    const sessionKey = randomBytes(32);
    const ownerPassword = randomBytes(24).toString('base64url');
    const ownerPasswordHash = hashOwnerPassword(ownerPassword);
    const deviceToken = randomBytes(32).toString('base64url');
    const controlToken = randomBytes(32).toString('base64url');
    redactor.addSecret(ownerPassword);
    redactor.addSecret(deviceToken);
    redactor.addSecret(controlToken);

    const startCenter = async () => {
      const srv = await openCenterServer({
        dataRoot: centerDataDir,
        encryptionKey,
        sessionKey,
        ownerPasswordHash,
        listenHost: '127.0.0.1',
        port: 0,
        publicUrl,
      });
      tlsProxy.setTarget(Number(new URL(srv.url).port));
      const httpClient = createOwnerHttpClient(srv.url, DEFAULT_HTTP_TIMEOUT_MS);
      await httpClient.login(ownerPassword);
      return { srv, httpClient };
    };

    const started = await startCenter();
    center = started.srv;
    let ownerHttp = started.httpClient;
    logLine(`[INIT] Center ready (proxy=${publicUrl})`);

    // Create local Host identity & primary Bot bound to isolated workspaceDir,
    // then close the probe handle immediately (matching openHostService) so only
    // openHostService owns the SQLite connection during the run.
    let deviceId;
    let botId;
    host = openHost({ dataRoot: hostDataDir });
    try {
      deviceId = host.deviceId;
      summary.deviceId = deviceId;
      const bot = host.createBot({
        requestId: `e2e-bot-${randomUUID()}`,
        role: 'AGY Native Turn E2E Bot',
        cwd: workspaceDir,
        makePrimary: true,
      });
      botId = bot.botId;
      summary.botId = botId;
    } finally {
      host.close();
      host = null;
      summary.cleanup.hostClosed = true;
    }
    logLine(`[INIT] Local Host created: deviceId=${deviceId} botId=${botId}`);

    const devicePlatform =
      process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'macos'
          : 'linux';

    // Register Host device with Center using pre-generated deviceToken.
    const registered = await ownerHttp.request('POST', '/api/devices', {
      displayName: 'AGY Native Turn E2E Host',
      platform: devicePlatform,
      deviceId,
      deviceToken,
    });
    assert.equal(registered?.deviceId, deviceId, 'POST /api/devices must register our exact deviceId');

    // Helper: set Bot model config via Center Owner HTTP API and wait for Host to apply.
    const assignBotModel = async (model, label) => {
      const beforeRt = await ownerHttp.request(
        'GET',
        `/api/devices/${encodeURIComponent(deviceId)}/runtime-status`,
      );
      const currentCfg = await ownerHttp.request(
        'GET',
        `/api/devices/${encodeURIComponent(deviceId)}/bots/${encodeURIComponent(botId)}/model-config`,
      );
      const modelRef = `${ANTIGRAVITY_PROVIDER_ID}/${model.id}`;
      const thinkingLevel = defaultThinkingLevelForModel(model);
      const putRes = await ownerHttp.requestRaw(
        'PUT',
        `/api/devices/${encodeURIComponent(deviceId)}/bots/${encodeURIComponent(botId)}/model-config`,
        {
          expectedRevision: currentCfg.revision,
          value: {
            modelRef,
            thinkingLevel,
            codemode: true,
            codemodeOnly: true,
          },
        },
      );
      assert.equal(
        putRes.status,
        200,
        `PUT model-config (${label}) must succeed with HTTP 200, got ${putRes.status} (${putRes.json?.error?.code ?? 'no-code'}: ${putRes.json?.error?.message ?? ''})`,
      );
      assert.equal(putRes.json?.effective?.modelRef, modelRef, 'effective.modelRef must match requested model');
      const minRev = (beforeRt?.desiredRevision ?? 0) + 1;
      await waitForHostSynced({
        ownerHttp,
        control,
        deviceId,
        botId,
        minRevision: minRev,
        timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
        label: `apply model ${model.id}`,
      });
      return { modelRef, thinkingLevel, revision: putRes.json.revision };
    };

    // Helper: submit a normal turn and assert completion + clean history.
    const runTurn = async ({ tag, text, expectSuccess = true }) => {
      const beforeHistory = await readAllHistory(control, botId);
      const beforeLastId = lastEntryIdOf(beforeHistory.items);
      const requestId = `e2e-${tag}-${randomUUID().slice(0, 8)}`;
      const t0 = Date.now();
      await control.submit(botId, { requestId, text });
      const sub = await waitForSubmissionTerminal(control, botId, requestId, turnTimeoutMs, `turn ${tag}`);
      const afterHistory = await readAllHistory(control, botId);
      const newEntries = afterHistory.items.filter((e) => e.id > beforeLastId);
      const inspected = inspectEntries(newEntries);
      if (expectSuccess) {
        assert.equal(
          sub.status,
          'done',
          `Turn ${tag} expected status=done, got status=${sub.status} reason=${sub.reason ?? 'none'} errors=${JSON.stringify(inspected.errorMessages)}`,
        );
        assert.equal(
          inspected.errorMessages.some((m) => m.includes(AGY_HISTORY_CHANGED)),
          false,
          `Turn ${tag} unexpectedly triggered ${AGY_HISTORY_CHANGED}: ${inspected.errorMessages.join('; ')}`,
        );
      }
      return {
        requestId,
        sub,
        answerText: sub.answerText ?? '',
        durationMs: Date.now() - t0,
        newEntries,
        inspected,
      };
    };

    const resolveNpmCliPath = () => {
      const nodeDir = path.dirname(process.execPath);
      const candidates = [
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ];
      return candidates.find((p) => existsSync(p));
    };
    const npmCliPath = resolveNpmCliPath();

    // Start real openHostService connected to our isolated Center via loopback TLS proxy.
    hostService = await openHostService({
      dataRoot: hostDataDir,
      token: controlToken,
      port: 0,
      displayName: 'AGY Native Turn E2E Host',
      platform: devicePlatform,
      nativeBridge: () => Promise.resolve({ ok: true }),
      ...(npmCliPath ? { npmPath: npmCliPath } : {}),
      center: {
        url: publicUrl,
        deviceToken,
        ca: certPem,
      },
    });
    control = createControlClient({ url: hostService.url, token: controlToken });
    await waitForHostSynced({
      ownerHttp,
      control,
      deviceId,
      botId,
      minRevision: 0,
      requireBotApplied: false,
      timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
      label: 'initial HostService online sync',
    });
    logLine(`[INIT] HostService online & synced (control=${hostService.url})`);

    // Shared E2E state across the 8 sequential scenarios.
    const secretCode = `SECRET-${randomBytes(4).toString('hex').toUpperCase()}`;
    const textCode = `TXT-${randomBytes(4).toString('hex').toUpperCase()}`;
    const imageCode = randomImageCode(6);
    let modelA = null;
    let modelB = null;
    let sessionId1 = null;
    let convId1 = null;
    let agentName1 = null;

    // =========================================================================
    // Scenario 1: Catalog discovery + multi-turn conversation without rebuild
    // =========================================================================
    await runScenario(1, 'Catalog discovery and multi-turn conversation without session rebuild', async ({ assertRecord }) => {
      let authStatus = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const tAuth = Date.now();
        authStatus = await ownerHttp.request('GET', `/api/providers/${ANTIGRAVITY_PROVIDER_ID}/auth-status`);
        if (authStatus?.method === 'oauth') break;
        const elapsed = Date.now() - tAuth;
        // provider-auth.js applies a 10s per-request timeout while probeAcpAuth remains in-flight
        // and populates the cache; retry if the first cold-start check appeared to hit that timeout.
        if (elapsed < 8500 || attempt === 3) break;
        logLine(`[SCENARIO 1] auth-status cold-start check took ${elapsed}ms; retrying (${attempt}/3)...`);
        await sleep(2000);
      }
      assertRecord('auth-status oauth precondition', () => {
        assert.equal(authStatus?.providerId, ANTIGRAVITY_PROVIDER_ID);
        assert.equal(authStatus?.oauth, true);
        assert.equal(
          authStatus?.method,
          'oauth',
          `Antigravity CLI auth not detected (method=${authStatus?.method ?? 'none'}). Complete CLI login first.`,
        );
      });

      const discovered = await ownerHttp.request(
        'POST',
        `/api/providers/${ANTIGRAVITY_PROVIDER_ID}/discover`,
        {},
        Math.max(DEFAULT_HTTP_TIMEOUT_MS, turnTimeoutMs),
      );
      assertRecord('discover returned >= 2 models', () => {
        assert.ok(Array.isArray(discovered?.models) && discovered.models.length >= 2, 'discover must return >= 2 AGY models');
      });

      const picked = pickTwoAgyModels(
        discovered.models,
        (cli.modelA ?? process.env.PIBOT_AGY_MODEL_A?.trim()) || undefined,
        (cli.modelB ?? process.env.PIBOT_AGY_MODEL_B?.trim()) || undefined,
      );
      modelA = picked.modelA;
      modelB = picked.modelB;
      summary.models = {
        discoveredCount: discovered.models.length,
        discoveredIds: discovered.models.map((m) => m.id),
        modelA: modelA.id,
        modelB: modelB.id,
      };
      logLine(`[SCENARIO 1] Discovered ${discovered.models.length} models; selected modelA=${modelA.id}, modelB=${modelB.id}`);

      // Enable antigravity-acp provider on Center.
      const providerBefore = await ownerHttp.request('GET', `/api/providers/${ANTIGRAVITY_PROVIDER_ID}`);
      if (!providerBefore.enabled || !providerBefore.configured) {
        await ownerHttp.request('PUT', `/api/providers/${ANTIGRAVITY_PROVIDER_ID}`, {
          expectedRevision: providerBefore.revision,
          value: {
            name: providerBefore.name,
            api: providerBefore.api,
            baseUrl: providerBefore.baseUrl ?? '',
            credentialRef: providerBefore.credentialRef ?? null,
            enabled: true,
            configured: true,
            ...(providerBefore.native !== undefined ? { native: providerBefore.native } : {}),
            ...(providerBefore.custom !== undefined ? { custom: providerBefore.custom } : {}),
          },
        });
      }

      await assignBotModel(modelA, 'initial modelA');

      // Turn 1: memorize random secretCode.
      const turn1 = await runTurn({
        tag: 't1-secret',
        text: `Remember this exact secret code for later in our conversation: ${secretCode}\nDo not call any tools. Reply briefly confirming you have memorized it.`,
      });
      assertRecord('Turn 1 replied cleanly', () => {
        assert.ok(turn1.answerText.trim().length > 0, 'Turn 1 must return a non-empty reply');
      });

      const sessionsAfterT1 = readDeviceSessions(sessionsPath, deviceId);
      assertRecord('Turn 1 persisted convId1 and agentName1 in sessions.json', () => {
        assert.equal(sessionsAfterT1.length, 1, `Expected 1 session in sessions.json after Turn 1, got ${sessionsAfterT1.length}`);
        assert.ok(typeof sessionsAfterT1[0].conversationId === 'string' && sessionsAfterT1[0].conversationId.length > 0);
        assert.ok(typeof sessionsAfterT1[0].agentName === 'string' && sessionsAfterT1[0].agentName.length > 0);
      });
      sessionId1 = sessionsAfterT1[0].sessionId;
      convId1 = sessionsAfterT1[0].conversationId;
      agentName1 = sessionsAfterT1[0].agentName;
      summary.sessionsEvidence.sessionId1 = sessionId1;
      summary.sessionsEvidence.convId1 = convId1;
      summary.sessionsEvidence.agentName1 = agentName1;

      const agentMdPath = path.join(geminiDir, 'config', 'agents', agentName1, 'agent.md');
      assertRecord('Per-session custom agent.md created without recall-hooks.json', () => {
        assert.equal(existsSync(agentMdPath), true, `Expected custom agent file at ${agentMdPath}`);
        assert.equal(findFilesByName(geminiDir, 'recall-hooks.json').length, 0, 'No recall-hooks.json should exist');
      });

      // Turn 2: recall secretCode on same session.
      const turn2 = await runTurn({
        tag: 't2-recall',
        text: 'What was the exact secret code I asked you to remember in the previous message? Reply with the exact code only. Do not call any tools.',
      });
      const sessionsAfterT2 = readDeviceSessions(sessionsPath, deviceId);
      assertRecord('Turn 2 accurately recalled secretCode on same convId1', () => {
        assert.ok(
          turn2.answerText.toUpperCase().includes(secretCode),
          `Turn 2 reply did not contain ${secretCode}; got: ${turn2.answerText.slice(0, 200)}`,
        );
        assert.equal(sessionsAfterT2.length, 1, 'Turn 2 must not create an extra session');
        assert.equal(sessionsAfterT2[0].conversationId, convId1, 'Turn 2 must keep the same convId1');
        assert.equal(sessionsAfterT2[0].agentName, agentName1, 'Turn 2 must keep the same agentName1');
      });

      return {
        modelA: modelA.id,
        modelB: modelB.id,
        convId1,
        agentName1,
        turn1DurationMs: turn1.durationMs,
        turn2DurationMs: turn2.durationMs,
        turn2Preview: turn2.answerText.slice(0, 160),
      };
    });

    // =========================================================================
    // Scenario 2: Dynamic section / SOUL change without session rebuild
    // =========================================================================
    await runScenario(2, 'Dynamic section (SOUL) update without session rebuild', async ({ assertRecord }) => {
      await waitForBotIdle(control, botId);
      const soul = await control.getBotSoul(botId);
      const nextSoulText = [
        soul.text.trimEnd(),
        '',
        '## Dynamic Session Directive',
        'From now on, prefix your replies with the exact marker `[S2]` whenever appropriate.',
        '',
      ].join('\n');
      const updatedSoul = await control.setBotSoul(botId, {
        expectedRevision: soul.revision,
        text: nextSoulText,
      });
      assertRecord('setBotSoul applied cleanly', () => {
        assert.equal(updatedSoul?.status, 'applied', `Expected setBotSoul status=applied, got ${updatedSoul?.status}`);
      });

      const turn3 = await runTurn({
        tag: 't3-soul-delta',
        text: 'Acknowledge the updated instructions briefly and include the new marker if requested. Do not call any tools.',
      });
      const sessionsAfterT3 = readDeviceSessions(sessionsPath, deviceId);
      assertRecord('Turn 3 succeeded without AGY_HISTORY_CHANGED and kept convId1', () => {
        assert.ok(turn3.answerText.trim().length > 0, 'Turn 3 must return a non-empty reply');
        assert.equal(sessionsAfterT3.length, 1, 'SOUL update must not create a new session');
        assert.equal(sessionsAfterT3[0].conversationId, convId1, 'SOUL update must keep convId1');
        assert.equal(sessionsAfterT3[0].agentName, agentName1, 'SOUL update must keep agentName1');
      });

      return {
        convId: sessionsAfterT3[0].conversationId,
        markerS2Observed: turn3.answerText.includes('[S2]'),
        turn3DurationMs: turn3.durationMs,
        turn3Preview: turn3.answerText.slice(0, 160),
      };
    });

    // =========================================================================
    // Scenario 3: Tool call + tool image (standard MCP image block, no recall-hook)
    // =========================================================================
    await runScenario(3, 'Host ToolTask (codemode read) and tool image via standard MCP image block', async ({ assertRecord }) => {
      const textFileName = 'probe-note.txt';
      const imageFileName = 'probe-code.png';
      const textFilePath = path.join(workspaceDir, textFileName);
      const imageFilePath = path.join(workspaceDir, imageFileName);

      writeFileSync(textFilePath, `PiBot E2E Verification Token: ${textCode}\n`, 'utf8');
      const pngBytes = generateTestPng({
        code: imageCode,
        shape: 'circle',
        colorName: 'red',
        corner: 'bottom-right',
      });
      writeFileSync(imageFilePath, pngBytes);
      writeFileSync(path.join(logsDir, imageFileName), pngBytes);

      const turn4 = await runTurn({
        tag: 't4-tool-image',
        text: [
          'Use the codemode tool with tools.read to read BOTH of these files in your workspace:',
          `1. ${textFileName}`,
          `2. ${imageFileName} (pass the image block returned by tools.read to image(...) in codemode so you can view the PNG directly)`,
          'Reply with ONLY these two lines:',
          'TEXT_CODE: <exact TXT-... token from the text file>',
          'IMAGE_CODE: <exact 6-character code in the center of the PNG image>',
          'Do NOT mention any geometric shape, color, or corner from the image yet.',
        ].join('\n'),
      });

      const sessionsAfterT4 = readDeviceSessions(sessionsPath, deviceId);
      const recallHooks = findFilesByName(geminiDir, 'recall-hooks.json');
      const totalImageBlocks = turn4.inspected.toolResults.reduce((acc, r) => acc + (r.imageBlocks ?? 0), 0);
      assertRecord('Real codemode ToolTask executed on Host and returned standard image block', () => {
        assert.ok(
          turn4.inspected.toolCalls.some((c) => c.name === 'codemode'),
          `Expected codemode toolCall in Turn 4 history, saw: ${JSON.stringify(turn4.inspected.toolCalls)}`,
        );
        assert.ok(
          turn4.inspected.toolResults.some((r) => r.toolName === 'codemode' && r.isError === false),
          `Expected successful codemode toolResult in Turn 4 history, saw: ${JSON.stringify(turn4.inspected.toolResults)}`,
        );
        assert.ok(
          turn4.inspected.toolResults.some((r) => r.toolName === 'codemode' && r.isError === false && r.imageBlocks > 0),
          `Expected codemode toolResult to contain a standard image block, saw: ${JSON.stringify(turn4.inspected.toolResults)}`,
        );
      });
      assertRecord('Model accurately read both textCode and 6-char PNG imageCode without recall-hook', () => {
        assert.ok(
          turn4.answerText.toUpperCase().includes(textCode),
          `Turn 4 reply missing textCode ${textCode}; got: ${turn4.answerText.slice(0, 240)}`,
        );
        assert.ok(
          turn4.answerText.toUpperCase().includes(imageCode),
          `Turn 4 reply missing imageCode ${imageCode}; got: ${turn4.answerText.slice(0, 240)}`,
        );
        assert.equal(recallHooks.length, 0, `Unexpected recall-hooks.json files found: ${recallHooks.join(', ')}`);
      });
      assertRecord('Turn 4 kept same convId1', () => {
        assert.equal(sessionsAfterT4.length, 1);
        assert.equal(sessionsAfterT4[0].conversationId, convId1);
      });

      return {
        textCode,
        imageCode,
        pngBytes: pngBytes.length,
        toolCalls: turn4.inspected.toolCalls.length,
        toolResults: turn4.inspected.toolResults.length,
        toolImageBlocks: totalImageBlocks,
        convId: sessionsAfterT4[0].conversationId,
        turn4DurationMs: turn4.durationMs,
        turn4Preview: turn4.answerText.slice(0, 200),
      };
    });

    // =========================================================================
    // Scenario 4: Center restart + cold `session/resume`
    // =========================================================================
    await runScenario(4, 'Center restart and cold session/resume', async ({ assertRecord }) => {
      await waitForBotIdle(control, botId);

      // Tear down Center completely and kill any warm agy processes.
      tlsProxy.setTarget(null);
      await center.close();
      center = null;
      const cleanedAfterClose = cleanupResidualAgyProcesses(geminiDir);
      logLine(`[SCENARIO 4] Center closed (residual agy cleaned: ${cleanedAfterClose.length}); restarting on same center-data`);

      // Wait briefly so HostService observes disconnect cleanly before restart.
      await sleep(800);

      // Restart Center pointing at the exact same centerDataDir.
      const restarted = await startCenter();
      center = restarted.srv;
      ownerHttp = restarted.httpClient;

      await waitForHostSynced({
        ownerHttp,
        control,
        deviceId,
        botId,
        minRevision: 0,
        timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
        label: 'HostService reconnect after Center restart',
      });
      logLine('[SCENARIO 4] HostService reconnected online to restarted Center');

      const turn5 = await runTurn({
        tag: 't5-cold-resume',
        text: [
          'Without calling any tools, answer both questions from our earlier conversation:',
          '1. What was the exact SECRET-... code from the very beginning?',
          '2. In the PNG image you read earlier, what colored geometric shape appeared in one of the corners (mention its color, shape, and corner)?',
        ].join('\n'),
      });

      const sessionsAfterT5 = readDeviceSessions(sessionsPath, deviceId);
      const sawColor = /\bred\b|红/i.test(turn5.answerText);
      const sawShape = /\bcircle\b|\bdot\b|圆/i.test(turn5.answerText);
      assertRecord('Cold session/resume preserved secretCode, image memory, and convId1', () => {
        assert.ok(
          turn5.answerText.toUpperCase().includes(secretCode),
          `Turn 5 reply missing ${secretCode} after cold resume; got: ${turn5.answerText.slice(0, 240)}`,
        );
        assert.ok(
          sawColor && sawShape,
          `Turn 5 reply did not identify the red circle from the earlier PNG (sawColor=${sawColor}, sawShape=${sawShape}); got: ${turn5.answerText.slice(0, 240)}`,
        );
        assert.equal(sessionsAfterT5.length, 1);
        assert.equal(sessionsAfterT5[0].conversationId, convId1, 'Cold resume must keep convId1');
        assert.equal(sessionsAfterT5[0].agentName, agentName1, 'Cold resume must keep agentName1');
      });

      return {
        cleanedAfterClose,
        convId: sessionsAfterT5[0].conversationId,
        sawColor,
        sawShape,
        turn5DurationMs: turn5.durationMs,
        turn5Preview: turn5.answerText.slice(0, 200),
      };
    });

    // =========================================================================
    // Scenario 5: In-session AGY model switch (`set_config_option`, no /clear)
    // =========================================================================
    await runScenario(5, 'In-session AGY model switch without /clear', async ({ assertRecord }) => {
      await waitForBotIdle(control, botId);

      const switched = await assignBotModel(modelB, `switch ${modelA.id} -> ${modelB.id}`);
      assertRecord('PUT model-config switched modelA -> modelB without 409 / AGY_HISTORY_CHANGED', () => {
        assert.equal(switched.modelRef, `${ANTIGRAVITY_PROVIDER_ID}/${modelB.id}`);
      });

      const turn6 = await runTurn({
        tag: 't6-model-switch',
        text: 'Repeat the exact SECRET-... code from the beginning of this conversation. Do not call any tools.',
      });
      const sessionsAfterT6 = readDeviceSessions(sessionsPath, deviceId);
      const usedModels = turn6.inspected.assistantMessages.map((m) => m.model);
      assertRecord('Turn 6 responded using modelB, remembered secretCode, and kept convId1', () => {
        assert.ok(
          turn6.answerText.toUpperCase().includes(secretCode),
          `Turn 6 reply missing ${secretCode}; got: ${turn6.answerText.slice(0, 200)}`,
        );
        assert.ok(
          turn6.inspected.assistantMessages.some(
            (m) => m.provider === ANTIGRAVITY_PROVIDER_ID && m.model === modelB.id,
          ),
          `Expected Turn 6 assistant message to record model=${modelB.id}, got: ${JSON.stringify(usedModels)}`,
        );
        assert.equal(sessionsAfterT6.length, 1);
        assert.equal(sessionsAfterT6[0].conversationId, convId1, 'Model switch must keep convId1');
      });

      return {
        fromModel: modelA.id,
        toModel: modelB.id,
        recordedModels: usedModels,
        convId: sessionsAfterT6[0].conversationId,
        turn6DurationMs: turn6.durationMs,
        turn6Preview: turn6.answerText.slice(0, 160),
      };
    });

    // =========================================================================
    // Scenario 6: Stop (`abort`) mid-turn and continue on same session
    // =========================================================================
    await runScenario(6, 'Stop mid-turn and continue on the same session', async ({ assertRecord }) => {
      await waitForBotIdle(control, botId);

      const req7 = `e2e-t7-stop-${randomUUID().slice(0, 8)}`;
      const activeWaiter = startLiveConditionWaiter(
        control,
        botId,
        (state) => {
          if (Array.isArray(state.tools) && state.tools.some((t) => t.status === 'pending' || t.status === 'running')) {
            return 'tool-active';
          }
          if ((state.generation?.text?.length ?? 0) >= 80) {
            return 'text-streaming';
          }
          if (
            Array.isArray(state.generation?.blocks) &&
            state.generation.blocks.some((b) => b?.type === 'thinking' && (b.text?.length ?? 0) >= 120)
          ) {
            return 'thinking-streaming';
          }
          return false;
        },
        turnTimeoutMs,
        'Turn 7 active tool or streaming output before Stop',
      );
      let triggerKind = 'unknown';
      try {
        await control.submit(botId, {
          requestId: req7,
          text: [
            'Use codemode to run `await tools.bash({ command: "sleep 25 && echo DONE_SLEEP_7" })` and return its output.',
            'Wait for the command to finish and then report its output.',
            'If bash is unavailable, write a continuous 2000-word numbered list from line 1 to line 400.',
          ].join('\n'),
        });

        const observed = await activeWaiter.promise;
        triggerKind = observed.matched;
        // Let the tool call / stream stay firmly in-flight before calling Stop.
        await sleep(triggerKind === 'tool-active' ? 1500 : 500);
        await control.abort(botId);
      } finally {
        activeWaiter.cancel();
      }

      const sub7 = await waitForSubmissionTerminal(control, botId, req7, turnTimeoutMs, 'Turn 7 abort terminal');
      await waitForBotIdle(control, botId, 30_000);
      const sessionsAfterT7 = readDeviceSessions(sessionsPath, deviceId);
      assertRecord('Turn 7 aborted cleanly and preserved convId1 in sessions.json', () => {
        assert.equal(
          sub7.status,
          'unanswered',
          `Expected Turn 7 status=unanswered after Stop, got status=${sub7.status} reason=${sub7.reason ?? 'none'}`,
        );
        assert.equal(sessionsAfterT7.length, 1, 'Stop must not delete session binding');
        assert.equal(sessionsAfterT7[0].conversationId, convId1, 'Stop must keep convId1 intact');
      });

      // Turn 8: continue normally on the exact same session.
      const turn8 = await runTurn({
        tag: 't8-after-stop',
        text: 'The previous turn was stopped. Confirm we can continue normally in this session and repeat the exact SECRET-... code. Do not call any tools.',
      });
      const sessionsAfterT8 = readDeviceSessions(sessionsPath, deviceId);
      assertRecord('Turn 8 recovered cleanly on same convId1 and remembered secretCode', () => {
        assert.ok(
          turn8.answerText.toUpperCase().includes(secretCode),
          `Turn 8 reply missing ${secretCode}; got: ${turn8.answerText.slice(0, 200)}`,
        );
        assert.equal(sessionsAfterT8.length, 1);
        assert.equal(sessionsAfterT8[0].conversationId, convId1, 'Post-stop continuation must keep convId1');
      });

      return {
        abortTriggerKind: triggerKind,
        turn7Status: sub7.status,
        turn7Reason: sub7.reason ?? null,
        convId: sessionsAfterT8[0].conversationId,
        turn8DurationMs: turn8.durationMs,
        turn8Preview: turn8.answerText.slice(0, 160),
      };
    });

    // =========================================================================
    // Scenario 7: Mid-turn `steer` while tool is running
    // =========================================================================
    await runScenario(7, 'Mid-turn steer during active tool execution', async ({ assertRecord }) => {
      await waitForBotIdle(control, botId);

      const steerFileMarker = `STEER_DATA_${randomBytes(3).toString('hex').toUpperCase()}`;
      writeFileSync(path.join(workspaceDir, 'steer-marker.txt'), `${steerFileMarker}\n`, 'utf8');

      const beforeHistory = await readAllHistory(control, botId);
      const beforeLastId = lastEntryIdOf(beforeHistory.items);

      const req9 = `e2e-t9-base-${randomUUID().slice(0, 8)}`;
      const req9Steer = `e2e-t9-steer-${randomUUID().slice(0, 8)}`;
      const toolWaiter = startLiveConditionWaiter(
        control,
        botId,
        (state) => (Array.isArray(state.tools) && state.tools.some((t) => t.status === 'pending' || t.status === 'running')
          ? 'tool-running'
          : false),
        turnTimeoutMs,
        'Turn 9 tool running before steer',
      );
      const t9Start = Date.now();
      try {
        await control.submit(botId, {
          requestId: req9,
          text: [
            'Use codemode to run `await tools.bash({ command: "sleep 12 && cat steer-marker.txt" })` and return its output.',
            'After the command finishes, reply with the exact text printed by the command.',
          ].join('\n'),
        });

        await toolWaiter.promise;
        // Brief settle so ToolTask + Center MCP tools/call are actively parked.
        await sleep(1500);
        await control.submit(botId, {
          requestId: req9Steer,
          text: 'Additional instruction for this running turn: at the very end of your final answer, you MUST append the exact uppercase word BANANA_STEER.',
          delivery: 'steer',
        });
        logLine(`[SCENARIO 7] Submitted mid-turn steer (${req9Steer}) while tool was running`);
      } finally {
        toolWaiter.cancel();
      }

      const [sub9, sub9Steer] = await Promise.all([
        waitForSubmissionTerminal(control, botId, req9, turnTimeoutMs, 'Turn 9 base submission'),
        waitForSubmissionTerminal(control, botId, req9Steer, turnTimeoutMs, 'Turn 9 steer submission'),
      ]);
      const afterHistory = await readAllHistory(control, botId);
      const newEntries = afterHistory.items.filter((e) => e.id > beforeLastId);
      const inspected = inspectEntries(newEntries);
      const sessionsAfterT9 = readDeviceSessions(sessionsPath, deviceId);

      assertRecord('Both original submission and steer settled done with BANANA_STEER on same convId1', () => {
        assert.equal(sub9.status, 'done', `Turn 9 base expected done, got ${sub9.status} (${sub9.reason ?? ''})`);
        assert.equal(sub9Steer.status, 'done', `Turn 9 steer expected done, got ${sub9Steer.status} (${sub9Steer.reason ?? ''})`);
        assert.equal(
          inspected.errorMessages.some((m) => m.includes(AGY_HISTORY_CHANGED)),
          false,
          `Turn 9 triggered ${AGY_HISTORY_CHANGED}`,
        );
        const combinedAnswer = sub9.answerText ?? '';
        const steerAnswer = sub9Steer.answerText ?? '';
        assert.ok(
          combinedAnswer.includes('BANANA_STEER') && steerAnswer.includes('BANANA_STEER'),
          `Expected BANANA_STEER in steered reply; base="${combinedAnswer.slice(0, 200)}" steer="${steerAnswer.slice(0, 200)}"`,
        );
        assert.equal(sessionsAfterT9.length, 1);
        assert.equal(sessionsAfterT9[0].conversationId, convId1, 'Steer must keep convId1');
      });

      return {
        steerFileMarker,
        sawSteerFileMarker: (sub9.answerText ?? '').includes(steerFileMarker),
        sameFinalAnswer: sub9.answerText === sub9Steer.answerText,
        convId: sessionsAfterT9[0].conversationId,
        durationMs: Date.now() - t9Start,
        answerPreview: (sub9.answerText ?? '').slice(0, 200),
      };
    });

    // =========================================================================
    // Scenario 8: `/clear` creates a fresh native session (`convId2 !== convId1`)
    // =========================================================================
    await runScenario(8, '/clear creates a fresh native conversationId', async ({ assertRecord }) => {
      await waitForBotIdle(control, botId);

      const cleared = await control.clearHistory(botId);
      assertRecord('clearHistory committed a reset boundary', () => {
        assert.ok(
          Number.isSafeInteger(cleared?.clearedThroughEntryId) && cleared.clearedThroughEntryId > 0,
          `Expected positive clearedThroughEntryId, got ${cleared?.clearedThroughEntryId}`,
        );
      });

      const turn10 = await runTurn({
        tag: 't10-after-clear',
        text: 'This is a brand new session after /clear. Reply briefly with the exact word FRESH_OK. Do not call any tools.',
      });
      const sessionsAfterT10 = readDeviceSessions(sessionsPath, deviceId);
      const newSessions = sessionsAfterT10.filter((s) => s.sessionId !== sessionId1);

      assertRecord('Turn 10 succeeded and persisted a new convId2 !== convId1', () => {
        assert.ok(
          turn10.answerText.toUpperCase().includes('FRESH_OK'),
          `Turn 10 reply missing FRESH_OK; got: ${turn10.answerText.slice(0, 200)}`,
        );
        assert.equal(
          newSessions.length,
          1,
          `Expected 1 new session entry after /clear, got ${newSessions.length} (total=${sessionsAfterT10.length})`,
        );
        const s2 = newSessions[0];
        assert.ok(typeof s2.conversationId === 'string' && s2.conversationId.length > 0);
        assert.notEqual(s2.conversationId, convId1, 'New session after /clear must have convId2 !== convId1');
        assert.notEqual(s2.agentName, agentName1, 'New session after /clear must have a distinct agentName');
      });

      const s2 = newSessions[0];
      summary.sessionsEvidence.sessionId2 = s2.sessionId;
      summary.sessionsEvidence.convId2 = s2.conversationId;
      summary.sessionsEvidence.agentName2 = s2.agentName;

      return {
        clearedThroughEntryId: cleared.clearedThroughEntryId,
        convId1,
        convId2: s2.conversationId,
        agentName2: s2.agentName,
        turn10DurationMs: turn10.durationMs,
        turn10Preview: turn10.answerText.slice(0, 160),
      };
    });

    summary.ok = true;
  } catch (err) {
    primaryError = err;
    summary.ok = false;
    summary.error = {
      scenario: activeScenarioName,
      code: err?.code ?? null,
      message: redactor.redactString(err?.message ?? String(err)),
      stack: redactor.redactString(err?.stack ?? ''),
    };
  } finally {
    const closeResource = async (name, fn, flagKey) => {
      try {
        await fn();
        summary.cleanup[flagKey] = true;
      } catch (err) {
        summary.cleanup.errors.push(`${name}: ${redactor.redactString(err?.message ?? String(err))}`);
      }
    };

    if (hostService) {
      await closeResource('hostService', () => hostService.close(), 'hostServiceClosed');
      hostService = null;
    } else {
      summary.cleanup.hostServiceClosed = true;
    }

    if (host) {
      await closeResource('host', () => host.close(), 'hostClosed');
      host = null;
    } else {
      summary.cleanup.hostClosed = true;
    }

    if (tlsProxy) {
      tlsProxy.setTarget(null);
    }

    if (center) {
      await closeResource('center', () => center.close(), 'centerClosed');
      center = null;
    } else {
      summary.cleanup.centerClosed = true;
    }

    if (tlsProxy) {
      await closeResource('tlsProxy', () => tlsProxy.close(), 'tlsProxyClosed');
      tlsProxy = null;
    } else {
      summary.cleanup.tlsProxyClosed = true;
    }

    summary.cleanup.residualAgyCleaned = cleanupResidualAgyProcesses(geminiDir);
    writeSummary();
  }

  // Print concise final summary to stdout (redacted, zero credentials).
  console.log('');
  console.log('================ AGY Native Turn E2E Summary ================');
  console.log(`Result      : ${summary.ok ? 'PASS' : 'FAIL'} (${summary.durationMs}ms)`);
  console.log(`Models      : modelA=${summary.models.modelA ?? 'n/a'}, modelB=${summary.models.modelB ?? 'n/a'} (discovered=${summary.models.discoveredCount})`);
  console.log(`Conv IDs    : convId1=${summary.sessionsEvidence.convId1 ?? 'n/a'} | convId2=${summary.sessionsEvidence.convId2 ?? 'n/a'}`);
  console.log(`Summary JSON: ${summaryPath}`);
  for (const s of summary.scenarios) {
    console.log(`  [${s.status.toUpperCase().padEnd(6)}] Scenario ${s.id}: ${s.name} (${s.durationMs}ms, ${s.assertions.length} assertions)`);
  }
  if (summary.cleanup.residualAgyCleaned.length > 0) {
    console.log(`Cleanup     : terminated residual isolated agy PIDs: ${summary.cleanup.residualAgyCleaned.join(', ')}`);
  }
  if (summary.cleanup.errors.length > 0) {
    console.log(`Cleanup Errs: ${summary.cleanup.errors.join(' | ')}`);
  }
  console.log('=============================================================');

  if (primaryError) {
    console.error(`[FAIL] ${activeScenarioName}: ${redactor.redactString(primaryError?.message ?? String(primaryError))}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(`[FAIL] ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
