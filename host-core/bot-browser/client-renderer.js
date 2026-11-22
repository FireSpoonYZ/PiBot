import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserError, validateFramePayload } from './protocol.js';
import { classifyPageSensitivity, validateNavigationUrl } from './policy.js';

const POLL_MS = 3_000;
const ACTIVE_MS = 12_000;
const COMMAND_MS = 12_000;

export function createClientBrowserRenderer({ rendererId, clientId, maxTabs, maxFrameBytes }) {
  const pages = new Map();
  const pendingUrls = new Set();
  const commands = new Map();
  const sessionId = randomUUID();
  let activePageId = null;
  let frameSeq = 0;
  let closed = false;
  let closeCode = 'BROWSER_CLOSED';
  let closeMessage = undefined;
  let closeDetails = undefined;
  let seenAt = Date.now();
  let waiting = null;
  let mutation = Promise.resolve();

  const closedError = () => browserError(closeCode, closeMessage, closeDetails);
  const online = () => !closed && Date.now() - seenAt < ACTIVE_MS;
  function takeCommand() {
    for (const record of commands.values()) {
      if (record.dispatched) continue;
      record.dispatched = true;
      return record.payload;
    }
    return null;
  }

  function request(operation, pageId, params = {}, signal) {
    if (closed) return Promise.reject(closedError());
    if (!online()) return Promise.reject(browserError('BROWSER_UNAVAILABLE'));
    if (commands.size >= 16) return Promise.reject(browserError('BROWSER_BUSY'));
    if (signal?.aborted) return Promise.reject(browserError('CANCELLED'));
    const operationId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (value, code, message, details) => {
        if (!commands.delete(operationId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (!code) resolve(value);
        else reject(browserError(code, message, { ...details, outcome: record.dispatched ? 'unconfirmed' : 'not-sent' }));
      };
      const abort = () => finish(null, 'CANCELLED');
      const timer = setTimeout(() => finish(null, 'BROWSER_TIMEOUT'), COMMAND_MS);
      timer.unref?.();
      const record = { finish, dispatched: false, payload: { operationId, operation, pageId, ...params } };
      commands.set(operationId, record);
      signal?.addEventListener('abort', abort, { once: true });
      waiting?.(takeCommand());
    });
  }

  function next() {
    if (closed) throw closedError();
    seenAt = Date.now();
    if (waiting) throw browserError('BROWSER_BUSY');
    const command = takeCommand();
    if (command) return { command };
    return new Promise(resolve => {
      const finish = (payload) => {
        waiting = null;
        clearTimeout(timer);
        resolve({ command: payload });
      };
      const timer = setTimeout(() => finish(null), POLL_MS);
      timer.unref?.();
      waiting = finish;
    });
  }

  function reply({ operationId, result, code }) {
    if (closed) return { accepted: false };
    const record = commands.get(operationId);
    if (!record?.dispatched) return { accepted: false };
    seenAt = Date.now();
    record.finish(result, code);
    return { accepted: true };
  }

  function status() {
    const page = pages.get(activePageId);
    return {
      available: online(),
      canStreamInteract: online(),
      reason: online() ? null : 'client_browser_disconnected',
      ...(page ? {
        sessionId,
        pageId: activePageId,
        documentGeneration: page.documentGeneration,
        url: page.url,
        title: page.title,
        hints: page.hints,
        sensitive: classifyPageSensitivity(page).sensitive,
      } : { pageId: null }),
      tabs: Array.from(pages, ([id, tab]) => ({ id, url: tab.url, title: tab.title })),
    };
  }

  function update(page, data) {
    if (typeof data?.url === 'string') page.url = validateNavigationUrl(data.url, { actor: 'human', allowBlank: true });
    if (typeof data?.title === 'string') page.title = data.title.slice(0, 256);
    if (Number.isSafeInteger(data?.documentGeneration)) page.documentGeneration = data.documentGeneration;
    if (data?.hints) page.hints = data.hints;
  }

  async function navigate(operation, pageId, url, signal) {
    if (url) pendingUrls.add(url);
    try {
      return await request(operation, pageId, url ? { url } : {}, signal);
    } finally {
      if (url) pendingUrls.delete(url);
    }
  }

  function guard(page, input, frame = false) {
    if (input.documentGeneration !== undefined && input.documentGeneration !== page.documentGeneration) {
      throw browserError('BROWSER_STALE_DOCUMENT');
    }
    const sensitivity = classifyPageSensitivity(page);
    if (sensitivity.blockNormalFrame || (input.actor === 'bot' && (sensitivity.blockBotObserve || sensitivity.blockBotAct)) ||
        (frame && sensitivity.sensitive)) {
      throw browserError('BROWSER_SENSITIVE_BLOCKED', sensitivity.guidance, {
        sensitive: true, requiresSystemBrowser: sensitivity.fallbackToSystemBrowser,
      });
    }
  }

  async function perform(input) {
    const { action, signal } = input;
    if (closed) throw closedError();
    if (!online() && action === 'status') return status();
    if (action === 'open') {
      if (pages.size >= maxTabs) throw browserError('BROWSER_TAB_LIMIT');
      const url = validateNavigationUrl(input.url ?? 'about:blank', { actor: input.actor, allowBlank: true });
      const pageId = randomUUID();
      const page = { url, title: '', documentGeneration: 0, hints: null };
      const created = await navigate('create', pageId, url, signal);
      if (closed) throw closedError();
      update(page, created);
      pages.set(pageId, page);
      activePageId = pageId;
      return status();
    }
    if (action === 'release') {
      const ownedPages = [...pages.keys()];
      pages.clear();
      activePageId = null;
      await Promise.allSettled(ownedPages.map(id => request('close', id)));
      return status();
    }
    const pageId = input.pageId ?? activePageId;
    const page = pages.get(pageId);
    if (!page && action === 'status') return status();
    if (!page) throw browserError('BROWSER_PAGE_NOT_FOUND');
    if (action === 'select') {
      activePageId = pageId;
      return status();
    }
    if (action === 'closeTab') {
      await request('close', pageId, {}, signal);
      if (closed) throw closedError();
      pages.delete(pageId);
      if (activePageId === pageId) activePageId = Array.from(pages.keys()).at(-1) ?? null;
      return status();
    }
    if (action === 'status') {
      const live = await request('status', pageId, {}, signal);
      if (closed) throw closedError();
      update(page, live);
      return { ...status(), canGoBack: live.canGoBack, canGoForward: live.canGoForward };
    }
    if (action === 'navigate' || ['back', 'forward', 'reload'].includes(action)) {
      const url = action === 'navigate' ? validateNavigationUrl(input.url, { actor: input.actor }) : null;
      const moved = await navigate(action, pageId, url, signal);
      if (closed) throw closedError();
      update(page, moved);
      return status();
    }

    const before = await request('status', pageId, {}, signal);
    if (closed) throw closedError();
    update(page, before);
    const isWait = action === 'act' && input.act.kind === 'wait';
    guard(page, isWait ? { ...input, documentGeneration: undefined } : input, action === 'frame');
    const documentGeneration = page.documentGeneration;
    if (action === 'frame') {
      const captured = await request('frame', pageId, { documentGeneration, expectedUrl: page.url }, signal);
      const after = await request('status', pageId, {}, signal);
      if (closed) throw closedError();
      update(page, after);
      guard(page, { ...input, documentGeneration }, true);
      const frame = validateFramePayload(captured, maxFrameBytes);
      return { ...frame, pageId, seq: ++frameSeq, url: page.url, title: page.title, hints: page.hints, documentGeneration };
    }
    if (action === 'snapshot') {
      const snapshot = await request('snapshot', pageId, { documentGeneration, expectedUrl: page.url }, signal);
      if (closed) throw closedError();
      update(page, snapshot);
      guard(page, { ...input, documentGeneration });
      const refs = Array.isArray(snapshot.elements) ? snapshot.elements.filter(item =>
        Number.isSafeInteger(item?.ref) && item.ref > 0 && item.ref <= 500).map(item => ({
        ref: `e${item.ref}`, name: String(item.text ?? '').slice(0, 160), role: item.role || item.tag, inputType: item.type,
      })) : [];
      const text = [snapshot.text, ...refs.map(item => `[${item.ref}] ${item.role} ${item.name}`)].join('\n');
      return { ...status(), text, refs };
    }
    if (action === 'input') {
      if (input.actor !== 'human') throw browserError('BROWSER_FORBIDDEN');
      input.beforeInput?.();
      await request('input', pageId, { event: input.event, documentGeneration, expectedUrl: page.url }, signal);
      if (closed) throw closedError();
      return { ...status(), ok: true };
    }
    if (action === 'act') {
      const { kind, ref, value, text, key, modifiers, direction, amount } = input.act;
      const target = { documentGeneration, expectedUrl: page.url };
      if (kind === 'wait') {
        const { selector, state, text: query, url, load, timeoutMs } = input.act;
        const conditions = { selector, state, text: query, url, load };
        const timeout = timeoutMs ?? 1_000;
        if (!selector && !query && !url && !load) {
          await delay(timeout, undefined, { signal });
        } else {
          const deadline = Date.now() + timeout;
          for (;;) {
            const result = await request('waitCheck', pageId, { wait: conditions }, signal);
            if (result.ok) break;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw browserError('BROWSER_TIMEOUT', 'Page did not meet the requested condition');
            await delay(Math.min(100, remaining), undefined, { signal });
          }
        }
      } else if (kind === 'type' || kind === 'press' || kind === 'scroll') {
        let event;
        if (kind === 'type') event = { kind: 'text', text };
        else if (kind === 'press') event = { kind: 'key', key, modifiers };
        else {
          const delta = amount ?? 600;
          const deltaX = direction === 'left' ? -delta : direction === 'right' ? delta : 0;
          const deltaY = direction === 'up' ? -delta : direction === 'down' ? delta : 0;
          event = { kind: 'wheel', deltaX, deltaY };
        }
        await request('actInput', pageId, { ...target, event }, signal);
      } else {
        if (!['click', 'dblclick', 'hover', 'fill', 'focus', 'select'].includes(kind) || !/^e[1-9]\d{0,2}$/.test(ref)) {
          throw browserError('BROWSER_ACTION_BLOCKED');
        }
        await request('act', pageId, {
          ...target, action: kind, elementRef: Number(ref.slice(1)), ...(value !== undefined ? { text: value } : {}),
        }, signal);
      }
      const after = await request('status', pageId, {}, signal);
      if (closed) throw closedError();
      update(page, after);
      return { ...status(), ok: true, kind };
    }
    throw browserError('INVALID_ARGUMENT');
  }

  return {
    rendererId, clientId, online, status, next, reply,
    hasTabs: () => pages.size > 0,
    ports: () => [...new Set([...Array.from(pages.values(), page => page.url), ...pendingUrls]
      .map(url => Number(new URL(url).port)).filter(Boolean))],
    hide: (pageId) => request('hide', pageId),
    perform(input) {
      if (input.action === 'frame' || input.action === 'status') return perform(input);
      const task = mutation.then(() => perform(input));
      mutation = task.catch(() => {});
      return task;
    },
    async close(code = 'BROWSER_CLOSED', message = undefined, details = undefined) {
      if (closed) return;
      closed = true;
      closeCode = code;
      closeMessage = message;
      closeDetails = details;
      waiting?.(null);
      for (const record of commands.values()) record.finish(null, code, message, details);
      pages.clear();
      pendingUrls.clear();
      activePageId = null;
    },
  };
}
