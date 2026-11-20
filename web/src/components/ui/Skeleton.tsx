import type { CSSProperties, Ref } from 'react';
import { useText } from '../../ui';

export interface SkeletonProps {
  lines?: number;
  height?: number | string;
  width?: number | string;
  gap?: number | string;
  rounded?: 'sm' | 'md' | 'full';
  label?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function Skeleton({
  lines = 3,
  height,
  width,
  gap,
  rounded = 'sm',
  label,
  className = '',
  ref,
}: SkeletonProps) {
  const t = useText();
  const count = Math.max(1, Math.floor(lines));
  const cls = ['ui-skeleton', className].filter(Boolean).join(' ');
  const lineCls = [
    'ui-skeleton-line',
    rounded === 'md' ? 'is-rounded-md' : rounded === 'full' ? 'is-rounded-full' : '',
  ].filter(Boolean).join(' ');
  const containerStyle: CSSProperties | undefined = gap !== undefined ? { gap } : undefined;

  return (
    <div
      ref={ref}
      role="status"
      aria-busy="true"
      aria-label={label ?? t('正在加载…', 'Loading…')}
      className={cls}
      style={containerStyle}
    >
      {Array.from({ length: count }, (_, index) => {
        const isLastShort = count > 1 && index === count - 1 && width === undefined;
        const lineStyle: CSSProperties = {
          ...(height !== undefined ? { height } : {}),
          ...(width !== undefined ? { width } : isLastShort ? { width: '72%' } : {}),
        };
        return <span key={index} className={lineCls} style={lineStyle} aria-hidden="true" />;
      })}
    </div>
  );
}
