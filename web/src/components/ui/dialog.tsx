import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useText } from '../../ui';
import { ActionBar } from './ActionBar';
import { Button } from './Button';
import { registerOverlayBackHandler } from './overlayStack';
import './components.css';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  sheet?: boolean;
  drawer?: boolean;
  className?: string;
  overlayClassName?: string;
  onBack?(): void;
  actions?: ReactNode;
  onCloseAutoFocus?(event: Event): void;
  closeDisabled?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  sheet = false,
  drawer = false,
  className = '',
  overlayClassName = '',
  onBack,
  actions,
  onCloseAutoFocus,
  closeDisabled = false,
}: DialogProps) {
  const t = useText();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const backHandlerRef = useRef<() => void>(() => {});
  backHandlerRef.current = () => {
    if (closeDisabled) return;
    if (onBack) onBack();
    else onOpenChange(false);
  };

  useIsomorphicLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      if (typeof document !== 'undefined') {
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && !contentRef.current?.contains(active)) {
          previousActiveRef.current = active;
        } else {
          previousActiveRef.current = null;
        }
      }
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return registerOverlayBackHandler(() => backHandlerRef.current());
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={`dialog-overlay${overlayClassName ? ` ${overlayClassName}` : ''}`} />
        <DialogPrimitive.Content
          ref={contentRef}
          data-ui-dialog={open ? 'open' : undefined}
          className={`dialog-content ${sheet ? 'sheet' : drawer ? 'drawer' : ''} ${className}`}
          onEscapeKeyDown={event => {
            event.stopPropagation();
            if (closeDisabled) {
              event.preventDefault();
              return;
            }
            if (onBack) {
              event.preventDefault();
              onBack();
            }
          }}
          onInteractOutside={closeDisabled ? event => event.preventDefault() : undefined}
          onCloseAutoFocus={event => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) {
              previousActiveRef.current = null;
              return;
            }
            if (contentRef.current?.isConnected) return;
            const target = previousActiveRef.current;
            previousActiveRef.current = null;
            if (target && target !== document.body && target.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
          onOpenAutoFocus={event => {
            event.preventDefault();
            requestAnimationFrame(() => contentRef.current?.focus());
          }}
        >
          {sheet && <div className="sheet-handle" aria-hidden="true" />}
          <header className="dialog-header">
            {onBack && (
              <button
                type="button"
                className="icon-button dialog-back"
                aria-label={t('返回', 'Back')}
                disabled={closeDisabled}
                onClick={onBack}
              >
                <ArrowLeft aria-hidden="true" />
              </button>
            )}
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {actions}
            <DialogPrimitive.Close
              className="icon-button"
              aria-label={t('关闭', 'Close')}
              disabled={closeDisabled}
            >
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>
          {description ? null : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          <div className="dialog-body">
            {description ? (
              <DialogPrimitive.Description className="secondary">{description}</DialogPrimitive.Description>
            ) : null}
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  danger,
  busy = false,
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel,
}: ConfirmDialogProps) {
  const t = useText();
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!value && !busy) onCancel();
      }}
      title={title}
      description={description}
      overlayClassName="bs-confirm-overlay"
      className="bs-confirm-dialog"
      closeDisabled={busy}
    >
      <ActionBar align="end" className="ui-confirm-actions">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {cancelLabel ?? t('取消', 'Cancel')}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          loading={busy}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel ?? t('确认', 'Confirm')}
        </Button>
      </ActionBar>
    </Dialog>
  );
}
