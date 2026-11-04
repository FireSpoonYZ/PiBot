import type { ActivationStatus, Installation, InstallationActivation } from '@e-launcher/center-contract';
import { runtimeTime } from './RuntimeStatus';

const LABELS: Record<ActivationStatus, string> = {
  disabled: '全局未启用',
  enabling: '全局启用中',
  enabled: '全局已启用',
  failed: '全局启用失败',
};

const TONES: Record<ActivationStatus, string> = {
  disabled: 'badge-offline',
  enabling: 'badge-primary',
  enabled: 'badge-online',
  failed: 'badge-danger',
};

/** Effective authorization shared by UI gating; the center enforces the same rule. */
export const activationUsable = (installation: { enabled: boolean; activation: InstallationActivation }) =>
  installation.enabled && installation.activation.status === 'enabled';

export function ActivationBadge({ status }: { status: ActivationStatus }) {
  return <span className={`badge ${TONES[status]}`}>{LABELS[status]}</span>;
}

/** Global intent, activation state and its center-side reason. */
export function ActivationSummary({ installation }: { installation: Installation }) {
  const { activation } = installation;
  return (
    <>
      <div className="action-row">
        <span className={`badge ${installation.enabled ? 'badge-primary' : 'badge-offline'}`}>
          全局意图：{installation.enabled ? '启用' : '停用'}
        </span>
        <ActivationBadge status={activation.status} />
        <span className="badge badge-neutral">更新于 {runtimeTime(activation.updatedAt)}</span>
        {!activationUsable(installation) && installation.enabled && (
          <span className="badge badge-warn">当前不生效</span>
        )}
      </div>
      {activation.error && (
        <p className="inline-error">
          {activation.error.code}：{activation.error.message}
        </p>
      )}
      {activationUsable(installation) && installation.kind === 'mcp' && installation.target === 'host' && (
        <p className="secondary">全局仅确认中心分发准备；实际设备连接需在该 Bot 侧单独确认。</p>
      )}
      {activationUsable(installation) && installation.target === 'host' && installation.kind !== 'mcp' && (
        <p className="secondary">全局已确认包校验与分发准备（可分配），Bot 侧实际部署仍以部署/运行回执为准。</p>
      )}
    </>
  );
}
