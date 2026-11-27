// Module 17 desktop 入口：装配 App，加载样式；错误以可见状态呈现，不写原始日志。
import { createRoot } from 'react-dom/client';
import { createDesktopClient } from './api';
import { startDesktopPetHost } from './pet/host';
import './app.css';
import { DesktopApp } from './App';
import { NoticeProvider } from '../../../web/src/notice';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
const api = createDesktopClient();
let openBotHandler: ((deviceId: string, botId: string) => void) | null = null;
let pendingOpenBot: { deviceId: string; botId: string } | null = null;
const registerOpenBot = (handler: ((deviceId: string, botId: string) => void) | null): void => {
  openBotHandler = handler;
  if (handler && pendingOpenBot) {
    const queued = pendingOpenBot;
    pendingOpenBot = null;
    handler(queued.deviceId, queued.botId);
  }
};
void startDesktopPetHost(api, {
  onOpenBot: (deviceId, botId) => {
    if (openBotHandler) {
      openBotHandler(deviceId, botId);
    } else {
      pendingOpenBot = { deviceId, botId };
    }
  },
}).then((stop) => {
  window.addEventListener('beforeunload', stop, { once: true });
}).catch((error: unknown) => api.reportError(error));
createRoot(container).render(
  <NoticeProvider>
    <DesktopApp api={api} onRegisterOpenBot={registerOpenBot} />
  </NoticeProvider>,
);
