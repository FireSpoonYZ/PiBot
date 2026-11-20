import { useContext, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronRight, Copy, MoreHorizontal, X } from 'lucide-react';
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
  variant = 'drawer',
  wide,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  variant?: 'modal' | 'drawer';
  wide?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useText();
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleBack = (event: Event) => {
      if (event.defaultPrevented) return;
      const openDialogs = document.querySelectorAll('[data-ui-dialog="open"]');
      if (openDialogs.length > 0 && contentRef.current && openDialogs[openDialogs.length - 1] !== contentRef.current) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      onOpenChange(false);
    };
    window.addEventListener('app-back', handleBack, true);
    return () => window.removeEventListener('app-back', handleBack, true);
  }, [open, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div className="ca-modal-portal">
          <Dialog.Overlay className="ca-dialog-overlay" />
          <Dialog.Content
            ref={contentRef}
            data-ui-dialog={open ? 'open' : undefined}
            className={`ca-dialog-content ${variant === 'modal' ? 'is-modal' : 'is-drawer'}${
              wide ? ' is-wide' : ''
            }`}
          >
            <div className="ca-dialog-header">
              <div>
                <Dialog.Title className="ca-dialog-title">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="ca-dialog-desc">{description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{title}</Dialog.Description>
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
            <div className="ca-dialog-body">{children}</div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
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

export function CaNotice({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'ok' | 'warn' | 'danger' | 'info';
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
      {open && <div className="ca-disclosure-body">{children}</div>}
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
      {open && <div className="ca-card-disclosure-body">{children}</div>}
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
      <span>{copied ? resolvedCopiedLabel : resolvedLabel}</span>
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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="ca-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="ca-btn ca-btn-ghost ca-btn-icon"
        aria-label={t('更多操作', 'More actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => {
          e.stopPropagation();
          setOpen(prev => !prev);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="ca-menu-pop" role="menu">
          {items.map((item, idx) => (
            <button
              key={`${item.label}-${idx}`}
              type="button"
              role="menuitem"
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
      )}
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
