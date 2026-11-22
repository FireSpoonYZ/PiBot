import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useText } from '../../ui';

export type ConditionDockTone = 'neutral' | 'info' | 'attention' | 'danger' | 'live';

export interface ConditionDockRenderContext {
  hasHeader: boolean;
  multiple: boolean;
  active: boolean;
  collapsed: boolean;
}

export interface ConditionDockItem {
  id: string;
  /** Higher priority renders first (e.g. 100 conflict, 80 prompt/takeover, 60 setup, 40 edit/voice, 30 queue, 10 quote). */
  priority: number;
  tone?: ConditionDockTone;
  label: string;
  badge?: string | number;
  defaultExpanded?: boolean;
  collapsible?: boolean;
  /** Keep mounted invisibly (hidden + inert) without showing dock chrome until ready. */
  hidden?: boolean;
  render: (context?: ConditionDockRenderContext) => ReactNode;
}

export interface ConditionDockProps {
  items: readonly ConditionDockItem[];
  className?: string;
  ariaLabel?: string;
  ref?: Ref<HTMLDivElement>;
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
const HIDDEN_STYLE: CSSProperties = { display: 'none' };

function setElementInert(el: HTMLElement | null, inert: boolean): void {
  if (!el) return;
  (el as HTMLElement & { inert?: boolean }).inert = inert;
  if (inert) {
    el.setAttribute('inert', '');
  } else {
    el.removeAttribute('inert');
  }
}

function sanitizeIdPart(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    ref.current = value;
  }
}

export function ConditionDock({
  items,
  className = '',
  ariaLabel,
  ref,
}: ConditionDockProps) {
  const t = useText();
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastParentRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const singleHeadRef = useRef<HTMLButtonElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const tabRefsMap = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const panelRefsMap = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const focusInPanelIdRef = useRef<string | null>(null);

  // Stable priority-descending sort across all mounted items and visible items.
  const allSorted = useMemo(() => {
    return items
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => (b.item.priority - a.item.priority) || (a.idx - b.idx))
      .map(entry => entry.item);
  }, [items]);

  const sorted = useMemo(
    () => allSorted.filter(item => !item.hidden),
    [allSorted],
  );

  const [activeId, setActiveId] = useState<string | null>(() => sorted[0]?.id ?? null);
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const prevVisibleIdsRef = useRef<Set<string>>(new Set(sorted.map(item => item.id)));

  // Auto-select newly arriving higher-priority visible item, or fall back when active item disappears.
  // Never steals focus from external inputs (e.g., composer textarea).
  useEffect(() => {
    const prevIds = prevVisibleIdsRef.current;
    const nextIds = new Set(sorted.map(item => item.id));
    prevVisibleIdsRef.current = nextIds;

    if (sorted.length === 0) {
      setActiveId(null);
      return;
    }

    const currentActive = sorted.find(item => item.id === activeId) ?? null;
    const newlyArrived = sorted.filter(item => !prevIds.has(item.id));
    const highestNew = newlyArrived[0] ?? null;

    if (!currentActive) {
      setActiveId(sorted[0].id);
      return;
    }

    if (highestNew && highestNew.priority > currentActive.priority) {
      setActiveId(highestNew.id);
      setCollapsedMap(prev => {
        const nextCollapsed = highestNew.defaultExpanded === false;
        if (prev[highestNew.id] === nextCollapsed) return prev;
        return { ...prev, [highestNew.id]: nextCollapsed };
      });
    }
  }, [sorted, activeId]);

  const activeItem = useMemo(
    () => sorted.find(item => item.id === activeId) ?? sorted[0] ?? null,
    [sorted, activeId],
  );

  const hasVisible = Boolean(activeItem);
  const isCollapsible = activeItem ? activeItem.collapsible !== false : false;
  const storedCollapsed = activeItem ? collapsedMap[activeItem.id] : undefined;
  const isCollapsed = !activeItem
    ? true
    : isCollapsible
      ? (storedCollapsed !== undefined ? storedCollapsed : activeItem.defaultExpanded === false)
      : false;

  const setRootNode = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (node?.parentElement) {
        lastParentRef.current = node.parentElement;
      }
      assignRef(ref, node);
    },
    [ref],
  );

  // Keep inactive/collapsed subtrees mounted in memory while enforcing `inert` and safe focus hygiene.
  useIsomorphicLayoutEffect(() => {
    const activeVisibleId = hasVisible && !isCollapsed && activeItem ? activeItem.id : null;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const focusedPanelId = focusInPanelIdRef.current;

    // Recover focus ONLY if focus was inside a dock panel that just became hidden or removed.
    // Never steal focus from the composer textarea or any control outside the dock.
    if (focusedPanelId !== null && focusedPanelId !== activeVisibleId) {
      const focusInsideBody = Boolean(activeEl && bodyRef.current?.contains(activeEl));
      const focusDroppedToBody = activeEl === null || activeEl === document.body;
      if (focusInsideBody || focusDroppedToBody) {
        focusInPanelIdRef.current = null;
        if (activeItem) {
          const targetControl =
            (sorted.length > 1 ? tabRefsMap.current.get(activeItem.id) : singleHeadRef.current) ??
            toggleRef.current;
          targetControl?.focus();
        } else {
          const fallbackInput = lastParentRef.current?.querySelector<HTMLElement>(
            'textarea:not(:disabled), button:not(:disabled)',
          );
          fallbackInput?.focus();
        }
      } else {
        focusInPanelIdRef.current = null;
      }
    }

    setElementInert(bodyRef.current, !activeVisibleId);
    for (const item of allSorted) {
      const panelEl = panelRefsMap.current.get(item.id) ?? null;
      setElementInert(panelEl, item.id !== activeVisibleId);
    }
  }, [allSorted, sorted.length, activeItem, hasVisible, isCollapsed]);

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (sorted.length <= 1) return;
      const move = (nextIndex: number) => {
        const target = sorted[nextIndex];
        if (!target) return;
        setActiveId(target.id);
        if (target.collapsible !== false) {
          setCollapsedMap(prev => (prev[target.id] === false ? prev : { ...prev, [target.id]: false }));
        }
        tabRefsMap.current.get(target.id)?.focus();
      };
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        move((index + 1) % sorted.length);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move((index - 1 + sorted.length) % sorted.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        move(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        move(sorted.length - 1);
      }
    },
    [sorted],
  );

  if (allSorted.length === 0) return null;

  const showHeader = hasVisible && (sorted.length > 1 || isCollapsible);
  const tone: ConditionDockTone = activeItem?.tone ?? 'neutral';
  const tabIdFor = (id: string) => `${baseId}-tab-${sanitizeIdPart(id)}`;
  const panelIdFor = (id: string) => `${baseId}-panel-${sanitizeIdPart(id)}`;
  const singleHeadId = `${baseId}-single-head`;
  const activePanelId = activeItem ? panelIdFor(activeItem.id) : `${baseId}-body`;

  const toggleCollapse = () => {
    if (!activeItem || !isCollapsible) return;
    setCollapsedMap(prev => ({ ...prev, [activeItem.id]: !isCollapsed }));
  };

  const selectItem = (item: ConditionDockItem) => {
    if (!activeItem) return;
    if (item.id === activeItem.id) {
      if (isCollapsible) {
        toggleCollapse();
      }
      return;
    }
    setActiveId(item.id);
    if (item.collapsible !== false) {
      setCollapsedMap(prev => ({ ...prev, [item.id]: false }));
    }
  };

  const cls = [
    'ui-condition-dock',
    `is-${tone}`,
    isCollapsed ? 'is-collapsed' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={setRootNode}
      role={hasVisible ? 'region' : undefined}
      aria-label={hasVisible ? (ariaLabel ?? t('上下文面板', 'Context dock')) : undefined}
      aria-hidden={!hasVisible || undefined}
      hidden={!hasVisible}
      style={hasVisible ? undefined : HIDDEN_STYLE}
      data-tone={tone}
      className={cls}
    >
      {showHeader && activeItem ? (
        <div className="ui-condition-dock-bar">
          {sorted.length > 1 ? (
            <div className="ui-condition-dock-tabs" role="tablist" aria-label={t('待处理项', 'Active items')}>
              {sorted.map((item, index) => {
                const isSelected = item.id === activeItem.id;
                const itemTone = item.tone ?? 'neutral';
                return (
                  <button
                    key={item.id}
                    ref={el => {
                      if (el) tabRefsMap.current.set(item.id, el);
                      else tabRefsMap.current.delete(item.id);
                    }}
                    type="button"
                    role="tab"
                    id={tabIdFor(item.id)}
                    aria-selected={isSelected}
                    aria-controls={panelIdFor(item.id)}
                    tabIndex={isSelected ? 0 : -1}
                    className={`ui-condition-dock-tab is-${itemTone}${isSelected ? ' is-active' : ''}`}
                    onClick={() => selectItem(item)}
                    onKeyDown={event => handleTabKeyDown(event, index)}
                  >
                    <span className="ui-condition-dock-dot" aria-hidden="true" />
                    <span className="ui-condition-dock-tab-label">{item.label}</span>
                    {item.badge !== undefined && item.badge !== '' ? (
                      <span className="ui-condition-dock-badge tabular-nums">{item.badge}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <button
              ref={singleHeadRef}
              id={singleHeadId}
              type="button"
              className="ui-condition-dock-single-head"
              aria-expanded={!isCollapsed}
              aria-controls={activePanelId}
              onClick={toggleCollapse}
            >
              <span className="ui-condition-dock-dot" aria-hidden="true" />
              <span className="ui-condition-dock-tab-label">{activeItem.label}</span>
              {activeItem.badge !== undefined && activeItem.badge !== '' ? (
                <span className="ui-condition-dock-badge tabular-nums">{activeItem.badge}</span>
              ) : null}
            </button>
          )}
          {isCollapsible ? (
            <button
              ref={toggleRef}
              type="button"
              className="ui-condition-dock-toggle"
              aria-expanded={!isCollapsed}
              aria-controls={activePanelId}
              aria-label={isCollapsed ? t('展开', 'Expand') : t('收起', 'Collapse')}
              onClick={toggleCollapse}
            >
              {isCollapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={bodyRef}
        id={`${baseId}-body`}
        className="ui-condition-dock-body"
        hidden={!hasVisible || isCollapsed}
        style={hasVisible && !isCollapsed ? undefined : HIDDEN_STYLE}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            focusInPanelIdRef.current = null;
          }
        }}
      >
        {allSorted.map(item => {
          const isActive = Boolean(activeItem && item.id === activeItem.id && !item.hidden);
          const isVisible = isActive && !isCollapsed;
          const isTabPanel = !item.hidden && sorted.length > 1;
          return (
            <div
              key={item.id}
              ref={el => {
                if (el) panelRefsMap.current.set(item.id, el);
                else panelRefsMap.current.delete(item.id);
              }}
              id={panelIdFor(item.id)}
              role={isTabPanel ? 'tabpanel' : undefined}
              aria-labelledby={isTabPanel ? tabIdFor(item.id) : (showHeader && isActive ? singleHeadId : undefined)}
              className="ui-condition-dock-panel"
              hidden={!isVisible}
              style={isVisible ? undefined : HIDDEN_STYLE}
              onFocusCapture={() => {
                focusInPanelIdRef.current = item.id;
              }}
            >
              {item.render({
                hasHeader: showHeader,
                multiple: sorted.length > 1,
                active: isActive,
                collapsed: isCollapsed,
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
