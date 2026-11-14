#!/usr/bin/env node
// scripts/verify-antigravity-acp.mjs — Lane 1 real ACP/MCP round-trip acceptance check.
// Scope: exercises openAntigravity (real `agy` binary + dedicated profile) and
// Host `read` tool execution via standard Pi AssistantMessageEventStream &
// SystemMessage tool declarations. Does NOT start full Center + Host HTTP/Relay.
//
// Usage:
//   PIBOT_AGY_HOME=/path/to/logged-in-dedicated-gemini node scripts/verify-antigravity-acp.mjs
//   PIBOT_AGY_BIN=/usr/local/bin/agy PIBOT_AGY_HOME=... node scripts/verify-antigravity-acp.mjs

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAntigravity } from '../center-server/antigravity/index.js';
import { createHostExecutionEnv } from '../host-core/host-environment.js';
import { createReadTool } from '../host-core/node_modules/@earendil-works/pi-durable/dist/tools/index.js';
import { BACKGROUND_CONTEXT } from '../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { getSupportedThinkingLevels } from '../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { createInitialSystemMessage, toToolDeclaration } from '../host-core/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js';

const PROVIDER_ID = 'antigravity';
const MODEL_API = 'pibot-antigravity-acp';

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

async function runTurnWithTools({
  service,
  deviceId,
  sessionId,
  modelId,
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
    const stream = service.stream(
      { deviceId, sessionId, modelId, messages, reasoning },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const { message, eventTypes } = await consumeStream(stream);
    if (message.stopReason === 'error') {
      throw new Error(
        `Antigravity stream failed: ${message.errorMessage || 'unknown error'} (stopReason=${message.stopReason}, eventTypes=[${eventTypes.join(', ')}])`,
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

function selectModelsAndReasonings(models) {
  const validModels = models.filter((model) => {
    assert.equal(typeof model.id, 'string', 'model.id must be a string');
    assert.ok(model.id.length > 0, 'model.id must be non-empty');
    assert.equal(model.provider, PROVIDER_ID, `expected provider=${PROVIDER_ID}`);
    assert.equal(model.api, MODEL_API, `expected api=${MODEL_API}`);
    assert.equal(typeof model.reasoning, 'boolean', 'model.reasoning must be boolean');
    return true;
  });

  const primaryModel = validModels.find((m) => getSupportedThinkingLevels(m).length >= 2) ?? validModels[0];
  const secondaryModel = validModels.find((m) => m.id !== primaryModel.id) ?? primaryModel;

  const levelsA = getSupportedThinkingLevels(primaryModel);
  assert.ok(levelsA.length > 0, `no supported thinking levels for ${primaryModel.id}`);
  const reasoningA = levelsA[0];

  const levelsB = getSupportedThinkingLevels(secondaryModel);
  assert.ok(levelsB.length > 0, `no supported thinking levels for ${secondaryModel.id}`);
  const reasoningB = levelsB.find((level) => level !== reasoningA) ?? levelsB[levelsB.length - 1];

  return { primaryModel, secondaryModel, reasoningA, reasoningB };
}

async function run() {
  const timeoutMs = parseTimeoutMs();
  const bin = process.env.PIBOT_AGY_BIN?.trim() || undefined;
  const externalGeminiHome = process.env.PIBOT_AGY_HOME?.trim() || undefined;
  if (externalGeminiHome) {
    assertNotDailyGeminiHome(externalGeminiHome);
  }

  const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pibot-agy-e2e-')));
  const dataRoot = path.join(tempRoot, 'center-data');
  const hostWorkDir = path.join(tempRoot, 'host-workspace');
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(hostWorkDir, { recursive: true, mode: 0o700 });

  const deviceId = 'verify-device-' + randomBytes(4).toString('hex');
  const hostEnv = createHostExecutionEnv({ cwd: hostWorkDir });
  const readTool = createReadTool();
  const readDecl = toToolDeclaration(readTool);
  let service;
  let primaryError = null;

  console.log('[SCOPE] ACP/MCP real round-trip acceptance (openAntigravity + real agy + Host read tool; Center/Host HTTP not included)');
  console.log(`[INIT] tempRoot=${tempRoot} profile=${externalGeminiHome ? 'external-PIBOT_AGY_HOME' : 'isolated-temp'}`);

  try {
    service = await openAntigravity({
      dataRoot,
      ...(bin ? { bin } : {}),
      ...(externalGeminiHome ? { geminiHome: externalGeminiHome } : {}),
    });

    // 1. Catalog discovery (no hardcoded model IDs; fail clearly if empty or unauthenticated)
    const models = await service.catalog({ signal: AbortSignal.timeout(timeoutMs) });
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(
        'service.catalog() returned no models (profile is empty or unauthenticated; run: agy acp --gemini-dir <dir> --login)',
      );
    }
    const { primaryModel, secondaryModel, reasoningA, reasoningB } = selectModelsAndReasonings(models);
    console.log(
      `[STEP 1/6] catalog ok: count=${models.length}, primary=${primaryModel.id} (${reasoningA}), secondary=${secondaryModel.id} (${reasoningB})`,
    );

    // 2. Two-turn memory within a session
    const memMarker = 'MEM_' + randomBytes(8).toString('hex');
    const memSessionId = 'verify-memory-' + randomBytes(4).toString('hex');
    const memMessages = [
      createInitialSystemMessage('You are a concise verification assistant. Follow instructions literally.', []),
      { role: 'user', content: `Remember this exact token for the next turn: ${memMarker}. Reply only with ACK.`, timestamp: Date.now() },
    ];
    const turn1 = await runTurnWithTools({
      service,
      deviceId,
      sessionId: memSessionId,
      modelId: primaryModel.id,
      messages: memMessages,
      reasoning: reasoningA,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(turn1.message.stopReason, 'stop', 'memory turn 1 must stop cleanly');

    memMessages.push({
      role: 'user',
      content: 'What was the exact token I asked you to remember in the previous turn? Reply with that token.',
      timestamp: Date.now(),
    });
    const turn2 = await runTurnWithTools({
      service,
      deviceId,
      sessionId: memSessionId,
      modelId: primaryModel.id,
      messages: memMessages,
      reasoning: reasoningA,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(turn2.message.stopReason, 'stop', 'memory turn 2 must stop cleanly');
    assert.ok(extractText(turn2.message).includes(memMarker), `turn 2 reply missing memory marker ${memMarker}`);
    console.log(`[STEP 2/6] two-turn memory ok: marker=${memMarker} model=${primaryModel.id}`);

    // 3. Same-session model / reasoning level switch retaining memory
    const switchMarker = 'SWITCH_' + randomBytes(8).toString('hex');
    memMessages.push({
      role: 'user',
      content: `Reply with BOTH the exact earlier memory token from turn 1 and this new token: ${switchMarker}.`,
      timestamp: Date.now(),
    });
    const switchRes = await runTurnWithTools({
      service,
      deviceId,
      sessionId: memSessionId,
      modelId: secondaryModel.id,
      messages: memMessages,
      reasoning: reasoningB,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(switchRes.message.stopReason, 'stop', 'model/reasoning switch turn must stop cleanly');
    const switchText = extractText(switchRes.message);
    assert.ok(switchText.includes(memMarker), `same-session switch reply missing earlier memory marker ${memMarker}`);
    assert.ok(switchText.includes(switchMarker), `same-session switch reply missing new marker ${switchMarker}`);
    console.log(
      `[STEP 3/6] same-session model/reasoning switch ok: ${primaryModel.id}/${reasoningA} -> ${secondaryModel.id}/${reasoningB} mem=${memMarker} switch=${switchMarker}`,
    );

    // 4. MCP pibot-bridge -> Host read tool round-trip & single execution location
    const fileToken = 'HOST_FILE_' + randomBytes(8).toString('hex');
    const hostTargetFile = path.join(hostWorkDir, 'host-secret-' + randomBytes(6).toString('hex') + '.txt');
    writeFileSync(hostTargetFile, `Verification payload\n${fileToken}\n`, 'utf8');
    const centerWorkspaceFile = path.join(dataRoot, 'antigravity', 'workspace', path.basename(hostTargetFile));
    assert.equal(existsSync(centerWorkspaceFile), false, 'test file must live only in Host workspace, not Center workspace');

    const toolSessionId = 'verify-tool-' + randomBytes(4).toString('hex');
    const toolMessages = [
      createInitialSystemMessage(
        'You MUST call the `read` tool to inspect any file requested by the user. Never guess file contents.',
        [readDecl],
      ),
      {
        role: 'user',
        content: `Use the read tool to read "${hostTargetFile}" and reply with the exact HOST_FILE_... token inside it.`,
        timestamp: Date.now(),
      },
    ];
    const toolRes = await runTurnWithTools({
      service,
      deviceId,
      sessionId: toolSessionId,
      modelId: primaryModel.id,
      messages: toolMessages,
      reasoning: reasoningA,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(toolRes.sawToolUse, true, 'model must yield a toolUse turn via MCP pibot-bridge instead of reading Center-side');
    assert.ok(toolRes.toolExecutions >= 1, 'Host read tool must execute at least once');
    assert.equal(toolRes.message.stopReason, 'stop', 'tool round-trip turn must finish cleanly');
    assert.ok(extractText(toolRes.message).includes(fileToken), `tool round-trip reply missing file token ${fileToken}`);
    console.log(
      `[STEP 4/6] host-only tool execution ok: hostExecutions=${toolRes.toolExecutions} token=${fileToken} model=${primaryModel.id}`,
    );

    // 5. Built-in native tool restriction probe (only Host `read` declared; no native write_file/run_command)
    const centerWorkspaceDir = path.join(dataRoot, 'antigravity', 'workspace');
    const sentinelName = 'native-probe-sentinel-' + randomBytes(6).toString('hex') + '.txt';
    const sentinelPath = path.join(centerWorkspaceDir, sentinelName);
    const probeToken = 'NATIVE_PROBE_' + randomBytes(6).toString('hex');
    const probeSessionId = 'verify-native-probe-' + randomBytes(4).toString('hex');
    const probeMessages = [
      createInitialSystemMessage(
        'Only the Host `read` tool is declared. Follow user instructions literally.',
        [readDecl],
      ),
      {
        role: 'user',
        content: `If you have a native \`run_command\` or \`write_file\` tool available (other than \`read\`), use it to create "${sentinelPath}" (or "${sentinelName}" in your current workspace) containing "${probeToken}". Otherwise, do NOT call any tool and reply directly with NO_NATIVE_TOOLS.`,
        timestamp: Date.now(),
      },
    ];
    const probeRes = await runTurnWithTools({
      service,
      deviceId,
      sessionId: probeSessionId,
      modelId: primaryModel.id,
      messages: probeMessages,
      reasoning: reasoningA,
      hostEnv,
      readTool,
      timeoutMs,
    });
    assert.equal(
      probeRes.message.stopReason,
      'stop',
      `native tool restriction probe must stop cleanly, got ${probeRes.message.stopReason}`,
    );
    assert.equal(
      probeRes.sawToolUse,
      false,
      'native tool restriction probe must not invoke Host read or unexpected toolCall',
    );
    assert.equal(
      existsSync(sentinelPath),
      false,
      `built-in tool restriction breached: sentinel created at ${sentinelPath}`,
    );
    console.log(`[STEP 5/6] built-in tool restriction probe ok: no sentinel at ${sentinelName}`);

    // 5. Cancellation via service.cancel({ deviceId, sessionId })
    const cancelSessionId = 'verify-cancel-' + randomBytes(4).toString('hex');
    const cancelMessages = [
      createInitialSystemMessage('Follow instructions literally.', []),
      {
        role: 'user',
        content: 'Write a numbered list from 1 to 500, one number per line, without skipping any number.',
        timestamp: Date.now(),
      },
    ];
    const cancelStream = service.stream(
      { deviceId, sessionId: cancelSessionId, modelId: primaryModel.id, messages: cancelMessages, reasoning: reasoningA },
      { signal: AbortSignal.timeout(timeoutMs) },
    );

    let cancelPromise = null;
    let fallbackTimer = null;
    const triggerCancel = () => {
      if (cancelPromise) return;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      cancelPromise = service.cancel({ deviceId, sessionId: cancelSessionId });
    };

    try {
      for await (const event of cancelStream) {
        if (event.type === 'start' && !cancelPromise && !fallbackTimer) {
          fallbackTimer = setTimeout(triggerCancel, 500);
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          triggerCancel();
        }
      }
    } finally {
      if (fallbackTimer) clearTimeout(fallbackTimer);
    }

    if (!cancelPromise) {
      cancelPromise = service.cancel({ deviceId, sessionId: cancelSessionId });
    }
    await cancelPromise;
    const cancelResult = await cancelStream.result();
    assert.equal(
      cancelResult.stopReason,
      'aborted',
      `expected stopReason=aborted after cancel, got ${cancelResult.stopReason}${cancelResult.errorMessage ? ` (${cancelResult.errorMessage})` : ''}`,
    );
    console.log(`[STEP 6/6] cancel ok: stopReason=${cancelResult.stopReason} sessionId=${cancelSessionId}`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (service?.close) {
      try {
        await service.close();
      } catch (closeErr) {
        if (!primaryError) {
          primaryError = closeErr;
        } else {
          console.error('[CLEANUP] service.close() failed:', closeErr?.message ?? String(closeErr));
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
  console.log('[PASS] Antigravity ACP/MCP real round-trip acceptance passed.');
}

run().catch((error) => {
  console.error('[FAIL] ' + (error?.message ?? String(error)));
  if (!process.env.PIBOT_AGY_HOME) {
    console.error('[HINT] Ensure PIBOT_AGY_HOME points to a dedicated profile logged in via: agy acp --gemini-dir <dir> --login');
  }
  process.exitCode = 1;
});
