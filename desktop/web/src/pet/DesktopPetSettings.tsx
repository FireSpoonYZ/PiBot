import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Switch } from '../../../../web/src/bot-settings/primitives';
import { useText } from '../../../../web/src/ui';
import { PET_EVENTS, type DesktopPetWindowState } from './protocol';
import { petWindow } from './windowApi';

export function DesktopPetSettings() {
  const t = useText();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const title = t('显示本机主助手桌宠', "Show this computer's main bot pet");

  return (
    <section className="settings-section">
      <h4>{t('悬浮桌宠', 'Desktop pet')}</h4>
      <div className="settings-row-group">
        <label className="settings-row settings-row-link">
          <span className="settings-row-label">
            <span>{title}</span>
            <span className="metadata" style={{ display: 'block' }}>
              {t('单击唤出输入胶囊，拖动移动，右键打开快捷菜单；回复与问卷以气泡呈现。', 'Click for quick prompt, drag to move, right-click for menu. Replies and questionnaires appear as bubbles.')}
            </span>
          </span>
          <Switch
            label={title}
            checked={visible}
            disabled={busy}
            onChange={(next) => {
              if (busy) return;
              setBusy(true);
              setError('');
              void petWindow(next ? 'show' : 'hide')
                .then((state) => setVisible(state.visible))
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          />
        </label>
      </div>
      {error && <p className="inline-notice inline-notice-danger" role="alert">{error}</p>}
    </section>
  );
}
