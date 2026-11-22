import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useText } from '../../ui';
import { ActionBar } from './ActionBar';
import { Button } from './Button';
import {
  hasOpenFloatingPopover,
  isEventInsideFloatingUi,
  useTopLayerClose,
} from './Overlay';
import './components.css';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  ariaDescribedBy?: string;
  children: ReactNode;
  sheet?: boolean;
  drawer?: boolean;
  className?: string;
  overlayClassName?: string;
  onBack?(): void;
  actions?: ReactNode;
  dismissDisabled?: boolean;
  closeDisabled?: boolean;
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
  closeDisabled = false,
  onCloseAutoFocus,
}: DialogProps) {
  const t = useText();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const isDismissDisabled = Boolean(dismissDisabled || closeDisabled);

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

  useTopLayerClose(open, {
    kind: 'modal',
    getElement: () => contentRef.current,
    canHandleBack: () => !isDismissDisabled,
    blockBackWhenDisabled: isDismissDisabled,
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
        if (!next && isDismissDisabled) return;
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
            if (isDismissDisabled || isEventInsideFloatingUi(event)) {
              event.preventDefault();
            }
          }}
          onFocusOutside={event => {
            if (isEventInsideFloatingUi(event)) {
              event.preventDefault();
            }
          }}
          onInteractOutside={event => {
            if (isDismissDisabled || isEventInsideFloatingUi(event)) {
              event.preventDefault();
            }
          }}
          onEscapeKeyDown={event => {
            if (isDismissDisabled) {
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
                disabled={isDismissDisabled}
                onClick={() => {
                  if (!isDismissDisabled) onBack();
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
              disabled={isDismissDisabled}
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
  description: ReactNode;
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
  const hasDescription =
    description !== undefined && description !== null && description !== false && description !== '';
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!value && !busy) onCancel();
      }}
      title={title}
      ariaDescribedBy={hasDescription ? descId : undefined}
      overlayClassName="bs-confirm-overlay"
      className={confirmDialogClass}
      dismissDisabled={busy}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {hasDescription ? (
        <p id={descId} className="secondary">{description}</p>
      ) : null}
      {error ? (
        <p className="ui-confirm-error" role="alert">{error}</p>
      ) : null}
      <ActionBar align="end" className="ui-confirm-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (!busy) onCancel();
          }}
        >
          {cancelLabel ?? t('取消', 'Cancel')}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          loading={busy}
          disabled={busy || disabled}
          onClick={() => {
            if (!busy && !disabled) onConfirm();
          }}
        >
          {confirmLabel ?? t('确认', 'Confirm')}
        </Button>
      </ActionBar>
    </Dialog>
  );
}
