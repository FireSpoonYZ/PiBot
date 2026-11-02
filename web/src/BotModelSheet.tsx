import { useEffect, useRef, useState } from 'react';
import { Check, Cpu, ExternalLink, X } from 'lucide-react';
import type { CenterBotModelConfig, CenterModelSelection } from '../../host-core/desktop-client.js';
import type { ModelCatalog } from '../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import { BotCapabilities } from '../../desktop/web/src/BotCapabilities';
import { openCenterManagement } from './native';
import { ErrorNotice, errorText, useText } from './ui';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type BotSettingsTab = 'model' | 'capabilities' | 'advanced';

type Props = { api: DesktopPanelApi; identity: DesktopIdentity; botId: string; initialTab?: BotSettingsTab; onClose(): void };

export function BotModelSheet({ api, identity, botId, initialTab = 'model', onClose }: Props) {
  const t = useText();
  const [target] = useState(() => ({ identity, deviceId: identity.targetDeviceId, botId }));
  const alive = useRef(false);
  const [authenticated, setAuthenticated] = useState(true);
  const [config, setConfig] = useState<CenterBotModelConfig>();
  const [draft, setDraft] = useState<CenterModelSelection>({});
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [password, setPassword] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [tab, setTab] = useState<BotSettingsTab>(initialTab);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isAuthError = (failure: unknown) =>
    typeof failure === 'object' && failure !== null && (failure as { code?: unknown }).code === 'CONTROL_UNAUTHORIZED';

  const loadConfig = async () => {
    const next = await api.broker(target.identity, 'center_bot_model_get', { deviceId: target.deviceId, botId: target.botId });
    if (alive.current) { setConfig(next); setDraft({ ...next.overrides }); setAuthenticated(true); }
  };
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const models = await api.call(target.identity, 'getModelCatalog', {});
        if (!alive.current) return;
        setCatalog(models);
        // 模型配置读写优先走 host 设备令牌路径；仅当旧中心要求 owner 会话时才回退弹出密码登录。
        await loadConfig();
      } catch (failure) {
        if (!alive.current) return;
        if (isAuthError(failure)) setAuthenticated(false);
        else setError(errorText(failure));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => { alive.current = false; };
  }, [api, target]);

  const login = async () => {
    setBusy(true); setError('');
    const secret = password;
    setPassword('');
    try {
      await api.broker(target.identity, 'center_owner_login', { password: secret });
      if (!alive.current) return;
      setAuthenticated(true);
      await loadConfig();
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!config) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api.broker(target.identity, 'center_bot_model_set', {
        deviceId: target.deviceId, botId: target.botId, expectedRevision: config.revision, value: draft,
      });
      if (alive.current) { setConfig(next); setDraft({ ...next.overrides }); setAuthenticated(true); setNotice(t('模型设置已保存', 'Model settings saved')); }
    } catch (failure) {
      if (!alive.current) return;
      if (isAuthError(failure)) setAuthenticated(false);
      setError(errorText(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const update = (key: 'modelRef' | 'thinkingLevel', value: string | null | undefined) => {
    setDraft(previous => {
      const next = { ...previous };
      if (value === undefined) delete next[key]; else next[key] = value;
      return next;
    });
    setNotice('');
  };
  const updateBool = (key: 'codemode' | 'codemodeOnly', value: string) => {
    setDraft(previous => {
      const next = { ...previous };
      if (value === '__inherit') delete next[key];
      else if (value === '__null') next[key] = null;
      else if (value === 'true') {
        next[key] = true;
        if (key === 'codemodeOnly') next.codemode = true;
      } else if (value === 'false') {
        next[key] = false;
        if (key === 'codemode' && next.codemodeOnly === true) next.codemodeOnly = false;
      }
      return next;
    });
    setNotice('');
  };
  const describe = (value: string | null | undefined) => value === undefined ? t('继承', 'Inherit') : value === null ? t('显式清空', 'Explicitly cleared') : value;
  const describeCodemode = (sel?: CenterModelSelection) => {
    if (!sel) return t('默认', 'Default');
    if (sel.codemodeOnly === true) return t('仅 Code Mode（渐进式加载）', 'Codemode Only');
    if (sel.codemode === true) return t('已开启 Code Mode', 'Codemode On');
    if (sel.codemode === false && sel.codemodeOnly === false) return t('已关闭', 'Off');
    return t('继承 / 默认', 'Inherit / Default');
  };
  const q = query.trim().toLowerCase();

  return <div className="grok-sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('Bot 设置', 'Bot settings')} onClick={onClose}>
    <section className="grok-model-sheet" onClick={e => e.stopPropagation()}>
      <header className="grok-model-sheet-header">
        <div className="grok-model-sheet-title-wrap"><h3>{t('Bot 设置', 'Bot settings')}</h3></div>
        <div className="grok-model-sheet-actions">
          <button type="button" className="grok-floating-circle-btn" aria-label={t('关闭', 'Close')} onClick={onClose}><X size={18}/></button>
        </div>
      </header>
      <div className="grok-model-sheet-body">
        <div className="grok-segmented-tabs" role="tablist" aria-label={t('Bot 设置视图', 'Bot settings views')}>
          <button type="button" role="tab" aria-selected={tab === 'model'} className={tab === 'model' ? 'active' : undefined} onClick={() => setTab('model')}>{t('模型', 'Model')}</button>
          <button type="button" role="tab" aria-selected={tab === 'capabilities'} className={tab === 'capabilities' ? 'active' : undefined} onClick={() => setTab('capabilities')}>{t('插件 / 技能 / MCP', 'Plugins / Skills / MCP')}</button>
          <button type="button" role="tab" aria-selected={tab === 'advanced'} className={tab === 'advanced' ? 'active' : undefined} onClick={() => setTab('advanced')}>{t('高级设置', 'Advanced')}</button>
        </div>
        {tab === 'capabilities' && <BotCapabilities api={api} identity={identity} deviceId={identity.targetDeviceId} botId={botId} t={t} showTitle={false} onAuthenticated={() => setAuthenticated(true)}/>}
        {(tab === 'model' || tab === 'advanced') && <>
        {busy && <p role="status">{t('正在处理…', 'Working…')}</p>}
        {!busy && !authenticated && catalog && <form className="grok-sheet-login" onSubmit={e => { e.preventDefault(); void login(); }}>
          <label className="grok-section-label" htmlFor="center-owner-password">{t('中心管理员密码', 'Center administrator password')}</label>
          <input id="center-owner-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" className="grok-done-pill-btn" disabled={!password}>{t('中心管理员登录', 'Center administrator login')}</button>
        </form>}
        {config && tab === 'model' && <>
          <p className="grok-card-footnote" style={{ marginTop: 0 }}>
            {t('当前生效模型', 'Effective model')}: <strong>{describe(config.effective.modelRef)}</strong> · {t('思考强度', 'Thinking level')} {describe(config.effective.thinkingLevel)} · {describeCodemode(config.effective)}
          </p>
          <label className="grok-section-label">{t('模型选择', 'Model')}</label>
          <section className="grok-card-group">
            <button type="button" className="grok-card-row" disabled={busy} onClick={() => update('modelRef', undefined)}>
              <Cpu size={18}/>
              <span className="grok-row-label">{t('继承全局默认模型', 'Inherit global default')} ({config.global.modelRef ?? t('未设置', 'Unset')})</span>
              {draft.modelRef === undefined && <Check size={18}/>}
            </button>
          </section>
          <div className="grok-model-sheet-search"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('搜索模型…', 'Search models…')}/></div>
          <section className="grok-card-group">
            {draft.modelRef && !catalog?.models.some(model => model.modelRef === draft.modelRef) && <p>{t('当前模型不在目录中', 'Current model not in catalog')}: {draft.modelRef}</p>}
            {catalog?.models.filter(model => !q || `${model.name} ${model.modelRef}`.toLowerCase().includes(q)).map(model => <button type="button" className="grok-card-row" key={model.modelRef} disabled={busy} onClick={() => update('modelRef', model.modelRef)}><span className="grok-row-label">{model.name} · {model.modelRef}</span>{draft.modelRef === model.modelRef && <Check size={18}/>}</button>)}
          </section>
          <section className="grok-card-group">
            <div className="grok-card-row no-active">
              <label className="grok-row-label" htmlFor="bot-thinking-level">{t('思考强度', 'Thinking level')}</label>
              <select id="bot-thinking-level" className="grok-inline-select" disabled={busy} value={draft.thinkingLevel === undefined ? '__inherit' : draft.thinkingLevel === null ? '__null' : draft.thinkingLevel} onChange={e => update('thinkingLevel', e.target.value === '__inherit' ? undefined : e.target.value === '__null' ? null : e.target.value)}>
                <option value="__inherit">{t('继承全局', 'Inherit global')}</option><option value="__null">{t('显式清空', 'Explicitly clear')}</option>
                {draft.thinkingLevel && !levels.includes(draft.thinkingLevel) && <option value={draft.thinkingLevel}>{draft.thinkingLevel}</option>}
                {levels.map(level => <option key={level} value={level}>{level}</option>)}
              </select>
            </div>
          </section>
          <button type="button" className="grok-done-pill-btn" disabled={busy} onClick={() => void save()}>{t('保存模型设置', 'Save Model')}</button>
          <section className="grok-card-group">
            <button type="button" className="grok-card-row" onClick={() => void openCenterManagement().catch(failure => setError(errorText(failure)))}>
              <span className="grok-row-label">{t('管理模型服务商', 'Manage model providers')}</span>
              <span className="grok-row-value">{t('在中心管理中打开', 'Opens Center management')}</span>
              <ExternalLink size={16} className="grok-row-chevron"/>
            </button>
          </section>
        </>}
        {config && tab === 'advanced' && <>
          <label className="grok-section-label" htmlFor="bot-codemode">{t('工具执行与渐进式加载 (Code Mode)', 'Code Mode & Progressive Tool Loading')}</label>
          <p className="grok-card-footnote" style={{ marginTop: 0 }}>
            {t('启用 Code Mode 后模型可在 QuickJS 沙盒内编排多工具脚本；开启“仅 Code Mode”后所有工具与 MCP 均转为按需搜索与渐进式加载。', 'Enable QuickJS sandbox tool orchestration; Codemode Only defers all tools & MCPs for progressive on-demand loading.')}
          </p>
          <section className="grok-card-group">
            <div className="grok-card-row no-active">
              <span className="grok-row-label">{t('启用 Code Mode (codemode)', 'Enable Code Mode')}</span>
              <select
                id="bot-codemode"
                className="grok-inline-select"
                disabled={busy}
                value={draft.codemode === undefined ? '__inherit' : draft.codemode === null ? '__null' : draft.codemode ? 'true' : 'false'}
                onChange={e => updateBool('codemode', e.target.value)}
              >
                <option value="__inherit">{t('继承全局', 'Inherit global')} ({config.global.codemode ? t('开启', 'On') : t('关闭', 'Off')})</option>
                <option value="true">{t('开启', 'Enabled')}</option>
                <option value="false">{t('关闭', 'Disabled')}</option>
              </select>
            </div>
            <div className="grok-card-row no-active">
              <span className="grok-row-label">{t('仅 Code Mode (渐进式加载)', 'Codemode Only')}</span>
              <select
                id="bot-codemode-only"
                className="grok-inline-select"
                disabled={busy}
                value={draft.codemodeOnly === undefined ? '__inherit' : draft.codemodeOnly === null ? '__null' : draft.codemodeOnly ? 'true' : 'false'}
                onChange={e => updateBool('codemodeOnly', e.target.value)}
              >
                <option value="__inherit">{t('继承全局', 'Inherit global')} ({config.global.codemodeOnly ? t('开启', 'On') : t('关闭', 'Off')})</option>
                <option value="true">{t('开启（仅暴露 codemode）', 'Enabled (codemode only)')}</option>
                <option value="false">{t('关闭（保留常规工具）', 'Disabled (normal tools)')}</option>
              </select>
            </div>
          </section>

          <label className="grok-section-label">{t('模型覆盖策略', 'Model Override Policy')}</label>
          <section className="grok-card-group">
            <div className="grok-card-row no-active">
              <span className="grok-row-label">{t('显式清空模型覆盖', 'Explicitly Clear Model')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={draft.modelRef === null}
                className={`grok-toggle-switch${draft.modelRef === null ? ' checked' : ''}`}
                disabled={busy}
                onClick={() => update('modelRef', draft.modelRef === null ? undefined : null)}
              >
                <span className="grok-toggle-knob" />
              </button>
            </div>
          </section>

          <label className="grok-section-label">{t('配置透视 (Global / Override / Effective)', 'Configuration Diagnostics')}</label>
          <section className="grok-card-group" style={{ padding: '10px 14px' }}>
            <p style={{ margin: '4px 0', fontSize: '.82rem' }}>{t('中心全局', 'Global')}: {describe(config.global.modelRef)} · {describe(config.global.thinkingLevel)} · {describeCodemode(config.global)}</p>
            <p style={{ margin: '4px 0', fontSize: '.82rem' }}>{t('当前覆盖', 'Override')}: {describe(config.overrides.modelRef)} · {describe(config.overrides.thinkingLevel)} · {describeCodemode(config.overrides)}</p>
            <p style={{ margin: '4px 0', fontSize: '.82rem' }}>{t('当前有效', 'Effective')}: {describe(config.effective.modelRef)} · {describe(config.effective.thinkingLevel)} · {describeCodemode(config.effective)}</p>
          </section>

          <button type="button" className="grok-done-pill-btn" disabled={busy} onClick={() => void save()}>{t('保存高级设置', 'Save Advanced Settings')}</button>
        </>}
        <ErrorNotice error={error} onDismiss={() => setError('')}/>{notice && <ErrorNotice error={notice} tone="success" compact onDismiss={() => setNotice('')}/>}
        </>}
      </div>
    </section>
  </div>;
}
