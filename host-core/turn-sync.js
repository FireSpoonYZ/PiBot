function syncError(code, message) {
  return Object.assign(new Error(message), { code });
}

function offline() { return syncError('CENTER_OFFLINE', 'center is disconnected'); }
function invalid(message) { return syncError('INVALID_ARGUMENT', message); }
function invalidResponse(message) { return syncError('BAD_RESPONSE', message); }

const MAX_CODE_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 512;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

function assertText(value, name, max = MAX_MESSAGE_LENGTH) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`invalid ${name}`);
  return value;
}

function assertRequestBody(body, allowed, optional = new Set()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('turn request must be an object');
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw invalid(`turn request has unknown field: ${key}`);
    if (body[key] !== undefined) assertText(body[key], `turn request ${key}`, 1024);
  }
  for (const key of allowed) {
    if (!optional.has(key) && body[key] === undefined) throw invalid(`turn request missing ${key}`);
  }
  return body;
}

function assertGrant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('invalid turn admission grant');
  assertText(value.admissionId, 'grant admissionId', 256);
  assertText(value.setId, 'grant setId', 256);
  assertText(value.admittedAt, 'grant admittedAt', 64);
  return { admissionId: value.admissionId, setId: value.setId, admittedAt: value.admittedAt };
}

function assertPreparation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('invalid turn preparation');
  if (value.protocol !== 1) throw invalidResponse('unsupported turn preparation protocol');
  assertText(value.botId, 'preparation botId', 256);
  assertText(value.setId, 'preparation setId', 256);
  if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) throw invalidResponse('invalid turn preparation snapshot');
  if (!Array.isArray(value.plans)) throw invalidResponse('invalid turn preparation plans');
  const preparation = { protocol: 1, botId: value.botId, setId: value.setId, snapshot: value.snapshot, plans: value.plans };
  if (value.admission !== undefined && value.admission !== null) preparation.admission = assertGrant(value.admission);
  return preparation;
}

function assertTurnError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && CODE_PATTERN.test(err.code) &&
      typeof err.message === 'string' && err.message.length <= MAX_MESSAGE_LENGTH) {
    return syncError(err.code, err.message);
  }
  const code = typeof err?.code === 'string' && err.code.length <= MAX_CODE_LENGTH ? err.code : 'TURN_SYNC_FAILED';
  return syncError(code, 'turn synchronization failed');
}

// Installer plans arrive from Center already scoped to this Bot's desired set.
// Disable/uninstall actions are handled by the runtime admission lane; only
// artifact-backed plans need local file preparation here.
function isPreparedPlan(plan) {
  return plan && typeof plan === 'object' && typeof plan.installationId === 'string' &&
    plan.action !== 'disable' && plan.action !== 'uninstall';
}

function assertPlanIdentity(plan) {
  if (!plan || typeof plan !== 'object') throw invalid('invalid installation plan');
  assertText(plan.installationId, 'plan installationId', 256);
  if (plan.planId !== undefined) assertText(plan.planId, 'plan planId', 256);
  if (plan.digest !== undefined) assertText(plan.digest, 'plan digest', 256);
  return plan;
}

/**
 * Per-turn Center synchronization coordinator (contract §3).
 * getClient() must return the currently authenticated Host center client or null;
 * installer is the managed installer exposing prepare(). Connection replacement
 * across awaits is detected by comparing the captured client with getClient()
 * again before continuing or returning; there is no stale-connection fallback.
 */
export function createTurnSynchronizer({ getClient, installer } = {}) {
  if (typeof getClient !== 'function') throw invalid('getClient must be a function');
  if (!installer || typeof installer.prepare !== 'function') throw invalid('installer.prepare is required');

  const current = () => {
    const client = getClient();
    if (!client) throw offline();
    return client;
  };

  const checkAlive = (client) => {
    if (getClient() !== client) throw offline();
    return client;
  };

  // 保留原始取消原因：取消不伪装成离线错误，也不被静默吞掉。
  const checkSignal = (signal) => {
    if (signal?.aborted) throw signal.reason ?? syncError('ABORTED', 'turn synchronization aborted');
  };

  async function prepareTurn(input, options = {}) {
    checkSignal(options.signal);
    const body = assertRequestBody(input, new Set(['botId', 'requestId', 'scopeKey', 'inputDigest', 'knownSetId']), new Set(['knownSetId']));
    const client = current();
    let preparation;
    try {
      preparation = assertPreparation(await client.prepareTurn({
        botId: body.botId,
        requestId: body.requestId,
        scopeKey: body.scopeKey,
        inputDigest: body.inputDigest,
        ...(body.knownSetId === undefined ? {} : { knownSetId: body.knownSetId }),
      }, options));
    } catch (err) {
      if (options.signal?.aborted) { checkSignal(options.signal); throw err; }
      throw assertTurnError(err);
    }
    checkAlive(client);
    checkSignal(options.signal);

    // Prepare exactly the plans Center returned for this turn; never quiesce the
    // global registry, applyCenterSnapshot, or reenter runtime admission.
    for (const plan of preparation.plans) {
      if (!isPreparedPlan(plan)) continue;
      assertPlanIdentity(plan);
      try {
        await installer.prepare(plan, { signal: options.signal });
      } catch (err) {
        if (options.signal?.aborted) { checkSignal(options.signal); throw err; }
        throw assertTurnError(err);
      }
      checkAlive(client);
      checkSignal(options.signal);
    }
    return preparation;
  }

  async function confirmTurn(input, options = {}) {
    checkSignal(options.signal);
    const body = assertRequestBody(input, new Set(['botId', 'requestId', 'scopeKey', 'inputDigest', 'setId']));
    const client = current();
    let grant;
    try {
      grant = assertGrant(await client.confirmTurn({
        botId: body.botId,
        requestId: body.requestId,
        scopeKey: body.scopeKey,
        inputDigest: body.inputDigest,
        setId: body.setId,
      }, options));
    } catch (err) {
      if (options.signal?.aborted) { checkSignal(options.signal); throw err; }
      throw assertTurnError(err);
    }
    checkAlive(client);
    return grant;
  }

  async function restoreTurn(input, options = {}) {
    checkSignal(options.signal);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('restoreTurn input must be an object');
    for (const key of Object.keys(input)) {
      if (key !== 'botId' && key !== 'admissionId') throw invalid(`restoreTurn has unknown field: ${key}`);
    }
    const botId = assertText(input.botId, 'botId', 256);
    const admissionId = assertText(input.admissionId, 'admissionId', 256);
    const client = current();
    let preparation;
    try {
      preparation = assertPreparation(await client.restoreTurn({ botId, admissionId }, options));
    } catch (err) {
      if (options.signal?.aborted) { checkSignal(options.signal); throw err; }
      throw assertTurnError(err);
    }
    checkAlive(client);
    if (preparation.botId !== botId) throw invalidResponse('restored preparation bot mismatch');
    // 契约要求 restore 返回原准入授权，缺失说明服务端应答不完整。
    if (!preparation.admission || preparation.admission.admissionId !== admissionId) {
      throw invalidResponse('restored preparation missing admission grant');
    }
    checkSignal(options.signal);

    for (const plan of preparation.plans) {
      if (!isPreparedPlan(plan)) continue;
      assertPlanIdentity(plan);
      try {
        await installer.prepare(plan, { admissionId, signal: options.signal });
      } catch (err) {
        if (options.signal?.aborted) { checkSignal(options.signal); throw err; }
        throw assertTurnError(err);
      }
      checkAlive(client);
      checkSignal(options.signal);
    }
    return preparation;
  }

  return { prepareTurn, confirmTurn, restoreTurn };
}
