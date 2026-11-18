import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react';

export interface SectionProps {
  title?: ReactNode;
  action?: ReactNode;
  hint?: ReactNode;
  bare?: boolean;
  children: ReactNode;
}

export function Section({ title, action, hint, bare = false, children }: SectionProps) {
  return (
    <section className="cw-section">
      {title || action ? (
        <div className="cw-section-head">
          {title ? <h2 className="cw-section-title">{title}</h2> : <span />}
          {action ? <div className="cw-section-action">{action}</div> : null}
        </div>
      ) : null}
      {bare ? children : <div className="cw-card">{children}</div>}
      {hint ? <p className="cw-section-hint">{hint}</p> : null}
    </section>
  );
}

export interface RowProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  radio?: boolean;
  selected?: boolean;
  chevron?: boolean;
  disabled?: boolean;
  muted?: boolean;
  ariaLabel?: string;
}

export function Row({
  icon,
  title,
  subtitle,
  trailing,
  onClick,
  radio = false,
  selected = false,
  chevron = false,
  disabled = false,
  muted = false,
  ariaLabel,
}: RowProps) {
  const body = (
    <>
      {icon ? <span className="cw-row-icon" aria-hidden="true">{icon}</span> : null}
      <span className="cw-row-text">
        <span className="cw-row-title">{title}</span>
        {subtitle ? <span className="cw-row-sub">{subtitle}</span> : null}
      </span>
    </>
  );
  const marks = (
    <>
      {radio ? (
        <span className={`cw-row-check${selected ? ' is-on' : ''}`} aria-hidden="true">
          {selected ? <Check size={17} /> : null}
        </span>
      ) : null}
      {chevron ? <ChevronRight size={17} className="cw-row-chevron" aria-hidden="true" /> : null}
    </>
  );
  const cls = `cw-row${selected ? ' is-selected' : ''}${muted ? ' is-muted' : ''}${onClick ? ' is-clickable' : ''}`;
  if (onClick && trailing && !radio) {
    return (
      <div className={`${cls} is-split`}>
        <button type="button" className="cw-row-main" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
          {body}
          {marks}
        </button>
        <span className="cw-row-trailing">{trailing}</span>
      </div>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        {...(radio ? { role: 'radio', 'aria-checked': selected } : {})}
      >
        {body}
        {trailing ? <span className="cw-row-trailing">{trailing}</span> : null}
        {marks}
      </button>
    );
  }
  return (
    <div className={cls} aria-label={ariaLabel}>
      {body}
      {trailing ? <span className="cw-row-trailing">{trailing}</span> : null}
      {marks}
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`cw-switch${checked ? ' is-on' : ''}`}
      onClick={event => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="cw-switch-knob" />
    </button>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: ReactNode;
  hint?: ReactNode;
}

export function Chips<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: V;
  options: ChoiceOption<V>[];
  onChange(next: V): void;
  disabled?: boolean;
}) {
  return (
    <div className="cw-chips" role="radiogroup" aria-label={label}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`cw-chip${active ? ' is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {option.hint ? <span className="cw-chip-hint">{option.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: V;
  options: ChoiceOption<V>[];
  onChange(next: V): void;
  disabled?: boolean;
}) {
  return (
    <div className="cw-segmented" role="radiogroup" aria-label={label}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={active ? 'is-active' : undefined}
            onClick={() => onChange(option.value)}
          >
            <span className="cw-segmented-label">{option.label}</span>
            {option.hint ? <span className="cw-segmented-hint">{option.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange(next: string): void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div className="cw-search">
      <Search size={16} aria-hidden="true" />
      <input
        type="search"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={event => onChange(event.target.value)}
      />
      {value ? (
        <button type="button" className="cw-search-clear" aria-label="清空搜索" onClick={() => onChange('')}>
          <X size={15} />
        </button>
      ) : null}
    </div>
  );
}

export function Disclosure({
  label,
  defaultOpen = false,
  children,
}: {
  label: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div className={`cw-disclosure${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="cw-disclosure-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(prev => !prev)}
      >
        <ChevronDown size={15} className="cw-disclosure-chevron" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open ? (
        <div id={bodyId} className="cw-disclosure-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
