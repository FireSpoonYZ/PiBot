import {
  useEffect,
  useLayoutEffect,
  type AriaRole,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import './stability.css';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// ---------------------------------------------------------------------------
// ReservedSlot
// ---------------------------------------------------------------------------

export interface ReservedSlotProps {
  minHeight: number | string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  align?: 'start' | 'center' | 'end';
  contentKey?: string | number;
  inline?: boolean;
  role?: AriaRole;
  'aria-live'?: 'off' | 'polite' | 'assertive';
  'aria-label'?: string;
}

/**
 * Reserves a stable minimum vertical height so async or state-driven content
 * can fade in/out or swap in place without shifting surrounding layout.
 */
export function ReservedSlot({
  minHeight,
  className,
  style,
  children,
  align = 'center',
  contentKey,
  inline = false,
  role,
  'aria-live': ariaLive,
  'aria-label': ariaLabel,
}: ReservedSlotProps) {
  const hasContent = children !== null && children !== undefined && children !== false && children !== '';
  const rootClass = [
    'ls-reserved-slot',
    `is-align-${align}`,
    inline ? 'is-inline' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const innerClass = [
    'ls-reserved-slot-inner',
    hasContent ? 'is-visible' : 'is-empty',
    hasContent && contentKey !== undefined ? 'is-swapping' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const rootStyle: CSSProperties = { minHeight, ...style };

  if (inline) {
    return (
      <span
        className={rootClass}
        style={rootStyle}
        role={role}
        aria-live={ariaLive}
        aria-label={ariaLabel}
      >
        <span key={contentKey} className={innerClass} aria-hidden={!hasContent || undefined}>
          {children}
        </span>
      </span>
    );
  }

  return (
    <div
      className={rootClass}
      style={rootStyle}
      role={role}
      aria-live={ariaLive}
      aria-label={ariaLabel}
    >
      <div key={contentKey} className={innerClass} aria-hidden={!hasContent || undefined}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LabelStack
// ---------------------------------------------------------------------------

export interface LabelStackProps {
  active: string;
  labels: readonly string[];
  className?: string;
  align?: 'start' | 'center' | 'end';
}

/**
 * Stacks all candidate labels inside the same 1x1 CSS Grid cell so the element
 * locks to the widest candidate label and never shifts horizontally on toggle.
 */
export function LabelStack({
  active,
  labels,
  className,
  align = 'center',
}: LabelStackProps) {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (!seen.has(label)) {
      seen.add(label);
      candidates.push(label);
    }
  }
  if (!seen.has(active)) {
    candidates.push(active);
  }

  const rootClass = ['ls-label-stack', `is-align-${align}`, className ?? ''].filter(Boolean).join(' ');

  return (
    <span className={rootClass}>
      {candidates.map((label) => {
        const isActive = label === active;
        return (
          <span
            key={label}
            className={`ls-label-stack-item${isActive ? ' is-active' : ' is-placeholder'}`}
            aria-hidden={isActive ? undefined : true}
          >
            {label}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skeleton & SkeletonRow
// ---------------------------------------------------------------------------

export type SkeletonVariant = 'text' | 'rect' | 'circle' | 'pill';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  lines?: number;
  gap?: number | string;
  variant?: SkeletonVariant;
  inline?: boolean;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

export function Skeleton({
  width,
  height,
  lines = 1,
  gap,
  variant = 'rect',
  inline = false,
  className,
  style,
  label,
}: SkeletonProps) {
  const count = Math.max(1, Math.floor(lines));
  const barClass = [
    'ls-skeleton-bar',
    `is-${variant}`,
    inline ? 'is-inline' : '',
    count === 1 ? (className ?? '') : '',
  ]
    .filter(Boolean)
    .join(' ');

  const statusProps = label
    ? ({ role: 'status', 'aria-busy': true, 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);

  if (count === 1) {
    const barStyle: CSSProperties = {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...style,
    };
    return <span className={barClass} style={barStyle} {...statusProps} />;
  }

  const listClass = ['ls-skeleton-lines', className ?? ''].filter(Boolean).join(' ');
  const listStyle: CSSProperties = {
    ...(gap !== undefined ? { gap } : {}),
    ...style,
  };

  return (
    <span className={listClass} style={listStyle} {...statusProps}>
      {Array.from({ length: count }, (_, idx) => {
        const isLastShort = idx === count - 1 && width === undefined;
        const lineStyle: CSSProperties = {
          ...(height !== undefined ? { height } : {}),
          ...(width !== undefined ? { width } : isLastShort ? { width: '72%' } : {}),
        };
        return <span key={idx} className={barClass} style={lineStyle} aria-hidden="true" />;
      })}
    </span>
  );
}

export type SkeletonRowVariant = 'hub' | 'settings' | 'custom';

export interface SkeletonRowProps {
  variant?: SkeletonRowVariant;
  height?: number | string;
  count?: number;
  showAvatar?: boolean;
  showTrailing?: boolean;
  lines?: number;
  className?: string;
  label?: string;
}

function SkeletonRowItem({
  variant,
  height,
  showAvatar,
  showTrailing,
  lines,
  className,
  label,
}: {
  variant: SkeletonRowVariant;
  height?: number | string;
  showAvatar: boolean;
  showTrailing: boolean;
  lines: number;
  className?: string;
  label?: string;
}) {
  const rowClass = ['ls-skeleton-row', `is-${variant}`, className ?? ''].filter(Boolean).join(' ');
  const rowStyle: CSSProperties | undefined =
    height !== undefined ? { height, minHeight: height } : undefined;

  const isHub = variant === 'hub';
  const avatarWidth = isHub ? 40 : 30;
  const avatarHeight = isHub ? 40 : 30;
  const avatarVariant: SkeletonVariant = isHub ? 'circle' : 'rect';
  const lineCount = Math.max(1, Math.floor(lines));

  return (
    <div
      className={rowClass}
      style={rowStyle}
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {showAvatar ? (
        <Skeleton variant={avatarVariant} width={avatarWidth} height={avatarHeight} />
      ) : null}
      <div className="ls-skeleton-row-body">
        <Skeleton
          variant="text"
          height={14}
          width={isHub ? '42%' : '48%'}
        />
        {lineCount > 1 ? (
          <Skeleton
            variant="text"
            height={12}
            width={isHub ? '68%' : '62%'}
          />
        ) : null}
        {lineCount > 2 ? (
          <Skeleton variant="text" height={12} width="52%" />
        ) : null}
      </div>
      {showTrailing ? (
        <div className="ls-skeleton-row-trailing">
          <Skeleton
            variant={isHub ? 'text' : 'pill'}
            width={isHub ? 34 : 48}
            height={isHub ? 11 : 20}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shimmer placeholder row matching real Hub (62px) and Settings (52px) row heights.
 */
export function SkeletonRow({
  variant = 'hub',
  height,
  count = 1,
  showAvatar,
  showTrailing,
  lines,
  className,
  label,
}: SkeletonRowProps) {
  const resolvedAvatar = showAvatar ?? (variant === 'hub' || variant === 'settings');
  const resolvedTrailing = showTrailing ?? variant === 'hub';
  const resolvedLines = lines ?? (variant === 'hub' ? 2 : 1);
  const resolvedHeight = height ?? (variant === 'custom' ? 52 : undefined);
  const itemCount = Math.max(1, Math.floor(count));

  if (itemCount === 1) {
    return (
      <SkeletonRowItem
        variant={variant}
        height={resolvedHeight}
        showAvatar={resolvedAvatar}
        showTrailing={resolvedTrailing}
        lines={resolvedLines}
        className={className}
        label={label}
      />
    );
  }

  return (
    <div
      className="ls-skeleton-list"
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {Array.from({ length: itemCount }, (_, idx) => (
        <SkeletonRowItem
          key={idx}
          variant={variant}
          height={resolvedHeight}
          showAvatar={resolvedAvatar}
          showTrailing={resolvedTrailing}
          lines={resolvedLines}
          className={className}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SmoothExpand
// ---------------------------------------------------------------------------

export interface SmoothExpandProps {
  open: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Smooth height/opacity container for user-initiated expandable regions
 * (composer strips, attachments, quotes, recording bars, disclosures).
 */
export function SmoothExpand({ open, className, children }: SmoothExpandProps) {
  const cls = [open ? 'smooth-expand' : 'smooth-collapse', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-collapsed={open ? undefined : 'true'} aria-hidden={!open || undefined}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useBottomChromeMeasure
// ---------------------------------------------------------------------------

let nextBottomChromeToken = 1;
const activeBottomChromeHeights = new Map<number, number>();
let lastBottomChromeCssValue: string | null = null;

function syncBottomChromeCssVar(): void {
  if (typeof document === 'undefined') return;
  let effectiveHeight = 0;
  for (const height of activeBottomChromeHeights.values()) {
    effectiveHeight = height;
  }
  const formatted = `${Math.max(0, Math.round(effectiveHeight))}px`;
  if (formatted !== lastBottomChromeCssValue) {
    lastBottomChromeCssValue = formatted;
    document.documentElement.style.setProperty('--bottom-chrome', formatted);
  }
}

/**
 * Measures the active screen's bottom chrome (search bar, composer, etc.) via
 * ResizeObserver and publishes `--bottom-chrome: <N>px` on `document.documentElement`.
 *
 * Uses an active-token map so hidden keep-alive screens (`active === false`)
 * never overwrite the currently visible screen's `--bottom-chrome`.
 */
export function useBottomChromeMeasure(
  ref: RefObject<HTMLElement | null>,
  active = true,
): void {
  useIsomorphicLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const token = nextBottomChromeToken++;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Hidden keep-alive screen (display: none) reports 0x0 and offsetParent === null.
      if (rect.width === 0 && rect.height === 0 && el.offsetParent === null) {
        return;
      }
      activeBottomChromeHeights.set(token, rect.height);
      syncBottomChromeCssVar();
    };

    measure();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        measure();
      });
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      activeBottomChromeHeights.delete(token);
      syncBottomChromeCssVar();
    };
  }, [ref, active]);
}
