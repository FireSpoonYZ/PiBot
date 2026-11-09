// gbot-ui lane：通用会话行（主语义 button，不嵌套按钮）。
// JSX 结构复制自 lenML/gbot-ui（MIT，仓库 licenses/gbot-ui-MIT.txt）：
// 上游 src/components/grok-bot/MobileChatList.tsx 的 ConversationRow 默认实现
// （title/preview 两行结构、选中/未读/时间槽位、pointer hook 展开到 button）。
// 差异：agent 模型替换为合同 props；Tailwind utility 由 gbot-ui.css 中同名结构类替代。
import type { ReactNode } from 'react';
import { useConversationRowInteractions } from './useConversationRowInteractions';
import type { ConversationMenuPosition } from './useConversationRowInteractions';

export interface ConversationRowProps {
  title: string;
  preview?: string;
  timestamp?: string | number | null;
  avatar: ReactNode;
  groupLabel?: string;
  connectionLabel?: string;
  selected?: boolean;
  unread?: boolean;
  pinned?: boolean;
  onOpen: () => void;
  onOpenMenu?: (position: ConversationMenuPosition) => void;
  className?: string;
}

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** 上游 formatAgentTime：今天时:分，昨天 "昨天"，7 天内星期，其余 月/日（跨年带年）。 */
function formatConversationTime(timestamp: string | number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '';
  const ms = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const now = new Date();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days <= 0) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (days === 1) return '昨天';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], {
    month: 'numeric',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear()
      ? {}
      : { year: '2-digit' as const }),
  });
}

const cn = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function ConversationRow({
  title,
  preview,
  timestamp,
  avatar,
  groupLabel,
  connectionLabel,
  selected = false,
  unread = false,
  pinned = false,
  onOpen,
  onOpenMenu,
  className,
}: ConversationRowProps) {
  const interactions = useConversationRowInteractions({ onOpen, onOpenMenu });
  const label = [title, groupLabel, pinned ? '已置顶' : null, unread ? '未读' : null, connectionLabel]
    .filter(Boolean)
    .join('，');
  const time = formatConversationTime(timestamp);
  const subtitle = preview?.trim();

  return (
    <button
      aria-current={selected ? 'page' : undefined}
      aria-haspopup={onOpenMenu ? 'menu' : undefined}
      aria-label={label}
      className={cn(
        'baby-grok-bot-conversation-row gbot-conversation-row',
        className,
      )}
      data-active={selected || undefined}
      data-pinned={pinned || undefined}
      data-unread={unread || undefined}
      {...interactions}
      type="button"
    >
      <span className="gbot-conversation-row__avatar">{avatar}</span>

      <span className="gbot-conversation-row__body">
        <span className="gbot-conversation-row__head">
          <span className="gbot-conversation-row__title">{title}</span>
          {unread ? (
            <span aria-hidden="true" className="gbot-conversation-row__unread-dot" />
          ) : null}
          {time ? <span className="gbot-conversation-row__time">{time}</span> : null}
        </span>
        {subtitle ? (
          <span className="gbot-conversation-row__preview">{subtitle}</span>
        ) : null}
      </span>
    </button>
  );
}
