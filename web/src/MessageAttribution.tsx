// Unified Bot session 消息来源徽标（web 共享，desktop/mobile 复用）。
// 契约：kind/botId/deviceId/channel 为稳定身份（仅内部 key/定位），名字仅显示；
// 所有可见文本/aria 只用面向用户的名字与自然回退，永不渲染 UUID/短 ID。
// 普通主聊及内部 Host 触发器隐藏徽标，Webhook 来源例外；协作轮由调用方过滤。
// 消息正文里 Bot 自己写出的 ID 是历史内容，不篡改。
import type { MessageAttribution as MessageAttributionData } from './chatTurnModel';
import { useText } from './ui';
import './MessageAttribution.css';

export interface MessageAttributionProps {
  attribution: MessageAttributionData;
  className?: string;
}

function channelLabel(channel: MessageAttributionData['channel'], t: (zh: string, en: string) => string): string {
  if (channel === 'primary') return t('私聊', 'DM');
  if (channel === 'dm') return t('Bot 私聊', 'bot DM');
  if (channel === 'room') return t('群聊', 'room');
  return channel;
}

function kindLabel(kind: MessageAttributionData['kind'], t: (zh: string, en: string) => string): string {
  if (kind === 'user') return t('用户', 'user');
  if (kind === 'bot') return t('Bot', 'bot');
  if (kind === 'host') return t('Host', 'host');
  return kind;
}

/** 来源可读名：有目录名用名字；bot 无名回退自然标签，绝不回退 botId。 */
function senderLabel(a: MessageAttributionData, t: (zh: string, en: string) => string): string {
  if (a.name && a.name.trim()) return a.name;
  return a.kind === 'bot' ? t('未命名 Bot', 'Unnamed Bot') : kindLabel(a.kind, t);
}

// Legacy history lacks sourceType; only its Host/primary attribution name is a fallback, never message text.
export function isWebhookAttribution(a: MessageAttributionData | undefined): boolean {
  return a?.kind === 'host' && (
    a.sourceType === 'webhook' ||
    a.sourceType === 'google-workspace-rule' ||
    (a.sourceType === undefined && a.channel === 'primary' && /^Webhook · \S/.test(a.name ?? ''))
  );
}

/**
 * 紧凑来源徽标：「名字 · 频道」+ 可选方向/类别小标签。设备与 ID 不出现在可见
 * 文本、title 或 aria-label 中（身份区分由宿主 knownBots 名字承担）。
 */
export function MessageAttribution({ attribution, className }: MessageAttributionProps) {
  const t = useText();
  const a = attribution;
  const webhook = isWebhookAttribution(a);
  if (!webhook && (a.channel === 'primary' || a.kind === 'host')) return null;
  const sender = senderLabel(a, t);
  const channel = webhook ? t('自动任务', 'Automated task') : channelLabel(a.channel, t);
  const directionOutgoing = a.direction === 'outgoing';
  const isUser = a.kind === 'user';

  const categoryLabel =
    a.category === 'notice'
      ? t('通知', 'notice')
      : a.category === 'request'
        ? t('请求', 'request')
        : a.category === 'reply'
          ? t('回复', 'reply')
          : '';

  const full = [sender, channel, directionOutgoing ? t('发出', 'outgoing') : '', categoryLabel]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      className={`msg-attr msg-attr-${a.kind}${directionOutgoing ? ' msg-attr-out' : ' msg-attr-in'}${className ? ' ' + className : ''}`}
      title={full}
      aria-label={t(`来源：${full}`, `source: ${full}`)}
      data-channel={a.channel}
      data-kind={a.kind}
      data-user={isUser ? 'true' : undefined}
    >
      <span className="msg-attr-sender">{sender}</span>
      <span className="msg-attr-channel">{channel}</span>
      {directionOutgoing ? <span className="msg-attr-dir">{t('发出', 'out')}</span> : null}
      {categoryLabel ? <span className="msg-attr-category">{categoryLabel}</span> : null}
    </span>
  );
}

export default MessageAttribution;
