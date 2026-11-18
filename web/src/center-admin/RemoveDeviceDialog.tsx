import { useAction } from '../ui';
import { CaModal, CaNotice } from './primitives';

export function RemoveDeviceDialog({ name, onRemove, onClose }: {
  name: string;
  onRemove(): Promise<void>;
  onClose(): void;
}) {
  const action = useAction();
  return (
    <CaModal
      open
      onOpenChange={open => { if (!open && !action.busy) onClose(); }}
      title="移除设备"
      description={`确定从中心移除「${name}」吗？该设备将断开连接，其下智能体的中心绑定也会被撤销。`}
      variant="modal"
    >
      {action.error && <CaNotice tone="danger">{action.error}</CaNotice>}
      <div className="ca-inline-end">
        <button type="button" className="ca-btn" disabled={action.busy} onClick={onClose}>取消</button>
        <button
          type="button"
          className="ca-btn ca-btn-danger"
          disabled={action.busy}
          onClick={() => void action.run(async () => {
            await onRemove();
            onClose();
          })}
        >
          {action.busy ? '移除中…' : '确认移除'}
        </button>
      </div>
    </CaModal>
  );
}
