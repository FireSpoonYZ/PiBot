import { useEffect, useState } from 'react';
import type { Operation } from '@e-launcher/center-contract';
import { api } from '../api';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getPhaseBadgeClass(phase: Operation['phase'] | undefined): string {
  if (phase === 'applied') return 'badge badge-online';
  if (phase === 'failed') return 'badge badge-danger';
  if (phase === 'removed') return 'badge badge-neutral';
  return 'badge badge-primary';
}

export function ConfigOperation({ id, onFinished }: { id: string; onFinished?(): void }) {
  const [operation, setOperation] = useState<Operation>();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.getOperation(id);
        if (!active) return;
        setOperation(next);
        setError('');
        if (['applied', 'failed', 'removed'].includes(next.phase)) onFinished?.();
        else timer = setTimeout(poll, 1500);
      } catch (e) {
        if (active) {
          setError(errorMessage(e));
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id]);

  const phaseText = operation?.phase ?? '读取中';

  return (
    <div className="config-operation" role="status">
      <div className="config-operation-header">
        <strong>操作 {id}</strong>
        <span className={getPhaseBadgeClass(operation?.phase)}>阶段：{phaseText}</span>
      </div>
      {operation?.error && (
        <p className="inline-error" role="alert">
          {operation.error.message}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}；正在重试读取状态
        </p>
      )}
      <small>受理不代表部署完成，请查看设备回执。</small>
    </div>
  );
}
