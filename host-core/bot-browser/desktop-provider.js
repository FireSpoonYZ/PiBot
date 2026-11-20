// host-core/bot-browser/desktop-provider.js
//
// Desktop Bot browser provider (`createDesktopBrowserProvider(opts)`).
// Manages one isolated headless Chromium-family process per Bot with:
//   - Local Chrome/Edge/Chromium/Brave discovery (no Orca required)
//   - Private per-Bot data dir (never connects to personal profiles)
//   - Private CDP pipe (POSIX) or 127.0.0.1 loopback WebSocket (Windows)
//   - Owned tab/navigation registry with documentGeneration & revision tracking
//   - Continuous bounded screencast frames (rate & 720 KiB base64 budget, never persisted)
//   - Real same-page mouse/keyboard/wheel human input with pre-dispatch revalidation
//   - Restricted Bot snapshot/act (no eval/cookies/CDP passthrough) + sensitive/ToS/OAuth/secret guards
//
// Portions of tab projection, serial execution queueing, and snapshot structure
// are adapted from Orca v1.4.265 (commit e64e561738d8d465ab459e7e3f9e46d08b6396ea):
//   - src/main/orcad/browser-providers/chromium/external-chromium-browser-process.ts
//   - src/main/orcad/browser-providers/chromium/external-chromium-tab-registry.ts
//   - src/main/orcad/browser-providers/chromium/external-chromium-tab-projection.ts
// MIT License — Copyright (c) 2026 Lovecast Inc.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertId } from '../message-protocol.js';
import { launchDesktopChromium } from './desktop-cdp.js';
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
  DESKTOP_BROWSER_MAX_WAIT_MS,
  DESKTOP_BROWSER_MIN_FRAME_INTERVAL_MS,
  DESKTOP_BROWSER_SCREENCAST_IDLE_STOP_MS,
  FORBIDDEN_ACT_KINDS,
  INTERNAL_ELEMENT_META_FUNCTION,
  INTERNAL_FILL_ELEMENT_FUNCTION,
  INTERNAL_SELECT_OPTION_FUNCTION,
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

function sleepAbortable(ms, signal, registerCancel) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(browserError('CANCELLED', 'Browser wait cancelled.', { outcome: 'not-sent' }));
      return;
    }
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      unregister?.();
    };
    const onAbort = () => {
      cleanup();
      reject(browserError('CANCELLED', 'Browser wait cancelled.', { outcome: 'not-sent' }));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const unregister = registerCancel?.(() => onAbort());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
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
  let activePageId = null;
  let offCdpEvent = null;
  let offCdpClose = null;

  const pagesById = new Map();
  const pagesByTargetId = new Map();
  const pagesBySessionId = new Map();
  const activeWaits = new Set();

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

  function clearPageScreencastTimers(page) {
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
  }

  function clearRuntimeState() {
    for (const page of pagesById.values()) {
      clearPageScreencastTimers(page);
      page.latestFrame = null;
      page.screencastActive = false;
    }
    pagesById.clear();
    pagesByTargetId.clear();
    pagesBySessionId.clear();
    activePageId = null;
    initialTargetId = null;
    sessionId = null;
    offCdpEvent?.();
    offCdpClose?.();
    offCdpEvent = null;
    offCdpClose = null;
    browserHandle = null;
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
      return {
        available: false,
        canStreamInteract: false,
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
      page.latestFrame = null;
      void stopPageScreencast(page);
    } else if (!prevSensitive && page.sensitive) {
      // Drop cached pre-transition frame when entering a sensitive page.
      page.latestFrame = null;
    }
  }

  async function refreshPageState(page, { signal } = {}) {
    if (!browserHandle || browserHandle.client.closed) {
      throw browserError('BROWSER_PROCESS_EXITED', 'Desktop browser process is not running.');
    }

    let domSignals = null;
    try {
      const frameTree = await browserHandle.client.send(
        'Page.getFrameTree',
        {},
        { sessionId: page.sessionId, timeoutMs: 5_000, signal }
      );
      const mainFrame = frameTree?.frameTree?.frame;
      if (mainFrame) {
        if (mainFrame.id) page.frameId = mainFrame.id;
        if (mainFrame.loaderId && page.loaderId && mainFrame.loaderId !== page.loaderId) {
          page.loaderId = mainFrame.loaderId;
          page.documentGeneration += 1;
          page.refs.clear();
          page.latestFrame = null;
          bumpRevision();
        } else if (mainFrame.loaderId && !page.loaderId) {
          page.loaderId = mainFrame.loaderId;
        }
        if (typeof mainFrame.url === 'string' && mainFrame.url) {
          page.url = mainFrame.url;
        }
      }
    } catch {
      // Keep last known URL if frameTree is momentarily busy.
    }

    try {
      const evalRes = await browserHandle.client.send(
        'Runtime.evaluate',
        {
          expression: SENSITIVE_DOM_PROBE_EXPRESSION,
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        },
        { sessionId: page.sessionId, timeoutMs: 4_000, signal }
      );
      if (isPlainObject(evalRes?.result?.value)) {
        domSignals = evalRes.result.value;
        if (typeof domSignals.title === 'string') {
          page.title = domSignals.title;
        }
        if (typeof domSignals.url === 'string' && domSignals.url) {
          if (page.url && domSignals.url !== page.url) {
            page.url = domSignals.url;
            page.latestFrame = null;
            bumpRevision();
          } else {
            page.url = domSignals.url;
          }
        }
      }
    } catch {
      // URL-based classification still applies if document is mid-navigation.
    }

    const classification = classifySensitivePage({
      url: page.url,
      title: page.title,
      domSignals,
    });
    applySensitiveState(page, classification);
    return { domSignals, classification };
  }

  async function stopPageScreencast(page) {
    if (!page) return;
    clearPageScreencastTimers(page);
    if (!page.screencastActive) return;
    page.screencastActive = false;
    page.latestFrame = null;
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

  async function handleCdpEvent(event) {
    const { method, params, sessionId: evSessionId } = event;

    if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
      const targetId = params.targetId;
      const page = targetId
        ? pagesByTargetId.get(targetId)
        : evSessionId
          ? pagesBySessionId.get(evSessionId)
          : null;
      if (page) {
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
      if (targetId && targetId === initialTargetId) {
        initialTargetId = null;
      }
      return;
    }

    if (method === 'Target.targetCreated') {
      const info = params.targetInfo;
      if (info && info.type === 'page' && info.openerId && pagesByTargetId.has(info.openerId)) {
        // Popup opened by an owned Bot tab: enforce maxTabs resource ceiling.
        if (pagesById.size >= maxTabs && browserHandle && !browserHandle.client.closed) {
          browserHandle.client
            .send('Target.closeTarget', { targetId: info.targetId }, { timeoutMs: 3_000 })
            .catch(() => undefined);
        }
      }
      return;
    }

    if (!evSessionId) return;
    const page = pagesBySessionId.get(evSessionId);
    if (!page) return;

    if (method === 'Page.frameNavigated') {
      const frame = params.frame;
      if (frame && !frame.parentId) {
        page.frameId = frame.id ?? page.frameId;
        page.loaderId = frame.loaderId ?? page.loaderId;
        if (typeof frame.url === 'string') {
          page.url = frame.url;
        }
        page.documentGeneration += 1;
        page.refs.clear();
        page.latestFrame = null;
        bumpRevision();
        applySensitiveState(page, classifySensitivePage({ url: page.url, title: page.title }));
      }
      return;
    }

    if (method === 'Page.navigatedWithinDocument') {
      if (!params.frameId || params.frameId === page.frameId) {
        if (typeof params.url === 'string') {
          page.url = params.url;
        }
        bumpRevision();
        applySensitiveState(page, classifySensitivePage({ url: page.url, title: page.title }));
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
      if (browserHandle && !browserHandle.client.closed && typeof ackSessionId === 'number') {
        browserHandle.client
          .send(
            'Page.screencastFrameAck',
            { sessionId: ackSessionId },
            { sessionId: page.sessionId, timeoutMs: 3_000 }
          )
          .catch(() => undefined);
      }
      if (page.secretExposureRisk) {
        page.latestFrame = null;
        return;
      }
      const data = typeof params.data === 'string' ? params.data : '';
      if (!data) return;
      const timestamp = now();
      if (page.lastAcceptedFrameAt > 0 && timestamp - page.lastAcceptedFrameAt < minFrameIntervalMs) {
        return;
      }
      if (data.length > maxFrameBase64Bytes) {
        page.frameOversizedHint = true;
        return;
      }
      page.frameOversizedHint = false;
      page.lastAcceptedFrameAt = timestamp;
      frameSeq += 1;
      const frame = {
        seq: frameSeq,
        mimeType: 'image/jpeg',
        data,
        width: viewport.width,
        height: viewport.height,
        revision,
        documentGeneration: page.documentGeneration,
        pageId: page.pageId,
        capturedAt: timestamp,
      };
      page.latestFrame = frame;
      if (page.pendingFrameWaiters.size > 0) {
        for (const resolveWaiter of page.pendingFrameWaiters) {
          resolveWaiter(frame);
        }
        page.pendingFrameWaiters.clear();
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

    const profilePath = await prepareBotProfileDir({
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
    resolvedProfilePath = profilePath;

    let handle;
    try {
      handle = await launchBrowser({
        executablePath: discovery.executablePath,
        profilePath,
        transport: discovery.transport,
        viewport,
        platform,
        env,
        commandTimeoutMs,
        signal,
      });
    } catch (err) {
      lastLaunchFailure = {
        reason: err?.code === 'BROWSER_PROFILE_UNWRITABLE' ? 'profile_dir_unwritable' : 'chromium_start_failed',
        detail: err?.message || 'Failed to start desktop Chromium browser.',
      };
      throw err;
    }

    lastLaunchFailure = null;
    browserHandle = handle;
    sessionId = randomUUID();
    offCdpEvent = handle.client.onEvent((event) => {
      void handleCdpEvent(event);
    });
    offCdpClose = handle.client.onClose(() => {
      clearRuntimeState();
    });

    // Enable target discovery & deny automatic file downloads (prevents silent secret JSON downloads).
    await handle.client
      .send('Target.setDiscoverTargets', { discover: true }, { timeoutMs: 5_000, signal })
      .catch(() => undefined);
    await handle.client
      .send('Browser.setDownloadBehavior', { behavior: 'deny' }, { timeoutMs: 5_000, signal })
      .catch(() => undefined);

    // Record the initial about:blank target so the first `open` reuses it cleanly.
    try {
      const { targetInfos } = await handle.client.send('Target.getTargets', {}, { timeoutMs: 5_000, signal });
      const initialPage = (Array.isArray(targetInfos) ? targetInfos : []).find((t) => t.type === 'page');
      initialTargetId = initialPage ? initialPage.targetId : null;
    } catch {
      initialTargetId = null;
    }

    return handle;
  }

  async function attachOwnedTarget(targetId, requestedPageId, signal) {
    const { sessionId: targetSessionId } = await browserHandle.client.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      { timeoutMs: commandTimeoutMs, signal }
    );

    const pageId = requestedPageId || randomUUID();
    const page = {
      pageId,
      targetId,
      sessionId: targetSessionId,
      frameId: null,
      loaderId: null,
      url: 'about:blank',
      title: '',
      documentGeneration: 1,
      sensitive: false,
      sensitiveCategory: null,
      sensitiveReason: null,
      secretExposureRisk: false,
      authUseSystemBrowser: false,
      refs: new Map(),
      screencastActive: false,
      screencastQuality: DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY,
      screencastIdleTimer: null,
      latestFrame: null,
      lastAcceptedFrameAt: 0,
      frameOversizedHint: false,
      pendingFrameWaiters: new Set(),
    };

    pagesById.set(pageId, page);
    pagesByTargetId.set(targetId, page);
    pagesBySessionId.set(targetSessionId, page);

    await Promise.all([
      browserHandle.client.send('Page.enable', {}, { sessionId: targetSessionId, timeoutMs: 5_000, signal }),
      browserHandle.client.send('DOM.enable', {}, { sessionId: targetSessionId, timeoutMs: 5_000, signal }),
      browserHandle.client.send('Accessibility.enable', {}, { sessionId: targetSessionId, timeoutMs: 5_000, signal }),
      browserHandle.client.send(
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
      page.latestFrame = null;
    }
    page.url = url;
    bumpRevision();

    if (url !== 'about:blank') {
      await waitForPageSettle(page, { timeoutMs: navigationTimeoutMs, signal });
    }
    await refreshPageState(page, { signal });
  }

  async function startOrRenewScreencast(page, { maxWidth, maxHeight, quality, signal }) {
    resetScreencastIdleTimer(page);
    const targetQuality = clampInt(quality, 20, 90, page.frameOversizedHint ? 40 : DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY);
    if (page.screencastActive && page.screencastQuality === targetQuality) {
      return;
    }
    if (page.screencastActive) {
      await stopPageScreencast(page);
      resetScreencastIdleTimer(page);
    }
    page.screencastQuality = targetQuality;
    page.screencastActive = true;
    try {
      await browserHandle.client.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: targetQuality,
          maxWidth: clampInt(maxWidth, 320, viewport.width, viewport.width),
          maxHeight: clampInt(maxHeight, 240, viewport.height, viewport.height),
          everyNthFrame: 1,
        },
        { sessionId: page.sessionId, timeoutMs: 5_000, signal }
      );
    } catch {
      page.screencastActive = false;
    }
  }

  async function captureBoundedScreenshot(page, { requestedQuality, signal }) {
    const qualities = requestedQuality
      ? [clampInt(requestedQuality, 20, 90, DESKTOP_BROWSER_DEFAULT_FRAME_QUALITY), ...ADAPTIVE_JPEG_QUALITIES]
      : [...ADAPTIVE_JPEG_QUALITIES];
    const tried = new Set();

    for (const q of qualities) {
      if (tried.has(q)) continue;
      tried.add(q);
      const res = await browserHandle.client.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: q, fromSurface: true },
        { sessionId: page.sessionId, timeoutMs: 8_000, signal }
      );
      const data = typeof res?.data === 'string' ? res.data : '';
      if (!data) {
        throw browserError('BROWSER_CAPTURE_FAILED', 'Browser returned an empty frame.');
      }
      if (data.length <= maxFrameBase64Bytes) {
        frameSeq += 1;
        const frame = {
          seq: frameSeq,
          mimeType: 'image/jpeg',
          data,
          width: viewport.width,
          height: viewport.height,
          revision,
          documentGeneration: page.documentGeneration,
          pageId: page.pageId,
          capturedAt: now(),
        };
        page.latestFrame = frame;
        page.lastAcceptedFrameAt = frame.capturedAt;
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
      try {
        const { targetInfos } = await browserHandle.client.send('Target.getTargets', {}, { timeoutMs: 4_000 });
        const liveTargetIds = new Set((Array.isArray(targetInfos) ? targetInfos : []).map((t) => t.targetId));
        for (const page of Array.from(pagesById.values())) {
          if (!liveTargetIds.has(page.targetId)) {
            clearPageScreencastTimers(page);
            pagesById.delete(page.pageId);
            pagesByTargetId.delete(page.targetId);
            pagesBySessionId.delete(page.sessionId);
            if (activePageId === page.pageId) {
              activePageId = null;
            }
            bumpRevision();
          }
        }
        const active = getActivePage();
        if (active) {
          await refreshPageState(active);
        }
      } catch {
        // Keep last state if target refresh momentarily failed.
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

    const requestedPageId =
      typeof input.pageId === 'string' && input.pageId.trim() ? input.pageId.trim() : null;
    if (requestedPageId && pagesById.has(requestedPageId) && input.newTab !== true) {
      const existing = pagesById.get(requestedPageId);
      if (activePageId && activePageId !== existing.pageId) {
        await stopPageScreencast(pagesById.get(activePageId));
      }
      await browserHandle.client.send(
        'Target.activateTarget',
        { targetId: existing.targetId },
        { timeoutMs: 5_000, signal }
      );
      activePageId = existing.pageId;
      bumpRevision();
      if (input.url !== undefined) {
        await navigatePage(existing, url, { actor: input.actor, signal });
      } else {
        await refreshPageState(existing, { signal });
      }
      return buildStatusView({ available: true, canStreamInteract: true });
    }

    if (pagesById.size >= maxTabs) {
      throw browserError(
        'BROWSER_TAB_LIMIT_REACHED',
        `Bot browser reached maximum open tabs limit (${maxTabs}). Close a tab before opening another.`,
        { outcome: 'not-sent' }
      );
    }

    let targetId;
    if (initialTargetId && pagesById.size === 0) {
      targetId = initialTargetId;
      initialTargetId = null;
    } else {
      const created = await browserHandle.client.send(
        'Target.createTarget',
        { url: 'about:blank', width: viewport.width, height: viewport.height },
        { timeoutMs: commandTimeoutMs, signal }
      );
      targetId = created.targetId;
    }

    const page = await attachOwnedTarget(targetId, requestedPageId, signal);
    if (activePageId && activePageId !== page.pageId) {
      await stopPageScreencast(pagesById.get(activePageId));
    }
    await browserHandle.client
      .send('Target.activateTarget', { targetId: page.targetId }, { timeoutMs: 5_000, signal })
      .catch(() => undefined);
    activePageId = page.pageId;
    bumpRevision();

    if (url !== 'about:blank') {
      await navigatePage(page, url, { actor: input.actor, signal });
    } else {
      await refreshPageState(page, { signal });
    }

    return buildStatusView({ available: true, canStreamInteract: true });
  }

  async function performSelect(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId);
    if (activePageId && activePageId !== page.pageId) {
      await stopPageScreencast(pagesById.get(activePageId));
    }
    await browserHandle.client.send(
      'Target.activateTarget',
      { targetId: page.targetId },
      { timeoutMs: 5_000, signal }
    );
    activePageId = page.pageId;
    bumpRevision();
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
      page.latestFrame = null;
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
        page.latestFrame = null;
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

  async function performFrame(input) {
    const signal = input.signal;
    const page = resolveOwnedPage(input.pageId);
    await refreshPageState(page, { signal });
    revalidateTargetState(page, input);

    if (page.secretExposureRisk && input.allowSecretFrame !== true) {
      await stopPageScreencast(page);
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

    await startOrRenewScreencast(page, {
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
      quality: input.quality,
      signal,
    });

    let frame = page.latestFrame;
    const isFresh =
      frame &&
      frame.documentGeneration === page.documentGeneration &&
      (!input.forceCapture) &&
      (input.afterSeq === undefined || frame.seq > input.afterSeq);

    if (!isFresh) {
      // Wait briefly for a live screencast frame before falling back to a bounded capture.
      const waited = await new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          page.pendingFrameWaiters.delete(finish);
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), FIRST_SCREENCAST_WAIT_MS);
        timer.unref?.();
        page.pendingFrameWaiters.add(finish);
      });
      if (waited && waited.documentGeneration === page.documentGeneration) {
        frame = waited;
      } else {
        frame = await captureBoundedScreenshot(page, {
          requestedQuality: input.quality,
          signal,
        });
      }
    }

    return {
      seq: frame.seq,
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

  async function performAct(input) {
    const signal = input.signal;
    const cmd = isPlainObject(input.command) ? input.command : input;
    const kind = String(cmd.kind ?? cmd.op ?? '').trim();

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
    } else if (kind === 'wait') {
      const waitMs = clampInt(cmd.timeoutMs ?? cmd.ms, 0, DESKTOP_BROWSER_MAX_WAIT_MS, 500);
      await sleepAbortable(waitMs, signal, (cancel) => {
        activeWaits.add(cancel);
        return () => activeWaits.delete(cancel);
      });
      detail = { waitedMs: waitMs };
    }

    if (kind !== 'wait') {
      page.latestFrame = null;
    }
    await refreshPageState(page, { signal });
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

    page.latestFrame = null;
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
      if (closed) {
        throw browserError('BROWSER_CLOSED', 'Desktop browser provider has been closed.', {
          outcome: 'not-sent',
        });
      }
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

      return enqueue(async () => {
        if (closed) {
          throw browserError('BROWSER_CLOSED', 'Desktop browser provider has been closed.', {
            outcome: 'not-sent',
          });
        }
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
          case 'frame':
            return performFrame(input);
          case 'stopStream':
            return performStopStream(input);
          case 'snapshot':
            return performSnapshot(input);
          case 'act':
            return performAct(input);
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
