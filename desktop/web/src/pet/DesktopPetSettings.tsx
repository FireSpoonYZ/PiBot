import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Switch } from '../../../../web/src/bot-settings/primitives';
import { useText } from '../../../../web/src/ui';
import {
  PET_EVENTS,
  type DesktopPetKdeRuleAction,
  type DesktopPetKdeRuleStatus,
  type DesktopPetWindowState,
} from './protocol';
import { petKdeRule, petWindow } from './windowApi';

export function DesktopPetSettings() {
  const t = useText();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kdeRule, setKdeRule] = useState<DesktopPetKdeRuleStatus | null>(null);
  const [kdeBusy, setKdeBusy] = useState(false);
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
    void petKdeRule('status').then((status) => {
      if (!disposed) setKdeRule(status);
    }).catch(() => {
      // Ignore on environments where KDE window rule management is unavailable.
    });
    return () => { disposed = true; void unlisten.then((stop) => stop()); };
  }, []);

  if (!isTauri()) return null;

  const title = t('显示本机主助手桌宠', "Show this computer's main bot pet");

  const runKdeRuleAction = (action: Exclude<DesktopPetKdeRuleAction, 'status'>) => {
    if (kdeBusy) return;
    setKdeBusy(true);
    setError('');
    void petKdeRule(action)
      .then((status) => setKdeRule(status))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setKdeBusy(false));
  };

  const kdeDescription = (() => {
    if (!kdeRule?.supported) return '';
    if (kdeRule.externallyManaged) {
      return t(
        'kwinrulesrc 为外部管理的符号链接，未自动修改。请手动导入 /usr/share/pibot/desktop-pet.kwinrule 或将其加入声明式配置。',
        'kwinrulesrc is an externally managed symlink and was not modified. Import /usr/share/pibot/desktop-pet.kwinrule manually or add it to your declarative config.',
      );
    }
    if (kdeRule.installed && kdeRule.upToDate) {
      if (kdeRule.reconfigured === false) {
        return t(
          '规则已写入，但未能通过 D-Bus 立即通知 KWin。若未生效，请重新打开桌宠或重新登录会话。',
          'Rule saved, but KWin could not be notified over D-Bus. Reopen the pet or log back in if it has not taken effect.',
        );
      }
      return t(
        '已生效：KWin 会保持桌宠置顶并从任务栏、分页器与窗口切换器隐藏（覆盖 Wayland 与 X11）。',
        'Active: KWin keeps the pet above other windows and hidden from the taskbar, pager, and switcher (Wayland & X11).',
      );
    }
    if (kdeRule.installed) {
      return t(
        '检测到旧版或自定义桌宠规则，可点击「重新应用」补全置顶与任务栏/切换器隐藏配置。',
        'An older or custom pet rule was detected. Click Reapply to update keep-above and taskbar/switcher hiding.',
      );
    }
    return t(
      '未配置：在 KDE Plasma（尤其是原生 Wayland）下需要 KWin 规则来保持桌宠置顶并隐藏任务栏图标。',
      'Not configured: KDE Plasma (especially native Wayland) needs a KWin rule to keep the pet above other windows and hidden from the taskbar.',
    );
  })();

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
                .then((state) => {
                  setVisible(state.visible);
                  if (next && kdeRule?.supported) {
                    void petKdeRule('status').then(setKdeRule).catch(() => {});
                  }
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          />
        </label>
        {kdeRule?.supported && (
          <div className="settings-row" style={{ flexWrap: 'wrap', paddingBlock: 'var(--space-3)' }}>
            <span className="settings-row-label">
              <span>{t('KDE 窗口规则', 'KDE window rule')}</span>
              <span className="metadata" style={{ display: 'block' }}>
                {kdeDescription}
              </span>
            </span>
            {!kdeRule.externallyManaged && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', flexShrink: 0 }}>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={kdeBusy}
                  onClick={() => runKdeRuleAction('apply')}
                >
                  {kdeBusy
                    ? t('处理中…', 'Working…')
                    : kdeRule.installed
                      ? t('重新应用', 'Reapply')
                      : t('应用规则', 'Apply rule')}
                </button>
                {kdeRule.installed && (
                  <button
                    type="button"
                    className="secondary-button danger-outline"
                    disabled={kdeBusy}
                    onClick={() => runKdeRuleAction('remove')}
                  >
                    {t('移除规则', 'Remove rule')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {error && <p className="inline-notice inline-notice-danger" role="alert">{error}</p>}
    </section>
  );
}
