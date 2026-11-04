import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { defineTool } from '@earendil-works/pi-durable';

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

export async function createMcpDriver({ installationId, version, target, packageRoot, host }) {
  const bots = new Set();
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
            replay: 'unsafe',
            async execute(args, api, invocation) {
              invocation.abortSignal?.throwIfAborted();
              check();
              const owner = await host.resolveConversationBot(api.conversationId);
              invocation.abortSignal?.throwIfAborted();
              check();
              if (owner !== botId) throw fail('MCP_FORBIDDEN', 'MCP tool is not available to this Bot.');
              if (!active) throw fail('MCP_CLOSED', 'MCP capability is not active.');
              const signal = invocation.abortSignal ? AbortSignal.any([invocation.abortSignal, abort.signal]) : abort.signal;
              try {
                const result = target === 'center'
                  ? await host.centerClient.callCapabilityTool(installationId, botId, tool.name, args, api.callId, { signal })
                  : await client.callTool(tool.name, args, { signal, timeoutMs: effectiveConfig.timeoutMs });
                invocation.abortSignal?.throwIfAborted();
                check();
                return { output: toLlmContent(result), isError: result.isError === true };
              } catch (error) {
                invocation.abortSignal?.throwIfAborted();
                check();
                throw fail('MCP_CALL_FAILED', 'MCP call failed; external effects may have occurred.');
              }
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
