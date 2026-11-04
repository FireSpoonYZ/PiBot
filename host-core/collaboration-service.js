import os from 'node:os';
import { collectBotDirectory } from './bot-directory.js';
import { openRemoteControl } from './remote-control-client.js';

function serviceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createCollaborationService({
  host,
  relay,
  createLocalBot,
  scheduleLocalTask,
  getLocalRuntime,
  getCenterClient,
  displayName,
  platform = process.platform,
}) {
  const fallbackName = displayName?.trim() || (platform !== 'android' && os.hostname().trim()) || `${platform}-${host.deviceId.slice(0, 8)}`;
  let currentName = fallbackName;
  let client = null;
  let connecting = null;
  let connectAbort = null;
  let refreshAbort = null;
  let refresh = null;
  let refreshWait = null;
  let nameFreshUntil = 0;
  let closed = false;

  async function connection() {
    if (closed || !relay) {
      const err = new Error('relay is not connected');
      err.code = 'NOT_CONNECTED';
      err.outcome = 'not-sent';
      throw err;
    }
    if (client) return client;
    if (!connecting) {
      connectAbort = new AbortController();
      connecting = openRemoteControl({ deviceId: host.deviceId, ...relay, signal: connectAbort.signal }).then((opened) => {
        if (closed) {
          opened.close();
          const err = new Error('collaboration service is closed');
          err.code = 'NOT_CONNECTED';
          err.outcome = 'not-sent';
          throw err;
        }
        client = opened;
        return opened;
      }).finally(() => { connecting = null; connectAbort = null; });
    }
    return connecting;
  }

  async function useClient(operation) {
    const active = await connection();
    try {
      return await operation(active);
    } catch (err) {
      if (['NOT_CONNECTED', 'DISCONNECTED', 'BAD_FRAME', 'REVOKED', 'UNAUTHORIZED'].includes(err?.code)) {
        if (client === active) client = null;
        active.close();
      }
      throw err;
    }
  }

  function localDevice() {
    return { deviceId: host.deviceId, displayName: currentName, platform, online: true, controlProtocol: 2, scopeProtocol: 1 };
  }

  function requireLocalRuntime() {
    const localRuntime = getLocalRuntime?.();
    if (!localRuntime) throw serviceError('NOT_CONNECTED', 'local runtime is not available');
    return localRuntime;
  }

  function requireCenterClient() {
    const center = getCenterClient?.();
    if (!center) throw serviceError('CENTER_OFFLINE', 'center is offline');
    return center;
  }

  async function listBots() {
    if (!relay) {
      return collectBotDirectory({
        listDevices: async () => ({ items: [localDevice()], nextCursor: null }),
        listBots: async () => host.listBots(),
      });
    }
    try {
      const snapshot = await collectBotDirectory({
        listDevices: (options) => useClient((active) => active.listDevices(options)),
        listBots: (deviceId) => deviceId === host.deviceId
          ? host.listBots()
          : useClient((active) => active.call(deviceId, 'listBots', {})),
      });
      const self = snapshot.devices.find((device) => device.deviceId === host.deviceId);
      if (self?.displayName) {
        currentName = self.displayName;
        nameFreshUntil = Date.now() + 5000;
      }
      if (!self || !self.online) {
        const device = self ?? localDevice();
        if (!self) snapshot.devices.push(device);
        snapshot.bots.push(...host.listBots().map((bot) => ({
          ...bot, description: bot.description ?? '', deviceName: currentName, platform, online: device.online,
        })));
      }
      return snapshot;
    } catch (err) {
      const local = await collectBotDirectory({
        listDevices: async () => ({ items: [localDevice()], nextCursor: null }),
        listBots: async () => host.listBots(),
      });
      local.errors.push({ deviceId: host.deviceId, code: err?.code ?? 'INTERNAL', message: 'Relay directory unavailable' });
      return local;
    }
  }

  async function createBot({ deviceId, requestId, name, description, modelRef, cwd, signal }) {
    const centerManaged = typeof getCenterClient === 'function';
    const input = {
      requestId,
      role: name,
      ...(description !== undefined ? { description } : {}),
      ...(!centerManaged && modelRef !== undefined ? { modelRef } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    let created;
    try {
      created = deviceId === host.deviceId
        ? await createLocalBot(input)
        : await useClient((active) => active.call(deviceId, 'createBot', input, { signal }));
    } catch (err) {
      err.requestId = requestId;
      throw err;
    }
    if (centerManaged && modelRef !== undefined && modelRef !== null) {
      await setBotModel({ deviceId, botId: created.botId, modelRef, signal });
      return { ...created, modelRef };
    }
    return created;
  }

  async function getBot({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      if (localRuntime?.getBot) return localRuntime.getBot(botId);
      const bot = host.getBot(botId);
      if (!bot) throw serviceError('BOT_NOT_FOUND', `bot not found: ${botId}`);
      return bot;
    }
    return useClient((active) => active.call(deviceId, 'getBot', { botId }, { signal }));
  }

  async function updateBotProfile({ deviceId, botId, name, description, signal }) {
    if (name === undefined && description === undefined) {
      throw serviceError('INVALID_ARGUMENT', 'at least one of name or description must be provided');
    }
    const input = {
      botId,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    };
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      return localRuntime?.updateBotProfile ? localRuntime.updateBotProfile(input) : host.updateBotProfile(input);
    }
    return useClient((active) => active.call(deviceId, 'updateBotProfile', input, { signal }));
  }

  async function getBotSoul({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      return localRuntime ? localRuntime.getBotSoul(botId) : host.getBotSoul(botId);
    }
    return useClient((active) => active.call(deviceId, 'getBotSoul', { botId }, { signal }));
  }

  async function setBotSoul({ deviceId, botId, text, expectedRevision, signal }) {
    let revision = expectedRevision;
    if (revision === undefined) {
      const current = await getBotSoul({ deviceId, botId, signal });
      revision = current.revision;
    }
    const input = { expectedRevision: revision, text };
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      return localRuntime ? localRuntime.setBotSoul(botId, input) : host.setBotSoul(botId, input);
    }
    return useClient((active) => active.call(deviceId, 'setBotSoul', { botId, input }, { signal }));
  }

  async function archiveBot({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      return localRuntime ? localRuntime.archiveBot(botId) : host.archiveBot({ botId });
    }
    return useClient((active) => active.call(deviceId, 'archiveBot', { botId }, { signal }));
  }

  async function unarchiveBot({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      return localRuntime ? localRuntime.unarchiveBot(botId) : host.unarchiveBot({ botId });
    }
    return useClient((active) => active.call(deviceId, 'unarchiveBot', { botId }, { signal }));
  }

  async function deleteBot({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      const localRuntime = getLocalRuntime?.();
      return localRuntime ? localRuntime.deleteBot(botId) : host.deleteBot({ botId });
    }
    return useClient((active) => active.call(deviceId, 'deleteBot', { botId }, { signal }));
  }

  async function abortBot({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      await requireLocalRuntime().abort(botId);
      return { botId };
    }
    return useClient((active) => active.call(deviceId, 'abort', { botId }, { signal }));
  }

  async function clearBotHistory({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      return requireLocalRuntime().clearHistory(botId);
    }
    return useClient((active) => active.call(deviceId, 'clearHistory', { botId }, { signal }));
  }

  async function compactBot({ deviceId, botId, signal }) {
    if (deviceId === host.deviceId) {
      return requireLocalRuntime().compact(botId);
    }
    return useClient((active) => active.call(deviceId, 'compact', { botId }, { signal }));
  }

  async function scheduleTask({ deviceId, botId, input, signal }) {
    if (deviceId === host.deviceId) {
      if (typeof scheduleLocalTask === 'function') {
        return scheduleLocalTask(botId, input);
      }
      const localRuntime = typeof getLocalRuntime === 'function' ? getLocalRuntime() : null;
      if (localRuntime?.scheduleTask) {
        return localRuntime.scheduleTask(botId, input);
      }
      const err = new Error('local runtime is not available');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    return useClient((active) => active.call(deviceId, 'scheduleTask', { botId, input }, { signal }));
  }

  async function getBotModel({ deviceId, botId, signal }) {
    const center = requireCenterClient();
    const config = await center.botModelGet(deviceId, botId, signal);
    let availableModels = [];
    try {
      const catalog = await getLocalRuntime?.()?.getModelCatalog?.();
      if (Array.isArray(catalog?.models)) availableModels = catalog.models;
    } catch { /* ignore catalog lookup failure */ }
    return { deviceId, botId, ...config, availableModels };
  }

  async function setBotModel({ deviceId, botId, modelRef, thinkingLevel, codemode, codemodeOnly, expectedRevision, signal }) {
    const center = requireCenterClient();
    let revision = expectedRevision;
    let currentOverrides = null;
    if (revision === undefined || modelRef === undefined || thinkingLevel === undefined || codemode === undefined || codemodeOnly === undefined) {
      const current = await center.botModelGet(deviceId, botId, signal);
      if (revision === undefined) revision = current.revision;
      currentOverrides = current.overrides ?? current.value ?? {};
    }
    const value = {};
    if (modelRef !== undefined) value.modelRef = modelRef;
    else if (currentOverrides && 'modelRef' in currentOverrides) value.modelRef = currentOverrides.modelRef;
    if (thinkingLevel !== undefined) value.thinkingLevel = thinkingLevel;
    else if (currentOverrides && 'thinkingLevel' in currentOverrides) value.thinkingLevel = currentOverrides.thinkingLevel;
    if (codemode !== undefined) value.codemode = codemode;
    else if (currentOverrides && 'codemode' in currentOverrides) value.codemode = currentOverrides.codemode;
    if (codemodeOnly !== undefined) value.codemodeOnly = codemodeOnly;
    else if (currentOverrides && 'codemodeOnly' in currentOverrides) value.codemodeOnly = currentOverrides.codemodeOnly;
    const updated = await center.botModelSet(deviceId, botId, { expectedRevision: revision, value }, signal);
    return { deviceId, botId, ...updated };
  }

  async function getBotCapabilities({ deviceId, botId, signal }) {
    const center = requireCenterClient();
    const capabilities = await center.botCapabilitiesGet(deviceId, botId, signal);
    return { deviceId, botId, capabilities };
  }

  async function setBotCapability({
    deviceId,
    botId,
    installationId,
    enabled,
    overrides,
    expectedRevision,
    signal,
  }) {
    if (enabled === undefined && overrides === undefined) {
      throw serviceError('INVALID_ARGUMENT', 'at least one of enabled or overrides must be provided');
    }
    const center = requireCenterClient();
    let revision = expectedRevision;
    let nextEnabled = enabled;
    let nextOverrides = overrides;
    if (revision === undefined || nextEnabled === undefined || nextOverrides === undefined) {
      const items = await center.botCapabilitiesGet(deviceId, botId, signal);
      const entry = Array.isArray(items)
        ? items.find((item) => (item.installation?.installationId ?? item.config?.installationId) === installationId)
        : null;
      if (!entry) throw serviceError('NOT_FOUND', `capability installation not found: ${installationId}`);
      if (revision === undefined) revision = entry.config?.revision ?? 0;
      if (nextEnabled === undefined) nextEnabled = Boolean(entry.config?.enabled);
      if (nextOverrides === undefined) nextOverrides = entry.config?.overrides ?? {};
    }
    const updated = await center.botCapabilitySet(deviceId, botId, installationId, {
      expectedRevision: revision,
      enabled: nextEnabled,
      overrides: nextOverrides,
    }, signal);
    return { deviceId, botId, installationId, ...updated };
  }

  async function putBotFileChunk({ deviceId, botId, input, signal }) {
    if (deviceId === host.deviceId) return requireLocalRuntime().putBotFileChunk(botId, input);
    return useClient((active) => active.call(deviceId, 'putBotFileChunk', { botId, ...input }, { signal }));
  }

  async function getCurrentDevice() {
    if (relay && !closed && Date.now() >= nameFreshUntil) {
      if (!refresh) {
        refreshAbort = new AbortController();
        const signal = refreshAbort.signal;
        refresh = (async () => {
          try {
            let cursor = null;
            do {
              const page = await useClient((active) => active.listDevices({ limit: 200, cursor, signal }));
              const self = page.items.find((device) => device.deviceId === host.deviceId);
              if (self) {
                if (!closed && !signal.aborted && self.displayName) currentName = self.displayName;
                if (!closed && !signal.aborted) nameFreshUntil = Date.now() + 5000;
                break;
              }
              cursor = page.nextCursor;
            } while (cursor !== null);
          } catch { /* Keep the last known name when the relay is unavailable. */ }
        })();
        refreshWait = new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          refresh.then(() => { clearTimeout(timer); resolve(); });
        });
        refresh.then(() => { refresh = null; refreshWait = null; refreshAbort = null; });
      }
      await refreshWait;
    }
    return { deviceId: host.deviceId, displayName: currentName, platform, arch: process.arch };
  }

  async function close() {
    closed = true;
    connectAbort?.abort();
    refreshAbort?.abort();
    if (client) {
      client.close();
      client = null;
    }
    if (connecting) {
      try { await connecting; } catch { /* Opening a client is cancelled by closure. */ }
    }
  }

  return {
    listBots,
    createBot,
    getBot,
    updateBotProfile,
    getBotSoul,
    setBotSoul,
    archiveBot,
    unarchiveBot,
    deleteBot,
    abortBot,
    clearBotHistory,
    compactBot,
    scheduleTask,
    getBotModel,
    setBotModel,
    getBotCapabilities,
    setBotCapability,
    putBotFileChunk,
    getCurrentDevice,
    close,
  };
}
