#!/usr/bin/env node
// scripts/verify-antigravity-center.mjs — Lane 5 Center HTTP + Host Provider E2E acceptance check.
// Scope: Center HTTP + Host Provider tool round-trip using real `openCenterServer`,
// real `openHost`, real `connectCenter`, unmodified `applyCenterModels(snapshot)`,
// Host `createReadTool()`, and real `agy`. Does NOT start the full `pi-durable` Harness
// or an HTTPS/WSS reverse-proxy TLS terminator (exercises local loopback HTTP APIs directly).
//
// Usage:
//   PIBOT_AGY_HOME=/path/to/logged-in-dedicated-gemini node scripts/verify-antigravity-center.mjs
//   PIBOT_AGY_BIN=/usr/local/bin/agy PIBOT_AGY_HOME=... node scripts/verify-antigravity-center.mjs

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCenterServer } from '../center-server/server.js';
import { hashOwnerPassword } from '../center-server/config.js';
import { openHost } from '../host-core/host.js';
import { connectCenter } from '../host-core/center-client.js';
import { applyCenterModels } from '../host-core/runtime-models.js';
import { createHostExecutionEnv } from '../host-core/host-environment.js';
import { createReadTool } from '../host-core/node_modules/@earendil-works/pi-durable/dist/tools/index.js';
import { BACKGROUND_CONTEXT } from '../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { getSupportedThinkingLevels } from '../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { createInitialSystemMessage, toToolDeclaration } from '../host-core/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js';

const PROVIDER_ID = 'antigravity';
const MODEL_API = 'pibot-antigravity-acp';
const CENTER_PLATFORM_BY_NODE = Object.freeze({
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
  android: 'android',
});

function mapDevicePlatform(nodePlatform) {
  const mapped = CENTER_PLATFORM_BY_NODE[nodePlatform];
  assert.ok(mapped, `Unsupported host platform for Center device registration: ${nodePlatform}`);
  return mapped;
}

function parseTimeoutMs() {
  const raw = process.env.PIBOT_AGY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return 120_000;
  const parsed = Number(raw);
  assert.ok(Number.isInteger(parsed) && parsed > 0, 'PIBOT_AGY_TIMEOUT_MS must be a positive integer');
  return parsed;
}

function assertNotDailyGeminiHome(geminiHome) {
  const dailyGemini = path.resolve(os.homedir(), '.gemini');
  const candidate = existsSync(geminiHome) ? realpathSync(geminiHome) : path.resolve(geminiHome);
  const dailyResolved = existsSync(dailyGemini) ? realpathSync(dailyGemini) : dailyGemini;
  assert.notEqual(
    candidate,
    dailyResolved,
    'Refusing to use daily ~/.gemini profile; provide an isolated PIBOT_AGY_HOME directory',
  );
}

function extractText(message) {
  return (message.content ?? [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function createOwnerHttpClient(baseUrl, timeoutMs) {
  const cookies = new Map();
  let csrfToken = '';

  const absorbCookies = (headers) => {
    const rawList = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of rawList) {
      const pair = String(raw).split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies.set(pair.slice(0, eq).trim(), pair.trim());
      }
    }
  };

  const cookieHeader = () => Array.from(cookies.values()).join('; ');

  async function request(method, pathname, body) {
    const headers = {};
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD') {
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    absorbCookies(res.headers);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const code = json?.error?.code ? ` ${json.error.code}` : '';
      const msg = json?.error?.message ? `: ${json.error.message}` : '';
      throw new Error(`Center HTTP ${method} ${pathname} failed (${res.status}${code})${msg}`);
    }
    if (json && typeof json.csrfToken === 'string' && json.csrfToken) {
      csrfToken = json.csrfToken;
    }
    return json;
  }

  return {
    request,
    async login(password) {
      await request('GET', '/api/session');
      const loginRes = await request('POST', '/api/session', { password });
      assert.equal(loginRes?.authenticated, true, 'owner login must authenticate');
      const verifyRes = await request('GET', '/api/session');
      assert.equal(verifyRes?.authenticated, true, 'owner session cookie must stay authenticated');
    },
  };
}

async function consumeStream(stream) {
  assert.ok(stream && typeof stream[Symbol.asyncIterator] === 'function', 'stream must be AsyncIterable');
  assert.equal(typeof stream.result, 'function', 'stream must provide result()');
  const eventTypes = [];
  for await (const event of stream) {
    assert.ok(event && typeof event.type === 'string', 'stream event must have type');
    eventTypes.push(event.type);
  }
  const message = await stream.result();
  assert.ok(message && message.role === 'assistant', 'stream.result() must return AssistantMessage');
  return { message, eventTypes };
}

async function runHostProviderTurnWithTools({
  models,
  model,
  sessionId,
  messages,
  reasoning,
  hostEnv,
  readTool,
  timeoutMs,
  maxToolRounds = 4,
}) {
  let toolExecutions = 0;
  let sawToolUse = false;

  for (let round = 0; round < maxToolRounds; round++) {
    const stream = models.streamSimple(
      model,
      { messages },
      { sessionId, reasoning, signal: AbortSignal.timeout(timeoutMs) },
    );
    const { message, eventTypes } = await consumeStream(stream);
    if (message.stopReason === 'error') {
      throw new Error(
        `Antigravity HTTP stream failed: ${message.errorMessage || 'unknown error'} (stopReason=${message.stopReason}, eventTypes=[${eventTypes.join(', ')}])`,
      );
    }
    assert.ok(
      eventTypes.includes('start'),
      `stream must emit start before completion (stopReason=${message.stopReason}, eventTypes=[${eventTypes.join(', ')}])`,
    );

    messages.push(message);
    if (message.stopReason !== 'toolUse') {
      return { message, toolExecutions, sawToolUse };
    }

    sawToolUse = true;
    const toolCalls = (message.content ?? []).filter((block) => block.type === 'toolCall');
    assert.ok(toolCalls.length > 0, 'toolUse response must contain at least one toolCall block');

    for (const tc of toolCalls) {
      assert.equal(tc.name, 'read', `unexpected toolCall '${tc.name}'; only host 'read' was declared`);
      const result = await readTool.execute(tc.arguments, { env: hostEnv }, BACKGROUND_CONTEXT);
      toolExecutions += 1;
      const content = Array.isArray(result.output) && result.output.length > 0
        ? result.output
        : [{ type: 'text', text: String(result.structuredOutput ?? '') }];
      messages.push({
        role: 'toolResult',
        toolCallId: tc.id,
        toolName: tc.name,
        content,
        ...(result.details !== undefined ? { details: result.details } : {}),
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  throw new Error(`Exceeded maxToolRounds (${maxToolRounds}) without terminal assistant response`);
}

function selectModelAndReasoning(models, preferredId) {
  const valid = models.filter((model) => {
    assert.equal(typeof model.id, 'string', 'model.id must be a string');
    assert.ok(model.id.length > 0, 'model.id must be non-empty');
    assert.equal(model.provider, PROVIDER_ID, `expected provider=${PROVIDER_ID}`);
    assert.equal(model.api, MODEL_API, `expected api=${MODEL_API}`);
    return true;
  });
  assert.ok(valid.length > 0, 'applyCenterModels returned zero antigravity models');
  const primaryModel = (preferredId && valid.find((m) => m.id === preferredId)) ?? valid[0];
  const levels = getSupportedThinkingLevels(primaryModel);
  assert.ok(levels.length > 0, `no supported thinking levels for ${primaryModel.id}`);
  return { primaryModel, reasoning: levels[0] };
}

async function run() {
  const timeoutMs = parseTimeoutMs();
  const externalGeminiHome = process.env.PIBOT_AGY_HOME?.trim() || undefined;
  if (externalGeminiHome) {
    assertNotDailyGeminiHome(externalGeminiHome);
  }

  const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-center-e2e-')));
  const centerDataRoot = path.join(tempRoot, 'center-data');
  const hostDataRoot = path.join(tempRoot, 'host-data');
  const hostWorkDir = path.join(tempRoot, 'host-workspace');
  mkdirSync(centerDataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(hostDataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(hostWorkDir, { recursive: true, mode: 0o700 });

  const hostEnv = createHostExecutionEnv({ cwd: hostWorkDir });
  const readTool = createReadTool();
  const readDecl = toToolDeclaration(readTool);

  let center;
  let client;
  let primaryError = null;

  console.log(
    '[SCOPE] Center HTTP + Host Provider tool round-trip (openCenterServer + connectCenter + applyCenterModels + Host read tool + real agy; full pi-durable Harness not started)',
  );
  console.log(`[INIT] tempRoot=${tempRoot} profile=${externalGeminiHome ? 'external-PIBOT_AGY_HOME' : 'isolated-temp'}`);

  try {
    const encryptionKey = randomBytes(32);
    const sessionKey = randomBytes(32);
    const ownerPassword = randomBytes(24).toString('base64url');
    const ownerPasswordHash = hashOwnerPassword(ownerPassword);

    // 1. Start real Center server
    center = await openCenterServer({
      dataRoot: centerDataRoot,
      encryptionKey,
      sessionKey,
      ownerPasswordHash,
      listenHost: '127.0.0.1',
      port: 0,
      publicUrl: 'https://127.0.0.1',
    });

    // 2. Authenticate as owner over HTTP
    const ownerHttp = createOwnerHttpClient(center.url, timeoutMs);
    await ownerHttp.login(ownerPassword);

    // 3. Create real Host identity + primary bot, register device, and bootstrap
    let deviceId;
    let bot;
    const host = openHost({ dataRoot: hostDataRoot });
    try {
      deviceId = host.deviceId;
      bot = host.createBot({
        requestId: 'verify-bot-' + randomBytes(6).toString('hex'),
        role: 'verify-antigravity-bot',
        cwd: hostWorkDir,
        makePrimary: true,
      });
    } finally {
      host.close();
    }

    const displayName = 'verify-center-host';
    const centerPlatform = mapDevicePlatform(process.platform);
    const registered = await ownerHttp.request('POST', '/api/devices', {
      deviceId,
      displayName,
      platform: centerPlatform,
      replaceExisting: true,
    });
    assert.equal(registered.deviceId, deviceId);
    assert.ok(typeof registered.deviceToken === 'string' && registered.deviceToken.length >= 32, 'deviceToken missing');
    const deviceToken = registered.deviceToken;

    client = await connectCenter({
      centerUrl: center.url,
      deviceId,
      deviceToken,
    });
    await client.bootstrap([
      {
        deviceId,
        botId: bot.botId,
        name: bot.role,
        description: bot.description ?? '',
        modelRef: bot.modelRef ?? null,
        primaryConversationId: bot.primaryConversationId,
        createdAt: bot.createdAt,
        isPrimary: Boolean(bot.isPrimary),
        lastActivityAt: bot.lastActivityAt ?? null,
        lastPreview: bot.lastPreview ?? null,
        archivedAt: bot.archivedAt ?? null,
        deviceName: displayName,
        platform: centerPlatform,
      },
    ]);
    console.log(`[STEP 1/5] Center + Host registered & bootstrapped: deviceId=${deviceId} botId=${bot.botId}`);

    // 4. Enable antigravity provider, discover real models, validate, and assign to bot
    const currentProvider = await ownerHttp.request('GET', `/api/providers/${PROVIDER_ID}`);
    await ownerHttp.request('PUT', `/api/providers/${PROVIDER_ID}`, {
      expectedRevision: currentProvider.revision,
      value: {
        name: currentProvider.name,
        api: currentProvider.api,
        baseUrl: currentProvider.baseUrl,
        credentialRef: currentProvider.credentialRef,
        enabled: true,
        native: currentProvider.native,
        configured: true,
      },
    });

    const discovered = await ownerHttp.request('POST', `/api/providers/${PROVIDER_ID}/discover`, {});
    if (!Array.isArray(discovered?.models) || discovered.models.length === 0) {
      throw new Error(
        'POST /api/providers/antigravity/discover returned no models (profile may be empty or unauthenticated; run: agy acp --gemini-dir <dir> --login)',
      );
    }
    const validation = await ownerHttp.request('POST', `/api/providers/${PROVIDER_ID}/validate`, {});
    assert.equal(validation?.ok, true, 'POST /api/providers/antigravity/validate must return ok=true');

    const chosenModelId = discovered.models[0].id;
    assert.ok(typeof chosenModelId === 'string' && chosenModelId.length > 0, 'discovered model must have id');
    const assignedModelRef = `${PROVIDER_ID}/${chosenModelId}`;

    const botModelCfg = await ownerHttp.request(
      'GET',
      `/api/devices/${encodeURIComponent(deviceId)}/bots/${encodeURIComponent(bot.botId)}/model-config`,
    );
    await ownerHttp.request(
      'PUT',
      `/api/devices/${encodeURIComponent(deviceId)}/bots/${encodeURIComponent(bot.botId)}/model-config`,
      {
        expectedRevision: botModelCfg.revision ?? 0,
        value: { modelRef: assignedModelRef },
      },
    );
    console.log(`[STEP 2/5] discovered=${discovered.models.length} assigned=${assignedModelRef}`);

    // 5. Fetch real snapshot and build Host Provider registry unmodified via applyCenterModels
    const snapshot = await client.getSnapshot();
    const { models, botModels } = applyCenterModels(
      snapshot,
      undefined,
      undefined,
      (payload, options) => client.streamAntigravity(payload, options),
    );
    assert.equal(botModels[bot.botId]?.modelRef, assignedModelRef, 'snapshot must propagate assigned antigravity modelRef');
    const { primaryModel, reasoning } = selectModelAndReasoning(models.getModels(PROVIDER_ID), chosenModelId);

    // 6. Two-turn memory through Host Provider -> real Center HTTP -> real agy
    const memMarker = 'HTTP_MEM_' + randomBytes(8).toString('hex');
    const memSessionId = 'verify-http-mem-' + randomBytes(4).toString('hex');
    const memMessages = [
      createInitialSystemMessage('You are a concise verification assistant. Follow instructions literally.', []),
      { role: 'user', content: `Remember this exact token for the next turn: ${memMarker}. Reply only with ACK.`, timestamp: Date.now() },
    ];
    const memTurn1 = await runHostProviderTurnWithTools({
      models,
      model: primaryModel,
      sessionId: memSessionId,
      messages: memMessages,
      reasoning,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(memTurn1.message.stopReason, 'stop', 'HTTP memory turn 1 must stop cleanly');

    memMessages.push({
      role: 'user',
      content: 'What was the exact token I asked you to remember in the previous turn? Reply with that token.',
      timestamp: Date.now(),
    });
    const memTurn2 = await runHostProviderTurnWithTools({
      models,
      model: primaryModel,
      sessionId: memSessionId,
      messages: memMessages,
      reasoning,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(memTurn2.message.stopReason, 'stop', 'HTTP memory turn 2 must stop cleanly');
    assert.ok(extractText(memTurn2.message).includes(memMarker), `HTTP turn 2 reply missing memory marker ${memMarker}`);
    console.log(`[STEP 3/5] HTTP two-turn memory ok: marker=${memMarker} model=${primaryModel.id}`);

    // 7. Full tool loop: Host Provider -> Center /stream -> agy -> toolCall -> Host readTool -> toolResult -> answer
    const fileToken = 'HTTP_HOST_FILE_' + randomBytes(8).toString('hex');
    const hostTargetFile = path.join(hostWorkDir, 'http-host-secret-' + randomBytes(6).toString('hex') + '.txt');
    writeFileSync(hostTargetFile, `Center HTTP E2E payload\n${fileToken}\n`, 'utf8');
    const centerWorkspaceFile = path.join(centerDataRoot, 'antigravity', 'workspace', path.basename(hostTargetFile));
    assert.equal(existsSync(centerWorkspaceFile), false, 'test file must exist only in Host workspace, not Center workspace');

    const toolSessionId = 'verify-http-tool-' + randomBytes(4).toString('hex');
    const toolMessages = [
      createInitialSystemMessage(
        'You MUST call the `read` tool to inspect any file requested by the user. Never guess file contents.',
        [readDecl],
      ),
      {
        role: 'user',
        content: `Use the read tool to read "${hostTargetFile}" and reply with the exact HTTP_HOST_FILE_... token inside it.`,
        timestamp: Date.now(),
      },
    ];
    const toolRes = await runHostProviderTurnWithTools({
      models,
      model: primaryModel,
      sessionId: toolSessionId,
      messages: toolMessages,
      reasoning,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(toolRes.sawToolUse, true, 'HTTP model turn must yield standard toolUse before final answer');
    assert.ok(toolRes.toolExecutions >= 1, 'Host read tool must execute at least once');
    assert.equal(toolRes.message.stopReason, 'stop', 'HTTP tool round-trip must finish cleanly');
    assert.ok(extractText(toolRes.message).includes(fileToken), `HTTP tool round-trip reply missing token ${fileToken}`);
    console.log(`[STEP 4/5] HTTP Host-tool round-trip ok: hostExecutions=${toolRes.toolExecutions} token=${fileToken}`);

    // 8. Verify /api/host/antigravity/cancel aborts a live /api/host/antigravity/stream turn
    const cancelSessionId = 'verify-http-cancel-' + randomBytes(4).toString('hex');
    const cancelMessages = [
      createInitialSystemMessage('Follow instructions literally.', []),
      {
        role: 'user',
        content: 'Write a numbered list from 1 to 500, one number per line, without skipping any number.',
        timestamp: Date.now(),
      },
    ];
    const cancelStream = models.streamSimple(
      primaryModel,
      { messages: cancelMessages },
      { sessionId: cancelSessionId, reasoning, signal: AbortSignal.timeout(timeoutMs) },
    );

    let cancelPromise = null;
    let fallbackTimer = null;
    const triggerHttpCancel = () => {
      if (cancelPromise) return;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      cancelPromise = (async () => {
        const cancelRes = await fetch(new URL('/api/host/antigravity/cancel', center.url), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${deviceToken}`,
            'X-Device-Id': deviceId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sessionId: cancelSessionId }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        assert.equal(cancelRes.status, 200, `POST /api/host/antigravity/cancel expected 200, got ${cancelRes.status}`);
        const cancelBody = await cancelRes.json();
        assert.equal(cancelBody?.ok, true, 'POST /api/host/antigravity/cancel must return { ok: true }');
      })();
    };

    try {
      for await (const event of cancelStream) {
        if (event.type === 'start' && !cancelPromise && !fallbackTimer) {
          fallbackTimer = setTimeout(triggerHttpCancel, 500);
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          triggerHttpCancel();
        }
      }
    } finally {
      if (fallbackTimer) clearTimeout(fallbackTimer);
    }

    if (!cancelPromise) {
      triggerHttpCancel();
    }
    await cancelPromise;
    const cancelResult = await cancelStream.result();
    assert.equal(
      cancelResult.stopReason,
      'aborted',
      `expected stopReason=aborted after HTTP cancel, got ${cancelResult.stopReason}${cancelResult.errorMessage ? ` (${cancelResult.errorMessage})` : ''}`,
    );
    console.log(`[STEP 5/5] HTTP cancel ok: stopReason=${cancelResult.stopReason} sessionId=${cancelSessionId}`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (client?.close) {
      try {
        await client.close();
      } catch (closeErr) {
        if (!primaryError) {
          primaryError = closeErr;
        } else {
          console.error('[CLEANUP] client.close() failed:', closeErr?.message ?? String(closeErr));
        }
      }
    }
    if (center?.close) {
      try {
        await center.close();
      } catch (closeErr) {
        if (!primaryError) {
          primaryError = closeErr;
        } else {
          console.error('[CLEANUP] center.close() failed:', closeErr?.message ?? String(closeErr));
        }
      }
    }
    if (hostEnv?.cleanup) {
      try {
        await hostEnv.cleanup(BACKGROUND_CONTEXT);
      } catch (envErr) {
        console.error('[CLEANUP] hostEnv.cleanup() failed:', envErr?.message ?? String(envErr));
      }
    }
    // Never delete externally provided PIBOT_AGY_HOME; remove only tempRoot with bounded retries.
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    } catch (rmErr) {
      console.error(`[CLEANUP] failed to remove tempRoot (${tempRoot}):`, rmErr?.message ?? String(rmErr));
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  console.log('[PASS] Antigravity Center HTTP + Host Provider round-trip acceptance passed.');
}

run().catch((error) => {
  console.error('[FAIL] ' + (error?.message ?? String(error)));
  if (!process.env.PIBOT_AGY_HOME) {
    console.error('[HINT] Ensure PIBOT_AGY_HOME points to a dedicated profile logged in via: agy acp --gemini-dir <dir> --login');
  }
  process.exitCode = 1;
});
