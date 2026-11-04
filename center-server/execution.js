import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute, sep } from 'node:path';
import { McpClient, StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { adaptOAuthProvider } from '@earendil-works/pi-mcp/oauth';
import { assertPublicCredentialId } from './auth.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function openCenterExecution({ store, packages, oauth }) {
  const current = new Map();
  const entries = new Set();
  const active = new Map();
  const activating = new Set();

  function retire(entry) {
    entry.retired = true;
    if (current.get(entry.key) === entry) current.delete(entry.key);
    if (entry.users || entry.closing) return entry.closing;
    entry.closing = entry.promise.then(client => client.close(), () => {});
    entry.closing.finally(() => entries.delete(entry)).catch(() => {});
    return entry.closing;
  }

  /** Resolves credentials and headers/env for one config; shared by Bot-scoped use and global validation. */
  function materialize(config) {
    const credentials = {};
    for (const ref of [config.apiKeyRef, ...Object.values(config.headerRefs || {}), ...Object.values(config.envRefs || {})].filter(Boolean)) {
      assertPublicCredentialId(ref);
      credentials[ref] = store.resolveCredential(ref);
    }
    const headers = { ...config.headers };
    const env = { ...config.env };
    for (const [name, ref] of Object.entries(config.headerRefs || {})) {
      for (const old of Object.keys(headers)) if (old.toLowerCase() === name.toLowerCase()) delete headers[old];
      headers[name] = credentials[ref];
    }
    for (const [name, ref] of Object.entries(config.envRefs || {})) env[name] = credentials[ref];
    const authorization = Object.keys(headers).some(name => name.toLowerCase() === 'authorization');
    if (config.oauth === true && (!config.url || config.apiKeyRef || authorization)) fail('INVALID_ARGUMENT', 'OAuth requires HTTP without another authorization');
    if (config.apiKeyRef && !authorization) headers.Authorization = `Bearer ${credentials[config.apiKeyRef]}`;
    return { credentials, headers, env };
  }

  async function connect(installation, installed, config, { headers, env }, identity) {
    let transport;
    if (config.url) {
      const authProvider = config.oauth === true
        ? adaptOAuthProvider(await oauth.getAuthProvider({ installationId: installation.installationId, deviceId: identity.deviceId, botId: identity.botId, url: config.url }))
        : undefined;
      transport = new StreamableHttpTransport({ url: config.url, headers, authProvider });
    } else {
      let command = config.command;
      let args = config.args || [];
      if (!command) {
        const metadata = JSON.parse(await readFile(resolve(installed.packageRoot, 'package.json'), 'utf8'));
        const bins = typeof metadata.bin === 'string' ? { [metadata.name]: metadata.bin } : metadata.bin;
        const choices = Object.entries(bins || {});
        const bin = config.bin ? bins?.[config.bin] : choices.length === 1 ? choices[0][1] : null;
        if (!bin) fail('INVALID_ARGUMENT', 'MCP bin not specified');
        const binPath = resolve(installed.packageRoot, bin);
        if (!binPath.startsWith(resolve(installed.packageRoot) + sep)) fail('FORBIDDEN', 'Invalid MCP bin');
        command = process.execPath;
        args = [binPath, ...args];
      } else if (!isAbsolute(command)) command = resolve(installed.packageRoot, command);
      transport = new StdioTransport({ command, args, cwd: config.cwd ? resolve(installed.packageRoot, config.cwd) : installed.packageRoot, env: { PATH: process.env.PATH || '', ...env }, inheritEnv: false });
    }
    const client = new McpClient({ name: 'e-launcher-center', version: '1.0.0', requestTimeoutMs: config.timeoutMs });
    try { await client.connect(transport); return client; }
    catch (error) { await client.close(); throw error; }
  }

  async function use(deviceId, installationId, botId, work) {
    if (activating.has(installationId)) fail('INVALID_STATE', 'Capability updating');
    active.set(installationId, (active.get(installationId) || 0) + 1);
    let entry;
    try {
      const installation = store.getInstallation(installationId);
      if (!installation || installation.kind !== 'mcp' || installation.target !== 'center' || !store.isActive(installation) || !store.listDeviceBots(deviceId).some(bot => bot.botId === botId)) fail('FORBIDDEN', 'Capability unavailable');
      const binding = store.getBotCapability(deviceId, botId, installationId);
      if (!binding.enabled) fail('FORBIDDEN', 'Capability unavailable');
      const installed = await packages.getInstalled(installationId);
      if (!installed || installed.version !== installation.targetVersion) fail('INVALID_STATE', 'Capability not deployed');
      const config = binding.effectiveConfig;
      const { credentials, headers, env } = materialize(config);
      const key = JSON.stringify([deviceId, botId, installationId]);
      const fingerprint = JSON.stringify([installed.version, installation.revision, binding.revision, config, credentials]);
      entry = current.get(key);
      if (entry && entry.fingerprint !== fingerprint) { retire(entry); entry = undefined; }
      if (!entry) {
        const promise = connect(installation, installed, config, { headers, env }, { deviceId, botId });
        entry = { key, installationId, fingerprint, promise, users: 0, retired: false, closing: null };
        current.set(key, entry);
        entries.add(entry);
      }
      entry.users++;
      let client;
      try { client = await entry.promise; } catch (error) { retire(entry); throw error; }
      if (client.connectionState !== 'connected') { retire(entry); fail('INVALID_STATE', 'MCP connection closed'); }
      return await work(client);
    } finally {
      if (entry && entry.users) {
        entry.users--;
        if (entry.retired) retire(entry);
      }
      active.set(installationId, active.get(installationId) - 1);
    }
  }

  async function withActivation(installationId, publish) {
    if (activating.has(installationId) || active.get(installationId)) return false;
    activating.add(installationId);
    try {
      const closing = [];
      for (const entry of entries) if (entry.installationId === installationId) closing.push(retire(entry));
      await Promise.all(closing);
      await publish();
      return true;
    } finally { activating.delete(installationId); }
  }

  return {
    listTools(deviceId, id, input) {
      return use(deviceId, id, input.botId, async client => ({ tools: (await client.listTools()).map(({ name, description, inputSchema }) => ({ name, ...(description ? { description } : {}), inputSchema })) }));
    },
    /** Independent global validation: uses the global config only, never a Bot binding; one-shot connection. */
    async probeGlobal(installation, config, identity) {
      const installed = await packages.getInstalled(installation.installationId);
      if (!installed || installed.version !== installation.targetVersion) fail('INVALID_STATE', 'Capability not deployed');
      const { headers, env } = materialize(config);
      const client = await connect(installation, installed, config, { headers, env }, identity ?? {});
      try { return { tools: (await client.listTools()).map(({ name }) => ({ name })) }; }
      finally { await client.close(); }
    },
    callTool(deviceId, id, input) {
      return use(deviceId, id, input.botId, async client => {
        if (!(await client.listTools()).some(tool => tool.name === input.name)) fail('FORBIDDEN', 'Tool unavailable');
        return client.callTool(input.name, input.args);
      });
    },
    withActivation,
    async invalidate(deviceId, botId, installationId) {
      const entry = current.get(JSON.stringify([deviceId, botId, installationId]));
      if (entry) await retire(entry);
    },
    async close() {
      const closing = [...entries].map(retire);
      await Promise.all(closing);
    },
  };
}
