import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
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
  ref?: Ref<HTMLDivElement>;
}

export function ActionSheet({
  items,
  open,
  onOpenChange,
  title,
  className = '',
  ref,
}: ActionSheetProps) {
  const t = useText();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cls = ['ui-action-sheet', className].filter(Boolean).join(' ');

  const focusStep = (startIndex: number, step: 1 | -1) => {
    const count = items.length;
    for (let offset = 1; offset <= count; offset += 1) {
      const next = (startIndex + step * offset + count) % count;
      if (!items[next].disabled) {
        itemRefs.current[next]?.focus();
        return;
      }
    }
  };

  const handleItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusStep(index, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusStep(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = items.findIndex(item => !item.disabled);
      if (first >= 0) itemRefs.current[first]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (!items[i].disabled) {
          itemRefs.current[i]?.focus();
          return;
        }
      }
    }
  };

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
    >
      <div className="ui-action-sheet-list" role="menu">
        {items.map((item, index) => (
          <button
            key={item.key}
            ref={el => { itemRefs.current[index] = el; }}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`ui-action-sheet-item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              if (item.disabled) return;
              onOpenChange(false);
              item.onSelect();
            }}
            onKeyDown={event => handleItemKeyDown(event, index)}
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
