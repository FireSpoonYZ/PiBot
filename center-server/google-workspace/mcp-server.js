// Built-in Center-hosted Google Workspace MCP server & in-process transport adapter.
// Aggregates mailCalendarTools and fileTools behind a real @modelcontextprotocol/sdk
// Server connected to @earendil-works/pi-mcp McpClient over an InMemoryTransport bridge.
//
// Security invariants:
// - Exposes ONLY Google Workspace business tools (never account/OAuth/secret management).
// - Resolves the authorized GoogleApi per call via accounts.api(account) without guessing
//   when multiple accounts exist and without caching grants in Host snapshots.
// - Strips any model-supplied caller/actor/credential fields; trusted caller identity
//   flows solely through Center's authenticated AsyncLocalStorage context.
// - Never echoes binary/base64 transfer payloads or tokens/secrets into text content or errors.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '@earendil-works/pi-mcp';
import * as googleWorkspaceContract from '../../center-contract/google-workspace.js';
import { mailCalendarTools } from './mail-calendar-tools.js';
import { fileTools } from './file-tools.js';
import {
  GOOGLE_WORKSPACE_INSTALLATION_ID,
  GOOGLE_WORKSPACE_VERSION,
} from './constants.js';

export { GOOGLE_WORKSPACE_INSTALLATION_ID };

const FALLBACK_GOOGLE_ASSISTANT_ALLOWED_TOOLS = Object.freeze([
  'gmail_search',
  'gmail_read',
  'gmail_draft',
  'calendar_list',
  'calendar_get',
  'calendar_suggest-time',
  'contacts_find',
  'drive_search',
  'drive_list',
  'drive_read',
  'docs_read',
  'sheets_read',
]);

export const PROACTIVE_ASSISTANT_ALLOWED_TOOLS = Object.freeze(
  Array.isArray(googleWorkspaceContract.GOOGLE_ASSISTANT_ALLOWED_TOOLS)
    ? [...googleWorkspaceContract.GOOGLE_ASSISTANT_ALLOWED_TOOLS]
    : [...FALLBACK_GOOGLE_ASSISTANT_ALLOWED_TOOLS],
);

const ALLOWED_PROACTIVE_TOOLS = new Set(PROACTIVE_ASSISTANT_ALLOWED_TOOLS);

const FORBIDDEN_PROACTIVE_DRAFT_KEYS = Object.freeze([
  'to',
  'cc',
  'bcc',
  'replyAll',
  'forward',
  'draft',
  'attach',
  'attachments',
]);

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const AMBIGUOUS_ACCOUNT_CODES = new Set([
  'GOOGLE_ACCOUNT_AMBIGUOUS',
  'GOOGLE_MULTIPLE_ACCOUNTS',
  'MULTIPLE_ACCOUNTS',
  'AMBIGUOUS_ACCOUNT',
]);

// Model arguments must never supply caller/actor, execution-mode, or secret fields.
const FORBIDDEN_MODEL_ARG_KEYS = new Set([
  'askedBy',
  'caller',
  'actor',
  'botToken',
  'callerSessionId',
  'deviceId',
  'botId',
  'ownerKey',
  'owner',
  'oauthToken',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'authorization',
  'backgroundProactive',
  '__proto__',
  'constructor',
  'prototype',
]);

// Field names that may carry Host<->Center file transfer bytes (consumed by Host
// finishGoogleFileCall and never echoed into LLM text blocks).
const BINARY_PAYLOAD_KEYS = new Set([
  'base64',
  'contentBase64',
  'dataBase64',
  'bytesBase64',
  'fileBase64',
  'attachmentBase64',
  'bodyBase64',
  'binary',
  'bytes',
  'buffer',
  'rawBytes',
]);

const TRANSFER_CONTAINER_KEYS = new Set([
  'fileTransfer',
  'transfer',
  'download',
  'downloadTransfer',
  'attachmentTransfer',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function scrubGoogleSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\b1\/\/[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\bGOCSPX-[A-Za-z0-9._-]{6,}/g, '[redacted-secret]')
    .replace(/(["']?(?:client_secret|clientSecret|refresh_token|refreshToken|access_token|accessToken|id_token|idToken)["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi, '$1[redacted]');
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSchema(rawSchema) {
  const base = isPlainObject(rawSchema) ? structuredClone(rawSchema) : { type: 'object', properties: {} };
  if (base.type !== 'object') base.type = 'object';
  if (!isPlainObject(base.properties)) base.properties = {};
  if (!Object.prototype.hasOwnProperty.call(base.properties, 'account')) {
    base.properties.account = {
      type: 'string',
      description: 'Optional connected Google account email or ID (required when multiple Google accounts are connected).',
    };
  }
  return base;
}

function normalizeTools(rawTools) {
  const list = [];
  const byName = new Map();
  for (const tool of rawTools) {
    if (!tool || typeof tool !== 'object') {
      throw new Error('Google Workspace tool entry must be an object');
    }
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name || /\s/.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error(`Invalid Google Workspace tool name: ${String(tool.name)}`);
    }
    if (typeof tool.run !== 'function') {
      throw new Error(`Google Workspace tool "${name}" is missing a run() handler`);
    }
    if (byName.has(name)) {
      throw new Error(`Duplicate Google Workspace tool name: ${name}`);
    }
    const normalized = {
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: normalizeSchema(tool.inputSchema),
      run: tool.run,
    };
    list.push(normalized);
    byName.set(name, normalized);
  }
  return { list, byName };
}

function sanitizeModelArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return {};
  if (!isPlainObject(rawArgs)) {
    throw Object.assign(new Error('Tool arguments must be an object'), { code: 'INVALID_ARGUMENT' });
  }
  const clean = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    if (FORBIDDEN_MODEL_ARG_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function extractAccountArg(args) {
  const raw = args.account;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw Object.assign(new Error('account must be a string'), { code: 'INVALID_ARGUMENT' });
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 320 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw Object.assign(new Error('Invalid account identifier'), { code: 'INVALID_ARGUMENT' });
  }
  return trimmed;
}

const DOWNLOAD_TOOL_NAMES = new Set([
  'drive_download',
  'gmail_attachment',
  'gmail_read',
]);

function isBinaryDownloadObject(value) {
  return isPlainObject(value)
    && typeof value.data === 'string'
    && value.data.length > 0
    && (value.file !== undefined
      || value.name !== undefined
      || value.mimeType !== undefined
      || value.ref !== undefined
      || value.attachmentId !== undefined
      || value.size !== undefined);
}

function redactBinaryValue(value, keyName = '', depth = 0, forceRedactDataString = false) {
  if (depth > 16) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `[binary omitted (${value.byteLength} bytes)]`;
  }
  if (typeof value === 'string') {
    if ((BINARY_PAYLOAD_KEYS.has(keyName) || (forceRedactDataString && keyName === 'data')) && value.length > 0) {
      return '[binary payload omitted; handled by host file transfer]';
    }
    return scrubGoogleSecrets(value);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactBinaryValue(item, '', depth + 1, forceRedactDataString));
  }
  const redactDataHere = forceRedactDataString || isBinaryDownloadObject(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (BINARY_PAYLOAD_KEYS.has(key) || (redactDataHere && key === 'data' && typeof item === 'string' && item.length > 0)) {
      if (typeof item === 'string' && item.length > 0) {
        out[key] = '[binary payload omitted; handled by host file transfer]';
      } else if (item instanceof Uint8Array || Buffer.isBuffer(item)) {
        out[key] = `[binary omitted (${item.byteLength} bytes)]`;
      } else {
        out[key] = redactBinaryValue(item, key, depth + 1, forceRedactDataString);
      }
      continue;
    }
    if (TRANSFER_CONTAINER_KEYS.has(key) && isPlainObject(item)) {
      out[key] = redactBinaryValue(item, key, depth + 1, true);
      continue;
    }
    out[key] = redactBinaryValue(item, key, depth + 1, forceRedactDataString);
  }
  return out;
}

function isCallToolResultEnvelope(value) {
  return isPlainObject(value)
    && Array.isArray(value.content)
    && value.content.every((block) => isPlainObject(block) && typeof block.type === 'string');
}

function sanitizeContentBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({ type: 'text', text: scrubGoogleSecrets(block.text) });
    } else if (block.type === 'resource' && isPlainObject(block.resource)) {
      if (typeof block.resource.text === 'string') {
        result.push({ type: 'text', text: scrubGoogleSecrets(block.resource.text) });
      } else {
        result.push({ type: 'text', text: '[binary resource omitted; handled by host file transfer]' });
      }
    } else if (block.type === 'image' || block.type === 'audio') {
      result.push({ type: 'text', text: `[${block.type} payload omitted; handled by host file transfer]` });
    } else {
      result.push({ type: 'text', text: JSON.stringify(redactBinaryValue(block)) });
    }
  }
  return result.length ? result : [{ type: 'text', text: '' }];
}

function formatToolResult(rawResult, toolName = '') {
  const isDownloadTool = DOWNLOAD_TOOL_NAMES.has(toolName);
  if (rawResult === undefined || rawResult === null) {
    return { content: [{ type: 'text', text: '' }] };
  }
  if (typeof rawResult === 'string') {
    return { content: [{ type: 'text', text: scrubGoogleSecrets(rawResult) }] };
  }
  if (isCallToolResultEnvelope(rawResult)) {
    const out = {
      content: sanitizeContentBlocks(rawResult.content),
      ...(rawResult.isError === true ? { isError: true } : {}),
    };
    if (isPlainObject(rawResult.structuredContent)) {
      out.structuredContent = rawResult.structuredContent;
    }
    return out;
  }
  if (isPlainObject(rawResult)) {
    const safeForText = redactBinaryValue(rawResult, '', 0, isDownloadTool);
    return {
      content: [{ type: 'text', text: JSON.stringify(safeForText) }],
      structuredContent: rawResult,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(redactBinaryValue(rawResult, '', 0, isDownloadTool)) }],
  };
}

function safeAccountList(list) {
  if (!Array.isArray(list)) return undefined;
  const items = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim()) {
      items.push({ email: entry.trim() });
    } else if (isPlainObject(entry)) {
      const safe = {};
      if (typeof entry.id === 'string' && entry.id) safe.id = entry.id;
      if (typeof entry.email === 'string' && entry.email) safe.email = entry.email;
      if (entry.status === 'connected' || entry.status === 'reconnect') safe.status = entry.status;
      if (Object.keys(safe).length > 0) items.push(safe);
    }
  }
  return items.length ? items : undefined;
}

function filterAllowedAccountChoices(choices, allowedAccounts) {
  if (!Array.isArray(choices)) return undefined;
  if (!allowedAccounts) return choices.length ? choices : undefined;
  const filtered = choices.filter(
    (entry) => typeof entry?.email === 'string' && allowedAccounts.has(entry.email.toLowerCase()),
  );
  return filtered.length ? filtered : undefined;
}

export function resolveReadDraftPolicy(caller, getAssistantBinding) {
  if (typeof getAssistantBinding !== 'function') {
    return { restricted: false, allowedAccounts: null, mode: null };
  }
  const binding = getAssistantBinding();
  if (
    !binding
    || binding.enabled !== true
    || typeof caller?.deviceId !== 'string'
    || !caller.deviceId
    || typeof caller?.botId !== 'string'
    || !caller.botId
    || binding.deviceId !== caller.deviceId
    || binding.botId !== caller.botId
  ) {
    return { restricted: false, allowedAccounts: null, mode: null };
  }
  const restricted = binding.mode === 'dedicated'
    || (binding.mode === 'existing' && caller.backgroundProactive === true);
  if (!restricted) {
    return { restricted: false, allowedAccounts: null, mode: binding.mode ?? null };
  }
  const normalizedAccounts = Array.isArray(binding.accounts)
    ? binding.accounts
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim().toLowerCase())
    : [];
  const allowedAccounts = normalizedAccounts.length > 0 ? new Set(normalizedAccounts) : null;
  return {
    restricted: true,
    allowedAccounts,
    mode: binding.mode,
  };
}

async function formatToolError(err, accounts, allowedAccounts = null) {
  const rawCode = typeof err?.code === 'string' ? err.code : '';
  const code = SAFE_ERROR_CODE.test(rawCode) ? rawCode : 'GOOGLE_TOOL_ERROR';
  const rawMessage = typeof err?.message === 'string' && err.message.trim()
    ? err.message.trim()
    : 'Google Workspace tool call failed';
  const payload = {
    code,
    message: scrubGoogleSecrets(rawMessage).slice(0, 600),
  };
  if (typeof err?.service === 'string' && err.service.trim()) payload.service = err.service.trim();
  if (typeof err?.state === 'string' && err.state.trim()) payload.state = err.state.trim();
  if (typeof err?.account === 'string' && err.account.trim()) payload.account = err.account.trim();
  const enableUrl = safeHttpsUrl(err?.enableUrl);
  if (enableUrl) payload.enableUrl = enableUrl;
  let accountChoices = filterAllowedAccountChoices(
    safeAccountList(err?.accounts ?? err?.details?.accounts),
    allowedAccounts,
  );
  if (!accountChoices && AMBIGUOUS_ACCOUNT_CODES.has(code) && typeof accounts?.status === 'function') {
    try {
      const current = await accounts.status();
      accountChoices = filterAllowedAccountChoices(
        safeAccountList(current?.accounts),
        allowedAccounts,
      );
    } catch {
      // Do not mask the original error if status lookup fails.
    }
  }
  if (accountChoices) payload.accounts = accountChoices;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: payload }) }],
  };
}

/**
 * Creates a real @modelcontextprotocol/sdk Server serving all Google Workspace
 * business tools.
 */
export function createGoogleWorkspaceMcpServer({
  accounts,
  tools = [...mailCalendarTools, ...fileTools],
  getCaller = () => undefined,
  getAssistantBinding = null,
}) {
  if (!accounts || typeof accounts.api !== 'function') {
    throw new Error('Google Workspace accounts service with api() is required');
  }
  const { list, byName } = normalizeTools(tools);
  const server = new Server(
    { name: 'pibot-google-workspace', version: GOOGLE_WORKSPACE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const caller = getCaller?.() ?? {};
    const policy = resolveReadDraftPolicy(caller, getAssistantBinding);
    const visibleTools = policy.restricted
      ? list.filter((tool) => ALLOWED_PROACTIVE_TOOLS.has(tool.name))
      : list;
    return {
      tools: visibleTools.map(({ name, description, inputSchema }) => ({
        name,
        ...(description ? { description } : {}),
        inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request?.params?.name;
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown Google Workspace tool' } }) }],
      };
    }
    let policy = { restricted: false, allowedAccounts: null, mode: null };
    try {
      const caller = getCaller?.() ?? {};
      policy = resolveReadDraftPolicy(caller, getAssistantBinding);
      if (policy.restricted && !ALLOWED_PROACTIVE_TOOLS.has(tool.name)) {
        throw Object.assign(
          new Error(`Tool "${tool.name}" is disabled for proactive Google assistant`),
          { code: 'FORBIDDEN' },
        );
      }
      const cleanArgs = sanitizeModelArgs(request?.params?.arguments);
      if (policy.restricted) {
        if (tool.name === 'gmail_read' && (cleanArgs.download !== undefined || cleanArgs.out !== undefined)) {
          throw Object.assign(
            new Error('Attachment download to disk is disabled for proactive Google assistant'),
            { code: 'FORBIDDEN' },
          );
        }
        if (tool.name === 'gmail_draft') {
          const hasReplyTo = typeof cleanArgs.replyTo === 'string' && cleanArgs.replyTo.trim().length > 0;
          const hasForbiddenDraftField = FORBIDDEN_PROACTIVE_DRAFT_KEYS.some((key) => cleanArgs[key] !== undefined);
          if (!hasReplyTo || hasForbiddenDraftField) {
            throw Object.assign(
              new Error('Proactive assistant drafts are restricted to in-thread replies without altering recipients or attachments'),
              { code: 'FORBIDDEN' },
            );
          }
        }
      }
      const accountArg = extractAccountArg(cleanArgs);
      if (policy.restricted && policy.allowedAccounts && accountArg && accountArg.includes('@')) {
        if (!policy.allowedAccounts.has(accountArg.toLowerCase())) {
          throw Object.assign(
            new Error('Google account is not permitted for proactive Google assistant'),
            { code: 'FORBIDDEN' },
          );
        }
      }
      const effectiveAccountArg = policy.restricted && policy.allowedAccounts
        ? (accountArg ?? (policy.allowedAccounts.size === 1 ? [...policy.allowedAccounts][0] : undefined))
        : accountArg;
      let api;
      try {
        api = await accounts.api(effectiveAccountArg);
      } catch (error) {
        // Only Center account resolution, never tool output or document text, may offer account choices.
        if (error?.code !== 'GOOGLE_ACCOUNT_AMBIGUOUS' || effectiveAccountArg) throw error;
        const allowedSet = policy.restricted ? policy.allowedAccounts : null;
        const rawChoices = safeAccountList(error.accounts ?? error.details?.accounts);
        const choices = filterAllowedAccountChoices(rawChoices, allowedSet);
        const errorForFormat = allowedSet
          ? Object.assign(
              new Error(
                choices?.length
                  ? `Specify which allowed Google account to use (${choices.map((entry) => entry.email).filter(Boolean).join(', ')}).`
                  : 'Specify which allowed Google account to use.',
              ),
              { code: 'GOOGLE_ACCOUNT_AMBIGUOUS', accounts: choices ?? [] },
            )
          : error;
        const result = await formatToolError(errorForFormat, accounts, allowedSet);
        if (choices) result._meta = { 'pibot/accountChoices': choices.slice(0, 16) };
        return result;
      }
      if (policy.restricted && policy.allowedAccounts) {
        const resolvedEmail = typeof api?.email === 'string' ? api.email.trim().toLowerCase() : '';
        if (!resolvedEmail || !policy.allowedAccounts.has(resolvedEmail)) {
          throw Object.assign(
            new Error('Google account is not permitted for proactive Google assistant'),
            { code: 'FORBIDDEN' },
          );
        }
      }
      const toolContext = {
        api,
        signal: extra?.signal,
        ...(typeof caller.deviceId === 'string' ? { deviceId: caller.deviceId } : {}),
        ...(typeof caller.botId === 'string' ? { botId: caller.botId } : {}),
        ...(typeof caller.callId === 'string' ? { callId: caller.callId } : {}),
        ...(typeof caller.askedBy === 'string' && caller.askedBy.trim() ? { askedBy: caller.askedBy.trim() } : {}),
      };
      const result = await tool.run(cleanArgs, toolContext);
      return formatToolResult(result, tool.name);
    } catch (err) {
      return await formatToolError(err, accounts, policy.restricted ? policy.allowedAccounts : null);
    }
  });

  return server;
}

/**
 * Bridges an @modelcontextprotocol/sdk Server + InMemoryTransport pair to the
 * @earendil-works/pi-mcp McpTransport interface so openCenterExecution runs the
 * authentic MCP protocol (initialize, tools/list, tools/call) without spawning
 * external commands or exposing a public MCP port.
 */
function createInProcessMcpTransport(server) {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const messageListeners = new Set();
  const errorListeners = new Set();
  const closeListeners = new Set();
  let started = false;
  let closed = false;
  let closeEmitted = false;

  const emitClose = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    for (const listener of [...closeListeners]) {
      try { listener(); } catch { /* ignore listener errors */ }
    }
  };

  clientEnd.onmessage = (message) => {
    for (const listener of [...messageListeners]) {
      try { listener(message); } catch { /* ignore listener errors */ }
    }
  };
  clientEnd.onerror = (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const listener of [...errorListeners]) {
      try { listener(err); } catch { /* ignore listener errors */ }
    }
  };
  clientEnd.onclose = () => {
    closed = true;
    emitClose();
  };

  return {
    async start() {
      if (started) return;
      started = true;
      await server.connect(serverEnd);
      await clientEnd.start();
    },
    async send(message, options) {
      if (closed) throw new Error('In-process MCP transport is closed');
      if (options?.signal?.aborted) throw new Error('In-process MCP send aborted');
      await clientEnd.send(message);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await clientEnd.close();
      } finally {
        try { await server.close(); } catch { /* ignore close errors */ }
        emitClose();
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => { messageListeners.delete(listener); };
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => { errorListeners.delete(listener); };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    setProtocolVersion() {},
  };
}

/**
 * Creates the built-in Center execution adapter for Google Workspace MCP.
 * Reuses a single live McpClient <-> in-process Server pair while binding trusted
 * per-call identity via AsyncLocalStorage.
 */
export function createGoogleWorkspaceMcpAdapter({
  accounts,
  tools = [...mailCalendarTools, ...fileTools],
  requestTimeoutMs = 120_000,
  getAssistantBinding = null,
}) {
  // Validate tools eagerly so malformed definitions fail fast on startup.
  const normalized = normalizeTools(tools);
  const callerStore = new AsyncLocalStorage();
  let clientPromise = null;
  let closed = false;

  async function openClient() {
    if (closed) throw Object.assign(new Error('Google Workspace MCP adapter is closed'), { code: 'INVALID_STATE' });
    const server = createGoogleWorkspaceMcpServer({
      accounts,
      tools: normalized.list,
      getCaller: () => callerStore.getStore(),
      getAssistantBinding,
    });
    const transport = createInProcessMcpTransport(server);
    const client = new McpClient({
      name: 'pibot-center',
      version: GOOGLE_WORKSPACE_VERSION,
      requestTimeoutMs,
    });
    client.onClose(() => {
      if (clientPromise) {
        const current = clientPromise;
        current.then((resolved) => {
          if (resolved === client && clientPromise === current) clientPromise = null;
        }, () => {});
      }
    });
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async function getClient() {
    if (closed) throw Object.assign(new Error('Google Workspace MCP adapter is closed'), { code: 'INVALID_STATE' });
    if (!clientPromise) {
      const created = openClient();
      clientPromise = created;
      created.catch(() => {
        if (clientPromise === created) clientPromise = null;
      });
    }
    const client = await clientPromise;
    if (client.connectionState !== 'connected') {
      clientPromise = null;
      return getClient();
    }
    return client;
  }

  function runWithCaller(caller, fn) {
    return callerStore.run(caller ?? {}, fn);
  }

  async function close() {
    if (closed) return;
    closed = true;
    const pending = clientPromise;
    clientPromise = null;
    if (!pending) return;
    try {
      const client = await pending;
      await client.close();
    } catch {
      // Ignore startup/teardown errors during close.
    }
  }

  return {
    installationId: GOOGLE_WORKSPACE_INSTALLATION_ID,
    version: GOOGLE_WORKSPACE_VERSION,
    getClient,
    runWithCaller,
    close,
  };
}
