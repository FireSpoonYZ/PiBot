import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';

export interface ChipOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

interface ChipsBaseProps<V extends string> {
  options: readonly ChipOption<V>[];
  'aria-label': string;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export type ChipsSingleProps<V extends string = string> = ChipsBaseProps<V> & {
  multiple?: false;
  value: V | undefined;
  onChange: (value: V) => void;
};

export type ChipsMultiProps<V extends string = string> = ChipsBaseProps<V> & {
  multiple: true;
  value: readonly V[];
  onChange: (value: V[]) => void;
};

export type ChipsProps<V extends string = string> = ChipsSingleProps<V> | ChipsMultiProps<V>;

export function Chips<V extends string = string>(props: ChipsProps<V>) {
  const {
    options,
    'aria-label': ariaLabel,
    disabled = false,
    className = '',
    ref,
  } = props;
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isPressed = (optionValue: V): boolean => (
    props.multiple ? props.value.includes(optionValue) : props.value === optionValue
  );

  const handleSelect = (optionValue: V) => {
    if (props.multiple) {
      const exists = props.value.includes(optionValue);
      const next = exists
        ? props.value.filter(item => item !== optionValue)
        : [...props.value, optionValue];
      props.onChange(next);
    } else {
      props.onChange(optionValue);
    }
  };

  const focusStep = (startIndex: number, step: 1 | -1) => {
    const count = options.length;
    for (let offset = 1; offset <= count; offset += 1) {
      const next = (startIndex + step * offset + count) % count;
      if (!disabled && !options[next].disabled) {
        itemRefs.current[next]?.focus();
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusStep(index, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusStep(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = options.findIndex(opt => !opt.disabled);
      if (first >= 0) itemRefs.current[first]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      for (let i = options.length - 1; i >= 0; i -= 1) {
        if (!options[i].disabled) {
          itemRefs.current[i]?.focus();
          return;
        }
      }
    }
  };

  const cls = ['ui-chips', className].filter(Boolean).join(' ');

  return (
    <div ref={ref} role="group" aria-label={ariaLabel} className={cls}>
      {options.map((option, index) => {
        const pressed = isPressed(option.value);
        const itemDisabled = Boolean(disabled || option.disabled);
        return (
          <button
            key={option.value}
            ref={el => { itemRefs.current[index] = el; }}
            type="button"
            aria-pressed={pressed}
            disabled={itemDisabled}
            className={`ui-chip${pressed ? ' is-active' : ''}`}
            onClick={() => {
              if (!itemDisabled) handleSelect(option.value);
            }}
            onKeyDown={event => handleKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
