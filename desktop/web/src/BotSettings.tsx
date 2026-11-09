// Bot 设置工作台（desktop/远程页）：SOUL.md 编辑、CPA 模型设置、插件能力、定时任务。
// 外层抽屉由 BotChats 负责；open=true 时直接展示内容，非活动 tab 的能力/任务面板不挂载、不轮询。
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CenterBotModelConfig, CenterModelSelection, CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { BotSoul, RemoteControlMethodMap } from '../../../host-core/index.js';
import { toError } from './api';
import { BotCapabilities } from './BotCapabilities';
import { BotSchedules } from './BotSchedules';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { ModelPicker } from '../../../web/src/bot-settings/ModelPicker';
import { VaultPanel, type VaultCall } from '../../../web/src/vault/VaultPanel';
import { SkillReviewPanel, type SkillReviewCall } from '../../../web/src/learning/SkillReviewPanel';
import './BotSettings.css';

/** 与 Host 的公开上限一致（UTF-8 字节）。 */
const SOUL_MAX_BYTES = 64 * 1024;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

export type BotSettingsTab = 'soul' | 'model' | 'capabilities' | 'skill-review' | 'schedules' | 'vault';

const STUDIO_TABS: { id: BotSettingsTab; label: string }[] = [
  { id: 'soul', label: '🎭 灵魂人设' },
  { id: 'model', label: '🤖 模型设置' },
  { id: 'capabilities', label: '🔌 插件与能力' },
  { id: 'skill-review', label: '✨ Skill 审阅' },
  { id: 'schedules', label: '⏰ 定时任务' },
  { id: 'vault', label: '🔒 密码库' },
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
  savedMessage: '人设已保存，下一次请求生效。',
};

const modelResource: EditorResource<CenterBotModelConfig, CenterModelSelection> = {
  label: '模型设置',
  cache: createDraftCache<CenterBotModelConfig, CenterModelSelection>(),
  read: (api, identity, botId) =>
    api.broker(identity, 'center_bot_model_get', { deviceId: identity.targetDeviceId, botId }),
  write: (api, identity, botId, baseline, value) => api.broker(identity, 'center_bot_model_set', {
    deviceId: identity.targetDeviceId, botId, expectedRevision: baseline.revision, value,
  }),
  valueOf: config => config.overrides,
  // undefined 表示继承。null 与 false 都是显式覆盖。
  equal: (a, b) => a.modelRef === b.modelRef && a.thinkingLevel === b.thinkingLevel &&
    a.codemode === b.codemode && a.codemodeOnly === b.codemodeOnly,
  savedMessage: '模型设置已保存并同步至中心。',
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
      if (adopt || (original.draft === null && !original.problem)) {
        cache.set(key, { baseline: next, draft: null, problem: null, saving: false });
        if (adopt) setNotice('已采用远端版本。');
      } else if (original.baseline?.revision === next.revision) {
        // 同一版本可以更新生效摘要，编辑继续绑定原版本。
        cache.set(key, { ...original, baseline: next });
      } else if (!original.problem) {
        cache.set(key, { ...original, problem: 'conflict' });
      }
    } catch (failure) {
      if (current()) setError(`读取${resource.label}失败。${toError(failure).message}`);
    } finally {
      if (readRef.current === read) {
        readRef.current = null;
        setReading(null);
      }
    }
  }, [api, botId, cache, key, resource]);

  useEffect(() => {
    if (active && online) void load(false);
  }, [active, generation, online, load]);

  function update(edit: (value: Value) => Value | null): void {
    const id = api.identity;
    const current = cache.get(key);
    if (!id || cacheKey(id, botId) !== key || !current.baseline || current.saving ||
      readRef.current?.generation === id.generation) return;
    const saved = resource.valueOf(current.baseline);
    const value = edit(current.draft ?? saved);
    const draft = value !== null && !resource.equal(value, saved) ? value : null;
    cache.set(key, { ...current, draft });
    setNotice(null);
  }

  async function save(): Promise<void> {
    const id = api.identity;
    const { baseline, draft, problem, saving } = cache.get(key);
    if (!id || !id.targetDeviceId || !api.transportConnected || cacheKey(id, botId) !== key ||
      !baseline || draft === null || problem || saving || readRef.current?.generation === id.generation) return;
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

interface BotSettingsProps {
  api: DesktopPanelApi;
  botId: string;
  hostLabel: string;
  hostPlatform?: string;
  tab?: BotSettingsTab;
  /** 由外层工作台抽屉控制；true 时直接展示内容。 */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}

export function BotSettings(props: BotSettingsProps) {
  const identity = props.api.identity;
  const key = identity ? cacheKey(identity, props.botId) : '';
  return props.open ? <BotSettingsSession key={key} draftKey={key} {...props} /> : null;
}

function BotSettingsSession({ api, botId, hostLabel, hostPlatform, tab, draftKey: key }: BotSettingsProps & { draftKey: string }) {
  const identity = api.identity;
  const online = api.transportConnected;
  const botPanelIdentityKey = JSON.stringify([key, identity?.generation]);
  const callBotPanel = useCallback(<M extends 'vaultControl' | 'reviewBotSkills',>(
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ) => {
    if (!identity || !isCurrent(api, identity)) return Promise.reject({ code: 'NOT_CONNECTED' });
    return api.call(identity, method, params);
  }, [api, identity]);
  const callVault = useCallback<VaultCall>(input => callBotPanel('vaultControl', input), [callBotPanel]);
  const callSkillReview = useCallback<SkillReviewCall>(input =>
    callBotPanel('reviewBotSkills', { botId, input }), [botId, callBotPanel]);

  const [localTab, setLocalTab] = useState<BotSettingsTab>('soul');
  const studioTab = tab ?? localTab;
  const soulEditor = useSettingsEditor(soulResource, api, botId, key, studioTab === 'soul');
  const modelEditor = useSettingsEditor(modelResource, api, botId, key, studioTab === 'model');
  const soulInputId = useId();
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const showModelPicker = studioTab === 'model' && modelPickerOpen;
  const [modelCatalog, setModelCatalog] = useState<CenterModelPicker | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogSeq = useRef(0);

  const loadCatalog = useCallback(async () => {
    const id = api.identity;
    if (!id || !api.transportConnected || cacheKey(id, botId) !== key) return;
    const seq = ++catalogSeq.current;
    const current = () => catalogSeq.current === seq && isCurrent(api, id);
    setCatalogError(null);
    try {
      const next = await api.broker(id, 'center_model_picker_get', {});
      if (current()) setModelCatalog(next);
    } catch (failure) {
      if (current()) setCatalogError(toError(failure).message);
    }
  }, [api, botId, key]);

  const generation = identity?.generation;
  useEffect(() => {
    if (online && showModelPicker) void loadCatalog();
    return () => { catalogSeq.current += 1; };
  }, [generation, online, showModelPicker, loadCatalog]);

  const soul = soulEditor.baseline;
  const soulValue = soulEditor.draft ?? soul?.text ?? '';
  const soulDirty = soulEditor.draft !== null;
  const currentBytes = soulBytes(soulValue);
  const byteOverLimit = currentBytes > SOUL_MAX_BYTES;
  const byteWarn = !byteOverLimit && currentBytes > SOUL_MAX_BYTES * 0.85;
  const modelConfig = modelEditor.baseline;
  const modelDraft: CenterModelSelection = modelEditor.draft ?? modelConfig?.overrides ?? {};
  const modelDirty = modelEditor.draft !== null;
  const editor = studioTab === 'soul' ? soulEditor : studioTab === 'model' ? modelEditor : null;

  function insertSoulSnippet(snippet: string): void {
    soulEditor.update(text => {
      const separator = !text ? '' : text.endsWith('\n') ? '\n' : '\n\n';
      return text + separator + snippet;
    });
  }

  function updateModelDraft(field: 'modelRef' | 'thinkingLevel', value: string | null | undefined): void {
    modelEditor.update(previous => {
      const next = { ...previous };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return next;
    });
  }

  function updateCodemodeDraft(field: 'codemode' | 'codemodeOnly', value: string): void {
    modelEditor.update(previous => {
      const next = { ...previous };
      if (value === '__inherit') delete next[field];
      else if (value === '__null') next[field] = null;
      else if (value === 'true') {
        next[field] = true;
        if (field === 'codemodeOnly') next.codemode = true;
      } else if (value === 'false') {
        next[field] = false;
        if (field === 'codemode' && next.codemodeOnly === true) next.codemodeOnly = false;
      }
      return next;
    });
  }

  const describeVal = (v: string | null | undefined) =>
    v === undefined ? '继承全局' : v === null ? '显式清空' : v;
  const describeCodemode = (sel?: CenterModelSelection) => {
    if (!sel) return '默认';
    if (sel.codemodeOnly === true) return '仅 Code Mode（渐进式加载）';
    if (sel.codemode === true) return '已开启 Code Mode';
    if (sel.codemode === false && sel.codemodeOnly === false) return '已关闭';
    return '继承全局';
  };

  const thinkingValue =
    modelDraft.thinkingLevel === undefined
      ? '__inherit'
      : modelDraft.thinkingLevel === null
        ? '__null'
        : modelDraft.thinkingLevel;

  const codemodeValue = (k: 'codemode' | 'codemodeOnly') => {
    const v = modelDraft[k];
    return v === undefined ? '__inherit' : v === null ? '__null' : v ? 'true' : 'false';
  };

  const codemodePill = (
    k: 'codemode' | 'codemodeOnly',
    value: string,
    label: string,
  ) => (
    <button
      key={value}
      type="button"
      className={`bot-studio-choice ${codemodeValue(k) === value ? 'active' : ''}`}
      disabled={modelEditor.busy || !online}
      onClick={() => updateCodemodeDraft(k, value)}
    >
      {label}
    </button>
  );

  return (
    <section className="bot-studio" aria-label="Bot 设置工作台">
      {tab === undefined || editor ? <div className="bot-studio-head">
        {tab === undefined ? <div className="pill-tabs bot-studio-tabs" role="tablist" aria-label="Bot 设置页签">
          {STUDIO_TABS.map((tab) => {
            const dirty = tab.id === 'soul' ? soulDirty : tab.id === 'model' && modelDirty;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={studioTab === tab.id}
                className={studioTab === tab.id ? 'active' : undefined}
                onClick={() => setLocalTab(tab.id)}
              >
                {tab.label}{dirty ? <span aria-hidden="true" title="有未保存修改"> ●</span> : null}
              </button>
            );
          })}
        </div> : null}
        {editor ? <div className="bot-studio-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void editor.load(false);
                if (showModelPicker) void loadCatalog();
              }}
              disabled={!online || editor.busy}
            >
              {editor.loading ? '读取中…' : '↻ 重新读取'}
            </button>
          {editor.draft !== null || editor.problem ? (
            <button
              type="button"
              className={`secondary-button ${editor.problem ? 'warn' : ''}`}
              onClick={() => void editor.load(true)}
              disabled={!online || editor.busy}
            >
              采用远端设置（丢弃本地修改）
            </button>
          ) : null}
        </div> : null}
      </div> : null}

      {!online ? <div className="status">离线：显示最后读取的设置，保存已禁用。</div> : null}
      {editor?.error ? (
        <div className="error-banner" role="alert">
          {editor.error}
          <button type="button" onClick={() => editor.setError(null)}>关闭</button>
        </div>
      ) : null}
      {editor?.notice ? <div className="status online">{editor.notice}</div> : null}
      {editor?.problem ? (
        <div className="bot-studio-lock" role="status">
          {editor.problem === 'conflict' ? '远端设置已更新。' : '上次保存结果待核对。'}
          草稿已保留。若要按远端版本继续，请先采用该版本。
        </div>
      ) : null}

      {studioTab === 'soul' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="灵魂人设">
          <div className="studio-card-header"><label htmlFor={soulInputId}>人设</label></div>
          {soul ? (
            <>
              <textarea
                id={soulInputId}
                className="soul-textarea"
                value={soulValue}
                rows={10}
                spellCheck={false}
                placeholder="写下这个智能体的职责、沟通风格和协作准则。"
                disabled={soulEditor.busy}
                onChange={(event) => soulEditor.update(() => event.target.value)}
              />
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
              <details className="bot-studio-disclosure">
                <summary>插入模板</summary>
                <div className="soul-snippet-bar">
                  {SOUL_SNIPPETS.map(snippet => (
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
              <p className="hint">人设在下一次请求生效，可留空。</p>
              <details className="bot-studio-disclosure">
                <summary>人设详情</summary>
                <p className="metadata">{soul.path} · 版本 {soul.revision}{soulDirty ? '（草稿基线）' : ''}</p>
              </details>
            </>
          ) : (
            <div className="metadata">{soulEditor.loading ? '读取中…' : '尚未读取'}</div>
          )}
        </div>
      ) : null}

      {studioTab === 'model' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="模型设置">
          {modelConfig ? (
            <>
              <div className="bot-studio-effective">
                <div className="bot-studio-model-summary">
                  <span>{modelEditor.problem ? '编辑前的模型' : '正在使用的模型'}</span>
                  <strong>{modelConfig.effective.modelRef ?? '未设置模型'}</strong>
                  <span>{modelConfig.overrides.modelRef === undefined ? '继承中心' : '此智能体单独设置'}</span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={modelPickerOpen}
                  onClick={() => setModelPickerOpen(value => !value)}
                >
                  {modelPickerOpen ? '收起模型列表' : '更换模型'}
                </button>
              </div>
              {modelDirty ? (
                <p className="hint">{modelDraft.modelRef === modelConfig.overrides.modelRef
                  ? '有未保存的高级设置'
                  : `待保存 · ${describeVal(modelDraft.modelRef)}`}</p>
              ) : null}
              {modelPickerOpen ? (
                <div className="bot-studio-advanced">
                  {catalogError ? <div className="error-banner" role="alert">读取模型列表失败。{catalogError}</div> : null}
                  <button
                    type="button"
                    aria-pressed={modelDraft.modelRef === undefined}
                    className={`bot-studio-model-row ${modelDraft.modelRef === undefined ? 'active' : ''}`}
                    disabled={modelEditor.busy || !online}
                    onClick={() => updateModelDraft('modelRef', undefined)}
                  >
                    <span className="bot-studio-model-name">继承中心全局</span>
                    <span className="bot-studio-model-ref">{describeVal(modelConfig.global.modelRef)}</span>
                  </button>
                  {modelCatalog && identity ? (
                    <ModelPicker
                      key={key}
                      catalog={modelCatalog}
                      api={api}
                      identity={identity}
                      value={modelDraft.modelRef}
                      onChange={value => updateModelDraft('modelRef', value)}
                      onStarsChange={starredModels => {
                        if (isCurrent(api, identity)) {
                          catalogSeq.current += 1;
                          setModelCatalog(previous => previous ? { ...previous, starredModels } : previous);
                        }
                      }}
                      disabled={modelEditor.busy || !online}
                    />
                  ) : !catalogError && online ? (
                    <p className="metadata" role="status">正在读取模型列表…</p>
                  ) : null}
                </div>
              ) : null}
              <details className="bot-studio-disclosure">
                <summary>高级设置</summary>
                <div className="bot-studio-advanced">
                  <div className="bot-studio-field">
                    <span className="bot-studio-field-label">
                      {`思考强度 · 全局 ${describeVal(modelConfig.global.thinkingLevel)}`}
                    </span>
                    <div className="bot-studio-choices" role="radiogroup" aria-label="思考强度">
                      {['__inherit', '__null', ...THINKING_LEVELS].map((lv) => (
                        <button
                          key={lv}
                          type="button"
                          role="radio"
                          aria-checked={thinkingValue === lv}
                          className={`bot-studio-choice ${thinkingValue === lv ? 'active' : ''}`}
                          disabled={modelEditor.busy || !online}
                          onClick={() =>
                            updateModelDraft(
                              'thinkingLevel',
                              lv === '__inherit' ? undefined : lv === '__null' ? null : lv,
                            )
                          }
                        >
                          {lv === '__inherit' ? '继承' : lv === '__null' ? '显式清空' : lv}
                        </button>
                      ))}
                      {thinkingValue !== '__inherit' &&
                      thinkingValue !== '__null' &&
                      !THINKING_LEVELS.includes(thinkingValue) ? (
                        <button
                          type="button"
                          role="radio"
                          aria-checked="true"
                          className="bot-studio-choice active"
                          disabled={modelEditor.busy || !online}
                          onClick={() => updateModelDraft('thinkingLevel', thinkingValue)}
                        >
                          {`${thinkingValue}（当前）`}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="bot-studio-field">
                    <span className="bot-studio-field-label">模型覆盖策略</span>
                    <select
                      disabled={modelEditor.busy || !online}
                      value={modelDraft.modelRef === null ? '__null' : '__normal'}
                      onChange={(e) => {
                        if (e.target.value === '__null') updateModelDraft('modelRef', null);
                        else if (modelDraft.modelRef === null) updateModelDraft('modelRef', undefined);
                      }}
                    >
                      <option value="__normal">正常（继承全局或使用所选模型）</option>
                      <option value="__null">显式清空（强制阻断继承全局模型）</option>
                    </select>
                  </div>
                  <div className="bot-studio-field">
                    <span className="bot-studio-field-label">
                      {`启用 Code Mode · 全局 ${modelConfig.global.codemode ? '开启' : '关闭'}`}
                    </span>
                    <div className="bot-studio-choices">
                      {codemodePill('codemode', '__inherit', '继承')}
                      {codemodePill('codemode', 'true', '开启')}
                      {codemodePill('codemode', 'false', '关闭')}
                    </div>
                    {modelDraft.codemode === null ? <span className="hint">当前为显式清空。</span> : null}
                  </div>
                  <div className="bot-studio-field">
                    <span className="bot-studio-field-label">
                      {`仅 Code Mode 模式 · 全局 ${modelConfig.global.codemodeOnly ? '开启' : '关闭'}`}
                    </span>
                    <div className="bot-studio-choices">
                      {codemodePill('codemodeOnly', '__inherit', '继承')}
                      {codemodePill('codemodeOnly', 'true', '开启')}
                      {codemodePill('codemodeOnly', 'false', '关闭')}
                    </div>
                    {modelDraft.codemodeOnly === null ? <span className="hint">当前为显式清空。</span> : null}
                  </div>
                  <p className="hint">
                    Code Mode 允许模型在受控环境中编排工具调用。仅 Code Mode 模式会改为按需加载工具。
                  </p>
                  <div className="metadata">
                    {`${modelDirty ? '草稿基线' : '当前覆盖'} · ${describeVal(modelConfig.overrides.modelRef)} (${describeVal(modelConfig.overrides.thinkingLevel)}, ${describeCodemode(modelConfig.overrides)}) · revision ${modelConfig.revision}`}
                  </div>
                </div>
              </details>
              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!online || !modelDirty || modelEditor.busy || !!modelEditor.problem}
                  onClick={() => void modelEditor.save()}
                >
                  {modelEditor.saving ? '保存中…' : '保存模型设置'}
                </button>
              </div>
            </>
          ) : (
            <div className="metadata">{modelEditor.loading ? '读取模型配置中…' : '尚未加载模型配置'}</div>
          )}
        </div>
      ) : null}

      {studioTab === 'skill-review' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="Skill 审阅">
          <SkillReviewPanel key={botPanelIdentityKey}
            connected={online && !!identity} call={callSkillReview} />
        </div>
      ) : null}

      {studioTab === 'vault' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="密码库">
          <VaultPanel identityKey={botPanelIdentityKey} botId={botId} deviceId={identity?.targetDeviceId}
            hostLabel={hostLabel} connected={online && !!identity} call={callVault} variant="desktop" />
        </div>
      ) : null}

      {studioTab === 'capabilities' && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="插件与能力">
          <BotCapabilities key={`${identity.targetDeviceId}\u0000${botId}`} api={api} identity={identity} deviceId={identity.targetDeviceId} botId={botId} />
        </div>
      ) : null}

      {studioTab === 'schedules' && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="定时任务">
          <BotSchedules key={`${identity.targetDeviceId}\u0000${botId}`} api={api} identity={identity} botId={botId} hostPlatform={hostPlatform} />
        </div>
      ) : null}
    </section>
  );
}
