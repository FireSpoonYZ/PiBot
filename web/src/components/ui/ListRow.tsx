import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

export type ListRowStatusTone = 'ok' | 'warn' | 'error' | 'idle' | 'accent';

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  statusTone?: ListRowStatusTone;
  value?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  radio?: boolean;
  chevron?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  statusTone,
  value,
  onClick,
  selected = false,
  radio = false,
  chevron = false,
  disabled = false,
  'aria-label': ariaLabel,
  className = '',
  ref,
}: ListRowProps) {
  const fullMain = !trailing && !radio && !chevron;
  const hasValue = value !== undefined && value !== null && value !== false && value !== '';
  const statusDot = statusTone ? (
    <span className={`ui-status-dot is-${statusTone}`} aria-hidden="true" />
  ) : null;
  const titleHasStatus = Boolean(statusDot && !hasValue);
  const cls = [
    'ui-list-row',
    selected ? 'is-selected' : '',
    fullMain ? 'is-full-main' : '',
    className,
  ].filter(Boolean).join(' ');

  const content = (
    <>
      {leading ? <span className="ui-list-row-leading" aria-hidden="true">{leading}</span> : null}
      <span className="ui-list-row-text">
        <span className={titleHasStatus ? 'ui-list-row-title has-status' : 'ui-list-row-title'}>
          {titleHasStatus ? (
            <>
              {statusDot}
              <span className="ui-list-row-title-text">{title}</span>
            </>
          ) : (
            title
          )}
        </span>
        {subtitle ? <span className="ui-list-row-subtitle">{subtitle}</span> : null}
      </span>
      {hasValue ? (
        <span className="ui-row-value">
          {statusDot}
          <span className="ui-row-value-text">{value}</span>
        </span>
      ) : null}
    </>
  );

  return (
    <div ref={ref} className={cls}>
      {onClick ? (
        <button
          type="button"
          className="ui-list-row-main"
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          {...(radio ? { role: 'radio', 'aria-checked': selected } : {})}
        >
          {content}
        </button>
      ) : (
        <div
          className="ui-list-row-main"
          aria-label={ariaLabel}
          {...(radio ? { role: 'radio', 'aria-checked': selected } : {})}
        >
          {content}
        </div>
      )}
      {trailing ? <div className="ui-list-row-trailing">{trailing}</div> : null}
      {radio ? (
        <span className="ui-list-row-check" aria-hidden="true">
          {selected ? <Check aria-hidden="true" /> : null}
        </span>
      ) : null}
      {chevron ? <ChevronRight className="ui-list-row-chevron" aria-hidden="true" /> : null}
    </div>
  );
}
