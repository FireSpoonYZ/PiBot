// host-core/bot-browser/desktop-provider.js
//
// Desktop Bot browser provider (`createDesktopBrowserProvider(opts)`).
// Manages one isolated headless Chromium-family process per Bot with:
//   - Local Chrome/Edge/Chromium/Brave discovery (no Orca required)
//   - Private per-Bot data dir (never connects to personal profiles)
//   - Private CDP pipe (POSIX) or 127.0.0.1 loopback WebSocket (Windows)
//   - Owned tab/navigation registry with documentGeneration & revision tracking
//   - A latest-only JPEG screencast cache (720 KiB base64 budget, never persisted)
//   - Real same-page mouse/keyboard/wheel human input with pre-dispatch revalidation
//   - Restricted Bot snapshot/act (no eval/cookies/CDP passthrough) + sensitive/ToS/OAuth/secret guards
//
// Portions of tab projection, serial execution queueing, and snapshot structure
// are adapted from Orca v1.4.265 (commit e64e561738d8d465ab459e7e3f9e46d08b6396ea):
//   - src/main/orcad/browser-providers/chromium/external-chromium-browser-process.ts
//   - src/main/orcad/browser-providers/chromium/external-chromium-tab-registry.ts
//   - src/main/orcad/browser-providers/chromium/external-chromium-tab-projection.ts
// The trailing screencast frame pacer follows Orca v1.4.267 (commit baf9c2c328fa95c0ba9c25fda4836b479162d232):
//   - src/main/browser/cdp/screencast/browser-screencast-frame-pacer.ts
// MIT License — Copyright (c) 2026 Lovecast Inc. See ./vendor/orca/LICENSE.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertId } from '../message-protocol.js';
import { hasWaitCondition, normalizeProviderWait } from './protocol.js';
import { launchDesktopChromium } from './desktop-cdp.js';
import { assertPrivateWindowsProfileDir } from './desktop-windows-endpoint.js';
import {
  discoverDesktopBrowser,
  isPersonalBrowserProfilePath,
  prepareBotProfileDir,
  resolveManagedBrowserDir,
} from './desktop-discovery.js';
import {
  ALLOWED_BOT_ACT_KINDS,
  browserError,
  checkBotHumanOnlyTarget,
  classifySensitivePage,
  DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY,
  DESKTOP_BROWSER_DEFAULT_VIEWPORT,
  DESKTOP_BROWSER_FLOOR_FRAME_INTERVAL_MS,
  DESKTOP_BROWSER_HARD_MAX_SNAPSHOT_NODES,
  DESKTOP_BROWSER_HARD_MAX_TABS,
  DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES,
  DESKTOP_BROWSER_MAX_SNAPSHOT_NODES,
  DESKTOP_BROWSER_MAX_SNAPSHOT_TEXT_BYTES,
  DESKTOP_BROWSER_MAX_TABS_PER_BOT,
  DESKTOP_BROWSER_MIN_FRAME_INTERVAL_MS,
  DESKTOP_BROWSER_SCREENCAST_IDLE_STOP_MS,
  FORBIDDEN_ACT_KINDS,
  INTERNAL_DOCUMENT_HANDLE_EXPRESSION,
  INTERNAL_ELEMENT_META_FUNCTION,
  INTERNAL_FILL_ELEMENT_FUNCTION,
  INTERNAL_SELECT_OPTION_FUNCTION,
  INTERNAL_WAIT_CONDITION_FUNCTION,
  isGoogleApiOAuthUrl,
  isPlainObject,
  normalizeHumanInputEvent,
  normalizeInputText,
  normalizeNavigationUrl,
  normalizeViewport,
  resolveCdpKeyDescriptor,
  SENSITIVE_DOM_PROBE_EXPRESSION,
} from './desktop-policy.js';

export {
  DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES,
  DESKTOP_BROWSER_DEFAULT_VIEWPORT,
  discoverDesktopBrowser,
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_CORE_DIR = dirname(MODULE_DIR);
const DEFAULT_COMMAND_TIMEOUT_MS = 25_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_CONDITIONAL_WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_INTERVAL_MS = 50;
const FIRST_SCREENCAST_WAIT_MS = 180;
const ADAPTIVE_JPEG_QUALITIES = Object.freeze([65, 50, 38, 26]);
const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
]);

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value)) {
    throw browserError('INVALID_ARGUMENT', `Expected integer within ${min}..${max}`);
  }
  return Math.max(min, Math.min(max, value));
}

function mouseButtonsBit(button) {
  if (button === 'left') return 1;
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

function truncateText(value, maxChars = 200) {
  const str = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (str.length <= maxChars) return str;
  return `${str.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sleepAbortable(ms, signal, registerCancel, registerWakeup) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(browserError('CANCELLED', 'Browser wait cancelled.', { outcome: 'not-sent' }));
      return;
    }
    let finished = false;
    let timer = null;
    let unregisterCancel = null;
    let unregisterWakeup = null;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      unregisterCancel?.();
      unregisterWakeup?.();
    };
    const onAbort = () => {
      cleanup();
      reject(browserError('CANCELLED', 'Browser wait cancelled.', { outcome: 'not-sent' }));
    };
    const onWake = () => {
      cleanup();
      resolve();
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    unregisterCancel = registerCancel?.(() => onAbort()) ?? null;
    unregisterWakeup = registerWakeup?.(() => onWake()) ?? null;
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeDesktopWaitCommand(input) {
  let command = input.command;
  if (!isPlainObject(command)) {
    // The legacy flat provider API carries routing fields alongside the DOM action.
    const { selector, state, text, url, load, timeoutMs, ms } = input;
    command = { kind: 'wait', selector, state, text, url, load, timeoutMs, ms };
  }
  const wait = normalizeProviderWait(command, 500);
  return { ...wait, hasCondition: hasWaitCondition(wait),
    timeoutMs: wait.timeoutMs ?? wait.ms ?? DEFAULT_CONDITIONAL_WAIT_TIMEOUT_MS };
}

function isSensitiveFieldRoleOrName(role, name, inputType) {
  if (inputType === 'password') return true;
  if (role === 'password') return true;
  return /(?:\bpassword\b|\bpasscode\b|\bclient\s*secret\b|\bsecret\b|\bcvv\b|\bcvc\b|密码|密钥)/i.test(
    String(name || '')
  );
}

/**
 * Format Chromium `Accessibility.getFullAXTree` nodes into a compact, bounded
 * snapshot with ephemeral refs mapped to `backendDOMNodeId`.
 */
function buildAccessibilitySnapshot(nodes, { pageUrl, pageTitle, documentGeneration, interactiveOnly, maxNodes }) {
  const refs = [];
  const refMap = new Map();
  const lines = [];
  let totalBytes = 0;
  let truncated = false;
  let refCounter = 1;

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (refs.length >= maxNodes || lines.length >= maxNodes * 2) {
      truncated = true;
      break;
    }
    if (!node || node.ignored) continue;

    const role = String(node.role?.value ?? '').toLowerCase();
    if (!role || role === 'none' || role === 'generic' || role === 'inlinetextbox') continue;

    const isInteractive = INTERACTIVE_AX_ROLES.has(role);
    const rawName = typeof node.name?.value === 'string' ? node.name.value : '';
    const name = truncateText(rawName, 180);

    if (interactiveOnly && !isInteractive) continue;
    if (!isInteractive && !name && role !== 'heading' && role !== 'dialog' && role !== 'alertdialog') {
      continue;
    }

    const props = new Map();
    for (const prop of Array.isArray(node.properties) ? node.properties : []) {
      if (prop && typeof prop.name === 'string') {
        props.set(prop.name, prop.value?.value);
      }
    }

    const disabled = props.get('disabled') === true;
    const checkedProp = props.get('checked');
    const checked = checkedProp === 'true' || checkedProp === true ? true : checkedProp === 'false' ? false : undefined;
    const focused = props.get('focused') === true;
    const inputType = props.get('autocomplete') === 'current-password' || props.get('autocomplete') === 'new-password'
      ? 'password'
      : '';

    let value = typeof node.value?.value === 'string' ? truncateText(node.value.value, 140) : undefined;
    const isPasswordOrSecret = isSensitiveFieldRoleOrName(role, name, inputType);
    if (isPasswordOrSecret && value !== undefined && value !== '') {
      value = '[REDACTED]';
    }

    let ref = null;
    let humanOnly = false;
    const backendDOMNodeId =
      typeof node.backendDOMNodeId === 'number' && Number.isSafeInteger(node.backendDOMNodeId)
        ? node.backendDOMNodeId
        : null;

    if (isInteractive && backendDOMNodeId !== null) {
      ref = `e${refCounter++}`;
      const guardClick = checkBotHumanOnlyTarget({
        url: pageUrl,
        title: pageTitle,
        role,
        name,
        inputType,
        actionKind: role === 'checkbox' || role === 'radio' ? 'check' : 'click',
      });
      const guardFill = checkBotHumanOnlyTarget({
        url: pageUrl,
        title: pageTitle,
        role,
        name,
        inputType,
        actionKind: 'fill',
      });
      humanOnly = guardClick.blocked || guardFill.blocked;

      const refEntry = {
        ref,
        backendDOMNodeId,
        role,
        name,
        inputType,
        humanOnly,
        documentGeneration,
      };
      refMap.set(ref, refEntry);
      refs.push({
        ref,
        role,
        name,
        ...(value !== undefined ? { value } : {}),
        ...(checked !== undefined ? { checked } : {}),
        ...(disabled ? { disabled: true } : {}),
        ...(focused ? { focused: true } : {}),
        ...(humanOnly ? { humanOnly: true } : {}),
      });
    }

    const parts = [ref ? `[${ref}] ${role}` : role];
    if (name) parts.push(`"${name}"`);
    if (value !== undefined && value !== '') parts.push(`value="${value}"`);
    if (checked !== undefined) parts.push(checked ? '[checked]' : '[unchecked]');
    if (disabled) parts.push('[disabled]');
    if (focused) parts.push('[focused]');
    if (humanOnly) parts.push('[human-only]');
    const line = parts.join(' ');
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (totalBytes + lineBytes > DESKTOP_BROWSER_MAX_SNAPSHOT_TEXT_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += lineBytes;
    lines.push(line);
  }

  return {
    snapshot: lines.join('\n'),
    refs,
    refMap,
    truncated,
  };
}

/**
 * Create a per-Bot desktop Chromium browser provider.
 * Calling `createDesktopBrowserProvider(opts)` never launches a browser process
 * until the first page-opening action (`open` / `navigate`), so `status` is
 * honest and side-effect-free even on hosts without Chrome/Edge/Chromium.
 */
export async function createDesktopBrowserProvider(opts = {}) {
  if (!isPlainObject(opts)) {
    throw browserError('INVALID_ARGUMENT', 'createDesktopBrowserProvider options must be an object');
  }
  assertId(opts.botId, 'opts.botId');

  const botId = opts.botId;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homePath = opts.homePath ?? homedir();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const viewport = normalizeViewport(opts.viewport);
  const maxTabs = clampInt(opts.maxTabs, 1, DESKTOP_BROWSER_HARD_MAX_TABS, DESKTOP_BROWSER_MAX_TABS_PER_BOT);
  const maxFrameBase64Bytes = clampInt(
    opts.maxFrameBase64Bytes,
    32_768,
    DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES,
    DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES
  );
  const minFrameIntervalMs = clampInt(
    opts.minFrameIntervalMs,
    DESKTOP_BROWSER_FLOOR_FRAME_INTERVAL_MS,
    10_000,
    DESKTOP_BROWSER_MIN_FRAME_INTERVAL_MS
  );
  const screencastIdleStopMs = clampInt(
    opts.screencastIdleStopMs,
    1_000,
    120_000,
    DESKTOP_BROWSER_SCREENCAST_IDLE_STOP_MS
  );
  const commandTimeoutMs = clampInt(opts.commandTimeoutMs, 1_000, 120_000, DEFAULT_COMMAND_TIMEOUT_MS);
  const navigationTimeoutMs = clampInt(opts.navigationTimeoutMs, 1_000, 120_000, DEFAULT_NAVIGATION_TIMEOUT_MS);
  const managedDir = opts.managedDir ?? resolveManagedBrowserDir(HOST_CORE_DIR);

  const discoverBrowser = opts.discoverBrowser ?? discoverDesktopBrowser;
  const launchBrowser = opts.launchBrowser ?? launchDesktopChromium;
  const profileDirOpt = opts.profileDir;
  const dataDirOpt = opts.dataDir ?? opts.stateDir;

  let closed = false;
  let queue = Promise.resolve();
  let revision = 0;
  let frameSeq = 0;
  let sessionId = null;
  let browserHandle = null;
  let lastDiscovery = null;
  let lastLaunchFailure = null;
  let resolvedProfilePath = null;
  let initialTargetId = null;
  let managedBrowserContextId = null;
  let activePageId = null;
  let explicitOpenReserved = false;
  let explicitCreateInFlight = false;
  let offCdpEvent = null;
  let offCdpClose = null;

  const pagesById = new Map();
  const pagesByTargetId = new Map();
  const pagesBySessionId = new Map();
  const unmanagedStartupTargetIds = new Set();
  const explicitOpeningTargets = new Map();
  const pendingPopupTargets = new Map();
  const closingTargetIds = new Set();
  const deferredCreatedInfos = [];
  const pendingTargetTasks = new Set();
  const activeWaits = new Set();

  function assertProviderOpen() {
    if (closed) {
      throw browserError('BROWSER_CLOSED', 'Desktop browser provider has been closed.', {
        outcome: 'not-sent',
      });
    }
  }

  function enqueue(operation) {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function bumpRevision() {
    revision += 1;
    return revision;
  }

  function notifyWaitWakeups(page) {
    if (!page || !page.waitWakeups || page.waitWakeups.size === 0) return;
    for (const wake of Array.from(page.waitWakeups)) {
      wake();
    }
  }

  function assertPageNotSensitiveForBot(page) {
    if (page.sensitive) {
      throw browserError(
        'BROWSER_SENSITIVE_PAGE',
        page.sensitiveReason || 'Bot actions are blocked on sensitive pages; request human takeover.',
        {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: page.sensitiveCategory,
          sensitiveReason: page.sensitiveReason,
          authUseSystemBrowser: page.authUseSystemBrowser,
        }
      );
    }
  }

  function acknowledgeScreencastFrame(page, handle, ackSessionId) {
    if (handle !== browserHandle || handle.client.closed || typeof ackSessionId !== 'number') return;
    void handle.client.send(
      'Page.screencastFrameAck',
      { sessionId: ackSessionId },
      { sessionId: page.sessionId, timeoutMs: 3_000 }
    ).catch(() => undefined);
  }

  function clearPendingScreencastFrame(page) {
    clearTimeout(page.screencastFrameTimer);
    page.screencastFrameTimer = null;
    const pending = page.pendingScreencastFrame;
    page.pendingScreencastFrame = null;
    if (pending) acknowledgeScreencastFrame(page, pending.handle, pending.ackSessionId);
  }

  function invalidatePageFrames(page) {
    page.frameGeneration += 1;
    page.latestFrame = null;
    clearPendingScreencastFrame(page);
  }

  function publishPageFrame(page, frame) {
    page.latestFrame = frame;
    for (const receive of page.pendingFrameWaiters) receive(frame);
  }

  function promoteScreencastFrame(page) {
    page.screencastFrameTimer = null;
    const pending = page.pendingScreencastFrame;
    page.pendingScreencastFrame = null;
    if (!pending) return;
    const { frame, handle, frameGeneration, ackSessionId } = pending;
    if (page.screencastActive && !page.secretExposureRisk &&
      handle === browserHandle && !handle.client.closed && frameGeneration === page.frameGeneration &&
      frame.documentGeneration === page.documentGeneration && frame.seq > (page.latestFrame?.seq ?? 0)) {
      page.lastScreencastFrameAt = now();
      page.screencastHasFrames = true;
      publishPageFrame(page, frame);
    }
    acknowledgeScreencastFrame(page, handle, ackSessionId);
  }

  function clearPageScreencastTimers(page) {
    invalidatePageFrames(page);
    page.screencastStart = null;
    page.screencastHasFrames = false;
    if (page.screencastIdleTimer) {
      clearTimeout(page.screencastIdleTimer);
      page.screencastIdleTimer = null;
    }
    if (page.pendingFrameWaiters.size > 0) {
      for (const resolveWaiter of page.pendingFrameWaiters) {
        resolveWaiter(null);
      }
      page.pendingFrameWaiters.clear();
    }
    notifyWaitWakeups(page);
    page.waitWakeups?.clear();
  }

  function clearRuntimeState() {
    for (const page of pagesById.values()) {
      clearPageScreencastTimers(page);
      page.screencastActive = false;
    }
    pagesById.clear();
    pagesByTargetId.clear();
    pagesBySessionId.clear();
    for (const pending of pendingPopupTargets.values()) {
      pending.destroyed = true;
    }
    pendingPopupTargets.clear();
    for (const opening of explicitOpeningTargets.values()) {
      opening.destroyed = true;
    }
    explicitOpeningTargets.clear();
    unmanagedStartupTargetIds.clear();
    closingTargetIds.clear();
    deferredCreatedInfos.length = 0;
    pendingTargetTasks.clear();
    explicitOpenReserved = false;
    explicitCreateInFlight = false;
    managedBrowserContextId = null;
    activePageId = null;
    initialTargetId = null;
    sessionId = null;
    offCdpEvent?.();
    offCdpClose?.();
    offCdpEvent = null;
    offCdpClose = null;
    browserHandle = null;
  }

  function removeOwnedPage(page) {
    clearPageScreencastTimers(page);
    pagesById.delete(page.pageId);
    pagesByTargetId.delete(page.targetId);
    pagesBySessionId.delete(page.sessionId);
    if (activePageId === page.pageId) {
      const next = pagesById.values().next().value ?? null;
      activePageId = next ? next.pageId : null;
    }
    bumpRevision();
  }

  function occupiedTabCount() {
    return pagesByTargetId.size + pendingPopupTargets.size + (explicitOpenReserved ? 1 : 0);
  }

  function maybeRecordBrowserContext(info) {
    if (managedBrowserContextId) return;
    if (!info || typeof info.targetId !== 'string' || !info.targetId) return;
    if (typeof info.browserContextId !== 'string' || !info.browserContextId) return;
    if (
      info.targetId === initialTargetId ||
      pagesByTargetId.has(info.targetId) ||
      explicitOpeningTargets.has(info.targetId)
    ) {
      managedBrowserContextId = info.browserContextId;
    }
  }

  function isAllowedPopupUrl(rawUrl) {
    if (rawUrl === undefined || rawUrl === null) return true;
    if (typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed === 'about:blank') return true;
    if (trimmed.startsWith('about:blank?') || trimmed.startsWith('about:blank#')) return true;
    return normalizeNavigationUrl(trimmed) !== null;
  }

  function isManagedPopupTargetInfo(info) {
    if (!info || typeof info.targetId !== 'string' || !info.targetId) return false;
    if (info.type !== 'page') return false;

    const infoCtx =
      typeof info.browserContextId === 'string' && info.browserContextId
        ? info.browserContextId
        : null;
    if (managedBrowserContextId && infoCtx && infoCtx !== managedBrowserContextId) {
      return false;
    }

    const openerId =
      typeof info.openerId === 'string' && info.openerId ? info.openerId : null;
    if (openerId) {
      return pagesByTargetId.has(openerId) || pendingPopupTargets.has(openerId);
    }

    // No openerId (e.g. target="_blank" rel="noopener" or window.open(..., "noopener")):
    // only accept while this Bot browser already owns a page, and if the Chromium
    // instance reports browserContextId it must match our managed context.
    if (pagesByTargetId.size === 0 && pendingPopupTargets.size === 0) {
      return false;
    }
    if (managedBrowserContextId && infoCtx !== managedBrowserContextId) {
      return false;
    }
    return true;
  }

  function trackTargetTask(promise) {
    const tracked = Promise.resolve(promise).finally(() => {
      pendingTargetTasks.delete(tracked);
    });
    pendingTargetTasks.add(tracked);
    return tracked;
  }

  async function settlePendingTargetTasks() {
    let rounds = 0;
    while (
      pendingTargetTasks.size > 0 &&
      rounds < 8 &&
      browserHandle &&
      !browserHandle.client.closed &&
      !closed
    ) {
      rounds += 1;
      await Promise.allSettled(Array.from(pendingTargetTasks));
    }
  }

  function closeExcessTarget(handle, targetId) {
    if (!handle || handle.client.closed || closed) return;
    if (closingTargetIds.has(targetId)) return;
    closingTargetIds.add(targetId);
    trackTargetTask(
      handle.client
        .send('Target.closeTarget', { targetId }, { timeoutMs: 3_000 })
        .catch(() => undefined)
        .finally(() => {
          closingTargetIds.delete(targetId);
        })
    );
  }

  function handleTargetCreated(info, { allowDefer = true } = {}) {
    const handle = browserHandle;
    if (!handle || handle.client.closed || closed) return;
    if (!info || typeof info.targetId !== 'string' || !info.targetId) return;

    const targetId = info.targetId;
    maybeRecordBrowserContext(info);

    if (
      pagesByTargetId.has(targetId) ||
      explicitOpeningTargets.has(targetId) ||
      pendingPopupTargets.has(targetId) ||
      closingTargetIds.has(targetId) ||
      targetId === initialTargetId ||
      unmanagedStartupTargetIds.has(targetId)
    ) {
      return;
    }

    if (info.type !== 'page') return;

    const openerId =
      typeof info.openerId === 'string' && info.openerId ? info.openerId : null;
    if (allowDefer && explicitCreateInFlight && !openerId) {
      if (!deferredCreatedInfos.some((item) => item.targetId === targetId)) {
        deferredCreatedInfos.push(info);
      }
      return;
    }

    if (!isManagedPopupTargetInfo(info)) {
      return;
    }

    if (!isAllowedPopupUrl(info.url)) {
      // A page spawned by an owned tab must not live untracked on a blocked scheme.
      if (openerId || !/^(?:chrome|chrome-extension|devtools):/i.test(info.url)) closeExcessTarget(handle, targetId);
      return;
    }
    if (occupiedTabCount() >= maxTabs) {
      closeExcessTarget(handle, targetId);
      return;
    }

    const pendingEntry = { destroyed: false, sessionId: null };
    pendingPopupTargets.set(targetId, pendingEntry);

    trackTargetTask(
      (async () => {
        try {
          const page = await attachOwnedTarget(targetId, {
            initialUrl: typeof info.url === 'string' && info.url ? info.url : 'about:blank',
            initialTitle: typeof info.title === 'string' ? info.title : '',
            isPopup: true,
            isCancelled: () => pendingEntry.destroyed,
            onSessionAttached: (sid) => {
              pendingEntry.sessionId = sid;
            },
            onCommit: () => {
              pendingPopupTargets.delete(targetId);
            },
          });

          // Never steal activePageId when attaching a background popup.
          bumpRevision();

          if (
            !pendingEntry.destroyed &&
            browserHandle === handle &&
            !handle.client.closed &&
            pagesByTargetId.get(targetId) === page
          ) {
            await refreshPageState(page).catch(() => undefined);
          }
        } catch {
          pendingPopupTargets.delete(targetId);
          if (!pendingEntry.destroyed && browserHandle === handle && !handle.client.closed && !closed) {
            closeExcessTarget(handle, targetId);
          }
        }
      })()
    );
  }

  function flushDeferredTargetCreated() {
    if (deferredCreatedInfos.length === 0) return;
    const queued = deferredCreatedInfos.splice(0, deferredCreatedInfos.length);
    for (const info of queued) {
      handleTargetCreated(info, { allowDefer: false });
    }
  }

  function serializeTabs() {
    return Array.from(pagesById.values()).map((page) => ({
      id: page.pageId,
      title: page.title || '',
      url: page.url || 'about:blank',
      active: page.pageId === activePageId,
      sensitive: Boolean(page.sensitive),
    }));
  }

  function getActivePage() {
    if (activePageId && pagesById.has(activePageId)) {
      return pagesById.get(activePageId);
    }
    const first = pagesById.values().next().value ?? null;
    activePageId = first ? first.pageId : null;
    return first;
  }

  function buildStatusView({ available, canStreamInteract, reason = null, detail = null } = {}) {
    const page = getActivePage();
    return {
      available: Boolean(available),
      canStreamInteract: Boolean(canStreamInteract),
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
      sessionId,
      pageId: page ? page.pageId : null,
      revision,
      documentGeneration: page ? page.documentGeneration : 0,
      tabs: serializeTabs(),
      viewport: { ...viewport },
      url: page ? page.url : null,
      title: page ? page.title : null,
      sensitive: page ? Boolean(page.sensitive) : false,
      sensitiveCategory: page ? page.sensitiveCategory : null,
      sensitiveReason: page ? page.sensitiveReason : null,
      authUseSystemBrowser: page ? Boolean(page.authUseSystemBrowser) : false,
      backend: {
        kind: lastDiscovery?.kind ?? 'none',
        transport: browserHandle?.transport ?? lastDiscovery?.transport ?? null,
        running: Boolean(browserHandle && !browserHandle.client.closed),
      },
    };
  }

  function validateProfileConfigWithoutDisk() {
    const configured = (typeof profileDirOpt === 'string' && profileDirOpt.trim())
      ? profileDirOpt.trim()
      : (typeof dataDirOpt === 'string' && dataDirOpt.trim())
        ? dataDirOpt.trim()
        : null;
    if (!configured) {
      return {
        ok: false,
        reason: 'profile_dir_unconfigured',
        detail: 'Desktop browser provider requires an isolated per-Bot profileDir or dataDir.',
      };
    }
    if (isPersonalBrowserProfilePath(configured, { platform, homePath, env })) {
      return {
        ok: false,
        reason: 'profile_dir_unsafe',
        detail: 'Refusing to use a personal browser profile directory for Bot browser.',
      };
    }
    return { ok: true, reason: null, detail: null };
  }

  async function probeAvailability() {
    const profileCheck = validateProfileConfigWithoutDisk();
    if (!profileCheck.ok) {
      return {
        available: false,
        canStreamInteract: false,
        reason: profileCheck.reason,
        detail: profileCheck.detail,
      };
    }
    const discovery = await discoverBrowser({
      platform,
      env,
      homePath,
      executablePath: opts.executablePath,
      transport: opts.transport,
      managedDir,
      probeExecutable: opts.probeExecutable,
    });
    lastDiscovery = discovery;
    if (!discovery.available) {
      return {
        available: false,
        canStreamInteract: false,
        reason: discovery.reason,
        detail: discovery.detail,
      };
    }
    if (lastLaunchFailure) {
      const retryable = lastLaunchFailure.reason === 'chromium_start_failed';
      return {
        available: retryable,
        canStreamInteract: retryable,
        reason: lastLaunchFailure.reason,
        detail: lastLaunchFailure.detail,
      };
    }
    return {
      available: true,
      canStreamInteract: true,
      reason: null,
      detail: null,
    };
  }

  function applySensitiveState(page, classification) {
    const prevSensitive = page.sensitive;
    page.sensitive = Boolean(classification.sensitive);
    page.sensitiveCategory = classification.category ?? null;
    page.sensitiveReason = classification.reason ?? null;
    page.secretExposureRisk = Boolean(classification.secretExposureRisk);
    page.authUseSystemBrowser = Boolean(classification.authUseSystemBrowser);
    if (page.secretExposureRisk) {
      void stopPageScreencast(page);
    } else if (!prevSensitive && page.sensitive) {
      // Drop cached pre-transition frame when entering a sensitive page.
      invalidatePageFrames(page);
    }
    if (page.sensitive) {
      notifyWaitWakeups(page);
    }
  }

  async function refreshPageState(page, { signal, timeoutMs, assertFrameTarget } = {}) {
    const handle = browserHandle;
    if (!handle || handle.client.closed) {
      throw browserError('BROWSER_PROCESS_EXITED', 'Desktop browser process is not running.');
    }

    const frameTreeTimeout = timeoutMs === undefined ? 5_000 : Math.max(50, Math.min(5_000, timeoutMs));
    const probeTimeout = timeoutMs === undefined ? 4_000 : Math.max(50, Math.min(4_000, timeoutMs));

    const assertFrameReadCurrent = (generation) => {
      if (!assertFrameTarget) return;
      assertFrameTarget();
      if (page.frameGeneration !== generation) {
        throw browserError('BROWSER_STALE_REVISION', 'Browser page changed during the frame safety check.');
      }
    };
    let readGeneration = page.frameGeneration;
    let frameTree;
    try {
      frameTree = await handle.client.send(
        'Page.getFrameTree',
        {},
        { sessionId: page.sessionId, timeoutMs: frameTreeTimeout, signal }
      );
    } catch {
      // Keep last known URL if frameTree is momentarily busy.
    }
    assertFrameReadCurrent(readGeneration);
    const mainFrame = frameTree?.frameTree?.frame;
    const changedDocument = mainFrame?.loaderId && page.loaderId && mainFrame.loaderId !== page.loaderId;
    const changedUrl = typeof mainFrame?.url === 'string' && mainFrame.url && page.url && mainFrame.url !== page.url;
    if (mainFrame) {
      if (mainFrame.id) page.frameId = mainFrame.id;
      if (changedDocument) {
        page.documentGeneration += 1;
        page.refs.clear();
      }
      if (changedDocument || changedUrl) {
        invalidatePageFrames(page);
        bumpRevision();
      }
      if (mainFrame.loaderId) page.loaderId = mainFrame.loaderId;
      if (typeof mainFrame.url === 'string' && mainFrame.url) page.url = mainFrame.url;
    }

    readGeneration = page.frameGeneration;
    let evalRes;
    try {
      evalRes = await handle.client.send(
        'Runtime.evaluate',
        {
          expression: SENSITIVE_DOM_PROBE_EXPRESSION,
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        },
        { sessionId: page.sessionId, timeoutMs: probeTimeout, signal }
      );
    } catch {
      // URL-based classification still applies if document is mid-navigation.
    }
    assertFrameReadCurrent(readGeneration);
    const domSignals = isPlainObject(evalRes?.result?.value) ? evalRes.result.value : null;
    if (domSignals) {
      if (typeof domSignals.title === 'string') page.title = domSignals.title;
      if (typeof domSignals.url === 'string' && domSignals.url) {
        if (page.url && domSignals.url !== page.url) {
          invalidatePageFrames(page);
          bumpRevision();
        }
        page.url = domSignals.url;
      }
    }

    if (page.isPopup && !isAllowedPopupUrl(page.url)) {
      if (pagesByTargetId.get(page.targetId) === page) removeOwnedPage(page);
      closeExcessTarget(browserHandle, page.targetId);
      throw browserError('BROWSER_URL_BLOCKED', 'Popup left the supported web URL schemes.');
    }
    const classification = classifySensitivePage({
      url: page.url,
      title: page.title,
      domSignals,
    });
    // A missing DOM probe is not proof that a previously detected dialog is gone.
    if (domSignals || classification.sensitive || changedDocument) {
      applySensitiveState(page, classification);
    }
    return { domSignals };
  }

  async function stopPageScreencast(page) {
    if (!page) return;
    clearPageScreencastTimers(page);
    if (!page.screencastActive) return;
    page.screencastActive = false;
    if (browserHandle && !browserHandle.client.closed) {
      try {
        await browserHandle.client.send(
          'Page.stopScreencast',
          {},
          { sessionId: page.sessionId, timeoutMs: 3_000 }
        );
      } catch {
        // Ignore if tab already navigated or closed.
      }
    }
  }

  function resetScreencastIdleTimer(page) {
    if (page.screencastIdleTimer) {
      clearTimeout(page.screencastIdleTimer);
    }
    page.screencastIdleTimer = setTimeout(() => {
      page.screencastIdleTimer = null;
      void stopPageScreencast(page);
    }, screencastIdleStopMs);
    page.screencastIdleTimer.unref?.();
  }

  async function handleCdpEvent(event, handle) {
    if (closed || !handle || browserHandle !== handle || handle.client.closed) return;
    const { method, params, sessionId: evSessionId } = event;

    if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
      const targetId = typeof params.targetId === 'string' && params.targetId ? params.targetId : null;
      const detachedSessionId =
        typeof params.sessionId === 'string' && params.sessionId
          ? params.sessionId
          : evSessionId || null;

      if (targetId) {
        if (method === 'Target.targetDestroyed') {
          if (targetId === initialTargetId) initialTargetId = null;
          unmanagedStartupTargetIds.delete(targetId);
          closingTargetIds.delete(targetId);
          for (let i = deferredCreatedInfos.length - 1; i >= 0; i -= 1) {
            if (deferredCreatedInfos[i]?.targetId === targetId) {
              deferredCreatedInfos.splice(i, 1);
            }
          }
        }
        const pendingPopup = pendingPopupTargets.get(targetId);
        if (pendingPopup) {
          pendingPopup.destroyed = true;
          pendingPopupTargets.delete(targetId);
        }
        const opening = explicitOpeningTargets.get(targetId);
        if (opening) {
          opening.destroyed = true;
        }
      } else if (detachedSessionId) {
        for (const [tid, pendingPopup] of pendingPopupTargets.entries()) {
          if (pendingPopup.sessionId === detachedSessionId) {
            pendingPopup.destroyed = true;
            pendingPopupTargets.delete(tid);
            break;
          }
        }
        for (const opening of explicitOpeningTargets.values()) {
          if (opening.sessionId === detachedSessionId) {
            opening.destroyed = true;
            break;
          }
        }
      }

      const page = targetId
        ? pagesByTargetId.get(targetId)
        : detachedSessionId
          ? pagesBySessionId.get(detachedSessionId)
          : null;
      if (page) {
        removeOwnedPage(page);
      }
      return;
    }

    if (method === 'Target.targetCreated') {
      handleTargetCreated(params.targetInfo);
      return;
    }

    if (method === 'Target.targetInfoChanged') {
      const info = params.targetInfo;
      if (info && typeof info.targetId === 'string') {
        maybeRecordBrowserContext(info);
        const page = pagesByTargetId.get(info.targetId);
        if (page) {
          if (page.isPopup && !isAllowedPopupUrl(info.url)) {
            removeOwnedPage(page);
            closeExcessTarget(handle, page.targetId);
            return;
          }
          let changed = false;
          if (typeof info.title === 'string' && info.title !== page.title) {
            page.title = info.title;
            changed = true;
          }
          if (typeof info.url === 'string' && info.url && info.url !== page.url) {
            page.url = info.url;
            invalidatePageFrames(page);
            changed = true;
          }
          if (changed) {
            applySensitiveState(page, classifySensitivePage({ url: page.url, title: page.title }));
            bumpRevision();
          }
        }
      }
      return;
    }

    if (!evSessionId) return;
    const page = pagesBySessionId.get(evSessionId);
    if (!page) return;

    if (method === 'Page.frameStartedLoading') {
      if (!params.frameId || !page.frameId || params.frameId === page.frameId) {
        page.isNavigating = true;
        page.domContentLoaded = false;
        notifyWaitWakeups(page);
      }
      return;
    }

    if (method === 'Page.frameNavigated') {
      const frame = params.frame;
      if (frame && !frame.parentId) {
        page.frameId = frame.id ?? page.frameId;
        page.loaderId = frame.loaderId ?? page.loaderId;
        if (typeof frame.url === 'string') {
          page.url = frame.url;
        }
        page.documentGeneration += 1;
        page.domContentLoaded = false;
        page.refs.clear();
        invalidatePageFrames(page);
        bumpRevision();
        applySensitiveState(page, classifySensitivePage({ url: page.url, title: page.title }));
        notifyWaitWakeups(page);
      }
      return;
    }

    if (method === 'Page.navigatedWithinDocument') {
      if (!params.frameId || params.frameId === page.frameId) {
        if (typeof params.url === 'string') {
          page.url = params.url;
        }
        invalidatePageFrames(page);
        bumpRevision();
        applySensitiveState(page, classifySensitivePage({ url: page.url, title: page.title }));
        notifyWaitWakeups(page);
      }
      return;
    }

    if (method === 'Page.domContentEventFired') {
      page.domContentLoaded = true;
      notifyWaitWakeups(page);
      return;
    }

    if (method === 'Page.loadEventFired') {
      page.isNavigating = false;
      page.domContentLoaded = true;
      notifyWaitWakeups(page);
      return;
    }

    if (method === 'Page.frameStoppedLoading') {
      if (!params.frameId || !page.frameId || params.frameId === page.frameId) {
        page.isNavigating = false;
        notifyWaitWakeups(page);
      }
      return;
    }

    if (method === 'Page.javascriptDialogOpening') {
      // Prevent JS alert/confirm/prompt dialogs from deadlocking headless CDP commands.
      if (browserHandle && !browserHandle.client.closed) {
        browserHandle.client
          .send(
            'Page.handleJavaScriptDialog',
            { accept: false },
            { sessionId: page.sessionId, timeoutMs: 3_000 }
          )
          .catch(() => undefined);
      }
      return;
    }

    if (method === 'Page.screencastFrame') {
      const ackSessionId = params.sessionId;
      const data = typeof params.data === 'string' ? params.data : '';
      if (!page.screencastActive || page.secretExposureRisk || !data) {
        acknowledgeScreencastFrame(page, handle, ackSessionId);
        return;
      }
      if (data.length > maxFrameBase64Bytes) {
        page.frameOversizedHint = true;
        acknowledgeScreencastFrame(page, handle, ackSessionId);
        return;
      }
      page.frameOversizedHint = false;
      const capturedAt = now();
      const frame = {
        seq: ++frameSeq,
        mimeType: 'image/jpeg',
        data,
        width: viewport.width,
        height: viewport.height,
        revision,
        documentGeneration: page.documentGeneration,
        frameGeneration: page.frameGeneration,
        pageId: page.pageId,
        capturedAt,
      };
      // Keep one trailing paint and withhold its ACK until it is published.
      const replaced = page.pendingScreencastFrame;
      page.pendingScreencastFrame = { frame, handle, ackSessionId, frameGeneration: page.frameGeneration };
      if (replaced) acknowledgeScreencastFrame(page, replaced.handle, replaced.ackSessionId);
      if (!page.screencastFrameTimer) {
        const elapsed = capturedAt - page.lastScreencastFrameAt;
        if (elapsed < 0 || elapsed >= minFrameIntervalMs) promoteScreencastFrame(page);
        else page.screencastFrameTimer = setTimeout(() => promoteScreencastFrame(page), minFrameIntervalMs - elapsed);
      }
    }
  }

  async function ensureBrowserStarted(signal) {
    if (browserHandle && !browserHandle.client.closed) {
      return browserHandle;
    }
    const discovery = await discoverBrowser({
      platform,
      env,
      homePath,
      executablePath: opts.executablePath,
      transport: opts.transport,
      managedDir,
      probeExecutable: opts.probeExecutable,
    });
    lastDiscovery = discovery;
    if (!discovery.available) {
      throw browserError('BROWSER_UNAVAILABLE', discovery.detail || 'Desktop browser is unavailable.', {
        data: { reason: discovery.reason },
      });
    }

    const baseProfilePath = await prepareBotProfileDir({
      botId,
      profileDir: profileDirOpt,
      dataDir: dataDirOpt,
      executablePath: discovery.executablePath,
      platform,
      env,
      homePath,
      snapRoots: opts.snapRoots,
      passwdHomePath: opts.passwdHomePath,
    });
    const recoveryProfilePath = platform === 'win32' && discovery.transport === 'loopback'
      ? win32.join(baseProfilePath, '.pibot-recovery')
      : null;
    let profilePath = baseProfilePath;
    const startProfile = (profilePath) => launchBrowser({
      executablePath: discovery.executablePath,
      profilePath,
      transport: discovery.transport,
      viewport,
      platform,
      env,
      commandTimeoutMs,
      signal,
    });
    let handle;
    try {
      if (recoveryProfilePath) {
        try {
          await assertPrivateWindowsProfileDir(recoveryProfilePath);
          profilePath = recoveryProfilePath;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      try {
        handle = await startProfile(profilePath);
      } catch (error) {
        if (!recoveryProfilePath || profilePath !== baseProfilePath || error?.data?.profileInUse !== true) throw error;
        signal?.throwIfAborted();
        // An orphaned Windows Chromium may still own the original profile after
        // a Host upgrade. Keep that profile intact and persist a new profile for this Bot.
        await assertPrivateWindowsProfileDir(baseProfilePath);
        await mkdir(recoveryProfilePath, { mode: 0o700, recursive: true });
        await assertPrivateWindowsProfileDir(recoveryProfilePath);
        profilePath = recoveryProfilePath;
        handle = await startProfile(profilePath);
      }
    } catch (err) {
      lastLaunchFailure = {
        reason: err?.code === 'BROWSER_PROFILE_UNWRITABLE' ? 'profile_dir_unwritable' : 'chromium_start_failed',
        detail: err?.message || 'Failed to start desktop Chromium browser.',
      };
      throw err;
    }

    resolvedProfilePath = profilePath;
    lastLaunchFailure = null;
    browserHandle = handle;
    sessionId = randomUUID();
    offCdpEvent = handle.client.onEvent((event) => {
      void handleCdpEvent(event, handle);
    });
    offCdpClose = handle.client.onClose(() => {
      if (browserHandle === handle) {
        clearRuntimeState();
      }
    });

    // Record the initial about:blank target and managed context before target discovery
    // so startup targets are not mistaken for web-opened popups.
    try {
      const { targetInfos } = await handle.client.send('Target.getTargets', {}, { timeoutMs: 5_000, signal });
      const targets = Array.isArray(targetInfos) ? targetInfos : [];
      const initialPage = targets.find((t) => t && t.type === 'page' && typeof t.targetId === 'string' && t.targetId);
      initialTargetId = initialPage ? initialPage.targetId : null;
      if (initialPage && typeof initialPage.browserContextId === 'string' && initialPage.browserContextId) {
        managedBrowserContextId = initialPage.browserContextId;
      }
      for (const t of targets) {
        if (t && typeof t.targetId === 'string' && t.targetId && t.targetId !== initialTargetId) {
          unmanagedStartupTargetIds.add(t.targetId);
        }
      }
    } catch {
      initialTargetId = null;
    }

    // Enable target discovery & deny automatic file downloads (prevents silent secret JSON downloads).
    await handle.client
      .send('Target.setDiscoverTargets', { discover: true }, { timeoutMs: 5_000, signal })
      .catch(() => undefined);
    await handle.client
      .send('Browser.setDownloadBehavior', { behavior: 'deny' }, { timeoutMs: 5_000, signal })
      .catch(() => undefined);

    return handle;
  }

  async function attachOwnedTarget(
    targetId,
    {
      requestedPageId = null,
      initialUrl = 'about:blank',
      initialTitle = '',
      isPopup = false,
      signal = undefined,
      isCancelled = null,
      onSessionAttached = null,
      onCommit = null,
    } = {}
  ) {
    const handle = browserHandle;
    if (!handle || handle.client.closed || closed) {
      throw browserError('BROWSER_PROCESS_EXITED', 'Desktop browser process is not running.');
    }

    const { sessionId: targetSessionId } = await handle.client.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      { timeoutMs: commandTimeoutMs, signal }
    );

    if (typeof targetSessionId !== 'string' || !targetSessionId) {
      throw browserError('BROWSER_ATTACH_FAILED', `Target.attachToTarget returned invalid sessionId for ${targetId}.`);
    }

    onSessionAttached?.(targetSessionId);

    const isAborted = () => closed || browserHandle !== handle || handle.client.closed || Boolean(isCancelled?.());
    const detachBestEffort = () => {
      if (handle && !handle.client.closed) {
        handle.client
          .send('Target.detachFromTarget', { sessionId: targetSessionId }, { timeoutMs: 2_000 })
          .catch(() => undefined);
      }
    };

    if (isAborted()) {
      detachBestEffort();
      throw browserError('BROWSER_TAB_NOT_FOUND', `Browser target '${targetId}' was closed during attach.`);
    }

    const normalizedUrl = initialUrl && initialUrl !== 'about:blank'
      ? (normalizeNavigationUrl(initialUrl) ?? 'about:blank')
      : 'about:blank';

    const pageId = requestedPageId || randomUUID();
    const page = {
      pageId,
      targetId,
      sessionId: targetSessionId,
      frameId: null,
      loaderId: null,
      url: normalizedUrl,
      isPopup,
      title: typeof initialTitle === 'string' ? initialTitle : '',
      documentGeneration: 1,
      isNavigating: false,
      domContentLoaded: false,
      sensitive: false,
      sensitiveCategory: null,
      sensitiveReason: null,
      secretExposureRisk: false,
      authUseSystemBrowser: false,
      refs: new Map(),
      frameTargetBlocked: false,
      screencastActive: false,
      screencastStart: null,
      screencastHasFrames: false,
      screencastQuality: DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY,
      screencastIdleTimer: null,
      screencastFrameTimer: null,
      pendingScreencastFrame: null,
      lastScreencastFrameAt: -Infinity,
      frameGeneration: 0,
      latestFrame: null,
      frameOversizedHint: false,
      pendingFrameWaiters: new Set(),
      waitWakeups: new Set(),
    };
    applySensitiveState(page, classifySensitivePage({ url: page.url, title: page.title }));

    try {
      await Promise.all([
        handle.client.send('Page.enable', {}, { sessionId: targetSessionId, timeoutMs: 5_000, signal }),
        handle.client.send('DOM.enable', {}, { sessionId: targetSessionId, timeoutMs: 5_000, signal }),
        handle.client.send('Accessibility.enable', {}, { sessionId: targetSessionId, timeoutMs: 5_000, signal }),
        handle.client.send(
          'Emulation.setDeviceMetricsOverride',
          {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          },
          { sessionId: targetSessionId, timeoutMs: 5_000, signal }
        ),
      ]);
    } catch (err) {
      detachBestEffort();
      throw err;
    }

    if (isAborted()) {
      detachBestEffort();
      throw browserError('BROWSER_TAB_NOT_FOUND', `Browser target '${targetId}' was closed during attach.`);
    }

    onCommit?.(page);
    pagesById.set(pageId, page);
    pagesByTargetId.set(targetId, page);
    pagesBySessionId.set(targetSessionId, page);

    return page;
  }

  async function waitForPageSettle(page, { timeoutMs = navigationTimeoutMs, signal } = {}) {
    if (!browserHandle || browserHandle.client.closed) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', finish);
        offEvent?.();
        resolve();
      };
      const offEvent = browserHandle.client.onEvent((ev) => {
        if (ev.sessionId !== page.sessionId) return;
        if (ev.method === 'Page.loadEventFired' || ev.method === 'Page.frameStoppedLoading') {
          finish();
        }
      });
      const timer = setTimeout(finish, Math.min(timeoutMs, 3_500));
      timer.unref?.();
      if (signal) signal.addEventListener('abort', finish, { once: true });
    });
  }

  function resolveOwnedPage(pageId, { requireActive = false } = {}) {
    if (pageId !== undefined && pageId !== null) {
      if (typeof pageId !== 'string' || !pageId.trim()) {
        throw browserError('INVALID_ARGUMENT', 'pageId must be a non-empty string', {
          outcome: 'not-sent',
        });
      }
      const page = pagesById.get(pageId);
      if (!page) {
        throw browserError('BROWSER_TAB_NOT_FOUND', `Browser page '${pageId}' was not found for this Bot.`, {
          outcome: 'not-sent',
        });
      }
      if (requireActive && activePageId !== page.pageId) {
        throw browserError(
          'BROWSER_PAGE_MISMATCH',
          'Target page is not the active tab; refresh view before sending input.',
          { outcome: 'not-sent' }
        );
      }
      return page;
    }
    const active = getActivePage();
    if (!active) {
      throw browserError('BROWSER_NO_TAB', 'No browser tab is open for this Bot.', {
        outcome: 'not-sent',
      });
    }
    return active;
  }

  function revalidateTargetState(page, input) {
    if (input.revision !== undefined && input.revision !== null) {
      if (!Number.isSafeInteger(input.revision) || input.revision !== revision) {
        throw browserError(
          'BROWSER_STALE_REVISION',
          `Browser revision mismatch (expected ${revision}, received ${String(input.revision)}).`,
          { outcome: 'not-sent' }
        );
      }
    }
    if (input.documentGeneration !== undefined && input.documentGeneration !== null) {
      if (
        !Number.isSafeInteger(input.documentGeneration) ||
        input.documentGeneration !== page.documentGeneration
      ) {
        throw browserError(
          'BROWSER_STALE_DOCUMENT',
          'Page document generation changed before action was dispatched.',
          { outcome: 'not-sent' }
        );
      }
    }
    if (typeof input.expectedUrl === 'string' && input.expectedUrl.length > 0) {
      if (page.url !== input.expectedUrl) {
        throw browserError(
          'BROWSER_STALE_PAGE',
          'Page URL changed before action was dispatched.',
          { outcome: 'not-sent' }
        );
      }
    }
  }

  async function navigatePage(page, url, { actor, signal }) {
    if (actor === 'bot' && isGoogleApiOAuthUrl(url)) {
      throw browserError(
        'BROWSER_AUTH_USE_SYSTEM_BROWSER',
        'Google API OAuth authorization must be completed in the system browser, not in the Bot browser.',
        {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: 'oauth_consent',
          authUseSystemBrowser: true,
        }
      );
    }

    const navResult = await browserHandle.client.send(
      'Page.navigate',
      { url },
      { sessionId: page.sessionId, timeoutMs: navigationTimeoutMs, signal }
    );
    if (typeof navResult?.errorText === 'string' && navResult.errorText) {
      throw browserError('BROWSER_NAVIGATION_FAILED', `Navigation failed: ${navResult.errorText}`);
    }
    if (navResult?.loaderId && navResult.loaderId !== page.loaderId) {
      page.loaderId = navResult.loaderId;
      page.documentGeneration += 1;
      page.refs.clear();
      invalidatePageFrames(page);
    }
    page.url = url;
    bumpRevision();

    if (url !== 'about:blank') {
      await waitForPageSettle(page, { timeoutMs: navigationTimeoutMs, signal });
    }
    await refreshPageState(page, { signal });
  }

  async function startOrRenewScreencast(page, { maxWidth, maxHeight, quality, signal }, assertFrameTarget) {
    resetScreencastIdleTimer(page);
    const targetQuality = clampInt(quality, 20, 90, page.frameOversizedHint ? 40 : DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY);
    if (page.screencastActive && page.screencastQuality !== targetQuality) {
      await stopPageScreencast(page);
      assertFrameTarget();
      resetScreencastIdleTimer(page);
    }
    if (page.screencastActive) return page.screencastStart;
    page.screencastQuality = targetQuality;
    page.screencastActive = true;
    const start = browserHandle.client.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: targetQuality,
        maxWidth: clampInt(maxWidth, 320, viewport.width, viewport.width),
        maxHeight: clampInt(maxHeight, 240, viewport.height, viewport.height),
        everyNthFrame: 1,
      },
      { sessionId: page.sessionId, timeoutMs: 5_000, signal }
    ).catch(() => {
      if (page.screencastStart === start) {
        page.screencastActive = false;
        clearPageScreencastTimers(page);
      }
    }).finally(() => {
      if (page.screencastStart === start) page.screencastStart = null;
    });
    page.screencastStart = start;
    await start;
  }

  async function captureBoundedScreenshot(page, { requestedQuality, signal }, assertFrameTarget) {
    const qualities = requestedQuality
      ? [clampInt(requestedQuality, 20, 90, DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY), ...ADAPTIVE_JPEG_QUALITIES]
      : [...ADAPTIVE_JPEG_QUALITIES];
    const tried = new Set();
    const frameGeneration = page.frameGeneration;

    for (const q of qualities) {
      if (tried.has(q)) continue;
      tried.add(q);
      // Order the fallback at dispatch. A newer CDP paint can arrive before its reply.
      const seq = ++frameSeq;
      const res = await browserHandle.client.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: q, fromSurface: true },
        { sessionId: page.sessionId, timeoutMs: 8_000, signal }
      );
      assertFrameTarget();
      if (frameGeneration !== page.frameGeneration) {
        throw browserError('BROWSER_STALE_REVISION', 'Browser page changed while capturing a frame.');
      }
      if (page.latestFrame?.seq > seq) return page.latestFrame;
      const data = typeof res?.data === 'string' ? res.data : '';
      if (!data) {
        throw browserError('BROWSER_CAPTURE_FAILED', 'Browser returned an empty frame.');
      }
      if (data.length <= maxFrameBase64Bytes) {
        const frame = {
          seq,
          mimeType: 'image/jpeg',
          data,
          width: viewport.width,
          height: viewport.height,
          revision,
          documentGeneration: page.documentGeneration,
          frameGeneration,
          pageId: page.pageId,
          capturedAt: now(),
        };
        if (page.pendingScreencastFrame?.frame.seq < seq) clearPendingScreencastFrame(page);
        if (!page.pendingScreencastFrame) page.lastScreencastFrameAt = frame.capturedAt;
        publishPageFrame(page, frame);
        return frame;
      }
    }

    throw browserError(
      'BROWSER_FRAME_TOO_LARGE',
      `Captured frame exceeded the ${maxFrameBase64Bytes}-byte base64 transport budget.`
    );
  }

  async function dispatchKeyDescriptor(page, descriptor, signal) {
    const baseParams = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode,
      modifiers: descriptor.modifiers,
    };
    await browserHandle.client.send(
      'Input.dispatchKeyEvent',
      {
        type: descriptor.text ? 'keyDown' : 'rawKeyDown',
        ...baseParams,
        ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.unmodifiedText } : {}),
      },
      { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
    );
    await browserHandle.client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        ...baseParams,
      },
      { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
    );
  }

  async function resolveElementCenter(page, backendDOMNodeId, signal) {
    await browserHandle.client.send(
      'DOM.scrollIntoViewIfNeeded',
      { backendNodeId: backendDOMNodeId },
      { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
    );
    const quadsRes = await browserHandle.client.send(
      'DOM.getContentQuads',
      { backendNodeId: backendDOMNodeId },
      { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
    );
    const quad = Array.isArray(quadsRes?.quads) ? quadsRes.quads[0] : null;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw browserError(
        'BROWSER_ELEMENT_NOT_INTERACTABLE',
        'Target element has no visible geometry on the page.',
        { outcome: 'not-sent' }
      );
    }
    const cx = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
    const cy = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
    return {
      x: Math.max(0, Math.min(viewport.width - 1, cx)),
      y: Math.max(0, Math.min(viewport.height - 1, cy)),
    };
  }

  async function callInternalElementFunction(page, backendDOMNodeId, fnDeclaration, args, signal) {
    const resolved = await browserHandle.client.send(
      'DOM.resolveNode',
      { backendNodeId: backendDOMNodeId },
      { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
    );
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
      throw browserError('BROWSER_STALE_REF', 'Target element is no longer attached to the document.', {
        outcome: 'not-sent',
      });
    }
    try {
      const res = await browserHandle.client.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: fnDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
        },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      if (res?.exceptionDetails) {
        throw browserError('BROWSER_ELEMENT_NOT_INTERACTABLE', 'Element interaction threw an exception.');
      }
      return res?.result?.value;
    } finally {
      browserHandle.client
        .send('Runtime.releaseObject', { objectId }, { sessionId: page.sessionId, timeoutMs: 2_000 })
        .catch(() => undefined);
    }
  }

  async function performStatus() {
    if (browserHandle && !browserHandle.client.closed) {
      await settlePendingTargetTasks();
      try {
        const { targetInfos } = await browserHandle.client.send('Target.getTargets', {}, { timeoutMs: 4_000 });
        const infos = Array.isArray(targetInfos) ? targetInfos : [];
        const liveTargetIds = new Set(infos.map((t) => t?.targetId).filter(Boolean));
        for (const page of Array.from(pagesById.values())) {
          if (!liveTargetIds.has(page.targetId)) {
            removeOwnedPage(page);
          }
        }
        for (const info of infos) {
          handleTargetCreated(info, { allowDefer: false });
        }
        await settlePendingTargetTasks();
        const active = getActivePage();
        if (active) {
          await refreshPageState(active);
        }
      } catch {
        // Keep last state if target refresh momentarily failed.
      }
      if (!browserHandle || browserHandle.client.closed) {
        const probe = await probeAvailability();
        return buildStatusView(probe);
      }
      return buildStatusView({ available: true, canStreamInteract: true });
    }
    const probe = await probeAvailability();
    return buildStatusView(probe);
  }

  async function performOpen(input) {
    const signal = input.signal;
    const url = input.url === undefined ? 'about:blank' : normalizeNavigationUrl(input.url);
    if (!url) {
      throw browserError('INVALID_ARGUMENT', `Unsupported browser URL: ${String(input.url)}`, {
        outcome: 'not-sent',
      });
    }
    if (input.actor === 'bot' && isGoogleApiOAuthUrl(url)) {
      throw browserError(
        'BROWSER_AUTH_USE_SYSTEM_BROWSER',
        'Google API OAuth authorization must be completed in the system browser, not in the Bot browser.',
        {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: 'oauth_consent',
          authUseSystemBrowser: true,
        }
      );
    }

    await ensureBrowserStarted(signal);
    await settlePendingTargetTasks();

    const requestedPageId =
      typeof input.pageId === 'string' && input.pageId.trim() ? input.pageId.trim() : null;
    if (requestedPageId && pagesById.has(requestedPageId) && input.newTab !== true) {
      const existing = pagesById.get(requestedPageId);
      await activateOwnedPage(existing, { signal });
      if (input.url !== undefined) {
        await navigatePage(existing, url, { actor: input.actor, signal });
      } else {
        await refreshPageState(existing, { signal });
      }
      return buildStatusView({ available: true, canStreamInteract: true });
    }

    if (occupiedTabCount() >= maxTabs) {
      throw browserError(
        'BROWSER_TAB_LIMIT_REACHED',
        `Bot browser reached maximum open tabs limit (${maxTabs}). Close a tab before opening another.`,
        { outcome: 'not-sent' }
      );
    }

    explicitOpenReserved = true;
    let targetId = null;
    let createdNewTarget = false;
    let openingEntry = null;
    let page;
    try {
      if (initialTargetId && pagesById.size === 0) {
        targetId = initialTargetId;
        initialTargetId = null;
      } else {
        explicitCreateInFlight = true;
        try {
          const created = await browserHandle.client.send(
            'Target.createTarget',
            { url: 'about:blank', width: viewport.width, height: viewport.height },
            { timeoutMs: commandTimeoutMs, signal }
          );
          targetId = typeof created?.targetId === 'string' && created.targetId ? created.targetId : null;
          if (!targetId) {
            throw browserError('BROWSER_OPEN_FAILED', 'Target.createTarget did not return a targetId.');
          }
          createdNewTarget = true;
        } finally {
          explicitCreateInFlight = false;
          if (targetId) {
            openingEntry = { destroyed: false, sessionId: null };
            explicitOpeningTargets.set(targetId, openingEntry);
          } else {
            explicitOpenReserved = false;
          }
          flushDeferredTargetCreated();
        }
      }

      if (!openingEntry) {
        openingEntry = { destroyed: false, sessionId: null };
        explicitOpeningTargets.set(targetId, openingEntry);
      }

      page = await attachOwnedTarget(targetId, {
        requestedPageId,
        signal,
        isCancelled: () => Boolean(openingEntry?.destroyed),
        onSessionAttached: (sid) => {
          if (openingEntry) openingEntry.sessionId = sid;
        },
        onCommit: () => {
          explicitOpeningTargets.delete(targetId);
          explicitOpenReserved = false;
        },
      });
    } catch (err) {
      if (targetId) {
        explicitOpeningTargets.delete(targetId);
        if (createdNewTarget && !openingEntry?.destroyed && browserHandle && !browserHandle.client.closed) {
          browserHandle.client
            .send('Target.closeTarget', { targetId }, { timeoutMs: 3_000 })
            .catch(() => undefined);
        }
      }
      explicitOpenReserved = false;
      throw err;
    }
    await activateOwnedPage(page, { signal, ignoreActivationFailure: true });

    if (url !== 'about:blank') {
      await navigatePage(page, url, { actor: input.actor, signal });
    } else {
      await refreshPageState(page, { signal });
    }

    return buildStatusView({ available: true, canStreamInteract: true });
  }

  async function activateOwnedPage(page, { signal, ignoreActivationFailure = false } = {}) {
    const priorPage = getActivePage();
    const leaving = priorPage && priorPage !== page ? priorPage : null;
    if (leaving) leaving.frameTargetBlocked = true;
    try {
      if (leaving) await stopPageScreencast(leaving);
      try {
        await browserHandle.client.send(
          'Target.activateTarget',
          { targetId: page.targetId },
          { timeoutMs: 5_000, signal }
        );
      } catch (error) {
        if (!ignoreActivationFailure) throw error;
      }
      activePageId = page.pageId;
      bumpRevision();
    } finally {
      if (leaving) leaving.frameTargetBlocked = false;
    }
  }

  async function performSelect(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId);
    await activateOwnedPage(page, { signal });
    await refreshPageState(page, { signal });
    return buildStatusView({ available: true, canStreamInteract: true });
  }

  async function performNavigate(input) {
    const signal = input.signal;
    const url = normalizeNavigationUrl(input.url);
    if (!url) {
      throw browserError('INVALID_ARGUMENT', `Unsupported browser URL: ${String(input.url)}`, {
        outcome: 'not-sent',
      });
    }
    if (input.actor === 'bot' && isGoogleApiOAuthUrl(url)) {
      throw browserError(
        'BROWSER_AUTH_USE_SYSTEM_BROWSER',
        'Google API OAuth authorization must be completed in the system browser, not in the Bot browser.',
        {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: 'oauth_consent',
          authUseSystemBrowser: true,
        }
      );
    }

    if (!input.pageId && pagesById.size === 0) {
      return performOpen({ ...input, action: 'open', url });
    }

    const page = resolveOwnedPage(input.pageId);
    await refreshPageState(page, { signal });
    revalidateTargetState(page, input);
    await navigatePage(page, url, { actor: input.actor, signal });
    return buildStatusView({ available: true, canStreamInteract: true });
  }

  async function performHistoryOrReload(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId);
    await refreshPageState(page, { signal });
    revalidateTargetState(page, input);

    let navigated = true;
    if (input.action === 'reload') {
      await browserHandle.client.send(
        'Page.reload',
        { ignoreCache: false },
        { sessionId: page.sessionId, timeoutMs: navigationTimeoutMs, signal }
      );
      page.documentGeneration += 1;
      page.refs.clear();
      invalidatePageFrames(page);
      bumpRevision();
      await waitForPageSettle(page, { timeoutMs: navigationTimeoutMs, signal });
    } else {
      const history = await browserHandle.client.send(
        'Page.getNavigationHistory',
        {},
        { sessionId: page.sessionId, timeoutMs: 5_000, signal }
      );
      const entries = Array.isArray(history?.entries) ? history.entries : [];
      const currentIndex = typeof history?.currentIndex === 'number' ? history.currentIndex : -1;
      const delta = input.action === 'back' ? -1 : 1;
      const targetEntry = entries[currentIndex + delta];
      if (!targetEntry) {
        navigated = false;
      } else {
        await browserHandle.client.send(
          'Page.navigateToHistoryEntry',
          { entryId: targetEntry.id },
          { sessionId: page.sessionId, timeoutMs: navigationTimeoutMs, signal }
        );
        page.documentGeneration += 1;
        page.refs.clear();
        invalidatePageFrames(page);
        bumpRevision();
        await waitForPageSettle(page, { timeoutMs: navigationTimeoutMs, signal });
      }
    }

    await refreshPageState(page, { signal });
    return {
      ...buildStatusView({ available: true, canStreamInteract: true }),
      navigated,
    };
  }

  async function performCloseTab(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId);
    page.frameTargetBlocked = true;
    await stopPageScreencast(page);
    await browserHandle.client
      .send('Target.closeTarget', { targetId: page.targetId }, { timeoutMs: 5_000, signal })
      .catch(() => undefined);

    pagesById.delete(page.pageId);
    pagesByTargetId.delete(page.targetId);
    pagesBySessionId.delete(page.sessionId);
    if (activePageId === page.pageId) {
      const next = pagesById.values().next().value ?? null;
      activePageId = next ? next.pageId : null;
      if (next && browserHandle && !browserHandle.client.closed) {
        await browserHandle.client
          .send('Target.activateTarget', { targetId: next.targetId }, { timeoutMs: 3_000 })
          .catch(() => undefined);
      }
    }
    bumpRevision();
    return {
      ...buildStatusView({ available: true, canStreamInteract: true }),
      closed: true,
      closedPageId: page.pageId,
    };
  }

  function assertFrameAccess(page, input) {
    if (page.secretExposureRisk && input.allowSecretFrame !== true) {
      void stopPageScreencast(page);
      throw browserError(
        'BROWSER_SECRET_FRAME_BLOCKED',
        'Client secret dialog detected; secret screens cannot be streamed as ordinary frames.',
        {
          sensitive: true,
          sensitiveCategory: page.sensitiveCategory,
          sensitiveReason: page.sensitiveReason,
        }
      );
    }

    const viewer = input.viewer ?? (input.actor === 'bot' ? 'bot' : 'human');
    if (page.sensitive && (viewer === 'bot' || viewer === 'model' || viewer === 'bystander')) {
      throw browserError(
        'BROWSER_SENSITIVE_BLOCKED',
        page.sensitiveReason || 'Sensitive page frame is blocked for non-owner viewers.',
        {
          sensitive: true,
          sensitiveCategory: page.sensitiveCategory,
          sensitiveReason: page.sensitiveReason,
          authUseSystemBrowser: page.authUseSystemBrowser,
        }
      );
    }
  }

  function waitForScreencastFrame(page, { afterSeq, waitMs, signal }) {
    return new Promise((resolve) => {
      const finish = (frame) => {
        if (frame && frame.seq <= afterSeq) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        page.pendingFrameWaiters.delete(finish);
        resolve(frame);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(onAbort, waitMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      page.pendingFrameWaiters.add(finish);
    });
  }

  async function performFrame(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId, { requireActive: input.stream === true });
    const handle = browserHandle;
    const assertFrameTarget = () => {
      signal?.throwIfAborted();
      if (closed || handle !== browserHandle || !handle || handle.client.closed || page.frameTargetBlocked ||
          pagesById.get(page.pageId) !== page || (input.stream && activePageId !== page.pageId)) {
        throw browserError('BROWSER_PAGE_MISMATCH', 'Browser frame target changed during capture.');
      }
      revalidateTargetState(page, input);
    };

    let frame;
    try {
      assertFrameTarget();
      if (!input.waitMs || !page.screencastActive) await refreshPageState(page, { signal, assertFrameTarget });
      assertFrameAccess(page, input);
      await startOrRenewScreencast(page, input, assertFrameTarget);
      assertFrameTarget();
      assertFrameAccess(page, input);

      const afterSeq = Math.max(input.afterSeq ?? 0, input.forceCapture ? page.latestFrame?.seq ?? 0 : 0);
      const waitMs = clampInt(input.waitMs, 1, 1500, FIRST_SCREENCAST_WAIT_MS);
      frame = page.latestFrame;
      if (page.screencastActive && (!frame || frame.seq <= afterSeq)) {
        await waitForScreencastFrame(page, { afterSeq, waitMs, signal });
        assertFrameTarget();
        assertFrameAccess(page, input);
        frame = page.latestFrame;
      }
      // A quiet live page can resend its validated cache for the relay's keyframe refresh.
      if (!frame || (frame.seq <= afterSeq && (!input.waitMs || input.forceCapture))) {
        frame = await captureBoundedScreenshot(page, { requestedQuality: input.quality, signal }, assertFrameTarget);
      }

      await refreshPageState(page, { signal, assertFrameTarget });
      assertFrameTarget();
      assertFrameAccess(page, input);
      if (frame.frameGeneration !== page.frameGeneration || frame.documentGeneration !== page.documentGeneration) {
        throw browserError('BROWSER_STALE_REVISION', 'Browser page changed while capturing a frame.');
      }
    } catch (error) {
      // Input may invalidate an in-flight screenshot. Retry through the next observation
      // without replaying its pixels or closing the authenticated stream.
      if (!input.stream || error?.code !== 'BROWSER_STALE_REVISION') throw error;
      assertFrameTarget();
      assertFrameAccess(page, input);
      return { frameUnchanged: true, pageId: page.pageId };
    }

    return {
      seq: frame.seq,
      ...(input.stream && page.screencastHasFrames ? { captureSeq: frame.seq } : {}),
      mimeType: frame.mimeType,
      data: frame.data,
      width: frame.width,
      height: frame.height,
      revision,
      documentGeneration: page.documentGeneration,
      pageId: page.pageId,
      url: page.url,
      title: page.title,
      sensitive: Boolean(page.sensitive),
      sensitiveCategory: page.sensitiveCategory,
      sensitiveReason: page.sensitiveReason,
      authUseSystemBrowser: Boolean(page.authUseSystemBrowser),
      capturedAt: frame.capturedAt,
    };
  }

  async function performSnapshot(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId);
    await refreshPageState(page, { signal });
    revalidateTargetState(page, input);

    if (page.sensitive) {
      throw browserError(
        'BROWSER_SENSITIVE_PAGE',
        page.sensitiveReason || 'Cannot observe sensitive page via Bot snapshot.',
        {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: page.sensitiveCategory,
          sensitiveReason: page.sensitiveReason,
          authUseSystemBrowser: page.authUseSystemBrowser,
        }
      );
    }

    const maxNodes = clampInt(
      input.maxNodes,
      10,
      DESKTOP_BROWSER_HARD_MAX_SNAPSHOT_NODES,
      DESKTOP_BROWSER_MAX_SNAPSHOT_NODES
    );
    const tree = await browserHandle.client.send(
      'Accessibility.getFullAXTree',
      {},
      { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
    );

    const built = buildAccessibilitySnapshot(tree?.nodes, {
      pageUrl: page.url,
      pageTitle: page.title,
      documentGeneration: page.documentGeneration,
      interactiveOnly: input.interactive === true,
      maxNodes,
    });
    page.refs = built.refMap;

    return {
      pageId: page.pageId,
      url: page.url,
      title: page.title,
      revision,
      documentGeneration: page.documentGeneration,
      snapshot: built.snapshot,
      refs: built.refs,
      truncated: built.truncated,
      sensitive: false,
    };
  }

  async function probeWaitDomCondition(page, { selector, state, text, url }, signal, timeoutMs) {
    const client = browserHandle.client;
    const evalTimeout = Math.max(50, Math.min(commandTimeoutMs, timeoutMs));
    const docRes = await client.send(
      'Runtime.evaluate',
      {
        expression: INTERNAL_DOCUMENT_HANDLE_EXPRESSION,
        returnByValue: false,
        awaitPromise: false,
        silent: true,
      },
      { sessionId: page.sessionId, timeoutMs: evalTimeout, signal }
    );
    const objectId = docRes?.result?.objectId;
    if (!objectId) {
      return null;
    }
    try {
      const callRes = await client.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: INTERNAL_WAIT_CONDITION_FUNCTION,
          arguments: [
            {
              value: {
                ...(selector !== undefined ? { selector } : {}),
                ...(state !== undefined ? { state } : {}),
                ...(text !== undefined ? { text } : {}),
                ...(url !== undefined ? { url } : {}),
              },
            },
          ],
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        },
        { sessionId: page.sessionId, timeoutMs: evalTimeout, signal }
      );
      if (callRes?.exceptionDetails) {
        return null;
      }
      return isPlainObject(callRes?.result?.value) ? callRes.result.value : null;
    } finally {
      client
        .send('Runtime.releaseObject', { objectId }, { sessionId: page.sessionId, timeoutMs: 2_000 })
        .catch(() => undefined);
    }
  }

  function buildActResult(page, kind, detail) {
    return {
      ok: true,
      kind,
      pageId: page.pageId,
      revision,
      documentGeneration: page.documentGeneration,
      url: page.url,
      title: page.title,
      sensitive: Boolean(page.sensitive),
      sensitiveCategory: page.sensitiveCategory,
      sensitiveReason: page.sensitiveReason,
      authUseSystemBrowser: Boolean(page.authUseSystemBrowser),
      ...detail,
    };
  }

  async function performWait(input) {
    const { signal } = input;
    const waitSpec = normalizeDesktopWaitCommand(input);
    const page = await enqueue(async () => {
      assertProviderOpen();
      const target = resolveOwnedPage(input.pageId);
      if (!waitSpec.hasCondition) await refreshPageState(target, { signal });
      revalidateTargetState(target, { ...input, documentGeneration: undefined });
      assertPageNotSensitiveForBot(target);
      return target;
    });

    if (signal?.aborted) {
      throw browserError('CANCELLED', 'Browser wait cancelled.', { outcome: 'not-sent' });
    }
    const registerWakeup = (wake) => {
      page.waitWakeups.add(wake);
      return () => page.waitWakeups.delete(wake);
    };

    if (!waitSpec.hasCondition) {
      const waitMs = waitSpec.timeoutMs;
      const deadline = Date.now() + waitMs;
      const assertTimedWaitTarget = () => {
        if (signal?.aborted) {
          throw browserError('CANCELLED', 'Browser wait cancelled.', { outcome: 'not-sent' });
        }
        assertProviderOpen();
        if (!browserHandle || browserHandle.client.closed) {
          throw browserError('BROWSER_PROCESS_EXITED', 'Desktop browser process is not running.');
        }
        if (pagesById.get(page.pageId) !== page) {
          throw browserError('BROWSER_TAB_NOT_FOUND', `Browser page '${page.pageId}' was not found for this Bot.`);
        }
        assertPageNotSensitiveForBot(page);
      };
      for (;;) {
        const result = await enqueue(async () => {
          assertTimedWaitTarget();
          if (Date.now() < deadline) return null;
          await refreshPageState(page, { signal });
          assertTimedWaitTarget();
          return buildActResult(page, 'wait', { waitedMs: waitMs });
        });
        if (result) return result;
        await sleepAbortable(
          deadline - Date.now(),
          signal,
          (cancel) => {
            activeWaits.add(cancel);
            return () => activeWaits.delete(cancel);
          },
          registerWakeup
        );
      }
    }

    const startedAt = performance.now();
    const deadlineSignal = AbortSignal.timeout(waitSpec.timeoutMs);
    const closeController = new AbortController();
    const onClose = () => closeController.abort();
    const waitSignal = AbortSignal.any([deadlineSignal, closeController.signal, ...(signal ? [signal] : [])]);
    activeWaits.add(onClose);

    const assertWaiting = () => {
      if (signal?.aborted || closeController.signal.aborted) throw browserError('CANCELLED', 'Wait cancelled.');
      assertProviderOpen();
      if (deadlineSignal.aborted || performance.now() - startedAt >= waitSpec.timeoutMs) {
        throw browserError('BROWSER_TIMEOUT', 'Browser wait conditions were not met before timeout.');
      }
      if (pagesById.get(page.pageId) !== page) throw browserError('BROWSER_TAB_NOT_FOUND', 'Wait target closed.');
      assertPageNotSensitiveForBot(page);
    };

    try {
      for (;;) {
        // Sample a single document between mutations, then release the queue between samples.
        const result = await enqueue(async () => {
          assertWaiting();
          const { domSignals } = await refreshPageState(page, { signal: waitSignal });
          assertWaiting();
          const generation = page.documentGeneration;
          let probe = null;
          if (domSignals) {
            try {
              probe = await probeWaitDomCondition(page, waitSpec, waitSignal, waitSpec.timeoutMs);
            } catch {
              // Navigation can destroy the execution context. Retry on the next pass.
            }
          }
          assertWaiting();
          if (!probe || generation !== page.documentGeneration) return null;
          if (probe.selectorInvalid) throw browserError('INVALID_ARGUMENT', 'Invalid CSS selector in act.wait.');
          const loaded = !waitSpec.load || (waitSpec.load === 'load'
            ? !page.isNavigating && probe.readyState === 'complete'
            : (probe.readyState === 'interactive' || probe.readyState === 'complete')
              && (!page.isNavigating || page.domContentLoaded));
          if (loaded && (!waitSpec.selector || probe.selectorMatched) && (!waitSpec.text || probe.textMatched)
              && (!waitSpec.url || probe.urlMatched)) {
            return buildActResult(page, 'wait', { waitedMs: Math.round(performance.now() - startedAt) });
          }
          return null;
        });
        if (result) return result;
        try {
          await sleepAbortable(WAIT_POLL_INTERVAL_MS, waitSignal, null, registerWakeup);
        } catch {
          assertWaiting();
        }
      }
    } finally {
      activeWaits.delete(onClose);
    }
  }

  async function performAct(input, cmd, kind) {
    const signal = input.signal;

    if (FORBIDDEN_ACT_KINDS.has(kind) || FORBIDDEN_ACT_KINDS.has(kind.toLowerCase())) {
      throw browserError(
        'BROWSER_ACTION_FORBIDDEN',
        `Bot browser action '${kind}' is prohibited (no arbitrary eval, cookie export, or CDP passthrough).`,
        { outcome: 'not-sent' }
      );
    }
    if (!ALLOWED_BOT_ACT_KINDS.has(kind)) {
      throw browserError('INVALID_ARGUMENT', `Unsupported Bot act kind: ${kind || '(empty)'}`, {
        outcome: 'not-sent',
      });
    }

    const page = resolveOwnedPage(input.pageId);
    await refreshPageState(page, { signal });
    revalidateTargetState(page, input);
    assertPageNotSensitiveForBot(page);

    const resolveRef = async () => {
      const refId = String(cmd.ref ?? cmd.element ?? '').trim();
      if (!refId) {
        throw browserError('INVALID_ARGUMENT', `Bot act '${kind}' requires a snapshot ref.`, {
          outcome: 'not-sent',
        });
      }
      const entry = page.refs.get(refId);
      if (!entry || entry.documentGeneration !== page.documentGeneration) {
        throw browserError(
          'BROWSER_STALE_REF',
          `Element ref '${refId}' is stale or unknown; take a fresh snapshot.`,
          { outcome: 'not-sent' }
        );
      }
      const meta = await callInternalElementFunction(
        page,
        entry.backendDOMNodeId,
        INTERNAL_ELEMENT_META_FUNCTION,
        [],
        signal
      );
      if (!meta) {
        throw browserError('BROWSER_STALE_REF', `Element ref '${refId}' is no longer present.`, {
          outcome: 'not-sent',
        });
      }
      const guard = checkBotHumanOnlyTarget({
        url: page.url,
        title: page.title,
        role: entry.role,
        name: entry.name,
        inputType: meta.type || entry.inputType,
        actionKind: kind,
      });
      if (guard.blocked) {
        throw browserError('BROWSER_HUMAN_REQUIRED', guard.reason, {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: guard.category,
          sensitiveReason: guard.reason,
        });
      }
      return { entry, meta };
    };

    let detail = {};
    invalidatePageFrames(page);

    if (kind === 'click' || kind === 'dblclick' || kind === 'hover') {
      const { entry } = await resolveRef();
      const { x, y } = await resolveElementCenter(page, entry.backendDOMNodeId, signal);
      await browserHandle.client.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, modifiers: 0 },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      if (kind !== 'hover') {
        const clicks = kind === 'dblclick' ? 2 : 1;
        for (let i = 1; i <= clicks; i++) {
          await browserHandle.client.send(
            'Input.dispatchMouseEvent',
            { type: 'mousePressed', x, y, button: 'left', clickCount: i, buttons: 1, modifiers: 0 },
            { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
          );
          await browserHandle.client.send(
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x, y, button: 'left', clickCount: i, buttons: 0, modifiers: 0 },
            { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
          );
        }
      }
      detail = { ref: entry.ref };
    } else if (kind === 'focus') {
      const { entry } = await resolveRef();
      await browserHandle.client.send(
        'DOM.scrollIntoViewIfNeeded',
        { backendNodeId: entry.backendDOMNodeId },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      await browserHandle.client.send(
        'DOM.focus',
        { backendNodeId: entry.backendDOMNodeId },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      detail = { ref: entry.ref };
    } else if (kind === 'fill' || kind === 'clear') {
      const { entry } = await resolveRef();
      const value = kind === 'clear' ? '' : String(cmd.value ?? cmd.text ?? '');
      if (value.length > 0) {
        normalizeInputText(value);
      }
      const outcome = await callInternalElementFunction(
        page,
        entry.backendDOMNodeId,
        INTERNAL_FILL_ELEMENT_FUNCTION,
        [value],
        signal
      );
      if (typeof outcome === 'string') {
        throw browserError('BROWSER_ELEMENT_NOT_INTERACTABLE', `Cannot ${kind} ${entry.ref}: ${outcome}`);
      }
      detail = { ref: entry.ref };
    } else if (kind === 'select') {
      const { entry } = await resolveRef();
      const optionValue = String(cmd.value ?? '');
      const outcome = await callInternalElementFunction(
        page,
        entry.backendDOMNodeId,
        INTERNAL_SELECT_OPTION_FUNCTION,
        [optionValue],
        signal
      );
      if (typeof outcome === 'string') {
        throw browserError('BROWSER_ELEMENT_NOT_INTERACTABLE', `Cannot select in ${entry.ref}: ${outcome}`);
      }
      detail = { ref: entry.ref, selected: optionValue };
    } else if (kind === 'check' || kind === 'uncheck') {
      const { entry, meta } = await resolveRef();
      const desired = kind === 'check';
      if (meta.disabled) {
        throw browserError('BROWSER_ELEMENT_NOT_INTERACTABLE', `Element ${entry.ref} is disabled.`, {
          outcome: 'not-sent',
        });
      }
      if (meta.checked !== desired) {
        const { x, y } = await resolveElementCenter(page, entry.backendDOMNodeId, signal);
        await browserHandle.client.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x, y, modifiers: 0 },
          { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
        );
        await browserHandle.client.send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, modifiers: 0 },
          { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
        );
        await browserHandle.client.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, modifiers: 0 },
          { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
        );
      }
      detail = { ref: entry.ref, checked: desired };
    } else if (kind === 'type') {
      const text = normalizeInputText(cmd.text ?? cmd.value);
      await browserHandle.client.send(
        'Input.insertText',
        { text },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      detail = { typed: true };
    } else if (kind === 'press') {
      const descriptor = resolveCdpKeyDescriptor(cmd.key, cmd.modifiers);
      await dispatchKeyDescriptor(page, descriptor, signal);
      detail = { pressed: descriptor.key };
    } else if (kind === 'scroll') {
      const direction = String(cmd.direction ?? 'down').toLowerCase();
      const amount = clampInt(cmd.amount, 50, 2_000, 400);
      let deltaX = 0;
      let deltaY = 0;
      if (direction === 'down') deltaY = amount;
      else if (direction === 'up') deltaY = -amount;
      else if (direction === 'right') deltaX = amount;
      else if (direction === 'left') deltaX = -amount;
      else {
        throw browserError('INVALID_ARGUMENT', `Unsupported scroll direction: ${direction}`, {
          outcome: 'not-sent',
        });
      }
      await browserHandle.client.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: Math.round(viewport.width / 2),
          y: Math.round(viewport.height / 2),
          deltaX,
          deltaY,
          modifiers: 0,
        },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      detail = { scrolled: direction, amount };
    }

    await refreshPageState(page, { signal });
    return buildActResult(page, kind, detail);
  }

  async function performInput(input) {
    const signal = input.signal;
    if (input.actor === 'bot') {
      throw browserError(
        'BROWSER_FORBIDDEN',
        'Direct coordinate/keyboard input is restricted to human takeover; Bot must use act.',
        { outcome: 'not-sent' }
      );
    }

    const normalized = normalizeHumanInputEvent(input.event);
    const page = resolveOwnedPage(input.pageId, {
      requireActive: input.requireActivePage !== false,
    });

    // Strict pre-dispatch revalidation of target page, document generation, URL, and sensitivity.
    await refreshPageState(page, { signal });
    revalidateTargetState(page, input);

    if (page.secretExposureRisk && input.allowSecretInput !== true) {
      throw browserError(
        'BROWSER_SECRET_INPUT_BLOCKED',
        'Client secret dialog detected; complete secret steps outside ordinary browser stream.',
        {
          outcome: 'not-sent',
          sensitive: true,
          sensitiveCategory: page.sensitiveCategory,
          sensitiveReason: page.sensitiveReason,
        }
      );
    }

    input.beforeInput?.();
    // The repaint can arrive before CDP acknowledges the input.
    invalidatePageFrames(page);
    if (normalized.kind === 'click' || normalized.kind === 'dblclick' || normalized.kind === 'move') {
      const px = Math.max(0, Math.min(viewport.width - 1, Math.round(normalized.x * viewport.width)));
      const py = Math.max(0, Math.min(viewport.height - 1, Math.round(normalized.y * viewport.height)));
      await browserHandle.client.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: px, y: py, modifiers: normalized.modifiers },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
      if (normalized.kind !== 'move') {
        const buttons = mouseButtonsBit(normalized.button);
        for (let i = 1; i <= normalized.clickCount; i++) {
          await browserHandle.client.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mousePressed',
              x: px,
              y: py,
              button: normalized.button,
              clickCount: i,
              buttons,
              modifiers: normalized.modifiers,
            },
            { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
          );
          await browserHandle.client.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mouseReleased',
              x: px,
              y: py,
              button: normalized.button,
              clickCount: i,
              buttons: 0,
              modifiers: normalized.modifiers,
            },
            { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
          );
        }
      }
    } else if (normalized.kind === 'text') {
      await browserHandle.client.send(
        'Input.insertText',
        { text: normalized.text },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
    } else if (normalized.kind === 'key') {
      await dispatchKeyDescriptor(page, normalized.descriptor, signal);
    } else if (normalized.kind === 'wheel') {
      const px = Math.max(0, Math.min(viewport.width - 1, Math.round(normalized.x * viewport.width)));
      const py = Math.max(0, Math.min(viewport.height - 1, Math.round(normalized.y * viewport.height)));
      await browserHandle.client.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: px,
          y: py,
          deltaX: normalized.deltaX,
          deltaY: normalized.deltaY,
          modifiers: normalized.modifiers,
        },
        { sessionId: page.sessionId, timeoutMs: commandTimeoutMs, signal }
      );
    }

    await refreshPageState(page, { signal });
    return {
      ok: true,
      pageId: page.pageId,
      revision,
      documentGeneration: page.documentGeneration,
      url: page.url,
      title: page.title,
      sensitive: Boolean(page.sensitive),
      sensitiveCategory: page.sensitiveCategory,
      sensitiveReason: page.sensitiveReason,
      authUseSystemBrowser: Boolean(page.authUseSystemBrowser),
    };
  }

  async function performStopStream(input) {
    if (input.pageId) {
      const page = pagesById.get(input.pageId);
      if (page) await stopPageScreencast(page);
    } else {
      for (const page of pagesById.values()) {
        await stopPageScreencast(page);
      }
    }
    return { ok: true, stopped: true };
  }

  return {
    get botId() {
      return botId;
    },
    get profilePath() {
      return resolvedProfilePath;
    },

    async perform(input) {
      assertProviderOpen();
      if (!isPlainObject(input)) {
        throw browserError('INVALID_ARGUMENT', 'perform(input) requires a plain object.', {
          outcome: 'not-sent',
        });
      }
      if (input.botId !== undefined && input.botId !== botId) {
        throw browserError('BROWSER_BOT_MISMATCH', 'Browser control botId does not match provider owner.', {
          outcome: 'not-sent',
        });
      }

      const action = input.action;
      if (action === 'status') {
        return browserHandle && !browserHandle.client.closed
          ? enqueue(() => performStatus())
          : performStatus();
      }
      // Frame wait and screenshot CDP commands never reserve the mutation/input queue.
      if (action === 'frame') return performFrame(input);
      const cmd = action === 'act' ? (isPlainObject(input.command) ? input.command : input) : null;
      const kind = cmd && String(cmd.kind ?? cmd.op ?? '').trim();
      if (kind === 'wait') return performWait(input);

      return enqueue(async () => {
        assertProviderOpen();
        switch (action) {
          case 'open':
            return performOpen(input);
          case 'select':
            return performSelect(input);
          case 'navigate':
            return performNavigate(input);
          case 'back':
          case 'forward':
          case 'reload':
            return performHistoryOrReload(input);
          case 'closeTab':
            return performCloseTab(input);
          case 'stopStream':
            return performStopStream(input);
          case 'snapshot':
            return performSnapshot(input);
          case 'act':
            return performAct(input, cmd, kind);
          case 'input':
            return performInput(input);
          default:
            throw browserError(
              'BROWSER_ACTION_UNSUPPORTED',
              `Unsupported desktop browser provider action: ${String(action)}`,
              { outcome: 'not-sent' }
            );
        }
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const cancel of Array.from(activeWaits)) {
        cancel();
      }
      activeWaits.clear();
      const handle = browserHandle;
      clearRuntimeState();
      if (handle) {
        await handle.close();
      }
    },
  };
}
