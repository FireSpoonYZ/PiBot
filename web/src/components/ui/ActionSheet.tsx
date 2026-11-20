import type { ReactNode, Ref } from 'react';
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
    >
      <div className="ui-action-sheet-list" role="menu">
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`ui-action-sheet-item${item.danger ? ' is-danger' : ''}`}
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
