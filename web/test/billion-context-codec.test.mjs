import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  createContextCodec,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
} from '../../plugins/billion-context/context-codec.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const USAGE = {
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function makeView(messages, { omittedFromContributions = new Set() } = {}) {
  const entries = [];
  const contributions = [];
  messages.forEach((message, idx) => {
    if (omittedFromContributions.has(message)) return;
    entries.push({ id: idx + 1 });
    contributions.push([message]);
  });
  return { head: undefined, entries, contributions, messages };
}

function sysMsg(content = 'Base system instructions.', timestamp = 1) {
  return deepFreeze({ role: 'system', content, timestamp });
}

function userMsg(content, timestamp = 2, extra = {}) {
  return deepFreeze({ role: 'user', content, timestamp, ...extra });
}

function asstTextMsg(text, timestamp = 3) {
  return deepFreeze({
    role: 'assistant',
    provider: 'openai-codex',
    api: 'openai-responses',
    model: 'gpt-5',
    content: [{ type: 'text', text }],
    usage: USAGE,
    stopReason: 'stop',
    timestamp,
  });
}

function asstToolCallMsg(calls, timestamp = 3, extraBlocks = []) {
  return deepFreeze({
    role: 'assistant',
    provider: 'openai-codex',
    api: 'openai-responses',
    model: 'gpt-5',
    content: [
      ...extraBlocks,
      ...calls.map((c) => ({
        type: 'toolCall',
        id: c.id,
        name: c.name,
        arguments: c.arguments ?? {},
      })),
    ],
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp,
  });
}

function toolResultMsg(toolCallId, toolName, content, timestamp = 4, extra = {}) {
  return deepFreeze({
    role: 'toolResult',
    toolCallId,
    toolName,
    content,
    isError: false,
    timestamp,
    ...extra,
  });
}

test('toolResult projects editable real text with stable id and preserves full archive text in codec.messages', () => {
  const bigOutput = 'HEAD_TOKEN_' + 'x'.repeat(70_000) + '_TAIL_ARCHIVE_NEEDLE';
  const sys = sysMsg();
  const u1 = userMsg('read the big file', 2);
  const call = asstToolCallMsg([{ id: 'tc_big', name: 'read', arguments: { path: 'big.log' } }], 3);
  const res = toolResultMsg('tc_big', 'read', [{ type: 'text', text: bigOutput }], 4, {
    isError: true,
    details: { bytes: bigOutput.length },
    durationMs: 17,
  });
  const u2 = userMsg('summarize it', 5);

  const codec = createContextCodec(makeView([sys, u1, call, res, u2]));

  assert.equal(DEFAULT_TOOL_OUTPUT_MAX_BYTES, 50_000);
  assert.equal(codec.messages.length, 5);
  assert.deepEqual(codec.messages[3], {
    id: 'e4:m0',
    role: 'tool',
    contentType: 'tool-result',
    toolName: 'read',
    toolCallId: 'tc_big',
    text: bigOutput,
  });
  // Single-call assistant exposes exact pairing metadata so kernel prune will not orphan-strip toolResult.
  assert.equal(codec.messages[2].contentType, 'tool-call');
  assert.equal(codec.messages[2].toolCallId, 'tc_big');
  assert.equal(codec.messages[2].toolName, 'read');
  // Archive text in codec.messages stays full and uncapped for search/decompress/summary material.
  assert.equal(Buffer.byteLength(codec.messages[3].text, 'utf8'), Buffer.byteLength(bigOutput, 'utf8'));
  assert.ok(codec.messages[3].text.includes('_TAIL_ARCHIVE_NEEDLE'));
});

test('kernel emergency truncate on toolResult survives restore without mutating frozen Durable originals', () => {
  const bigOutput = 'START_' + 'a'.repeat(40_000) + '_END';
  const sys = sysMsg();
  const u1 = userMsg('run build', 2);
  const call = asstToolCallMsg([{ id: 'tc_build', name: 'bash', arguments: { command: 'npm run build' } }], 3);
  const res = toolResultMsg('tc_build', 'bash', [{ type: 'text', text: bigOutput }], 4, {
    isError: true,
    details: { exitCode: 1 },
    durationMs: 99,
  });
  const a2 = asstTextMsg('looking at the error', 5);
  const u2 = userMsg('fix it', 6);

  const codec = createContextCodec(makeView([sys, u1, call, res, a2, u2]));
  const truncatedText = 'START_aaa\n\n...[truncated for context space] — original ~10000 tokens]...\n\naaa_END';
  const projected = codec.messages.map((m) => (m.id === 'e4:m0' ? { ...m, text: truncatedText } : m));

  const restored = codec.restoreWithProvenance(projected);
  assert.equal(restored.lostInput, false);
  assert.equal(restored.inputIndex, 5);
  assert.deepEqual(restored.auxiliaryIndices, []);

  const restoredTool = restored.messages[3];
  assert.notEqual(restoredTool, res);
  assert.equal(restoredTool.role, 'toolResult');
  assert.equal(restoredTool.toolCallId, 'tc_build');
  assert.equal(restoredTool.toolName, 'bash');
  assert.equal(restoredTool.isError, true);
  assert.deepEqual(restoredTool.details, { exitCode: 1 });
  assert.equal(restoredTool.durationMs, 99);
  assert.equal(restoredTool.timestamp, 4);
  assert.deepEqual(restoredTool.content, [{ type: 'text', text: truncatedText }]);

  // Durable original object and codec.messages archive remain completely untouched.
  assert.equal(res.content[0].text, bigOutput);
  assert.equal(codec.messages[3].text, bigOutput);
});

test('restore enforces 50,000 UTF-8 byte visible cap on toolResult (multi-byte safe), supports toolOutputMaxBytes=0, and validates option', () => {
  const cjkChunk = '中文日志🚀'.repeat(8_000); // > 120,000 UTF-8 bytes (3-byte CJK + 4-byte emoji)
  const sys = sysMsg();
  const call = asstToolCallMsg([{ id: 'tc_utf8', name: 'bash' }], 2);
  const res = toolResultMsg('tc_utf8', 'bash', [{ type: 'text', text: cjkChunk }], 3);
  const u2 = userMsg('continue', 4);
  const view = makeView([sys, call, res, u2]);

  // Default 50,000 UTF-8 byte cap
  const defaultCodec = createContextCodec(view);
  assert.equal(defaultCodec.messages[2].text, cjkChunk);
  const defaultRestored = defaultCodec.restore(defaultCodec.messages);
  const cappedText = defaultRestored[2].content[0].text;
  assert.ok(Buffer.byteLength(cappedText, 'utf8') <= 50_000);
  assert.ok(cappedText.length < cjkChunk.length);
  assert.equal(LONE_SURROGATE_RE.test(cappedText), false);
  assert.equal(cappedText.includes('\uFFFD'), false);
  assert.equal(res.content[0].text, cjkChunk);

  // Small caps (including tiny boundary caps) must never exceed maxBytes or split surrogate pairs
  for (const smallCap of [256, 40, 12, 5, 3, 1]) {
    const smallCodec = createContextCodec(view, { toolOutputMaxBytes: smallCap });
    const smallRestored = smallCodec.restore(smallCodec.messages);
    const out = smallRestored[2].content[0].text;
    assert.ok(
      Buffer.byteLength(out, 'utf8') <= smallCap,
      `expected UTF-8 bytes <= ${smallCap}, got ${Buffer.byteLength(out, 'utf8')}`,
    );
    assert.equal(LONE_SURROGATE_RE.test(out), false);
    assert.equal(out.includes('\uFFFD'), false);
  }

  // toolOutputMaxBytes: 0 disables cap (returns original reference when kernel text is unchanged)
  const uncappedCodec = createContextCodec(view, { toolOutputMaxBytes: 0 });
  const uncappedRestored = uncappedCodec.restore(uncappedCodec.messages);
  assert.equal(uncappedRestored[2], res);
  assert.equal(uncappedRestored[2].content[0].text, cjkChunk);

  // Even when cap is disabled, explicit kernel emergency truncate rewrite is still applied
  const kernelTrunc = 'HEAD...[truncated for context space]...TAIL';
  const uncappedTrunc = uncappedCodec.restore(
    uncappedCodec.messages.map((m) => (m.id === 'e3:m0' ? { ...m, text: kernelTrunc } : m)),
  );
  assert.deepEqual(uncappedTrunc[2].content, [{ type: 'text', text: kernelTrunc }]);

  // String-content toolResult preserves string shape when capped
  const strRes = toolResultMsg('tc_str', 'read', 's'.repeat(60_000), 3);
  const strView = makeView([sys, asstToolCallMsg([{ id: 'tc_str', name: 'read' }], 2), strRes, u2]);
  const strRestored = createContextCodec(strView).restore(createContextCodec(strView).messages);
  assert.equal(typeof strRestored[2].content, 'string');
  assert.ok(Buffer.byteLength(strRestored[2].content, 'utf8') <= 50_000);
  assert.equal(strRes.content.length, 60_000);

  // Invalid toolOutputMaxBytes fails fast
  assert.throws(() => createContextCodec(view, { toolOutputMaxBytes: -1 }), RangeError);
  assert.throws(() => createContextCodec(view, { toolOutputMaxBytes: Number.NaN }), RangeError);
  assert.throws(() => createContextCodec(view, { toolOutputMaxBytes: Number.POSITIVE_INFINITY }), RangeError);
});

test('mixed image/non-text toolResult preserves non-text blocks and order while capping/truncating text; missing_result stays intact', () => {
  const imgBlock = deepFreeze({ type: 'image', data: PNG_1X1, mimeType: 'image/png' });
  const customBlock = deepFreeze({ type: 'resource', uri: 'file:///tmp/report.bin' });
  const sys = sysMsg();
  const call1 = asstToolCallMsg([{ id: 'tc_mix', name: 'screenshot' }], 2);
  const resMix = toolResultMsg(
    'tc_mix',
    'screenshot',
    [imgBlock, { type: 'text', text: 'LOG_'.repeat(20_000) }, customBlock],
    3,
  );
  const call2 = asstToolCallMsg([{ id: 'tc_miss', name: 'read' }], 4);
  const resMissing = toolResultMsg(
    'tc_miss',
    'read',
    [{ type: 'text', text: 'Tool result unavailable: history ends before this call completed.' }],
    4,
    { isError: true, details: { reason: 'missing_result' } },
  );
  const u2 = userMsg('next step', 5);

  const view = makeView([sys, call1, resMix, call2, resMissing, u2], {
    omittedFromContributions: new Set([resMissing]),
  });
  const codec = createContextCodec(view, { toolOutputMaxBytes: 32 });

  // Synthetic missing_result gets stable missing:<toolCallId> id and is protected
  assert.equal(codec.messages[4].id, 'missing:tc_miss');
  assert.equal(codec.protectedIds.has('missing:tc_miss'), true);
  assert.equal(codec.protectedIds.has('e3:m0'), true);

  // Mixed toolResult caps only text while preserving image + customBlock in order
  const restored = codec.restore(codec.messages.filter((m) => m.id !== 'missing:tc_miss'));
  assert.equal(restored.length, 6);
  const outMix = restored[2];
  assert.equal(outMix.content.length, 3);
  assert.equal(outMix.content[0], imgBlock);
  assert.equal(outMix.content[1].type, 'text');
  assert.ok(Buffer.byteLength(outMix.content[1].text, 'utf8') <= 32);
  assert.equal(outMix.content[2], customBlock);

  // Synthetic missing_result is restored verbatim even when omitted and even under tiny toolOutputMaxBytes
  assert.equal(restored[4], resMissing);
  assert.equal(restored[4].details.reason, 'missing_result');
  assert.equal(restored[4].isError, true);

  // Unmappable non-missing_result message still throws BC_CODEC_UNMAPPABLE
  const rogue = userMsg('rogue', 9);
  assert.throws(
    () => createContextCodec(makeView([sys, rogue], { omittedFromContributions: new Set([rogue]) })),
    (err) => err?.code === 'BC_CODEC_UNMAPPABLE',
  );
});

test('last real input is hard-protected by codec.protectedIds; real user input is not capped/truncated while tail toolResult is still capped with preserved identity', () => {
  // Case A: huge genuine user input (> 50KB) as last real input
  const hugeUserText = 'USER_PROMPT_'.repeat(6_000); // 72,000 bytes
  const sys = sysMsg();
  const uOld = userMsg('old', 2);
  const aOld = asstTextMsg('old reply', 3);
  const uLatest = userMsg(hugeUserText, 4);
  const auxTail = userMsg('BC reminder', 0, { bcContextMaterial: true });

  const userCodec = createContextCodec(makeView([sys, uOld, aOld, uLatest, auxTail]));
  assert.equal(userCodec.protectedIds.has('e4:m0'), true);
  assert.equal(userCodec.protectedIds.has('e2:m0'), false);

  // 1) Even if kernel drops uLatest from projected, restore restores it with exact provenance
  const droppedRestored = userCodec.restoreWithProvenance([userCodec.messages[0], userCodec.messages[4]]);
  assert.equal(droppedRestored.lostInput, false);
  assert.equal(droppedRestored.inputIndex, 1);
  assert.deepEqual(droppedRestored.auxiliaryIndices, [2]);
  assert.equal(droppedRestored.messages[1], uLatest);
  assert.equal(droppedRestored.messages[1].content, hugeUserText);

  // 2) Emergency truncate marker on last real user input is rejected, preserving genuine input
  const truncAttempt = userCodec.messages.map((m) =>
    m.id === 'e4:m0' ? { ...m, text: 'USER...[truncated for context space]...PROMPT' } : m,
  );
  const afterTruncAttempt = userCodec.restoreWithProvenance(truncAttempt);
  assert.equal(afterTruncAttempt.messages[3], uLatest);
  assert.equal(afterTruncAttempt.inputIndex, 3);
  assert.deepEqual(afterTruncAttempt.auxiliaryIndices, [4]);

  // 3) Legitimate tag rewrite (<acp ...>) on last real user input is still preserved without turning it into auxiliary
  const taggedUser = userCodec.messages.map((m) =>
    m.id === 'e4:m0' ? { ...m, text: `<acp tokens="18K" type="text">m00004</acp>\n${hugeUserText}` } : m,
  );
  const afterTag = userCodec.restoreWithProvenance(taggedUser);
  assert.equal(afterTag.inputIndex, 3);
  assert.equal(afterTag.lostInput, false);
  assert.deepEqual(afterTag.auxiliaryIndices, [4]);
  assert.ok(afterTag.messages[3].content.startsWith('<acp '));
  assert.ok(afterTag.messages[3].content.endsWith(hugeUserText));

  // Case B: huge toolResult as last real input (followed by trailing auxiliary user note)
  const hugeTool = 'TOOL_OUTPUT_'.repeat(6_000); // 72,000 bytes
  const call = asstToolCallMsg([{ id: 'tc_tail', name: 'bash' }], 5);
  const resTail = toolResultMsg('tc_tail', 'bash', [{ type: 'text', text: hugeTool }], 6, { isError: true });
  const tailCodec = createContextCodec(makeView([sys, uOld, call, resTail, auxTail]));
  assert.equal(tailCodec.protectedIds.has('e4:m0'), true);
  assert.equal(tailCodec.messages[3].text, hugeTool);

  const tailRestored = tailCodec.restoreWithProvenance(tailCodec.messages);
  assert.equal(tailRestored.lostInput, false);
  assert.equal(tailRestored.inputIndex, 3);
  assert.deepEqual(tailRestored.auxiliaryIndices, [4]);
  assert.equal(tailRestored.messages[3].role, 'toolResult');
  assert.equal(tailRestored.messages[3].toolCallId, 'tc_tail');
  assert.equal(tailRestored.messages[3].toolName, 'bash');
  assert.equal(tailRestored.messages[3].isError, true);
  assert.ok(Buffer.byteLength(tailRestored.messages[3].content[0].text, 'utf8') <= 50_000);
  assert.equal(resTail.content[0].text, hugeTool);

  // Even when omitted from projected, tail toolResult is restored WITH cap and intact provenance
  const tailMissing = tailCodec.restoreWithProvenance([tailCodec.messages[0], tailCodec.messages[2], tailCodec.messages[4]]);
  assert.equal(tailMissing.lostInput, false);
  assert.equal(tailMissing.messages[1], uOld);
  assert.equal(tailMissing.inputIndex, 3);
  assert.deepEqual(tailMissing.auxiliaryIndices, [4]);
  assert.equal(tailMissing.messages[3].toolCallId, 'tc_tail');
  assert.ok(Buffer.byteLength(tailMissing.messages[3].content[0].text, 'utf8') <= 50_000);
});

test('opt-in foldClosedTools allows whole-group folding of complete historical tool pairs, restores partial crops without orphans, and protects active/image/incomplete/multi-call/meta groups', () => {
  const sys = sysMsg();
  const u1 = userMsg('step 1', 2);
  // 1) Complete historical closed single-call pair -> foldable when foldClosedTools: true
  const histCall = asstToolCallMsg([{ id: 'tc_hist', name: 'read' }], 3);
  const histRes = toolResultMsg('tc_hist', 'read', [{ type: 'text', text: 'file body ' + 'z'.repeat(1_000) }], 4);
  // 2) Historical pair with image in toolResult -> MUST be protected
  const imgCall = asstToolCallMsg([{ id: 'tc_img', name: 'screenshot' }], 5);
  const imgRes = toolResultMsg(
    'tc_img',
    'screenshot',
    [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }],
    6,
  );
  // 3) Historical pair with compress metadata tool -> MUST be protected
  const metaCall = asstToolCallMsg([{ id: 'tc_meta', name: 'compress' }], 7);
  const metaRes = toolResultMsg('tc_meta', 'compress', [{ type: 'text', text: '{"blocksCreated":1}' }], 8);
  // 4) Historical multi-toolCall group -> MUST be protected under scalar CoreMessage.toolCallId ABI
  const multiCall = asstToolCallMsg(
    [
      { id: 'tc_m1', name: 'read' },
      { id: 'tc_m2', name: 'read' },
    ],
    9,
  );
  const multiRes1 = toolResultMsg('tc_m1', 'read', [{ type: 'text', text: 'm1' }], 10);
  const multiRes2 = toolResultMsg('tc_m2', 'read', [{ type: 'text', text: 'm2' }], 11);
  // 5) Historical incomplete pair (missing_result) -> MUST be protected
  const missCall = asstToolCallMsg([{ id: 'tc_inc', name: 'bash' }], 12);
  const missRes = toolResultMsg(
    'tc_inc',
    'bash',
    [{ type: 'text', text: 'Tool result unavailable: history ends before this call completed.' }],
    12,
    { isError: true, details: { reason: 'missing_result' } },
  );
  // 6) Active tail tool pair -> MUST be protected
  const activeCall = asstToolCallMsg([{ id: 'tc_active', name: 'bash' }], 13);
  const activeRes = toolResultMsg('tc_active', 'bash', [{ type: 'text', text: 'active output' }], 14);
  const aux = userMsg('nudge', 0, { bcContextMaterial: true });

  const allMsgs = [
    sys,
    u1,
    histCall,
    histRes,
    imgCall,
    imgRes,
    metaCall,
    metaRes,
    multiCall,
    multiRes1,
    multiRes2,
    missCall,
    missRes,
    activeCall,
    activeRes,
    aux,
  ];
  const view = makeView(allMsgs, { omittedFromContributions: new Set([missRes]) });

  // Default mode: historical pair IS protected
  const defaultCodec = createContextCodec(view);
  assert.equal(defaultCodec.protectedIds.has('e3:m0'), true);
  assert.equal(defaultCodec.protectedIds.has('e4:m0'), true);

  // Opt-in foldClosedTools: true
  const foldCodec = createContextCodec(view, { foldClosedTools: true });
  // Closed historical single-call pair is NOT in protectedIds
  assert.equal(foldCodec.protectedIds.has('e3:m0'), false);
  assert.equal(foldCodec.protectedIds.has('e4:m0'), false);
  // Image, metadata, multi-call, incomplete, and active groups ARE all protected
  for (const id of [
    'e1:m0', // sys
    'e5:m0', 'e6:m0', // image group
    'e7:m0', 'e8:m0', // compress meta group
    'e9:m0', 'e10:m0', 'e11:m0', // multi-call group
    'e12:m0', 'missing:tc_inc', // incomplete group
    'e14:m0', 'e15:m0', // active tail group
  ]) {
    assert.equal(foldCodec.protectedIds.has(id), true, `expected ${id} to be protected`);
  }

  const summaryCore = {
    id: 'acp_summary_b1',
    role: 'system',
    contentType: 'text',
    text: '[Compressed Context Summary]\nRead file body earlier.',
  };

  // A) Whole historical group folded -> stays folded, no orphans, protected groups stay restored
  const foldedProjected = [
    foldCodec.messages[0],
    summaryCore,
    ...foldCodec.messages.slice(4),
  ];
  const afterWholeFold = foldCodec.restoreWithProvenance(foldedProjected);
  assert.equal(afterWholeFold.messages.includes(histCall), false);
  assert.equal(afterWholeFold.messages.includes(histRes), false);
  assert.equal(afterWholeFold.messages[1].bcSummaryMaterial, true);
  assert.deepEqual(afterWholeFold.auxiliaryIndices, [1, afterWholeFold.messages.length - 1]);
  assert.equal(afterWholeFold.messages[afterWholeFold.inputIndex], activeRes);

  // B) Partial crop: only histCall omitted, histRes present -> histCall MUST be restored before histRes
  const missingCallProjected = foldCodec.messages.filter((m) => m.id !== 'e3:m0');
  const afterMissingCall = foldCodec.restore(missingCallProjected);
  const histCallIdx = afterMissingCall.indexOf(histCall);
  const histResIdx = afterMissingCall.indexOf(histRes);
  assert.ok(histCallIdx >= 0 && histResIdx === histCallIdx + 1);

  // C) Partial crop: only histRes omitted AND a synthetic summary sits right after histCall ->
  //    histRes MUST be restored IMMEDIATELY after histCall and BEFORE the synthetic summary!
  const missingResProjected = [
    foldCodec.messages[0],
    foldCodec.messages[1],
    foldCodec.messages[2], // histCall
    summaryCore,
    ...foldCodec.messages.slice(4),
  ];
  const afterMissingRes = foldCodec.restore(missingResProjected);
  const callIdx2 = afterMissingRes.indexOf(histCall);
  const resIdx2 = afterMissingRes.indexOf(histRes);
  const summaryIdx2 = afterMissingRes.findIndex((m) => m.bcSummaryMaterial === true);
  assert.ok(callIdx2 >= 0);
  assert.equal(resIdx2, callIdx2 + 1);
  assert.ok(summaryIdx2 > resIdx2);

  // D) Attempting to drop any protected group (e.g. active, image, multi-call) restores all of them
  const dropProtectedProjected = [foldCodec.messages[0], summaryCore];
  const afterDropProtected = foldCodec.restoreWithProvenance(dropProtectedProjected);
  assert.equal(afterDropProtected.lostInput, false);
  assert.equal(afterDropProtected.messages[afterDropProtected.inputIndex], activeRes);
  assert.ok(afterDropProtected.messages.includes(imgCall));
  assert.ok(afterDropProtected.messages.includes(imgRes));
  assert.ok(afterDropProtected.messages.includes(multiCall));
  assert.ok(afterDropProtected.messages.includes(multiRes1));
  assert.ok(afterDropProtected.messages.includes(multiRes2));
  assert.ok(afterDropProtected.messages.includes(missCall));
  assert.ok(afterDropProtected.messages.includes(missRes));
  assert.ok(afterDropProtected.messages.includes(activeCall));
  assert.ok(afterDropProtected.messages.includes(activeRes));
});

const KERNEL_ENTRY = new URL('../../plugins/billion-context/node_modules/acp-kernel/dist/index.js', import.meta.url);

test('acp-kernel@0.0.101 integration: emergency truncate survives restore and foldClosedTools folds cleanly without orphans', async (t) => {
  if (!existsSync(KERNEL_ENTRY)) {
    t.skip('plugins/billion-context/node_modules/acp-kernel is not installed in this checkout');
    return;
  }
  const kernel = await import(KERNEL_ENTRY.href);
  const core = kernel.createCore();

  // 1) Emergency truncate survives restore while codec.messages retains full archive text
  const largePayload = 'KERNEL_HEAD_' + 'q'.repeat(24_000) + '_KERNEL_TAIL';
  const sys = sysMsg('System prompt', 1);
  const u1 = userMsg('inspect logs', 2);
  const c1 = asstToolCallMsg([{ id: 'tc_k1', name: 'bash' }], 3);
  const r1 = toolResultMsg('tc_k1', 'bash', [{ type: 'text', text: largePayload }], 4);
  const a1 = asstTextMsg('analyzed the log output', 5);
  const u2 = userMsg('what next?', 6);
  const view = makeView([sys, u1, c1, r1, a1, u2]);

  const codec = createContextCodec(view);
  const config = kernel.defaultConfig(6_000, { preserveRecentMessages: 2 });
  const tokenCount = codec.messages.reduce((sum, m) => sum + kernel.countMessageTokens(m), 0);
  const turn = core.processTurn({
    messages: codec.messages,
    state: kernel.createInitialState(),
    config,
    contentStore: kernel.createContentStore(),
    tokenCount,
    renderTags: 'text-only',
  });
  const restored = codec.restoreWithProvenance(turn.messages);
  const restoredTool = restored.messages[3];
  assert.equal(restoredTool.role, 'toolResult');
  assert.equal(restoredTool.toolCallId, 'tc_k1');
  assert.ok(restoredTool.content[0].text.includes('[truncated for context space]'));
  assert.ok(restoredTool.content[0].text.length < largePayload.length);
  assert.equal(r1.content[0].text, largePayload);
  assert.equal(codec.messages[3].text, largePayload);

  // 2) Opt-in foldClosedTools with real applyCompression + processTurn folds closed tool pair cleanly
  const foldCodec = createContextCodec(view, { foldClosedTools: true });
  const foldConfig = kernel.defaultConfig(100_000, {
    preserveRecentMessages: 1,
    preserveRecentTokens: 1,
    compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
  });
  const pass1 = core.processTurn({
    messages: foldCodec.messages,
    state: kernel.createInitialState(),
    config: foldConfig,
    contentStore: kernel.createContentStore(),
    tokenCount: 1_000,
    renderTags: 'text-only',
  });
  const startRef = pass1.state.messageRefs.byRaw['e3:m0'];
  const endRef = pass1.state.messageRefs.byRaw['e4:m0'];
  assert.ok(startRef && endRef);

  const protectedRefs = new Set(
    [...foldCodec.protectedIds]
      .map((rawId) => pass1.state.messageRefs.byRaw[rawId])
      .filter((ref) => typeof ref === 'string'),
  );
  const compressed = core.applyCompression({
    ranges: [{ startRef, endRef, summary: 'Ran bash command to inspect logs and reviewed the full output.' }],
    messages: foldCodec.messages,
    state: pass1.state,
    config: foldConfig,
    protectedMessageIds: protectedRefs,
  });
  assert.equal(compressed.result.errors.length, 0);
  assert.equal(compressed.result.blocksCreated, 1);

  const pass2 = core.processTurn({
    messages: foldCodec.messages,
    state: compressed.state,
    config: foldConfig,
    contentStore: pass1.contentStore,
    tokenCount: 500,
    renderTags: 'text-only',
  });
  const foldedRestored = foldCodec.restoreWithProvenance(pass2.messages);
  assert.equal(foldedRestored.lostInput, false);
  assert.equal(foldedRestored.messages.some((m) => m === c1 || m === r1), false);
  assert.equal(foldedRestored.messages.some((m) => m.bcSummaryMaterial === true), true);

  // Decompress still recovers full uncapped archive text from codec.messages
  const block = core.decompress(compressed.state.blocks[0].blockId, compressed.state);
  const collected = kernel.collectBlockContent(compressed.state, block, foldCodec.messages, { full: true });
  assert.ok(collected.text.includes('_KERNEL_TAIL'));
});
