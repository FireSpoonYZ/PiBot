// Bot 头像由中心保存，本地缓存只用于展示。
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
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
import { ErrorNotice, useAction } from '../../../web/src/ui';
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
    <div className="avatar-studio">
      <button className="avatar-studio-trigger" type="button" aria-expanded={editing} onClick={() => setEditing(value => !value)}>
        <GrokBotAvatar preset={draft} size={40} isPrimary={isPrimary} starBadge={isPrimary} />
        <span>{editing ? '收起头像编辑' : '编辑头像'}</span>
        {dirty ? <small>未保存</small> : null}
      </button>
      {editing ? (
        <>
          <div className="avatar-studio-section-title">形状</div>
          <div className="avatar-shape-grid" role="group" aria-label="形状">
            {GROK_SHAPE_ORDER.map((item) => {
              const selected = draft.shape === item.shape;
              return (
                <button
                  key={item.shape}
                  type="button"
                  className={`avatar-shape-cell${selected ? ' selected' : ''}`}
                  title={item.labelZh}
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

          <div className="avatar-studio-section-title">表情</div>
          <div className="avatar-expression-grid" role="group" aria-label="表情">
            {GROK_EXPRESSION_LIST.map((expr) => {
              const selected = draft.expressionIndex === expr.index;
              return (
                <button
                  key={expr.index}
                  type="button"
                  className={`avatar-expression-cell${selected ? ' selected' : ''}`}
                  title={expr.labelZh}
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
                  <span>{expr.labelZh}</span>
                </button>
              );
            })}
          </div>

          <div className="avatar-studio-section-title">颜色</div>
          <div className="avatar-color-grid" role="group" aria-label="颜色">
            {GROK_COLOR_PALETTE.map((c) => {
              const selected = draft.color.toLowerCase() === c.hex.toLowerCase();
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`avatar-color-swatch${selected ? ' selected' : ''}`}
                  title={c.labelZh}
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
              title="放弃自定义并恢复该 Bot 的默认头像"
            >
              <RotateCcw size={14} /> 恢复默认
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || action.busy}
              onClick={() => persist(draft)}
              title="保存到中心并同步到其他客户端"
            >
              {action.busy ? '保存中…' : dirty ? '保存形象' : '已保存'}
            </button>
          </div>
          <p className="avatar-studio-hint">保存后会同步到其他客户端。</p>
        </>
      ) : null}
      <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
    </div>
  );
}
