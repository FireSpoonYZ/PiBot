import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useText } from '../../ui';
import { ActionBar } from './ActionBar';
import { Button } from './Button';
import { registerOverlayBackHandler } from './overlayStack';
import './components.css';

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
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
  const backHandlerRef = useRef<() => void>(() => {});
  backHandlerRef.current = () => {
    if (closeDisabled) return;
    if (onBack) onBack();
    else onOpenChange(false);
  };

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
          onCloseAutoFocus={onCloseAutoFocus}
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
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          <div className="dialog-body">{children}</div>
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
      overlayClassName="bs-confirm-overlay"
      className="bs-confirm-dialog"
      closeDisabled={busy}
    >
      <p className="secondary">{description}</p>
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
