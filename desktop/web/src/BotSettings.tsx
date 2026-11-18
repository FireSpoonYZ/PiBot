// Bot 设置工作台（桌面端）：统一 6 大核心设置项（模型 / 人设 / 技能 / 工具扩展 / 定时任务 / 密码凭据）。
// 模型采用免密二态即点即存视图，技能由 BotSkillsPage 独立承担，工具扩展仅展示 MCP 与插件。
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CenterBotModelConfig, CenterModelPicker, CenterModelSelection } from '../../../host-core/desktop-client.js';
import type { BotSoul, RemoteControlMethodMap } from '../../../host-core/index.js';
import { toError } from './api';
import { BotCapabilities } from './BotCapabilities';
import { BotSchedules } from './BotSchedules';
import { openCenterManagement } from './CenterGate';
import type { CenterAdminTab } from './SettingsPanel';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { BotSkillsPage } from '../../../web/src/bot-settings/BotSkillsPage';
import { ModelPicker } from '../../../web/src/bot-settings/ModelPicker';
import { Markdown } from '../../../web/src/Markdown';
import { VaultPanel, type VaultCall } from '../../../web/src/vault/VaultPanel';
import './BotSettings.css';

/** 与 Host 的公开上限一致（UTF-8 字节）。 */
const SOUL_MAX_BYTES = 64 * 1024;

const THINKING_CHOICES: Array<{ value: string | undefined; label: string }> = [
  { value: undefined, label: '跟随默认' },
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '均衡' },
  { value: 'high', label: '深度' },
  { value: 'xhigh', label: '极致' },
  { value: 'max', label: '最大' },
];

type CodeModeChoice = 'inherit' | 'standard' | 'hybrid' | 'only';

const CODEMODE_CHOICES: Array<{ id: CodeModeChoice; label: string; desc: string }> = [
  { id: 'inherit', label: '跟随全局设置', desc: '使用中心全局默认的工具调用方式' },
  { id: 'standard', label: '标准工具调用', desc: '直接向模型暴露全部已启用工具定义' },
  { id: 'hybrid', label: '混合模式（支持 Code Mode）', desc: '保留标准工具并允许在受控沙箱编排调用' },
  { id: 'only', label: '仅 Code Mode（按需加载）', desc: '减少上下文占用，按需发现并执行工具' },
];

const SOUL_SNIPPETS: { label: string; content: string }[] = [
  {
    label: '＋ 角色使命',
    content: '# 角色与职责定位\n你是专注本工作区与目标领域的智能体搭档，结合上下文与实证数据直接推进任务并给出可靠结论。\n',
  },
  {
    label: '＋ 沟通风格',
    content: '# 沟通与表达风格\n- 自然温和、实事求是：像熟悉业务的靠谱搭档交流；已掌握答案或完成核查时第一句直奔结论，需调用工具排查时伴随工具调用简明交代第一步，不在核实前猜测结论，不重复问题、不加客服套话与多余尾注。\n- 篇幅克制、自然段落：日常简明扼要，复杂任务才展开完整细节；优先用连贯自然句表达，仅在真正并列或对比时使用列表与表格。\n',
  },
  {
    label: '＋ 群聊准则',
    content: '# 多 Bot 协作偏好\n- 发挥自身专长，对可并行或跨设备的子任务积极配合同伴 Bot 分工。\n- 聚焦实质进展与有效结论，其他成员已完整解答或无需补充时保持安静，不发无意义的附和与礼貌回执。\n',
  },
  {
    label: '＋ 安全禁区',
    content: '# 审慎与边界偏好\n- 专注当前工作区与用户委托的目标范围，不擅自触碰无关目录或敏感凭据；涉及不可逆改动前先请用户确认。\n',
  },
];

export type BotSettingsTab = 'model' | 'soul' | 'skills' | 'capabilities' | 'schedules' | 'vault';

const STUDIO_TABS: { id: BotSettingsTab; label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'soul', label: '人设' },
  { id: 'skills', label: '技能' },
  { id: 'capabilities', label: '工具扩展' },
  { id: 'schedules', label: '定时任务' },
  { id: 'vault', label: '密码凭据' },
];

type DraftProblem = 'conflict' | 'unconfirmed';

interface DraftState<Config, Value> {
  baseline: Config | null;
  draft: Value | null;
  problem: DraftProblem | null;
  saving: boolean;
}

/** 关闭抽屉后，草稿、CAS 基线和进行中的保存仍属于原智能体。 */
function createDraftCache<Config, Value>() {
  const empty: DraftState<Config, Value> = { baseline: null, draft: null, problem: null, saving: false };
  const entries = new Map<string, DraftState<Config, Value>>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key: string) => entries.get(key) ?? empty,
    set(key: string, value: DraftState<Config, Value>) {
      entries.set(key, value);
      listeners.get(key)?.forEach(listener => listener());
    },
    subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, subscribers);
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(key);
      };
    },
  };
}

function cacheKey(identity: DesktopIdentity, botId: string): string {
  return JSON.stringify([identity.profileId, identity.kind, identity.targetDeviceId, botId]);
}

function isCurrent(api: DesktopPanelApi, identity: DesktopIdentity): boolean {
  const current = api.identity;
  return api.transportConnected && !!current &&
    current.profileId === identity.profileId && current.kind === identity.kind &&
    current.targetDeviceId === identity.targetDeviceId && current.generation === identity.generation;
}

interface EditorResource<Config extends { revision: string | number }, Value> {
  label: string;
  cache: ReturnType<typeof createDraftCache<Config, Value>>;
  read(api: DesktopPanelApi, identity: DesktopIdentity, botId: string): Promise<Config>;
  write(api: DesktopPanelApi, identity: DesktopIdentity, botId: string, baseline: Config, value: Value): Promise<Config>;
  valueOf(config: Config): Value;
  equal(a: Value, b: Value): boolean;
  savedMessage: string;
}

const soulResource: EditorResource<BotSoul, string> = {
  label: '人设',
  cache: createDraftCache<BotSoul, string>(),
  read: (api, identity, botId) => api.call(identity, 'getBotSoul', { botId }),
  write: (api, identity, botId, baseline, text) =>
    api.call(identity, 'setBotSoul', { botId, input: { expectedRevision: baseline.revision, text } }),
  valueOf: config => config.text,
  equal: (a, b) => a === b,
  savedMessage: '✓ 人设已保存，下一次对话生效。',
};

function useSettingsEditor<Config extends { revision: string | number }, Value>(
  resource: EditorResource<Config, Value>,
  api: DesktopPanelApi,
  botId: string,
  key: string,
  active: boolean,
) {
  const { cache } = resource;
  const generation = api.identity?.generation;
  const online = api.transportConnected;
  const subscribe = useCallback((listener: () => void) => cache.subscribe(key, listener), [cache, key]);
  const getSnapshot = useCallback(() => cache.get(key), [cache, key]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const readRef = useRef<{ generation: number } | null>(null);
  const alive = useRef(false);
  const [reading, setReading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loading = reading !== null && reading === generation;

  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readRef.current = null;
    };
  }, []);

  const load = useCallback(async (adopt: boolean): Promise<void> => {
    const id = api.identity;
    const original = cache.get(key);
    if (!id || !api.transportConnected || cacheKey(id, botId) !== key ||
      original.saving || readRef.current?.generation === id.generation) return;
    const read = { generation: id.generation };
    readRef.current = read;
    const current = () => readRef.current === read && isCurrent(api, id) && cache.get(key) === original;
    setReading(id.generation);
    setError(null);
    setNotice(null);
    try {
      const next = await resource.read(api, id, botId);
      if (!current()) return;
      const keepDraft = !adopt && original.draft !== null;
      const resolved = keepDraft && !original.problem &&
        resource.equal(original.draft!, resource.valueOf(next)) ? null : original.draft;
      cache.set(key, { baseline: next, draft: keepDraft ? resolved : null, problem: null, saving: false });
    } catch (failure) {
      if (alive.current && readRef.current === read && isCurrent(api, id)) {
        setError(`读取${resource.label}失败：${toError(failure).message}`);
      }
    } finally {
      if (readRef.current === read) {
        readRef.current = null;
        if (alive.current) setReading(null);
      }
    }
  }, [api, botId, cache, key, resource]);

  useEffect(() => {
    if (active && online && !state.saving) void load(false);
  }, [active, generation, online, state.saving, load]);

  function update(transform: (previous: Value) => Value | null): void {
    const current = cache.get(key);
    if (!current.baseline || current.saving) return;
    const baseValue = resource.valueOf(current.baseline);
    const nextDraft = transform(current.draft ?? baseValue);
    setError(null);
    setNotice(null);
    cache.set(key, {
      ...current,
      draft: nextDraft !== null && !resource.equal(nextDraft, baseValue) ? nextDraft : null,
    });
  }

  async function save(): Promise<void> {
    const id = api.identity;
    const { baseline, draft, problem, saving } = cache.get(key);
    if (!id || !isCurrent(api, id) || !baseline || draft === null || saving) return;
    const inFlight = { baseline, draft, problem, saving: true };
    cache.set(key, inFlight);
    setError(null);
    setNotice(null);
    try {
      const next = await resource.write(api, id, botId, baseline, draft);
      if (cache.get(key) !== inFlight) return;
      if (!isCurrent(api, id)) {
        cache.set(key, { ...inFlight, problem: 'unconfirmed', saving: false });
        return;
      }
      cache.set(key, { baseline: next, draft: null, problem: null, saving: false });
      if (alive.current) setNotice(resource.savedMessage);
    } catch (failure) {
      if (cache.get(key) !== inFlight) return;
      const err = toError(failure);
      const conflict = err.code === 'REQUEST_CONFLICT' || err.code === 'REVISION_CONFLICT';
      const nextProblem = conflict ? 'conflict' :
        err.outcome === 'unconfirmed' && err.code !== 'RUNTIME_BUSY' ? 'unconfirmed' : null;
      cache.set(key, { ...inFlight, problem: nextProblem, saving: false });
      if (alive.current && isCurrent(api, id) && !nextProblem) {
        setError(err.code === 'RUNTIME_BUSY'
          ? '智能体正忙。草稿已保留，任务结束后可重试。'
          : `保存${resource.label}失败，草稿已保留。${err.message}`);
      }
    }
  }

  return { ...state, loading, error, notice, setError, load, update, save, busy: loading || state.saving };
}

function soulBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function resolveCodemodeChoice(sel: CenterModelSelection): CodeModeChoice {
  if (sel.codemodeOnly === true) return 'only';
  if (sel.codemode === true) return 'hybrid';
  if (sel.codemode === false && sel.codemodeOnly === false) return 'standard';
  return 'inherit';
}

function BotModelSection({
  api,
  identity,
  botId,
  online,
  onOpenCenterAdmin,
  onModelSaved,
}: {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  botId: string;
  online: boolean;
  onOpenCenterAdmin?: (tab?: CenterAdminTab) => void;
  onModelSaved?: (config: CenterBotModelConfig) => void;
}) {
  const [config, setConfig] = useState<CenterBotModelConfig | null>(null);
  const [catalog, setCatalog] = useState<CenterModelPicker | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);

  const aliveRef = useRef(true);
  const configRef = useRef<CenterBotModelConfig | null>(null);
  const saveChainRef = useRef(Promise.resolve());
  const savedTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimeout(savedTimerRef.current);
    };
  }, []);

  const loadAll = useCallback(async () => {
    if (!identity || !online || !isCurrent(api, identity)) return;
    setLoading(true);
    setError(null);
    try {
      const [cfg, cat] = await Promise.all([
        api.broker(identity, 'center_bot_model_get', { deviceId: identity.targetDeviceId, botId }),
        api.broker(identity, 'center_model_picker_get', {}),
      ]);
      if (!aliveRef.current || !isCurrent(api, identity)) return;
      configRef.current = cfg;
      setConfig(cfg);
      setCatalog(cat);
      setCustomMode(typeof cfg.overrides.modelRef === 'string' && cfg.overrides.modelRef.length > 0);
    } catch (failure) {
      if (!aliveRef.current) return;
      setError(toError(failure).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [api, identity, botId, online]);

  const generation = identity?.generation;
  useEffect(() => {
    void loadAll();
  }, [loadAll, generation]);

  const commitOverrides = (transform: (current: CenterModelSelection) => CenterModelSelection) => {
    if (!identity || !online || !configRef.current) return;
    setError(null);
    setSaving(true);
    setSavedOk(false);
    saveChainRef.current = saveChainRef.current.then(async () => {
      const currentCfg = configRef.current;
      if (!currentCfg || !isCurrent(api, identity)) return;
      const nextValue = transform({ ...currentCfg.overrides });
      try {
        const updated = await api.broker(identity, 'center_bot_model_set', {
          deviceId: identity.targetDeviceId,
          botId,
          expectedRevision: currentCfg.revision,
          value: nextValue,
        });
        if (!aliveRef.current || !isCurrent(api, identity)) return;
        configRef.current = updated;
        setConfig(updated);
        onModelSaved?.(updated);
        setSavedOk(true);
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => {
          if (aliveRef.current) setSavedOk(false);
        }, 1800);
      } catch (failure) {
        if (!aliveRef.current) return;
        const err = toError(failure);
        setError(err.message);
        if (err.code === 'REVISION_CONFLICT' || err.code === 'REQUEST_CONFLICT') {
          await loadAll();
        }
      } finally {
        if (aliveRef.current) setSaving(false);
      }
    });
  };

  if (loading && !config) {
    return <div className="metadata">正在读取模型配置…</div>;
  }

  if (!config) {
    return (
      <div className="studio-empty-state">
        {error ? (
          <div className="error-banner" role="alert">
            {error}
            <button type="button" onClick={() => void loadAll()}>重试</button>
          </div>
        ) : (
          <p className="metadata">暂未获取到模型配置。</p>
        )}
      </div>
    );
  }

  const models = catalog?.models ?? [];
  const globalRef = config.global.modelRef ?? null;
  const globalEntry = globalRef ? models.find((m) => m.modelRef === globalRef) : undefined;
  const globalDisplay = globalEntry?.name || globalRef || '未设置全局默认';

  const hasBotOverride = typeof config.overrides.modelRef === 'string' && config.overrides.modelRef.length > 0;
  const isCustom = customMode || hasBotOverride;

  const effectiveRef = config.effective.modelRef ?? globalRef;
  const effectiveEntry = effectiveRef ? models.find((m) => m.modelRef === effectiveRef) : undefined;
  const effectiveDisplay = effectiveEntry?.name || effectiveRef || '暂未配置可用模型';
  const supportsReasoning = effectiveEntry ? effectiveEntry.reasoning === true : false;
  const codemodeChoice = resolveCodemodeChoice(config.overrides);

  const selectFollowGlobal = () => {
    setCustomMode(false);
    if (config.overrides.modelRef !== undefined) {
      commitOverrides((prev) => {
        const next = { ...prev };
        delete next.modelRef;
        return next;
      });
    }
  };

  const selectCustomMode = () => {
    setCustomMode(true);
  };

  const selectModelRef = (modelRef: string) => {
    setCustomMode(true);
    commitOverrides((prev) => ({ ...prev, modelRef }));
  };

  const selectThinking = (level: string | undefined) => {
    commitOverrides((prev) => {
      const next = { ...prev };
      if (level === undefined) delete next.thinkingLevel;
      else next.thinkingLevel = level;
      return next;
    });
  };

  const selectCodemode = (choice: CodeModeChoice) => {
    commitOverrides((prev) => {
      const next = { ...prev };
      if (choice === 'inherit') {
        delete next.codemode;
        delete next.codemodeOnly;
      } else if (choice === 'standard') {
        next.codemode = false;
        next.codemodeOnly = false;
      } else if (choice === 'hybrid') {
        next.codemode = true;
        next.codemodeOnly = false;
      } else {
        next.codemode = true;
        next.codemodeOnly = true;
      }
      return next;
    });
  };

  return (
    <div className="bot-model-panel">
      <div className="bot-model-status-bar">
        <div className="bot-studio-model-summary">
          <span className="metadata">当前生效模型</span>
          <strong>
            {effectiveDisplay}
            {!hasBotOverride && effectiveRef ? <span className="bot-model-default-badge">默认</span> : null}
          </strong>
        </div>
        <div className="bot-model-save-indicator" aria-live="polite">
          {saving && <span className="metadata">保存中…</span>}
          {!saving && savedOk && <span className="status online">✓ 已保存</span>}
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      {catalog && models.length === 0 ? (
        <div className="bot-model-empty-card">
          <p className="metadata">中心尚未添加可用模型服务商。</p>
          {onOpenCenterAdmin && (
            <button type="button" className="primary-button" onClick={() => onOpenCenterAdmin('providers')}>
              去中心管理配置服务商 →
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="bot-studio-field">
            <span className="bot-studio-field-label">模型来源</span>
            <div className="bot-model-mode-cards" role="radiogroup" aria-label="模型来源">
              <button
                type="button"
                role="radio"
                aria-checked={!isCustom}
                className={'bot-model-mode-card' + (!isCustom ? ' active' : '')}
                disabled={!online}
                onClick={selectFollowGlobal}
              >
                <strong>跟随全局默认</strong>
                <span className="metadata">{globalDisplay}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={isCustom}
                className={'bot-model-mode-card' + (isCustom ? ' active' : '')}
                disabled={!online}
                onClick={selectCustomMode}
              >
                <strong>为此智能体指定模型</strong>
                <span className="metadata">
                  {hasBotOverride
                    ? (models.find((m) => m.modelRef === config.overrides.modelRef)?.name || config.overrides.modelRef)
                    : '从已配置服务商中任选'}
                </span>
              </button>
            </div>
          </div>

          {isCustom && catalog && identity && (
            <div className="bot-model-picker-wrap">
              <ModelPicker
                catalog={catalog}
                api={api}
                identity={identity}
                value={config.overrides.modelRef ?? null}
                onChange={selectModelRef}
                onStarsChange={(starredModels) => setCatalog((prev) => (prev ? { ...prev, starredModels } : prev))}
                disabled={!online}
              />
            </div>
          )}

          {supportsReasoning && (
            <div className="bot-studio-field">
              <span className="bot-studio-field-label">思考强度</span>
              <div className="bot-studio-choices" role="radiogroup" aria-label="思考强度">
                {THINKING_CHOICES.map((choice) => {
                  const active = choice.value === undefined
                    ? config.overrides.thinkingLevel === undefined
                    : config.overrides.thinkingLevel === choice.value;
                  return (
                    <button
                      key={choice.label}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`bot-studio-choice${active ? ' active' : ''}`}
                      disabled={!online}
                      onClick={() => selectThinking(choice.value)}
                    >
                      {choice.label}
                    </button>
                  );
                })}
              </div>
              <span className="hint">档位越高思考越深入，响应耗时也会相应增加。</span>
            </div>
          )}

          <details className="bot-studio-disclosure">
            <summary>高级工具调用方式</summary>
            <div className="bot-model-advanced-radios" role="radiogroup" aria-label="高级工具调用方式">
              {CODEMODE_CHOICES.map((choice) => (
                <label key={choice.id} className={'bot-model-radio-row' + (codemodeChoice === choice.id ? ' active' : '')}>
                  <input
                    type="radio"
                    name={`codemode-${botId}`}
                    checked={codemodeChoice === choice.id}
                    disabled={!online}
                    onChange={() => selectCodemode(choice.id)}
                  />
                  <span className="bot-model-radio-copy">
                    <strong>{choice.label}</strong>
                    <span className="metadata">{choice.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

interface BotSettingsProps {
  api: DesktopPanelApi;
  botId: string;
  botName?: string;
  hostLabel: string;
  hostPlatform?: string;
  tab?: BotSettingsTab;
  /** 由外层工作台抽屉控制；true 时直接展示内容。 */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  onOpenCenterAdmin?: (tab?: CenterAdminTab) => void;
  onModelSaved?: (config: CenterBotModelConfig) => void;
}

export function BotSettings(props: BotSettingsProps) {
  const identity = props.api.identity;
  const key = identity ? cacheKey(identity, props.botId) : '';
  return props.open ? <BotSettingsSession key={key} draftKey={key} {...props} /> : null;
}

function BotSettingsSession({
  api,
  botId,
  botName,
  hostLabel,
  hostPlatform,
  tab,
  draftKey: key,
  onOpenCenterAdmin,
  onModelSaved,
}: BotSettingsProps & { draftKey: string }) {
  const identity = api.identity;
  const online = api.transportConnected;
  const botPanelIdentityKey = JSON.stringify([key, identity?.generation]);
  const callBotPanel = useCallback(<M extends 'vaultControl'>(
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ) => {
    if (!identity || !isCurrent(api, identity)) return Promise.reject({ code: 'NOT_CONNECTED' });
    return api.call(identity, method, params);
  }, [api, identity]);
  const callVault = useCallback<VaultCall>((input) => callBotPanel('vaultControl', input), [callBotPanel]);

  const [localTab, setLocalTab] = useState<BotSettingsTab>('model');
  const [soulMode, setSoulMode] = useState<'edit' | 'preview'>('edit');
  const studioTab = tab ?? localTab;
  const soulEditor = useSettingsEditor(soulResource, api, botId, key, studioTab === 'soul');
  const soulInputId = useId();

  const soul = soulEditor.baseline;
  const soulValue = soulEditor.draft ?? soul?.text ?? '';
  const soulDirty = soulEditor.draft !== null;
  const currentBytes = soulBytes(soulValue);
  const byteOverLimit = currentBytes > SOUL_MAX_BYTES;
  const byteWarn = !byteOverLimit && currentBytes > SOUL_MAX_BYTES * 0.85;

  function insertSoulSnippet(snippet: string): void {
    setSoulMode('edit');
    soulEditor.update((text) => {
      const separator = !text ? '' : text.endsWith('\n') ? '\n' : '\n\n';
      return text + separator + snippet;
    });
  }

  return (
    <section className="bot-studio" aria-label="智能体配置">
      {tab === undefined || studioTab === 'soul' ? (
        <div className="bot-studio-head">
          {tab === undefined ? (
            <div className="pill-tabs bot-studio-tabs" role="tablist" aria-label="智能体设置页签">
              {STUDIO_TABS.map((item) => {
                const dirty = item.id === 'soul' && soulDirty;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={studioTab === item.id}
                    className={studioTab === item.id ? 'active' : undefined}
                    onClick={() => setLocalTab(item.id)}
                  >
                    {item.label}{dirty ? <span aria-hidden="true" title="有未保存修改"> ●</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {studioTab === 'soul' ? (
            <div className="bot-studio-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void soulEditor.load(false)}
                disabled={!online || soulEditor.busy}
              >
                {soulEditor.loading ? '读取中…' : '↻ 重新读取'}
              </button>
              {soulEditor.draft !== null || soulEditor.problem ? (
                <button
                  type="button"
                  className={`secondary-button ${soulEditor.problem ? 'warn' : ''}`}
                  onClick={() => void soulEditor.load(true)}
                  disabled={!online || soulEditor.busy}
                >
                  采用远端设置
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!online && studioTab !== 'skills' ? (
        <div className="status">当前连接已断开：仅显示已读取的内容，修改暂不可保存。</div>
      ) : null}

      {studioTab === 'soul' && soulEditor.error ? (
        <div className="error-banner" role="alert">
          {soulEditor.error}
          <button type="button" onClick={() => soulEditor.setError(null)}>关闭</button>
        </div>
      ) : null}
      {studioTab === 'soul' && soulEditor.notice ? <div className="status online">{soulEditor.notice}</div> : null}
      {studioTab === 'soul' && soulEditor.problem ? (
        <div className="bot-studio-lock" role="status">
          {soulEditor.problem === 'conflict' ? '远端人设已更新。' : '上次保存结果待核对。'}
          本地草稿已保留，如需同步远端版本请点击「采用远端设置」。
        </div>
      ) : null}

      {studioTab === 'model' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="模型设置">
          <BotModelSection
            api={api}
            identity={identity}
            botId={botId}
            online={online}
            onOpenCenterAdmin={onOpenCenterAdmin}
            onModelSaved={onModelSaved}
          />
        </div>
      ) : null}

      {studioTab === 'soul' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="人设 (SOUL.md)">
          <div className="studio-card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <label htmlFor={soulInputId}>人设 (SOUL.md)</label>
            <div className="bot-studio-choices" role="tablist" aria-label="人设模式">
              <button
                type="button"
                role="tab"
                aria-selected={soulMode === 'edit'}
                className={`bot-studio-choice${soulMode === 'edit' ? ' active' : ''}`}
                onClick={() => setSoulMode('edit')}
              >
                编辑
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={soulMode === 'preview'}
                className={`bot-studio-choice${soulMode === 'preview' ? ' active' : ''}`}
                onClick={() => setSoulMode('preview')}
              >
                Markdown 预览
              </button>
            </div>
          </div>
          {soul ? (
            <>
              {soulMode === 'edit' ? (
                <textarea
                  id={soulInputId}
                  className="soul-textarea"
                  value={soulValue}
                  rows={11}
                  spellCheck={false}
                  placeholder="写下这个智能体的职责、沟通风格与边界准则（支持 Markdown）。"
                  disabled={soulEditor.busy}
                  onChange={(event) => soulEditor.update(() => event.target.value)}
                />
              ) : (
                <div className="soul-preview-box">
                  <Markdown
                    text={soulValue.trim() ? soulValue : '_尚未编写人设内容，可切回「编辑」添加。_'}
                    onOpenLink={(href) => void openCenterManagement(href)}
                  />
                </div>
              )}

              {byteWarn ? (
                <p className={byteOverLimit ? 'error-banner' : 'hint'} role="status">
                  {byteOverLimit ? '人设超过 64 KiB 上限。' : '人设接近 64 KiB 上限。'} 当前 {currentBytes.toLocaleString()} 字节。
                </p>
              ) : null}

              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    if (!byteOverLimit) void soulEditor.save();
                  }}
                  disabled={!online || !soulDirty || soulEditor.busy || !!soulEditor.problem || byteOverLimit}
                >
                  {soulEditor.saving ? '保存中…' : '保存人设'}
                </button>
                {soulDirty && !soulEditor.problem ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => soulEditor.update(() => null)}
                    disabled={soulEditor.busy}
                  >
                    放弃修改
                  </button>
                ) : null}
              </div>

              {soulMode === 'edit' && (
                <details className="bot-studio-disclosure">
                  <summary>插入常用人设片段</summary>
                  <div className="soul-snippet-bar">
                    {SOUL_SNIPPETS.map((snippet) => (
                      <button
                        key={snippet.label}
                        type="button"
                        className="snippet-chip"
                        disabled={soulEditor.busy}
                        onClick={() => insertSoulSnippet(snippet.content)}
                      >
                        {snippet.label}
                      </button>
                    ))}
                  </div>
                </details>
              )}
              <p className="hint">人设保存在设备本地 SOUL.md，将在下一次对话请求时生效。</p>
            </>
          ) : (
            <div className="metadata">{soulEditor.loading ? '正在读取人设…' : '尚未加载人设'}</div>
          )}
        </div>
      ) : null}

      {studioTab === 'skills' && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="技能 (Skills)">
          <BotSkillsPage
            key={`${identity.targetDeviceId}\u0000${botId}`}
            api={api}
            identity={identity}
            deviceId={identity.targetDeviceId}
            botId={botId}
            botName={botName}
          />
        </div>
      ) : null}

      {studioTab === 'capabilities' && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="工具扩展 (MCP & 插件)">
          <BotCapabilities
            key={`${identity.targetDeviceId}\u0000${botId}`}
            api={api}
            identity={identity}
            deviceId={identity.targetDeviceId}
            botId={botId}
            showTitle={false}
            onOpenCenterAdmin={() => onOpenCenterAdmin?.('capabilities')}
          />
        </div>
      ) : null}

      {studioTab === 'schedules' && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="定时任务">
          <BotSchedules
            key={`${identity.targetDeviceId}\u0000${botId}`}
            api={api}
            identity={identity}
            botId={botId}
            hostPlatform={hostPlatform}
          />
        </div>
      ) : null}

      {studioTab === 'vault' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="密码凭据">
          <VaultPanel
            identityKey={botPanelIdentityKey}
            botId={botId}
            deviceId={identity?.targetDeviceId}
            hostLabel={hostLabel}
            connected={online && !!identity}
            call={callVault}
            variant="desktop"
            onOpenGlobalVault={() => onOpenCenterAdmin?.('vault')}
          />
        </div>
      ) : null}
    </section>
  );
}
