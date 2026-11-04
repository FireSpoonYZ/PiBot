import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Cpu, Pencil, Plus, Sparkles } from 'lucide-react';
import type { Device, JsonObject, Model } from '@e-launcher/center-contract';
import { api } from '../api';
import { SheetModal } from '../components/SheetModal';

const blank: Model = {
  id: '',
  name: '',
  contextWindow: 32768,
  maxTokens: 1024,
  input: ['text'],
  reasoning: false,
  enabled: true,
  revision: 0,
};

export default function Models() {
  const { providerId = '' } = useParams();
  const [models, setModels] = useState<Model[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [discovered, setDiscovered] = useState<Model[]>([]);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [edit, setEdit] = useState<Model | null>(null);
  const [creating, setCreating] = useState(false);
  const [advanced, setAdvanced] = useState('{}');
  const [inputTypes, setInputTypes] = useState('text');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    const [m, d] = await Promise.all([api.listModels(providerId), api.listDevices()]);
    setModels(m);
    setDevices(d);
  };

  useEffect(() => {
    void run(load);
  }, [providerId]);

  const open = (model: Model, isNew: boolean) => {
    setEdit(model);
    setCreating(isNew);
    setInputTypes(model.input.join(', '));
    const { thinkingLevelMap, cost, compat, inputLimits } = model;
    setAdvanced(
      JSON.stringify(
        {
          ...(thinkingLevelMap !== undefined && { thinkingLevelMap }),
          ...(cost !== undefined && { cost }),
          ...(compat !== undefined && { compat }),
          ...(inputLimits !== undefined && { inputLimits }),
        },
        null,
        2,
      ),
    );
  };

  return (
    <main className="page">
      <div style={{ marginBottom: 8 }}>
        <Link to="/providers" className="quiet-button">
          ← 返回服务商
        </Link>
      </div>

      <header className="page-header">
        <div className="page-title-group">
          <h1>{providerId} 的模型</h1>
          <p className="secondary">管理该服务商下的模型目录、上下文窗口与推理特性</p>
        </div>
        <div className="action-row">
          <button
            className="button secondary-button button-sm"
            onClick={() => {
              setError('');
              setDiscoverOpen(true);
            }}
          >
            <Sparkles size={15} />
            从设备发现模型
          </button>
          <button
            className="button"
            onClick={() => {
              setError('');
              open({ ...blank }, true);
            }}
          >
            <Plus size={16} />
            新增模型
          </button>
        </div>
      </header>

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      )}

      {models.length === 0 ? (
        <div className="empty-state">
          <Cpu size={28} />
          <p>暂无已保存的模型</p>
          <p className="secondary">点击“从设备发现模型”自动拉取列表，或点击“新增模型”手动添加。</p>
        </div>
      ) : (
        <div className="card-grid">
          {models.map(model => (
            <article className="card-group resource-row" key={model.id}>
              <div className="card-header">
                <div className="action-row" style={{ marginBlock: 0 }}>
                  <h2>{model.name || model.id}</h2>
                  <span className={`badge ${model.enabled ? 'badge-online' : 'badge-offline'}`}>
                    {model.enabled ? '已启用' : '已停用'}
                  </span>
                  {model.reasoning && <span className="badge badge-accent">推理</span>}
                  <span className="badge badge-neutral">上下文 {model.contextWindow.toLocaleString()}</span>
                  <span className="badge badge-neutral">最大输出 {model.maxTokens.toLocaleString()}</span>
                  <span className="badge badge-neutral">{model.input.join(', ')}</span>
                </div>
                <button className="quiet-button" onClick={() => open(model, false)}>
                  <Pencil size={15} />
                  编辑
                </button>
              </div>
              <p className="secondary">ID: {model.id}</p>
            </article>
          ))}
        </div>
      )}

      <SheetModal
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        title="从在线设备发现模型"
        description={`通过在线设备查询 ${providerId} 支持的模型目录，选择后可确认参数并保存`}
        size="lg"
      >
        <div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="inline-notice" role="status">
              {notice}
            </p>
          )}
          <div className="form">
            <label>
              从在线设备发现模型
              <select value={deviceId} onChange={e => setDeviceId(e.target.value)}>
                <option value="">选择设备</option>
                {devices
                  .filter(d => d.online)
                  .map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.name || d.deviceId}
                    </option>
                  ))}
              </select>
            </label>
            <div className="action-row">
              <button
                className="button secondary-button"
                disabled={busy || !deviceId}
                onClick={() =>
                  void run(async () => {
                    const result = await api.discoverModels(providerId, { deviceId });
                    setDiscovered(result.models);
                    setNotice(`发现 ${result.models.length} 个模型，选择后确认保存。`);
                  })
                }
              >
                发现模型
              </button>
            </div>
          </div>

          {discovered.length > 0 && (
            <div className="card-grid" style={{ marginTop: 12 }}>
              {discovered.map(model => {
                const exists = models.some(m => m.id === model.id);
                return (
                  <article className="resource-row" key={model.id}>
                    <div className="card-header">
                      <div>
                        <strong>{model.name || model.id}</strong>
                        <span className="secondary"> · {model.id}</span>
                      </div>
                      <button
                        className="button secondary-button button-sm"
                        disabled={exists}
                        onClick={() => {
                          setDiscoverOpen(false);
                          open({ ...model, revision: 0 }, true);
                        }}
                      >
                        {exists ? '已添加' : '填写并保存'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </SheetModal>

      <SheetModal
        open={edit !== null}
        onOpenChange={isOpen => {
          if (!isOpen) setEdit(null);
        }}
        title={creating ? '新增模型' : `编辑模型：${edit?.name || edit?.id || ''}`}
        description={creating ? `向 ${providerId} 注册新模型` : `模型 ID: ${edit?.id || ''}`}
        size="lg"
      >
        {edit && (
          <div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <form
              className="form"
              onSubmit={e => {
                e.preventDefault();
                void run(async () => {
                  const extra = JSON.parse(advanced) as JsonObject;
                  if (
                    !extra ||
                    Array.isArray(extra) ||
                    typeof extra !== 'object' ||
                    Object.keys(extra).some(k => !['thinkingLevelMap', 'cost', 'compat', 'inputLimits'].includes(k))
                  ) {
                    throw new Error('高级参数仅接受 thinkingLevelMap、cost、compat、inputLimits 对象');
                  }
                  const { thinkingLevelMap: _t, cost: _c, compat: _co, inputLimits: _i, ...base } = edit;
                  const input = inputTypes
                    .split(',')
                    .map(v => v.trim())
                    .filter(Boolean);
                  if (!input.length) throw new Error('至少填写一个输入类型');
                  const value = { ...base, ...extra, input } as Model;
                  const saved = creating
                    ? await api.createModel(providerId, value)
                    : await api.putModel(providerId, edit.id, { expectedRevision: edit.revision, value });
                  open(saved, false);
                  await load();
                  setNotice('模型已保存');
                });
              }}
            >
              <div className="form-grid">
                <label>
                  模型 ID
                  <input
                    required
                    disabled={!creating}
                    placeholder="例如 gpt-4.1 或 claude-sonnet-4"
                    value={edit.id}
                    onChange={e => setEdit({ ...edit, id: e.target.value })}
                  />
                </label>
                <label>
                  显示名称
                  <input
                    required
                    placeholder="例如 GPT-4.1"
                    value={edit.name}
                    onChange={e => setEdit({ ...edit, name: e.target.value })}
                  />
                </label>
              </div>
              <div className="form-grid">
                <label>
                  上下文窗口
                  <input
                    type="number"
                    min="1"
                    required
                    value={edit.contextWindow}
                    onChange={e => setEdit({ ...edit, contextWindow: Number(e.target.value) })}
                  />
                </label>
                <label>
                  最大输出 token
                  <input
                    type="number"
                    min="1"
                    required
                    value={edit.maxTokens}
                    onChange={e => setEdit({ ...edit, maxTokens: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label>
                输入类型（逗号分隔）
                <input
                  required
                  placeholder="text, image"
                  value={inputTypes}
                  onChange={e => setInputTypes(e.target.value)}
                />
              </label>
              <div className="action-row" style={{ marginBlock: 4 }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={edit.reasoning}
                    onChange={e => setEdit({ ...edit, reasoning: e.target.checked })}
                  />
                  支持推理
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={edit.enabled}
                    onChange={e => setEdit({ ...edit, enabled: e.target.checked })}
                  />
                  启用
                </label>
              </div>
              <details className="fold-panel">
                <summary>高级参数（JSON，可选）</summary>
                <div className="form" style={{ marginTop: 10 }}>
                  <p className="secondary">
                    可配置 thinkingLevelMap、cost、compat、inputLimits 字段；无特殊要求保持 <code>{'{}'}</code> 即可。
                  </p>
                  <label>
                    高级参数（JSON）
                    <textarea rows={6} value={advanced} onChange={e => setAdvanced(e.target.value)} />
                  </label>
                </div>
              </details>
              <div className="action-row">
                <button className="button" disabled={busy}>
                  保存模型
                </button>
                <button type="button" className="quiet-button" onClick={() => setEdit(null)}>
                  关闭
                </button>
              </div>
            </form>
          </div>
        )}
      </SheetModal>
    </main>
  );
}
