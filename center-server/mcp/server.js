// Center-hosted Streamable HTTP MCP transport over Fastify.
//
// Uses the official @modelcontextprotocol/sdk Server + WebStandardStreamableHTTPServerTransport
// in stateless JSON-response mode (POST only; GET/DELETE return 405).
//
// Security invariants:
// - Executes MCP handlers and operations ONLY after `authenticate` succeeds.
// - Auth failures return HTTP 401/403 (never JSON-RPC 200).
// - Origin validation allows absent Origin (server-to-server HTTPS clients such as Gemini)
//   and explicitly configured HTTPS origins (publicUrl + allowedOrigins); never trusts Host.
// - Explicit routes on /mcp and /mcp/* prevent static SPA index.html fallback.
// - Enforces bounded request size/structure, bounded response bytes, per-IP and per-actor
//   rate limiting, safe error responses, and secret scrubbing.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_MCP_PATH = '/mcp';
export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_RATE_LIMIT_MAX = 60;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

const DEFAULT_SERVER_INFO = Object.freeze({ name: 'pibot-center', version: '0.1.0' });
const UNSUPPORTED_BODY_METHODS = Object.freeze(['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']);
const MAX_TOOLS_PER_ACTOR = 256;
const MAX_TOOL_DESCRIPTION_CHARS = 4096;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 2000;
const MAX_OUTPUT_DEPTH = 16;
const MAX_OUTPUT_ARRAY_ITEMS = 10_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const TRUNCATED_SUFFIX = '\n[truncated]';

const VALID_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SENSITIVE_KEY_NAMES = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'oauthtoken',
  'bearertoken',
  'devicetoken',
  'bottoken',
  'ownertoken',
  'ownerkey',
  'ownerpassword',
  'ownerpasswordhash',
  'password',
  'passwordhash',
  'passphrase',
  'clientsecret',
  'secret',
  'apikey',
  'apikeyref',
  'sessionkey',
  'encryptionkey',
  'privatekey',
  'cookie',
  'setcookie',
  'xcsrftoken',
  'xbridgetoken',
]);

const SAFE_TOOL_ERROR_CODES = new Map([
  ['INVALID_ARGUMENT', 'Invalid argument'],
  ['VALIDATION_FAILED', 'Validation failed'],
  ['NOT_FOUND', 'Not found'],
  ['BOT_NOT_FOUND', 'Bot not found'],
  ['TOOL_NOT_FOUND', 'Unknown tool'],
  ['FORBIDDEN', 'Forbidden'],
  ['CONFLICT', 'Conflict'],
  ['REVISION_CONFLICT', 'Revision conflict'],
  ['REQUEST_CONFLICT', 'Request conflict'],
  ['INVALID_STATE', 'Invalid state'],
  ['RATE_LIMITED', 'Rate limit exceeded'],
  ['TIMEOUT', 'Operation timed out'],
  ['CALL_TIMEOUT', 'Operation timed out'],
  ['PAYLOAD_TOO_LARGE', 'Payload too large'],
  ['UNSUPPORTED_TARGET', 'Unsupported target'],
  ['DEVICE_OFFLINE', 'Device offline'],
  ['CENTER_OFFLINE', 'Center offline'],
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function singleHeader(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseHttpsOrigin(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty HTTPS origin`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
  ) {
    throw new Error(`${label} must be an HTTPS origin (scheme, host and optional port only)`);
  }
  return parsed;
}

function parseAllowedOriginEntry(value) {
  if (typeof value !== 'string' || !value || value === '*' || value === 'null') {
    throw new Error('allowedOrigins entries must be explicit HTTPS origins');
  }
  const parsed = parseHttpsOrigin(value, 'allowedOrigins entry');
  if (parsed.origin !== value) {
    throw new Error('allowedOrigins entries must be canonical HTTPS origins without trailing slash');
  }
  return parsed.origin;
}

function normalizeMcpPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.length < 2 || rawPath.length > 128) {
    throw new Error('path must be a non-root path starting with "/"');
  }
  if (rawPath.endsWith('/') || rawPath.includes('//') || !/^\/[A-Za-z0-9._~/-]+$/.test(rawPath)) {
    throw new Error('path must be a normalized URL path without trailing slash or wildcards');
  }
  return rawPath;
}

function parsePositiveInt(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function scrubSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:pboauth|pbpair)_[A-Za-z0-9_-]{8,}/g, '[redacted-token]')
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\b1\/\/[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\bGOCSPX-[A-Za-z0-9._-]{6,}/g, '[redacted-secret]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|glpat|xox[baprs])-[A-Za-z0-9._-]{12,}/g, '[redacted-secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
    .replace(/\bscrypt\$[0-9a-f]{32}\$[0-9a-f]{128}\b/gi, '[redacted-hash]')
    .replace(
      /(["']?(?:client_secret|clientSecret|refresh_token|refreshToken|access_token|accessToken|id_token|idToken|device_token|deviceToken|owner_password_hash|ownerPasswordHash|session_key|sessionKey|encryption_key|encryptionKey|api_key|apiKey|password|authorization)["']?\s*[:=]\s*["']?)([^"'\s,&}\]]+)/gi,
      '$1[redacted]',
    );
}

function isSensitiveKeyName(key) {
  if (typeof key !== 'string' || !key) return false;
  return SENSITIVE_KEY_NAMES.has(key.toLowerCase().replace(/[-_]/g, ''));
}

function isAllowedOrigin(rawOriginHeader, allowedOriginSet) {
  // Server-to-server HTTPS clients (such as Gemini) do not send an Origin header.
  if (rawOriginHeader === undefined) return true;
  if (typeof rawOriginHeader !== 'string' || !rawOriginHeader || rawOriginHeader === 'null') {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(rawOriginHeader);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
    || parsed.origin !== rawOriginHeader
  ) {
    return false;
  }
  return allowedOriginSet.has(parsed.origin);
}

function isJsonContentType(contentTypeHeader) {
  const value = singleHeader(contentTypeHeader);
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

function acceptsJson(acceptHeader) {
  if (acceptHeader === undefined) return true;
  const value = singleHeader(acceptHeader);
  if (value === undefined) return false;
  if (value.trim() === '') return true;
  const ranges = value.split(',');
  for (const rawRange of ranges) {
    const parts = rawRange.trim().toLowerCase().split(';').map((part) => part.trim());
    const mediaType = parts[0];
    if (!mediaType) continue;
    let q = 1;
    for (let i = 1; i < parts.length; i += 1) {
      const match = /^q=([0-9.]+)$/.exec(parts[i]);
      if (match) {
        q = Number(match[1]);
        break;
      }
    }
    if (!Number.isFinite(q) || q <= 0) continue;
    if (mediaType === 'application/json' || mediaType === 'application/*' || mediaType === '*/*') {
      return true;
    }
  }
  return false;
}

function withinJsonLimits(root, maxDepth, maxNodes) {
  let nodes = 0;
  const stack = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return false;
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        stack.push({ value: value[i], depth: depth + 1 });
      }
    } else {
      for (const item of Object.values(value)) {
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return true;
}

function stripDangerousKeys(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error('Maximum depth exceeded');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item, depth + 1));
  }
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = stripDangerousKeys(item, depth + 1);
  }
  return clean;
}

function sanitizeOutputValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_OUTPUT_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `[binary omitted (${value.byteLength} bytes)]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return '[error]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, MAX_OUTPUT_ARRAY_ITEMS);
      const out = [];
      for (let i = 0; i < limit; i += 1) {
        const sanitized = sanitizeOutputValue(value[i], depth + 1, seen);
        out.push(sanitized === undefined ? null : sanitized);
      }
      if (value.length > limit) {
        out.push('[truncated items]');
      }
      return out;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (isSensitiveKeyName(key)) {
        out[key] = '[redacted]';
        continue;
      }
      const sanitized = sanitizeOutputValue(item, depth + 1, seen);
      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function sliceSafeUtf16(str, length) {
  if (length <= 0) return '';
  if (length >= str.length) return str;
  const lastCode = str.charCodeAt(length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    return str.slice(0, length - 1);
  }
  return str.slice(0, length);
}

function truncateTextToJsonByteBudget(text, maxJsonBytes) {
  if (maxJsonBytes <= 0) return '';
  if (Buffer.byteLength(JSON.stringify(text), 'utf8') <= maxJsonBytes) {
    return text;
  }
  const suffix = Buffer.byteLength(JSON.stringify(TRUNCATED_SUFFIX), 'utf8') <= maxJsonBytes
    ? TRUNCATED_SUFFIX
    : '';
  let low = 0;
  let high = text.length;
  let best = suffix;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = sliceSafeUtf16(text, mid) + suffix;
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxJsonBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function isCallToolResultEnvelope(value) {
  return isPlainObject(value)
    && Array.isArray(value.content)
    && value.content.every((block) => isPlainObject(block) && typeof block.type === 'string');
}

function sanitizeContentBlocks(blocks, maxTotalJsonBytes) {
  const result = [];
  let remaining = Math.max(0, maxTotalJsonBytes);
  const blockOverhead = 32;

  for (const block of blocks) {
    if (remaining <= blockOverhead) {
      if (result.length === 0) {
        result.push({ type: 'text', text: truncateTextToJsonByteBudget('[truncated]', maxTotalJsonBytes) });
      }
      break;
    }
    let text;
    if (block.type === 'text' && typeof block.text === 'string') {
      text = scrubSecrets(block.text);
    } else if (block.type === 'resource' && isPlainObject(block.resource) && typeof block.resource.text === 'string') {
      text = scrubSecrets(block.resource.text);
    } else if (block.type === 'image' || block.type === 'audio' || block.type === 'resource') {
      text = `[${block.type} payload omitted]`;
    } else {
      text = JSON.stringify(sanitizeOutputValue(block));
    }
    const bounded = truncateTextToJsonByteBudget(text, remaining - blockOverhead);
    result.push({ type: 'text', text: bounded });
    remaining -= Buffer.byteLength(JSON.stringify(bounded), 'utf8') + blockOverhead;
  }

  return result.length > 0 ? result : [{ type: 'text', text: '' }];
}

function formatToolResult(rawResult, maxToolJsonBytes) {
  const textBudget = Math.max(32, maxToolJsonBytes);
  if (rawResult === undefined || rawResult === null) {
    return { content: [{ type: 'text', text: '' }] };
  }
  if (typeof rawResult === 'string') {
    return {
      content: [{ type: 'text', text: truncateTextToJsonByteBudget(scrubSecrets(rawResult), textBudget) }],
    };
  }
  if (isCallToolResultEnvelope(rawResult)) {
    const out = {
      content: sanitizeContentBlocks(rawResult.content, textBudget),
      ...(rawResult.isError === true ? { isError: true } : {}),
    };
    if (isPlainObject(rawResult.structuredContent)) {
      const safeStructured = sanitizeOutputValue(rawResult.structuredContent);
      const candidate = { ...out, structuredContent: safeStructured };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= textBudget) {
        out.structuredContent = safeStructured;
      }
    }
    return out;
  }
  const safeValue = sanitizeOutputValue(rawResult);
  const serialized = JSON.stringify(safeValue);
  return {
    content: [{ type: 'text', text: truncateTextToJsonByteBudget(serialized, textBudget) }],
  };
}

function formatToolError(err) {
  const rawCode = typeof err?.code === 'string' ? err.code : '';
  const mappedMessage = SAFE_TOOL_ERROR_CODES.get(rawCode);
  const code = mappedMessage ? rawCode : 'TOOL_EXECUTION_FAILED';
  let message = mappedMessage || 'Tool execution failed';
  if (typeof err?.publicMessage === 'string' && err.publicMessage.trim()) {
    message = scrubSecrets(err.publicMessage.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim()).slice(0, 256);
  } else if (err?.expose === true && typeof err?.message === 'string' && err.message.trim()) {
    message = scrubSecrets(err.message.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim()).slice(0, 256);
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  };
}

function normalizeInputSchema(rawSchema) {
  if (!isPlainObject(rawSchema) || !withinJsonLimits(rawSchema, MAX_JSON_DEPTH, MAX_JSON_NODES)) {
    return { type: 'object', properties: {} };
  }
  const cloned = stripDangerousKeys(rawSchema);
  if (cloned.type !== 'object') cloned.type = 'object';
  if (!isPlainObject(cloned.properties)) cloned.properties = {};
  return cloned;
}

function normalizeOperationList(rawOperations) {
  if (!Array.isArray(rawOperations) || rawOperations.length > MAX_TOOLS_PER_ACTOR) {
    throw new Error('Invalid operations list');
  }
  const tools = [];
  const byName = new Map();
  for (const op of rawOperations) {
    if (!op || typeof op !== 'object') {
      throw new Error('Operation entry must be an object');
    }
    const name = typeof op.name === 'string' ? op.name.trim() : '';
    if (!VALID_TOOL_NAME.test(name) || byName.has(name)) {
      throw new Error('Invalid or duplicate operation name');
    }
    const destructiveHint = op.destructive === true;
    const readOnlyHint = !destructiveHint && op.readOnly === true;
    const description = typeof op.description === 'string'
      ? scrubSecrets(op.description).slice(0, MAX_TOOL_DESCRIPTION_CHARS)
      : '';
    const tool = {
      name,
      ...(description ? { description } : {}),
      inputSchema: normalizeInputSchema(op.inputSchema),
      annotations: {
        readOnlyHint,
        destructiveHint,
      },
    };
    tools.push(tool);
    byName.set(name, tool);
  }
  return { tools, byName };
}

function createRateLimiter({ max, windowMs, now, maxEntries = MAX_RATE_LIMIT_ENTRIES }) {
  const buckets = new Map();

  function sweep(currentTime) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) {
        buckets.delete(key);
      }
    }
    while (buckets.size >= maxEntries) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  return {
    consume(key) {
      const currentTime = now();
      const bucketKey = typeof key === 'string' && key ? key : 'unknown';
      const existing = buckets.get(bucketKey);
      if (!existing || existing.resetAt <= currentTime) {
        if (!existing && buckets.size >= maxEntries) {
          sweep(currentTime);
        }
        buckets.set(bucketKey, { count: 1, resetAt: currentTime + windowMs });
        return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 };
      }
      if (existing.count >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000));
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      existing.count += 1;
      return { allowed: true, remaining: max - existing.count, retryAfterSeconds: 0 };
    },
  };
}

function clientIpKey(req) {
  return typeof req?.ip === 'string' && req.ip ? req.ip : 'unknown';
}

function deriveActorRateKey(actor, req) {
  if (typeof actor === 'string' && actor.trim()) {
    return `actor:${actor.trim().slice(0, 128)}`;
  }
  if (isPlainObject(actor)) {
    for (const field of ['id', 'sub', 'subject', 'actorId', 'clientId', 'deviceId', 'userId']) {
      const value = actor[field];
      if (typeof value === 'string' && value.trim()) {
        return `actor:${field}:${value.trim().slice(0, 128)}`;
      }
    }
  }
  return `ip:${clientIpKey(req)}`;
}

function setSecurityHeaders(reply) {
  reply.header('Cache-Control', 'no-store');
  reply.header('Vary', 'Origin');
  reply.header('X-Content-Type-Options', 'nosniff');
}

function sendHttpError(reply, statusCode, code, message) {
  setSecurityHeaders(reply);
  return reply.code(statusCode).type('application/json').send({
    error: { code, message },
  });
}

function sanitizeWwwAuthenticate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

async function runAuthenticate(authenticate, req, reply, resourceMetadataUrl) {
  const defaultWwwAuth = `Bearer resource_metadata="${resourceMetadataUrl}"`;
  try {
    const actor = await authenticate(req, reply);
    if (reply.sent || reply.raw.headersSent || reply.raw.writableEnded) {
      return { ok: false };
    }
    if (!actor || (typeof actor === 'object' && (actor.authenticated === false || actor.ok === false))) {
      if (!reply.getHeader('www-authenticate')) {
        reply.header('WWW-Authenticate', defaultWwwAuth);
      }
      sendHttpError(reply, 401, 'UNAUTHENTICATED', 'Authentication required');
      return { ok: false };
    }
    return { ok: true, actor };
  } catch (error) {
    if (reply.sent || reply.raw.headersSent || reply.raw.writableEnded) {
      return { ok: false };
    }
    const statusCode = Number(error?.statusCode);
    const code = typeof error?.code === 'string' ? error.code : '';
    const customWwwAuth = sanitizeWwwAuthenticate(error?.wwwAuthenticate);

    if (statusCode === 403 || code === 'FORBIDDEN' || code === 'INSUFFICIENT_SCOPE') {
      if (customWwwAuth && !reply.getHeader('www-authenticate')) {
        reply.header('WWW-Authenticate', customWwwAuth);
      }
      sendHttpError(reply, 403, code === 'INSUFFICIENT_SCOPE' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN', 'Forbidden');
      return { ok: false };
    }
    if (statusCode >= 500 && statusCode <= 599) {
      sendHttpError(reply, 500, 'INTERNAL_ERROR', 'Internal error');
      return { ok: false };
    }
    if (!reply.getHeader('www-authenticate')) {
      reply.header('WWW-Authenticate', customWwwAuth || defaultWwwAuth);
    }
    sendHttpError(reply, 401, 'UNAUTHENTICATED', 'Authentication required');
    return { ok: false };
  }
}

function sendOversizedResponseError(reply, requestBody, maxResponseBytes) {
  setSecurityHeaders(reply);
  if (typeof requestBody?.id === 'string' || typeof requestBody?.id === 'number') {
    const rpcError = JSON.stringify({
      jsonrpc: '2.0',
      id: requestBody.id,
      error: { code: -32603, message: 'Response exceeds size limit' },
    });
    if (Buffer.byteLength(rpcError, 'utf8') <= maxResponseBytes) {
      return reply.code(200).type('application/json').send(rpcError);
    }
  }
  return sendHttpError(reply, 500, 'RESPONSE_TOO_LARGE', 'Response exceeds size limit');
}

function createStatelessMcpServer({ actor, operations, serverInfo, maxResponseBytes, requestIdBytes }) {
  const mcpServer = new Server(serverInfo, { capabilities: { tools: {} } });
  let cachedCatalogPromise = null;

  function loadCatalog() {
    if (!cachedCatalogPromise) {
      cachedCatalogPromise = Promise.resolve()
        .then(() => operations.list(actor))
        .then((rawList) => normalizeOperationList(rawList));
    }
    return cachedCatalogPromise;
  }

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { tools } = await loadCatalog();
      return { tools };
    } catch {
      throw new McpError(ErrorCode.InternalError, 'Internal error');
    }
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    let catalog;
    try {
      catalog = await loadCatalog();
    } catch {
      throw new McpError(ErrorCode.InternalError, 'Internal error');
    }

    const toolName = request?.params?.name;
    if (typeof toolName !== 'string' || !catalog.byName.has(toolName)) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'TOOL_NOT_FOUND', message: 'Unknown tool' } }) }],
      };
    }

    const rawArgs = request?.params?.arguments;
    if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'Tool arguments must be an object' } }) }],
      };
    }

    let cleanArgs = {};
    if (rawArgs !== undefined && rawArgs !== null) {
      if (!withinJsonLimits(rawArgs, MAX_JSON_DEPTH, MAX_JSON_NODES)) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'Tool arguments exceed limits' } }) }],
        };
      }
      try {
        cleanArgs = stripDangerousKeys(rawArgs);
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'Invalid tool arguments' } }) }],
        };
      }
    }

    try {
      const result = await operations.call(actor, toolName, cleanArgs);
      const envelopeAllowance = 160 + requestIdBytes;
      const toolBudget = Math.max(32, maxResponseBytes - envelopeAllowance);
      return formatToolResult(result, toolBudget);
    } catch (error) {
      return formatToolError(error);
    }
  });

  return mcpServer;
}

export function registerMcp(app, options) {
  if (!app || typeof app.route !== 'function') {
    throw new Error('Fastify app instance is required');
  }
  if (!options || typeof options !== 'object') {
    throw new Error('registerMcp options are required');
  }

  const {
    publicUrl,
    authenticate,
    operations,
    path = DEFAULT_MCP_PATH,
    allowedOrigins = [],
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    rateLimit = {},
    serverInfo = DEFAULT_SERVER_INFO,
    now = () => Date.now(),
  } = options;

  const publicOrigin = parseHttpsOrigin(publicUrl, 'publicUrl');
  if (typeof authenticate !== 'function') {
    throw new Error('authenticate function is required');
  }
  if (!operations || typeof operations !== 'object' || typeof operations.list !== 'function' || typeof operations.call !== 'function') {
    throw new Error('operations with list() and call() functions is required');
  }
  if (typeof now !== 'function') {
    throw new Error('now must be a function');
  }

  const mcpPath = normalizeMcpPath(path);
  const canonicalEndpointUrl = new URL(mcpPath, publicOrigin).href;
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', publicOrigin).href;

  const allowedOriginSet = new Set([publicOrigin.origin]);
  if (allowedOrigins !== undefined && allowedOrigins !== null) {
    if (!Array.isArray(allowedOrigins) && !(allowedOrigins instanceof Set)) {
      throw new Error('allowedOrigins must be an array or Set of HTTPS origins');
    }
    for (const originEntry of allowedOrigins) {
      allowedOriginSet.add(parseAllowedOriginEntry(originEntry));
    }
  }

  const boundedRequestBytes = parsePositiveInt(maxRequestBytes, 'maxRequestBytes', { min: 256, max: 4 * 1024 * 1024 });
  const boundedResponseBytes = parsePositiveInt(maxResponseBytes, 'maxResponseBytes', { min: 256, max: 4 * 1024 * 1024 });

  if (rateLimit !== null && typeof rateLimit !== 'object') {
    throw new Error('rateLimit must be an object');
  }
  const actorMax = parsePositiveInt(rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX, 'rateLimit.max', { min: 1, max: 100_000 });
  const ipMax = parsePositiveInt(rateLimit?.ipMax ?? actorMax, 'rateLimit.ipMax', { min: 1, max: 100_000 });
  const windowMs = parsePositiveInt(rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS, 'rateLimit.windowMs', { min: 100, max: 24 * 60 * 60 * 1000 });

  const normalizedServerInfo = {
    name: typeof serverInfo?.name === 'string' && serverInfo.name.trim()
      ? serverInfo.name.trim().slice(0, 128)
      : DEFAULT_SERVER_INFO.name,
    version: typeof serverInfo?.version === 'string' && serverInfo.version.trim()
      ? serverInfo.version.trim().slice(0, 64)
      : DEFAULT_SERVER_INFO.version,
  };

  const ipLimiter = createRateLimiter({ max: ipMax, windowMs, now });
  const actorLimiter = createRateLimiter({ max: actorMax, windowMs, now });
  const actorByRequest = new WeakMap();

  app.route({
    method: 'POST',
    url: mcpPath,
    bodyLimit: boundedRequestBytes,
    errorHandler: (error, req, reply) => {
      setSecurityHeaders(reply);
      if (error?.statusCode === 413 || error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return sendHttpError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Request payload too large');
      }
      if (error?.statusCode === 415 || error?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        return sendHttpError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
      }
      if (
        error?.statusCode === 400
        || error?.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
        || error?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
      ) {
        return sendHttpError(reply, 400, 'INVALID_JSON', 'Invalid JSON request body');
      }
      return sendHttpError(reply, 500, 'INTERNAL_ERROR', 'Internal error');
    },
    preParsing: async (req, reply, payload) => {
      setSecurityHeaders(reply);

      if (!isAllowedOrigin(req.headers.origin, allowedOriginSet)) {
        return sendHttpError(reply, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed');
      }

      const ipLimit = ipLimiter.consume(clientIpKey(req));
      if (!ipLimit.allowed) {
        reply.header('Retry-After', String(ipLimit.retryAfterSeconds));
        return sendHttpError(reply, 429, 'RATE_LIMITED', 'Rate limit exceeded');
      }

      const authResult = await runAuthenticate(authenticate, req, reply, resourceMetadataUrl);
      if (!authResult.ok) {
        return reply;
      }
      actorByRequest.set(req, authResult.actor);

      const actorLimit = actorLimiter.consume(deriveActorRateKey(authResult.actor, req));
      if (!actorLimit.allowed) {
        reply.header('Retry-After', String(actorLimit.retryAfterSeconds));
        return sendHttpError(reply, 429, 'RATE_LIMITED', 'Rate limit exceeded');
      }

      if (!isJsonContentType(req.headers['content-type'])) {
        return sendHttpError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
      }
      if (!acceptsJson(req.headers.accept)) {
        return sendHttpError(reply, 406, 'NOT_ACCEPTABLE', 'Accept header must allow application/json');
      }

      const contentLengthHeader = singleHeader(req.headers['content-length']);
      if (contentLengthHeader !== undefined) {
        const parsedLength = Number(contentLengthHeader);
        if (!Number.isFinite(parsedLength) || parsedLength < 0) {
          return sendHttpError(reply, 400, 'INVALID_ARGUMENT', 'Invalid Content-Length header');
        }
        if (parsedLength > boundedRequestBytes) {
          return sendHttpError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Request payload too large');
        }
      }

      return payload;
    },
    handler: async (req, reply) => {
      setSecurityHeaders(reply);

      const actor = actorByRequest.get(req);
      if (!actor) {
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
        return sendHttpError(reply, 401, 'UNAUTHENTICATED', 'Authentication required');
      }

      const body = req.body;
      if (!isPlainObject(body)) {
        return sendHttpError(reply, 400, 'INVALID_ARGUMENT', 'Request body must be a JSON object');
      }
      if (!withinJsonLimits(body, MAX_JSON_DEPTH, MAX_JSON_NODES)) {
        return sendHttpError(reply, 400, 'INVALID_ARGUMENT', 'Request body exceeds structural limits');
      }

      let sanitizedBody;
      try {
        sanitizedBody = stripDangerousKeys(body);
      } catch {
        return sendHttpError(reply, 400, 'INVALID_ARGUMENT', 'Invalid request body');
      }

      if (Buffer.byteLength(JSON.stringify(sanitizedBody), 'utf8') > boundedRequestBytes) {
        return sendHttpError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Request payload too large');
      }

      const requestIdBytes = sanitizedBody.id === undefined
        ? 4
        : Buffer.byteLength(JSON.stringify(sanitizedBody.id), 'utf8');

      const mcpServer = createStatelessMcpServer({
        actor,
        operations,
        serverInfo: normalizedServerInfo,
        maxResponseBytes: boundedResponseBytes,
        requestIdBytes,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const webHeaders = new Headers();
      webHeaders.set('content-type', 'application/json');
      webHeaders.set('accept', 'application/json, text/event-stream');
      const protocolVersion = singleHeader(req.headers['mcp-protocol-version']);
      if (protocolVersion) {
        webHeaders.set('mcp-protocol-version', protocolVersion);
      }
      const webRequest = new Request(canonicalEndpointUrl, {
        method: 'POST',
        headers: webHeaders,
      });

      try {
        await mcpServer.connect(transport);
        const webResponse = await transport.handleRequest(webRequest, {
          parsedBody: sanitizedBody,
        });
        const statusCode = webResponse.status;
        if (statusCode === 202 || statusCode === 204) {
          return reply.code(statusCode).send();
        }
        const rawResponseText = await webResponse.text();
        if (statusCode >= 500) {
          return sendHttpError(reply, 500, 'INTERNAL_ERROR', 'Internal error');
        }
        const safeResponseText = statusCode >= 400 ? scrubSecrets(rawResponseText) : rawResponseText;
        if (Buffer.byteLength(safeResponseText, 'utf8') > boundedResponseBytes) {
          return sendOversizedResponseError(reply, sanitizedBody, boundedResponseBytes);
        }
        const responseContentType = webResponse.headers.get('content-type') || 'application/json';
        return reply.code(statusCode).type(responseContentType).send(safeResponseText);
      } catch {
        return sendHttpError(reply, 500, 'INTERNAL_ERROR', 'Internal error');
      } finally {
        try { await mcpServer.close(); } catch { /* ignore close errors */ }
        try { await transport.close(); } catch { /* ignore close errors */ }
      }
    },
  });

  const handleUnsupportedMethod = async (req, reply) => {
    setSecurityHeaders(reply);
    if (!isAllowedOrigin(req.headers.origin, allowedOriginSet)) {
      return sendHttpError(reply, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed');
    }
    const ipLimit = ipLimiter.consume(clientIpKey(req));
    if (!ipLimit.allowed) {
      reply.header('Retry-After', String(ipLimit.retryAfterSeconds));
      return sendHttpError(reply, 429, 'RATE_LIMITED', 'Rate limit exceeded');
    }
    reply.header('Allow', 'POST');
    if (req.method === 'HEAD') {
      return reply.code(405).send();
    }
    return sendHttpError(reply, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed; use POST');
  };

  app.route({
    method: [...UNSUPPORTED_BODY_METHODS],
    url: mcpPath,
    exposeHeadRoutes: false,
    handler: handleUnsupportedMethod,
  });

  app.route({
    method: 'HEAD',
    url: mcpPath,
    handler: handleUnsupportedMethod,
  });

  const handleSubpathNotFound = async (req, reply) => {
    setSecurityHeaders(reply);
    if (req.method === 'HEAD') {
      return reply.code(404).send();
    }
    return sendHttpError(reply, 404, 'NOT_FOUND', 'Not found');
  };

  app.route({
    method: ['POST', ...UNSUPPORTED_BODY_METHODS],
    url: `${mcpPath}/*`,
    exposeHeadRoutes: false,
    handler: handleSubpathNotFound,
  });

  app.route({
    method: 'HEAD',
    url: `${mcpPath}/*`,
    handler: handleSubpathNotFound,
  });

  return {
    path: mcpPath,
    endpointUrl: canonicalEndpointUrl,
  };
}
