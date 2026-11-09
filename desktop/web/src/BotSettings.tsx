// Bot 设置工作台（desktop/远程页）：SOUL.md 编辑、CPA 模型设置、插件能力、定时任务。
// 外层抽屉由 BotChats 负责；open=true 时直接展示内容，非活动 tab 的能力/任务面板不挂载、不轮询。
// 显式读取 + CAS 保存：冲突/结果未确认只锁保存，只有显式“采用远端设置（丢弃本地修改）”才换基线；
// 未保存草稿连同其原始基线（含 revision）按 profile+target+bot 保留，自动读取绝不替换 dirty 部分的基线，
// 因此旧草稿不会拿到未看过的远端 revision 去覆盖远端；不自动重放、不跨 Host 串数据。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CenterBotModelConfig, CenterModelSelection, CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { BotSoul, RemoteControlMethodMap } from '../../../host-core/index.js';
import { toError } from './api';
import { openCenterManagement } from './CenterGate';
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

type StudioTab = 'soul' | 'model' | 'capabilities' | 'skill-review' | 'schedules' | 'vault';

const STUDIO_TABS: { id: StudioTab; label: string }[] = [
  { id: 'soul', label: '🎭 灵魂人设' },
  { id: 'model', label: '🤖 模型设置' },
  { id: 'capabilities', label: '🔌 插件与能力' },
  { id: 'skill-review', label: '✨ Skill 审阅' },
  { id: 'schedules', label: '⏰ 定时任务' },
  { id: 'vault', label: '🔒 密码库' },
];

/** 一个 Bot 的本地编辑状态：草稿与其原始基线成对保存，切走/重挂载后 CAS 仍指向同一远端版本。 */
interface Cached {
  soul: BotSoul | null;
  soulDraft: string | null;
  /** 上次保存冲突/结果未确认：锁定保存，直到用户显式采用远端。 */
  lock: boolean;
}

/** 按 profile+target+bot 保留（不含 generation，重连后仍可继续编辑）。 */
const draftCache = new Map<string, Cached>();

function cacheKey(identity: DesktopIdentity, botId: string): string {
  return `${identity.profileId}\u0000${identity.targetDeviceId}\u0000${botId}`;
}

function soulBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function BotSettings({
  api,
  botId,
  hostLabel,
  open,
}: {
  api: DesktopPanelApi;
  botId: string;
  hostLabel: string;
  /** 由外层工作台抽屉控制；true 时直接展示内容。 */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}) {
  const identity = api.identity;
  const online = api.transportConnected;
  const key = identity ? cacheKey(identity, botId) : '';
  const cached = key ? draftCache.get(key) : undefined;
  const botPanelIdentityKey = JSON.stringify([identity?.profileId, identity?.targetDeviceId, identity?.kind, identity?.generation]);
  const callBotPanel = useCallback(<M extends 'vaultControl' | 'reviewBotSkills',>(
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ) => {
    const current = api.identity;
    if (!identity || !current || !api.transportConnected ||
      current.profileId !== identity.profileId || current.targetDeviceId !== identity.targetDeviceId ||
      current.kind !== identity.kind || current.generation !== identity.generation) {
      return Promise.reject({ code: 'NOT_CONNECTED' });
    }
    return api.call(identity, method, params);
  }, [api, identity]);
  const callVault = useCallback<VaultCall>(input => callBotPanel('vaultControl', input), [callBotPanel]);
  const callSkillReview = useCallback<SkillReviewCall>(input =>
    callBotPanel('reviewBotSkills', { botId, input }), [botId, callBotPanel]);

  const [soul, setSoul] = useState<BotSoul | null>(cached?.soul ?? null);
  const [soulDraft, setSoulDraft] = useState<string | null>(cached?.soulDraft ?? null);
  const [locked, setLocked] = useState(!!cached?.lock);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<'soul' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [studioTab, setStudioTab] = useState<StudioTab>('soul');

  const [modelConfig, setModelConfig] = useState<CenterBotModelConfig | null>(null);
  const [modelDraft, setModelDraft] = useState<CenterModelSelection>({});
  const [modelCatalog, setModelCatalog] = useState<CenterModelPicker | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  const mountedRef = useRef(true);
  /** 读取代次：同一选择内只应用最后一次读取。 */
  const seqRef = useRef(0);
  /** 写入代次：保存成功后作废发起更早的读取响应，避免把旧 revision 当基线。 */
  const writeSeqRef = useRef(0);
  /** 最近一次渲染的本地状态；响应应用时按“当前”状态判断该部分是否已被编辑。 */
  const liveRef = useRef<Cached>({ soul: null, soulDraft: null, lock: false });
  liveRef.current = { soul, soulDraft, lock: locked };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /** 选择是否已变（profile/target/bot）或已卸载：迟到结果一律丢弃。 */
  const stale = useCallback((sel: string): boolean => {
    if (!mountedRef.current) return true;
    const cur = api.identity;
    return !cur || cacheKey(cur, botId) !== sel;
  }, [api, botId]);

  /** 每次状态变更都把草稿与基线成对写回缓存，保证重挂载后 CAS 仍用原 revision。 */
  const remember = useCallback((patch: Partial<Cached>): void => {
    if (!key) return;
    draftCache.set(key, { ...liveRef.current, ...patch });
  }, [key]);

  // SOUL 逐字节比较，不 trim：空内容与尾部空白都是有效文本。
  function updateSoul(next: string | null): void {
    const base = liveRef.current.soul;
    const draft = next !== null && base && next === base.text ? null : next;
    setSoulDraft(draft);
    setNotice(null);
    liveRef.current = { ...liveRef.current, soulDraft: draft };
    remember({ soulDraft: draft });
  }

  function insertSoulSnippet(snippet: string): void {
    if (busy) return;
    const cur = soulDraft ?? soul?.text ?? '';
    const sep = cur.length > 0 && !cur.endsWith('\n') ? '\n\n' : cur.length > 0 ? '\n' : '';
    updateSoul(cur + sep + snippet);
  }

  const load = useCallback(async (adoptRemote: boolean): Promise<void> => {
    const id = api.identity;
    if (!id || !api.transportConnected) return;
    const sel = cacheKey(id, botId);
    const seq = ++seqRef.current;
    const writesAtStart = writeSeqRef.current;
    setLoading(true);
    try {
      const [doc, catalogRes, cfgRes] = await Promise.all([
        api.call(id, 'getBotSoul', { botId }),
        api.broker(id, 'center_model_picker_get', {}),
        api.broker(id, 'center_bot_model_get', { deviceId: id.targetDeviceId, botId }),
      ]);
      if (stale(sel) || seq !== seqRef.current || writesAtStart !== writeSeqRef.current) return;
      setModelCatalog(catalogRes);
      setModelConfig(cfgRes);
      setModelDraft({ ...cfgRes.overrides });
      if (adoptRemote) {
        // 唯一允许更新基线并丢弃本地草稿的入口（显式动作）。
        const adopted: Cached = { soul: doc, soulDraft: null, lock: false };
        setSoul(doc);
        setSoulDraft(null);
        setLocked(false);
        setError(null);
        setNotice('已采用远端当前设置与 SOUL（本地未保存修改已丢弃）。');
        liveRef.current = adopted;
        draftCache.set(sel, adopted);
        return;
      }
      // 普通读取：已编辑部分保持原基线（请求发起后用户才开始编辑也按当前状态判断）。
      const live = liveRef.current;
      const soulPinned = live.soulDraft !== null;
      const nextSoul = soulPinned && live.soul ? live.soul : doc;
      setSoul(nextSoul);
      if (!live.lock) setError(null);
      if (
        (soulPinned && live.soul && live.soul.revision !== doc.revision)
      ) {
        setNotice('远端已更新：本地未保存草稿保持原基线，保存会得到冲突提示；需要远端内容请用“采用远端设置（丢弃本地修改）”。');
      }
      remember({ soul: nextSoul });
    } catch (e) {
      if (stale(sel) || seq !== seqRef.current) return;
      setError(`读取 Bot 设置失败：${toError(e).message}`);
      api.reportError(e);
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [api, botId, key, stale, remember]);

  // 首次/换 Bot：草稿与基线一起从缓存恢复后显式读取；不自动写回任何内容。
  useEffect(() => {
    const saved = key ? draftCache.get(key) : undefined;
    setSoul(saved?.soul ?? null);
    setSoulDraft(saved?.soulDraft ?? null);
    setLocked(!!saved?.lock);
    setError(null);
    setNotice(null);
    setSaving(null);
    setModelConfig(null);
    setModelCatalog(null);
    setModelDraft({});
    if (key) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 重连后被动刷新一次（同一选择；dirty 部分的基线仍保持不动）。
  const prevOnline = useRef(online);
  useEffect(() => {
    if (!prevOnline.current && online && key) void load(false);
    prevOnline.current = online;
  }, [online, key, load]);

  const soulValue = soulDraft ?? soul?.text ?? '';
  const soulDirty = soulDraft !== null && !!soul && soulDraft !== soul.text;
  // 读取（含“采用远端”）在途时同样锁住编辑与保存：点击后才输入的内容不会被迟到的采用结果清掉。
  const busy = saving !== null || loading || modelSaving;
  const saveBusy = busy || !online;
  const canSaveSoul = !saveBusy && !!soul && soulDirty && !locked;
  const dirty = soulDirty;
  const currentBytes = soulBytes(soulValue);
  const bytePct = Math.min(100, Math.round((currentBytes / SOUL_MAX_BYTES) * 100));
  const byteOverLimit = currentBytes > SOUL_MAX_BYTES;
  const byteWarn = !byteOverLimit && currentBytes > SOUL_MAX_BYTES * 0.85;

  /** 统一收尾：确定的拒绝保留草稿可重试；冲突/未确认锁保存，只有显式采用远端才能继续。 */
  function reportSaveFailure(e: unknown, sel: string, what: string): void {
    if (stale(sel)) return;
    const err = toError(e);
    api.reportError(e);
    if (err.code === 'RUNTIME_BUSY') {
      setError('Bot 正忙（RUNTIME_BUSY）：有进行中或排队的任务，本次未保存。草稿已保留，任务结束后可重试。');
      return;
    }
    if (err.code === 'REQUEST_CONFLICT' || err.outcome === 'unconfirmed') {
      setLocked(true);
      remember({ lock: true });
      setError(err.code === 'REQUEST_CONFLICT'
        ? `${what}保存冲突（REQUEST_CONFLICT）：远端内容已变化，本次写入未生效。草稿与基线已保留；普通“重新读取”不会给未保存草稿换 revision，请用“采用远端设置（丢弃本地修改）”核对后再保存，不会自动重放。`
        : `${what}保存结果未确认（${err.message || err.code}）：草稿已保留，保存保持锁定；请用“采用远端设置（丢弃本地修改）”核对远端，不会自动重放。`);
      return;
    }
    // 其他确定性拒绝（未下发）：不锁保存，可修正后重试。
    setError(`${what}保存被拒绝（${err.code}）：${err.message}。草稿已保留，可修正后重试。`);
  }

  async function saveSoul(): Promise<void> {
    const id = api.identity;
    if (!id || !soul || !soulDirty || busy || locked || !online) return;
    const text = soulDraft ?? '';
    const bytes = soulBytes(text);
    if (bytes > SOUL_MAX_BYTES) {
      setError(`SOUL 超过 64 KiB（当前 ${bytes} 字节），未保存。`);
      return;
    }
    const sel = cacheKey(id, botId);
    setSaving('soul');
    setError(null);
    setNotice(null);
    try {
      const updated = await api.call(id, 'setBotSoul', {
        botId,
        input: { expectedRevision: soul.revision, text },
      });
      if (stale(sel)) return;
      writeSeqRef.current += 1;
      liveRef.current = { ...liveRef.current, soul: updated, soulDraft: null };
      setSoul(updated);
      setSoulDraft(null);
      remember({ soul: updated, soulDraft: null });
      setNotice('SOUL 已保存：下一请求生效，不重置会话与历史。');
    } catch (e) {
      reportSaveFailure(e, sel, 'SOUL ');
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }

  function updateModelDraft(k: 'modelRef' | 'thinkingLevel', v: string | null | undefined): void {
    setModelDraft((prev) => {
      const next = { ...prev };
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next;
    });
    setNotice(null);
  }

  function updateCodemodeDraft(k: 'codemode' | 'codemodeOnly', v: string): void {
    setModelDraft((prev) => {
      const next = { ...prev };
      if (v === '__inherit') delete next[k];
      else if (v === '__null') next[k] = null;
      else if (v === 'true') {
        next[k] = true;
        if (k === 'codemodeOnly') next.codemode = true;
      } else if (v === 'false') {
        next[k] = false;
        if (k === 'codemode' && next.codemodeOnly === true) next.codemodeOnly = false;
      }
      return next;
    });
    setNotice(null);
  }

  async function saveModelConfig(): Promise<void> {
    const id = api.identity;
    if (!id || !id.targetDeviceId || !modelConfig || busy || !online) return;
    const sel = cacheKey(id, botId);
    setModelSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.broker(id, 'center_bot_model_set', {
        deviceId: id.targetDeviceId,
        botId,
        expectedRevision: modelConfig.revision,
        value: modelDraft,
      });
      if (stale(sel)) return;
      ++writeSeqRef.current;
      setModelConfig(updated);
      setModelDraft({ ...updated.overrides });
      setNotice('Bot 模型设置已保存并同步至中心。');
    } catch (e) {
      if (!stale(sel)) setError(`保存模型配置失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current) setModelSaving(false);
    }
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
      disabled={busy || !online}
      onClick={() => updateCodemodeDraft(k, value)}
    >
      {label}
    </button>
  );

  // 能力/定时任务面板只在其 tab 激活且面板打开时挂载：收起/后台不轮询中心。
  const panelOpen = Boolean(open);
  const showCapabilityPanel = panelOpen && studioTab === 'capabilities';
  const showSchedulesPanel = panelOpen && studioTab === 'schedules';

  if (!open) return null;

  return (
    <section className="bot-studio" aria-label="Bot 设置工作台">
      <div className="bot-studio-head">
        <div className="pill-tabs bot-studio-tabs" role="tablist" aria-label="Bot 设置页签">
          {STUDIO_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={studioTab === t.id}
              className={studioTab === t.id ? 'active' : undefined}
              onClick={() => setStudioTab(t.id)}
            >
              {t.id === 'soul' && soulDirty ? `${t.label} ●` : t.label}
            </button>
          ))}
        </div>
        <div className="bot-studio-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void load(false)}
            disabled={!online || loading || busy}
          >
            {loading ? '读取中…' : '↻ 重新读取'}
          </button>
          <button
            type="button"
            className={`secondary-button ${locked ? 'warn' : ''}`}
            onClick={() => void load(true)}
            disabled={!online || loading || busy || (!dirty && !locked)}
          >
            采用远端设置（丢弃本地修改）
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void openCenterManagement()}
          >
            插件与中心管理
          </button>
        </div>
      </div>

      <div className="bot-studio-badges">
        {soul ? (
          <span className={`studio-pill ${soulDirty ? 'is-warn' : 'is-ok'}`}>
            {`SOUL.md · ${currentBytes} B${soulDirty ? ' · 已修改' : ''}`}
          </span>
        ) : null}
        {modelConfig ? (
          <span className="studio-pill is-ok">
            {`模型: ${describeVal(modelConfig.effective.modelRef)}`}
          </span>
        ) : null}
        {locked ? <span className="studio-pill is-lock">🔒 冲突锁定</span> : null}
      </div>

      {!online ? <div className="status">离线：显示最后读取的设置，保存已禁用。</div> : null}
      {loading && !soul ? <div className="status">加载中…</div> : null}
      {error ? (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError(null)}>关闭</button>
        </div>
      ) : null}
      {notice ? <div className="status online">{notice}</div> : null}
      {locked ? (
        <div className="bot-studio-lock" role="status">
          <strong>🔒 保存保持锁定：</strong>
          请用“采用远端设置（丢弃本地修改）”核对远端；普通“重新读取”不会给未保存草稿换 revision。
        </div>
      ) : null}

      {studioTab === 'soul' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="灵魂人设">
          <div className="studio-card-header">
            <label>🎭 SOUL.md（Bot 独立灵魂文档）</label>
            {soul ? (
              <span className={`studio-pill mono ${byteOverLimit ? 'is-lock' : byteWarn ? 'is-warn' : 'is-ok'}`}>
                {`UTF-8: ${currentBytes} / ${SOUL_MAX_BYTES} B (${bytePct}%)`}
              </span>
            ) : null}
          </div>
          {soul ? (
            <>
              <div className="metadata">
                {`${soul.path} · revision ${soul.revision.slice(0, 12)}…${soulDirty ? '（本地草稿基线）' : ''}`}
              </div>
              <div className="soul-byte-progress" aria-hidden="true">
                <div
                  className={`soul-byte-fill ${byteOverLimit ? 'danger' : byteWarn ? 'warn' : ''}`}
                  style={{ width: `${bytePct}%` }}
                />
              </div>
              <div className="soul-snippet-bar">
                {SOUL_SNIPPETS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="snippet-chip"
                    disabled={busy}
                    onClick={() => insertSoulSnippet(s.content)}
                  >
                    {s.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="snippet-chip danger"
                  disabled={busy || soulValue === ''}
                  onClick={() => updateSoul('')}
                >
                  清空为空灵魂 (&quot;&quot;)
                </button>
              </div>
              <textarea
                className="soul-textarea"
                value={soulValue}
                rows={12}
                spellCheck={false}
                placeholder="在此编写该 Bot 的独立系统灵魂（SOUL.md）。留空保存代表显式使用空灵魂 (intentionally empty)…"
                disabled={busy}
                onChange={(e) => updateSoul(e.target.value)}
              />
              <p className="hint">
                该 Bot 独立的系统人设（主会话 Primary 与群聊/私聊 Room/DM 工作上下文共享同一份 SOUL.md）；保存后在下一个请求生效，不重置会话与历史。允许为空。
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveSoul()}
                  disabled={!canSaveSoul || byteOverLimit}
                >
                  {saving === 'soul' ? '保存中…' : '保存灵魂文档（CAS）'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => updateSoul(null)}
                  disabled={!soulDirty || busy}
                >
                  放弃修改
                </button>
              </div>
            </>
          ) : (
            <div className="metadata">{loading ? '读取中…' : '尚未读取'}</div>
          )}
        </div>
      ) : null}

      {studioTab === 'model' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="模型设置">
          <div className="studio-card-header">
            <label>🤖 模型设置（CPA 中心下发）</label>
            {modelConfig ? (
              <span className="studio-pill is-ok">
                {`有效模型: ${describeVal(modelConfig.effective.modelRef)}`}
              </span>
            ) : null}
          </div>
          {modelConfig ? (
            <>
              <div className="bot-studio-effective">
                <span>{`生效模型 ${describeVal(modelConfig.effective.modelRef)}`}</span>
                <span>{`思考 ${describeVal(modelConfig.effective.thinkingLevel)}`}</span>
                <span>{describeCodemode(modelConfig.effective)}</span>
              </div>
              <button
                type="button"
                aria-pressed={modelDraft.modelRef === undefined}
                className={`bot-studio-model-row ${modelDraft.modelRef === undefined ? 'active' : ''}`}
                disabled={busy || !online}
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
                    if (!stale(key) && api.identity?.generation === identity.generation) {
                      setModelCatalog(previous => previous ? { ...previous, starredModels } : previous);
                    }
                  }}
                  disabled={busy || !online}
                />
              ) : null}
              <div className="bot-studio-field">
                <span className="bot-studio-field-label">
                  {`思考强度 (Thinking Level) · 全局 ${describeVal(modelConfig.global.thinkingLevel)}`}
                </span>
                <div className="bot-studio-choices" role="radiogroup" aria-label="思考强度">
                  {['__inherit', '__null', ...THINKING_LEVELS].map((lv) => (
                    <button
                      key={lv}
                      type="button"
                      role="radio"
                      aria-checked={thinkingValue === lv}
                      className={`bot-studio-choice ${thinkingValue === lv ? 'active' : ''}`}
                      disabled={busy || !online}
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
                      disabled={busy || !online}
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
                  disabled={busy || !online}
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
                  {`启用 Code Mode (codemode) · 全局 ${modelConfig.global.codemode ? '开启' : '关闭'}`}
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
                  {`仅 Code Mode 模式 (codemodeOnly — 全量工具与 MCP 渐进式按需加载) · 全局 ${modelConfig.global.codemodeOnly ? '开启' : '关闭'}`}
                </span>
                <div className="bot-studio-choices">
                  {codemodePill('codemodeOnly', '__inherit', '继承')}
                  {codemodePill('codemodeOnly', 'true', '开启')}
                  {codemodePill('codemodeOnly', 'false', '关闭')}
                </div>
                {modelDraft.codemodeOnly === null ? <span className="hint">当前为显式清空。</span> : null}
              </div>
              <p className="hint">
                启用 Code Mode 后模型可在受控 QuickJS 沙盒中编写 JS 脚本批量编排工具调用；启用“仅 Code Mode 模式”后，仅向模型暴露 codemode 工具，所有内置工具、插件与 MCP 转为沙盒内渐进式按需搜索与加载，大幅降低上下文开销。
              </p>
              <div className="metadata">
                {`当前覆盖: ${describeVal(modelConfig.overrides.modelRef)} (${describeVal(modelConfig.overrides.thinkingLevel)}, ${describeCodemode(modelConfig.overrides)}) · revision ${modelConfig.revision}`}
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !online}
                  onClick={() => void saveModelConfig()}
                >
                  {modelSaving ? '保存中…' : '保存模型设置'}
                </button>
              </div>
            </>
          ) : (
            <div className="metadata">{loading ? '读取模型配置中…' : '尚未加载模型配置'}</div>
          )}
        </div>
      ) : null}

      {studioTab === 'skill-review' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="Skill 审阅">
          <SkillReviewPanel key={botPanelIdentityKey + ':' + botId}
            connected={online && !!identity} call={callSkillReview} />
        </div>
      ) : null}

      {studioTab === 'vault' ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="密码库">
          <VaultPanel identityKey={botPanelIdentityKey} botId={botId} deviceId={identity?.targetDeviceId}
            hostLabel={hostLabel} connected={online && !!identity} call={callVault} />
        </div>
      ) : null}

      {showCapabilityPanel && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="插件与能力">
          <div className="studio-card-header">
            <label>🔌 Bot 能力（插件 / MCP / 技能）</label>
          </div>
          <BotCapabilities key={`${identity.targetDeviceId}\u0000${botId}`} api={api} identity={identity} deviceId={identity.targetDeviceId} botId={botId} />
        </div>
      ) : null}

      {showSchedulesPanel && identity ? (
        <div className="studio-card bot-studio-card" role="tabpanel" aria-label="定时任务">
          <div className="studio-card-header">
            <label>⏰ 定时任务（主私聊自动触发）</label>
          </div>
          <BotSchedules key={`${identity.targetDeviceId}\u0000${botId}`} api={api} identity={identity} botId={botId} />
        </div>
      ) : null}
    </section>
  );
}
