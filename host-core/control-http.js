// HTTP transport helpers for the local control server: bearer authz, bounded
// JSON body reads, and uniform JSON responses. No routing, server, or client.

import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const BEARER_PREFIX = 'Bearer ';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** Domain error code -> HTTP status (contract errorStatus table). */
export const errorStatus = Object.freeze({
  INVALID_ARGUMENT: 400,
  INVALID_CWD: 400,
  REQUEST_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  BOT_NOT_FOUND: 404,
  BOT_REQUEST_NOT_FOUND: 404,
  SUBMISSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  DELIVERY_NOT_FOUND: 404,
  SCOPE_NOT_FOUND: 404,
  SCOPE_FORBIDDEN: 403,
  SCOPE_UNMANAGED: 409,
  SCOPE_AUTHORITY_REQUIRED: 403,
  RESPONSE_TOO_LARGE: 413,
  STALE_INPUT: 409,
  WORK_STOPPED: 409,
  WORK_CONTEXT_INACTIVE: 409,
  CONTEXT_LIMIT: 409,
  WORK_GENERATION_FAILED: 500,
  STORE_FAILED: 500,
  WORK_CONTEXT_NOT_FOUND: 404,
  MODEL_REQUIRED: 409,
  MODEL_NOT_FOUND: 409,
  COMPACTION_FAILED: 500,
  RUNTIME_BUSY: 409,
  UNSUPPORTED_SCHEMA: 503,
  CONTROL_UNAVAILABLE: 503,
  HINDSIGHT_NOT_CONFIGURED: 503,
  HINDSIGHT_SHARED_DISABLED: 403,
  HINDSIGHT_CLOSED: 503,
  HINDSIGHT_UNAVAILABLE: 503,
  HINDSIGHT_AUTH_FAILED: 502,
  HINDSIGHT_NOT_FOUND: 404,
  HINDSIGHT_CONFLICT: 409,
  HINDSIGHT_INVALID_REQUEST: 400,
  HINDSIGHT_PROTOCOL_ERROR: 502,
  HINDSIGHT_STORE_FAILED: 503,
  HINDSIGHT_BINDING_MISMATCH: 409,
  EXTENSION_DISABLED: 409,
  EXTENSION_READ_ONLY: 403,
  SHOWER_UNAVAILABLE: 503,
  SHOWER_UNSUPPORTED: 409,
  SHOWER_BUSY: 409,
  SHOWER_AUTH_REQUIRED: 409,
  SHOWER_PERMISSION_REQUIRED: 403,
  SHOWER_SESSION_NOT_FOUND: 404,
  SHOWER_SESSION_MISMATCH: 409,
  SHOWER_NOT_READY: 409,
  SHOWER_INPUT_FAILED: 502,
  SHOWER_FRAME_TOO_LARGE: 413,
  SHOWER_CAPTURE_BLOCKED: 403,
  SHOWER_CAPTURE_TIMEOUT: 504,
  SHOWER_CAPTURE_FAILED: 502,
  SHOWER_BACKEND_FAILED: 502,
  CANCELLED: 409,
  INTERNAL: 500,
});

/** Error carrying an explicit HTTP status plus a stable error code. */
export class ControlHttpError extends Error {
  constructor(status, code, message = 'control request failed') {
    super(message);
    this.name = 'ControlHttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Validate the opaque token up front (call before opening any data root), then
 * return a per-request authorizer: throws ControlHttpError 403 for any Origin
 * header and 401 for missing/mismatched bearer tokens. Timing-safe compare.
 * The Authorization header is never logged or echoed.
 */
export function createControlAuthorizer(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'token must be a URL-safe opaque string of 32-512 characters');
  }
  const expected = Buffer.from(token, 'utf8');
  return function authorizeControlRequest(request) {
    if (request.headers.origin !== undefined) {
      throw new ControlHttpError(403, 'ORIGIN_FORBIDDEN', 'requests with an Origin header are not allowed');
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      throw new ControlHttpError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    }
    const provided = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ControlHttpError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    }
  };
}

/**
 * Read a request body as a plain JSON object. Empty body is allowed and yields
 * {}. Non-empty bodies must be Content-Type application/json (415), valid
 * UTF-8 (400), valid JSON (400), and a plain object (400). Bodies over 32 MiB
 * reject with 413 without destroying the connection, so the error response can
 * still flush; reading is paused and the caller closes with Connection: close.
 */
export async function readControlBody(request) {
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      if (size > MAX_BODY_BYTES) request.pause();
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      resolve(value);
    };
    const onError = (err) => fail(err); // kept attached after settle as a no-op
    const onAborted = () => fail(new Error('request aborted by client'));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new ControlHttpError(413, 'REQUEST_TOO_LARGE', 'request body exceeds 32 MiB limit'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      // request.complete false means the peer closed before the body finished.
      if (!request.complete) {
        fail(new Error('request aborted by client'));
        return;
      }
      if (size === 0) {
        succeed({});
        return;
      }
      if (mediaType(request) !== 'application/json') {
        fail(new ControlHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
        return;
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      } catch {
        fail(new ControlHttpError(400, 'INVALID_UTF8', 'request body is not valid UTF-8'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        fail(new ControlHttpError(400, 'INVALID_JSON', 'request body is not valid JSON'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail(new ControlHttpError(400, 'INVALID_BODY', 'request body must be a JSON object'));
        return;
      }
      succeed(parsed);
    };

    if (request.destroyed || request.readableAborted) {
      fail(new Error('request aborted by client'));
      return;
    }
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('error', onError);
  });
  return body;
}

function mediaType(request) {
  const header = request.headers['content-type'];
  if (typeof header !== 'string') return null;
  const semi = header.indexOf(';');
  return (semi === -1 ? header : header.slice(0, semi)).trim().toLowerCase();
}

/** Write a JSON body with no-store headers; no-op when the response is gone. */
export function writeControlJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Write the uniform error shape {error:{code,message}}. ControlHttpError keeps
 * its explicit status; domain codes map through errorStatus; anything else is
 * 500 with the original message (never a stack or token). A 413 left the body
 * unread, so respond with Connection: close so the connection is wound down.
 */
export function writeControlError(response, error) {
  if (response.destroyed || response.writableEnded) return;
  const { status, code, message } = normalizeControlError(error);
  const body = JSON.stringify({ error: { code, message } });
  const headers = {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
  };
  if (status === 413) headers.connection = 'close';
  response.writeHead(status, headers);
  response.end(body);
}

function normalizeControlError(error) {
  if (error instanceof ControlHttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'INTERNAL';
  const status = errorStatus[code] ?? 500;
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : 'internal error';
  return { status, code, message };
}
