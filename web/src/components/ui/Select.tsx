import { Check, ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getViewportSafeBounds,
  useTopLayerClose,
  useViewportInsetEffect,
} from './Overlay';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  ariaLabel: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

const VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 6;
const TYPEAHEAD_RESET_MS = 500;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    ref.current = value;
  }
}

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  id,
  placeholder,
  disabled = false,
  size = 'md',
  className = '',
  ref,
}: SelectProps<V>) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [listboxStyle, setListboxStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedIndex = useMemo(
    () => options.findIndex(opt => opt.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const setTriggerNode = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, []);

  const findNextEnabled = useCallback(
    (startIndex: number, step: 1 | -1): number => {
      const count = options.length;
      if (count === 0) return -1;
      for (let offset = 1; offset <= count; offset += 1) {
        const idx = (startIndex + step * offset + count) % count;
        if (!options[idx].disabled) return idx;
      }
      return -1;
    },
    [options],
  );

  const findBoundaryEnabled = useCallback(
    (fromEnd: boolean): number => {
      if (fromEnd) {
        for (let i = options.length - 1; i >= 0; i -= 1) {
          if (!options[i].disabled) return i;
        }
        return -1;
      }
      return options.findIndex(opt => !opt.disabled);
    },
    [options],
  );

  const runTypeahead = useCallback(
    (char: string, commitDirectly: boolean) => {
      if (typeaheadTimerRef.current !== null) {
        clearTimeout(typeaheadTimerRef.current);
      }
      typeaheadRef.current += char.toLowerCase();
      typeaheadTimerRef.current = setTimeout(() => {
        typeaheadRef.current = '';
        typeaheadTimerRef.current = null;
      }, TYPEAHEAD_RESET_MS);

      const query = typeaheadRef.current;
      const start = Math.max(0, activeIndex >= 0 ? activeIndex : selectedIndex);
      const count = options.length;
      for (let offset = 0; offset < count; offset += 1) {
        const idx = (start + offset) % count;
        const opt = options[idx];
        if (!opt.disabled && opt.label.toLowerCase().startsWith(query)) {
          if (commitDirectly) {
            onChange(opt.value);
          } else {
            setActiveIndex(idx);
            optionRefs.current[idx]?.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
      }
    },
    [activeIndex, onChange, options, selectedIndex],
  );

  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current !== null) {
        clearTimeout(typeaheadTimerRef.current);
      }
    };
  }, []);

  const computePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const listboxEl = listboxRef.current;
    if (!triggerEl || !listboxEl || typeof window === 'undefined') return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bounds = getViewportSafeBounds(VIEWPORT_MARGIN);
    const spaceBelow = vh - bounds.bottom - triggerRect.bottom - POPOVER_GAP;
    const spaceAbove = triggerRect.top - bounds.top - POPOVER_GAP;

    const measuredHeight = Math.min(listboxEl.scrollHeight + 12, 300);
    const placeAbove = measuredHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      100,
      Math.min(300, bounds.height - POPOVER_GAP, Math.max(100, placeAbove ? spaceAbove : spaceBelow)),
    );

    const renderedHeight = Math.min(measuredHeight, maxHeight);
    const rawTop = placeAbove
      ? triggerRect.top - POPOVER_GAP - renderedHeight
      : triggerRect.bottom + POPOVER_GAP;
    const maxTop = Math.max(bounds.top, vh - bounds.bottom - renderedHeight);
    const top = Math.min(Math.max(bounds.top, rawTop), maxTop);

    const maxWidth = Math.max(160, bounds.width);
    const width = Math.min(Math.max(triggerRect.width, 160), maxWidth);
    const left = Math.min(
      Math.max(bounds.left, triggerRect.left),
      Math.max(bounds.left, vw - bounds.right - width),
    );

    setListboxStyle({
      position: 'fixed',
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      minWidth: `${Math.round(Math.min(triggerRect.width, maxWidth))}px`,
      maxWidth: `${Math.round(maxWidth)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
      transformOrigin: placeAbove ? 'bottom left' : 'top left',
      visibility: 'visible',
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    const initial =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : findBoundaryEnabled(false);
    setActiveIndex(initial);

    const rafId = requestAnimationFrame(() => {
      computePosition();
      listboxRef.current?.focus();
      if (initial >= 0) {
        optionRefs.current[initial]?.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [open, selectedIndex, options, findBoundaryEnabled, computePosition]);

  useTopLayerClose(open, {
    kind: 'floating',
    getElement: () => listboxRef.current,
    onClose: () => close(true),
  });

  useViewportInsetEffect(computePosition, open);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (listboxRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      close(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, close]);

  const commitIndex = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      close(true);
    },
    [close, onChange, options],
  );

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        runTypeahead(event.key, true);
      }
    },
    [close, disabled, open, runTypeahead],
  );

  const handleListboxKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === 'Tab') {
        close(false);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = findNextEnabled(activeIndex >= 0 ? activeIndex : -1, 1);
        if (next >= 0) {
          setActiveIndex(next);
          optionRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = findNextEnabled(activeIndex >= 0 ? activeIndex : 0, -1);
        if (prev >= 0) {
          setActiveIndex(prev);
          optionRefs.current[prev]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (event.key === 'Home') {
        event.preventDefault();
        const first = findBoundaryEnabled(false);
        if (first >= 0) {
          setActiveIndex(first);
          optionRefs.current[first]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (event.key === 'End') {
        event.preventDefault();
        const last = findBoundaryEnabled(true);
        if (last >= 0) {
          setActiveIndex(last);
          optionRefs.current[last]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (activeIndex >= 0) {
          commitIndex(activeIndex);
        }
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        runTypeahead(event.key, false);
      }
    },
    [activeIndex, close, commitIndex, findBoundaryEnabled, findNextEnabled, runTypeahead],
  );

  const activeOptionId = activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;
  const triggerCls = [
    'ui-select-trigger',
    size === 'sm' ? 'is-sm' : '',
    open ? 'is-open' : '',
    !selectedOption ? 'is-placeholder' : '',
    className,
  ].filter(Boolean).join(' ');

  const portalTarget = typeof document !== 'undefined' ? document.body : null;

  return (
    <>
      <button
        ref={setTriggerNode}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className={triggerCls}
        onClick={() => {
          if (!disabled) setOpen(prev => !prev);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="ui-select-value">
          {selectedOption ? selectedOption.label : (placeholder ?? '')}
        </span>
        <ChevronDown className="ui-select-chevron" aria-hidden="true" />
      </button>

      {open && portalTarget
        ? createPortal(
            <div
              ref={listboxRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              aria-activedescendant={activeOptionId}
              tabIndex={-1}
              data-ui-dialog="open"
              data-floating-ui="true"
              className="ui-select-listbox"
              style={listboxStyle}
              onKeyDown={handleListboxKeyDown}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;
                return (
                  <div
                    key={option.value}
                    ref={el => { optionRefs.current[index] = el; }}
                    id={`${listboxId}-opt-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={[
                      'ui-select-option',
                      isSelected ? 'is-selected' : '',
                      isActive ? 'is-active' : '',
                      option.disabled ? 'is-disabled' : '',
                    ].filter(Boolean).join(' ')}
                    onMouseEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onClick={() => {
                      if (!option.disabled) commitIndex(index);
                    }}
                  >
                    <span className="ui-select-option-text">
                      <span className="ui-select-option-label">{option.label}</span>
                      {option.description ? (
                        <span className="ui-select-option-desc">{option.description}</span>
                      ) : null}
                    </span>
                    <span className="ui-select-option-check" aria-hidden="true">
                      {isSelected ? <Check aria-hidden="true" /> : null}
                    </span>
                  </div>
                );
              })}
            </div>,
            portalTarget,
          )
        : null}
    </>
  );
}
