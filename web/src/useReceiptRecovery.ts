import { useEffect, useRef } from 'react';

/** Poll the original receipt only. The callback must never enqueue or resend. */
export function useReceiptRecovery(key: string, active: boolean, online: boolean, recover: (current: () => boolean) => Promise<void>) {
  const latest = useRef(recover);
  latest.current = recover;
  const flight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (!active || !online) return;
    let disposed = false;
    const current = () => !disposed;
    const poll = () => {
      if (disposed || document.hidden || flight.current) return;
      const read = latest.current;
      const task = Promise.resolve().then(() => { if (current()) return read(current); }).catch(() => {}).finally(() => {
        if (flight.current === task) flight.current = null;
      });
      flight.current = task;
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    document.addEventListener('visibilitychange', poll);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [key, active, online]);
}
