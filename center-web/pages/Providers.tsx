import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, KeyRound, Plus, Server, Settings2 } from 'lucide-react';
import type { CredentialInfo, Device, Provider } from '@e-launcher/center-contract';
import { api, CenterApiError } from '../api';
import { SheetModal } from '../components/SheetModal';

const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'pi-messages'];
const blank: Provider = {
  id: '',
  name: '',
  api: protocols[0],
  baseUrl: '',
  credentialRef: null,
  enabled: true,
  revision: 0,
};

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [edit, setEdit] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [credential, setCredential] = useState<CredentialInfo | null>(null);
  const [savedRef, setSavedRef] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
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
    const [p, d] = await Promise.all([api.listProviders(), api.listDevices()]);
    setProviders(p);
    setDevices(d);
  };

  useEffect(() => {
    void run(load);
  }, []);

  const open = async (provider: Provider, isNew: boolean) => {
    setEdit(provider);
    setCreating(isNew);
    setSecret('');
    setCredential(null);
    setSavedRef(provider.credentialRef);
    setNotice('');
    if (provider.credentialRef) {
      try {
        setCredential(await api.getCredential(provider.credentialRef));
      } catch (e) {
        if (!(e instanceof CenterApiError && e.status === 404)) throw e;
      }
    }
  };

  return (
    <main className="page">
      <header className="page-header">
        <div className="page-title-group">
          <h1>服务商与模型</h1>
          <p className="secondary">统一管理模型服务商、API 密钥与模型目录</p>
        </div>
        <div className="action-row">
          <Link to="/devices" className="button secondary-button button-sm">
            设置全局与 Bot 模型
          </Link>
          <button className="button" onClick={() => void run(() => open({ ...blank }, true))}>
            <Plus size={16} />
            新增服务商
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

      {providers.length === 0 ? (
        <div className="empty-state">
          <Server size={28} />
          <p>暂无已配置的服务商</p>
          <p className="secondary">点击右上角“新增服务商”配置 API 协议、Base URL 与密钥引用。</p>
        </div>
      ) : (
        <div className="card-grid">
          {providers.map(provider => (
            <article className="card-group resource-card" key={provider.id}>
              <div className="card-header">
                <div className="action-row" style={{ marginBlock: 0 }}>
                  <h2>{provider.name || provider.id}</h2>
                  <span className={`badge ${provider.enabled ? 'badge-online' : 'badge-offline'}`}>
                    {provider.enabled ? '已启用' : '已停用'}
                  </span>
                  <span className="badge badge-neutral">{provider.api}</span>
                </div>
              </div>
              <p className="secondary">
                ID: {provider.id} · {provider.baseUrl} · {provider.credentialRef ? `凭证: ${provider.credentialRef}` : '无凭证引用'}
              </p>
              <div className="action-row">
                <Link className="button secondary-button button-sm" to={`/providers/${encodeURIComponent(provider.id)}/models`}>
                  模型管理
                </Link>
                <button className="quiet-button" onClick={() => void run(() => open(provider, false))}>
                  <Settings2 size={15} />
                  编辑与密钥
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <SheetModal
        open={edit !== null}
        onOpenChange={isOpen => {
          if (!isOpen) {
            setEdit(null);
            setSecret('');
          }
        }}
        title={creating ? '新增服务商' : `编辑服务商：${edit?.name || edit?.id || ''}`}
        description={creating ? '配置模型服务商接口地址、协议与凭证引用' : `ID: ${edit?.id || ''} · 管理基本参数、API Key 与在线连接测试`}
        size="lg"
      >
        {edit && (
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

            <form
              className="form"
              onSubmit={event => {
                event.preventDefault();
                void run(async () => {
                  const saved = creating
                    ? await api.createProvider(edit)
                    : await api.putProvider(edit.id, { expectedRevision: edit.revision, value: edit });
                  await open(saved, false);
                  await load();
                  setNotice('服务商已保存');
                });
              }}
            >
              <div className="form-grid">
                <label>
                  服务商 ID
                  <input
                    required
                    value={edit.id}
                    disabled={!creating}
                    placeholder="例如 openai 或 anthropic"
                    onChange={e => setEdit({ ...edit, id: e.target.value })}
                  />
                </label>
                <label>
                  显示名称
                  <input
                    required
                    value={edit.name}
                    placeholder="例如 OpenAI 官方"
                    onChange={e => setEdit({ ...edit, name: e.target.value })}
                  />
                </label>
              </div>
              <label>
                Base URL
                <input
                  type="url"
                  required
                  value={edit.baseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={e => setEdit({ ...edit, baseUrl: e.target.value })}
                />
              </label>
              <div className="form-grid">
                <label>
                  API 协议
                  <select value={edit.api} onChange={e => setEdit({ ...edit, api: e.target.value })}>
                    {!protocols.includes(edit.api) && <option>{edit.api}</option>}
                    {protocols.map(p => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  凭证引用
                  <input
                    value={edit.credentialRef || ''}
                    placeholder="例如 openai-key（可选）"
                    onChange={e => setEdit({ ...edit, credentialRef: e.target.value || null })}
                  />
                </label>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={edit.enabled}
                  onChange={e => setEdit({ ...edit, enabled: e.target.checked })}
                />
                启用
              </label>
              <div className="action-row">
                <button className="button" disabled={busy}>
                  保存服务商
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    setEdit(null);
                    setSecret('');
                  }}
                >
                  关闭
                </button>
              </div>
            </form>

            {!creating && edit.credentialRef && edit.credentialRef !== savedRef && (
              <p className="secondary">凭证引用已更改，请先点击“保存服务商”后再写入对应 API Key。</p>
            )}

            {!creating && edit.credentialRef && edit.credentialRef === savedRef && (
              <form
                className="panel form"
                onSubmit={e => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await api.putCredential(edit.credentialRef!, {
                      value: secret,
                      expectedRevision: credential?.revision ?? null,
                    });
                    setCredential(result);
                    setSecret('');
                    setNotice('凭证已保存');
                  });
                }}
              >
                <div className="card-header">
                  <h3>
                    <KeyRound size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                    凭证：{edit.credentialRef}
                  </h3>
                  <span className={`badge ${credential?.configured ? 'badge-success' : 'badge-warn'}`}>
                    {credential?.configured ? '已配置；不会回显密钥' : '尚未配置'}
                  </span>
                </div>
                <label>
                  新 API Key
                  <input
                    type="password"
                    required
                    autoComplete="new-password"
                    placeholder="输入新的 API 密钥以写入或轮换"
                    value={secret}
                    onChange={e => setSecret(e.target.value)}
                  />
                </label>
                <div className="action-row">
                  <button className="button" disabled={busy}>
                    保存凭证
                  </button>
                  {credential?.configured && (
                    <button
                      type="button"
                      className="quiet-button danger"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.deleteCredential(edit.credentialRef!, {
                            expectedRevision: credential.revision,
                            value: null,
                          });
                          setCredential(null);
                          setSecret('');
                          setNotice('凭证已删除');
                        })
                      }
                    >
                      删除凭证
                    </button>
                  )}
                </div>
              </form>
            )}

            {!creating && (
              <div className="panel form">
                <h3>
                  <Activity size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                  在线设备连接检查
                </h3>
                <label>
                  用于连接检查的在线设备
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
                <p className="secondary">
                  检查会使用已保存的服务商配置和模型发送真实推理请求，可能产生费用；未保存的修改不会用于检查。
                </p>
                <div className="action-row">
                  <button
                    type="button"
                    className="button secondary-button"
                    disabled={busy || !deviceId}
                    onClick={() =>
                      void run(async () => {
                        const result = await api.validateProvider(edit.id, { deviceId });
                        setNotice(`${result.ok ? '连接成功' : '连接失败'}：${result.message}`);
                      })
                    }
                  >
                    检查连接
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </SheetModal>
    </main>
  );
}
