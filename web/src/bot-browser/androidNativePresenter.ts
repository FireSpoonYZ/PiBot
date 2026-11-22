import type { NativeBrowserPresenter } from './nativePresentation';

type NativeRequest = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
type NativeStatus = { supported?: boolean; sessionId?: number; phase?: string };
type AttachedPage = { pageId: string; grantId: string; sessionId: number };

// Kotlin owns one overlay per Activity. Serialize across Bot adapters as well as within a page.
let overlayQueue: Promise<unknown> = Promise.resolve();
function withOverlay<T>(operation: () => Promise<T>): Promise<T> {
  const result = overlayQueue.then(operation, operation);
  overlayQueue = result.catch(() => undefined);
  return result;
}

export function createAndroidNativePresenter(
  botId: string,
  request: NativeRequest,
  isCurrentBot: () => boolean,
): NativeBrowserPresenter & { clear(): Promise<void> } {
  let generation = 0;
  let desired: { pageId: string; grantId: string } | null = null;
  let attached: AttachedPage | null = null;

  async function close(page: AttachedPage | null): Promise<void> {
    if (!page) return;
    if (attached === page) attached = null;
    await request('browserNativeClose', { sessionId: page.sessionId }).catch(() => undefined);
  }

  function clear(): Promise<void> {
    generation++;
    desired = null;
    return withOverlay(async () => { await close(attached); });
  }

  return {
    clear,
    async present(input) {
      if (!isCurrentBot() || input.expiresAt <= Date.now()) return false;
      if (desired?.pageId !== input.pageId || desired.grantId !== input.grantId) {
        generation++;
        desired = { pageId: input.pageId, grantId: input.grantId };
      }
      const operationGeneration = generation;
      const current = () => generation === operationGeneration && isCurrentBot();
      return withOverlay(async () => {
        if (!current()) return false;
        let page = attached;
        try {
          if (page && (page.pageId !== input.pageId || page.grantId !== input.grantId)) {
            await close(page);
            page = null;
          }
          if (!current()) return false;
          let state: NativeStatus;
          if (!page) {
            state = await request<NativeStatus>('browserNativeOpen', {
              botId, pageId: input.pageId, grantId: input.grantId,
              rect: input.rect, dpr: input.dpr, visible: true,
            });
            if (!state.supported || !Number.isSafeInteger(state.sessionId) || state.sessionId! <= 0) return false;
            page = { pageId: input.pageId, grantId: input.grantId, sessionId: state.sessionId! };
            attached = page;
          } else {
            state = await request<NativeStatus>('browserNativeLayout', {
              sessionId: page.sessionId, rect: input.rect, dpr: input.dpr, visible: true,
            });
          }
          const deadline = Math.min(input.expiresAt, Date.now() + 3500);
          while (current() && Date.now() < deadline) {
            if (state.sessionId !== page.sessionId || state.phase === 'error' || state.phase === 'idle') break;
            if (state.phase === 'ready') return true;
            if (state.phase !== 'connecting') break;
            await new Promise<void>(resolve => setTimeout(resolve, 50));
            if (!current()) break;
            state = await request<NativeStatus>('browserNativeStatus', { sessionId: page.sessionId });
          }
        } catch {
          // Native capability/attachment failure keeps the panel on its server-stream path.
        }
        await close(page);
        return false;
      });
    },
    hide(pageId) {
      // A late old-page cleanup must not close a new page opened by the same adapter.
      if (desired?.pageId !== pageId && attached?.pageId !== pageId) return Promise.resolve();
      if (desired?.pageId === pageId) {
        generation++;
        desired = null;
      }
      return withOverlay(async () => {
        if (attached?.pageId === pageId) await close(attached);
      });
    },
  };
}
