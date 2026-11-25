import { useId, useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from 'lucide-react';
import { isBotDmSendToTool, isBotDmTurn, type ChatTurn } from './chatTurnModel';
import './bot-dm-card.css';

export interface BotDmFoldCardProps {
  direction: 'incoming' | 'outgoing';
  peerLabel: string;
  tag?: string;
  preview?: string;
  meta?: string;
  status?: 'idle' | 'running' | 'error';
  silent?: boolean;
  /** Used inside an assistant turn (e.g. outbound send_to) so width fills the turn column cleanly. */
  inline?: boolean;
  defaultCollapsed: boolean;
  forceExpand?: boolean;
  className?: string;
  children: ReactNode;
}

function compactDmPreview(raw: string | undefined, maxLen = 72): string {
  if (!raw) return '';
  const single = raw.replace(/\s+/g, ' ').trim();
  if (!single) return '';
  return single.length > maxLen ? `${single.slice(0, maxLen - 1)}…` : single;
}

function formatCompactClock(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export interface BotDmTurnSummary {
  direction: 'incoming' | 'outgoing';
  peerLabel: string;
  tag: string;
  preview: string;
  meta: string;
  copyText: string;
  status: 'idle' | 'running' | 'error';
  silent: boolean;
}

function resolveDmAssistantPeerName(turns: readonly ChatTurn[], turnIdx: number): string | undefined {
  const turn = turns[turnIdx];
  if (!turn) return undefined;
  const tools = turn.tools ?? [];
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (isBotDmSendToTool(tool, turn) && tool.sendTo?.targetName?.trim()) {
      return tool.sendTo.targetName.trim();
    }
  }
  const replyTo = turn.attribution?.replyTo;
  const scopeId = turn.attribution?.scopeId;
  for (let i = turnIdx - 1; i >= Math.max(0, turnIdx - 8); i -= 1) {
    const candidate = turns[i];
    if (!candidate || candidate.role !== 'user' || !isBotDmTurn(candidate)) continue;
    const candidateName = candidate.attribution?.name?.trim();
    if (!candidateName) continue;
    if (replyTo && candidate.attribution?.messageId === replyTo) return candidateName;
    if (scopeId && candidate.attribution?.scopeId === scopeId) return candidateName;
  }
  for (let i = turnIdx - 1; i >= Math.max(0, turnIdx - 4); i -= 1) {
    const candidate = turns[i];
    if (candidate?.role === 'user' && isBotDmTurn(candidate) && candidate.attribution?.name?.trim()) {
      return candidate.attribution.name.trim();
    }
  }
  return undefined;
}

export function resolveBotDmTurnSummary(
  turn: ChatTurn,
  turns: readonly ChatTurn[],
  turnIdx: number,
  t: (zh: string, en: string) => string,
): BotDmTurnSummary {
  const clock = formatCompactClock(turn.timestamp);

  if (turn.role === 'user') {
    const peer = turn.attribution?.name?.trim() || t('其他 Bot', 'Peer bot');
    const category = turn.attribution?.category;
    const tag =
      category === 'request'
        ? t('私聊请求', 'DM request')
        : category === 'reply'
          ? t('私聊回复', 'DM reply')
          : category === 'notice'
            ? t('私聊通知', 'DM notice')
            : t('Bot 私聊', 'Bot DM');
    const attachmentCount = turn.attachments?.length ?? 0;
    const preview =
      compactDmPreview(turn.text) ||
      (attachmentCount > 0 ? t(`${attachmentCount} 张图片`, `${attachmentCount} image(s)`) : '');
    const metaParts = [
      attachmentCount > 0 ? t(`${attachmentCount} 张图片`, `${attachmentCount} img`) : '',
      clock,
    ].filter(Boolean);
    return {
      direction: 'incoming',
      peerLabel: t(`来自 ${peer}`, `From ${peer}`),
      tag,
      preview,
      meta: metaParts.join(' · '),
      copyText: turn.text,
      status: 'idle',
      silent: false,
    };
  }

  const tools = turn.tools ?? [];
  const dmSendTools = tools.filter(tool => isBotDmSendToTool(tool, turn));
  const lastSendTo = dmSendTools.at(-1)?.sendTo;
  const nonSendToolsCount = tools.filter(tool => !isBotDmSendToTool(tool, turn)).length;
  const peer = resolveDmAssistantPeerName(turns, turnIdx) || t('其他 Bot', 'Peer bot');
  const isSilent = Boolean(lastSendTo?.silentPass && !turn.text.trim());
  const status: BotDmTurnSummary['status'] = turn.error
    ? 'error'
    : turn.isStreaming || tools.some(tool => tool.status === 'running')
      ? 'running'
      : 'idle';
  const peerLabel =
    lastSendTo?.category === 'request'
      ? t(`发给 ${peer}`, `To ${peer}`)
      : t(`回复 ${peer}`, `Reply to ${peer}`);
  const tag =
    status === 'running'
      ? t('处理中…', 'Working…')
      : status === 'error'
        ? t('处理失败', 'Failed')
        : isSilent
          ? t('无需回复', 'Silent pass')
          : lastSendTo
            ? t('私聊回传', 'DM reply')
            : t('私聊处理', 'DM task');
  const preview =
    compactDmPreview(lastSendTo?.text) ||
    compactDmPreview(turn.text) ||
    (isSilent
      ? t('本次无需回复（pass）', 'No reply needed (pass)')
      : nonSendToolsCount > 0
        ? t(`调用了 ${nonSendToolsCount} 个工具`, `Used ${nonSendToolsCount} tool(s)`)
        : '');
  const metaParts = [
    lastSendTo?.fileCount && lastSendTo.fileCount > 0
      ? t(`${lastSendTo.fileCount} 个附件`, `${lastSendTo.fileCount} file(s)`)
      : '',
    nonSendToolsCount > 0
      ? t(`${nonSendToolsCount} 步工具`, `${nonSendToolsCount} tool(s)`)
      : '',
    clock,
  ].filter(Boolean);

  return {
    direction: 'outgoing',
    peerLabel,
    tag,
    preview,
    meta: metaParts.join(' · '),
    copyText: turn.text.trim() ? turn.text : (!lastSendTo?.silentPass && lastSendTo?.text ? lastSendTo.text : ''),
    status,
    silent: isSilent,
  };
}

export function BotDmFoldCard({
  direction,
  peerLabel,
  tag,
  preview,
  meta,
  status = 'idle',
  silent = false,
  inline = false,
  defaultCollapsed,
  forceExpand = false,
  className = '',
  children,
}: BotDmFoldCardProps) {
  const bodyId = useId();
  const [prevDefaultCollapsed, setPrevDefaultCollapsed] = useState(defaultCollapsed);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  if (prevDefaultCollapsed !== defaultCollapsed) {
    setPrevDefaultCollapsed(defaultCollapsed);
    setUserOpen(null);
  }

  const expanded = userOpen ?? (!defaultCollapsed || forceExpand);
  const showPreview = !expanded && Boolean(preview);
  const cls = [
    'bot-dm-fold',
    direction === 'incoming' ? 'is-incoming' : 'is-outgoing',
    expanded ? 'is-expanded' : 'is-collapsed',
    inline ? 'is-inline' : '',
    silent ? 'is-silent' : '',
    status === 'running' ? 'is-running' : status === 'error' ? 'is-error' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} data-dm-direction={direction} data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="bot-dm-fold-trigger"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setUserOpen(!expanded)}
      >
        <span className="bot-dm-fold-badge" aria-hidden="true">
          {direction === 'incoming' ? <ArrowDownLeft size={13} strokeWidth={2.2} /> : <ArrowUpRight size={13} strokeWidth={2.2} />}
        </span>
        <span className="bot-dm-fold-summary">
          <span className="bot-dm-fold-peer">{peerLabel}</span>
          {tag ? <span className="bot-dm-fold-tag">{tag}</span> : null}
          {showPreview ? <span className="bot-dm-fold-preview">{preview}</span> : null}
        </span>
        {meta ? <span className="bot-dm-fold-meta">{meta}</span> : null}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`bot-dm-fold-chevron${expanded ? ' is-open' : ''}`}
        />
      </button>
      {expanded ? (
        <div id={bodyId} className="bot-dm-fold-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
