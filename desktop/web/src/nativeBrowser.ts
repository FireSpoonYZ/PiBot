import { invoke } from '@tauri-apps/api/core';
import type { NativeBrowserPresenter } from '../../../web/src/bot-browser/nativePresentation';
import { automaticGoogleClientSetup, googleSetupConsoleUrl } from '../../../web/src/google/currentGoogleSetup';
import { configureGoogleClient, createGoogleSetupControlRequest, fetchGoogleStatus } from '../../../web/src/google/googleClient';
import type { GoogleSetupControlState } from '../../../web/src/google/types';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { nextBrowserHostReconnectDelay } from './vendor/orca/browserHostReconnectDelay';

type NativeResult = Record<string, unknown>;
type RendererCommand = { operation: string; operationId: string; pageId: string } & NativeResult;
type RenderPlacement = 'client' | 'server';
const nativeKeys = [
  'url', 'title', 'width', 'height', 'documentGeneration', 'text', 'elements', 'mimeType', 'data',
  'ok', 'canGoBack', 'canGoForward',
] as const;

function broker<T>(op: string, params: Record<string, unknown>) {
  return invoke<T>('desktop_request', { request: { op, params } });
}

let directRoute: Promise<string | null> | null = null;
function discoverLocalHost() {
  directRoute ??= invoke<{ deviceId?: string }>('desktop_browser_local_route').then(
    value => value.deviceId ?? null, () => null,
  ).finally(() => { window.setTimeout(() => { directRoute = null; }, 15_000); });
  return directRoute;
}

// This module runs inside the single trusted desktop window. Capture subscriptions can
// change generation (and recreate target API proxies) without replacing its guest pages.
const sessions = new Map<string, DesktopNativeBrowser>();

export function desktopNativeBrowser(api: DesktopPanelApi, identity: DesktopIdentity, botId: string) {
  const key = JSON.stringify([identity.profileId, identity.kind, identity.targetDeviceId, botId]);
  let native = sessions.get(key);
  if (!native) {
    native = new DesktopNativeBrowser(api, identity, botId, key);
    sessions.set(key, native);
  }
  native.identity = identity;
  return native;
}

export class DesktopNativeBrowser implements NativeBrowserPresenter {
  private rendererId = crypto.randomUUID();
  private readonly pages = new Map<string, string>();
  private readonly hidden = new Map<string, number>();
  private googleClientAttempt?: { runId: string; result: Promise<GoogleSetupControlState> };
  private local = false;
  private attached = false;
  private polling = false;
  private preparing: Promise<boolean> | null = null;
  private lastAttempt = 0;
  private lastPlacement: RenderPlacement | null = null;
  private windowClosedByHost = false;
  private proxyUrl: string | undefined;

  constructor(
    private readonly api: DesktopPanelApi,
    public identity: DesktopIdentity,
    private readonly botId: string,
    private readonly key: string,
  ) {}

  private activeConnection() {
    try {
      const identity = this.api.identityForTarget(this.identity.targetDeviceId);
      return identity.profileId === this.identity.profileId && identity.kind === this.identity.kind;
    } catch {
      return false;
    }
  }

  private control<T>(input: Record<string, unknown>) {
    if (!this.activeConnection()) return Promise.reject({ code: 'NOT_CONNECTED' });
    return broker<T>('call', {
      targetDeviceId: this.identity.targetDeviceId, method: 'browserControl', params: { ...input, botId: this.botId },
    });
  }

  async prepare(placement: RenderPlacement) {
    if (this.preparing) {
      await this.preparing;
      if (placement === 'client') return this.attached;
    }
    if (placement === 'client' && this.attached) {
      this.startPolling();
      return true;
    }
    if (this.polling && !this.attached) return false;
    if (this.lastPlacement === placement && Date.now() - this.lastAttempt < 1_500) return false;
    this.lastPlacement = placement;
    this.lastAttempt = Date.now();
    this.preparing = this.configure(placement).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  private async configure(placement: RenderPlacement): Promise<boolean> {
    this.local = await this.isLocalHost();
    if (!this.local && placement === 'server') {
      return this.attached && !(await this.detachIdle());
    }
    if (this.attached) return true;
    const active = [...sessions.values()].filter(session => session.attached);
    if (active.length >= 3) {
      const idle = active.find(session => !session.pages.size && !session.preparing);
      if (!idle || !(await idle.detachIdle())) return false;
    }
    const result = await this.control<{ accepted: boolean }>({ action: 'rendererAttach', rendererId: this.rendererId });
    if (!result.accepted) return false;
    try {
      const egress = await broker<{ proxyUrl: string | null }>('browser_egress_open', {
        targetDeviceId: this.identity.targetDeviceId, botId: this.botId, rendererId: this.rendererId,
      });
      this.proxyUrl = egress.proxyUrl ?? undefined;
      if (!this.activeConnection()) throw Error('Browser connection changed');
    } catch {
      await this.control({ action: 'rendererDetach', rendererId: this.rendererId }).catch(() => {});
      await this.closeProxy();
      return false;
    }
    this.attached = true;
    this.startPolling();
    return true;
  }

  async isLocalHost() {
    return this.identity.kind === 'local' || await discoverLocalHost() === this.identity.targetDeviceId;
  }

  private async detachIdle() {
    if (this.pages.size) return false;
    const result = await this.control<{ ok: boolean }>({ action: 'rendererDetach', rendererId: this.rendererId });
    if (!result.ok) return false;
    this.attached = false;
    await this.closeProxy();
    return true;
  }

  private closeProxy() {
    this.proxyUrl = undefined;
    return broker('browser_egress_close', { rendererId: this.rendererId }).catch(() => {});
  }

  private native(operation: string, pageId: string, params: NativeResult = {}) {
    return invoke<NativeResult>('desktop_browser_guest', { request: {
      ...params, operation, holder: this.rendererId, guestId: this.pages.get(pageId),
    } });
  }

  provisionGoogleClient(runId: string, centerApi: DesktopPanelApi, centerIdentity: DesktopIdentity) {
    if (this.googleClientAttempt?.runId === runId) return this.googleClientAttempt.result;
    const result = this.provisionGoogleClientOnce(runId, centerApi, centerIdentity);
    this.googleClientAttempt = { runId, result };
    return result;
  }

  private async provisionGoogleClientOnce(runId: string, centerApi: DesktopPanelApi, centerIdentity: DesktopIdentity) {
    const hostIdentity = this.identity;
    const setupControl = createGoogleSetupControlRequest(this.api, hostIdentity, this.botId);
    const setup = await setupControl({ action: 'status' });
    const target = automaticGoogleClientSetup(setup);
    if (!target || target.runId !== runId) throw Error('Google setup changed');
    const readLiveRun = async () => {
      const latest = await setupControl({ action: 'status' });
      const live = automaticGoogleClientSetup(latest);
      if (live?.runId !== runId || live.projectId !== target.projectId || live.account !== target.account) {
        throw Error('Google setup changed');
      }
      return latest;
    };

    let { client } = await fetchGoogleStatus(centerApi, centerIdentity);
    if (!client.configured) {
      const consoleUrl = googleSetupConsoleUrl('client', target);
      if (!client.supportsAutoConfigure || !client.redirectUri?.startsWith('https://') || !consoleUrl ||
          (setup.center?.client?.redirectUri && client.redirectUri !== setup.center.client.redirectUri)) {
        throw Error('Automatic Google client setup is unavailable');
      }
      const local = await this.isLocalHost();
      const browser = await this.control<{ renderPlacement?: 'client'; rendererId?: string; tabs?: { id: string }[] }>({ action: 'status' });
      if ((browser.renderPlacement === 'client' && browser.rendererId !== this.rendererId) ||
          (!local && (!this.proxyUrl || !browser.tabs?.some(tab => tab.id === setup.browserPageId)))) {
        throw Error('Automatic Google setup needs this desktop to own the setup browser');
      }
      await readLiveRun();
      const download = await this.native('provisionGoogleClient', '', {
        url: consoleUrl, text: client.redirectUri, setupRunId: runId,
        hostId: hostIdentity.targetDeviceId, botId: this.botId,
        ...(this.proxyUrl ? { proxyUrl: this.proxyUrl } : {}),
      });
      if (typeof download.clientFile !== 'string') throw Error('No Web OAuth client was downloaded');
      await readLiveRun();
      try {
        ({ client } = await configureGoogleClient(centerApi, centerIdentity, {
          clientFile: download.clientFile, projectId: target.projectId, ifUnconfigured: true,
        }));
      } catch {
        // A lost response or concurrent first-time import can already have completed setup.
        ({ client } = await fetchGoogleStatus(centerApi, centerIdentity));
      }
    }

    if (!client.configured || client.projectId !== target.projectId) throw Error('Center did not save this project’s Google OAuth client');
    void this.native('finishGoogleClientProvision', '', { setupRunId: runId }).catch(() => {});
    const latest = await readLiveRun();
    const next = await setupControl({ action: 'advance', step: 'client', runId, expectedRevision: latest.revision });
    if (next.id !== runId || next.stale || next.step !== 'connect') {
      throw Error('Center could not verify the Google OAuth client for this setup');
    }
    return next;
  }

  private async execute(command: RendererCommand) {
    const { operationId: _operationId, operation, pageId, elementRef, ...params } = command;
    if (operation === 'provisionGoogleClient' || operation === 'finishGoogleClientProvision') {
      throw Error('Private Google client setup is owner-only');
    }
    if (operation === 'create') {
      const rendererId = this.rendererId;
      const opened = await this.native('create', pageId, {
        ...params, ...(this.proxyUrl ? { proxyUrl: this.proxyUrl } : {}),
        hostId: this.identity.targetDeviceId, botId: this.botId,
      });
      if (typeof opened.guestId !== 'string') throw Error('Native browser did not open');
      if (rendererId !== this.rendererId || !this.attached || !this.activeConnection()) {
        await invoke('desktop_browser_guest', {
          request: { operation: 'close', holder: rendererId, guestId: opened.guestId },
        }).catch(() => {});
        throw Error('Browser connection changed');
      }
      this.pages.set(pageId, opened.guestId);
      return opened;
    }
    if (!this.pages.has(pageId)) throw { code: 'BROWSER_STALE_PAGE' };
    if (operation === 'hide') await this.hide(pageId);
    const result = operation === 'hide' ? { ok: true } : await this.native(operation, pageId, {
      ...params, ...(typeof elementRef === 'number' ? { ref: elementRef } : {}),
    });
    if (operation === 'close') {
      this.pages.delete(pageId);
      this.hidden.delete(pageId);
    }
    return result;
  }

  private startPolling() {
    if (this.polling) return;
    this.polling = true;
    void (async () => {
      let failures = 0;
      let rendererGone = false;
      try {
        while (this.attached && this.activeConnection()) {
          try {
            const { command } = await this.control<{ command: RendererCommand | null }>({
              action: 'rendererNext', rendererId: this.rendererId,
            });
            failures = 0;
            if (command && this.attached && this.activeConnection()) {
              void this.executeAndReply(command);
            }
          } catch (error) {
            if ((error as { code?: string })?.code === 'BROWSER_FORBIDDEN') {
              rendererGone = true;
              break;
            }
            if (!this.attached || !this.activeConnection()) break;
            const retryDelay = nextBrowserHostReconnectDelay({
              baseDelayMs: 100, attempt: failures++, remainingMs: 2_000, browserHostClientId: this.rendererId,
            });
            await new Promise(resolve => window.setTimeout(resolve, retryDelay));
          }
        }
      } finally {
        if (rendererGone || !this.activeConnection()) {
          await this.closeGuests();
          this.rendererId = crypto.randomUUID();
          this.lastAttempt = 0;
          if (!this.activeConnection() && sessions.get(this.key) === this) sessions.delete(this.key);
        }
        this.polling = false;
      }
    })();
  }

  private async closeGuests() {
    this.attached = false;
    await Promise.allSettled([...this.pages.keys()].map(id => this.native('close', id)));
    this.pages.clear();
    this.hidden.clear();
    await this.closeProxy();
  }

  private async executeAndReply(command: RendererCommand) {
    const reply = { action: 'rendererReply', rendererId: this.rendererId, operationId: command.operationId };
    try {
      const result = await this.execute(command);
      const projected: NativeResult = {};
      for (const key of nativeKeys) if (result[key] !== undefined) projected[key] = result[key];
      if (result.domHints) projected.hints = result.domHints;
      await this.control({ ...reply, result: projected });
    } catch (error) {
      const err = error as { code?: string; message?: string };
      let code = validBrowserError(err?.code);
      if (/sensitive|credential/i.test(err?.message ?? '')) code = 'BROWSER_SENSITIVE_BLOCKED';
      else if (/frame.*(limit|bound|size)/i.test(err?.message ?? '')) code = 'BROWSER_FRAME_TOO_LARGE';
      await this.control({ ...reply, code }).catch(() => {});
    }
  }

  async request(input: Record<string, unknown>, placement: RenderPlacement) {
    if (input.action === 'status' || input.action === 'open') {
      await this.prepare(placement).catch(() => {});
      if (this.attached) this.startPolling();
    }
    if (input.action === 'open' && placement === 'client' && !this.attached) {
      throw { code: 'BROWSER_UNAVAILABLE', message: 'Desktop browser is not ready.' };
    }
    if (input.action === 'open' && placement === 'server' && !this.local && this.windowClosedByHost) {
      input = { ...input, placement: 'server' };
    }
    const result = await this.control<NativeResult>(input);
    if (input.action === 'status' || input.action === 'open') {
      this.windowClosedByHost = result.reason === 'client_browser_window_closed';
    }
    return result;
  }

  async present({ pageId, expiresAt, rect }: Parameters<NativeBrowserPresenter['present']>[0]) {
    if (!this.attached || !this.pages.has(pageId) || !this.activeConnection() || expiresAt <= Date.now()) return false;
    const marker = this.hidden.get(pageId);
    await this.native('layout', pageId, { bounds: rect });
    if (this.hidden.get(pageId) !== marker || expiresAt <= Date.now() || !this.activeConnection()) return false;
    await this.native('show', pageId, { ttlMs: Math.max(1, expiresAt - Date.now()) });
    if (this.hidden.get(pageId) !== marker) {
      await this.native('hide', pageId);
      return false;
    }
    return true;
  }

  async hide(pageId: string) {
    this.hidden.set(pageId, (this.hidden.get(pageId) ?? 0) + 1);
    if (this.pages.has(pageId)) await this.native('hide', pageId);
  }
}

function validBrowserError(code: string | undefined) {
  return code === 'BROWSER_STALE_PAGE' || code === 'BROWSER_STALE_DOCUMENT' || code === 'BROWSER_BUSY'
    ? code : 'BROWSER_BACKEND_FAILED';
}
