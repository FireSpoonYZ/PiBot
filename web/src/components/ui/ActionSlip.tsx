import type { AriaRole, ReactNode, Ref } from 'react';

export type ActionSlipTone = 'neutral' | 'info' | 'attention' | 'live' | 'danger';

export interface ActionSlipProps {
  tone?: ActionSlipTone;
  icon?: ReactNode;
  title?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  headerExtra?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  className?: string;
  role?: AriaRole;
  ariaLabel?: string;
  ref?: Ref<HTMLElement>;
}

export function ActionSlip({
  tone = 'neutral',
  icon,
  title,
  status,
  meta,
  headerExtra,
  children,
  footer,
  compact = false,
  className = '',
  role,
  ariaLabel,
  ref,
}: ActionSlipProps) {
  const cls = [
    'ui-action-slip',
    `is-${tone}`,
    compact ? 'is-compact' : '',
    className,
  ].filter(Boolean).join(' ');
  const hasHeader = Boolean(icon || title || status || meta || headerExtra);

  return (
    <section ref={ref} role={role} aria-label={ariaLabel} className={cls}>
      {hasHeader ? (
        <header className="ui-action-slip-header">
          <div className="ui-action-slip-heading">
            {icon ? (
              <span className="ui-action-slip-icon" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <div className="ui-action-slip-title-group">
              {title || status ? (
                <div className="ui-action-slip-title-row">
                  {title ? <span className="ui-action-slip-title">{title}</span> : null}
                  {status ? <span className="ui-action-slip-status">{status}</span> : null}
                </div>
              ) : null}
              {meta ? <div className="ui-action-slip-meta">{meta}</div> : null}
            </div>
          </div>
          {headerExtra ? <div className="ui-action-slip-extra">{headerExtra}</div> : null}
        </header>
      ) : null}
      {children ? <div className="ui-action-slip-body">{children}</div> : null}
      {footer ? <footer className="ui-action-slip-footer">{footer}</footer> : null}
    </section>
  );
}
