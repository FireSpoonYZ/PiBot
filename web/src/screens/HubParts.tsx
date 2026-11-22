import type { ReactNode } from 'react';
import { useConversationRowInteractions } from '../gbot-ui';
import { GrokBotAvatar, type GrokAvatarPreset } from '../GrokBotAvatar';
import { PlatformLogoIcon, type UnifiedBotItem } from '../hub/shared';

/** 主 Bot hero：复用上游长按/右键/键盘行交互 hook（顶层调用，非 map 内）。 */
export function HubPrimaryHero({
  bot,
  preset,
  offline,
  label,
  onOpen,
  onOpenMenu,
}: {
  bot: UnifiedBotItem;
  preset: GrokAvatarPreset;
  offline: boolean;
  label: string;
  onOpen: () => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  const interactions = useConversationRowInteractions({ onOpen, onOpenMenu });
  return (
    <button
      type="button"
      className="hub-hero-button hub-hero-card"
      aria-label={label}
      {...interactions}
    >
      <GrokBotAvatar
        preset={preset}
        offline={offline}
        isPrimary
        starBadge
        platformBadge={<PlatformLogoIcon platform={bot.platform} size={11} />}
        size={64}
      />
      <div className="hub-hero-card-text">
        <span className="hub-hero-name" title={bot.role}>{bot.role}</span>
        <span className="hub-bot-host-badge local" title={bot.hostLabel}>
          <PlatformLogoIcon platform={bot.platform} size={12} />
          <span className="hub-bot-host-text">{bot.hostLabel}</span>
        </span>
      </div>
    </button>
  );
}

/** 归档 Bot 行：div + 上游 hook 交互；内部操作按钮不触发长按菜单，也不进入聊天。 */
export function HubArchivedRow({
  onOpen,
  onOpenMenu,
  className = '',
  children,
}: {
  onOpen: () => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
  className?: string;
  children: ReactNode;
}) {
  const interactions = useConversationRowInteractions({ onOpen, onOpenMenu });
  // 共享 hook 已忽略嵌套控件起点；move/up/leave 无条件转发，否则按下行文本、
  // 抬起在内按钮时会残留计时器。仅重写 Enter/Space 打开行为。
  return (
    <div
      className={`hub-bot-row is-archived${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      {...interactions}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
          return;
        }
        interactions.onKeyDown(e);
      }}
    >
      {children}
    </div>
  );
}
