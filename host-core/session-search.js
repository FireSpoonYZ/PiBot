import { randomUUID } from 'node:crypto';
import { PrimaryIndex } from './runtime-docs.js';
import { WorkIndex } from './work-context-docs.js';
import { resolveBotIdentity } from './bot-identity.js';
import { messageError } from './message-protocol.js';

const MAX_CONVERSATIONS = 128;
const MAX_CURSORS = 128;
const CURSOR_TTL = 15 * 60 * 1000;
const SCAN_STEPS = 128;
const SCAN_UNITS = 64 * 1024;
const OUTPUT_BYTES = 40 * 1024;
const READ_UNITS = 2048;
const EXCERPT_UNITS = 512;
const DENIED = new Set(['SCOPE_NOT_FOUND', 'SCOPE_DELETED', 'SCOPE_FORBIDDEN', 'BOT_CONTEXT_REQUIRED']);

function fail(code, message) { throw messageError(code, message); }

// Only actual display text, never model envelopes, tool arguments, thinking, or attachment bytes.
function textParts(entry) {
  if (entry.kind === 'host.scope-message') {
    const message = entry.data?.message;
    return typeof message?.text === 'string' && message.author?.kind !== 'host'
      ? [{ role: 'user', messageIndex: 0, blockIndex: 0, text: message.text,
        source: 'scope', authorKind: message.author?.kind === 'user' ? 'user' : 'bot' }]
      : [];
  }
  if (!['host.user-message', 'pi.user', 'pi.assistant'].includes(entry.kind) ||
      entry.data?.attribution?.kind === 'host') return [];
  const parts = [];
  for (const [messageIndex, message] of (entry.model ?? []).entries()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content === 'string') {
      parts.push({ role: message.role, messageIndex, blockIndex: 0, text: message.content, source: 'model' });
    } else {
      for (const [blockIndex, block] of (message.content ?? []).entries()) {
        if (block.type === 'text') {
          parts.push({ role: message.role, messageIndex, blockIndex, text: block.text, source: 'model' });
        }
      }
    }
  }
  return parts;
}

function endOfChunk(text, start, length) {
  let end = Math.min(text.length, start + length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return end;
}

/** Read-only, runtime-local cursor metadata; no transcript copy, index, or new persistence. */
export function createSessionSearch({ host, getHarness, getWorkContexts }) {
  const cursors = new Map();

  async function authorize(candidate, botId, context) {
    const harness = getHarness();
    const identity = await resolveBotIdentity(host, harness, candidate.nativeId, context);
    if (identity.botId !== botId || identity.conversationId !== candidate.conversationId ||
        identity.scopeId !== candidate.scopeId) fail('BOT_CONTEXT_REQUIRED', 'conversation ownership changed');
    if (candidate.scopeId !== null) {
      const { binding } = await getWorkContexts().resolveWorkContext(botId, candidate.scopeId);
      if (binding?.nativeId !== candidate.nativeId || binding.conversationId !== candidate.conversationId) {
        fail('BOT_CONTEXT_REQUIRED', 'work conversation binding changed');
      }
    }
    context.abortSignal?.throwIfAborted();
  }

  async function candidates(botId, conversationId, context) {
    const harness = getHarness();
    const bot = host.getBot(botId);
    const primary = await harness.snapshot(PrimaryIndex, context);
    const work = await harness.snapshot(WorkIndex, context);
    const list = [];
    const nativeId = primary?.byPrimary[bot.primaryConversationId];
    if (nativeId !== undefined) {
      list.push({ nativeId, conversationId: bot.primaryConversationId, scopeId: null });
    }
    for (const [key, binding] of Object.entries(work?.byKey ?? {})) {
      const [owner, scopeId] = JSON.parse(key);
      if (owner === botId) list.push({ ...binding, scopeId });
    }
    const selected = conversationId ? list.filter((item) => item.conversationId === conversationId) : list;
    if (selected.length > MAX_CONVERSATIONS) {
      fail('INVALID_ARGUMENT', 'snapshot exceeds 128 conversations; narrow with conversationId');
    }
    const allowed = [];
    for (const item of selected) {
      try {
        await authorize(item, botId, context);
        allowed.push(item);
      } catch (error) {
        if (!DENIED.has(error?.code)) throw error;
      }
    }
    if (conversationId && allowed.length === 0) fail('CONVERSATION_NOT_FOUND', 'conversation is not currently accessible');
    return harness.commit(async (tx) => {
      const result = [];
      for (const item of allowed) {
        context.abortSignal?.throwIfAborted();
        result.push({ ...item, tail: await tx.latestEntryId(item.nativeId) ?? 0,
          head: (await tx.latestHeadMarker(item.nativeId))?.id ?? 0 });
      }
      return result;
    }, context);
  }

  async function checkHeads(items, context) {
    await getHarness().commit(async (tx) => {
      for (const item of items) {
        context.abortSignal?.throwIfAborted();
        // shortcut: any head change invalidates cursors; distinguish compaction only with a stable reset epoch API.
        if (((await tx.latestHeadMarker(item.nativeId))?.id ?? 0) !== item.head) {
          fail('STALE_CURSOR', 'conversation reset or context head changed; restart without cursor');
        }
      }
    }, context);
  }

  function remember(state) {
    for (const [key, value] of cursors) if (value.expires <= Date.now()) cursors.delete(key);
    while (cursors.size >= MAX_CURSORS) cursors.delete(cursors.keys().next().value);
    const token = randomUUID();
    cursors.set(token, state);
    return token;
  }

  return async function sessionSearch(args, api, context) {
    context.abortSignal?.throwIfAborted();
    const harness = getHarness();
    const caller = await resolveBotIdentity(host, harness, api.conversationId, context);
    await authorize({ ...caller, nativeId: api.conversationId }, caller.botId, context);
    // The SDK validates the input schema; these are the action-specific constraints.
    if (args.action === 'search' && (args.query === undefined || args.entryId !== undefined ||
        args.before !== undefined || args.after !== undefined)) {
      fail('INVALID_ARGUMENT', 'search requires query and does not accept entryId/before/after');
    }
    if (args.action === 'read' && (args.query !== undefined || !args.conversationId || args.entryId === undefined)) {
      fail('INVALID_ARGUMENT', 'read requires conversationId and entryId, and does not accept query');
    }
    const request = { action: args.action, query: args.query ?? null, conversationId: args.conversationId ?? null,
      entryId: args.entryId ?? null, before: args.before ?? 2, after: args.after ?? 2, limit: args.limit ?? 10 };
    const key = JSON.stringify(request);
    let state;
    if (args.cursor) {
      const saved = cursors.get(args.cursor);
      if (!saved || saved.expires <= Date.now()) fail('STALE_CURSOR', 'cursor expired, evicted, or Host restarted; restart without cursor');
      if (saved.botId !== caller.botId || saved.key !== key) fail('INVALID_ARGUMENT', 'cursor belongs to another Bot or request');
      state = structuredClone(saved);
    } else {
      state = { botId: caller.botId, key, expires: Date.now() + CURSOR_TTL,
        conversations: await candidates(caller.botId, args.conversationId, context),
        index: 0, phase: args.action === 'read' ? 'locate' : 'search', position: null,
        part: 0, offset: 0, neighbors: 0 };
    }
    // Never use cursor possession as an authorization grant (including completed conversations).
    for (const item of state.conversations) await authorize(item, caller.botId, context);
    await checkHeads(state.conversations, context);
    const items = [];
    let steps = 0;
    let units = 0;
    let bytes = 0;
    const add = (item) => {
      const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (bytes + size > OUTPUT_BYTES) return false;
      items.push(item);
      bytes += size;
      return true;
    };
    const advanceEntry = (entry) => {
      state.position = entry.id + (state.phase === 'after' ? 1 : -1);
      state.part = 0;
      state.offset = 0;
    };
    const finishSide = () => {
      if (state.phase === 'before') {
        state.phase = 'after';
        state.position = args.entryId + 1;
        state.part = 0;
        state.offset = 0;
        state.neighbors = 0;
      } else {
        state.index++;
        state.position = null;
        state.part = 0;
        state.offset = 0;
      }
    };

    while (state.index < state.conversations.length && steps < SCAN_STEPS &&
        units < SCAN_UNITS - 512 && items.length < request.limit) {
      context.abortSignal?.throwIfAborted();
      const candidate = state.conversations[state.index];
      const ascending = state.phase === 'after';
      if (ascending && state.neighbors >= request.after) { finishSide(); continue; }
      const position = state.position ?? candidate.tail;
      if ((!ascending && position <= 0) || (ascending && position > candidate.tail)) {
        if (state.phase === 'locate') fail('ENTRY_NOT_FOUND', 'entry is not visible after reset');
        finishSide();
        continue;
      }
      const conversation = await harness.conversation(candidate.nativeId, context);
      const page = await conversation.entries({
        order: ascending ? 'ascending' : 'descending',
        ...(ascending ? { minEntryId: position, maxEntryId: candidate.tail } : { maxEntryId: position }),
      }, 1, undefined, context);
      steps++;
      const entry = page.items[0];
      if (!entry || entry.kind === 'pi.reset') {
        if (state.phase === 'locate') fail('ENTRY_NOT_FOUND', 'entry is not visible after reset');
        finishSide();
        continue;
      }
      if (state.phase === 'locate') {
        if (entry.id < args.entryId) fail('ENTRY_NOT_FOUND', 'entry is not in this conversation');
        if (entry.id !== args.entryId) { advanceEntry(entry); continue; }
        if (!textParts(entry).some((part) => part.text.length)) fail('ENTRY_NOT_FOUND', 'entry has no user/assistant text');
        state.phase = 'before';
        state.position = entry.id;
      }
      const parts = textParts(entry);
      if (state.part >= parts.length) {
        if (state.phase !== 'search' && parts.some((part) => part.text.length) && entry.id !== args.entryId) state.neighbors++;
        advanceEntry(entry);
        if (state.phase === 'before' && (entry.id === args.entryId ? request.before === 0 : state.neighbors >= request.before)) finishSide();
        continue;
      }
      const { text, ...source } = parts[state.part];
      if (state.offset >= text.length) { state.part++; state.offset = 0; continue; }
      const base = { conversationId: candidate.conversationId, scopeId: candidate.scopeId, entryId: entry.id, ...source };
      if (state.phase === 'search') {
        // Literal, case-sensitive search in bounded windows, including matches across window boundaries.
        const end = endOfChunk(text, state.offset, Math.min(READ_UNITS, SCAN_UNITS - units - request.query.length));
        const window = text.slice(state.offset, end + request.query.length - 1);
        const found = window.indexOf(request.query);
        if (found !== -1 && state.offset + found < end) {
          const matchOffset = state.offset + found;
          const excerptEnd = endOfChunk(text, matchOffset, Math.max(EXCERPT_UNITS, request.query.length));
          if (!add({ ...base, offset: matchOffset, text: text.slice(matchOffset, excerptEnd),
            matchOffset, truncated: matchOffset > 0 || excerptEnd < text.length })) break;
          // One hit per text block; read retrieves all original chunks, not just the excerpt.
          state.part++;
          state.offset = 0;
        } else {
          state.offset = end;
        }
        units += window.length;
      } else {
        const end = endOfChunk(text, state.offset, Math.min(READ_UNITS, SCAN_UNITS - units));
        if (!add({ ...base, offset: state.offset, text: text.slice(state.offset, end),
          truncated: state.offset > 0 || end < text.length })) break;
        units += end - state.offset;
        state.offset = end;
      }
    }
    context.abortSignal?.throwIfAborted();
    // Reject concurrent resets and revocations before any collected text leaves the tool.
    await authorize({ ...caller, nativeId: api.conversationId }, caller.botId, context);
    for (const candidate of state.conversations) await authorize(candidate, caller.botId, context);
    await checkHeads(state.conversations, context);
    const nextCursor = state.index < state.conversations.length ? remember(state) : null;
    return { action: args.action, botId: caller.botId, items, nextCursor,
      scannedEntryReads: steps, scannedTextUnits: units, complete: nextCursor === null };
  };
}
