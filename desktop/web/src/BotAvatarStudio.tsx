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
import { ActionBar, useDirtyForm } from '../../../web/src/components/ui';
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

  useDirtyForm(dirty);

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
    <div
      className="avatar-studio"
      style={{
        padding: '0 0 var(--space-3)',
        border: 0,
        borderBottom: '1px solid var(--line-subtle)',
        borderRadius: 0,
        background: 'transparent',
      }}
    >
      <button
        className="avatar-studio-trigger"
        type="button"
        aria-expanded={editing}
        onClick={() => setEditing(value => !value)}
        style={{
          width: '100%',
          justifyContent: 'space-between',
          padding: '6px 4px',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <GrokBotAvatar preset={draft} size={40} isPrimary={isPrimary} starBadge={isPrimary} />
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 0 }}>
            <strong style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text)' }}>智能体形象</strong>
            <span className="metadata" style={{ fontSize: 12 }}>
              {editing ? '点击收起形状、表情与配色' : '自定义形状、表情与配色'}
            </span>
          </span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {dirty ? (
            <span
              role="status"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '1px 8px',
                borderRadius: 'var(--radius-full)',
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                color: 'var(--warn)',
                background: 'var(--warn-soft)',
                border: '1px solid var(--warn-line)',
                whiteSpace: 'nowrap',
              }}
            >
              未保存
            </span>
          ) : null}
          <span className="metadata" style={{ whiteSpace: 'nowrap' }}>
            {editing ? '收起' : '编辑头像'}
          </span>
          <ChevronDown
            size={15}
            aria-hidden="true"
            style={{
              color: 'var(--muted)',
              transition: 'transform var(--dur-fast) var(--ease-out)',
              transform: editing ? 'rotate(180deg)' : undefined,
            }}
          />
        </span>
      </button>

      {editing ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 'var(--space-2)',
            borderTop: '1px solid var(--line-subtle)',
          }}
        >
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

          <ActionBar
            align="between"
            className="avatar-studio-actions"
            style={{
              flexWrap: 'nowrap',
              paddingTop: 'var(--space-2)',
              borderTop: '1px solid var(--line-subtle)',
            }}
          >
            <button
              type="button"
              className="secondary-button"
              disabled={action.busy}
              onClick={() => persist(null)}
              title="放弃自定义并恢复该智能体的默认头像"
            >
              <RotateCcw size={14} aria-hidden="true" />
              恢复默认
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || action.busy}
              onClick={() => persist(draft)}
              title="保存到中心并同步到其他客户端"
            >
              {action.busy ? '保存中…' : '保存形象'}
            </button>
          </ActionBar>
          <p className="avatar-studio-hint">保存后会同步到其他客户端。</p>
        </div>
      ) : null}
      <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
    </div>
  );
}
