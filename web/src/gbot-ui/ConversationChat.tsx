// gbot-ui lane：scope 内容页聊天表面（普通聊天，非调试卡片）。
// JSX/逻辑复制自 lenML/gbot-ui（MIT，仓库 licenses/gbot-ui-MIT.txt）：
//   GrokBotTranscript.tsx 的 MessageOriginHeader / MessageView / 45 分钟时间分隔、
//   MobileChat.tsx 的浮动头部结构（返回 + 中间标题 pill + 右侧槽位）。
// 差异：删除 store/slots/附件/reaction/上下文菜单/卡片分派；气泡皮肤映射本仓库
// bot-chat-bubble 变量；正文用宿主 Markdown；复制用 navigator.clipboard。
// 名字一律用 BotRecord.role / 用户自然名，任何技术 ID 不出现在可视/aria/title。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  BotRecord,
  MessageMember,
  MessageScope,
  StoredMessage,
} from '../../../host-core/index.js';
import { Markdown } from '../Markdown';
import { useText } from '../ui';
import './conversation-chat.css';

/** 名字目录条目：deviceId + botId 定位成员，role 是唯一可视身份。 */
export type ConversationBot = Pick<
  BotRecord,
  'deviceId' | 'botId' | 'role' | 'isPrimary'
>;

const TIMESTAMP_GAP_MS = 45 * 60 * 1000;

const cn = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

function findBot(
  member: MessageMember,
  bots: readonly ConversationBot[],
): ConversationBot | undefined {
  return bots.find(
    (b) => b.deviceId === member.deviceId && b.botId === member.botId,
  );
}

/** 成员可视名：目录命中用 role（空 role 记作未命名），目录缺失记作已移除；不回退 ID。 */
export function conversationMemberName(
  member: MessageMember,
  bots: readonly ConversationBot[],
): string {
  const bot = findBot(member, bots);
  if (!bot) return '已移除的 Bot';
  return bot.role.trim() || '未命名 Bot';
}

/**
 * 会话标题：room 与 DM 都是成员名字并列（scope DM 两端都是 Bot，不含用户）；
 * 无群聊/私聊前缀或 ID。成员全部缺席目录（含 0 成员）时无名字可拼，
 * 回退会话类型自然名，避免重复多遍「已移除的 Bot」。
 */
export function conversationTitle(
  scope: MessageScope,
  bots: readonly ConversationBot[],
): string {
  const allUnknown = scope.members.every((m) => !findBot(m, bots));
  if (scope.members.length === 0 || allUnknown) {
    return scope.kind === 'room' ? '群聊' : '私聊';
  }
  return scope.members
    .map((m) => conversationMemberName(m, bots))
    .join('、');
}

export interface ConversationChatHeaderProps {
  title: string;
  subtitle?: string;
  avatar: ReactNode;
  onBack?: () => void;
  /** 只读徽标（DM/本机只读 room）。 */
  readOnly?: boolean;
  onShowMembers?: () => void;
}

export function ConversationChatHeader({
  title,
  subtitle,
  avatar,
  onBack,
  readOnly = false,
  onShowMembers,
}: ConversationChatHeaderProps) {
  const t = useText();
  return (
    <header className="conversation-chat-header">
      {onBack ? (
        <button
          aria-label={t('返回', 'Back')}
          className="conversation-chat-header__circle"
          onClick={onBack}
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 16 16" width="18">
            <path
              d="m9.75 3.25-4.5 4.75 4.5 4.75"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
          </svg>
        </button>
      ) : (
        <span aria-hidden="true" className="conversation-chat-header__spacer" />
      )}

      <div className="conversation-chat-header__pill">
        <span className="conversation-chat-header__avatar">{avatar}</span>
        <span className="conversation-chat-header__text">
          <span className="conversation-chat-header__title" title={title}>
            {title}
          </span>
          {subtitle ? (
            <span className="conversation-chat-header__subtitle">{subtitle}</span>
          ) : null}
        </span>
        {readOnly ? (
          <span className="conversation-chat-header__readonly">
            {t('只读', 'Read only')}
          </span>
        ) : null}
      </div>

      {onShowMembers ? (
        <button
          aria-label={t('查看成员', 'View members')}
          className="conversation-chat-header__circle"
          onClick={onShowMembers}
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 16 16" width="17">
            <circle cx="5.5" cy="5.25" r="2.25" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M1.75 13.25c.5-2 2-3 3.75-3s3.25 1 3.75 3"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.3"
            />
            <circle cx="11.25" cy="6" r="1.75" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M10.4 10.4c2.6-.2 3.9.8 4.15 2.85"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      ) : (
        <span aria-hidden="true" className="conversation-chat-header__spacer" />
      )}
    </header>
  );
}

export interface ConversationMessageProps {
  message: StoredMessage;
  /** 作者可视名（调用方用 conversationMemberName / 用户名解析）。 */
  authorName: string;
  replyQuote?: { author: string; text: string } | null;
  /** 不存在就不渲染回复动作。 */
  onReply?: () => void;
  onOpenLink?: (href: string) => void | Promise<unknown>;
}

export function ConversationMessage({
  message,
  authorName,
  replyQuote,
  onReply,
  onOpenLink,
}: ConversationMessageProps) {
  const t = useText();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timeout = window.setTimeout(() => setCopyState('idle'), 1_400);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const envelope = message.message;
  const isUser = envelope.author.kind === 'user';
  const text = envelope.text;
  const showBubble = text.trim().length > 0;

  const copy = () => {
    if (!navigator.clipboard || !text) {
      setCopyState('error');
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopyState('copied'))
      .catch(() => setCopyState('error'));
  };

  const copyLabel =
    copyState === 'copied'
      ? t('已复制', 'Copied')
      : copyState === 'error'
        ? t('复制失败', 'Copy failed')
        : t('复制', 'Copy');

  return (
    <div
      className={cn(
        'conversation-chat-message',
        isUser && 'conversation-chat-message--user',
      )}
      data-side={isUser ? 'user' : 'agent'}
    >
      <div className="conversation-chat-message__origin">
        <span className="conversation-chat-message__name">{authorName}</span>
        <span className="conversation-chat-message__badge">
          {isUser ? t('用户', 'You') : 'Bot'}
        </span>
      </div>
      <div className="conversation-chat-message__body">
        {replyQuote ? (
          <blockquote
            className="conversation-chat-message__quote"
            title={replyQuote.text}
          >
            <span className="conversation-chat-message__quote-author">
              {replyQuote.author}
            </span>
            <span className="conversation-chat-message__quote-text">
              {replyQuote.text}
            </span>
          </blockquote>
        ) : null}
        {showBubble ? (
          <div className="conversation-chat-message__bubble">
            <Markdown onOpenLink={onOpenLink} text={text} />
          </div>
        ) : null}
        {showBubble ? (
          <div className="conversation-chat-message__actions">
            <button
              aria-label={copyLabel}
              className="conversation-chat-message__action"
              data-copied={copyState === 'copied' || undefined}
              onClick={copy}
              type="button"
            >
              <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 16 16" width="13">
                {copyState === 'copied' ? (
                  <path
                    d="m3.5 8.25 2.5 2.5 6-6"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.4"
                  />
                ) : (
                  <>
                    <rect
                      height="8"
                      rx="1.5"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      width="8"
                      x="3.5"
                      y="4.5"
                    />
                    <path
                      d="M6 4.5V3.25A1.25 1.25 0 0 1 7.25 2h5A1.25 1.25 0 0 1 13.5 3.25v5A1.25 1.25 0 0 1 12.25 9.5H11.5"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="1.2"
                    />
                  </>
                )}
              </svg>
              <span>{copyLabel}</span>
            </button>
            {onReply ? (
              <button
                aria-label={t('回复', 'Reply')}
                className="conversation-chat-message__action"
                onClick={onReply}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 16 16" width="13">
                  <path
                    d="M6.5 3.5 2.75 7.25l3.75 3.75M3.25 7.25h6.5a3.5 3.5 0 0 1 3.5 3.5v1.75"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.3"
                  />
                </svg>
                <span>{t('回复', 'Reply')}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** 上游 formatTranscriptTimestamp：当天时刻、昨天、7 天内星期、其余月日。 */
function formatDividerTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  const time = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (days <= 0) return time;
  if (days === 1) return '昨天 ' + time;
  if (days < 7) {
    return date.toLocaleDateString([], { weekday: 'long' }) + ' ' + time;
  }
  return (
    date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
  );
}

export interface ConversationTimeDividerProps {
  at: string;
  previousAt?: string | null;
}

/** 上游 shouldShowTimestamp：本消息与前一条间隔 >=45min（或前条无有效时间）时居中分隔。 */
export function ConversationTimeDivider({
  at,
  previousAt,
}: ConversationTimeDividerProps) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (previousAt) {
    const prevMs = Date.parse(previousAt);
    if (Number.isFinite(prevMs) && prevMs > 0 && ms - prevMs < TIMESTAMP_GAP_MS) {
      return null;
    }
  }
  return (
    <div className="conversation-chat-time" role="separator">
      {formatDividerTime(ms)}
    </div>
  );
}
