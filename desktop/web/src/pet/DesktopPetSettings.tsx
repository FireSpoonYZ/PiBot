import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useText } from '../../../../web/src/ui';
import { PET_EVENTS, type DesktopPetWindowState } from './protocol';
import { petWindow } from './windowApi';

export function DesktopPetSettings() {
  const t = useText();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisten = listen<DesktopPetWindowState>(PET_EVENTS.window, ({ payload }) => {
      if (!disposed) setVisible(payload.visible);
    });
    void petWindow('status').then((state) => {
      if (!disposed) setVisible(state.visible);
    }).catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { disposed = true; void unlisten.then((stop) => stop()); };
  }, []);
  if (!isTauri()) return null;
  return (
    <section className="settings-section">
      <h4>{t('悬浮桌宠', 'Desktop pet')}</h4>
      <div className="settings-row">
        <span className="settings-row-label">
          <span>{t('本机 main bot', 'This computer’s main bot')}</span>
          <span className="metadata" style={{ display: 'block' }}>
            {t('点击头像对话，拖动头像移动位置；语音可在桌宠中设置。', 'Click to chat, drag to move. Configure voice from the pet.')}
          </span>
        </span>
        <button type="button" onClick={() => {
          setError('');
          void petWindow('toggle').then((state) => setVisible(state.visible))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}>
          {visible ? t('收起桌宠', 'Hide pet') : t('显示桌宠', 'Show pet')}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
