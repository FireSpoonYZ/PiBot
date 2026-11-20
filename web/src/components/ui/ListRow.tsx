import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
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
        <span className="ui-list-row-title">{title}</span>
        {subtitle ? <span className="ui-list-row-subtitle">{subtitle}</span> : null}
      </span>
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
