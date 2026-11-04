import type React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export interface SheetModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}

export function SheetModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = 'md',
}: SheetModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className={`sheet-content ${size === 'lg' ? 'sheet-lg' : 'sheet-md'}`}>
          <div className="sheet-handle" aria-hidden="true" />
          <header className="sheet-header">
            <div>
              <Dialog.Title className="sheet-title">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="sheet-description">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button type="button" className="quiet-button icon-button" aria-label="关闭">
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default SheetModal;
