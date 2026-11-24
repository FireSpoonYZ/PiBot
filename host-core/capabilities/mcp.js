import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { defineTool } from '@earendil-works/pi-durable';
import { guardGoogleWorkspaceMcpCall, GOOGLE_WORKSPACE_MCP_INSTALLATION_ID as GOOGLE_WORKSPACE_INSTALLATION_ID } from '../google-workspace-privacy.js';
import { prepareGoogleFileCall, finishGoogleFileCall } from '../google-file-transfer.js';
import { projectToolPresentation } from '../tool-presentation.js';


const GOOGLE_BINARY_FIELD_KEYS = new Set([
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function hasBinaryTransferField(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return true;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasBinaryTransferField(item, depth + 1));
  if (isBinaryDownloadObject(value)) return true;
  for (const [key, item] of Object.entries(value)) {
    if (GOOGLE_BINARY_FIELD_KEYS.has(key) && item !== null && item !== undefined && item !== '') return true;
    if (hasBinaryTransferField(item, depth + 1)) return true;
  }
  return false;
}

function redactBinaryFields(value, keyName = '', depth = 0) {
  if (depth > 16) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `[binary omitted (${value.byteLength} bytes)]`;
  }
  if (typeof value === 'string') {
    if (GOOGLE_BINARY_FIELD_KEYS.has(keyName) && value.length > 0) {
      return '[binary payload omitted]';
    }
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactBinaryFields(item, '', depth + 1));
  const redactDataHere = isBinaryDownloadObject(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if ((GOOGLE_BINARY_FIELD_KEYS.has(key) || (redactDataHere && key === 'data' && typeof item === 'string')) && item !== null && item !== undefined && item !== '') {
      out[key] = '[binary payload omitted]';
      continue;
    }
    out[key] = redactBinaryFields(item, key, depth + 1);
  }
  return out;
}

function sanitizeGoogleMcpResultForLlm(result) {
  if (!isPlainObject(result)) {
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(redactBinaryFields(result)) }] };
  }
  const blocks = Array.isArray(result.content)
    ? result.content.map(block => {
      if (!isPlainObject(block)) return { type: 'text', text: '' };
      if (block.type === 'text' && typeof block.text === 'string') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'resource' && isPlainObject(block.resource) && typeof block.resource.text === 'string') {
        return { type: 'text', text: block.resource.text };
      }
      if (block.type === 'image' || block.type === 'audio' || block.type === 'resource') {
        return { type: 'text', text: `[${block.type} binary payload omitted; saved on Host when downloaded]` };
      }
      return { type: 'text', text: JSON.stringify(redactBinaryFields(block)) };
    })
    : [];
  const safeStructured = isPlainObject(result.structuredContent) ? redactBinaryFields(result.structuredContent) : undefined;
  return {
    content: blocks.length ? blocks : [{ type: 'text', text: safeStructured !== undefined ? JSON.stringify(safeStructured) : '' }],
    ...(safeStructured !== undefined ? { structuredContent: safeStructured } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

async function resolveBotCwd(host, botId, conversationId) {
  if (typeof host?.getHarness === 'function' && conversationId) {
    try {
      const conversation = await host.getHarness().conversation(conversationId, host.context);
      const agent = await conversation?.agent?.(host.context);
      if (typeof agent?.cwd === 'string' && agent.cwd) return agent.cwd;
    } catch {
      // Fall back to the Bot record cwd.
    }
  }
  const bot = typeof host?.host?.getBot === 'function' ? host.host.getBot(botId) : null;
  if (typeof bot?.cwd === 'string' && bot.cwd) return bot.cwd;
  return undefined;
}

function unwrapPreparedArgs(prepared, fallback) {
  if (prepared === undefined) return fallback;
  if (isPlainObject(prepared) && isPlainObject(prepared.args)
      && Object.keys(prepared).every(key => key === 'args' || key === 'meta' || key === 'transfer')) {
    return prepared.args;
  }
  return prepared;
}

function safeTransferErrorMessage(error, fallback) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'GOOGLE_FILE_TRANSFER_ERROR';
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim().slice(0, 400)
    : fallback;
  return JSON.stringify({ error: { code, message } });
}

async function finalizeGoogleToolResult(toolName, mcpResult, { transferOptions, args, finish }) {
  if (mcpResult?.isError === true) {
    return sanitizeGoogleMcpResultForLlm(mcpResult);
  }
  const finishOpts = { ...transferOptions, args };
  if (isPlainObject(mcpResult) && isPlainObject(mcpResult.structuredContent)) {
    let finished = await finish(toolName, mcpResult.structuredContent, finishOpts);
    if (finished === mcpResult.structuredContent && hasBinaryTransferField(mcpResult.structuredContent)) {
      finished = await finish(toolName, mcpResult, finishOpts);
    }
    if (isPlainObject(finished) && Array.isArray(finished.content)) {
      return sanitizeGoogleMcpResultForLlm(finished);
    }
    if (finished !== mcpResult.structuredContent) {
      if (typeof finished === 'string') {
        return { content: [{ type: 'text', text: finished }], isError: false };
      }
      const sanitized = redactBinaryFields(finished);
      return {
        content: [{ type: 'text', text: JSON.stringify(sanitized) }],
        ...(isPlainObject(sanitized) ? { structuredContent: sanitized } : {}),
        isError: false,
      };
    }
    return sanitizeGoogleMcpResultForLlm(mcpResult);
  }
  const finished = await finish(toolName, mcpResult, finishOpts);
  if (isPlainObject(finished) && Array.isArray(finished.content)) {
    return sanitizeGoogleMcpResultForLlm(finished);
  }
  if (typeof finished === 'string') {
    return { content: [{ type: 'text', text: finished }], isError: false };
  }
  const sanitized = redactBinaryFields(finished);
  return {
    content: [{ type: 'text', text: JSON.stringify(sanitized) }],
    ...(isPlainObject(sanitized) ? { structuredContent: sanitized } : {}),
    isError: false,
  };
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function credential(credentials, ref) {
  if (typeof credentials[ref] !== 'string') throw fail('MCP_CREDENTIAL_MISSING', 'MCP credential is unavailable.');
  return credentials[ref];
}

function applyRefs(values, refs, credentials) {
  const result = { ...values };
  for (const [name, ref] of Object.entries(refs ?? {})) result[name] = credential(credentials, ref);
  return result;
}

function packagePath(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || rel === '..' || rel.startsWith('..' + sep)) {
    throw fail('INVALID_ARGUMENT', 'MCP package entry must be within its package.');
  }
  return target;
}

async function transportFor(config, credentials, packageRoot) {
  const transport = config.transport ?? (config.url ? 'http' : 'stdio');
  if (transport === 'http') {
    if (config.oauth) throw fail('MCP_OAUTH_CENTER_REQUIRED', 'OAuth MCP must be hosted by the center.');
    const headers = { ...config.headers };
    for (const [name, ref] of Object.entries(config.headerRefs ?? {})) {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
      headers[name] = credential(credentials, ref);
    }
    if (config.apiKeyRef && !Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
      headers.Authorization = 'Bearer ' + credential(credentials, config.apiKeyRef);
    }
    return new StreamableHttpTransport({ url: config.url, headers });
  }
  if (transport !== 'stdio') throw fail('INVALID_ARGUMENT', 'Unsupported MCP transport.');
  let command = config.command;
  let args = config.args ?? [];
  if (!command) {
    const pkg = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
    const keys = Object.keys(bins);
    const selected = config.bin ?? (keys.length === 1 ? keys[0] : undefined);
    if (!selected || typeof bins[selected] !== 'string') {
      throw fail('MCP_BIN_REQUIRED', 'Select a package bin or configure a command.');
    }
    const entry = packagePath(packageRoot, bins[selected]);
    const script = await readFile(entry, 'utf8');
    if (!/\.(?:cjs|mjs|js)$/i.test(entry) && !/^#![^\r\n]*\bnode(?:\s|$)/.test(script)) {
      throw fail('MCP_BIN_UNSUPPORTED', 'Automatic MCP package bin must be JavaScript.');
    }
    command = process.execPath;
    args = [entry, ...args];
  }
  return new StdioTransport({
    command, args, cwd: config.cwd ?? packageRoot,
    env: applyRefs(config.env, config.envRefs, credentials), inheritEnv: true,
  });
}

export function mcpToolName(installationId, botId, remoteName) {
  const hash = createHash('sha256').update(JSON.stringify([installationId, botId, remoteName])).digest('hex');
  return 'mcp_' + hash.slice(0, 32);
}

export async function createMcpDriver({ installationId, version, target, dataBoundary, packageRoot, host, googleFileTransfer }) {
  const bots = new Set();
  const isGoogleWorkspace = target === 'center' && installationId === GOOGLE_WORKSPACE_INSTALLATION_ID;
  const prepareTransfer = googleFileTransfer?.prepareGoogleFileCall ?? prepareGoogleFileCall;
  const finishTransfer = googleFileTransfer?.finishGoogleFileCall ?? finishGoogleFileCall;
  return {
    async forBot(context) {
      const { botId, effectiveConfig, credentials } = context;
      const contributions = { tools: [] };
      let client;
      let active = false;
      let closed = false;
      const abort = new AbortController();
      const checkOpen = () => {
        if (closed) throw fail('MCP_CLOSED', 'MCP capability is closed.');
      };
      const check = () => {
        checkOpen();
        host.assertCapabilityAllowed(botId, installationId);
      };
      const listTools = async () => {
        check();
        if (!active) throw fail('MCP_CLOSED', 'MCP capability is not active.');
        let tools;
        try {
          tools = target === 'center'
            ? (await host.centerClient.listCapabilityTools(installationId, botId, { signal: abort.signal })).tools
            : await client.listTools();
        } catch {
          check();
          throw fail('MCP_UNAVAILABLE', 'MCP connection or tool listing failed.');
        }
        check();
        if (!active) throw fail('MCP_CLOSED', 'MCP capability is not active.');
        return { tools: tools.map(({ name, description, inputSchema }) => ({ name, ...(description ? { description } : {}), inputSchema })) };
      };
      const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
      const bot = {
        durableContributions: contributions,
        requestContributions: {},
        actions: {
          listTools: { inputSchema, execute: listTools },
          validate: { inputSchema, async execute() { await listTools(); return { ok: true, message: 'Connection successful' }; } },
        },
        async prepare() {
          checkOpen();
          let tools;
          try {
            if (target === 'center') {
              ({ tools } = await host.centerClient.listCapabilityTools(installationId, botId, { signal: abort.signal }));
            } else {
              const transport = await transportFor(effectiveConfig, credentials, packageRoot);
              client = new McpClient({ name: 'e-launcher', version, requestTimeoutMs: effectiveConfig.timeoutMs });
              await client.connect(transport);
              tools = await client.listTools();
            }
            checkOpen();
          } catch (error) {
            await client?.close();
            client = undefined;
            checkOpen();
            if (error?.code === 'MCP_OAUTH_CENTER_REQUIRED' || error?.code === 'MCP_CREDENTIAL_MISSING' ||
                error?.code === 'MCP_BIN_REQUIRED' || error?.code === 'MCP_BIN_UNSUPPORTED' ||
                error?.code === 'INVALID_ARGUMENT') throw error;
            throw fail('MCP_UNAVAILABLE', 'MCP connection or tool listing failed.');
          }
          contributions.tools = tools.map(tool => defineTool({
            name: mcpToolName(installationId, botId, tool.name),
            description: `MCP tool ${tool.name}: ${tool.description ?? ''}`,
            parameters: tool.inputSchema,
            deferred: true,
            replay: 'unsafe',
            async execute(args, api, invocation) {
              invocation.abortSignal?.throwIfAborted();
              check();
              const owner = await host.resolveConversationBot(api.conversationId);
              invocation.abortSignal?.throwIfAborted();
              check();
              if (owner !== botId) throw fail('MCP_FORBIDDEN', 'MCP tool is not available to this Bot.');
              if (!active) throw fail('MCP_CLOSED', 'MCP capability is not active.');
              // 内置 Center Google Workspace MCP：真实执行前原子持久化会话隐私隔离标记；
              // 标记失败则 fail-closed 拒调 Center，绝不以 tools/list 或默认可见触发标记。
              const privacyGuard = await guardGoogleWorkspaceMcpCall({
                installationId,
                target,
                dataBoundary,
                botId,
                conversationId: api.conversationId,
                callId: api.callId,
                taskId: api.taskId,
                host,
              });
              invocation.abortSignal?.throwIfAborted();
              check();
              if (!active) throw fail('MCP_CLOSED', 'MCP capability is not active.');
              const signal = invocation.abortSignal ? AbortSignal.any([invocation.abortSignal, abort.signal]) : abort.signal;
              const rawArgs = isPlainObject(args) ? args : {};
              let callArgs = args;
              let transferOptions;
              if (isGoogleWorkspace) {
                const cwd = await resolveBotCwd(host, botId, api.conversationId);
                const dataRoot = typeof host?.host?.dataRoot === 'string' && host.host.dataRoot ? host.host.dataRoot : undefined;
                transferOptions = {
                  cwd,
                  ...(dataRoot ? { dataRoot, botId } : {}),
                  signal,
                };
                invocation.abortSignal?.throwIfAborted();
                check();
                try {
                  const prepared = await prepareTransfer(tool.name, rawArgs, transferOptions);
                  callArgs = unwrapPreparedArgs(prepared, rawArgs);
                } catch (error) {
                  await privacyGuard.finish(invocation.abortSignal?.aborted ? 'aborted' : 'failed');
                  invocation.abortSignal?.throwIfAborted();
                  check();
                  return {
                    output: [{ type: 'text', text: safeTransferErrorMessage(error, 'Failed to prepare Google file transfer.') }],
                    isError: true,
                  };
                }
              }
              let result;
              try {
                result = target === 'center'
                  ? await host.centerClient.callCapabilityTool(installationId, botId, tool.name, callArgs, api.callId, { signal })
                  : await client.callTool(tool.name, callArgs, { signal, timeoutMs: effectiveConfig.timeoutMs });
                await privacyGuard.finish(result?.isError ? 'failed' : 'completed');
                invocation.abortSignal?.throwIfAborted();
                check();
              } catch (error) {
                const aborted = invocation.abortSignal?.aborted === true || abort.signal.aborted === true;
                await privacyGuard.finish(aborted ? 'aborted' : 'failed');
                invocation.abortSignal?.throwIfAborted();
                check();
                throw fail('MCP_CALL_FAILED', 'MCP call failed; external effects may have occurred.');
              }
              if (isGoogleWorkspace) {
                try {
                  const choices = result?.isError === true && result._meta?.['pibot/accountChoices'];
                  if (Array.isArray(choices) && typeof api.details === 'function') {
                    const presentation = projectToolPresentation({ presentation: {
                      kind: 'google-account-select', version: 1, installationId, botId,
                      status: 'pending', toolName: tool.name, accounts: choices,
                    } });
                    // The text error remains usable even when the live card cannot be delivered.
                    if (presentation) {
                      try { await api.details({ presentation }, invocation); } catch { /* advisory UI */ }
                    }
                  }
                  const finalized = await finalizeGoogleToolResult(tool.name, result, { transferOptions, args: rawArgs, finish: finishTransfer });
                  invocation.abortSignal?.throwIfAborted();
                  check();
                  return { output: toLlmContent(finalized), isError: finalized.isError === true };
                } catch (error) {
                  invocation.abortSignal?.throwIfAborted();
                  check();
                  return {
                    output: [{ type: 'text', text: safeTransferErrorMessage(error, 'Failed to finish Google file transfer.') }],
                    isError: true,
                  };
                }
              }
              return { output: toLlmContent(result), isError: result.isError === true };
            },
          }));
        },
        async activate() { checkOpen(); active = true; },
        async quiesce() { active = false; closed = true; abort.abort(); await client?.close(); },
        async close() { await bot.quiesce(); bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map(bot => bot.close())); },
  };
}
