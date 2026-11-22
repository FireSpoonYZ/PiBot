import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { AriaRole, ReactNode, Ref } from 'react';
import { useText } from '../../ui';
import { IconButton } from './IconButton';

export type InlineNoticeTone = 'info' | 'success' | 'warning' | 'error';

export interface InlineNoticeProps {
  tone?: InlineNoticeTone;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
  role?: AriaRole;
  ref?: Ref<HTMLDivElement>;
}

function renderToneIcon(tone: InlineNoticeTone): ReactNode {
  switch (tone) {
    case 'success':
      return <CheckCircle2 aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle aria-hidden="true" />;
    case 'error':
      return <AlertCircle aria-hidden="true" />;
    default:
      return <Info aria-hidden="true" />;
  }
}

export function InlineNotice({
  tone = 'info',
  title,
  description,
  action,
  onDismiss,
  className = '',
  role,
  ref,
}: InlineNoticeProps) {
  const t = useText();
  const resolvedRole: AriaRole = role ?? (tone === 'error' ? 'alert' : 'status');
  const ariaLive = resolvedRole === 'alert' ? 'assertive' : resolvedRole === 'status' ? 'polite' : undefined;
  const cls = ['ui-inline-notice', `is-${tone}`, className].filter(Boolean).join(' ');

  return (
    <div ref={ref} role={resolvedRole} aria-live={ariaLive} className={cls}>
      <span className="ui-inline-notice-icon" aria-hidden="true">
        {renderToneIcon(tone)}
      </span>
      <div className="ui-inline-notice-body">
        {title ? <div className="ui-inline-notice-title">{title}</div> : null}
        {description ? <div className="ui-inline-notice-desc">{description}</div> : null}
        {action ? <div className="ui-inline-notice-action">{action}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton
          size="sm"
          variant="ghost"
          label={t('关闭提示', 'Dismiss notice')}
          className="ui-inline-notice-dismiss"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}
