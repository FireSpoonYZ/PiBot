import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leadingIcon,
  trailingIcon,
  fullWidth = false,
  type = 'button',
  disabled,
  className = '',
  children,
  ref,
  ...rest
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  const cls = [
    'ui-btn',
    `is-${variant}`,
    size === 'sm' ? 'is-sm' : '',
    fullWidth ? 'is-full' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="ui-btn-spinner" aria-hidden="true" />
      ) : leadingIcon ? (
        <span className="ui-btn-icon" aria-hidden="true">{leadingIcon}</span>
      ) : null}
      {children}
      {!loading && trailingIcon ? (
        <span className="ui-btn-icon" aria-hidden="true">{trailingIcon}</span>
      ) : null}
    </button>
  );
}
