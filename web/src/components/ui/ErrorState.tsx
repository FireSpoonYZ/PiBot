import { AlertCircle } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useText } from '../../ui';
import { Button } from './Button';

export interface ErrorStateProps {
  title: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel,
  icon,
  action,
  className = '',
  ref,
}: ErrorStateProps) {
  const t = useText();
  const cls = ['ui-state-box', 'is-error', className].filter(Boolean).join(' ');
  const cta = action ?? (onRetry ? (
    <Button variant="secondary" size="sm" onClick={onRetry}>
      {retryLabel ?? t('重试', 'Retry')}
    </Button>
  ) : null);

  return (
    <div ref={ref} role="alert" className={cls}>
      <span className="ui-state-icon" aria-hidden="true">
        {icon ?? <AlertCircle aria-hidden="true" />}
      </span>
      <h3 className="ui-state-title">{title}</h3>
      {description ? <p className="ui-state-desc">{description}</p> : null}
      {cta ? <div className="ui-state-action">{cta}</div> : null}
    </div>
  );
}
