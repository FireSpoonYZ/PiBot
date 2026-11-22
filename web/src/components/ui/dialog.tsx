import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { useText } from '../../ui';
import {
  hasOpenFloatingPopover,
  isEventInsideFloatingUi,
  useTopLayerClose,
} from './Overlay';

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  ariaDescribedBy?: string;
  children: ReactNode;
  sheet?: boolean;
  drawer?: boolean;
  className?: string;
  overlayClassName?: string;
  onBack?(): void;
  actions?: ReactNode;
  dismissDisabled?: boolean;
  onCloseAutoFocus?(event: Event): void;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  ariaDescribedBy,
  children,
  sheet = false,
  drawer = false,
  className = '',
  overlayClassName = '',
  onBack,
  actions,
  dismissDisabled = false,
  onCloseAutoFocus,
}: DialogProps) {
  const t = useText();
  const contentRef = useRef<HTMLDivElement>(null);

  useTopLayerClose(open, {
    kind: 'modal',
    getElement: () => contentRef.current,
    canHandleBack: () => !dismissDisabled,
    blockBackWhenDisabled: dismissDisabled,
    onClose: () => {
      if (onBack) onBack();
      else onOpenChange(false);
    },
  });

  const describedByProps = description
    ? {}
    : { 'aria-describedby': ariaDescribedBy };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={next => {
        if (!next && dismissDisabled) return;
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={`dialog-overlay${overlayClassName ? ` ${overlayClassName}` : ''}`} />
        <DialogPrimitive.Content
          ref={contentRef}
          data-ui-dialog={open ? 'open' : undefined}
          className={`dialog-content ${sheet ? 'sheet' : drawer ? 'drawer' : ''} ${className}`}
          {...describedByProps}
          onPointerDownOutside={event => {
            if (dismissDisabled || isEventInsideFloatingUi(event)) {
              event.preventDefault();
            }
          }}
          onFocusOutside={event => {
            if (isEventInsideFloatingUi(event)) {
              event.preventDefault();
            }
          }}
          onInteractOutside={event => {
            if (dismissDisabled || isEventInsideFloatingUi(event)) {
              event.preventDefault();
            }
          }}
          onEscapeKeyDown={event => {
            if (dismissDisabled) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (hasOpenFloatingPopover(contentRef.current)) {
              event.preventDefault();
              return;
            }
            event.stopPropagation();
            if (onBack) {
              event.preventDefault();
              onBack();
            }
          }}
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
                disabled={dismissDisabled}
                onClick={() => {
                  if (!dismissDisabled) onBack();
                }}
              >
                <ArrowLeft aria-hidden="true" />
              </button>
            )}
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {actions}
            <DialogPrimitive.Close
              className="icon-button"
              aria-label={t('关闭', 'Close')}
              disabled={dismissDisabled}
            >
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>
          {description ? (
            <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          ) : null}
          <div className="dialog-body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  danger?: boolean;
  onCancel(): void;
  onConfirm(): void;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onCloseAutoFocus?: (event: Event) => void;
  contentClassName?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  danger,
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel,
  busy = false,
  disabled = false,
  error,
  onCloseAutoFocus,
  contentClassName = '',
}: ConfirmDialogProps) {
  const t = useText();
  const descId = useId();
  const confirmDialogClass = ['bs-confirm-dialog', contentClassName].filter(Boolean).join(' ');
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!value && !busy) onCancel();
      }}
      title={title}
      ariaDescribedBy={description ? descId : undefined}
      overlayClassName="bs-confirm-overlay"
      className={confirmDialogClass}
      dismissDisabled={busy}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <p id={descId} className="secondary">{description}</p>
      {error ? (
        <p className="ui-confirm-error" role="alert">{error}</p>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary-button"
          disabled={busy}
          onClick={() => {
            if (!busy) onCancel();
          }}
        >
          {cancelLabel ?? t('取消', 'Cancel')}
        </button>
        <button
          type="button"
          className={danger ? 'button danger-button' : 'button'}
          disabled={busy || disabled}
          aria-busy={busy || undefined}
          onClick={() => {
            if (!busy && !disabled) onConfirm();
          }}
        >
          {confirmLabel ?? t('确认', 'Confirm')}
        </button>
      </div>
    </Dialog>
  );
}
