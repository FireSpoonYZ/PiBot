import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronRight, Copy, MoreHorizontal, X } from 'lucide-react';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import { LabelStack, Skeleton, SkeletonRow } from '../layout';
import { useNotice } from '../notice';
import type { NoticeAction, NoticeTone } from '../notice';
import { LanguageOverride, useText } from '../ui';
import { openExternalUrl } from './openExternalUrl';
import { QrSvg } from './qrSvg';
import type { CenterBotRef, CenterDevice } from './types';

export { openExternalUrl };

type TranslateFn = (zh: string, en: string) => string;

function defaultTranslate(zh: string, en: string): string {
  return typeof navigator !== 'undefined' && navigator.language.startsWith('en') ? en : zh;
}

// Keep local instead of importing ../bot-settings/centerAdminBroker so center-web stays independent of desktop/ and host-core/.
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function useUiLocale(): string | undefined {
  const language = useContext(LanguageOverride);
  if (language === 'en') return 'en-US';
  if (language === 'zh') return 'zh-CN';
  return typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined;
}

export function formatTime(isoOrMs: string | number | null | undefined, locale?: string): string {
  if (!isoOrMs) return '—';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  const resolvedLocale =
    locale ?? (typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined);
  return d.toLocaleString(resolvedLocale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatCountdown(expiresAt: string, nowMs: number): string {
  const diff = Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function platformLabel(platform?: string | null, t: TranslateFn = defaultTranslate): string {
  switch (platform) {
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'android':
      return 'Android';
    default:
      return platform || t('未知平台', 'Unknown platform');
  }
}

export function botKey(deviceId: string, botId: string): string {
  return `${deviceId}::${botId}`;
}

export function CaModal({
  open,
  onOpenChange,
  title,
  description,
  ariaDescription,
  variant = 'drawer',
  wide,
  footer,
  bodyClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  ariaDescription?: string;
  variant?: 'modal' | 'drawer';
  wide?: boolean;
  footer?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useText();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    return registerOverlayBackHandler(() => onOpenChangeRef.current(false));
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div className="ca-modal-portal ca-modal-layer">
          <Dialog.Overlay className="ca-dialog-overlay ca-modal-overlay" />
          <Dialog.Content
            ref={contentRef}
            data-ui-dialog={open ? 'open' : undefined}
            className={`ca-dialog-content ca-modal-content ${variant === 'modal' ? 'is-modal' : 'is-drawer'}${
              wide ? ' is-wide' : ''
            }`}
          >
            <div className="ca-dialog-header">
              <div className="ca-dialog-head-text">
                <Dialog.Title className="ca-dialog-title">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="ca-dialog-desc">{description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{ariaDescription ?? title}</Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-icon"
                  aria-label={t('关闭', 'Close')}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className={`ca-dialog-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
            {footer ? <div className="ca-dialog-footer">{footer}</div> : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface CaConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function CaConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onCancel,
  onConfirm,
}: CaConfirmDialogProps): React.JSX.Element {
  const t = useText();
  const resolvedCancel = cancelLabel ?? t('取消', 'Cancel');
  const resolvedConfirm = confirmLabel ?? t('确认', 'Confirm');

  return (
    <CaModal
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && !busy) onCancel();
      }}
      title={title}
      ariaDescription={typeof description === 'string' ? description : undefined}
      variant="modal"
    >
      <div className="ca-confirm-body">
        {description ? <p className="ca-confirm-desc">{description}</p> : null}
        <div className="ca-modal-footer">
          <button
            type="button"
            className="ca-btn"
            disabled={busy}
            onClick={onCancel}
          >
            {resolvedCancel}
          </button>
          <button
            type="button"
            className={`ca-btn ${danger ? 'ca-btn-danger' : 'ca-btn-primary'}`}
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {resolvedConfirm}
          </button>
        </div>
      </div>
    </CaModal>
  );
}

export function CaSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label?: string;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ca-switch ${checked ? 'is-on' : ''}`}
      onClick={e => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="ca-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function CaSegmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}): React.JSX.Element {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, options.findIndex(opt => opt.value === value));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = options.length;
    if (count === 0) return;
    let nextIndex = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (index + 1) % count;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (index - 1 + count) % count;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = count - 1;
    }
    if (nextIndex >= 0) {
      e.preventDefault();
      itemRefs.current[nextIndex]?.focus();
      onChange(options[nextIndex].value);
    }
  };

  return (
    <div className="ca-segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((opt, idx) => (
        <button
          key={opt.value}
          ref={el => {
            itemRefs.current[idx] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          tabIndex={idx === activeIndex ? 0 : -1}
          className={`ca-seg-btn ${value === opt.value ? 'is-active' : ''}`}
          onClick={() => onChange(opt.value)}
          onKeyDown={e => handleKeyDown(e, idx)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function CaChips<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <div className="ca-chips" role="group" aria-label={ariaLabel}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          className={`ca-chip ${value === opt.value ? 'is-active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export type CaNoticeTone = 'ok' | 'warn' | 'danger' | 'info';

export interface CaTabNoticeOptions {
  tone?: CaNoticeTone;
  detail?: string;
  action?: NoticeAction;
  sticky?: boolean;
  durationMs?: number;
}

export function mapCaNoticeTone(tone: CaNoticeTone): NoticeTone {
  switch (tone) {
    case 'ok':
      return 'success';
    case 'warn':
      return 'warning';
    case 'danger':
      return 'error';
    default:
      return 'info';
  }
}

export interface CaTabNotices {
  showNotice: (key: string, title: string, opts?: CaTabNoticeOptions) => void;
  clearNotice: (key: string) => void;
  clearAllNotices: () => void;
}

export function useCaTabNotices(scope: string, active = true): CaTabNotices {
  const { notify, dismiss } = useNotice();
  const trackedRef = useRef<Map<string, boolean>>(new Map());

  const showNotice = useCallback(
    (key: string, title: string, opts?: CaTabNoticeOptions) => {
      const id = `ca:${scope}:${key}`;
      const trimmed = title.trim();
      if (!trimmed) {
        trackedRef.current.delete(id);
        dismiss(id);
        return;
      }
      const tone = mapCaNoticeTone(opts?.tone ?? 'info');
      const dismissOnHide = Boolean(opts?.sticky) || tone === 'error';
      trackedRef.current.set(id, dismissOnHide);
      notify({
        id,
        tone,
        title: trimmed,
        detail: opts?.detail,
        action: opts?.action,
        sticky: opts?.sticky,
        durationMs: opts?.durationMs,
      });
    },
    [dismiss, notify, scope],
  );

  const clearNotice = useCallback(
    (key: string) => {
      const id = `ca:${scope}:${key}`;
      trackedRef.current.delete(id);
      dismiss(id);
    },
    [dismiss, scope],
  );

  const clearAllNotices = useCallback(() => {
    for (const id of trackedRef.current.keys()) {
      dismiss(id);
    }
    trackedRef.current.clear();
  }, [dismiss]);

  useEffect(() => {
    if (active) return;
    for (const [id, dismissOnHide] of Array.from(trackedRef.current.entries())) {
      if (dismissOnHide) {
        trackedRef.current.delete(id);
        dismiss(id);
      }
    }
  }, [active, dismiss]);

  useEffect(() => () => clearAllNotices(), [clearAllNotices]);

  return useMemo(
    () => ({ showNotice, clearNotice, clearAllNotices }),
    [clearAllNotices, clearNotice, showNotice],
  );
}

export function CaRefreshBar({ active }: { active: boolean }): React.JSX.Element {
  return <div className={`ca-refresh-bar${active ? ' is-active' : ''}`} aria-hidden="true" />;
}

export function CaToolbarSkeleton({
  leftWidth = 180,
  rightWidth = 132,
}: {
  leftWidth?: number;
  rightWidth?: number;
}): React.JSX.Element {
  return (
    <div className="ca-toolbar" aria-hidden="true">
      <Skeleton variant="pill" width={leftWidth} height={30} />
      <Skeleton variant="pill" width={rightWidth} height={30} />
    </div>
  );
}

export function CaCardSkeleton({
  height = 58,
  subbar = false,
  label,
}: {
  height?: number;
  subbar?: boolean;
  label?: string;
}): React.JSX.Element {
  return (
    <section
      className="ca-section ca-skeleton-card"
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div className="ca-skeleton-card-main">
        <SkeletonRow variant="settings" height={height} showAvatar={false} showTrailing lines={2} />
      </div>
      {subbar && (
        <div className="ca-skeleton-subbar">
          <Skeleton variant="text" width="64%" height={13} />
        </div>
      )}
    </section>
  );
}

export function CaSectionSkeleton({
  rows = 4,
  lines = 2,
  headWidth = 136,
  trailingWidth = 96,
  label,
}: {
  rows?: number;
  lines?: number;
  headWidth?: number;
  trailingWidth?: number;
  label?: string;
}): React.JSX.Element {
  return (
    <section
      className="ca-section ca-skeleton-card"
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div className="ca-section-head">
        <Skeleton variant="text" width={headWidth} height={16} />
        <Skeleton variant="pill" width={trailingWidth} height={26} />
      </div>
      <div className="ca-list">
        <SkeletonRow
          variant="settings"
          height={lines > 1 ? 58 : 52}
          count={rows}
          showAvatar={false}
          showTrailing
          lines={lines}
        />
      </div>
    </section>
  );
}

export function CaNotice({
  tone = 'info',
  children,
  action,
}: {
  tone?: CaNoticeTone;
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`ca-notice ca-notice-${tone}`}>
      <div>{children}</div>
      {action ? <div className="ca-inline-row">{action}</div> : null}
    </div>
  );
}

export async function openExternalLink(
  url: string,
  handler?: (url: string) => void | Promise<unknown>,
): Promise<void> {
  return openExternalUrl(url, handler);
}

export function CaExternalUrlBox({
  url,
  onOpenUrl,
  onError,
  copyLabel,
}: {
  url: string;
  onOpenUrl?: (url: string) => void | Promise<unknown>;
  onError?: (err: unknown) => void;
  copyLabel?: string;
}): React.JSX.Element {
  const t = useText();
  const resolvedCopyLabel = copyLabel ?? t('复制', 'Copy');
  return (
    <div className="ca-oauth-url-row">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="ca-oauth-link"
        onClick={e => {
          e.preventDefault();
          void openExternalUrl(url, onOpenUrl).catch(err => onError?.(err));
        }}
      >
        {url}
      </a>
      <CopyButton value={url} label={resolvedCopyLabel} />
    </div>
  );
}

export function CaDisclosure({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ca-disclosure">
      <button
        type="button"
        className="ca-disclosure-btn"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <span>{open ? '▾' : '▸'} {title}</span>
      </button>
      {open && <div className="ca-disclosure-body smooth-expand-mount">{children}</div>}
    </div>
  );
}

export function CaCardDisclosure({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`ca-section ca-card-disclosure${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ca-card-disclosure-head"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className="ca-card-disclosure-text">
          <span className="ca-field-label">{title}</span>
          {subtitle && !open ? <span className="ca-muted">{subtitle}</span> : null}
        </span>
        <ChevronRight
          size={15}
          aria-hidden="true"
          className={`ca-card-disclosure-chevron${open ? ' is-open' : ''}`}
        />
      </button>
      {open && <div className="ca-card-disclosure-body smooth-expand-mount">{children}</div>}
    </div>
  );
}

export function CopyButton({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
}): React.JSX.Element {
  const t = useText();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 1800);
    }
  };

  const resolvedLabel = label ?? t('复制', 'Copy');
  const resolvedCopiedLabel = copiedLabel ?? t('已复制', 'Copied');

  return (
    <button type="button" className="ca-btn ca-btn-secondary ca-btn-sm" onClick={() => void handleCopy()}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      <LabelStack
        active={copied ? resolvedCopiedLabel : resolvedLabel}
        labels={[resolvedLabel, resolvedCopiedLabel]}
      />
    </button>
  );
}

export function CaQrBox({
  value,
  label,
  renderQr,
}: {
  value: string;
  label: string;
  renderQr?: (value: string, label: string) => React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="ca-qr-box">
      <div className="ca-qr-frame">
        {renderQr ? renderQr(value, label) : <QrSvg value={value} label={label} />}
      </div>
    </div>
  );
}

export interface ActionMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ActionMenu({ items }: { items: ActionMenuItem[] }): React.JSX.Element {
  const t = useText();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'bottom' | 'top' } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<'first' | 'last'>('first');

  const getEnabledItems = useCallback((): HTMLButtonElement[] => {
    const menu = menuRef.current;
    if (!menu) return [];
    return Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
      ),
    );
  }, []);

  const hasExternalOpenDialog = useCallback((): boolean => {
    if (typeof document === 'undefined') return false;
    const dialogs = document.querySelectorAll('[data-ui-dialog="open"]');
    for (const dialog of dialogs) {
      if (!triggerRef.current || !dialog.contains(triggerRef.current)) {
        return true;
      }
    }
    return false;
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const menuEl = menuRef.current;
    const menuW = menuEl ? menuEl.offsetWidth : 168;
    const menuH = menuEl ? menuEl.offsetHeight : Math.max(44, items.length * 36 + 8);
    const gap = 4;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const preferredLeft = rect.right - menuW;
    const maxLeft = Math.max(pad, vw - menuW - pad);
    const left = Math.min(Math.max(preferredLeft, pad), maxLeft);

    const spaceBelow = vh - rect.bottom - pad;
    const spaceAbove = rect.top - pad;
    const flipUp = spaceBelow < menuH + gap && spaceAbove > spaceBelow;

    let top: number;
    if (flipUp) {
      top = Math.max(pad, rect.top - menuH - gap);
    } else {
      const maxTop = Math.max(pad, vh - menuH - pad);
      top = Math.min(rect.bottom + gap, maxTop);
    }

    setPos({
      top: Math.round(top),
      left: Math.round(left),
      placement: flipUp ? 'top' : 'bottom',
    });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) {
      initialFocusRef.current = 'first';
      return;
    }

    if (hasExternalOpenDialog()) {
      setOpen(false);
      return;
    }

    let rafId: number | null = null;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (hasExternalOpenDialog()) {
          setOpen(false);
          return;
        }
        const enabled = getEnabledItems();
        if (enabled.length > 0) {
          const target =
            initialFocusRef.current === 'last' ? enabled[enabled.length - 1] : enabled[0];
          target.focus();
        } else {
          menuRef.current?.focus();
        }
        initialFocusRef.current = 'first';
      });
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onFocusIn = (e: FocusEvent) => {
      if (hasExternalOpenDialog()) {
        setOpen(false);
        return;
      }
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (hasExternalOpenDialog()) {
        setOpen(false);
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAndRestoreFocus();
        return;
      }

      if (e.key === 'Tab') {
        setOpen(false);
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const enabled = getEnabledItems();
        if (enabled.length === 0) return;
        const activeEl = document.activeElement as HTMLButtonElement | null;
        const currentIndex = activeEl ? enabled.indexOf(activeEl) : -1;
        let nextIndex: number;
        if (e.key === 'Home') {
          nextIndex = 0;
        } else if (e.key === 'End') {
          nextIndex = enabled.length - 1;
        } else if (e.key === 'ArrowDown') {
          nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % enabled.length;
        } else {
          nextIndex =
            currentIndex === -1
              ? enabled.length - 1
              : (currentIndex - 1 + enabled.length) % enabled.length;
        }
        enabled[nextIndex]?.focus();
      }
    };

    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onResize = () => {
      setOpen(false);
    };

    let dialogObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && document.body) {
      dialogObserver = new MutationObserver(() => {
        if (hasExternalOpenDialog()) {
          setOpen(false);
        }
      });
      dialogObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-ui-dialog'],
      });
    }

    const unregisterBack = registerOverlayBackHandler(closeAndRestoreFocus);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    return () => {
      if (rafId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
      dialogObserver?.disconnect();
      unregisterBack();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, closeAndRestoreFocus, getEnabledItems, hasExternalOpenDialog]);

  return (
    <div className="ca-menu-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="ca-btn ca-btn-ghost ca-btn-icon"
        aria-label={t('更多操作', 'More actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={e => {
          e.stopPropagation();
          initialFocusRef.current = 'first';
          setOpen(prev => !prev);
        }}
        onKeyDown={e => {
          if (open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            initialFocusRef.current = e.key === 'ArrowUp' ? 'last' : 'first';
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div className="ca-modal-portal">
              <div
                ref={menuRef}
                id={menuId}
                className={`ca-menu-pop${pos?.placement === 'top' ? ' is-top' : ''}`}
                role="menu"
                tabIndex={-1}
                style={
                  pos
                    ? { top: `${pos.top}px`, left: `${pos.left}px` }
                    : { top: 0, left: 0, visibility: 'hidden' }
                }
              >
                {items.map((item, idx) => (
                  <button
                    key={`${item.label}-${idx}`}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={item.disabled}
                    className={`ca-menu-item${item.danger ? ' is-danger' : ''}`}
                    onClick={e => {
                      e.stopPropagation();
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export interface BotTreeSelectorProps {
  devices: CenterDevice[];
  bots: CenterBotRef[];
  selectedKeys: Set<string>;
  busyKeys?: Set<string>;
  disabled?: boolean;
  onToggleBot: (deviceId: string, botId: string, nextChecked: boolean) => void;
  renderBotExtra?: (bot: CenterBotRef) => React.ReactNode;
  emptyText?: string;
}

export function BotTreeSelector({
  devices,
  bots,
  selectedKeys,
  busyKeys,
  disabled,
  onToggleBot,
  renderBotExtra,
  emptyText,
}: BotTreeSelectorProps): React.JSX.Element {
  const t = useText();
  const activeBots = bots.filter(b => !b.archivedAt);
  const grouped = new Map<string, CenterBotRef[]>();
  for (const bot of activeBots) {
    const arr = grouped.get(bot.deviceId) ?? [];
    arr.push(bot);
    grouped.set(bot.deviceId, arr);
  }

  const deviceById = new Map<string, CenterDevice>();
  for (const d of devices) deviceById.set(d.deviceId, d);
  for (const b of activeBots) {
    if (!deviceById.has(b.deviceId)) {
      deviceById.set(b.deviceId, {
        deviceId: b.deviceId,
        name: b.deviceName || b.deviceId,
        online: Boolean(b.online),
        platform: (b.platform as CenterDevice['platform']) || undefined,
      });
    }
  }

  const deviceList = [...deviceById.values()].filter(d => (grouped.get(d.deviceId)?.length ?? 0) > 0);
  if (deviceList.length === 0) {
    const fallbackEmpty = emptyText ?? t('暂无在线或已注册设备的 Bot', 'No Bots on online or registered devices');
    return <div className="ca-empty-hint">{fallbackEmpty}</div>;
  }

  return (
    <div className="ca-tree">
      {deviceList.map(device => {
        const list = grouped.get(device.deviceId) ?? [];
        return (
          <div key={device.deviceId} className="ca-tree-device">
            <div className="ca-tree-device-head">
              <div className="ca-inline-row">
                <span className={`ca-dot ${device.online ? 'is-online' : ''}`} />
                <span>{device.name || device.deviceId}</span>
                {device.platform && (
                  <span className="ca-pill ca-pill-muted">{platformLabel(device.platform, t)}</span>
                )}
              </div>
              <span className="ca-muted ca-num">
                {t(`${list.length} 个 Bot`, `${list.length} ${list.length === 1 ? 'Bot' : 'Bots'}`)}
              </span>
            </div>
            <div className="ca-tree-bots">
              {list.map(bot => {
                const key = botKey(device.deviceId, bot.botId);
                const checked = selectedKeys.has(key);
                const busy = busyKeys?.has(key) ?? false;
                return (
                  <div key={key} className="ca-tree-bot-row">
                    <label className="ca-check-label ca-tree-bot-label">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || busy}
                        onChange={e => onToggleBot(device.deviceId, bot.botId, e.target.checked)}
                      />
                      <span className="ca-tree-bot-name">{bot.name || bot.botId}</span>
                      {bot.isPrimary && <span className="ca-pill ca-pill-info">{t('主', 'Primary')}</span>}
                      {bot.resolvedModel?.effectiveModelName && (
                        <span className="ca-muted ca-tree-bot-model">
                          {bot.resolvedModel.effectiveModelName}
                        </span>
                      )}
                    </label>
                    {renderBotExtra ? <div className="ca-inline-row">{renderBotExtra(bot)}</div> : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
