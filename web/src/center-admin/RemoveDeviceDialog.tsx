import { useAction, useText } from '../ui';
import { CaModal, CaNotice } from './primitives';

export function RemoveDeviceDialog({ name, onRemove, onClose }: {
  name: string;
  onRemove(): Promise<void>;
  onClose(): void;
}) {
  const t = useText();
  const action = useAction();
  return (
    <CaModal
      open
      onOpenChange={open => { if (!open && !action.busy) onClose(); }}
      title={t('移除设备', 'Remove Device')}
      description={t(`确定从中心移除「${name}」吗？该设备将断开连接，其下 Bot 的中心绑定也会被撤销。`, `Remove "${name}" from the center? This device will disconnect and its Bots' center bindings will be revoked.`)}
      variant="modal"
    >
      {action.error && <CaNotice tone="danger">{action.error}</CaNotice>}
      <div className="ca-inline-end">
        <button type="button" className="ca-btn" disabled={action.busy} onClick={onClose}>
          {t('取消', 'Cancel')}
        </button>
        <button
          type="button"
          className="ca-btn ca-btn-danger"
          disabled={action.busy}
          onClick={() => void action.run(async () => {
            await onRemove();
            onClose();
          })}
        >
          {action.busy ? t('移除中…', 'Removing…') : t('确认移除', 'Confirm Remove')}
        </button>
      </div>
    </CaModal>
  );
}
