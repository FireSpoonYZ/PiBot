// Bot 头像由中心保存，本地缓存只用于展示。
import { useEffect, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import {
  GROK_COLOR_PALETTE,
  GROK_EXPRESSION_LIST,
  GROK_SHAPE_ORDER,
  GrokBotAvatar,
  getDefaultBotAvatarPreset,
  resolveBotAvatarPreset,
  type GrokAvatarPreset,
} from '../../../web/src/GrokBotAvatar';
import { saveCentralBotAvatar } from '../../../web/src/botAvatarSync';
import { ErrorNotice, useAction, useText } from '../../../web/src/ui';
import type { DesktopPanelApi } from './types';

export function BotAvatarStudio({
  api,
  deviceId,
  botId,
  botKey,
  roleName,
  isPrimary,
  onChanged,
}: {
  api: DesktopPanelApi;
  deviceId: string;
  botId: string;
  botKey: string;
  roleName?: string;
  isPrimary?: boolean;
  /** 持久化后回调（供外层 bump avatarVersion，刷新其它 avatar 实例）。 */
  onChanged?: () => void;
}) {
  const t = useText();
  const [draft, setDraft] = useState<GrokAvatarPreset>(() =>
    resolveBotAvatarPreset(botKey, roleName, isPrimary),
  );
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const action = useAction();

  useEffect(() => {
    setDraft(resolveBotAvatarPreset(botKey, roleName, isPrimary));
    setDirty(false);
    setEditing(false);
  }, [botKey, roleName, isPrimary]);

  function persist(value: GrokAvatarPreset | null) {
    void action.run(async () => {
      await saveCentralBotAvatar(api, { deviceId, botId }, value);
      setDraft(value ?? { ...getDefaultBotAvatarPreset(botKey, roleName, isPrimary) });
      setDirty(false);
      onChanged?.();
    });
  }

  return (
    <div className="bot-avatar-studio">
      <button
        className="bot-avatar-studio-trigger"
        type="button"
        aria-expanded={editing}
        onClick={() => setEditing(value => !value)}
      >
        <GrokBotAvatar preset={draft} size={40} isPrimary={isPrimary} starBadge={isPrimary} />
        <span className="bot-avatar-studio-trigger-text">
          <span>{editing ? t('收起头像编辑', 'Hide avatar editor') : t('编辑头像', 'Edit avatar')}</span>
          {dirty ? <small className="bot-avatar-studio-dirty">{t('未保存', 'Unsaved')}</small> : null}
        </span>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={`bot-avatar-studio-chevron${editing ? ' is-open' : ''}`}
        />
      </button>

      {editing ? (
        <div className="bot-avatar-studio-body">
          <div className="avatar-studio-section-title">{t('形状', 'Shape')}</div>
          <div className="avatar-shape-grid" role="group" aria-label={t('形状', 'Shape')}>
            {GROK_SHAPE_ORDER.map((item) => {
              const selected = draft.shape === item.shape;
              const label = t(item.labelZh, item.labelEn);
              return (
                <button
                  key={item.shape}
                  type="button"
                  className={`avatar-shape-cell${selected ? ' selected' : ''}`}
                  title={label}
                  aria-label={t(`形状：${label}`, `Shape: ${label}`)}
                  aria-pressed={selected}
                  disabled={action.busy}
                  onClick={() => {
                    setDirty(true);
                    setDraft((prev) => ({
                      ...prev,
                      id: `${item.shape}-${prev.color}`,
                      shape: item.shape,
                      rotation: item.rotation,
                    }));
                  }}
                >
                  <GrokBotAvatar
                    preset={{ ...draft, shape: item.shape, rotation: item.rotation }}
                    size={40}
                  />
                </button>
              );
            })}
          </div>

          <div className="avatar-studio-section-title">{t('表情', 'Expression')}</div>
          <div className="avatar-expression-grid" role="group" aria-label={t('表情', 'Expression')}>
            {GROK_EXPRESSION_LIST.map((expr) => {
              const selected = draft.expressionIndex === expr.index;
              const label = t(expr.labelZh, expr.labelEn);
              return (
                <button
                  key={expr.index}
                  type="button"
                  className={`avatar-expression-cell${selected ? ' selected' : ''}`}
                  title={label}
                  aria-label={t(`表情：${label}`, `Expression: ${label}`)}
                  aria-pressed={selected}
                  disabled={action.busy}
                  onClick={() => {
                    setDirty(true);
                    setDraft((prev) => ({ ...prev, expressionIndex: expr.index }));
                  }}
                >
                  <GrokBotAvatar
                    preset={{ ...draft, expressionIndex: expr.index }}
                    size={46}
                  />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <div className="avatar-studio-section-title">{t('颜色', 'Color')}</div>
          <div className="avatar-color-grid" role="group" aria-label={t('颜色', 'Color')}>
            {GROK_COLOR_PALETTE.map((c) => {
              const selected = draft.color.toLowerCase() === c.hex.toLowerCase();
              const label = t(c.labelZh, c.labelEn);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`avatar-color-swatch${selected ? ' selected' : ''}`}
                  title={label}
                  aria-label={t(`颜色：${label}`, `Color: ${label}`)}
                  aria-pressed={selected}
                  disabled={action.busy}
                  onClick={() => {
                    setDirty(true);
                    setDraft((prev) => ({ ...prev, id: `${prev.shape}-${c.id}`, color: c.hex }));
                  }}
                >
                  <span style={{ backgroundColor: c.hex }} />
                </button>
              );
            })}
          </div>

          <div className="avatar-studio-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={action.busy}
              onClick={() => persist(null)}
              title={t('放弃自定义并恢复该 Bot 的默认头像', 'Discard customizations and restore the default avatar')}
            >
              <RotateCcw size={14} aria-hidden="true" /> {t('恢复默认', 'Reset default')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || action.busy}
              onClick={() => persist(draft)}
              title={t('保存到中心并同步到其他客户端', 'Save to Center and sync to your other clients')}
            >
              {action.busy
                ? t('保存中…', 'Saving…')
                : dirty
                  ? t('保存形象', 'Save avatar')
                  : t('已保存', 'Saved')}
            </button>
          </div>
          <p className="avatar-studio-hint">
            {t('保存后会同步到其他客户端。', 'Changes sync to your other clients once saved.')}
          </p>
        </div>
      ) : null}
      <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
    </div>
  );
}
