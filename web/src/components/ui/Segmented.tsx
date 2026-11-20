import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string = string> {
  options: readonly SegmentedOption<V>[];
  value: V | undefined;
  onChange: (value: V) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function Segmented<V extends string = string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  disabled = false,
  className = '',
  ref,
}: SegmentedProps<V>) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const firstEnabledIndex = options.findIndex(opt => !disabled && !opt.disabled);
  const selectedIndex = options.findIndex(opt => opt.value === value && !disabled && !opt.disabled);
  const activeTabIndex = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex;

  const moveFocusAndSelect = (startIndex: number, step: 1 | -1) => {
    const count = options.length;
    for (let offset = 1; offset <= count; offset += 1) {
      const next = (startIndex + step * offset + count) % count;
      const option = options[next];
      if (!disabled && !option.disabled) {
        itemRefs.current[next]?.focus();
        onChange(option.value);
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocusAndSelect(index, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocusAndSelect(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (firstEnabledIndex >= 0) {
        itemRefs.current[firstEnabledIndex]?.focus();
        onChange(options[firstEnabledIndex].value);
      }
    } else if (event.key === 'End') {
      event.preventDefault();
      for (let i = options.length - 1; i >= 0; i -= 1) {
        if (!options[i].disabled) {
          itemRefs.current[i]?.focus();
          onChange(options[i].value);
          return;
        }
      }
    }
  };

  const cls = ['ui-segmented', className].filter(Boolean).join(' ');

  return (
    <div ref={ref} role="radiogroup" aria-label={ariaLabel} className={cls}>
      {options.map((option, index) => {
        const checked = value === option.value;
        const itemDisabled = Boolean(disabled || option.disabled);
        return (
          <button
            key={option.value}
            ref={el => { itemRefs.current[index] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === activeTabIndex ? 0 : -1}
            disabled={itemDisabled}
            className={`ui-segmented-item${checked ? ' is-active' : ''}`}
            onClick={() => {
              if (!itemDisabled) onChange(option.value);
            }}
            onKeyDown={event => handleKeyDown(event, index)}
          >
            <span className="ui-segmented-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
