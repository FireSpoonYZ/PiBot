import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronRight, Copy, MoreHorizontal, X } from 'lucide-react';
import { openExternalUrl } from './openExternalUrl';
import { QrSvg } from './qrSvg';
import type { CenterBotRef, CenterDevice } from './types';

export { openExternalUrl };

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

export function formatTime(isoOrMs: string | number | null | undefined): string {
  if (!isoOrMs) return '—';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return String(isoOrMs);
  return d.toLocaleString('zh-CN', {
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

export function platformLabel(platform?: string | null): string {
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
      return platform || '未知平台';
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div className="ca-modal-portal">
          <Dialog.Overlay className="ca-dialog-overlay" />
          <Dialog.Content
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
                  <Dialog.Description className="ca-dialog-desc" style={{ display: 'none' }}>
                    {title}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <button type="button" className="ca-btn ca-btn-ghost ca-btn-icon" aria-label="关闭">
                  <X size={16} />
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
      <span className="ca-switch-thumb" />
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
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="ca-segmented" role="tablist">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`ca-seg-btn ${value === opt.value ? 'is-active' : ''}`}
          onClick={() => onChange(opt.value)}
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
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="ca-chips">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
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
  copyLabel = '复制',
}: {
  url: string;
  onOpenUrl?: (url: string) => void | Promise<unknown>;
  onError?: (err: unknown) => void;
  copyLabel?: string;
}): React.JSX.Element {
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
      <CopyButton value={url} label={copyLabel} />
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
      <button type="button" className="ca-disclosure-btn" onClick={() => setOpen(prev => !prev)}>
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
        <div className="ca-card-disclosure-text">
          <span className="ca-field-label">{title}</span>
          {subtitle && !open ? <span className="ca-muted">{subtitle}</span> : null}
        </div>
        <ChevronRight size={15} className={`ca-card-disclosure-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && <div className="ca-card-disclosure-body">{children}</div>}
    </div>
  );
}

export function CopyButton({
  value,
  label = '复制',
  copiedLabel = '已复制',
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <button type="button" className="ca-btn ca-btn-secondary ca-btn-sm" onClick={() => void handleCopy()}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? copiedLabel : label}</span>
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
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="ca-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="ca-btn ca-btn-ghost ca-btn-icon"
        aria-label="更多操作"
        aria-expanded={open}
        onClick={e => {
          e.stopPropagation();
          setOpen(prev => !prev);
        }}
      >
        <MoreHorizontal size={16} />
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
  emptyText = '暂无在线或已注册设备的智能体',
}: BotTreeSelectorProps): React.JSX.Element {
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
    return <div className="ca-empty-hint">{emptyText}</div>;
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
                {device.platform && <span className="ca-pill ca-pill-muted">{platformLabel(device.platform)}</span>}
              </div>
              <span className="ca-muted ca-num">{list.length} 个 Bot</span>
            </div>
            <div className="ca-tree-bots">
              {list.map(bot => {
                const key = botKey(device.deviceId, bot.botId);
                const checked = selectedKeys.has(key);
                const busy = busyKeys?.has(key) ?? false;
                return (
                  <div key={key} className="ca-tree-bot-row">
                    <label className="ca-check-label" style={{ flex: 1, minWidth: 0 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || busy}
                        onChange={e => onToggleBot(device.deviceId, bot.botId, e.target.checked)}
                      />
                      <span style={{ fontWeight: 500 }}>{bot.name || bot.botId}</span>
                      {bot.isPrimary && <span className="ca-pill ca-pill-info">主</span>}
                      {bot.resolvedModel?.effectiveModelName && (
                        <span className="ca-muted" style={{ marginLeft: 4 }}>
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
