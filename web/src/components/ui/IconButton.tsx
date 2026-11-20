import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type IconButtonSize = 'md' | 'sm';
export type IconButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  type = 'button',
  className = '',
  children,
  ref,
  ...rest
}: IconButtonProps) {
  const cls = [
    'ui-icon-btn',
    `is-${variant}`,
    size === 'sm' ? 'is-sm' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cls}
      {...rest}
    >
      {children}
    </button>
  );
}
