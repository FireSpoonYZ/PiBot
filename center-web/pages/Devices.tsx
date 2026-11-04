import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive,
  Bot,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Sliders,
  Smartphone,
  Star,
  Trash2,
} from 'lucide-react';
import type {
  BotModelConfig,
  BotRef,
  BotSyncResponse,
  Device,
  DeviceRuntimeStatus,
  ModelConfig,
  ModelSelection,
  Provider,
} from '@e-launcher/center-contract';
import { api, CenterApiError } from '../api';
import { RuntimeStatusSummary } from '../components/RuntimeStatus';
import { SheetModal } from '../components/SheetModal';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
interface ModelOption {
  ref: string;
  name: string;
}

function compareBots(a: BotRef, b: BotRef): number {
  const aArchived = Boolean(a.archivedAt);
  const bArchived = Boolean(b.archivedAt);
  if (aArchived !== bArchived) return aArchived ? 1 : -1;
  const aPrimary = a.isPrimary === true;
  const bPrimary = b.isPrimary === true;
  if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
  const aTime = Date.parse(a.lastActivityAt ?? a.createdAt ?? '') || 0;
  const bTime = Date.parse(b.lastActivityAt ?? b.createdAt ?? '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return a.botId.localeCompare(b.botId);
}

function formatCodemodeBadge(sel?: ModelSelection): string {
  if (!sel) return '默认（标准工具 + MCP 延迟搜索）';
  if (sel.codemodeOnly === true) return '仅 Code Mode（全量渐进式工具加载）';
  if (sel.codemode === true) return '已启用 Code Mode 沙盒';
  if (sel.codemode === false && sel.codemodeOnly === false) return '已关闭 Code Mode';
  return '默认（标准工具 + MCP 延迟搜索）';
}

function SelectionForm({
  value,
  inherited,
  options,
  busy,
  save,
  onCancel,
}: {
  value: ModelSelection;
  inherited?: ModelSelection;
  options: ModelOption[];
  busy: boolean;
  save(value: ModelSelection): void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<ModelSelection>(value);
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  useEffect(() => setDraft(value), [value]);
  const updateString = (key: 'modelRef' | 'thinkingLevel', next: string) => {
    const copy = { ...draft };
    if (next === '__inherit') delete copy[key];
    else copy[key] = next === '__null' ? null : next;
    setDraft(copy);
  };
  const updateBool = (key: 'codemode' | 'codemodeOnly', next: string) => {
    const copy = { ...draft };
    if (next === '__inherit') delete copy[key];
    else if (next === '__null') copy[key] = null;
    else if (next === 'true') {
      copy[key] = true;
      if (key === 'codemodeOnly') copy.codemode = true;
    } else if (next === 'false') {
      copy[key] = false;
      if (key === 'codemode' && copy.codemodeOnly === true) copy.codemodeOnly = false;
    }
    setDraft(copy);
  };
  const selectedString = (key: 'modelRef' | 'thinkingLevel') =>
    draft[key] === undefined ? '__inherit' : draft[key] === null ? '__null' : draft[key]!;
  const selectedBool = (key: 'codemode' | 'codemodeOnly') =>
    draft[key] === undefined ? '__inherit' : draft[key] === null ? '__null' : draft[key] ? 'true' : 'false';
  const modelRef = selectedString('modelRef');
  const level = selectedString('thinkingLevel');
  const codemode = selectedBool('codemode');
  const codemodeOnly = selectedBool('codemodeOnly');
  return (
    <form
      className="form"
      onSubmit={e => {
        e.preventDefault();
        save(draft);
      }}
    >
      <div className="filter-bar" role="tablist" aria-label="模型配置分栏" style={{ marginBottom: 8 }}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'basic'}
          className={`filter-chip ${tab === 'basic' ? 'is-active' : ''}`}
          onClick={() => setTab('basic')}
        >
          模型设置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'advanced'}
          className={`filter-chip ${tab === 'advanced' ? 'is-active' : ''}`}
          onClick={() => setTab('advanced')}
        >
          <Sliders size={14} />
          高级设置
        </button>
      </div>

      {inherited && (
        <p className="secondary" style={{ marginTop: 0 }}>
          继承全局：{inherited.modelRef ?? '未选择模型'} · 思考档位 {inherited.thinkingLevel ?? '默认'} ·{' '}
          {formatCodemodeBadge(inherited)}
        </p>
      )}

      {tab === 'basic' ? (
        <div className="form-grid">
          <label>
            模型选择
            <select
              value={modelRef === '__null' ? '__inherit' : modelRef}
              onChange={e => updateString('modelRef', e.target.value)}
            >
              <option value="__inherit">{inherited ? `继承全局 (${inherited.modelRef ?? '未设置'})` : '未设置'}</option>
              {modelRef !== '__inherit' && modelRef !== '__null' && !options.some(o => o.ref === modelRef) && (
                <option value={modelRef}>{modelRef}（不可用）</option>
              )}
              {options.map(o => (
                <option key={o.ref} value={o.ref}>
                  {o.name} · {o.ref}
                </option>
              ))}
            </select>
            {modelRef === '__null' && (
              <span className="secondary">当前已在“高级设置”中设为显式清空模型覆盖。</span>
            )}
          </label>
          <label>
            思考强度 (Thinking Level)
            <select value={level} onChange={e => updateString('thinkingLevel', e.target.value)}>
              <option value="__inherit">
                {inherited ? `继承全局（${inherited.thinkingLevel ?? 'SDK 默认'}）` : '未设置（SDK 默认）'}
              </option>
              <option value="__null">显式清空（强制使用 SDK 默认）</option>
              {level !== '__inherit' && level !== '__null' && !levels.includes(level) && (
                <option value={level}>{level}</option>
              )}
              {levels.map(v => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className="form" style={{ gap: 14 }}>
          <div className="card-group" style={{ padding: 14, margin: 0 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>工具执行与渐进式加载 (Code Mode)</strong>
            <p className="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
              启用 Code Mode 后模型可在受控 QuickJS 沙盒中编排多工具脚本；开启“仅 Code Mode”后所有内置工具、插件与 MCP 均转为沙盒内按需搜索与渐进式加载。
            </p>
            <div className="form-grid">
              <label>
                启用 Code Mode (codemode)
                <select value={codemode} onChange={e => updateBool('codemode', e.target.value)}>
                  <option value="__inherit">
                    {inherited
                      ? `继承全局（${inherited.codemode ? '开启' : '关闭'}）`
                      : '默认（关闭）'}
                  </option>
                  <option value="true">开启 — 提供 codemode 沙盒工具</option>
                  <option value="false">关闭 — 仅使用常规工具调用</option>
                </select>
              </label>
              <label>
                仅 Code Mode 模式 (codemodeOnly)
                <select value={codemodeOnly} onChange={e => updateBool('codemodeOnly', e.target.value)}>
                  <option value="__inherit">
                    {inherited
                      ? `继承全局（${inherited.codemodeOnly ? '开启' : '关闭'}）`
                      : '默认（关闭）'}
                  </option>
                  <option value="true">开启 — 仅暴露 codemode（全工具渐进式按需加载）</option>
                  <option value="false">关闭 — 保留常规工具直接调用</option>
                </select>
              </label>
            </div>
          </div>

          <div className="card-group" style={{ padding: 14, margin: 0 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>模型覆盖策略</strong>
            <p className="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
              思考档位已移至“模型设置”分栏；此处仅在需要强制阻断全局模型继承时覆写。
            </p>
            <div className="form-grid">
              <label>
                显式清空模型覆盖
                <select
                  value={modelRef === '__null' ? '__null' : '__normal'}
                  onChange={e => {
                    if (e.target.value === '__null') updateString('modelRef', '__null');
                    else if (modelRef === '__null') updateString('modelRef', '__inherit');
                  }}
                >
                  <option value="__normal">正常（使用模型设置中的模型或继承全局）</option>
                  <option value="__null">显式清空（不继承全局模型）</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="action-row">
        <button className="button" disabled={busy}>
          保存
        </button>
        {onCancel && (
          <button type="button" className="quiet-button" onClick={onCancel} disabled={busy}>
            关闭
          </button>
        )}
      </div>
    </form>
  );
}

function CreateBotForm({
  online,
  busy,
  defaultPrimary,
  forcePrimary,
  onSubmit,
  onCancel,
}: {
  online: boolean;
  busy: boolean;
  defaultPrimary: boolean;
  forcePrimary?: boolean;
  onSubmit(input: { role: string; description: string; cwd?: string; makePrimary: boolean }): void;
  onCancel?: () => void;
}) {
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
  const [makePrimary, setMakePrimary] = useState(defaultPrimary || Boolean(forcePrimary));
  useEffect(() => {
    setMakePrimary(defaultPrimary || Boolean(forcePrimary));
  }, [defaultPrimary, forcePrimary]);
  const disabled = busy || !online;
  return (
    <form
      className="form"
      onSubmit={e => {
        e.preventDefault();
        if (!role.trim() || disabled) return;
        onSubmit({
          role: role.trim(),
          description: description.trim(),
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          makePrimary: forcePrimary ? true : makePrimary,
        });
        setRole('');
        setDescription('');
        setCwd('');
      }}
    >
      {!online && <p className="secondary danger">设备离线，无法远程创建 Bot</p>}
      <label>
        名称
        <input
          value={role}
          onChange={e => setRole(e.target.value)}
          placeholder="输入 Bot 名称"
          required
          disabled={disabled}
        />
      </label>
      <label>
        描述
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="职责或说明（可选）"
          disabled={disabled}
        />
      </label>
      <label>
        工作目录 (cwd，可选)
        <input
          value={cwd}
          onChange={e => setCwd(e.target.value)}
          placeholder="留空使用主机默认工作空间"
          disabled={disabled}
        />
      </label>
      {!forcePrimary && (
        <label className="check">
          <input
            type="checkbox"
            checked={makePrimary}
            onChange={e => setMakePrimary(e.target.checked)}
            disabled={disabled}
          />
          <span>设为主 Bot</span>
        </label>
      )}
      <div className="action-row">
        <button className="button" type="submit" disabled={disabled || !role.trim()}>
          {forcePrimary ? '创建主 Bot' : '创建 Bot'}
        </button>
        {onCancel && (
          <button className="quiet-button" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [bots, setBots] = useState<Record<string, BotRef[]>>({});
  const [runtime, setRuntime] = useState<Record<string, DeviceRuntimeStatus>>({});
  const [global, setGlobal] = useState<ModelConfig>();
  const [globalModalOpen, setGlobalModalOpen] = useState(false);
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [filterDeviceId, setFilterDeviceId] = useState<string>('');
  const [selected, setSelected] = useState<{ device: Device; bot: BotRef; config: BotModelConfig }>();
  const [creatingBotFor, setCreatingBotFor] = useState<{
    deviceId: string;
    defaultPrimary: boolean;
    forcePrimary: boolean;
  }>();
  const [editingDevice, setEditingDevice] = useState<{ deviceId: string; name: string }>();
  const [confirmDeleteDevice, setConfirmDeleteDevice] = useState<string>();
  const [editingBot, setEditingBot] = useState<{
    deviceId: string;
    botId: string;
    name: string;
    description: string;
    cwd: string;
    cwdRevision: number;
  }>();
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const syncCursorRef = useRef<{ epoch?: string; seq?: number }>({});

  const applyBotSync = (sync: BotSyncResponse) => {
    syncCursorRef.current = { epoch: sync.epoch, seq: sync.seq };
    setDevices(sync.devices);
    if (sync.mode === 'snapshot') {
      const grouped: Record<string, BotRef[]> = {};
      for (const d of sync.devices) grouped[d.deviceId] = [];
      for (const b of sync.bots || []) {
        (grouped[b.deviceId] ||= []).push(b);
      }
      for (const list of Object.values(grouped)) list.sort(compareBots);
      setBots(grouped);
    } else if (sync.events?.length) {
      setBots(prev => {
        const next: Record<string, BotRef[]> = {};
        for (const [k, v] of Object.entries(prev)) next[k] = [...v];
        for (const d of sync.devices) if (!next[d.deviceId]) next[d.deviceId] = [];
        for (const ev of sync.events || []) {
          const list = next[ev.deviceId] ? [...next[ev.deviceId]] : [];
          if (ev.op === 'upsert' && ev.bot) {
            const idx = list.findIndex(item => item.botId === ev.botId);
            if (idx >= 0) list[idx] = ev.bot;
            else list.push(ev.bot);
          } else if (ev.op === 'delete') {
            const idx = list.findIndex(item => item.botId === ev.botId);
            if (idx >= 0) list.splice(idx, 1);
          }
          list.sort(compareBots);
          next[ev.deviceId] = list;
        }
        return next;
      });
    }
  };

  const syncBotsNow = async () => {
    const sync = await api.getBotSync({
      epoch: syncCursorRef.current.epoch,
      sinceSeq: syncCursorRef.current.seq,
    });
    applyBotSync(sync);
  };

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

  const refreshRuntime = async (deviceIds: string[]) => {
    const results = await Promise.all(
      deviceIds.map(deviceId => api.getDeviceRuntimeStatus(deviceId).catch(() => null)),
    );
    setRuntime(current => {
      const next = { ...current };
      for (const item of results) if (item) next[item.deviceId] = item;
      return next;
    });
  };

  const load = async () => {
    const [sync, g, providers] = await Promise.all([
      api.getBotSync({ epoch: syncCursorRef.current.epoch, sinceSeq: syncCursorRef.current.seq }),
      api.getModelConfig(),
      api.listProviders(),
    ]);
    const modelLists = await Promise.all(providers.map((p: Provider) => api.listModels(p.id)));
    applyBotSync(sync);
    await refreshRuntime(sync.devices.map(device => device.deviceId));
    setGlobal(g);
    setOptions(
      modelLists.flatMap((models, i) =>
        providers[i].enabled
          ? models.filter(m => m.enabled).map(m => ({ ref: `${providers[i].id}/${m.id}`, name: m.name }))
          : [],
      ),
    );
  };

  useEffect(() => {
    void run(load);
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      void api
        .getBotSync({
          epoch: syncCursorRef.current.epoch,
          sinceSeq: syncCursorRef.current.seq,
        })
        .then(sync => {
          applyBotSync(sync);
          return refreshRuntime(sync.devices.map(device => device.deviceId));
        })
        .catch(() => {});
    };
    const timer = setInterval(tick, 2500);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  const visibleDevices =
    filterDeviceId && devices.some(d => d.deviceId === filterDeviceId)
      ? devices.filter(d => d.deviceId === filterDeviceId)
      : devices;

  const creatingDevice = creatingBotFor ? devices.find(d => d.deviceId === creatingBotFor.deviceId) : undefined;
  const editingBotDevice = editingBot ? devices.find(d => d.deviceId === editingBot.deviceId) : undefined;

  return (
    <main className="page">
      <header className="page-header">
        <div className="page-title-group">
          <h1>设备与 Bot 管理</h1>
          <p className="secondary">管理在线设备、主 Bot 守护、模型覆盖与能力绑定</p>
        </div>
        <button className="button secondary-button button-sm" disabled={busy} onClick={() => void run(load)}>
          <RefreshCw size={15} />
          刷新
        </button>
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

      {global && (
        <section className="summary-bar card-group">
          <div>
            <strong>全局默认模型与高级策略</strong>
            <p className="secondary" style={{ marginBottom: 0 }}>
              模型：{global.global.modelRef ?? '未设置'} · 思考档位：{global.global.thinkingLevel ?? '默认'} ·{' '}
              {formatCodemodeBadge(global.global)}
            </p>
          </div>
          <button
            className="button secondary-button button-sm"
            disabled={busy}
            onClick={() => {
              setError('');
              setGlobalModalOpen(true);
            }}
          >
            <Sliders size={15} />
            修改全局模型
          </button>
        </section>
      )}

      {devices.length > 1 && (
        <div className="filter-bar" role="tablist" aria-label="设备筛选">
          <button
            type="button"
            className={`filter-chip ${!filterDeviceId || !devices.some(d => d.deviceId === filterDeviceId) ? 'is-active' : ''}`}
            onClick={() => setFilterDeviceId('')}
          >
            全部设备 ({devices.length})
          </button>
          {devices.map(d => (
            <button
              type="button"
              key={d.deviceId}
              className={`filter-chip ${filterDeviceId === d.deviceId ? 'is-active' : ''}`}
              onClick={() => setFilterDeviceId(d.deviceId)}
            >
              <span className={`badge ${d.online ? 'badge-online' : 'badge-offline'}`}>
                {d.online ? '在线' : '离线'}
              </span>
              {d.name || d.deviceId}
            </button>
          ))}
        </div>
      )}

      {devices.length === 0 && (
        <div className="empty-state">
          <Smartphone size={28} />
          <p>暂无已接入的设备</p>
          <p className="secondary">当终端或移动设备连接到控制中心后，将在此显示设备及其 Bot 列表。</p>
        </div>
      )}

      {visibleDevices.map(device => {
        const allBots = (bots[device.deviceId] || []).slice().sort(compareBots);
        const activeBots = allBots.filter(b => !b.archivedAt);
        const archivedBots = allBots.filter(b => Boolean(b.archivedAt));
        const hasPrimary = activeBots.some(b => b.isPrimary);

        return (
          <section className="card-group resource-row" key={device.deviceId}>
            <div className="card-header">
              <div>
                <div className="action-row" style={{ marginBlock: 0 }}>
                  <h2>{device.name || device.deviceId}</h2>
                  <span className={`badge ${device.online ? 'badge-online' : 'badge-offline'}`}>
                    {device.online ? '在线' : '离线'}
                  </span>
                </div>
                <p className="secondary" style={{ marginBottom: 0 }}>
                  {device.deviceId}
                  {!device.online ? ' · 离线设备禁用 Bot 远程管理' : ''}
                </p>
              </div>
              <div className="action-row" style={{ marginBlock: 0 }}>
                <button
                  className="button secondary-button button-sm"
                  disabled={busy || !device.online}
                  title={!device.online ? '设备离线，不可新建 Bot' : undefined}
                  onClick={() => {
                    setError('');
                    setCreatingBotFor({
                      deviceId: device.deviceId,
                      defaultPrimary: !hasPrimary,
                      forcePrimary: false,
                    });
                  }}
                >
                  <Plus size={15} />
                  新建 Bot
                </button>
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setEditingDevice({ deviceId: device.deviceId, name: device.name });
                  }}
                >
                  <Pencil size={15} />
                  重命名设备
                </button>
                {confirmDeleteDevice !== device.deviceId ? (
                  <button
                    className="quiet-button danger"
                    disabled={busy}
                    onClick={() => setConfirmDeleteDevice(device.deviceId)}
                  >
                    <Trash2 size={15} />
                    删除设备
                  </button>
                ) : (
                  <>
                    <span className="secondary">从中心移除并撤销接入，不删除设备本机聊天数据。</span>
                    <button
                      className="quiet-button danger"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.deleteDevice(device.deviceId);
                          setConfirmDeleteDevice(undefined);
                          if (selected?.device.deviceId === device.deviceId) setSelected(undefined);
                          await syncBotsNow();
                          setNotice(`已从中心移除 ${device.name}`);
                        })
                      }
                    >
                      确认删除设备
                    </button>
                    <button className="quiet-button" disabled={busy} onClick={() => setConfirmDeleteDevice(undefined)}>
                      取消
                    </button>
                  </>
                )}
              </div>
            </div>

            {runtime[device.deviceId] && <RuntimeStatusSummary status={runtime[device.deviceId]} />}

            {!hasPrimary && (
              <div className="warning-banner">
                <span>
                  <strong>未设置主 Bot</strong> — 请为该设备创建或指定一个主 Bot
                </span>
                <button
                  className="button button-sm"
                  disabled={busy || !device.online}
                  title={!device.online ? '设备离线，无法远程创建主 Bot' : undefined}
                  onClick={() => {
                    setError('');
                    setCreatingBotFor({
                      deviceId: device.deviceId,
                      defaultPrimary: true,
                      forcePrimary: true,
                    });
                  }}
                >
                  <Plus size={15} />
                  创建主 Bot
                </button>
              </div>
            )}

            {activeBots.map(bot => {
              const botKey = `${device.deviceId}:${bot.botId}`;
              const isConfirmingDelete = confirmDeleteKey === botKey;
              const activityTime = bot.lastActivityAt ?? bot.createdAt;

              return (
                <div className="bot-row" key={bot.botId}>
                  <div className="action-row" style={{ marginBlock: 0 }}>
                    <strong>{bot.name || bot.botId}</strong>
                    {bot.isPrimary && <span className="badge badge-primary">★ 主 Bot</span>}
                    <span className="secondary">{bot.botId}</span>
                  </div>
                  {bot.description && <p className="secondary">{bot.description}</p>}
                  <p className="secondary">
                    最后活动：{activityTime ? new Date(activityTime).toLocaleString() : '暂无记录'}
                    {bot.lastPreview ? ` · 摘要：${bot.lastPreview}` : ''}
                  </p>

                  <div className="action-row">
                    <button
                      className="button secondary-button button-sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setSelected({
                            device,
                            bot,
                            config: await api.getBotModelConfig(device.deviceId, bot.botId),
                          });
                        })
                      }
                    >
                      <Sliders size={14} />
                      模型配置
                    </button>
                    <Link
                      className="button secondary-button button-sm"
                      to={`/devices/${encodeURIComponent(device.deviceId)}/bots/${encodeURIComponent(bot.botId)}/capabilities`}
                    >
                      <Puzzle size={14} />
                      能力分配
                    </Link>
                    <button
                      className="quiet-button"
                      disabled={busy}
                      title={!device.online ? '设备离线：仅工作目录可保存' : undefined}
                      onClick={() => {
                        setError('');
                        setEditingBot({
                          deviceId: device.deviceId,
                          botId: bot.botId,
                          name: bot.name || '',
                          description: bot.description || '',
                          cwd: bot.cwd ?? '',
                          cwdRevision: bot.cwdRevision ?? 0,
                        });
                      }}
                    >
                      编辑 Bot
                    </button>
                    {!bot.isPrimary && (
                      <button
                        className="quiet-button"
                        disabled={busy || !device.online}
                        title={!device.online ? '设备离线' : undefined}
                        onClick={() =>
                          void run(async () => {
                            await api.setPrimaryBot(device.deviceId, bot.botId);
                            await syncBotsNow();
                            setNotice(`已将 ${bot.name || bot.botId} 设为主 Bot`);
                          })
                        }
                      >
                        <Star size={14} />
                        设为主 Bot
                      </button>
                    )}
                    {!bot.isPrimary && (
                      <button
                        className="quiet-button"
                        disabled={busy || !device.online}
                        title={!device.online ? '设备离线' : undefined}
                        onClick={() =>
                          void run(async () => {
                            await api.archiveBot(device.deviceId, bot.botId);
                            await syncBotsNow();
                            setNotice(`已归档 ${bot.name || bot.botId}`);
                          })
                        }
                      >
                        <Archive size={14} />
                        归档
                      </button>
                    )}
                    {!bot.isPrimary &&
                      (!isConfirmingDelete ? (
                        <button
                          className="quiet-button danger"
                          disabled={busy || !device.online}
                          title={!device.online ? '设备离线' : undefined}
                          onClick={() => setConfirmDeleteKey(botKey)}
                        >
                          <Trash2 size={14} />
                          删除
                        </button>
                      ) : (
                        <>
                          <button
                            className="quiet-button danger"
                            disabled={busy || !device.online}
                            onClick={() =>
                              void run(async () => {
                                await api.deleteBot(device.deviceId, bot.botId);
                                await syncBotsNow();
                                setConfirmDeleteKey(undefined);
                                setNotice(`已删除 ${bot.name || bot.botId}`);
                              })
                            }
                          >
                            确认删除
                          </button>
                          <button className="quiet-button" onClick={() => setConfirmDeleteKey(undefined)}>
                            取消
                          </button>
                        </>
                      ))}
                  </div>
                </div>
              );
            })}

            {!activeBots.length && (
              <p className="secondary" style={{ marginTop: 12 }}>
                <Bot size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                暂无未归档 Bot
              </p>
            )}

            {archivedBots.length > 0 && (
              <details className="fold-panel">
                <summary className="quiet-button">已归档 Bot ({archivedBots.length})</summary>
                {archivedBots.map(bot => {
                  const remainingDays = Math.max(
                    0,
                    Math.ceil(14 - (Date.now() - Date.parse(bot.archivedAt!)) / 86400000),
                  );
                  return (
                    <div className="bot-row" key={bot.botId}>
                      <div className="action-row" style={{ marginBlock: 0 }}>
                        <strong>{bot.name || bot.botId}</strong>
                        <span className="secondary">{bot.botId}</span>
                        <span className="badge badge-warn">剩余 {remainingDays} 天自动删除</span>
                      </div>
                      {bot.description && <p className="secondary">{bot.description}</p>}
                      <div className="action-row">
                        <button
                          className="quiet-button"
                          disabled={busy || !device.online}
                          title={!device.online ? '设备离线' : undefined}
                          onClick={() =>
                            void run(async () => {
                              await api.unarchiveBot(device.deviceId, bot.botId);
                              await syncBotsNow();
                              setNotice(`已恢复 ${bot.name || bot.botId}`);
                            })
                          }
                        >
                          恢复
                        </button>
                        <button
                          className="quiet-button danger"
                          disabled={busy || !device.online}
                          title={!device.online ? '设备离线' : undefined}
                          onClick={() =>
                            void run(async () => {
                              await api.deleteBot(device.deviceId, bot.botId);
                              await syncBotsNow();
                              setNotice(`已删除 ${bot.name || bot.botId}`);
                            })
                          }
                        >
                          立即删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </details>
            )}
          </section>
        );
      })}

      <SheetModal
        open={globalModalOpen && Boolean(global)}
        onOpenChange={setGlobalModalOpen}
        title="全局默认模型设置"
        description="为所有未单独设置模型覆盖的 Bot 指定默认模型与思考档位"
      >
        {global && (
          <div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <SelectionForm
              value={global.global}
              options={options}
              busy={busy}
              onCancel={() => setGlobalModalOpen(false)}
              save={value =>
                void run(async () => {
                  setGlobal(await api.putModelConfig({ expectedRevision: global.revision, value }));
                  setNotice('全局模型已保存');
                  setGlobalModalOpen(false);
                  if (selected) {
                    setSelected({
                      ...selected,
                      config: await api.getBotModelConfig(selected.device.deviceId, selected.bot.botId),
                    });
                  }
                })
              }
            />
          </div>
        )}
      </SheetModal>

      <SheetModal
        open={selected !== undefined}
        onOpenChange={isOpen => {
          if (!isOpen) setSelected(undefined);
        }}
        title={selected ? `${selected.bot.name || selected.bot.botId} 的模型与高级设置` : 'Bot 模型与高级设置'}
        description={
          selected
            ? `当前有效：${selected.config.effective.modelRef ?? '未选择'} · 思考档位 ${selected.config.effective.thinkingLevel ?? '默认'} · ${formatCodemodeBadge(selected.config.effective)}`
            : undefined
        }
      >
        {selected && (
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
            <SelectionForm
              value={selected.config.overrides}
              inherited={selected.config.global}
              options={options}
              busy={busy}
              onCancel={() => setSelected(undefined)}
              save={value =>
                void run(async () => {
                  const config = await api.putBotModelConfig(selected.device.deviceId, selected.bot.botId, {
                    expectedRevision: selected.config.revision,
                    value,
                  });
                  setSelected({ ...selected, config });
                  setNotice('Bot 模型覆盖已保存');
                })
              }
            />
          </div>
        )}
      </SheetModal>

      <SheetModal
        open={creatingBotFor !== undefined}
        onOpenChange={isOpen => {
          if (!isOpen) setCreatingBotFor(undefined);
        }}
        title={creatingBotFor?.forcePrimary ? '创建主 Bot' : '新建 Bot'}
        description={
          creatingDevice
            ? `目标设备：${creatingDevice.name || creatingDevice.deviceId}`
            : creatingBotFor?.deviceId
        }
      >
        {creatingBotFor && (
          <div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <CreateBotForm
              online={Boolean(creatingDevice?.online)}
              busy={busy}
              defaultPrimary={creatingBotFor.defaultPrimary}
              forcePrimary={creatingBotFor.forcePrimary}
              onCancel={() => setCreatingBotFor(undefined)}
              onSubmit={input =>
                void run(async () => {
                  await api.createBot(creatingBotFor.deviceId, input);
                  await syncBotsNow();
                  const wasForcePrimary = creatingBotFor.forcePrimary;
                  setCreatingBotFor(undefined);
                  setNotice(wasForcePrimary ? '主 Bot 已创建' : 'Bot 已创建');
                })
              }
            />
          </div>
        )}
      </SheetModal>

      <SheetModal
        open={editingBot !== undefined}
        onOpenChange={isOpen => {
          if (!isOpen) setEditingBot(undefined);
        }}
        title="重命名 / 编辑 Bot"
        description={editingBot ? `Bot ID: ${editingBot.botId}` : undefined}
      >
        {editingBot && (() => {
          const current = bots[editingBot.deviceId]?.find(b => b.botId === editingBot.botId);
          const profileChanged = !current || current.name !== editingBot.name.trim() || (current.description ?? '') !== editingBot.description;
          const cwdChanged = (current?.cwd ?? '') !== editingBot.cwd.trim();
          const trimmedCwd = editingBot.cwd.trim();
          // 资料 PATCH 需 Host 在线；仅目录变化在离线时也可提交，且不再附带未变的资料字段。
          const profileBlocked = profileChanged && !editingBotDevice?.online;
          const canSave = Boolean(editingBot.name.trim()) && trimmedCwd !== '' && (profileChanged || cwdChanged) && !profileBlocked;
          return (
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
                if (!editingBot.name.trim() || !canSave) return;
                void run(async () => {
                  if (profileChanged) {
                    await api.updateBot(editingBot.deviceId, editingBot.botId, {
                      name: editingBot.name.trim(),
                      description: editingBot.description,
                    });
                  }
                  if (cwdChanged) {
                    try {
                      const config = await api.putBotCwd(editingBot.deviceId, editingBot.botId, {
                        expectedRevision: editingBot.cwdRevision,
                        value: trimmedCwd,
                      });
                      setEditingBot(prev => (prev && prev.botId === editingBot.botId
                        ? { ...prev, cwd: config.value ?? prev.cwd, cwdRevision: config.revision }
                        : prev));
                    } catch (e) {
                      // 修订冲突：重读中心权威修订回填表单，保留用户刚输入的目录。
                      if (e instanceof CenterApiError && e.code === 'REVISION_CONFLICT') {
                        const fresh = await api.getBotCwd(editingBot.deviceId, editingBot.botId);
                        setEditingBot(prev => (prev && prev.botId === editingBot.botId
                          ? { ...prev, cwdRevision: fresh.revision }
                          : prev));
                        throw new Error('工作目录已被其他修改占用，已重新读取修订；请确认目录后再保存。');
                      }
                      throw e;
                    }
                  }
                  await syncBotsNow();
                  setEditingBot(undefined);
                  setNotice(cwdChanged
                    ? (editingBotDevice?.online
                      ? 'Bot 资料已保存；工作目录将在目标 Host 空闲后生效，不会移动文件'
                      : '工作目录已保存到中心；设备待同步，连线后目标 Host 空闲时生效，不会移动文件')
                    : 'Bot 资料已更新');
                });
              }}
            >
              <label>
                名称
                <input
                  value={editingBot.name}
                  onChange={e => setEditingBot({ ...editingBot, name: e.target.value })}
                  required
                  disabled={busy || !editingBotDevice?.online}
                />
              </label>
              <label>
                描述
                <input
                  value={editingBot.description}
                  onChange={e => setEditingBot({ ...editingBot, description: e.target.value })}
                  disabled={busy || !editingBotDevice?.online}
                />
              </label>
              <label>
                工作目录
                <input
                  value={editingBot.cwd}
                  onChange={e => setEditingBot({ ...editingBot, cwd: e.target.value })}
                  placeholder="目标 Host 上的绝对路径"
                  disabled={busy}
                />
              </label>
              <p className="secondary" style={{ marginTop: 0 }}>
                目标 Host 上的绝对路径；离线设备也可保存，空闲后生效；不会移动文件。
                {profileBlocked ? '（设备离线：名称/描述暂不可保存，请先连线或仅修改工作目录）' : ''}
              </p>
              <div className="action-row">
                <button
                  className="button"
                  type="submit"
                  disabled={busy || !canSave}
                >
                  保存
                </button>
                <button className="quiet-button" type="button" onClick={() => setEditingBot(undefined)}>
                  取消
                </button>
              </div>
            </form>
          </div>
          );
        })()}
      </SheetModal>

      <SheetModal
        open={editingDevice !== undefined}
        onOpenChange={isOpen => {
          if (!isOpen) setEditingDevice(undefined);
        }}
        title="重命名设备"
        description={editingDevice ? `设备 ID: ${editingDevice.deviceId}` : undefined}
      >
        {editingDevice && (
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
                if (!editingDevice.name.trim()) return;
                void run(async () => {
                  await api.renameDevice(editingDevice.deviceId, editingDevice.name.trim());
                  setEditingDevice(undefined);
                  await syncBotsNow();
                  setNotice('设备名称已更新');
                });
              }}
            >
              <label>
                设备名称
                <input
                  value={editingDevice.name}
                  onChange={e => setEditingDevice({ ...editingDevice, name: e.target.value })}
                  maxLength={120}
                  required
                  disabled={busy}
                />
              </label>
              <div className="action-row">
                <button className="button" type="submit" disabled={busy || !editingDevice.name.trim()}>
                  保存
                </button>
                <button
                  className="quiet-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditingDevice(undefined)}
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}
      </SheetModal>
    </main>
  );
}
