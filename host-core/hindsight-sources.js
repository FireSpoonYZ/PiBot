// host-core/hindsight-sources.js
// M13 Hindsight memory sources: capture unfinished input submissions into durable
// runs, collect completed exchanges into SourceText items, and prepare frozen
// PreparedJob payloads. Pure SDK reads only; no network/store writes.
// Redaction/clipping helpers come from the hindsight-format lane; this module
// never duplicates them.

import { createHash } from 'node:crypto';
import { messageError } from './message-protocol.js';
import { resolveBotIdentity } from './bot-identity.js';
import { WorkContextState } from './work-context-docs.js';
import { WorkDecisionState } from './work-decision-state.js';
import { RequestKeys } from './runtime-docs.js';
import { clipMemoryText, redactMemoryText } from './hindsight-format.js';

const SCOPE_MESSAGE_KIND = 'host.scope-message';
const WORK_TRIGGER_KIND = 'host.work-trigger';
const PRIMARY_INPUT_KIND = 'pi.user';
// 带图主输入以自定义 kind 放置（附件 worker 约定）：kind 不同，model 里仍是同一条 user 消息，
// 附件引用在 entry.data.attachments。
const PRIMARY_USER_MESSAGE_KIND = 'host.user-message';
const PRIMARY_INPUT_KINDS = new Set([PRIMARY_INPUT_KIND, PRIMARY_USER_MESSAGE_KIND]);

/** 与 runtime-turns 的提交摘要一致：纯文本 sha256(text)，带图 sha256(JSON.stringify({text,attachments:有序ID数组}))。 */
function primaryInputDigest(text, attachments) {
  if (attachments === undefined) return sha256Hex(text);
  return sha256Hex(JSON.stringify({ text, attachments }));
}

const PAGE_SIZE = 50; // work collection page of scope-message entries
const CHUNK_MAX_UNITS = 16384; // per source text chunk, UTF-16 units
const QUERY_MAX_UNITS = 8192; // recall query bound, UTF-16 units
const QUERY_SOURCE_COUNT = 2; // last two genuine relevant inputs for the query

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sourceError(code, message) {
  return messageError(code, message);
}

function nonBlankString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw sourceError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  }
  return value;
}

function safeEntryId(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw sourceError('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
  }
  return value;
}

/** 全 source 时间戳必须来自实际文档字段；缺失/畸形直接失败，不落 Date.now。 */
function requiredIso(iso, label) {
  if (typeof iso !== 'string' || iso.length === 0 || Number.isNaN(Date.parse(iso))) {
    throw sourceError('HINDSIGHT_STORE_FAILED', `${label} timestamp is missing or malformed`);
  }
  return iso;
}

/** 从 user/assistant 消息中提取纯文本，排除 thinking/工具调用/图像。 */
function textFromMessage(message, role) {
  if (!message || typeof message !== 'object' || message.role !== role) return '';
  const content = message.content;
  if (typeof content === 'string') return role === 'user' ? content : '';
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function isoFromMs(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function visibleMessages(view) {
  return new Set(view.messages);
}

/** 条目是否真实贡献到冻结视图（与 decisions 的可见性判定一致，visible 每视图只建一次）。 */
function contributes(view, index, visible) {
  return (view.contributions[index] ?? []).some((message) => visible.has(message));
}

/** 按 clipMemoryText 前缀消费长度拆分 UTF-16 块，surrogate pair 安全，不截断/丢数据。 */
function splitChunks(text, maxUnits) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let part = clipMemoryText(remaining, maxUnits).text;
    if (part.length === 0) {
      // 1 单元窗口遇单个代理对时前缀为空：整对推进，避免死循环。
      const width = remaining.codePointAt(0) > 0xffff ? 2 : 1;
      part = remaining.slice(0, width);
    }
    chunks.push(part);
    remaining = remaining.slice(part.length);
  }
  return chunks;
}

/**
 * 稳定来源定位器（documentId 组成之一）：主输入/回答按 native entry/提交定位，
 * 工作消息按 entry/messageId/localId 定位；不依赖可变化的 M7 local_id 时序，
 * 不携带任意长度原始 requestId。
 */
function sourceLocator(source) {
  if (source.kind === 'scope-message') {
    return ['scope-message', source.entryId, source.messageId, source.localId];
  }
  if (source.kind === 'primary-input') {
    return [source.kind, source.entryId, source.submissionId];
  }
  if (source.kind === 'primary-answer' || source.kind === 'work-answer') {
    return [source.kind, source.entryId];
  }
  return [String(source.kind ?? 'unknown')];
}

function normalizeTarget(target) {
  if (target?.kind === 'primary') return { kind: 'primary' };
  if (target?.kind === 'shared') return { kind: 'shared' };
  if (target?.kind === 'scope' && typeof target.scopeId === 'string' && target.scopeId.length > 0) {
    return { kind: 'scope', scopeId: target.scopeId };
  }
  throw sourceError('INVALID_ARGUMENT', 'invalid memory target');
}

/**
 * 构造 Hindsight 来源收集器。
 * - captureRequest：在 provider 请求前把未完成输入提交固化为 runs（只读 SDK）。
 * - collectRun：按提交状态收集已完成交换的 SourceText。
 * - makeHindsightJobs：把 SourceText 加工为去重/确定性 PreparedJob。
 * getBotPolicy(botId) 提供每 Bot 策略：关闭时 captureRequest 返回 null，
 * 只读时保留 query 但 canWrite=false；retentionFloor 以下的历史条目不入 source/query。
 */
export function createHindsightSources({ host, getHarness, context, getBotPolicy }) {
  if (!host || typeof getHarness !== 'function' || !context) {
    throw sourceError('INVALID_ARGUMENT', 'createHindsightSources requires host, getHarness and context');
  }
  const deviceId = nonBlankString(host.deviceId, 'host.deviceId');

  function harness() {
    const value = getHarness();
    if (!value) throw sourceError('HINDSIGHT_STORE_FAILED', 'harness is not initialized');
    return value;
  }

  async function resolveIdentity(nativeId, callContext) {
    try {
      return await resolveBotIdentity(host, harness(), nativeId, callContext);
    } catch (error) {
      if (error?.code === 'BOT_CONTEXT_REQUIRED') return null;
      throw error;
    }
  }

  /** 主私聊：RequestKeys 注册 + 实际 pi.user 输入文本摘要一致 + native 归属/贡献。 */
  async function primaryCapture(api, callContext, submissions, cutoff, view, visible) {
    const h = harness();
    const keys = await h.snapshot(RequestKeys, api.conversationId, callContext);
    const digests = keys?.digests ?? {};
    const entryIndex = new Map();
    for (let i = 0; i < view.entries.length; i++) entryIndex.set(view.entries[i].id, i);

    const runs = [];
    const verified = [];
    for (const submission of submissions) {
      if (submission.status !== 'placed') continue;
      const requestId = submission.requestId;
      if (typeof requestId !== 'string' || requestId.length === 0) continue;
      const expected = digests['r:' + requestId];
      if (expected === undefined) continue; // 非 Host 注册的 control-caller 输入
      if (typeof submission.entry !== 'number' || !(submission.entry <= cutoff)) continue;
      const idx = entryIndex.get(submission.entry);
      if (idx === undefined) continue;
      const entry = view.entries[idx];
      if (entry.conversationId !== api.conversationId || !PRIMARY_INPUT_KINDS.has(entry.kind)) continue;
      // host.user-message 的附件只认严格有序的字符串 ID 数组；形状不符视为校验失败，绝不放宽摘要。
      const data = entry.kind === PRIMARY_USER_MESSAGE_KIND ? entry.data : undefined;
      if (data !== undefined && !Array.isArray(data?.attachments)) continue;
      const attachments = data === undefined ? undefined : data.attachments.map((a) => a?.id);
      if (attachments !== undefined && attachments.some((id) => typeof id !== 'string' || id.length === 0)) continue;
      if (!contributes(view, idx, visible)) continue;
      const text = textFromMessage(entry.model?.[0], 'user');
      if (text.length === 0 || primaryInputDigest(text, attachments) !== expected) continue; // 精确 Runtime 正文摘要
      verified.push({ entryId: entry.id, text });
      runs.push({
        submissionId: submission.id,
        nativeId: api.conversationId,
        requestId,
        entryId: submission.entry,
        cutoff,
        kind: 'primary',
      });
    }
    return { runs, verified };
  }

  /** 工作：定位由 pending.requestId 放置的输入（不等 submissionId 回填），并核对 Host 触发条目。 */
  async function workCapture(api, callContext, submissions, cutoff, view, meta) {
    const h = harness();
    const state = await h.snapshot(WorkDecisionState, api.conversationId, callContext);
    const pending = state?.pending;
    if (!pending || !pending.prepared || pending.prepared.taskId !== String(api.taskId)) return [];
    const requestId = pending.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) return [];
    const submission = submissions.find((item) => item.requestId === requestId);
    if (!submission || submission.type !== 'input' || submission.status !== 'placed') return [];
    if (typeof submission.entry !== 'number' || !(submission.entry <= cutoff)) return [];
    const entry = view.entries.find((item) => item.id === submission.entry);
    if (!entry || entry.conversationId !== api.conversationId) return [];
    if (entry.kind !== WORK_TRIGGER_KIND || entry.data?.requestId !== requestId) return [];
    return [{
      submissionId: submission.id,
      nativeId: api.conversationId,
      requestId,
      entryId: submission.entry,
      cutoff,
      kind: 'scope',
    }];
  }

  /** 冻结视图内真实工作来源输入：scope-message 贡献、非 selfEcho、非 Host 触发、不低于 retention floor。 */
  function scopeGenuineInputs(view, visible, scopeId, floorEntryId) {
    const items = [];
    for (let i = 0; i < view.entries.length; i++) {
      const entry = view.entries[i];
      if (entry.id <= floorEntryId) continue;
      if (entry.kind === WORK_TRIGGER_KIND) continue;
      if (entry.kind !== SCOPE_MESSAGE_KIND) continue;
      const data = entry.data;
      if (!isPlainObject(data) || !isPlainObject(data.message) || data.message.scopeId !== scopeId) continue;
      if (data.selfEcho === true) continue;
      if (!contributes(view, i, visible)) continue;
      if (typeof data.message.text !== 'string' || data.message.text.length === 0) continue;
      items.push({ entryId: entry.id, messageId: data.message.messageId, text: data.message.text });
    }
    return items.slice(-QUERY_SOURCE_COUNT);
  }

  function buildQuery(inputs) {
    const texts = inputs.map((item) => item.text);
    const query = clipMemoryText(redactMemoryText(texts.join('\n\n')), QUERY_MAX_UNITS).text;
    const keyInputs = inputs.map((item) => item.messageId ? [item.entryId, item.messageId, item.text] : [item.entryId, item.text]);
    const queryKey = texts.length === 0 ? '' : 'q:' + sha256Hex(JSON.stringify(keyInputs));
    return { query, queryKey };
  }

  async function captureRequest(api, callContext) {
    const h = harness();
    const task = await h.getTask(api.taskId, callContext);
    const cutoff = task?.state?.checkpoint?.cutoff;
    if (!Number.isSafeInteger(cutoff)) return null;
    const identity = await resolveIdentity(api.conversationId, callContext);
    if (!identity) return null;
    // 每 Bot 策略：关闭则完全跳过（不记录 run、不建 query）；只读保留 query 但冻结写入。
    const policy = getBotPolicy ? (getBotPolicy(identity.botId) ?? null) : null;
    if (policy && policy.enabled !== true) return null;
    const canWrite = policy === null || policy.canWrite === true;
    const floorEntryId = Number.isSafeInteger(policy?.retentionFloor) && policy.retentionFloor > 0 ? policy.retentionFloor : 0;

    const conversation = await h.conversation(api.conversationId, callContext);
    if (!conversation) return null;
    const view = await conversation.context(callContext, { at: cutoff });
    const visible = visibleMessages(view);

    const inspection = await h.inspect(callContext);
    const submissions = inspection.submissions.filter(
      (item) => item.conversationId === api.conversationId && item.type === 'input',
    );

    const meta = await h.snapshot(WorkContextState, api.conversationId, callContext);
    let target;
    let runs;
    let verifiedInputs;
    if (meta?.scopeId) {
      target = { kind: 'scope', scopeId: meta.scopeId };
      runs = await workCapture(api, callContext, submissions, cutoff, view, meta);
      verifiedInputs = scopeGenuineInputs(view, visible, meta.scopeId, floorEntryId);
    } else {
      target = { kind: 'primary' };
      const captured = await primaryCapture(api, callContext, submissions, cutoff, view, visible);
      runs = captured.runs;
      verifiedInputs = captured.verified.map((item) => ({ entryId: item.entryId, text: item.text }));
    }
    if (runs.length === 0) return null;

    const { query, queryKey } = buildQuery(verifiedInputs);
    return {
      identity,
      target,
      nativeId: api.conversationId,
      // 新记录 run 冻结此刻的 retention floor；只读 Bot 不记录（canWrite=false），但仍用该 run 计算 recall。
      runs: runs.map((run) => ({ ...run, floorEntryId })),
      query,
      queryKey,
      canWrite,
    };
  }

  function verifySubmissionRecord(run, record) {
    if (!record || record.type !== 'input' || record.conversationId !== run.nativeId) return false;
    if (record.requestId !== run.requestId) return false;
    if (record.status === 'done' && record.entry !== run.entryId) return false;
    return true;
  }

  /** 收集前校验解析身份与跟踪行映射一致，杜绝旧银行装入当前上下文数据。 */
  function verifyRunOwner(run, identity, meta) {
    if (run.botId !== undefined && run.botId !== identity.botId) {
      throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked run bot mismatch');
    }
    if (run.kind === 'primary') {
      if (identity.scopeId !== null) {
        throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked primary run conversation became a scope');
      }
      if (run.target !== undefined && run.target.kind !== 'primary') {
        throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked primary run target mismatch');
      }
    } else {
      if (!meta?.scopeId || identity.scopeId !== meta.scopeId) {
        throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked scope run mismatch');
      }
      if (run.target !== undefined && (run.target.kind !== 'scope' || run.target.scopeId !== meta.scopeId)) {
        throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked scope run target mismatch');
      }
    }
  }

  async function entryAt(conversation, entryId, callContext) {
    safeEntryId(entryId, 'entryId');
    const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId, order: 'ascending' }, 1, undefined, callContext);
    return page.items[0] ?? null;
  }

  function primaryItems(run, record, conversation, callContext, identity) {
    return entryAt(conversation, record.entry, callContext).then((inputEntry) =>
      entryAt(conversation, record.answer, callContext).then((answerEntry) => {
        if (!inputEntry || !answerEntry) {
          throw sourceError('HINDSIGHT_STORE_FAILED', 'primary run entry is missing');
        }
        const items = [];
        const inputText = textFromMessage(inputEntry.model?.[0], 'user');
        if (inputText.length > 0 && PRIMARY_INPUT_KINDS.has(inputEntry.kind)) {
          items.push({
            text: inputText,
            timestamp: requiredIso(isoFromMs(inputEntry.model?.[0]?.timestamp), 'primary input'),
            source: {
              version: 1,
              kind: 'primary-input',
              deviceId: identity.deviceId,
              botId: identity.botId,
              conversationId: identity.conversationId,
              nativeId: run.nativeId,
              submissionId: run.submissionId,
              requestIdHash: sha256Hex(run.requestId),
              entryId: inputEntry.id,
              author: { kind: 'control' }, // control-caller，非推断人类
            },
          });
        }
        const answerText = textFromMessage(answerEntry.model?.[0], 'assistant');
        if (answerText.length > 0) {
          items.push({
            text: answerText,
            timestamp: requiredIso(isoFromMs(answerEntry.model?.[0]?.timestamp), 'primary answer'),
            source: {
              version: 1,
              kind: 'primary-answer',
              deviceId: identity.deviceId,
              botId: identity.botId,
              conversationId: identity.conversationId,
              nativeId: run.nativeId,
              entryId: answerEntry.id,
              author: { kind: 'bot', botId: identity.botId },
            },
          });
        }
        return items;
      }),
    );
  }

  function scopeMessageItem(run, entry, identity, meta) {
    const data = entry.data;
    const message = data.message;
    return {
      text: message.text,
      timestamp: requiredIso(typeof message.createdAt === 'string' ? message.createdAt : null, 'scope message'),
      source: {
        version: 1,
        kind: 'scope-message',
        deviceId: identity.deviceId,
        botId: identity.botId,
        conversationId: identity.conversationId,
        nativeId: run.nativeId,
        scopeId: identity.scopeId,
        scopeKind: meta.kind,
        entryId: entry.id,
        localId: data.localId,
        messageId: message.messageId,
        sourceDeviceId: message.sourceDeviceId,
        digest: data.digest,
        storedAt: data.storedAt,
        revision: message.revision,
        category: message.category,
        rootId: message.rootId,
        replyTo: message.replyTo,
        targets: message.targets,
        author: message.author,
      },
    };
  }

  /** 最终回答锚定 native conversation+entry，去掉 per-submission requestId/submissionId。 */
  function workAnswerItem(run, record, conversation, callContext, identity) {
    return entryAt(conversation, record.answer, callContext).then((answerEntry) => {
      if (!answerEntry) {
        throw sourceError('HINDSIGHT_STORE_FAILED', 'work answer entry is missing');
      }
      const text = textFromMessage(answerEntry.model?.[0], 'assistant');
      if (text.length === 0) return null;
      return {
        text,
        timestamp: requiredIso(isoFromMs(answerEntry.model?.[0]?.timestamp), 'work answer'),
        source: {
          version: 1,
          kind: 'work-answer',
          deviceId: identity.deviceId,
          botId: identity.botId,
          conversationId: identity.conversationId,
          nativeId: run.nativeId,
          scopeId: identity.scopeId,
          scopeKind: identity.kind,
          entryId: answerEntry.id,
          author: { kind: 'bot', botId: identity.botId },
        },
      };
    });
  }

  async function collectRun(run, afterEntryId, callContext = context) {
    safeEntryId(run.nativeId, 'run.nativeId');
    const floorEntryId = Number.isSafeInteger(run.floorEntryId) && run.floorEntryId > 0 ? run.floorEntryId : 0;
    const startAfter = Math.max(Number.isSafeInteger(afterEntryId) && afterEntryId >= 0 ? afterEntryId : 0, floorEntryId);
    const h = harness();
    const submission = await h.submission(run.submissionId, callContext);
    if (!submission) throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked submission is missing');
    const record = await submission.status(callContext);
    if (record.status === 'queued' || record.status === 'placed') {
      return { status: 'pending', items: [], afterEntryId: startAfter, done: false };
    }
    if (record.status === 'unanswered') {
      return { status: 'unanswered', items: [], afterEntryId: startAfter, done: false };
    }
    if (record.status !== 'done' || !verifySubmissionRecord(run, record)) {
      throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked run submission mismatch');
    }

    const conversation = await h.conversation(run.nativeId, callContext);
    if (!conversation) throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked conversation is missing');
    const identity = await resolveIdentity(run.nativeId, callContext);
    if (!identity) throw sourceError('HINDSIGHT_STORE_FAILED', 'tracked run is not owned by a local bot');
    const meta = await h.snapshot(WorkContextState, run.nativeId, callContext);
    verifyRunOwner(run, identity, meta);

    if (run.kind === 'primary') {
      const items = await primaryItems(run, record, conversation, callContext, identity);
      const after = Math.max(record.entry, record.answer);
      return { status: 'ready', items, afterEntryId: after, done: true };
    }

    // 工作：冻结 native 视图（stored cutoff），取贡献的 scope-message 条目（分页 50）。
    const view = await conversation.context(callContext, { at: run.cutoff });
    const visible = visibleMessages(view);
    const selected = [];
    for (let i = 0; i < view.entries.length && selected.length < PAGE_SIZE; i++) {
      const entry = view.entries[i];
      if (entry.id <= startAfter) continue;
      if (entry.kind !== SCOPE_MESSAGE_KIND) continue;
      const data = entry.data;
      if (!isPlainObject(data) || !isPlainObject(data.message) || data.message.scopeId !== meta.scopeId) continue;
      if (data.selfEcho === true) continue;
      if (!contributes(view, i, visible)) continue;
      if (typeof data.message.text !== 'string' || data.message.text.length === 0) continue;
      selected.push(scopeMessageItem(run, entry, identity, meta));
    }
    if (selected.length === PAGE_SIZE) {
      const lastId = selected[selected.length - 1].source.entryId;
      return { status: 'ready', items: selected, afterEntryId: lastId, done: false };
    }
    const answerItem = await workAnswerItem(run, record, conversation, callContext, identity);
    const items = answerItem ? [...selected, answerItem] : selected;
    return { status: 'ready', items, afterEntryId: run.cutoff, done: true };
  }

  /** 把 SourceText 加工为 PreparedJob：脱敏、分块、确定性 documentId/fingerprint。 */
  function makeHindsightJobs(memoryContext, items) {
    if (!isPlainObject(memoryContext) || !isPlainObject(memoryContext.target)) {
      throw sourceError('INVALID_ARGUMENT', 'makeHindsightJobs requires a normalized context');
    }
    const target = normalizeTarget(memoryContext.target);
    const botId = nonBlankString(memoryContext.botId, 'context.botId');
    const targetKind = target.kind;
    // 固定 context/tag 标记，不复制任意原始 scopeId（身份已在 bank 哈希/省名）。
    const contextLabel = 'e-launcher:' + targetKind;
    const tags = ['source:e-launcher', 'target:' + targetKind];

    const jobs = [];
    const list = Array.isArray(items) ? items : [];
    for (const item of list) {
      if (!isPlainObject(item)) throw sourceError('INVALID_ARGUMENT', 'source item must be a plain object');
      if (typeof item.text !== 'string') throw sourceError('INVALID_ARGUMENT', 'source text must be a string');
      if (!isPlainObject(item.source)) throw sourceError('INVALID_ARGUMENT', 'source provenance must be a plain object');
      if (targetKind === 'shared' && !['control-note', 'tool-note'].includes(item.source.kind)) {
        throw sourceError('HINDSIGHT_STORE_FAILED', 'automatic transcripts cannot target shared memory');
      }
      const timestamp = requiredIso(item.timestamp, 'source');
      if (item.text.length === 0) continue;
      const redacted = redactMemoryText(item.text);
      // raw-source 摘要必须包含原文，不能只哈希元数据。
      const rawDigest = sha256Hex(JSON.stringify({ source: item.source, text: item.text }));
      const chunks = splitChunks(redacted, CHUNK_MAX_UNITS);
      for (let part = 0; part < chunks.length; part++) {
        const proven = { ...item.source, part: { index: part, count: chunks.length } };
        const content = JSON.stringify({ formatVersion: 1, provenance: proven, text: chunks[part] });
        const locator = sourceLocator(item.source);
        const documentId = 'elauncher-source-' + sha256Hex(JSON.stringify([
          'hindsight-source-v1',
          deviceId,
          botId,
          targetKind,
          targetKind === 'scope' ? target.scopeId : null,
          locator,
          rawDigest,
          part,
        ]));
        const metadata = { provenance: JSON.stringify(proven) };
        const fingerprint = sha256Hex(JSON.stringify([documentId, content, contextLabel, metadata, tags, timestamp]));
        jobs.push({
          documentId,
          fingerprint,
          payload: { documentId, content, context: contextLabel, metadata, tags, timestamp },
          source: proven,
        });
      }
    }
    return jobs;
  }

  return { captureRequest, collectRun, makeHindsightJobs };
}
