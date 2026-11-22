import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type IconButtonSize = 'md' | 'sm';
export type IconButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  loading?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  loading = false,
  type = 'button',
  disabled,
  title,
  className = '',
  children,
  ref,
  ...rest
}: IconButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  const cls = [
    'ui-icon-btn',
    `is-${variant}`,
    size === 'sm' ? 'is-sm' : '',
    loading ? 'is-loading' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cls}
      {...rest}
    >
      {loading ? <Loader2 className="ui-btn-spinner" aria-hidden="true" /> : children}
    </button>
  );
}
