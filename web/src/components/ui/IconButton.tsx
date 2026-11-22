import { Loader2 } from 'lucide-react';
import { useCallback, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';

export type IconButtonSize = 'md' | 'sm';
export type IconButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string;
  title?: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  loading?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    ref.current = value;
  }
}

export function IconButton({
  label,
  title,
  size = 'md',
  variant = 'ghost',
  loading = false,
  type = 'button',
  disabled,
  className = '',
  children,
  ref,
  ...rest
}: IconButtonProps) {
  const setButtonNode = useCallback(
    (node: HTMLButtonElement | null) => {
      assignRef(ref, node);
    },
    [ref],
  );
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
      ref={ref ? setButtonNode : undefined}
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
