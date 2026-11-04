import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Sliders } from 'lucide-react';
import type { BotCapabilityEntry, DeviceRuntimeStatus, JsonObject } from '@e-launcher/center-contract';
import { api } from '../api';
import ConfigForm from '../components/ConfigForm';
import { errorMessage } from '../components/ConfigOperation';
import { ActivationBadge, activationUsable } from '../components/ActivationStatus';
import { RuntimeStatusBadge, RuntimeStatusSummary } from '../components/RuntimeStatus';
import { SheetModal } from '../components/SheetModal';
import '../components/Config.css';

export default function BotCapabilities() {
  const { deviceId = '', botId = '' } = useParams();
  const [entries, setEntries] = useState<BotCapabilityEntry[]>([]);
  const [runtime, setRuntime] = useState<DeviceRuntimeStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [editingId, setEditingId] = useState('');

  const load = async () => {
    try {
      const [next, status] = await Promise.all([
        api.listBotCapabilities(deviceId, botId),
        api.getDeviceRuntimeStatus(deviceId),
      ]);
      setEntries(next);
      setRuntime(status);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, [deviceId, botId]);

  // Low-frequency refresh while visible; a dirty override form keeps its own state.
  useEffect(() => {
    if (editingId || busy) return;
    const tick = () => {
      if (document.hidden) return;
      void load();
    };
    const timer = setInterval(tick, 2500);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [deviceId, botId, editingId, busy]);

  const save = async (entry: BotCapabilityEntry, enabled: boolean, overrides: JsonObject) => {
    setBusy(entry.installation.installationId);
    setError('');
    try {
      const config = await api.putBotCapability(deviceId, botId, entry.installation.installationId, {
        expectedRevision: entry.config.revision,
        enabled,
        overrides,
      });
      setEntries(current =>
        current.map(item =>
          item.installation.installationId === entry.installation.installationId
            ? { ...item, config }
            : item,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  };

  const enabledCount = entries.filter(entry => entry.config.enabled).length;
  const disabledCount = entries.length - enabledCount;
  const visibleEntries = entries.filter(entry => {
    if (filterStatus === 'enabled') return entry.config.enabled;
    if (filterStatus === 'disabled') return !entry.config.enabled;
    return true;
  });
  const editingEntry = entries.find(entry => entry.installation.installationId === editingId);
  const botReceipt = runtime?.bots.find(item => item.botId === botId);
  const capabilityErrors = (installationId: string) =>
    runtime?.capabilityErrors.filter(item => item.botId === botId && item.installationId === installationId) ?? [];

  return (
    <main className="page config-page">
      <div className="action-row">
        <Link to="/devices" className="quiet-button">
          ← 返回设备与 Bot
        </Link>
        <Link to="/capabilities" className="quiet-button">
          返回能力列表
        </Link>
      </div>

      <header className="page-header">
        <div className="page-title-group">
          <h1>Bot 能力配置</h1>
          <p className="secondary">
            设备 {deviceId} · Bot {botId}
          </p>
        </div>
      </header>

      {error && (
        <p role="alert" className="inline-error config-error">
          {error}
        </p>
      )}

      {runtime && (
        <section className="card-group">
          <div className="card-header">
            <h2>应用状态</h2>
          </div>
          <RuntimeStatusSummary status={runtime} />
          {botReceipt && (
            <div className="action-row">
              <RuntimeStatusBadge status={botReceipt.status} />
              <span className="badge badge-neutral">Bot 配置版本 {botReceipt.desiredRevision}</span>
              <span className="badge badge-neutral">Bot 已应用版本 {botReceipt.appliedRevision ?? '无'}</span>
            </div>
          )}
          {botReceipt?.error && (
            <p className="inline-error">
              {botReceipt.error.code}：{botReceipt.error.message}
            </p>
          )}
          <p className="secondary">修改后显示为待应用，直到目标 Host 回报当前配置版本已应用。</p>
        </section>
      )}

      {loaded && entries.length > 0 && (
        <div className="filter-bar" role="group" aria-label="启用状态筛选">
          <button
            type="button"
            className={`filter-chip ${filterStatus === 'all' ? 'is-active' : ''}`}
            aria-pressed={filterStatus === 'all'}
            onClick={() => setFilterStatus('all')}
          >
            全部 ({entries.length})
          </button>
          <button
            type="button"
            className={`filter-chip ${filterStatus === 'enabled' ? 'is-active' : ''}`}
            aria-pressed={filterStatus === 'enabled'}
            onClick={() => setFilterStatus('enabled')}
          >
            已为该 Bot 启用 ({enabledCount})
          </button>
          <button
            type="button"
            className={`filter-chip ${filterStatus === 'disabled' ? 'is-active' : ''}`}
            aria-pressed={filterStatus === 'disabled'}
            onClick={() => setFilterStatus('disabled')}
          >
            未启用 ({disabledCount})
          </button>
        </div>
      )}

      {!loaded && <p className="empty-state secondary">加载中…</p>}
      {loaded && entries.length === 0 && <p className="empty-state secondary">暂无安装实例。</p>}
      {loaded && entries.length > 0 && visibleEntries.length === 0 && (
        <p className="empty-state secondary">当前筛选条件下暂无能力实例。</p>
      )}

      {visibleEntries.length > 0 && (
        <div className="card-grid">
          {visibleEntries.map(entry => {
            const overrideCount = Object.keys(entry.config.overrides).length;
            const globalUsable = activationUsable(entry.installation);
            return (
              <section key={entry.installation.installationId} className="card-group resource-row">
                <div className="card-header">
                  <h2>
                    <Link to={`/capabilities/${encodeURIComponent(entry.installation.installationId)}`}>
                      {entry.installation.displayName}
                    </Link>
                  </h2>
                  <div className="action-row">
                    <span
                      className={`badge ${
                        entry.installation.kind === 'plugin'
                          ? 'badge-primary'
                          : entry.installation.kind === 'mcp'
                            ? 'badge-accent'
                            : 'badge-neutral'
                      }`}
                    >
                      {entry.installation.kind}
                    </span>
                    <span
                      className={`badge ${entry.installation.enabled ? 'badge-online' : 'badge-offline'}`}
                    >
                      全局{entry.installation.enabled ? '启用' : '禁用'}
                    </span>
                    <span className="badge badge-neutral">版本 {entry.installation.targetVersion}</span>
                    <ActivationBadge status={entry.installation.activation.status} />
                    <span className={`badge ${overrideCount > 0 ? 'badge-accent' : 'badge-neutral'}`}>
                      {overrideCount > 0 ? '已自定义覆盖' : '继承全局配置'}
                    </span>
                    {capabilityErrors(entry.installation.installationId).length > 0 && (
                      <span className="badge badge-danger">应用失败</span>
                    )}
                  </div>
                </div>

                {capabilityErrors(entry.installation.installationId).map(item => (
                  <p key={item.installationId} className="inline-error">
                    {item.error.code}：{item.error.message}
                  </p>
                ))}

                <div className="action-row">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={entry.config.enabled}
                      disabled={!!busy || (!entry.config.enabled && !globalUsable)}
                      onChange={event =>
                        void save(entry, event.target.checked, entry.config.overrides)
                      }
                    />
                    为此 Bot 启用
                  </label>
                  {!globalUsable && (
                    <span className="secondary">
                      {entry.config.enabled
                        ? '全局未启用成功，当前不生效；仍可关闭此绑定'
                        : '全局启用成功后才能为此 Bot 开启'}
                    </span>
                  )}
                  <button
                    type="button"
                    className="button secondary-button button-sm"
                    onClick={() => setEditingId(entry.installation.installationId)}
                  >
                    <Sliders size={15} aria-hidden="true" />
                    配置覆盖参数
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <SheetModal
        open={editingEntry !== undefined}
        onOpenChange={open => {
          if (!open) setEditingId('');
        }}
        title={`${editingEntry?.installation.displayName ?? ''} — Bot 覆盖配置`}
        description={`设备 ${deviceId} · Bot ${botId}`}
        size="lg"
      >
        {editingEntry && (
          <ConfigForm
            key={`${editingEntry.installation.installationId}:${editingEntry.config.revision}`}
            schema={editingEntry.config.configSchema}
            uiSchema={editingEntry.uiSchema}
            globalConfig={editingEntry.config.globalConfig}
            overrides={editingEntry.config.overrides}
            onSave={async value => {
              await save(editingEntry, editingEntry.config.enabled, value);
              setEditingId('');
            }}
          />
        )}
      </SheetModal>
    </main>
  );
}
