import type { ButtonHTMLAttributes, Ref } from 'react';

type SwitchLabelProps =
  | { label: string; 'aria-label'?: string }
  | { label?: string; 'aria-label': string };

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'aria-checked' | 'aria-label' | 'onChange' | 'type' | 'children'
> & SwitchLabelProps & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  'aria-label': ariaLabel,
  className = '',
  onClick,
  ref,
  ...rest
}: SwitchProps) {
  const accessibleLabel = ariaLabel ?? label;
  const cls = [
    'ui-switch',
    checked ? 'is-checked' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={accessibleLabel}
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      className={cls}
      onClick={event => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          onCheckedChange(!checked);
        }
      }}
      {...rest}
    >
      <span className="ui-switch-knob" aria-hidden="true" />
    </button>
  );
}
