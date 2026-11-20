import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger' | 'progress';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  open?: boolean;
  tone?: ToastTone;
  message: ReactNode;
  action?: ToastAction;
  duration?: number;
  floating?: boolean;
  onDismiss?: () => void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export interface ToastOptions {
  id?: string;
  tone?: ToastTone;
  message: ReactNode;
  action?: ToastAction;
  duration?: number;
}

export interface ToastContextValue {
  show: (input: ToastOptions | string) => string;
  dismiss: (id?: string) => void;
}

const DEFAULT_TOAST_DURATION = 3200;

function renderToneIcon(tone: ToastTone): ReactNode {
  switch (tone) {
    case 'success':
      return <CheckCircle2 aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle aria-hidden="true" />;
    case 'danger':
      return <AlertCircle aria-hidden="true" />;
    case 'progress':
      return <Loader2 className="ui-toast-spinner" aria-hidden="true" />;
    default:
      return <Info aria-hidden="true" />;
  }
}

export function Toast({
  open = true,
  tone = 'info',
  message,
  action,
  duration = DEFAULT_TOAST_DURATION,
  floating = true,
  onDismiss,
  className = '',
  ref,
}: ToastProps) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const hasDismiss = Boolean(onDismiss);

  useEffect(() => {
    if (!open || tone === 'progress' || !hasDismiss || duration <= 0) return;
    const timer = setTimeout(() => {
      onDismissRef.current?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [open, tone, duration, message, hasDismiss]);

  if (!open) return null;

  const cls = [
    'ui-toast',
    `is-${tone}`,
    floating ? 'is-floating' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} role="status" aria-live="polite" className={cls}>
      <span className="ui-toast-icon" aria-hidden="true">{renderToneIcon(tone)}</span>
      <span className="ui-toast-message">{message}</span>
      {action ? (
        <button
          type="button"
          className="ui-toast-action"
          onClick={() => {
            action.onClick();
            onDismissRef.current?.();
          }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

interface ToastEntry {
  id: string;
  tone: ToastTone;
  message: ReactNode;
  action?: ToastAction;
  duration: number;
}

const ToastContext = createContext<ToastContextValue>({
  show: () => '',
  dismiss: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seqRef = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const existing = timersRef.current.get(id);
    if (existing !== undefined) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id?: string) => {
    if (id === undefined) {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      setToasts([]);
      return;
    }
    clearTimer(id);
    setToasts(prev => prev.filter(item => item.id !== id));
  }, [clearTimer]);

  const show = useCallback((input: ToastOptions | string): string => {
    const options: ToastOptions = typeof input === 'string' ? { message: input } : input;
    const id = options.id ?? `toast-${++seqRef.current}`;
    const tone: ToastTone = options.tone ?? 'info';
    const duration = options.duration ?? DEFAULT_TOAST_DURATION;

    clearTimer(id);
    const entry: ToastEntry = {
      id,
      tone,
      message: options.message,
      action: options.action,
      duration,
    };
    setToasts(prev => [...prev.filter(item => item.id !== id), entry]);

    if (tone !== 'progress' && duration > 0) {
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts(prev => prev.filter(item => item.id !== id));
      }, duration);
      timersRef.current.set(id, timer);
    }

    return id;
  }, [clearTimer]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const contextValue = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {toasts.length > 0 ? (
        <div className="ui-toast-viewport">
          {toasts.map(item => (
            <Toast
              key={item.id}
              tone={item.tone}
              message={item.message}
              action={item.action}
              duration={0}
              floating={false}
              onDismiss={() => dismiss(item.id)}
            />
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
