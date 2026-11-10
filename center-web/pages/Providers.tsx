import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Settings2 } from 'lucide-react';
import type { CredentialInfo, Provider, ProviderAuthFlow, ProviderAuthStatus, JsonObject } from '@e-launcher/center-contract';
import { api, CenterApiError } from '../api';
import { SheetModal } from '../components/SheetModal';

const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'pi-messages'];
const blank: Provider = { id: '', name: '', baseUrl: '', api: 'openai-completions', credentialRef: null, native: false, enabled: false, revision: 0 };

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [choose, setChoose] = useState(false);
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [custom, setCustom] = useState('{}');
  const [auth, setAuth] = useState<ProviderAuthStatus | null>(null);
  const [credential, setCredential] = useState<CredentialInfo | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ProviderAuthFlow | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => setProviders(await api.listProviders());
  useEffect(() => { void load().catch(e => setError(String(e))); }, []);
  const connected = useMemo(() => providers.filter(p => p.enabled), [providers]);
  const available = useMemo(() => providers.filter(p => !p.enabled &&
    (!search || (p.name + ' ' + p.id).toLowerCase().includes(search.toLowerCase()))).slice(0, 30), [providers, search]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const open = async (provider: Provider, isNew = false) => {
    setEdit(provider); setCreating(isNew); setChoose(false); setError(''); setNotice('');
    setCustom(JSON.stringify(provider.custom ?? {}, null, 2)); setAuth(null);
    setCredential(null); setKeyValue(''); setFlowId(null); setFlow(null); setReply('');
    if (!isNew) {
      const [status, key] = await Promise.all([
        api.providerAuthStatus(provider.id),
        provider.credentialRef ? api.getCredential(provider.credentialRef).catch(e => {
          if (e instanceof CenterApiError && e.status === 404) return null;
          throw e;
        }) : Promise.resolve(null),
      ]);
      setAuth(status); setCredential(key);
    }
  };

  useEffect(() => {
    if (!flowId || !edit) return;
    let gone = false;
    const providerId = edit.id;
    const poll = async () => {
      try {
        const state = await api.providerLoginStatus(providerId, flowId);
        if (gone) return;
        setFlow(state);
        if (state.status === 'complete') {
          setFlowId(null); setNotice('账号连接成功'); setError('');
          void load();
          void api.providerAuthStatus(providerId).then(setAuth);
          return;
        }
        if (state.status === 'failed' || state.status === 'cancelled') setFlowId(null);
      } catch (e) { if (!gone) setError(String(e)); }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { gone = true; clearInterval(timer); };
  }, [flowId, edit?.id]);

  const close = () => {
    if (flowId && edit) void api.providerLoginCancel(edit.id, flowId).catch(() => {});
    setEdit(null); setFlowId(null);
  };

  const save = async () => {
    if (!edit) return;
    const settings = JSON.parse(custom) as JsonObject;
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('高级设置必须是 JSON 对象');
    if (settings.apiKey !== undefined) throw new Error('API Key 请使用专用的安全输入框');
    const input = { ...edit, custom: settings, ...(creating && !edit.credentialRef ? { credentialRef: edit.id + '-api-key' } : {}) };
    const saved = creating ? await api.createProvider(input) :
      await api.putProvider(input.id, { expectedRevision: edit.revision, value: input });
    await load(); await open(saved); setNotice('设置已保存');
  };

  const startLogin = async () => {
    if (!edit) return;
    const { flowId: id } = await api.providerLogin(edit.id);
    setFlowId(id); setFlow(null);
  };

  return (
    <main className="page">
      <header className="page-header">
        <div className="page-title-group">
          <h1>模型服务商</h1>
          <p className="secondary">连接账号或填写 API Key。模型列表与协议由 Pi 自动维护。</p>
        </div>
        <div className="action-row">
          <button className="button secondary-button button-sm" disabled={busy} onClick={() => void run(async () => {
            const result = await api.syncModelCatalog(); await load();
            setNotice(result.error || '模型目录已同步');
          })}>更新模型目录</button>
          <button className="button" onClick={() => { setSearch(''); setChoose(true); }}>
            <Plus size={16} /> 添加服务商
          </button>
        </div>
      </header>

      {error && <p role="alert" className="inline-error">{error}</p>}
      {notice && <p role="status" className="inline-notice">{notice}</p>}

      {connected.length === 0 ? (
        <div className="empty-state">
          <p>还没有连接模型服务商</p>
          <p className="secondary">点击“添加服务商”，选择已有平台或自己的兼容接口。</p>
        </div>
      ) : (
        <div className="card-grid">
          {connected.map(provider => (
            <article className="card-group resource-card" key={provider.id}>
              <div className="card-header">
                <div><h2>{provider.name || provider.id}</h2>
                  <p className="secondary" style={{ marginBottom: 0 }}>{provider.native ? 'Pi 原生服务商' : '自定义服务商'}</p>
                </div>
                <span className="badge badge-online">已启用</span>
              </div>
              <div className="action-row">
                <button className="quiet-button" onClick={() => void run(() => open(provider))}>
                  <Settings2 size={15} /> 管理连接
                </button>
                <Link to={`/providers/${encodeURIComponent(provider.id)}/models`} className="quiet-button">模型列表</Link>
              </div>
            </article>
          ))}
        </div>
      )}

      <SheetModal open={choose} onOpenChange={setChoose} title="添加服务商"
        description="选择常用平台，或连接任意兼容 API" size="lg">
        <div className="form">
          <label>
            <span className="secondary">查找平台</span>
            <div style={{ position: 'relative' }}>
              <Search size={15} style={{ position: 'absolute', left: 12, top: 14, opacity: .6 }} />
              <input style={{ paddingLeft: 36 }} value={search} placeholder="例如 OpenAI、Claude、Copilot"
                onChange={e => setSearch(e.target.value)} />
            </div>
          </label>
          <div className="card-grid" style={{ maxHeight: 340, overflowY: 'auto' }}>
            {available.map(p => (
              <button key={p.id} className="quiet-button" style={{ textAlign: 'left', padding: 12, border: '1px solid var(--line, #ddd)', borderRadius: 10 }}
                onClick={() => void run(() => open(p))}>
                {p.name} <span className="secondary" style={{ fontSize: 12 }}>· {p.id}</span>
              </button>
            ))}
          </div>
          {available.length === 0 && <p className="secondary">没有匹配的平台，可以添加自定义连接。</p>}
          <button className="button secondary-button" onClick={() => void open({ ...blank }, true)}>
            <Plus size={16} /> 自定义兼容接口
          </button>
        </div>
      </SheetModal>

      <SheetModal open={edit !== null} onOpenChange={open => { if (!open) close(); }}
        title={creating ? '自定义服务商' : (edit?.name || '模型服务商')}
        description={edit?.native ? '保留 Pi 原生认证和模型能力' : '连接任意 Pi 支持的兼容接口'} size="lg">
        {edit && (
          <div className="form">
            {error && <p role="alert" className="inline-error">{error}</p>}
            {notice && <p role="status" className="inline-notice">{notice}</p>}

            {!creating && auth?.oauth && (
              <div className="panel form">
                <div className="card-header">
                  <h3>账号连接</h3>
                  <span className={auth.method === 'oauth' ? 'badge badge-online' : 'badge badge-neutral'}>
                    {auth.method === 'oauth' ? '已连接' : '未连接'}
                  </span>
                </div>
                {auth.method === 'oauth' ? (
                  <div className="action-row">
                    <span className="secondary">已通过 Pi 原生授权连接</span>
                    <button className="quiet-button danger" disabled={busy} onClick={() => void run(async () => {
                      setAuth(await api.providerLogout(edit.id)); await load(); setNotice('已退出账号');
                    })}>退出账号</button>
                  </div>
                ) : <button className="button" disabled={busy || Boolean(flowId)} onClick={() => void run(startLogin)}>
                  {auth.label || '连接账号'}
                </button>}
                {flow && (
                  <div className="form">
                    {flow.events.filter(e => e.type === 'auth_url' || e.type === 'device_code').slice(-1).map((e, i) => (
                      <div key={i} className="panel form">
                        {e.type === 'device_code' && <p>授权码：<strong style={{ userSelect: 'all' }}>{e.userCode}</strong></p>}
                        <a href={e.url || e.verificationUri} target="_blank" rel="noopener noreferrer">打开授权页面 ↗</a>
                      </div>
                    ))}
                    {flow.prompt && <form className="form" onSubmit={e => { e.preventDefault();
                      if (flowId) void run(async () => { await api.providerLoginAnswer(edit.id, flowId, reply); setReply(''); });
                    }}>
                      <label>{flow.prompt.message}
                        {flow.prompt.type === 'select' ? (
                          <select value={reply} onChange={e => setReply(e.target.value)}>
                            <option value="">请选择</option>
                            {flow.prompt.options?.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                          </select>
                        ) : <input type={flow.prompt.type === 'secret' ? 'password' : 'text'}
                          value={reply} placeholder={flow.prompt.placeholder || '粘贴授权码或回调地址'}
                          onChange={e => setReply(e.target.value)} />}
                      </label>
                      <button className="button" disabled={!reply || busy}>继续</button>
                    </form>}
                    {flow.status === 'pending' && <p className="secondary">等待授权完成…</p>}
                    {flow.error && <p className="inline-error">{flow.error}</p>}
                  </div>
                )}
              </div>
            )}

            {!creating && edit.credentialRef && (
              <form className="panel form" onSubmit={e => { e.preventDefault(); void run(async () => {
                if (!keyValue) return;
                const saved = await api.putCredential(edit.credentialRef!, {
                  value: keyValue, expectedRevision: credential?.revision ?? null,
                });
                setCredential(saved); setKeyValue('');
                if (!edit.enabled) {
                  const updated = await api.putProvider(edit.id, { expectedRevision: edit.revision,
                    value: { ...edit, enabled: true } });
                  setEdit(updated);
                }
                setAuth(await api.providerAuthStatus(edit.id)); await load(); setNotice('API Key 已保存');
              }); }}>
                <div className="card-header"><h3>API Key</h3>
                  <span className="secondary">{credential?.configured ? '已配置' : '未配置'}</span></div>
                <label>密钥
                  <input type="password" value={keyValue} autoComplete="new-password"
                    placeholder={credential?.configured ? '输入新 Key 以替换' : '粘贴 API Key'}
                    onChange={e => setKeyValue(e.target.value)} />
                </label>
                <div className="action-row">
                  <button className="button secondary-button" disabled={!keyValue || busy}>保存 Key</button>
                  {credential?.configured && <button type="button" className="quiet-button danger" disabled={busy}
                    onClick={() => void run(async () => {
                      await api.deleteCredential(edit.credentialRef!, { expectedRevision: credential.revision, value: null });
                      setCredential(null); setAuth(await api.providerAuthStatus(edit.id)); await load();
                      setNotice('API Key 已删除');
                    })}>删除 Key</button>}
                </div>
              </form>
            )}

            <form className="form" onSubmit={e => { e.preventDefault(); void run(save); }}>
              {creating && <div className="form-grid">
                <label>连接名称<input required value={edit.name} placeholder="我的模型服务"
                  onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
                <label>服务商 ID<input required value={edit.id} placeholder="my-provider"
                  onChange={e => setEdit({ ...edit, id: e.target.value })} /></label>
              </div>}

              {!edit.native && <div className="form-grid">
                <label>API 地址<input type="url" required value={edit.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={e => setEdit({ ...edit, baseUrl: e.target.value })}/></label>
                <label>协议<input value={edit.api} list="pi-provider-protocols"
                  onChange={e => setEdit({ ...edit, api: e.target.value })}/>
                  <datalist id="pi-provider-protocols">{protocols.map(p => <option key={p} value={p}/>)}</datalist>
                </label>
              </div>}

              <details className="fold-panel">
                <summary>高级设置 · 自定义 Provider</summary>
                <div className="form" style={{ marginTop: 12 }}>
                  <p className="secondary">使用 Pi models.json 的 Provider 配置格式。只填写要覆盖的字段；支持 baseUrl、api、headers、models 和 modelOverrides。API Key 请在上方安全保存。</p>
                  <textarea rows={8} spellCheck={false} value={custom} onChange={e => setCustom(e.target.value)} />
                  <label className="check"><input type="checkbox" checked={edit.enabled}
                    onChange={e => setEdit({ ...edit, enabled: e.target.checked })}/>启用服务商</label>
                  {edit.native && <label>显示名称<input value={edit.name}
                    onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>}
                </div>
              </details>

              {creating && <p className="secondary">创建后可以连接 API Key，并在“模型列表”添加模型。</p>}
              <div className="action-row">
                <button className="button" disabled={busy}>{creating ? '创建连接' : '保存设置'}</button>
                {!creating && <Link to={`/providers/${encodeURIComponent(edit.id)}/models`}
                  className="button secondary-button">管理模型</Link>}
                <button type="button" className="quiet-button" onClick={close}>关闭</button>
              </div>
            </form>
          </div>
        )}
      </SheetModal>
    </main>
  );
}
