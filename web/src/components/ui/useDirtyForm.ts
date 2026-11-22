import { useEffect } from 'react';

export interface UseDirtyFormOptions {
  warnOnUnload?: boolean;
}

export function useDirtyForm(isDirty: boolean, opts?: UseDirtyFormOptions): void {
  const warnOnUnload = opts?.warnOnUnload ?? true;

  useEffect(() => {
    if (!isDirty || !warnOnUnload) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty, warnOnUnload]);
}
