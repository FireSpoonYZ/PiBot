import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  OPERATION_ERROR_MESSAGES,
  OPERATION_ERROR_STATUS,
} from '../../center-server/operations/errors.js';
import { registerMcp } from '../../center-server/mcp/server.js';
import { errorStatus } from '../../center-server/server.js';

const centerRequire = createRequire(new URL('../../center-server/package.json', import.meta.url));
const Fastify = centerRequire('fastify');

const PUBLIC_URL = 'https://center.example.com';
const VALID_BEARER = 'Bearer valid-mcp-token-for-error-tests';

const REQUIRED_CALLER_FIXABLE_CODES = Object.freeze({
  TASK_NOT_FOUND: 404,
  SCOPE_FORBIDDEN: 403,
  SCOPE_DELETED: 410,
  SCOPE_AUTHORITY_REQUIRED: 403,
  SCOPE_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  BOT_ARCHIVED: 409,
  PRIMARY_BOT_PROTECTED: 409,
  RUNTIME_BUSY: 409,
});

const LEAKY_SECRET_DETAIL = 'SQLITE_CANTOPEN /var/lib/pibot/center.db Bearer pboauth_secret999999999999 row-id-42';

function mcpCallTool(app, id, name, args = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: VALID_BEARER,
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  });
}

test('shared operation error whitelist covers required caller-fixable codes and stays aligned with server.js', () => {
  assert.equal(Object.isFrozen(OPERATION_ERROR_STATUS), true);
  assert.equal(Object.isFrozen(OPERATION_ERROR_MESSAGES), true);
  assert.deepEqual(
    Object.keys(OPERATION_ERROR_STATUS).sort(),
    Object.keys(OPERATION_ERROR_MESSAGES).sort(),
  );

  for (const [code, expectedStatus] of Object.entries(REQUIRED_CALLER_FIXABLE_CODES)) {
    assert.equal(OPERATION_ERROR_STATUS[code], expectedStatus, `${code} HTTP status`);
    assert.equal(typeof OPERATION_ERROR_MESSAGES[code], 'string', `${code} message`);
    assert.ok(OPERATION_ERROR_MESSAGES[code].length > 0, `${code} non-empty message`);
  }

  for (const code of [
    'INVALID_CWD',
    'PACKAGE_NOT_READY',
    'SUBMISSION_NOT_FOUND',
    'DELIVERY_NOT_FOUND',
    'ATTACHMENT_NOT_FOUND',
    'MODEL_REQUIRED',
    'MODEL_NOT_FOUND',
    'MODEL_NO_VISION',
    'SCOPE_UNMANAGED',
  ]) {
    assert.equal(Object.hasOwn(OPERATION_ERROR_STATUS, code), true, `expected ${code} in whitelist`);
    assert.ok(OPERATION_ERROR_STATUS[code] >= 400 && OPERATION_ERROR_STATUS[code] < 500);
  }

  for (const unsafeCode of [
    'INTERNAL_ERROR',
    'INTERNAL',
    'STORE_FAILED',
    'ENOENT',
    'EACCES',
    'SQLITE_CANTOPEN',
    'WORK_GENERATION_FAILED',
    'COMPACTION_FAILED',
    '__proto__',
    'constructor',
    'toString',
  ]) {
    assert.equal(Object.hasOwn(OPERATION_ERROR_STATUS, unsafeCode), false, `${unsafeCode} must not be whitelisted`);
    assert.equal(Object.hasOwn(OPERATION_ERROR_MESSAGES, unsafeCode), false, `${unsafeCode} must not be whitelisted`);
  }

  // Spreading OPERATION_ERROR_STATUS into center-server/server.js must not alter any existing status code.
  for (const [code, status] of Object.entries(OPERATION_ERROR_STATUS)) {
    if (Object.hasOwn(errorStatus, code)) {
      assert.equal(status, errorStatus[code], `status mismatch with server.js for ${code}`);
    }
  }
});

test('MCP adapter returns whitelisted caller-fixable error codes with fixed messages and never leaks internal details', async () => {
  const app = Fastify({ logger: false });
  registerMcp(app, {
    publicUrl: PUBLIC_URL,
    rateLimit: { max: 200, ipMax: 200 },
    authenticate(req) {
      return req.headers.authorization === VALID_BEARER
        ? { id: 'actor-error-test', clientId: 'test-client' }
        : null;
    },
    operations: {
      list() {
        return [
          {
            name: 'trigger_error',
            description: 'Throws a configured error code for testing',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                omitCode: { type: 'boolean' },
              },
            },
            readOnly: true,
            destructive: false,
          },
        ];
      },
      async call(_actor, _name, args) {
        const err = new Error(LEAKY_SECRET_DETAIL);
        err.expose = true;
        err.publicMessage = 'leaked-public-message-secret';
        if (!args.omitCode) {
          err.code = args.code;
        }
        throw err;
      },
    },
  });
  await app.ready();

  try {
    let requestId = 1;
    for (const code of Object.keys(REQUIRED_CALLER_FIXABLE_CODES)) {
      const res = await mcpCallTool(app, requestId++, 'trigger_error', { code });
      assert.equal(res.statusCode, 200, `${code}: ${res.body}`);
      const result = res.json().result;
      assert.equal(result.isError, true, `${code} must return isError=true`);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        error: {
          code,
          message: OPERATION_ERROR_MESSAGES[code],
        },
      });
      assert.doesNotMatch(res.body, /SQLITE_CANTOPEN|center\.db|pboauth_secret|row-id-42|leaked-public-message/);
    }

    for (const disconnectCode of ['OFFLINE', 'NOT_CONNECTED', 'DISCONNECTED', 'CONNECT_FAILED']) {
      const res = await mcpCallTool(app, requestId++, 'trigger_error', { code: disconnectCode });
      assert.equal(res.statusCode, 200, `${disconnectCode}: ${res.body}`);
      const result = res.json().result;
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        error: {
          code: 'DEVICE_OFFLINE',
          message: 'Device offline',
        },
      });
      assert.doesNotMatch(res.body, /SQLITE_CANTOPEN|center\.db|pboauth_secret|row-id-42|leaked-public-message/);
    }

    const unknownCases = [
      { code: 'SQLITE_CANTOPEN' },
      { code: 'ENOENT' },
      { code: 'INTERNAL_ERROR' },
      { code: 'STORE_FAILED' },
      { code: 'UNKNOWN_CUSTOM_CODE' },
      { code: 'toString' },
      { code: 'constructor' },
      { omitCode: true },
    ];
    for (const args of unknownCases) {
      const res = await mcpCallTool(app, requestId++, 'trigger_error', args);
      assert.equal(res.statusCode, 200, `${JSON.stringify(args)}: ${res.body}`);
      const result = res.json().result;
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        error: {
          code: 'TOOL_EXECUTION_FAILED',
          message: 'Tool execution failed',
        },
      });
      assert.doesNotMatch(res.body, /SQLITE_CANTOPEN|ENOENT|STORE_FAILED|UNKNOWN_CUSTOM_CODE|center\.db|pboauth_secret|row-id-42|leaked-public-message/);
    }
  } finally {
    await app.close();
  }
});

test('HTTP adapter status spread maps required caller-fixable codes to 4xx and keeps unknown errors at 500 without leaking', async () => {
  const statusMap = { ...errorStatus, ...OPERATION_ERROR_STATUS };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (['OFFLINE', 'NOT_CONNECTED', 'DISCONNECTED', 'CONNECT_FAILED'].includes(code)) code = 'DEVICE_OFFLINE';
    if (!Object.hasOwn(statusMap, code)) code = 'INTERNAL_ERROR';
    reply.code(statusMap[code] || 500).send({
      error: {
        code,
        message: code === 'INTERNAL_ERROR' ? 'Internal error' : code.replaceAll('_', ' ').toLowerCase(),
      },
    });
  });
  app.post('/test-op', async (req) => {
    const err = new Error(LEAKY_SECRET_DETAIL);
    if (req.body?.code !== undefined) err.code = req.body.code;
    throw err;
  });
  await app.ready();

  try {
    for (const [code, expectedStatus] of Object.entries(REQUIRED_CALLER_FIXABLE_CODES)) {
      const res = await app.inject({
        method: 'POST',
        url: '/test-op',
        payload: { code },
      });
      assert.equal(res.statusCode, expectedStatus, `${code} HTTP status`);
      assert.deepEqual(res.json(), {
        error: {
          code,
          message: code.replaceAll('_', ' ').toLowerCase(),
        },
      });
      assert.doesNotMatch(res.body, /SQLITE_CANTOPEN|center\.db|pboauth_secret|row-id-42/);
    }

    for (const unknownPayload of [
      { code: 'SQLITE_CANTOPEN' },
      { code: 'ENOENT' },
      { code: 'STORE_FAILED' },
      { code: 'INTERNAL_ERROR' },
      { code: 'UNKNOWN_CUSTOM_CODE' },
      { code: 'toString' },
      {},
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/test-op',
        payload: unknownPayload,
      });
      assert.equal(res.statusCode, 500, `${JSON.stringify(unknownPayload)} must return 500`);
      assert.deepEqual(res.json(), {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal error',
        },
      });
      assert.doesNotMatch(res.body, /SQLITE_CANTOPEN|ENOENT|STORE_FAILED|UNKNOWN_CUSTOM_CODE|center\.db|pboauth_secret|row-id-42/);
    }
  } finally {
    await app.close();
  }
});
