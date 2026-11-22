import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useText } from '../../ui';
import { Overlay } from './Overlay';

export interface ActionSheetItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ActionSheetProps {
  items: readonly ActionSheetItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  className?: string;
  onCloseAutoFocus?: (event: Event) => void;
  ref?: Ref<HTMLDivElement>;
}

export function ActionSheet({
  items,
  open,
  onOpenChange,
  title,
  className = '',
  onCloseAutoFocus,
  ref,
}: ActionSheetProps) {
  const t = useText();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const firstEnabledIndex = items.findIndex(item => !item.disabled);
  const [activeIndex, setActiveIndex] = useState(firstEnabledIndex >= 0 ? firstEnabledIndex : 0);

  useEffect(() => {
    if (!open) return;
    const next = items.findIndex(item => !item.disabled);
    setActiveIndex(next >= 0 ? next : 0);
  }, [open, items]);

  const focusStep = useCallback(
    (startIndex: number, step: 1 | -1) => {
      const count = items.length;
      if (count === 0) return;
      for (let offset = 1; offset <= count; offset += 1) {
        const next = (startIndex + step * offset + count) % count;
        if (!items[next].disabled) {
          setActiveIndex(next);
          itemRefs.current[next]?.focus();
          return;
        }
      }
    },
    [items],
  );

  const focusBoundary = useCallback(
    (fromEnd: boolean) => {
      if (fromEnd) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (!items[i].disabled) {
            setActiveIndex(i);
            itemRefs.current[i]?.focus();
            return;
          }
        }
      } else {
        const first = items.findIndex(item => !item.disabled);
        if (first >= 0) {
          setActiveIndex(first);
          itemRefs.current[first]?.focus();
        }
      }
    },
    [items],
  );

  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusStep(index, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusStep(index, -1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusBoundary(false);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusBoundary(true);
      }
    },
    [focusStep, focusBoundary],
  );

  const cls = ['ui-action-sheet', className].filter(Boolean).join(' ');

  return (
    <Overlay
      ref={ref}
      open={open}
      onOpenChange={onOpenChange}
      variant="sheet"
      title={title ?? t('操作菜单', 'Actions')}
      hideTitle={!title}
      showClose={false}
      className={cls}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="ui-action-sheet-list" role="menu">
        {items.map((item, index) => (
          <button
            key={item.key}
            ref={el => { itemRefs.current[index] = el; }}
            type="button"
            role="menuitem"
            tabIndex={!item.disabled && index === activeIndex ? 0 : -1}
            disabled={item.disabled}
            className={`ui-action-sheet-item${item.danger ? ' is-danger' : ''}`}
            onFocus={() => {
              if (!item.disabled) setActiveIndex(index);
            }}
            onKeyDown={event => handleMenuKeyDown(event, index)}
            onClick={() => {
              if (item.disabled) return;
              onOpenChange(false);
              item.onSelect();
            }}
          >
            {item.icon ? <span className="ui-action-sheet-icon" aria-hidden="true">{item.icon}</span> : null}
            <span className="ui-action-sheet-label">{item.label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="ui-action-sheet-cancel"
        onClick={() => onOpenChange(false)}
      >
        {t('取消', 'Cancel')}
      </button>
    </Overlay>
  );
}
