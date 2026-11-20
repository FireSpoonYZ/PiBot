import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useText } from '../../ui';

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
}: {
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
}) {
  const t = useText();
  const contentRef = useRef<HTMLDivElement>(null);

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
      if (onBack) onBack();
      else onOpenChange(false);
    };
    window.addEventListener('app-back', handleBack, true);
    return () => window.removeEventListener('app-back', handleBack, true);
  }, [open, onBack, onOpenChange]);

  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={`dialog-overlay${overlayClassName ? ` ${overlayClassName}` : ''}`} />
      <DialogPrimitive.Content
        ref={contentRef}
        data-ui-dialog={open ? 'open' : undefined}
        className={`dialog-content ${sheet ? 'sheet' : drawer ? 'drawer' : ''} ${className}`}
        onEscapeKeyDown={event => { event.stopPropagation(); if (onBack) { event.preventDefault(); onBack(); } }}
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => contentRef.current?.focus()); }}
      >
        {sheet && <div className="sheet-handle" aria-hidden="true" />}
        <header className="dialog-header">{onBack && <button type="button" className="icon-button dialog-back" aria-label={t('返回','Back')} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>}<DialogPrimitive.Title>{title}</DialogPrimitive.Title>{actions}<DialogPrimitive.Close className="icon-button" aria-label={t('关闭','Close')}><X aria-hidden="true" /></DialogPrimitive.Close></header>
        <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        <div className="dialog-body">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
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
}: {
  open: boolean;
  title: string;
  description: string;
  danger?: boolean;
  onCancel(): void;
  onConfirm(): void;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  const t = useText();
  return <Dialog open={open} onOpenChange={value => !value && onCancel()} title={title} overlayClassName="bs-confirm-overlay" className="bs-confirm-dialog">
    <p className="secondary">{description}</p><div className="dialog-actions"><button type="button" className="button secondary-button" onClick={onCancel}>{cancelLabel ?? t('取消','Cancel')}</button><button type="button" className={danger ? 'button danger-button' : 'button'} onClick={onConfirm}>{confirmLabel ?? t('确认','Confirm')}</button></div>
  </Dialog>;
}
