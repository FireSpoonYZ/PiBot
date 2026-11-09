// host-core/bot-learning.js
// Host 侧 Bot 学习驱动：
// - 主会话用户提交完结后向 Center learning 服务上报真实增量快照（自动 review 入口）；
// - 手动与自动 learn|review|curate 作业由 next→agent.run→respond 循环驱动；
// - agent.run 在独立的受限 Durable 会话执行：只注册回调给出的 OpenAI 函数 schema
//   对应的工具，并强制 allowedTools 白名单；技能调用经
//   centerClient.botLearning {action:'tool',jobId,callId,name,args} 回 Center
//   （callId 由 agent.run 回调 id 与模型工具调用 id 派生，Center 按 (jobId,callId) 幂等）
//   记忆/显式资料经 Host 本地受限能力执行，绝不放开 bash/管理等通用工具面；
// - 触发计数、间隔阈值、配置、作业持久化全在 Center learning 服务，
//   Host 不保存阈值、不按完成条数强行触发，只提供真实增量；
// - 与上游的适配边界：上游 fork 复用父会话缓存前缀，这里按契约重建独立
//   ownerless 会话，不声称缓存等价；messages 在 OpenAI 式与 pi-ai 式之间做尽力
//   双向投影（thinking 块、图片字节与 provider 私有字段不保真）。
import { createHash, randomUUID } from 'node:crypto';
import { withCancel } from '@earendil-works/chord/context';
import { defineExtension, defineTool, hook, GenerationTask, ResetEntry } from '@earendil-works/pi-durable';
import { messageError } from './message-protocol.js';
import { parseModelRef } from './runtime-models.js';
import { countRequestTokens, countMessageTokens } from './request-context.js';
import { declareLearningSources, readLearningSource } from './learning-sources.js';

const REPLAY_ENTRY_KIND = 'learning.replay';
const INPUT_ENTRY_KIND = 'learning.review-input';
const RESET_ENTRY_KIND = ResetEntry.kind;
// 增量快照一次最多扫描的主会话条目数；冷启动/重启后游标缺失时取最近一段尾部，
// 避免把整段历史塞进一次 start 请求。
const SNAPSHOT_MAX_ENTRIES = 120;
// 单次 start 携带快照的上限：超出时丢弃最旧消息并标记 truncated，绝不静默截断。
const SNAPSHOT_MAX_BYTES = 256 * 1024;
// 回放给 review 会话的上游 transcript 条数上限：超限时保留最新一段（最近上下文
// 对 review 最有价值），截断只发生在 agent.run 边界，不回改源数据。
const REPLAY_MAX_MESSAGES = 256;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const REVIEW_MAX_TOOLS = 64;
const DRIVE_MAX_CONSECUTIVE_ERRORS = 3;
const CLOSE_CANCEL_TIMEOUT_MS = 3000;

const TERMINAL_JOB_STATUS = new Set([
  'completed', 'done', 'failed', 'cancelled', 'canceled', 'succeeded',
  'faulted', 'error', 'interrupted', 'skipped', 'stopped',
]);
const PUBLIC_ACTIONS = new Set(['status', 'configure', 'learn', 'review', 'curate', 'cancel']);
const JOB_MODES = new Set(['learn', 'review', 'curate']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// memory.call 只允许映射到既有 Hindsight 能力动作；上游 memory 工具语义由
// Center 侧适配器决定暴露与否，本侧不发明第二套记忆接口。
const MEMORY_ACTIONS = new Set([
  'memoryStatus', 'recallMemory', 'reflectMemory', 'retainMemory',
  'getMemory', 'getMemorySource', 'correctMemory',
]);
// 回执/工具错误对外只透传这组已知码；其余一律折叠为 INTERNAL，绝不把
// 凭据/provider 细节写进学习通道。
const SAFE_ERROR_CODES = new Set([
  'INVALID_ARGUMENT', 'BOT_NOT_FOUND', 'CENTER_OFFLINE', 'INVALID_STATE',
  'REQUEST_CONFLICT', 'MODEL_REQUIRED', 'MODEL_NOT_FOUND', 'RUNTIME_BUSY',
  'NOT_CONNECTED', 'CONTEXT_LIMIT', 'INTERNAL', 'EXTENSION_DISABLED',
  'EXTENSION_READ_ONLY', 'FORBIDDEN', 'VALIDATION_FAILED', 'CANCELLED',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonBlank(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw messageError('INVALID_ARGUMENT', name + ' must be a non-empty string');
  }
  return value;
}

function safeCode(err) {
  return typeof err?.code === 'string' && SAFE_ERROR_CODES.has(err.code) ? err.code : 'INTERNAL';
}

function safeMessage(err, fallback = 'learning operation failed') {
  return typeof err?.message === 'string' && err.message !== '' ? err.message.slice(0, 200) : fallback;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** pi-ai 消息 -> OpenAI 式消息（快照与 agent.run 返回值共用，工具调用/结果原样保留）。 */
function toOpenAiMessage(message) {
  if (message?.role === 'user') {
    if (typeof message.content === 'string') return { role: 'user', content: message.content };
    const parts = [];
    for (const block of message.content ?? []) {
      if (block?.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (block?.type === 'image') parts.push({ type: 'text', text: '[image omitted]' });
    }
    return { role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts };
  }
  if (message?.role === 'assistant') {
    const texts = [];
    const toolCalls = [];
    for (const block of message.content ?? []) {
      if (block?.type === 'text') texts.push(block.text);
      else if (block?.type === 'toolCall') {
        let args = '{}';
        try { args = JSON.stringify(block.arguments ?? {}); } catch { /* 保持原样失败不阻塞投影 */ }
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: args } });
      }
      // thinking/redacted 块不进入 OpenAI 投影（上游 transcript 也不含它们）。
    }
    const out = { role: 'assistant', content: texts.join('\n') };
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    return out;
  }
  if (message?.role === 'toolResult') {
    const texts = [];
    for (const block of message.content ?? []) {
      if (block?.type === 'text') texts.push(block.text);
      else if (block?.type === 'image') texts.push('[image omitted]');
    }
    return { role: 'tool', tool_call_id: message.toolCallId, content: texts.join('\n') };
  }
  if (message?.role === 'system') {
    const content = typeof message.content === 'string'
      ? message.content
      : (message.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
    return { role: 'system', content };
  }
  return null;
}

/**
 * OpenAI 式消息 -> pi-ai 消息（agent.run transcript 回放）。
 * 回放的 assistant 行必须带 api/provider/model/usage/stopReason：usage 置零，
 * provider/api/model 用本次解析到的执行模型标注来源，stopReason 按是否含
 * tool_calls 分派；这是投影而非伪造——真实生成的消息由 durable 运行自己写。
 */
function toPiMessage(message, stamp) {
  if (!isPlainObject(message) || typeof message.role !== 'string') return null;
  const timestamp = stamp.next();
  if (message.role === 'system') {
    const content = typeof message.content === 'string' ? message.content : '';
    return { role: 'system', content, timestamp };
  }
  if (message.role === 'user') {
    if (typeof message.content === 'string') return { role: 'user', content: message.content, timestamp };
    const parts = [];
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
      else if (part != null) parts.push({ type: 'text', text: '[non-text content omitted]' });
    }
    return { role: 'user', content: parts.length ? parts : '', timestamp };
  }
  if (message.role === 'assistant') {
    const content = [];
    const text = typeof message.content === 'string'
      ? message.content
      : (Array.isArray(message.content) ? message.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');
    if (text) content.push({ type: 'text', text });
    for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = tc?.function?.name;
      if (typeof name !== 'string' || name === '') continue;
      let args = {};
      try {
        const parsed = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments;
        if (isPlainObject(parsed)) args = parsed;
      } catch { /* 参数非法时以空调用投影；模型在回放中只见调用事实 */ }
      content.push({ type: 'toolCall', id: typeof tc.id === 'string' && tc.id !== '' ? tc.id : 'call_' + randomUUID(), name, arguments: args });
    }
    return {
      role: 'assistant',
      content,
      api: stamp.api, provider: stamp.provider, model: stamp.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
      timestamp,
    };
  }
  if (message.role === 'tool') {
    const text = typeof message.content === 'string'
      ? message.content
      : (Array.isArray(message.content) ? message.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');
    return {
      role: 'toolResult',
      toolCallId: typeof message.tool_call_id === 'string' && message.tool_call_id !== '' ? message.tool_call_id : 'call_unknown',
      toolName: stamp.toolName(message.tool_call_id),
      content: [{ type: 'text', text }],
      isError: false,
      timestamp,
    };
  }
  return null;
}

/** 一次 agent.run 的回放上下文：递增时间戳 + tool_call_id -> toolName 索引。 */
function replayStamp({ provider, api, model }) {
  const base = Date.now();
  let index = 0;
  const names = new Map();
  return {
    api, provider, model,
    next() { return base - 1_000_000 + (index++); },
    toolName(callId) {
      return names.get(callId) ?? 'tool';
    },
    learn(messages) {
      for (const m of messages) {
        if (m?.role !== 'assistant') continue;
        for (const tc of m.tool_calls ?? []) {
          const name = tc?.function?.name;
          if (typeof tc?.id === 'string' && tc.id !== '' && typeof name === 'string' && name !== '') {
            names.set(tc.id, name);
          }
        }
      }
    },
  };
}

function assistantTextOf(entry) {
  const texts = [];
  for (const message of entry?.model ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block?.type === 'text') texts.push(block.text);
    }
  }
  return texts.join('\n');
}

const EMPTY_USAGE = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 });

function addUsage(sum, usage) {
  if (!usage) return;
  sum.input += usage.input ?? 0;
  sum.output += usage.output ?? 0;
  sum.cacheRead += usage.cacheRead ?? 0;
  sum.cacheWrite += usage.cacheWrite ?? 0;
  sum.reasoning += usage.reasoning ?? 0;
  sum.costUsd += usage.cost?.total ?? 0;
}

/**
 * Bot 学习驱动的 Host 侧装配。deps 全部由 runtime.js 注入：
 * - host：本机 Bot/设备事实源（deviceId、SOUL、primaryConversationId）；
 * - getHarness/models/getBotModels：受限会话与 review 模型解析；
 * - getCenterClient：Center learning 通道（botLearning 固定路径方法）；
 * - plugins：memory.call 到 Hindsight 能力动作的唯一映射入口；
 * - openPrimaryConversation/dropEnvFor：主会话只读访问与 review 会话执行环境回收；
 * - registry：受限 review 扩展须先 install（SDK 按名称从注册表解析扩展），
 *   名称按 jobId+callId 唯一，运行结算或取消后在 finally 卸载，防多 Bot 互覆。
 */
export function createBotLearning({ host, getHarness, models, getBotModels, getCenterClient, plugins, schedules, getUsableModelRefs, registry, context, openPrimaryConversation, dropEnvFor, isBotIdle }) {
  let closing = false;
  let suspended = false;
  const deferredReports = new Map();
  // botId -> {jobId, controller, done}：一个 Bot 同时只驱动一个学习作业（Center
  // 侧本来按 Bot 串行，此处是防御性单槽）。
  const jobs = new Map();
  // botId -> Promise：自动上报按 Bot 串行，游标推进只发生在 Center 受理之后。
  const reportChains = new Map();
  // botId -> 已上报的最大 entryId：Center 受理即推进；失败保留，下次完结把
  // 未上报区间一并捎上——增量从不丢、也不重发 Center 已确认的部分。
  const reportCursors = new Map();

  function requireClient() {
    const client = getCenterClient?.();
    if (!client || typeof client.botLearning !== 'function') {
      throw messageError('CENTER_OFFLINE', 'center learning channel is unavailable');
    }
    return client;
  }

  function requireBot(botId) {
    assertNonBlank(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot) throw messageError('BOT_NOT_FOUND', 'bot not found: ' + botId);
    return bot;
  }

  async function memoryStatus(botId, signal) {
    try {
      const status = await plugins.actionByName(botId, 'learningMemoryStatus', {}, { signal });
      if (status?.enabled !== true || status.canRead !== true || typeof status.canWrite !== 'boolean' ||
          !['read-only', 'read-write'].includes(status.mode) || status.canWrite !== (status.mode === 'read-write')) {
        throw messageError('INVALID_STATE', 'Hindsight returned an invalid learning readiness result');
      }
      return { enabled: true, canRead: true, canWrite: status.canWrite, mode: status.mode };
    } catch (err) {
      if (err?.code === 'EXTENSION_DISABLED') return { enabled: false, canRead: false, canWrite: false };
      throw messageError(safeCode(err), 'Cannot determine authorized Hindsight readiness');
    }
  }

  function assertUsableModel(ref) {
    const parsed = parseModelRef(ref);
    if (!getUsableModelRefs().has(ref) || !models.getModel(parsed.provider, parsed.modelId)) {
      throw messageError('MODEL_NOT_FOUND', 'Learning model is not configured and usable by this Host');
    }
  }

  /**
   * 从已提交主会话历史构建 OpenAI 式快照：
   * - incremental=true 时从上次已受理游标之后取真实增量；游标缺失（冷启动/重启）
   *   回退为最近一段尾部，绝不按「每完成一条消息」强行上报全量；
   * - incremental=false（手动 learn/review/curate）总是取最近尾部，对齐上游
   *   显式 review 复放整段会话的行为；
   * - pi.reset 之后的上下文才算数：扫描中遇到 reset 条目清掉已累计消息。
   */
  async function buildSnapshot(bot, { incremental }) {
    const conversation = await openPrimaryConversation(bot);
    if (!conversation && incremental) return null;
    const cursor = reportCursors.get(bot.botId) ?? 0;
    const entries = [];
    if (conversation && incremental && cursor > 0) {
      let pageCursor;
      for (;;) {
        const page = await conversation.entries({ order: 'ascending', minEntryId: cursor + 1 }, SNAPSHOT_MAX_ENTRIES, pageCursor, context);
        entries.push(...(page?.items ?? []));
        if (!page?.next || entries.length >= SNAPSHOT_MAX_ENTRIES) break;
        pageCursor = page.next;
      }
      if (entries.length === 0) return null;
    } else if (conversation) {
      let pageCursor;
      for (;;) {
        const page = await conversation.entries({ order: 'descending' }, SNAPSHOT_MAX_ENTRIES, pageCursor, context);
        // descending 页内部是新到旧：反转后按页 unshift，保证整体升序。
        entries.unshift(...(page?.items ?? []).reverse());
        if (!page?.next || entries.length >= SNAPSHOT_MAX_ENTRIES) break;
        pageCursor = page.next;
      }
      if (entries.length > SNAPSHOT_MAX_ENTRIES) entries.splice(0, entries.length - SNAPSHOT_MAX_ENTRIES);
      if (entries.length === 0 && incremental) return null;
    }
    const messages = [];
    // 每条 assistant 消息 = 一次真实模型迭代；Center 累计增量触发 skill review。
    let iterations = 0;
    for (const entry of entries) {
      if (entry.kind === RESET_ENTRY_KIND) {
        messages.length = 0;
        continue;
      }
      for (const message of entry.model ?? []) {
        if (message?.role === 'assistant') iterations += 1;
        const projected = toOpenAiMessage(message);
        if (projected) messages.push(projected);
      }
    }
    // 字节预算内保留最新尾部：丢弃最旧消息并在 span.truncated 如实标记。
    let truncated = 0;
    while (messages.length > 0 && Buffer.byteLength(JSON.stringify(messages), 'utf8') > SNAPSHOT_MAX_BYTES) {
      messages.shift();
      truncated += 1;
    }
    if (messages.length === 0 && incremental) return null;
    const throughEntryId = entries[entries.length - 1]?.id ?? 0;
    const selection = getBotModels?.()[bot.botId] ?? {};
    let model = null;
    let provider = null;
    if (typeof selection.modelRef === 'string' && selection.modelRef.trim() !== '') {
      try {
        const parsed = parseModelRef(selection.modelRef.trim());
        provider = parsed.provider;
        model = parsed.modelId;
      } catch { /* modelRef 异常时如实缺省，由 Center 决定 */ }
    }
    const memory = await memoryStatus(bot.botId);
    const snapshot = {
      messages,
      sessionId: bot.primaryConversationId,
      memoryEnabled: memory.enabled,
      memory,
      span: {
        afterEntryId: incremental ? cursor : 0,
        throughEntryId,
        truncated,
      },
    };
    if (model && provider) {
      snapshot.model = model;
      snapshot.provider = provider;
    }
    try {
      snapshot.systemPrompt = host.getBotSoul(bot.botId).text;
    } catch { /* SOUL 缺失不阻断快照 */ }
    // iterations 随返回而非塞进 snapshot：Center 白名单会丢弃未知快照字段，
    // 自动 start 须把它放在 action 顶层。
    return { snapshot, iterations };
  }

  /** 上报提交对应的可信发送者 kind（user|host|null）：只认 entry.data 注入的归属，绝不信 wire 字段。 */
  async function submissionSenderKind(submissionId) {
    const harness = getHarness();
    const submission = await harness.submission(submissionId, context);
    if (!submission) return null;
    const record = await submission.status(context);
    if (record?.type !== 'input' || typeof record.entry !== 'number') return null;
    const entry = await harness.commit((tx) => tx.entry(record.entry), context);
    const kind = entry?.data?.turn?.sender?.kind ?? entry?.data?.attribution?.kind;
    return kind === 'user' || kind === 'host' ? kind : null;
  }

  /** Center 回执里有存活 jobId 才驱动；状态为已知终态词时不进入长轮询。 */
  function liveJob(receipt) {
    return isPlainObject(receipt) &&
      typeof receipt.jobId === 'string' && receipt.jobId !== '' &&
      !TERMINAL_JOB_STATUS.has(receipt.status);
  }

  function abortJob(job) {
    job.controller.abort();
  }

  function startDriver(bot, jobId, meta) {
    const existing = jobs.get(bot.botId);
    if (existing?.jobId === jobId) return existing;
    if (existing) {
      jobs.delete(bot.botId);
      abortJob(existing);
      void safeCancelRemote(bot.botId, existing.jobId);
    }
    const controller = new AbortController();
    const job = { botId: bot.botId, jobId, controller, mode: meta?.mode ?? null, automatic: meta?.automatic === true,
      sources: meta?.sources ?? [], activeRun: null, done: null };
    job.done = driveJob(bot, job);
    jobs.set(bot.botId, job);
    job.done.catch(() => {}).finally(() => {
      if (jobs.get(bot.botId) === job) jobs.delete(bot.botId);
    });
    return job;
  }

  /** 尽力取消远端作业；Center 不通时静默（Center 超时机制兜底标记 interrupted）。 */
  async function safeCancelRemote(botId, jobId) {
    try {
      const client = getCenterClient?.();
      if (!client || typeof client.botLearning !== 'function' || typeof jobId !== 'string' || jobId === '') return;
      await client.botLearning(host.deviceId, botId, { action: 'cancel', jobId }, AbortSignal.timeout(CLOSE_CANCEL_TIMEOUT_MS));
    } catch { /* 尽力而为 */ }
  }

  /**
   * next→respond 长轮询驱动：Center 每交出一个 agent.run/memory.call 回调，
   * Host 执行后 respond 回结果；终态/关闭/断线即退出，绝不伪造完成。
   */
  async function driveJob(bot, job) {
    let consecutiveErrors = 0;
    let completedCall = null;
    for (;;) {
      if (closing || job.controller.signal.aborted) return;
      const client = getCenterClient?.();
      if (!client || typeof client.botLearning !== 'function') return;
      let poll;
      try {
        poll = await client.botLearning(host.deviceId, bot.botId, { action: 'next', jobId: job.jobId }, job.controller.signal);
        consecutiveErrors = 0;
      } catch {
        if (closing || job.controller.signal.aborted) return;
        // 连续传输失败即停止驱动：作业由 Center 超时机制如实结算，不假装存活。
        if (++consecutiveErrors >= DRIVE_MAX_CONSECUTIVE_ERRORS) return;
        await sleep(500, job.controller.signal);
        continue;
      }
      if (!isPlainObject(poll)) return;
      if (TERMINAL_JOB_STATUS.has(poll.status)) return;
      const call = poll.call;
      if (!isPlainObject(call) || typeof call.id !== 'string' || call.id === '') {
        await sleep(250, job.controller.signal);
        continue;
      }
      // Center has one outstanding call: a failed response retries this outcome, not its effects.
      if (completedCall?.id !== call.id) {
        completedCall = null;
        // A model call can outlive a remote cancellation or Center timeout.
        // Observe the job in parallel and stop the provider before releasing its extension.
        const watch = new AbortController();
        const stopWatch = () => watch.abort();
        job.controller.signal.addEventListener('abort', stopWatch, { once: true });
        const watching = (async () => {
          while (!watch.signal.aborted) {
            await sleep(1000, watch.signal);
            if (watch.signal.aborted) break;
            try {
              const current = await client.botLearning(host.deviceId, bot.botId, { action: 'next', jobId: job.jobId }, watch.signal);
              if (TERMINAL_JOB_STATUS.has(current?.status) || (current?.call && current.call.id !== call.id)) {
                abortJob(job);
                break;
              }
            } catch {
              if (!watch.signal.aborted) abortJob(job);
              break;
            }
          }
        })();
        try {
          completedCall = { id: call.id, outcome: await executeCall(bot, job, call) };
        } finally {
          watch.abort();
          job.controller.signal.removeEventListener('abort', stopWatch);
          await watching;
        }
      }
      try {
        await client.botLearning(host.deviceId, bot.botId, {
          action: 'respond', jobId: job.jobId, callId: call.id, ...completedCall.outcome,
        }, job.controller.signal);
        consecutiveErrors = 0;
      } catch {
        if (closing || job.controller.signal.aborted) return;
        if (++consecutiveErrors >= DRIVE_MAX_CONSECUTIVE_ERRORS) return;
      }
    }
  }

  async function executeCall(bot, job, call) {
    try {
      if (call.method === 'agent.run') {
        return { result: await runAgentRun(bot, job, call) };
      }
      if (call.method === 'memory.call') {
        return { result: await runMemoryCall(bot, job, call) };
      }
      if (call.method === 'schedule.call') {
        if (job.mode !== 'curate' || call.params?.name !== 'referenced_skill_names') {
          throw messageError('FORBIDDEN', 'Curator jobs can only read schedule skill references');
        }
        job.controller.signal.throwIfAborted();
        return { result: await schedules.learningSkillCall(bot, call.params.name, call.params.args ?? {}, { signal: job.controller.signal }) };
      }
      return { error: { code: 'INVALID_ARGUMENT', message: 'unsupported call method: ' + String(call.method).slice(0, 64) } };
    } catch (err) {
      return { error: { code: safeCode(err), message: safeMessage(err) } };
    }
  }

  /** memory.call：params {name,args} 与 skill.call 同形，仅放行既有 Hindsight 动作名。 */
  async function runMemoryCall(bot, job, call) {
    const params = isPlainObject(call.params) ? call.params : {};
    if (typeof params.name !== 'string' || !MEMORY_ACTIONS.has(params.name)) {
      throw messageError('INVALID_ARGUMENT', 'unsupported memory action');
    }
    return executeMemory(bot, job, params.name, params.args ?? {}, call.id, job.controller.signal);
  }

  async function executeMemory(bot, job, name, input, callId, signal) {
    signal.throwIfAborted();
    if (job.mode === 'curate' || !MEMORY_ACTIONS.has(name) || !isPlainObject(input) ||
        Object.hasOwn(input, 'target') || Object.hasOwn(input, 'requestId')) {
      throw messageError('FORBIDDEN', 'Learning memory is limited to this Bot primary bank');
    }
    const status = await memoryStatus(bot.botId, signal);
    if (!status.enabled) throw messageError('EXTENSION_DISABLED', 'Enable and configure Hindsight for this Bot in Center first');
    const write = name === 'retainMemory' || name === 'correctMemory';
    if (write && !status.canWrite) throw messageError('EXTENSION_READ_ONLY', 'Hindsight is read-only');
    if (name === 'correctMemory' && job.automatic) throw messageError('FORBIDDEN', 'Automatic memory review is append-only');
    const args = { ...input };
    if (write) args.requestId = 'learning-' + createHash('sha256').update(JSON.stringify([job.jobId, callId])).digest('hex');
    let receipt;
    try { receipt = await plugins.actionByName(bot.botId, name, args, { signal }); }
    catch (err) { throw messageError(safeCode(err), 'Hindsight action failed; check capability configuration and operation receipts'); }
    if (!write) return { success: true, result: receipt };
    const completed = name === 'correctMemory' ? receipt?.state === 'applied'
      : Array.isArray(receipt?.jobs) && receipt.jobs.length > 0 && receipt.jobs.every((item) => item.state === 'completed');
    const failed = ['rejected', 'unconfirmed'].includes(receipt?.state) || receipt?.jobs?.some((item) => item.state === 'failed');
    // Only a real completed receipt contributes an upstream write notification.
    return { success: !failed, completed, staged: !completed, receipt,
      message: completed ? 'Hindsight memory updated (confirmed receipt)' : 'Hindsight write not confirmed complete; inspect receipt before claiming success' };
  }

  async function executeLocalTool(bot, job, name, args, callId, signal) {
    if (name === 'memory') {
      const { action, ...input } = args;
      return executeMemory(bot, job, action, input, callId, signal);
    }
    if (job.mode !== 'learn' || job.automatic) throw messageError('FORBIDDEN', 'Material tools are manual-learn only');
    return readLearningSource(job.sources, args, signal, async (url, sourceSignal) => {
      try { return await plugins.actionByName(bot.botId, 'readLearningSource', { url }, { signal: sourceSignal }); }
      catch (err) { throw messageError(safeCode(err), 'Webfox extraction unavailable; configure an authorized contents provider in Center, then retry learn'); }
    });
  }

  /** 本次 review 的模型解析：agent.run 的 provider/model 覆盖优先，否则用 Bot 当前中心选择。 */
  function resolveReviewModel(bot, params) {
    const selection = getBotModels?.()[bot.botId] ?? {};
    let provider = null;
    let modelId = null;
    if (typeof selection.modelRef === 'string' && selection.modelRef.trim() !== '') {
      try {
        const parsed = parseModelRef(selection.modelRef.trim());
        provider = parsed.provider;
        modelId = parsed.modelId;
      } catch { /* 落回参数解析 */ }
    }
    if (typeof params.provider === 'string' && params.provider.trim() !== '') provider = params.provider.trim();
    if (typeof params.model === 'string' && params.model.trim() !== '') modelId = params.model.trim();
    if (!provider || !modelId) throw messageError('MODEL_REQUIRED', 'review model is required');
    assertUsableModel(provider + '/' + modelId);
    const model = models.getModel(provider, modelId);
    if (!model) throw messageError('MODEL_NOT_FOUND', 'review model is unavailable: ' + provider + '/' + modelId);
    const reasoning = params.reasoningConfig;
    let thinkingLevel = selection.thinkingLevel ?? null;
    const effort = typeof reasoning === 'string' ? reasoning : reasoning?.effort;
    if (typeof effort === 'string' && THINKING_LEVELS.has(effort)) thinkingLevel = effort;
    return { provider, modelId, model, thinkingLevel };
  }

  /** 回调 tools[] -> 受限工具注册项：name/描述/schema 原样透传，execute 统一回 Center。 */
  function normalizeToolSpecs(params) {
    const specs = [];
    const seen = new Set();
    for (const item of Array.isArray(params.tools) ? params.tools : []) {
      const fn = item?.type === 'function' ? item.function : item;
      const name = fn?.name;
      if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
      seen.add(name);
      if (seen.size > REVIEW_MAX_TOOLS) break;
      specs.push({
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: isPlainObject(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
      });
    }
    return specs;
  }

  function buildReviewExtension(bot, job, call, specs, allowed, budget) {
    const tools = specs.map((spec) => defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      // 每次调用都过 Center 网络：重启后绝不自动重放未确认调用。
      replay: 'unsafe',
      callers: ['model'],
      outputLimits: { maxBytes: TOOL_OUTPUT_MAX_BYTES },
      async execute(args, api, toolContext) {
        if (!allowed.has(spec.name)) {
          return {
            output: [{ type: 'text', text: 'Background review denied non-whitelisted tool: ' + spec.name +
              '. Allowed here: ' + (allowed.size ? [...allowed].join(', ') : '(none)') +
              '. Do not retry ' + spec.name + '.' }],
            isError: true,
          };
        }
        try {
          const signal = AbortSignal.any([job.controller.signal, toolContext.abortSignal].filter(Boolean));
          signal.throwIfAborted();
          const toolCallId = 'tool-' + createHash('sha256').update(JSON.stringify([call.id, api.callId])).digest('hex');
          if (spec.name === 'memory' || spec.name === 'learning_source') {
            const result = await executeLocalTool(bot, job, spec.name, args, toolCallId, signal);
            return { output: [{ type: 'text', text: JSON.stringify(result) }], ...(result?.success === false ? { isError: true } : {}) };
          }
          const client = requireClient();
          const envelope = await client.botLearning(host.deviceId, bot.botId, {
            action: 'tool', jobId: job.jobId, callId: toolCallId, name: spec.name, args: isPlainObject(args) ? args : {},
          }, signal);
          // Center 回执 {jobId,callId,name,result}：result 为 JSON string，原样喂回模型
          // （摘要器读取其中 success/_change 等键），envelope 元信息不透给模型。
          const raw = isPlainObject(envelope) ? envelope.result : envelope;
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? { success: false });
          let failed = false;
          try { failed = JSON.parse(text)?.success === false; } catch { /* 非 JSON 按成功文本透传 */ }
          return {
            output: [{ type: 'text', text }],
            ...(failed ? { isError: true } : {}),
          };
        } catch (err) {
          // 工具失败作为 tool result 原样回喂模型（与上游工具错误同形），不中止本轮。
          return {
            output: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: safeCode(err), message: safeMessage(err) } }) }],
            isError: true,
          };
        }
      },
    }));
    const hooks = [];
    if (budget !== null) {
      let usedInputTokens = 0;
      hooks.push(hook(GenerationTask, {
        afterResponse(message) {
          if (message?.usage) usedInputTokens += (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
        },
        async beforeRequest(request, api, hookContext) {
          const estimate = countRequestTokens(request) + countMessageTokens({ text: JSON.stringify(specs) });
          if (usedInputTokens + estimate <= budget) return undefined;
          // 与 host.request-context 同型：hook 异常会被 SDK 吞掉，先显式中止当前任务再抛。
          try { await getHarness().abortTask(api.taskId, hookContext); } catch { /* 已终态 */ }
          throw messageError('CONTEXT_LIMIT', 'review input token budget exceeded');
        },
      }));
    }
    return defineExtension({ name: 'learning.review.' + job.jobId + '.' + call.id, tools, hooks });
  }

  /**
   * 执行一次 agent.run：独立 ownerless 会话 + 受限工具扩展 + maxTurns/输入 token 硬预算；
   * 返回 {final_response,messages,usage}，messages 为整段 OpenAI 式 transcript
   * （回放 + 本轮新增），与上游摘要器的 prior-snapshot 去重语义兼容。
   */
  async function runAgentRun(bot, job, call) {
    const harness = getHarness();
    const params = isPlainObject(call.params) ? call.params : {};
    const resolved = resolveReviewModel(bot, params);
    const specs = normalizeToolSpecs(params);
    const allowed = new Set(
      Array.isArray(params.allowedTools)
        ? params.allowedTools.filter((name) => typeof name === 'string' && name !== '')
        : specs.map((spec) => spec.name),
    );
    const maxTurns = Number.isSafeInteger(params.maxIterations) && params.maxIterations >= 1
      ? params.maxIterations : undefined;
    const budget = Number.isSafeInteger(params.maxInputTokens) && params.maxInputTokens >= 1
      ? params.maxInputTokens : null;

    const { context: runContext, cancel } = withCancel(context);
    const run = { cancel, conversation: null, abortPromise: null };
    let timedOut = false;
    const onAbort = () => {
      cancel();
      if (run.conversation && !run.abortPromise) {
        run.abortPromise = run.conversation.abort(context, { background: true }).catch(() => {});
      }
    };
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
    job.activeRun = run;
    const timeout = Number.isSafeInteger(params.maxDurationMs) && params.maxDurationMs > 0
      ? setTimeout(() => { timedOut = true; onAbort(); }, params.maxDurationMs) : null;
    timeout?.unref?.();
    if (job.controller.signal.aborted) onAbort();
    let reviewExtension = null;
    let submission = null;
    try {
      const stamp = replayStamp({ provider: resolved.provider, api: resolved.model.api ?? 'openai-completions', model: resolved.modelId });
      stamp.learn(Array.isArray(params.messages) ? params.messages : []);
      const replayed = [];
      const source = Array.isArray(params.messages) ? params.messages : [];
      for (const message of source.slice(-REPLAY_MAX_MESSAGES)) {
        const pi = toPiMessage(message, stamp);
        if (pi) replayed.push(pi);
      }
      reviewExtension = buildReviewExtension(bot, job, call, specs, allowed, budget);
      // SDK 按扩展名从注册表解析：必须先 install；名称含 jobId+callId，多 Bot/作业不互覆。
      registry.install(reviewExtension);
      const agent = {
        model: { provider: resolved.provider, modelId: resolved.modelId },
        thinkingLevel: resolved.thinkingLevel,
        instructions: null,
        cwd: bot.cwd,
        extensions: [reviewExtension],
      };
      if (maxTurns !== undefined) agent.maxTurns = maxTurns;
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, runContext);
      run.conversation = conversation;
      if (replayed.length > 0) {
        await harness.commit(async (tx) => {
          for (const message of replayed) {
            await tx.appendEntry(conversation.id, { kind: REPLAY_ENTRY_KIND, model: [message] });
          }
        }, runContext);
      }
      const prompt = typeof params.prompt === 'string' ? params.prompt : '';
      submission = prompt.trim() !== ''
        ? await conversation.submit({ type: 'input', content: prompt, whenBusy: 'reject', entry: { kind: INPUT_ENTRY_KIND } }, runContext)
        : await conversation.submit({ type: 'continue' }, runContext);
      const settled = await submission.wait(runContext);
      return await collectRun(conversation, settled, runContext);
    } catch (err) {
      if (timedOut) throw messageError('INVALID_STATE', 'review call timed out');
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
      job.controller.signal.removeEventListener('abort', onAbort);
      if (submission && (timedOut || job.controller.signal.aborted)) {
        if (!run.abortPromise) run.abortPromise = run.conversation.abort(context, { background: true }).catch(() => {});
        await run.abortPromise;
        await submission.wait(context).catch(() => {});
      }
      if (job.activeRun === run) job.activeRun = null;
      // 运行已结算（submission.wait 返回）或被取消：卸载受限扩展，注册表不留残留。
      if (reviewExtension) { try { registry.uninstall(reviewExtension); } catch { /* 未安装过 */ } }
      const conversationId = run.conversation?.id;
      if (typeof conversationId === 'number') {
        dropEnvFor?.(conversationId).catch(() => {});
      }
    }
  }

  /** 汇总整段 transcript（回放 + 生成），累加真实 provider usage，取最终回答文本。 */
  async function collectRun(conversation, settled, runContext) {
    const messages = [];
    const usage = EMPTY_USAGE();
    let apiCalls = 0;
    let cursor;
    for (;;) {
      const page = await conversation.entries({ order: 'ascending' }, 256, cursor, runContext);
      for (const entry of page?.items ?? []) {
        for (const message of entry.model ?? []) {
          if (entry.kind !== REPLAY_ENTRY_KIND && message?.role === 'assistant') {
            addUsage(usage, message.usage);
            if (message.usage && (message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite) > 0) apiCalls += 1;
          }
          const projected = toOpenAiMessage(message);
          if (projected) messages.push(projected);
        }
      }
      if (!page?.next) break;
      cursor = page.next;
    }
    if (settled?.status !== 'done' || typeof settled.answer !== 'number') {
      throw messageError('INVALID_STATE', 'review run failed: ' + (settled?.reason ?? settled?.status ?? 'unknown'));
    }
    let finalResponse = '';
    let reason;
    if (settled?.status === 'done' && typeof settled.answer === 'number') {
      const answer = await getHarness().commit((tx) => tx.entry(settled.answer), runContext);
      finalResponse = assistantTextOf(answer);
    } else if (settled?.status === 'unanswered') {
      reason = typeof settled.reason === 'string' ? settled.reason : 'unanswered';
    }
    const result = {
      final_response: finalResponse,
      messages,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite,
        reasoning_tokens: usage.reasoning,
        api_calls: apiCalls,
        estimated_cost_usd: usage.costUsd,
      },
    };
    if (reason) result.reason = reason;
    return result;
  }

  /**
   * 自动学习入口（runtime 在 recordCompletedSubmission 内 fire-and-forget 调用）：
   * 只报 user 来源完结提交（计划任务等 host 来源与上游 skip_background_review 同型跳过），
   * 上报真实增量快照；Center 决定是否受理成作业，Host 不保存触发阈值。
   */
  function noteCompletedSubmission(botId, formatted) {
    if (closing || !formatted || formatted.status !== 'done') return;
    const submissionId = formatted.submissionId;
    if (typeof submissionId !== 'number' && typeof submissionId !== 'string') return;
    const previous = reportChains.get(botId) ?? Promise.resolve();
    const next = previous.then(() => {
      if (suspended) deferredReports.set(submissionId, botId);
      else return reportCompletedSubmission(botId, submissionId);
    }).catch(() => {});
    reportChains.set(botId, next);
    next.finally(() => {
      if (reportChains.get(botId) === next) reportChains.delete(botId);
    });
  }

  async function reportCompletedSubmission(botId, submissionId) {
    if (closing) return;
    const client = getCenterClient?.();
    if (!client || typeof client.botLearning !== 'function') return;
    const bot = host.getBot(botId);
    if (!bot) return;
    // 仅真实用户轮触发；归属缺失按最保守处理（不上报），绝不拿 host 来源凑数。
    const senderKind = await submissionSenderKind(submissionId).catch(() => null);
    if (senderKind !== 'user') return;
    const status = await client.botLearning(host.deviceId, botId, { action: 'status' });
    if (status.settings?.reviewModelRef) assertUsableModel(status.settings.reviewModelRef);
    const storedCursor = status?.counters?.reviewCursor;
    reportCursors.set(botId, storedCursor?.sessionId === bot.primaryConversationId ? storedCursor.throughEntryId : 0);
    const built = await buildSnapshot(bot, { incremental: true });
    if (!built) return;
    const { snapshot, iterations } = built;
    const requestId = 'auto-review:' + bot.primaryConversationId + ':' + snapshot.span.throughEntryId;
    if (suspended) { deferredReports.set(submissionId, botId); return; }
    const receipt = await client.botLearning(host.deviceId, botId, {
      action: 'start', mode: 'review', automatic: true, requestId, snapshot, iterations,
    });
    // Center 已受理本次增量（无论是否成 job）：推进游标，未受理的下次完结补报。
    reportCursors.set(botId, snapshot.span.throughEntryId);
    if (liveJob(receipt)) startDriver(bot, receipt.jobId, { mode: 'review', automatic: true });
  }

  /**
   * runtime.manageBotLearning：status/configure/cancel 直转 Center；
   * learn/review/curate 先 start，拿到存活 jobId 即挂驱动并回诚实回执。
   */
  async function manageBotLearning(botId, input = {}) {
    const bot = requireBot(botId);
    const action = input?.action;
    if (typeof action !== 'string' || !PUBLIC_ACTIONS.has(action)) {
      throw messageError('INVALID_ARGUMENT', 'action must be one of status|configure|learn|review|curate|cancel');
    }
    const client = requireClient();
    if (action === 'status') {
      const forward = { action: 'status' };
      if (typeof input.jobId === 'string' && input.jobId !== '') forward.jobId = input.jobId;
      return client.botLearning(host.deviceId, botId, forward);
    }
    if (action === 'configure') {
      if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw messageError('BOT_ARCHIVED', 'bot is archived and read-only');
      }
      for (const key of ['reviewModelRef', 'curatorModelRef']) {
        if (input.config?.[key] != null) assertUsableModel(input.config[key]);
      }
      const forward = { ...input, action: 'configure' };
      const result = await client.botLearning(host.deviceId, botId, forward);
      if (input.config?.enabled === false) {
        const job = jobs.get(botId);
        if (job) abortJob(job);
      }
      return result;
    }
    if (action === 'cancel') {
      const job = jobs.get(botId);
      const jobId = typeof input.jobId === 'string' && input.jobId !== '' ? input.jobId : null;
      if (job && (jobId === null || job.jobId === jobId)) abortJob(job);
      const forward = { action: 'cancel' };
      if (jobId) forward.jobId = jobId;
      return client.botLearning(host.deviceId, botId, forward);
    }
    if (!JOB_MODES.has(action)) throw messageError('INVALID_ARGUMENT', 'unsupported learning action');
    // 归档 Bot 只读（与 scheduleTask 同口径）：configure/启动新作业一律拒绝，
    // status/cancel 放行以便查询与清理在途作业。
    if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
      throw messageError('BOT_ARCHIVED', 'bot is archived and read-only');
    }
    if (input.sources !== undefined && action !== 'learn') throw messageError('INVALID_ARGUMENT', 'sources are only accepted for learn');
    const sources = await declareLearningSources(input.sources, bot.cwd);
    const settings = (await client.botLearning(host.deviceId, botId, { action: 'status' })).settings;
    const auxiliary = action === 'review' ? settings.reviewModelRef : action === 'curate' ? settings.curatorModelRef : null;
    if (auxiliary) assertUsableModel(auxiliary);
    const requestId = typeof input.requestId === 'string' && input.requestId !== '' ? input.requestId : randomUUID();
    const start = { action: 'start', mode: action, requestId, automatic: false };
    if (typeof input.focus === 'string' && input.focus !== '') start.focus = input.focus;
    if (isPlainObject(input.snapshot)) {
      const memory = await memoryStatus(botId);
      start.snapshot = { ...input.snapshot, memory, memoryEnabled: memory.enabled };
    } else {
      const built = await buildSnapshot(bot, { incremental: false });
      if (built) start.snapshot = built.snapshot;
    }
    if (suspended) throw messageError('RUNTIME_BUSY', 'host is preparing an update');
    start.sources = sources.map((source) => source.value);
    const receipt = await client.botLearning(host.deviceId, botId, start);
    if (liveJob(receipt)) {
      startDriver(bot, receipt.jobId, { mode: action, automatic: false, sources });
      return { ...receipt, driven: true };
    }
    return { ...receipt, driven: false };
  }

  let curatorTickRunning = false;
  async function tickCurator() {
    if (closing || suspended || curatorTickRunning) return;
    const client = getCenterClient?.();
    if (!client) return;
    curatorTickRunning = true;
    try {
      for (const bot of host.listBots()) {
        if (closing || suspended || bot.archivedAt || jobs.has(bot.botId)) continue;
        try {
          const status = await client.botLearning(host.deviceId, bot.botId, { action: 'status' });
          const settings = status.settings;
          if (status.activeJob) continue;
          const lastActivity = Date.parse(bot.lastActivityAt ?? bot.createdAt);
          if (!Number.isFinite(lastActivity) || Date.now() - lastActivity < settings.curator.minIdleHours * 3_600_000) continue;
          if (!(await isBotIdle(bot))) continue;
          if (settings.curatorModelRef) assertUsableModel(settings.curatorModelRef);
          const built = await buildSnapshot(bot, { incremental: false });
          if (!built) continue;
          if (suspended) continue;
          const receipt = await client.botLearning(host.deviceId, bot.botId, {
            action: 'start', mode: 'curate', automatic: true, requestId: randomUUID(), snapshot: built.snapshot,
          });
          if (liveJob(receipt)) startDriver(bot, receipt.jobId, { mode: 'curate', automatic: true });
        } catch { /* retry on the next idle tick */ }
      }
    } finally {
      curatorTickRunning = false;
    }
  }
  let curatorRun = Promise.resolve();
  const curatorTimer = setInterval(() => {
    if (!curatorTickRunning) curatorRun = tickCurator();
  }, 60_000);
  curatorTimer.unref?.();

  /** Bot 删除/归档前调用：中止在驱动作业并尽力向 Center 取消。 */
  async function cancelBot(botId) {
    reportCursors.delete(botId);
    const job = jobs.get(botId);
    if (!job) return;
    abortJob(job);
    await safeCancelRemote(botId, job.jobId);
  }

  /** Center 断线：本地全部作业中止（provider/工具调用经 runContext 取消），不发取消请求。 */
  function notifyOffline() {
    // Keep cancellation visible until the provider and restricted extension settle.
    for (const job of jobs.values()) abortJob(job);
  }

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(curatorTimer);
    const active = [...jobs.values()];
    for (const job of active) abortJob(job);
    await Promise.allSettled(active.map((job) => job.done));
    await Promise.allSettled(active.map((job) => safeCancelRemote(job.botId, job.jobId)));
    jobs.clear();
    reportChains.clear();
    deferredReports.clear();
  }

  function resume() {
    suspended = false;
    for (const [submissionId, botId] of deferredReports) {
      noteCompletedSubmission(botId, { status: 'done', submissionId });
    }
    deferredReports.clear();
  }

  return {
    manageBotLearning, noteCompletedSubmission, cancelBot, notifyOffline, close,
    suspend: () => { suspended = true; },
    resume,
    drainAdmissions: () => Promise.allSettled([...reportChains.values(), curatorRun]),
    isActive: (botId) => jobs.has(botId),
    waitForJobs: () => Promise.allSettled([...jobs.values()].map((job) => job.done)),
  };
}
