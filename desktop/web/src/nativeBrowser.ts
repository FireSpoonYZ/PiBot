import { invoke } from '@tauri-apps/api/core';
import type { NativeBrowserPresenter } from '../../../web/src/bot-browser/nativePresentation';
import type { DesktopIdentity, DesktopPanelApi } from './types';

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

const sessions = new WeakMap<DesktopPanelApi, Map<string, DesktopNativeBrowser>>();

export function desktopNativeBrowser(api: DesktopPanelApi, identity: DesktopIdentity, botId: string) {
  let browsers = sessions.get(api);
  if (!browsers) sessions.set(api, browsers = new Map());
  const key = JSON.stringify([identity.profileId, identity.generation, identity.targetDeviceId, botId]);
  let native = browsers.get(key);
  if (!native) {
    native = new DesktopNativeBrowser(api, identity, botId, browsers, key);
    browsers.set(key, native);
  }
  native.identity = identity;
  return native;
}

export class DesktopNativeBrowser implements NativeBrowserPresenter {
  private readonly rendererId = crypto.randomUUID();
  private readonly pages = new Map<string, string>();
  private readonly hidden = new Map<string, number>();
  private local = false;
  private attached = false;
  private polling = false;
  private preparing: Promise<boolean> | null = null;
  private lastAttempt = 0;
  private lastPlacement: RenderPlacement | null = null;
  private proxyUrl: string | undefined;

  constructor(
    private readonly api: DesktopPanelApi,
    public identity: DesktopIdentity,
    private readonly botId: string,
    private readonly sessions: Map<string, DesktopNativeBrowser>,
    private readonly key: string,
  ) {}

  private activeConnection() {
    const identity = this.api.identity;
    return identity?.profileId === this.identity.profileId && identity.generation === this.identity.generation;
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
    const active = [...this.sessions.values()].filter(session => session.attached);
    if (active.length >= 3) {
      const idle = active.find(session => !session.pages.size && !session.preparing);
      if (!idle || !(await idle.detachIdle())) return false;
    }
    const result = await this.control<{ accepted: boolean }>({ action: 'rendererAttach', rendererId: this.rendererId });
    if (!result.accepted) return false;
    try {
      if (!this.local) {
        const egress = await broker<{ proxyUrl: string }>('browser_egress_open', {
          targetDeviceId: this.identity.targetDeviceId, botId: this.botId, rendererId: this.rendererId,
        });
        if (!egress.proxyUrl) throw Error('Remote browser route is unavailable');
        this.proxyUrl = egress.proxyUrl;
      }
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

  private async execute(command: RendererCommand) {
    const { operationId: _operationId, operation, pageId, elementRef, ...params } = command;
    if (operation === 'create') {
      const opened = await this.native('create', pageId, {
        ...params, ...(this.proxyUrl ? { proxyUrl: this.proxyUrl } : {}),
        hostId: this.identity.targetDeviceId, botId: this.botId,
      });
      if (typeof opened.guestId !== 'string') throw Error('Native browser did not open');
      this.pages.set(pageId, opened.guestId);
      if (!this.attached || !this.activeConnection()) {
        await this.native('close', pageId).catch(() => {});
        this.pages.delete(pageId);
        throw Error('Browser connection changed');
      }
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
      try {
        while (this.attached && this.activeConnection()) {
          try {
            const { command } = await this.control<{ command: RendererCommand | null }>({
              action: 'rendererNext', rendererId: this.rendererId,
            });
            failures = 0;
            if (command) {
              void this.executeAndReply(command);
            }
          } catch (error) {
            if ((error as { code?: string })?.code === 'BROWSER_FORBIDDEN') {
              await this.closeGuests();
              break;
            }
            if (++failures >= 8) {
              await Promise.allSettled([...this.pages.keys()].map(id => this.hide(id)));
              break;
            }
            await new Promise(resolve => window.setTimeout(resolve, 800));
          }
        }
      } finally {
        this.polling = false;
        if (!this.activeConnection()) {
          await this.closeGuests();
          if (this.sessions.get(this.key) === this) this.sessions.delete(this.key);
        }
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
    return this.control<NativeResult>(input);
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
