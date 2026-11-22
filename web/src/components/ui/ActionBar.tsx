import type { HTMLAttributes, ReactNode, Ref } from 'react';

export type ActionBarAlign = 'end' | 'start' | 'between';

export interface ActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  align?: ActionBarAlign;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export function ActionBar({
  align = 'end',
  className = '',
  children,
  ref,
  ...rest
}: ActionBarProps) {
  const cls = [
    'ui-action-bar',
    `is-align-${align}`,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} className={cls} {...rest}>
      {children}
    </div>
  );
}
