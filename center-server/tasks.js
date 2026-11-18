import { randomUUID } from 'node:crypto';

const DISPATCHER_BOT_NAME = '任务分派';
const DISPATCHER_BOT_DESCRIPTION = '全局任务分派协调 Bot：根据需求描述与各设备在线 Bot 的职责能力，通过 assign 决定由哪位 Bot 作为任务负责人。';

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ARGUMENT', 'Expected an object');
  }
  return value;
}

function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail('INVALID_ARGUMENT', 'Unknown field');
  }
  return value;
}

function receiptInput(value) {
  const body = fields(value, ['status', 'error']);
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(body.status)) {
    fail('INVALID_ARGUMENT', 'Invalid task dispatch receipt');
  }
  if (body.error !== undefined && body.error !== null && typeof body.error !== 'string') {
    fail('INVALID_ARGUMENT', 'Invalid task dispatch error');
  }
  return {
    status: body.status,
    ...(body.error !== undefined ? { error: body.error } : {}),
  };
}

function listInputFromQuery(query) {
  const input = { action: 'list' };
  if (query?.status !== undefined) input.status = String(query.status);
  if (query?.botDeviceId !== undefined) input.botDeviceId = String(query.botDeviceId);
  if (query?.botId !== undefined) input.botId = String(query.botId);
  if (query?.limit !== undefined && query.limit !== '') {
    const parsed = Number(query.limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1) fail('INVALID_ARGUMENT', 'Invalid limit');
    input.limit = parsed;
  }
  if (query?.cursor !== undefined && query.cursor !== '') {
    const rawCursor = String(query.cursor).trim();
    if (rawCursor === 'null') {
      input.cursor = null;
    } else {
      try {
        input.cursor = JSON.parse(rawCursor);
      } catch {
        fail('INVALID_ARGUMENT', 'Invalid cursor');
      }
    }
  }
  return input;
}

async function handleTaskAction(reply, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === 'TASK_NOT_FOUND') {
      return reply.code(404).send({
        error: { code: 'TASK_NOT_FOUND', message: err.message || 'Task not found' },
      });
    }
    throw err;
  }
}

export function registerTaskRoutes({ route, host, store, bridge, packages, notify, notifyConfig, notifyTaskReady, isAbsolutePath }) {
  let ensurePromise = null;
  let reconcilePromise = null;
  let reconcileAgain = false;
  const pendingReconcileDeviceIds = new Set();

  const sendConfigNotify = (deviceId) => {
    if (!deviceId) return;
    if (typeof notifyConfig === 'function') notifyConfig(deviceId);
    else if (typeof notify === 'function') notify(deviceId, 'config-changed');
  };

  const sendTaskReadyNotify = (deviceId) => {
    if (!deviceId) return;
    if (typeof notifyTaskReady === 'function') notifyTaskReady(deviceId);
    else if (typeof notify === 'function') notify(deviceId, 'task-ready');
  };

  function devicesWithMeta() {
    const listed = typeof bridge?.listDevices === 'function' ? bridge.listDevices() : [];
    const registryDevices = typeof bridge?.registry?.list === 'function' ? bridge.registry.list() : [];
    if (!registryDevices.length) return listed;
    const regById = new Map(registryDevices.map((item) => [item.deviceId, item]));
    return listed.map((device) => {
      const reg = regById.get(device.deviceId);
      if (!reg) return device;
      return {
        ...device,
        ...(typeof reg.platform === 'string' && !device.platform ? { platform: reg.platform } : {}),
        ...(typeof reg.displayName === 'string' && !device.name ? { name: reg.displayName } : {}),
      };
    });
  }

  function notifyTargets(targetDeviceIds) {
    if (!Array.isArray(targetDeviceIds) || !targetDeviceIds.length) return;
    for (const deviceId of new Set(targetDeviceIds)) {
      if (deviceId) sendTaskReadyNotify(deviceId);
    }
  }

  async function ensureDispatcher() {
    const existing = store.getActiveTaskDispatcher?.();
    if (existing) return existing;
    if (ensurePromise) return ensurePromise;

    ensurePromise = (async () => {
      try {
        const recheck = store.getActiveTaskDispatcher?.();
        if (recheck) return recheck;

        const devices = devicesWithMeta();
        const onlineDevices = devices.filter((device) => device && device.online && typeof device.deviceId === 'string' && device.deviceId);
        if (!onlineDevices.length) return null;

        const candidate = store.findExistingDispatcherBot?.(onlineDevices.map((device) => device.deviceId));
        if (candidate) {
          return store.setTaskDispatcher(candidate);
        }

        for (const device of onlineDevices) {
          try {
            const created = await bridge.call(device.deviceId, 'createBot', {
              requestId: `task-dispatcher-${randomUUID()}`,
              role: DISPATCHER_BOT_NAME,
              description: DISPATCHER_BOT_DESCRIPTION,
              makePrimary: false,
            });
            const botId = typeof created?.botId === 'string' ? created.botId.trim() : '';
            if (!botId) continue;

            const name = typeof created?.name === 'string' && created.name.trim()
              ? created.name.trim()
              : (typeof created?.role === 'string' && created.role.trim() ? created.role.trim() : DISPATCHER_BOT_NAME);
            let bot = store.upsertDeviceBot(device.deviceId, {
              ...created,
              deviceId: device.deviceId,
              botId,
              name,
              isPrimary: false,
            });

            if (bot.cwd === undefined && typeof created?.cwd === 'string' && typeof isAbsolutePath === 'function' && isAbsolutePath(created.cwd)) {
              try {
                bot = store.upsertDeviceBot(device.deviceId, { botId: bot.botId, name: bot.name }, { kind: 'cwd', expectedRevision: 0, value: created.cwd });
              } catch (err) {
                if (err?.code !== 'REVISION_CONFLICT') throw err;
                bot = store.upsertDeviceBot(device.deviceId, { botId: bot.botId, name: bot.name });
              }
            }

            const persisted = store.setTaskDispatcher({ deviceId: device.deviceId, botId: bot.botId });
            if (packages?.reconcileDevice) {
              await packages.reconcileDevice(device.deviceId);
            }
            sendConfigNotify(device.deviceId);
            return persisted;
          } catch {
            // Try the next online Host if this one rejects or disconnects mid-call.
          }
        }
        return null;
      } finally {
        ensurePromise = null;
      }
    })();

    return ensurePromise;
  }

  function reconcilePendingTasks(deviceIdHint = null) {
    if (deviceIdHint) {
      pendingReconcileDeviceIds.add(deviceIdHint);
    }
    if (reconcilePromise) {
      reconcileAgain = true;
      return reconcilePromise;
    }
    reconcilePromise = (async () => {
      try {
        do {
          reconcileAgain = false;
          const hints = [...pendingReconcileDeviceIds];
          pendingReconcileDeviceIds.clear();
          if (store.hasUnassignedTasks?.()) {
            await ensureDispatcher();
            const targetDeviceIds = store.claimUnassignedTasks?.({
              devices: devicesWithMeta(),
            }) || [];
            notifyTargets(targetDeviceIds);
          }
          for (const hint of hints) {
            if (store.hasPendingDispatches?.(hint)) {
              sendTaskReadyNotify(hint);
            }
          }
        } while (reconcileAgain);
      } finally {
        reconcilePromise = null;
      }
    })();
    return reconcilePromise;
  }

  route('GET', '/api/tasks', (req, reply) => handleTaskAction(reply, () => {
    const { result } = store.executeTaskAction(listInputFromQuery(req.query), {
      actor: { kind: 'owner' },
      devices: devicesWithMeta(),
    });
    return result;
  }));

  route('POST', '/api/tasks/action', (req, reply) => handleTaskAction(reply, async () => {
    const body = object(req.body);
    if (body.action === 'create' && body.coordinatorBotId === undefined && body.coordinatorDeviceId === undefined) {
      await ensureDispatcher();
    }
    const { result, targetDeviceIds } = store.executeTaskAction(body, {
      actor: { kind: 'owner' },
      devices: devicesWithMeta(),
    });
    notifyTargets(targetDeviceIds);
    return result;
  }), true);

  host('POST', '/api/host/tasks/action', (req, reply) => handleTaskAction(reply, async () => {
    const body = object(req.body);
    const actorBotId = typeof body.actorBotId === 'string' && body.actorBotId.trim()
      ? body.actorBotId.trim()
      : null;
    if (!actorBotId && body.action === 'create' && body.coordinatorBotId === undefined && body.coordinatorDeviceId === undefined) {
      await ensureDispatcher();
    }
    const actor = actorBotId
      ? { kind: 'bot', deviceId: req.centerDevice.deviceId, botId: actorBotId }
      : { kind: 'host', deviceId: req.centerDevice.deviceId };
    const { result, targetDeviceIds } = store.executeTaskAction(body, {
      actor,
      devices: devicesWithMeta(),
    });
    notifyTargets(targetDeviceIds);
    return result;
  }), 256 * 1024);

  host('POST', '/api/host/task-dispatches/poll', (req) => {
    const body = fields(req.body ?? {}, ['cursor']);
    const deviceId = req.centerDevice.deviceId;
    const result = store.pollTaskDispatches(deviceId, body.cursor ?? null, {
      devices: devicesWithMeta(),
    });
    void reconcilePendingTasks(deviceId).catch(() => {});
    return result;
  });

  host('POST', '/api/host/task-dispatches/:id/receipt', (req) => {
    const input = receiptInput(req.body);
    return store.reportTaskDispatch(req.centerDevice.deviceId, req.params.id, input);
  });

  return {
    ensureDispatcher,
    reconcilePendingTasks,
  };
}
