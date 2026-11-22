import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { useText } from '../../ui';
import { IconButton } from './IconButton';
import { registerOverlayBackHandler } from './overlayStack';

export type OverlayVariant = 'center' | 'sheet' | 'drawer' | 'fullscreen';

export interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hideTitle?: boolean;
  description?: string;
  variant?: OverlayVariant;
  showClose?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function Overlay({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  variant = 'center',
  showClose,
  children,
  footer,
  className = '',
  ref,
}: OverlayProps) {
  const t = useText();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    return registerOverlayBackHandler(() => onOpenChangeRef.current(false));
  }, [open]);

  const closeVisible = showClose ?? !hideTitle;
  const scrimCls = `ui-overlay-scrim is-${variant}`;
  const contentCls = ['ui-overlay-content', `is-${variant}`, className].filter(Boolean).join(' ');

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={scrimCls} />
        <DialogPrimitive.Content
          ref={ref}
          data-ui-dialog={open ? 'open' : undefined}
          className={contentCls}
          onEscapeKeyDown={event => event.stopPropagation()}
        >
          {variant === 'sheet' ? <div className="ui-overlay-handle" aria-hidden="true" /> : null}
          {hideTitle ? (
            <>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              {closeVisible ? (
                <header className="ui-overlay-header">
                  <span className="ui-overlay-title" aria-hidden="true" />
                  <DialogPrimitive.Close asChild>
                    <IconButton label={t('关闭', 'Close')} size="sm">
                      <X aria-hidden="true" />
                    </IconButton>
                  </DialogPrimitive.Close>
                </header>
              ) : null}
            </>
          ) : (
            <header className="ui-overlay-header">
              <DialogPrimitive.Title className="ui-overlay-title">{title}</DialogPrimitive.Title>
              {closeVisible ? (
                <DialogPrimitive.Close asChild>
                  <IconButton label={t('关闭', 'Close')} size="sm">
                    <X aria-hidden="true" />
                  </IconButton>
                </DialogPrimitive.Close>
              ) : null}
            </header>
          )}
          <DialogPrimitive.Description className="sr-only">{description ?? title}</DialogPrimitive.Description>
          <div className="ui-overlay-body">{children}</div>
          {footer ? <footer className="ui-overlay-footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
