import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useText } from '../../ui';

export type InlineBannerTone = 'neutral' | 'info' | 'attention' | 'danger' | 'live';

export interface InlineBannerProps {
  tone?: InlineBannerTone;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  compact?: boolean;
  role?: 'alert' | 'status' | 'region';
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function renderDefaultBannerIcon(tone: InlineBannerTone): ReactNode {
  switch (tone) {
    case 'live':
      return <CheckCircle2 aria-hidden="true" />;
    case 'attention':
      return <TriangleAlert aria-hidden="true" />;
    case 'danger':
      return <CircleAlert aria-hidden="true" />;
    case 'info':
      return <Info aria-hidden="true" />;
    default:
      return null;
  }
}

export function InlineBanner({
  tone = 'neutral',
  icon,
  title,
  detail,
  actions,
  onDismiss,
  dismissLabel,
  compact = false,
  role,
  className = '',
  ref,
}: InlineBannerProps) {
  const t = useText();
  const resolvedIcon = icon === undefined ? renderDefaultBannerIcon(tone) : icon;
  const resolvedRole =
    role ?? (tone === 'danger' ? 'alert' : tone === 'neutral' ? 'region' : 'status');

  const cls = [
    'ui-inline-banner',
    `is-${tone}`,
    compact ? 'is-compact' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={ref}
      role={resolvedRole}
      aria-live={resolvedRole === 'alert' ? 'assertive' : resolvedRole === 'status' ? 'polite' : undefined}
      className={cls}
    >
      {resolvedIcon ? (
        <span className="ui-inline-banner-icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      ) : null}
      <div className="ui-inline-banner-body">
        <div className="ui-inline-banner-title">{title}</div>
        {detail ? <div className="ui-inline-banner-detail">{detail}</div> : null}
      </div>
      {actions || onDismiss ? (
        <div className="ui-inline-banner-trailing">
          {actions ? <div className="ui-inline-banner-actions">{actions}</div> : null}
          {onDismiss ? (
            <button
              type="button"
              className="ui-inline-banner-dismiss"
              aria-label={dismissLabel ?? t('关闭', 'Dismiss')}
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
