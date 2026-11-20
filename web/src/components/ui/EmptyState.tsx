import type { ReactNode, Ref } from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  actionLabel,
  onAction,
  className = '',
  ref,
}: EmptyStateProps) {
  const cls = ['ui-state-box', className].filter(Boolean).join(' ');
  const cta = action ?? (actionLabel && onAction ? (
    <Button variant="primary" size="sm" onClick={onAction}>{actionLabel}</Button>
  ) : null);

  return (
    <div ref={ref} className={cls}>
      {icon ? <span className="ui-state-icon" aria-hidden="true">{icon}</span> : null}
      <h3 className="ui-state-title">{title}</h3>
      {description ? <p className="ui-state-desc">{description}</p> : null}
      {cta ? <div className="ui-state-action">{cta}</div> : null}
    </div>
  );
}
