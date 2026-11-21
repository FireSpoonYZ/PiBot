import type { BrowserLiveTarget } from '../../../host-core/index';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';

export type SubscribeBrowserFrames = (
  target: Pick<BrowserLiveTarget, 'pageId' | 'sessionId' | 'lease'>,
  handlers: { onFrame: (frame: unknown) => void; onError: (error: unknown) => void },
) => () => void;

export function createBrowserFrameSubscriber(
  api: DesktopPanelApi | undefined,
  identity: DesktopIdentity | null | undefined,
  botId: string | undefined,
): SubscribeBrowserFrames | undefined {
  if (!api || !identity || !botId) return;

  return (target, { onFrame, onError }) => {
    let closed = false;
    const handle = api.observe(identity, { kind: 'browser', botId, ...target }, (event) => {
      if (closed) return;
      if ('error' in event) onError(event.error);
      else if (event.frame.type === 'browser-frame') onFrame(event.frame.frame);
      else if (event.frame.type === 'end') onError({ code: 'DISCONNECTED' });
    });
    void handle.ready.catch((error) => { if (!closed) onError(error); });
    return () => {
      if (closed) return;
      closed = true;
      void handle.close();
    };
  };
}
