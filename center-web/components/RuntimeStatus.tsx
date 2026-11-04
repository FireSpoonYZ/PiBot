import type { DeviceRuntimeStatus, RuntimeApplyStatus } from '@e-launcher/center-contract';

const LABELS: Record<RuntimeApplyStatus, string> = {
  pending: '待应用',
  applying: '应用中',
  'waiting-idle': '等待空闲',
  applied: '已应用',
  failed: '应用失败',
};

const TONES: Record<RuntimeApplyStatus, string> = {
  pending: 'badge-warn',
  applying: 'badge-primary',
  'waiting-idle': 'badge-primary',
  applied: 'badge-online',
  failed: 'badge-danger',
};

export const runtimeLabel = (status: RuntimeApplyStatus) => LABELS[status];

export function runtimeTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function RuntimeStatusBadge({ status }: { status: RuntimeApplyStatus }) {
  return <span className={`badge ${TONES[status]}`}>{LABELS[status]}</span>;
}

/** Center-saved desired revision, target receipt and timestamps; offline is expressed separately. */
export function RuntimeStatusSummary({ status }: { status: DeviceRuntimeStatus }) {
  const capabilityErrors = status.capabilityErrors.length;
  return (
    <>
      <div className="action-row">
        <RuntimeStatusBadge status={status.status} />
        <span className={`badge ${status.online ? 'badge-online' : 'badge-offline'}`}>
          {status.online ? '在线' : '离线'}
        </span>
        <span className="badge badge-neutral">配置版本 {status.desiredRevision}</span>
        <span className="badge badge-neutral">已应用版本 {status.appliedRevision ?? '无'}</span>
        <span className="badge badge-neutral">配置时间 {runtimeTime(status.updatedAt)}</span>
        <span className="badge badge-neutral">应用时间 {runtimeTime(status.appliedAt)}</span>
        {capabilityErrors > 0 && <span className="badge badge-danger">能力错误 {capabilityErrors}</span>}
      </div>
      {status.status === 'failed' && status.error && (
        <p className="inline-error">
          {status.error.code}：{status.error.message}
        </p>
      )}
    </>
  );
}
