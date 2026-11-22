// Bot 设置（模型 / 插件技能 MCP / 高级）三个手机端页面共用的极简 UI 原语。
// 所有样式以 .bs- 前缀限定在 bot-settings.css 中，不影响其它页面与桌面端。
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Loader2, Lock, Search, X } from 'lucide-react';
import { Switch as UiSwitch } from '../components/ui';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import { useText } from '../ui';
import './bot-settings.css';

/* ------------------------------------------------------------------ */
/* Sheet 外壳                                                          */
/* ------------------------------------------------------------------ */

interface BackEntry {
  fn: () => void;
}

interface SettingsSheetContextValue {
  registerBack: (entry: BackEntry) => () => void;
}

const SettingsSheetContext = createContext<SettingsSheetContextValue | null>(null);

/**
 * 在 SettingsSheet 内的二级子视图注册返回回调。
 * 返回 true 表示当前位于 SettingsSheet 中（由 Sheet 头部统一显示返回箭头并接管 Esc / 系统返回）。
 */
export function useSettingsSheetBack(handler: (() => void) | null): boolean {
  const ctx = useContext(SettingsSheetContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const active = Boolean(handler);

  useEffect(() => {
    if (!ctx || !active) return;
    const entry: BackEntry = { fn: () => handlerRef.current?.() };
    return ctx.registerBack(entry);
  }, [ctx, active]);

  return Boolean(ctx);
}

export interface SettingsSheetProps {
  title: string;
  /** 标题下方一行弱化说明（可选）。 */
  subtitle?: ReactNode;
  onClose(): void;
  /** 提供时在左上角显示返回箭头（用于页面内二级视图）。Esc 与系统返回优先触发返回。 */
  onBack?: () => void;
  /** 固定在底部的操作区（通常是 SaveBar）。 */
  footer?: ReactNode;
  children: ReactNode;
}

/** 底部弹出的全高设置面板：抓手 + 居中标题 + 关闭，内容区滚动，底部操作区固定。 */
export function SettingsSheet({ title, subtitle, onClose, onBack, footer, children }: SettingsSheetProps) {
  const t = useText();
  const sheetRef = useRef<HTMLElement | null>(null);
  const [backStack, setBackStack] = useState<BackEntry[]>([]);
  const registerBack = useCallback((entry: BackEntry) => {
    setBackStack(prev => [...prev, entry]);
    return () => {
      setBackStack(prev => prev.filter(item => item !== entry));
    };
  }, []);
  const contextValue = useMemo(() => ({ registerBack }), [registerBack]);
  const effectiveOnBack = backStack.length > 0 ? backStack[backStack.length - 1].fn : onBack;
  const effectiveOnBackRef = useRef(effectiveOnBack);
  effectiveOnBackRef.current = effectiveOnBack;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rafId = window.requestAnimationFrame(() => {
      const sheet = sheetRef.current;
      if (sheet && !sheet.contains(document.activeElement)) {
        sheet.focus({ preventScroll: true });
      }
    });
    return () => {
      window.cancelAnimationFrame(rafId);
      if (previouslyFocused && previouslyFocused !== document.body && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    return registerOverlayBackHandler(() => {
      (effectiveOnBackRef.current ?? onCloseRef.current)();
    });
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const hasOpenModal = () =>
      Boolean(document.querySelector('[role="dialog"][data-state="open"], [data-ui-dialog="open"]'));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (hasOpenModal()) return;
      event.preventDefault();
      event.stopPropagation();
      (effectiveOnBackRef.current ?? onCloseRef.current)();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const content = (
    <SettingsSheetContext.Provider value={contextValue}>
      <div
        className="bs-backdrop"
        role="presentation"
        onClick={event => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <section
          ref={sheetRef}
          tabIndex={-1}
          className="bs-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key === 'Escape') event.stopPropagation();
          }}
        >
          <div className="bs-grabber" aria-hidden="true" />
          <header className="bs-header">
            <div className="bs-header-side">
              {effectiveOnBack ? (
                <button type="button" className="bs-icon-btn" aria-label={t('返回', 'Back')} onClick={effectiveOnBack}>
                  <ArrowLeft aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="bs-header-title">
              <h2>{title}</h2>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
            <div className="bs-header-side is-end">
              <button type="button" className="bs-icon-btn" aria-label={t('关闭', 'Close')} onClick={onClose}>
                <X aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="bs-body">{children}</div>
          {footer ? <footer className="bs-footer">{footer}</footer> : null}
        </section>
      </div>
    </SettingsSheetContext.Provider>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}

/* ------------------------------------------------------------------ */
/* 分组与行                                                            */
/* ------------------------------------------------------------------ */

export interface SectionProps {
  title?: ReactNode;
  /** 标题右侧的轻量操作（如“全部 / 插件”筛选、文字按钮）。 */
  action?: ReactNode;
  /** 分组下方的弱化说明。 */
  hint?: ReactNode;
  /** true 时不包卡片，直接渲染 children（用于 Chips、Segmented 等自带外观的控件）。 */
  bare?: boolean;
  children: ReactNode;
}

export function Section({ title, action, hint, bare = false, children }: SectionProps) {
  return (
    <section className="bs-section">
      {title || action ? (
        <div className="bs-section-head">
          {title ? <h3 className="bs-section-title">{title}</h3> : <span />}
          {action ? <div className="bs-section-action">{action}</div> : null}
        </div>
      ) : null}
      {bare ? children : <div className="bs-card">{children}</div>}
      {hint ? <p className="bs-section-hint">{hint}</p> : null}
    </section>
  );
}

export interface RowProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 右侧附件（Badge、Switch、数值文字等）。 */
  trailing?: ReactNode;
  /** 有 onClick 时整行可点；若同时有 trailing，则主体与 trailing 分区，避免按钮嵌套。 */
  onClick?: () => void;
  /** 单选行：显示对勾并以 role=radio 暴露选中态。 */
  radio?: boolean;
  selected?: boolean;
  /** 右侧显示 > 箭头，表示进入下一级。 */
  chevron?: boolean;
  disabled?: boolean;
  /** 弱化（如全局未启用的能力）。 */
  muted?: boolean;
  ariaLabel?: string;
}

export function Row({ icon, title, subtitle, trailing, onClick, radio = false, selected = false, chevron = false, disabled = false, muted = false, ariaLabel }: RowProps) {
  const body = (
    <>
      {icon ? <span className="bs-row-icon" aria-hidden="true">{icon}</span> : null}
      <span className="bs-row-text">
        <span className="bs-row-title">{title}</span>
        {subtitle ? <span className="bs-row-sub">{subtitle}</span> : null}
      </span>
    </>
  );
  const marks = (
    <>
      {radio ? <span className={`bs-row-check${selected ? ' is-on' : ''}`} aria-hidden="true">{selected ? <Check aria-hidden="true" /> : null}</span> : null}
      {chevron ? <ChevronRight className="bs-row-chevron" aria-hidden="true" /> : null}
    </>
  );
  const cls = `bs-row${selected ? ' is-selected' : ''}${muted ? ' is-muted' : ''}${onClick ? ' is-clickable' : ''}`;
  // 有 trailing 时主体按钮与 trailing 分区，避免 radio 行 trailing 内含按钮时形成嵌套按钮；单选对勾保持在最右侧。
  if (onClick && trailing) {
    return (
      <div className={`${cls} is-split${radio ? ' is-radio' : ''}`}>
        <button
          type="button"
          className="bs-row-main"
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          {...(radio ? { role: 'radio', 'aria-checked': selected } : {})}
        >
          {body}
          {!radio ? marks : null}
        </button>
        <div className="bs-row-trailing">{trailing}</div>
        {radio ? marks : null}
      </div>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        {...(radio ? { role: 'radio', 'aria-checked': selected } : {})}
      >
        {body}
        {trailing ? <span className="bs-row-trailing">{trailing}</span> : null}
        {marks}
      </button>
    );
  }
  return (
    <div className={cls} aria-label={ariaLabel}>
      {body}
      {trailing ? <span className="bs-row-trailing">{trailing}</span> : null}
      {marks}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 控件                                                                */
/* ------------------------------------------------------------------ */

export interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
}

/** iOS 风格拨动开关（role=switch）。点击不会冒泡到所在行。 */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <UiSwitch
      checked={checked}
      onCheckedChange={onChange}
      label={label}
      disabled={disabled}
      onClick={event => event.stopPropagation()}
    />
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: ReactNode;
  /** 选项下方的极短补充（如“跟随默认”时显示默认值）。 */
  hint?: ReactNode;
}

export interface ChoiceProps<V extends string> {
  /** 当前值；为 undefined 或不在选项内时表示“无选中”。 */
  value: V | undefined;
  options: ChoiceOption<V>[];
  onChange(value: V): void;
  label: string;
  disabled?: boolean;
}

/** 等宽分段控件（2~4 项）。 */
export function Segmented<V extends string>({ value, options, onChange, label, disabled = false }: ChoiceProps<V>) {
  return (
    <div className="bs-segmented" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'is-active' : undefined}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          <span className="bs-segmented-label">{option.label}</span>
          {option.hint ? <span className="bs-segmented-hint">{option.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 可换行的胶囊单选组（选项较多时使用，例如思考强度、能力类型筛选）。 */
export function Chips<V extends string>({ value, options, onChange, label, disabled = false }: ChoiceProps<V>) {
  return (
    <div className="bs-chips" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`bs-chip${value === option.value ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.hint ? <span className="bs-chip-hint">{option.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange(value: string): void; placeholder: string }) {
  const t = useText();
  return (
    <label className="bs-search">
      <Search aria-hidden="true" />
      <input type="search" value={value} placeholder={placeholder} aria-label={placeholder} onChange={event => onChange(event.target.value)} />
      {value ? (
        <button type="button" className="bs-search-clear" aria-label={t('清除', 'Clear')} onClick={() => onChange('')}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`bs-badge is-${tone}`}>{children}</span>;
}

/** 状态圆点 + 文字，用于设备在线、应用状态等一行摘要。 */
export function StatusLine({ tone = 'neutral', children, trailing }: { tone?: BadgeTone; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className={`bs-status is-${tone}`} role="status">
      <span className="bs-status-dot" aria-hidden="true" />
      <span className="bs-status-text">{children}</span>
      {trailing ? <span className="bs-status-trailing">{trailing}</span> : null}
    </div>
  );
}

/** 折叠区：默认收起，用于诊断、配置来源等低频信息。 */
export function Disclosure({
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`bs-disclosure${open ? ' is-open' : ''}`}>
      <button type="button" className="bs-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <span>{title}</span>
        <span className="bs-disclosure-right">
          {summary ? <span className="bs-disclosure-summary">{summary}</span> : null}
          <ChevronDown className="bs-disclosure-chevron" aria-hidden="true" />
        </span>
      </button>
      {open ? <div id={id} className="bs-disclosure-body">{children}</div> : null}
    </div>
  );
}

/** 键值列表（放在 Disclosure 或卡片中展示只读信息）。 */
export function KeyValueList({ items }: { items: { key: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="bs-kv">
      {items.map(item => (
        <div className="bs-kv-item" key={item.key}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* 状态块                                                              */
/* ------------------------------------------------------------------ */

export function LoadingState({ text }: { text?: string }) {
  const t = useText();
  return (
    <div className="bs-state" role="status">
      <Loader2 className="bs-spin" aria-hidden="true" />
      <span>{text ?? t('正在加载…', 'Loading…')}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="bs-state">
      {icon ? <span className="bs-state-icon" aria-hidden="true">{icon}</span> : null}
      <span className="bs-state-title">{title}</span>
      {hint ? <span className="bs-state-hint">{hint}</span> : null}
      {action ? <div className="bs-state-action">{action}</div> : null}
    </div>
  );
}

export interface LoginCardProps {
  /** 额外说明（例如“管理该 Bot 的能力需要管理员身份”）。 */
  message?: ReactNode;
  busy?: boolean;
  /** 提交时输入框会立即清空，密码只经由参数传出。 */
  onSubmit(password: string): void;
}

export function LoginCard({ message, busy = false, onSubmit }: LoginCardProps) {
  const t = useText();
  const [password, setPassword] = useState('');
  const id = useId();
  return (
    <form
      className="bs-login"
      onSubmit={event => {
        event.preventDefault();
        const secret = password;
        setPassword('');
        onSubmit(secret);
      }}
    >
      <span className="bs-login-icon" aria-hidden="true"><Lock aria-hidden="true" /></span>
      <p className="bs-login-title">{t('需要中心管理员身份', 'Administrator sign-in required')}</p>
      {message ? <p className="bs-login-hint">{message}</p> : null}
      <label htmlFor={id} className="sr-only">{t('中心管理员密码', 'Center administrator password')}</label>
      <input
        id={id}
        className="bs-input"
        type="password"
        autoComplete="current-password"
        placeholder={t('中心管理员密码', 'Center administrator password')}
        value={password}
        onChange={event => setPassword(event.target.value)}
      />
      <button type="submit" className="bs-btn is-primary is-block" disabled={!password || busy}>
        {t('登录', 'Log in')}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* 底部保存栏                                                          */
/* ------------------------------------------------------------------ */

export interface SaveBarProps {
  dirty: boolean;
  busy?: boolean;
  onSave(): void;
  /** 撤销未保存的更改（仅在 dirty 时显示）。 */
  onReset?: () => void;
  saveLabel?: string;
  /** 替换左侧状态文字（例如“已保存到中心，等待设备应用”）。 */
  status?: ReactNode;
  /** 额外的次要按钮（放在撤销左侧）。 */
  extra?: ReactNode;
}

export function SaveBar({ dirty, busy = false, onSave, onReset, saveLabel, status, extra }: SaveBarProps) {
  const t = useText();
  return (
    <div className="bs-savebar">
      <span className={`bs-savebar-status${dirty ? ' is-dirty' : ''}`}>
        {status ?? (dirty ? t('有未保存的更改', 'Unsaved changes') : t('没有更改', 'No changes'))}
      </span>
      {extra}
      {dirty && onReset ? (
        <button type="button" className="bs-btn is-ghost" disabled={busy} onClick={onReset}>
          {t('撤销', 'Discard')}
        </button>
      ) : null}
      <button type="button" className="bs-btn is-primary" disabled={!dirty || busy} onClick={onSave}>
        {busy ? t('保存中…', 'Saving…') : saveLabel ?? t('保存', 'Save')}
      </button>
    </div>
  );
}
