import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { Archive, Check, Pencil, Plus, QrCode, Shield, X } from 'lucide-react';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  ActionMenu,
  CaDisclosure,
  CaModal,
  CaNotice,
  CaQrBox,
  CaSegmented,
  CaSwitch,
  CopyButton,
  formatCountdown,
  formatTime,
  platformLabel,
} from './primitives';
import type {
  ActivePairingCodeInfo,
  BotCapabilityEntry,
  BotLearningStatus,
  BotModelConfig,
  CenterBotRef,
  CenterDevice,
  CreatePairingCodeResponse,
  ModelPickerResponse,
  PairingCaState,
} from './types';

interface PendingPairingState {
  id: string;
  code: string;
  expiresAt: string;
  includesCa: boolean;
  target: { deviceId: string; name: string } | null;
}

export function DevicesTab({
  api,
  onConfigureBot,
  renderQr,
}: {
  api: CenterApi;
  onConfigureBot?: (deviceId: string, botId: string) => void;
  renderQr?: (value: string, label: string) => React.ReactNode;
}): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [bots, setBots] = useState<CenterBotRef[]>([]);
  const [picker, setPicker] = useState<ModelPickerResponse | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Inline device rename
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);

  // Pairing code state (NEVER deleted on modal close!)
  const [pendingPairing, setPendingPairing] = useState<PendingPairingState | null>(null);
  const [pairingModalOpen, setPairingModalOpen] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);

  // CA drawer
  const [caOpen, setCaOpen] = useState(false);
  const [caState, setCaState] = useState<PairingCaState | null>(null);
  const [caDraft, setCaDraft] = useState('');
  const [caBusy, setCaBusy] = useState(false);
  const [caError, setCaError] = useState('');

  // Create Bot modal
  const [createBotDevice, setCreateBotDevice] = useState<CenterDevice | null>(null);
  const [newBotRole, setNewBotRole] = useState('');
  const [newBotDesc, setNewBotDesc] = useState('');
  const [newBotCwd, setNewBotCwd] = useState('');
  const [newBotPrimary, setNewBotPrimary] = useState(false);
  const [newBotModelRef, setNewBotModelRef] = useState('');
  const [createBotBusy, setCreateBotBusy] = useState(false);
  const [createBotError, setCreateBotError] = useState('');

  // Built-in aggregated Bot Config drawer (used when onConfigureBot is not supplied)
  const [cfgBot, setCfgBot] = useState<CenterBotRef | null>(null);
  const [cfgTab, setCfgTab] = useState<'basic' | 'caps' | 'learning'>('basic');
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgError, setCfgError] = useState('');
  const [cfgNotice, setCfgNotice] = useState('');
  const [cfgName, setCfgName] = useState('');
  const [cfgDesc, setCfgDesc] = useState('');
  const [cfgCwd, setCfgCwd] = useState('');
  const [cfgCwdRev, setCfgCwdRev] = useState(0);
  const [cfgModel, setCfgModel] = useState<BotModelConfig | null>(null);
  const [cfgCaps, setCfgCaps] = useState<BotCapabilityEntry[]>([]);
  const [cfgLearning, setCfgLearning] = useState<BotLearningStatus | null>(null);
  const [learnMemoryEvery, setLearnMemoryEvery] = useState(5);
  const [learnSkillEvery, setLearnSkillEvery] = useState(10);
  const [learnIntervalHours, setLearnIntervalHours] = useState(12);
  const [learnMinIdleHours, setLearnMinIdleHours] = useState(2);

  const loadAll = useCallback(async () => {
    const [sync, pickerRes, activeCodes] = await Promise.all([
      api.getBotSync(),
      api.getModelPicker().catch(() => null),
      api.listActivePairingCodes().catch(() => [] as ActivePairingCodeInfo[]),
    ]);
    // Also fetch listDevices in case oauthAdminEnabled/platform is enriched there
    const devList = await api.listDevices().catch(() => sync.devices);
    const mergedDevices = devList.length > 0 ? devList : sync.devices;
    setDevices(mergedDevices);
    setBots(sync.bots ?? []);
    if (pickerRes) setPicker(pickerRes);

    // Sync first non-expired active pairing code if we don't have a newer one with full code text
    if (activeCodes.length > 0) {
      const valid = activeCodes.find(c => c.status === 'pending' && new Date(c.expiresAt).getTime() > Date.now());
      if (valid) {
        setPendingPairing(prev => {
          if (prev && prev.id === valid.id) return prev;
          if (!valid.code) return prev;
          return {
            id: valid.id,
            code: valid.code,
            expiresAt: valid.expiresAt,
            includesCa: valid.includesCa,
            target: valid.target,
          };
        });
      }
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadAll()
      .catch(err => {
        if (active) setError(errorMessage(err, '加载设备与智能体失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAll]);

  // Countdown tick & pairing status poll
  useEffect(() => {
    if (!pendingPairing) return;
    const tickTimer = window.setInterval(() => setNowMs(Date.now()), 1000);
    const pollTimer = window.setInterval(() => {
      void api
        .getPairingCode(pendingPairing.id)
        .then(state => {
          if (state.status === 'redeemed') {
            setPendingPairing(null);
            setPairingModalOpen(false);
            setNotice(`设备「${state.device?.name || '新设备'}」已扫码绑定成功`);
            void loadAll();
          } else if (state.status === 'expired' || state.status === 'revoked') {
            setPendingPairing(null);
          }
        })
        .catch(() => {
          // Ignore transient poll errors
        });
    }, 2000);

    return () => {
      window.clearInterval(tickTimer);
      window.clearInterval(pollTimer);
    };
  }, [api, loadAll, pendingPairing]);

  // Clear expired local banner
  useEffect(() => {
    if (pendingPairing && new Date(pendingPairing.expiresAt).getTime() <= nowMs) {
      setPendingPairing(null);
    }
  }, [nowMs, pendingPairing]);

  const handleOpenPairing = async (targetDeviceId?: string) => {
    // Reuse existing pending code if it matches the same target and has > 15s left
    if (
      pendingPairing &&
      (pendingPairing.target?.deviceId ?? undefined) === targetDeviceId &&
      new Date(pendingPairing.expiresAt).getTime() - Date.now() > 15_000
    ) {
      setPairingModalOpen(true);
      return;
    }

    setPairingBusy(true);
    setError('');
    try {
      const created: CreatePairingCodeResponse = await api.createPairingCode(targetDeviceId);
      setPendingPairing({
        id: created.id,
        code: created.code,
        expiresAt: created.expiresAt,
        includesCa: created.includesCa,
        target: created.target,
      });
      setNowMs(Date.now());
      setPairingModalOpen(true);
    } catch (err) {
      setError(errorMessage(err, '生成配对码失败'));
    } finally {
      setPairingBusy(false);
    }
  };

  const handleRevokePendingPairing = async () => {
    if (!pendingPairing) return;
    const targetId = pendingPairing.id;
    setPendingPairing(null);
    setPairingModalOpen(false);
    try {
      await api.revokePairingCode(targetId);
      setNotice('已作废待用配对码');
    } catch (err) {
      setError(errorMessage(err, '作废配对码失败'));
    }
  };

  // CA Settings
  const openCaDrawer = () => {
    setCaError('');
    setCaOpen(true);
    void api
      .getPairingCa()
      .then(st => {
        setCaState(st);
        setCaDraft(st.ca ?? '');
      })
      .catch(err => setCaError(errorMessage(err, '读取证书配置失败')));
  };

  const handleSaveCa = async (nextCa: string | null) => {
    setCaBusy(true);
    setCaError('');
    try {
      const updated = await api.putPairingCa(nextCa);
      setCaState(updated);
      setCaDraft(updated.ca ?? '');
      setNotice(nextCa ? '私有 CA 证书已保存，新生成的配对码将自动携带' : '已清除私有 CA 证书');
    } catch (err) {
      setCaError(errorMessage(err, '保存证书失败'));
    } finally {
      setCaBusy(false);
    }
  };

  // Device controls
  const handleSaveDeviceRename = async (device: CenterDevice) => {
    const trimmed = renameDraft.trim();
    if (!trimmed) return;
    setError('');
    try {
      const updated = await api.renameDevice(device.deviceId, trimmed);
      setDevices(prev => prev.map(d => (d.deviceId === updated.deviceId ? { ...d, ...updated } : d)));
      setRenamingDeviceId(null);
    } catch (err) {
      setError(errorMessage(err, '重命名设备失败'));
    }
  };

  const handleToggleOAuthGrant = async (device: CenterDevice, nextEnabled: boolean) => {
    setOauthBusyId(device.deviceId);
    setError('');
    try {
      const updated = await api.setDeviceOAuthGrant(device.deviceId, nextEnabled);
      setDevices(prev =>
        prev.map(d =>
          d.deviceId === device.deviceId
            ? { ...d, ...updated, oauthAdminEnabled: updated.oauthAdminEnabled ?? nextEnabled }
            : d,
        ),
      );
      setNotice(
        nextEnabled
          ? `已开启「${device.name}」的中心管理权限`
          : `已收回「${device.name}」的中心管理权限`,
      );
    } catch (err) {
      setError(errorMessage(err, '切换中心管理权限失败'));
    } finally {
      setOauthBusyId(null);
    }
  };

  const handleDeleteDevice = async (device: CenterDevice) => {
    if (!window.confirm(`确定移除设备「${device.name}」吗？其下所有智能体绑定将一并撤销。`)) return;
    setError('');
    try {
      await api.deleteDevice(device.deviceId);
      await loadAll();
      setNotice(`已移除设备 ${device.name}`);
    } catch (err) {
      setError(errorMessage(err, '移除设备失败'));
    }
  };

  // Bot actions
  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createBotDevice) return;
    const role = newBotRole.trim();
    if (!role) {
      setCreateBotError('请填写智能体名称');
      return;
    }
    setCreateBotBusy(true);
    setCreateBotError('');
    try {
      const created = await api.createBot(createBotDevice.deviceId, {
        role,
        ...(newBotDesc.trim() ? { description: newBotDesc.trim() } : {}),
        ...(newBotCwd.trim() ? { cwd: newBotCwd.trim() } : {}),
        makePrimary: newBotPrimary,
      });
      if (newBotModelRef) {
        const currentCfg = await api.getBotModelConfig(createBotDevice.deviceId, created.botId);
        await api.putBotModelConfig(createBotDevice.deviceId, created.botId, {
          expectedRevision: currentCfg.revision,
          value: { modelRef: newBotModelRef },
        });
      }
      setCreateBotDevice(null);
      setNewBotRole('');
      setNewBotDesc('');
      setNewBotCwd('');
      setNewBotPrimary(false);
      setNewBotModelRef('');
      await loadAll();
      setNotice(`已创建智能体「${created.name}」`);
    } catch (err) {
      setCreateBotError(errorMessage(err, '创建智能体失败'));
    } finally {
      setCreateBotBusy(false);
    }
  };

  const handleBotMenuAction = async (
    bot: CenterBotRef,
    action: 'primary' | 'archive' | 'unarchive' | 'delete',
  ) => {
    setError('');
    try {
      if (action === 'primary') {
        await api.setPrimaryBot(bot.deviceId, bot.botId);
        setNotice(`已将「${bot.name}」设为主智能体`);
      } else if (action === 'archive') {
        await api.archiveBot(bot.deviceId, bot.botId);
        setNotice(`已归档「${bot.name}」`);
      } else if (action === 'unarchive') {
        await api.unarchiveBot(bot.deviceId, bot.botId);
        setNotice(`已恢复「${bot.name}」`);
      } else {
        if (!window.confirm(`确定彻底删除智能体「${bot.name}」吗？`)) return;
        await api.deleteBot(bot.deviceId, bot.botId);
        setNotice(`已删除「${bot.name}」`);
      }
      await loadAll();
    } catch (err) {
      setError(errorMessage(err, '操作智能体失败'));
    }
  };

  // Built-in Bot config drawer
  const openBuiltinBotConfig = async (bot: CenterBotRef) => {
    setCfgBot(bot);
    setCfgTab('basic');
    setCfgError('');
    setCfgNotice('');
    setCfgName(bot.name);
    setCfgDesc(bot.description ?? '');
    setCfgCwd(bot.cwd ?? '');
    setCfgCwdRev(bot.cwdRevision ?? 0);
    setCfgModel(null);
    setCfgCaps([]);
    setCfgLearning(null);
    setCfgBusy(true);
    try {
      const [modelCfg, cwdCfg, capsList, learningRes] = await Promise.all([
        api.getBotModelConfig(bot.deviceId, bot.botId).catch(() => null),
        api.getBotCwd(bot.deviceId, bot.botId).catch(() => null),
        api.listBotCapabilities(bot.deviceId, bot.botId).catch(() => [] as BotCapabilityEntry[]),
        api.getBotLearningStatus(bot.deviceId, bot.botId).catch(() => null),
      ]);
      if (modelCfg) setCfgModel(modelCfg);
      if (cwdCfg) {
        setCfgCwd(cwdCfg.value ?? '');
        setCfgCwdRev(cwdCfg.revision);
      }
      setCfgCaps(capsList);
      if (learningRes) {
        setCfgLearning(learningRes);
        setLearnMemoryEvery(learningRes.settings.review.memoryEvery);
        setLearnSkillEvery(learningRes.settings.review.skillEvery);
        setLearnIntervalHours(learningRes.settings.curator.intervalHours);
        setLearnMinIdleHours(learningRes.settings.curator.minIdleHours);
      }
    } catch (err) {
      setCfgError(errorMessage(err, '读取智能体配置失败'));
    } finally {
      setCfgBusy(false);
    }
  };

  const handleSetBotModel = async (modelRef: string | null) => {
    if (!cfgBot || !cfgModel) return;
    setCfgBusy(true);
    setCfgError('');
    try {
      const nextOverrides = { ...cfgModel.overrides };
      if (modelRef) nextOverrides.modelRef = modelRef;
      else delete nextOverrides.modelRef;
      const updated = await api.putBotModelConfig(cfgBot.deviceId, cfgBot.botId, {
        expectedRevision: cfgModel.revision,
        value: nextOverrides,
      });
      setCfgModel(updated);
      setCfgNotice(modelRef ? '已切换专属模型' : '已设为跟随全局默认模型');
      await loadAll();
    } catch (err) {
      setCfgError(errorMessage(err, '保存模型设置失败'));
    } finally {
      setCfgBusy(false);
    }
  };

  const handleSaveBotProfileAndCwd = async () => {
    if (!cfgBot) return;
    setCfgBusy(true);
    setCfgError('');
    setCfgNotice('');
    try {
      await api.updateBot(cfgBot.deviceId, cfgBot.botId, {
        name: cfgName.trim() || cfgBot.name,
        description: cfgDesc.trim(),
      });
      if (cfgCwd.trim()) {
        const nextCwd = await api.putBotCwd(cfgBot.deviceId, cfgBot.botId, {
          expectedRevision: cfgCwdRev,
          value: cfgCwd.trim(),
        });
        setCfgCwd(nextCwd.value ?? '');
        setCfgCwdRev(nextCwd.revision);
      }
      await loadAll();
      setCfgNotice('基础信息与工作目录已保存');
    } catch (err) {
      setCfgError(errorMessage(err, '保存失败'));
    } finally {
      setCfgBusy(false);
    }
  };

  const handleToggleBotCap = async (entry: BotCapabilityEntry, nextEnabled: boolean) => {
    if (!cfgBot) return;
    setCfgError('');
    try {
      const updated = await api.putBotCapability(
        cfgBot.deviceId,
        cfgBot.botId,
        entry.installation.installationId,
        {
          expectedRevision: entry.config.revision,
          enabled: nextEnabled,
          overrides: entry.config.overrides,
        },
      );
      setCfgCaps(prev =>
        prev.map(item =>
          item.installation.installationId === entry.installation.installationId
            ? { ...item, config: updated }
            : item,
        ),
      );
    } catch (err) {
      setCfgError(errorMessage(err, '切换能力授权失败'));
    }
  };

  const handleToggleLearning = async (nextEnabled: boolean) => {
    if (!cfgBot || !cfgLearning) return;
    setCfgBusy(true);
    setCfgError('');
    try {
      const res = await api.configureBotLearning(cfgBot.deviceId, cfgBot.botId, cfgLearning.settings.revision, {
        enabled: nextEnabled,
        curator: { enabled: nextEnabled },
      });
      setCfgLearning(prev => (prev ? { ...prev, settings: res.settings } : prev));
      setCfgNotice(nextEnabled ? '已开启空闲自动学习技能' : '已暂停空闲自动学习');
    } catch (err) {
      setCfgError(errorMessage(err, '更新学习开关失败'));
    } finally {
      setCfgBusy(false);
    }
  };

  const handleTriggerReview = async (mode: 'review' | 'curate') => {
    if (!cfgBot) return;
    setCfgBusy(true);
    setCfgError('');
    try {
      const res = await api.triggerBotLearning(cfgBot.deviceId, cfgBot.botId, mode);
      setCfgNotice(res.reason || `已提交${mode === 'review' ? '复盘' : '整理'}任务`);
      const refreshed = await api.getBotLearningStatus(cfgBot.deviceId, cfgBot.botId).catch(() => null);
      if (refreshed) setCfgLearning(refreshed);
    } catch (err) {
      setCfgError(errorMessage(err, '触发学习任务失败'));
    } finally {
      setCfgBusy(false);
    }
  };

  const handleSaveLearningAdvanced = async () => {
    if (!cfgBot || !cfgLearning) return;
    setCfgBusy(true);
    setCfgError('');
    try {
      const res = await api.configureBotLearning(cfgBot.deviceId, cfgBot.botId, cfgLearning.settings.revision, {
        review: { memoryEvery: Number(learnMemoryEvery) || 5, skillEvery: Number(learnSkillEvery) || 10 },
        curator: {
          intervalHours: Number(learnIntervalHours) || 12,
          minIdleHours: Number(learnMinIdleHours) || 2,
        },
      });
      setCfgLearning(prev => (prev ? { ...prev, settings: res.settings } : prev));
      setCfgNotice('学习周期参数已保存');
    } catch (err) {
      setCfgError(errorMessage(err, '保存学习参数失败'));
    } finally {
      setCfgBusy(false);
    }
  };

  const globalDefaultName = useMemo(() => {
    if (!picker?.defaultModel) return '未设置';
    const found = picker.models.find(m => m.modelRef === picker.defaultModel);
    return found?.name || picker.defaultModel;
  }, [picker]);

  const sortedPickerModels = useMemo(() => {
    if (!picker) return [];
    const starred = new Set(picker.starredModels);
    return [...picker.models].sort((a, b) => (starred.has(a.modelRef) ? 0 : 1) - (starred.has(b.modelRef) ? 0 : 1));
  }, [picker]);

  const activeBotsByDevice = useMemo(() => {
    const map = new Map<string, CenterBotRef[]>();
    for (const b of bots) {
      if (b.archivedAt) continue;
      const list = map.get(b.deviceId) ?? [];
      list.push(b);
      map.set(b.deviceId, list);
    }
    return map;
  }, [bots]);

  const archivedBots = useMemo(() => bots.filter(b => Boolean(b.archivedAt)), [bots]);

  const botModelDisplay = (bot: CenterBotRef): { label: string; unset: boolean } => {
    if (bot.resolvedModel) {
      return {
        label: bot.resolvedModel.effectiveModelName || '未配置模型',
        unset: !bot.resolvedModel.effectiveModelName || bot.resolvedModel.source === 'unset',
      };
    }
    if (bot.modelRef) {
      const found = picker?.models.find(m => m.modelRef === bot.modelRef);
      return { label: found?.name || bot.modelRef, unset: false };
    }
    if (picker?.defaultModel) {
      return { label: `默认 (${globalDefaultName})`, unset: false };
    }
    return { label: '未配置模型', unset: true };
  };

  if (loading) {
    return <div className="ca-empty">正在加载设备与智能体…</div>;
  }

  return (
    <div>
      {error && <CaNotice tone="danger">{error}</CaNotice>}
      {notice && (
        <CaNotice
          tone="ok"
          action={
            <button type="button" className="ca-btn ca-btn-ghost ca-btn-sm" onClick={() => setNotice('')}>
              关闭
            </button>
          }
        >
          {notice}
        </CaNotice>
      )}

      {/* 顶部未核销配对码状态条（关闭弹窗不作废，仅点「作废」或绑定完成核销） */}
      {pendingPairing && (
        <CaNotice
          tone="info"
          action={
            <>
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                onClick={() => setPairingModalOpen(true)}
              >
                查看二维码
              </button>
              <CopyButton value={pendingPairing.code} label="复制配对码" />
              <button
                type="button"
                className="ca-btn ca-btn-danger ca-btn-sm"
                onClick={() => void handleRevokePendingPairing()}
              >
                作废
              </button>
            </>
          }
        >
          <span className="ca-num">
            {pendingPairing.target
              ? `设备「${pendingPairing.target.name}」待重绑配对码生效中`
              : '新设备待绑定配对码生效中'}
            （剩余 {formatCountdown(pendingPairing.expiresAt, nowMs)}）
          </span>
        </CaNotice>
      )}

      {/* 工具栏 */}
      <div className="ca-toolbar">
        <div className="ca-muted ca-num">
          共 {devices.length} 台设备 · {bots.filter(b => !b.archivedAt).length} 个活跃智能体
        </div>
        <div className="ca-toolbar-group">
          <button type="button" className="ca-btn ca-btn-sm" onClick={openCaDrawer}>
            <Shield size={14} />
            <span>证书设置</span>
          </button>
          <button
            type="button"
            className="ca-btn ca-btn-primary ca-btn-sm"
            disabled={pairingBusy}
            onClick={() => void handleOpenPairing()}
          >
            <QrCode size={14} />
            <span>{pairingBusy ? '生成中…' : '扫码添加设备'}</span>
          </button>
        </div>
      </div>

      {/* 设备列表 */}
      {devices.length === 0 ? (
        <section className="ca-section">
          <div className="ca-empty">
            暂无已绑定设备，点击右上角「扫码添加设备」生成配对码连接桌面或手机客户端
          </div>
        </section>
      ) : (
        devices.map(device => {
          const devBots = activeBotsByDevice.get(device.deviceId) ?? [];
          const isRenaming = renamingDeviceId === device.deviceId;
          const oauthEnabled = device.oauthAdminEnabled !== false;

          return (
            <section key={device.deviceId} className="ca-section">
              <div className="ca-section-head" style={{ flexWrap: 'wrap' }}>
                <div className="ca-inline-row" style={{ flex: 1, minWidth: 200 }}>
                  <span className={`ca-dot ${device.online ? 'is-online' : ''}`} />
                  {isRenaming ? (
                    <div className="ca-inline-row" style={{ flex: 1, maxWidth: 280 }}>
                      <input
                        type="text"
                        className="ca-input"
                        style={{ paddingTop: 3, paddingBottom: 3 }}
                        value={renameDraft}
                        onChange={e => setRenameDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void handleSaveDeviceRename(device);
                          if (e.key === 'Escape') setRenamingDeviceId(null);
                        }}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-icon"
                        onClick={() => void handleSaveDeviceRename(device)}
                        aria-label="保存名称"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-icon"
                        onClick={() => setRenamingDeviceId(null)}
                        aria-label="取消"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="ca-section-title">{device.name}</span>
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-icon"
                        aria-label="重命名设备"
                        onClick={() => {
                          setRenamingDeviceId(device.deviceId);
                          setRenameDraft(device.name);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    </>
                  )}
                  {device.platform && (
                    <span className="ca-pill ca-pill-muted">{platformLabel(device.platform)}</span>
                  )}
                  <span className={`ca-pill ${device.online ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
                    {device.online ? '在线' : '离线'}
                  </span>
                </div>

                <div className="ca-inline-row" style={{ flexWrap: 'wrap' }}>
                  <label
                    className="ca-inline-row"
                    style={{ fontSize: 12.5, color: 'var(--ca-text-muted)', cursor: 'pointer' }}
                    title="控制该设备扫码绑定后是否具备免密管理中心的 OAuth 权限"
                  >
                    <span>中心管理权限</span>
                    <CaSwitch
                      checked={oauthEnabled}
                      disabled={oauthBusyId === device.deviceId}
                      label={`切换 ${device.name} 中心管理权限`}
                      onChange={next => void handleToggleOAuthGrant(device, next)}
                    />
                  </label>
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => {
                      setCreateBotDevice(device);
                      setNewBotRole('');
                      setNewBotDesc('');
                      setNewBotCwd('');
                      setNewBotPrimary(false);
                      setNewBotModelRef('');
                      setCreateBotError('');
                    }}
                  >
                    <Plus size={13} />
                    <span>新建智能体</span>
                  </button>
                  <ActionMenu
                    items={[
                      {
                        label: '重新扫码绑定',
                        onSelect: () => void handleOpenPairing(device.deviceId),
                      },
                      {
                        label: '移除此设备',
                        danger: true,
                        onSelect: () => void handleDeleteDevice(device),
                      },
                    ]}
                  />
                </div>
              </div>

              {/* 下属 Bot 列表：极简行，直显 Bot 名 + 当前真实生效模型名 */}
              <div className="ca-list">
                {devBots.length === 0 ? (
                  <div className="ca-empty">此设备暂无智能体，点击上方「+ 新建智能体」创建</div>
                ) : (
                  devBots.map(bot => {
                    const modelDisp = botModelDisplay(bot);
                    return (
                      <div key={bot.botId} className="ca-row">
                        <div className="ca-row-main">
                          <div className="ca-row-title">
                            <span>{bot.name}</span>
                            {bot.isPrimary && <span className="ca-pill ca-pill-info">主智能体</span>}
                            <span className={`ca-pill ${modelDisp.unset ? 'ca-pill-warn' : 'ca-pill-muted'}`}>
                              {modelDisp.label}
                            </span>
                          </div>
                          {bot.description && <div className="ca-row-sub">{bot.description}</div>}
                        </div>
                        <div className="ca-row-actions">
                          <button
                            type="button"
                            className="ca-btn ca-btn-sm"
                            onClick={() => {
                              if (onConfigureBot) onConfigureBot(bot.deviceId, bot.botId);
                              else void openBuiltinBotConfig(bot);
                            }}
                          >
                            配置
                          </button>
                          <ActionMenu
                            items={[
                              {
                                label: '设为主智能体',
                                disabled: Boolean(bot.isPrimary),
                                onSelect: () => void handleBotMenuAction(bot, 'primary'),
                              },
                              {
                                label: '归档智能体',
                                onSelect: () => void handleBotMenuAction(bot, 'archive'),
                              },
                              {
                                label: '删除智能体',
                                danger: true,
                                onSelect: () => void handleBotMenuAction(bot, 'delete'),
                              },
                            ]}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          );
        })
      )}

      {/* 已归档智能体折叠区 */}
      {archivedBots.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <CaDisclosure title={`已归档智能体 (${archivedBots.length})`}>
            <section className="ca-section">
              <div className="ca-list">
                {archivedBots.map(bot => (
                  <div key={`${bot.deviceId}-${bot.botId}`} className="ca-row">
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <Archive size={14} />
                        <span>{bot.name}</span>
                        <span className="ca-pill ca-pill-muted">{bot.deviceName || bot.deviceId}</span>
                      </div>
                    </div>
                    <div className="ca-row-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => void handleBotMenuAction(bot, 'unarchive')}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className="ca-btn ca-btn-danger ca-btn-sm"
                        onClick={() => void handleBotMenuAction(bot, 'delete')}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </CaDisclosure>
        </div>
      )}

      {/* 扫码添加 / 重绑设备弹窗（关闭时不核销配对码） */}
      <CaModal
        open={pairingModalOpen}
        onOpenChange={setPairingModalOpen}
        title={pendingPairing?.target ? `重新绑定设备 · ${pendingPairing.target.name}` : '扫码添加设备'}
        description="使用手机端或桌面端扫一扫 / 粘贴配对码即可完成绑定"
        variant="modal"
      >
        {pendingPairing ? (
          <div className="ca-form-stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <CaQrBox value={pendingPairing.code} label="设备配对二维码" renderQr={renderQr} />

            <div className="ca-muted ca-num">
              有效期剩余 <strong>{formatCountdown(pendingPairing.expiresAt, nowMs)}</strong>
              {pendingPairing.includesCa ? ' · 已内嵌私有 CA 证书' : ''}
            </div>

            <div className="ca-inline-row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
              <CopyButton value={pendingPairing.code} label="复制配对码" />
              <button
                type="button"
                className="ca-btn ca-btn-danger ca-btn-sm"
                onClick={() => void handleRevokePendingPairing()}
              >
                作废此配对码
              </button>
            </div>
            <p className="ca-field-help">
              关闭此窗口不会作废配对码，可在设备页顶部状态条随时重新打开或作废。
            </p>
          </div>
        ) : (
          <div className="ca-empty">正在生成配对码…</div>
        )}
      </CaModal>

      {/* 私有 CA 证书设置抽屉 */}
      <CaModal
        open={caOpen}
        onOpenChange={setCaOpen}
        title="私有 CA 证书设置"
        description="若中心使用自签或内网 HTTPS 证书，可在此配置信任根证书（新配对码将自动携带）"
        variant="drawer"
      >
        <div className="ca-form-stack">
          {caError && <CaNotice tone="danger">{caError}</CaNotice>}
          {caState && caState.certificates.length > 0 && (
            <div className="ca-cred-box">
              <div className="ca-field-label" style={{ marginBottom: 4 }}>
                当前已解析证书 ({caState.certificates.length})
              </div>
              {caState.certificates.map(cert => (
                <div key={cert.fingerprint256} className="ca-muted" style={{ marginTop: 4 }}>
                  <div>{cert.subject}</div>
                  <div className="ca-mono">有效期至 {formatTime(cert.validTo)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label">PEM 根证书内容</label>
            <textarea
              rows={8}
              className="ca-textarea ca-mono"
              placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
              value={caDraft}
              onChange={e => setCaDraft(e.target.value)}
            />
          </div>

          <div className="ca-inline-between">
            <button
              type="button"
              className="ca-btn ca-btn-danger ca-btn-sm"
              disabled={caBusy || !caState?.ca}
              onClick={() => void handleSaveCa(null)}
            >
              清除证书
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              disabled={caBusy || !caDraft.trim()}
              onClick={() => void handleSaveCa(caDraft)}
            >
              {caBusy ? '保存中…' : '保存证书'}
            </button>
          </div>
        </div>
      </CaModal>

      {/* 新建智能体弹窗（直接支持选模型） */}
      <CaModal
        open={Boolean(createBotDevice)}
        onOpenChange={open => {
          if (!open) setCreateBotDevice(null);
        }}
        title={`在「${createBotDevice?.name ?? ''}」新建智能体`}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleCreateBot(e)}>
          {createBotError && <CaNotice tone="danger">{createBotError}</CaNotice>}
          <div className="ca-field">
            <label className="ca-field-label">
              智能体名称 <span className="ca-req">*</span>
            </label>
            <input
              type="text"
              className="ca-input"
              required
              placeholder="例如：代码助手 / 运维助理"
              value={newBotRole}
              onChange={e => setNewBotRole(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">模型选择</label>
            <select
              className="ca-select"
              value={newBotModelRef}
              onChange={e => setNewBotModelRef(e.target.value)}
            >
              <option value="">跟随默认（{globalDefaultName}）</option>
              {sortedPickerModels.map(m => (
                <option key={m.modelRef} value={m.modelRef}>
                  {m.name} ({m.modelRef})
                </option>
              ))}
            </select>
          </div>

          <div className="ca-field">
            <label className="ca-field-label">简介（可选）</label>
            <input
              type="text"
              className="ca-input"
              placeholder="简述职责或定位"
              value={newBotDesc}
              onChange={e => setNewBotDesc(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">工作目录 CWD（可选）</label>
            <input
              type="text"
              className="ca-input ca-mono"
              placeholder="留空由设备端分配默认目录"
              value={newBotCwd}
              onChange={e => setNewBotCwd(e.target.value)}
            />
          </div>

          <label className="ca-check-label">
            <input
              type="checkbox"
              checked={newBotPrimary}
              onChange={e => setNewBotPrimary(e.target.checked)}
            />
            <span>设为此设备主智能体</span>
          </label>

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setCreateBotDevice(null)}>
              取消
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={createBotBusy}>
              {createBotBusy ? '创建中…' : '创建智能体'}
            </button>
          </div>
        </form>
      </CaModal>

      {/* 内置聚合智能体配置抽屉（未传外部 onConfigureBot 时使用） */}
      <CaModal
        open={Boolean(cfgBot)}
        onOpenChange={open => {
          if (!open) setCfgBot(null);
        }}
        title={`配置智能体 · ${cfgBot?.name ?? ''}`}
        description={cfgBot?.deviceName || cfgBot?.deviceId}
        variant="drawer"
        wide
      >
        {cfgBot && (
          <div className="ca-form-stack">
            {cfgError && <CaNotice tone="danger">{cfgError}</CaNotice>}
            {cfgNotice && <CaNotice tone="ok">{cfgNotice}</CaNotice>}

            <CaSegmented
              value={cfgTab}
              options={[
                { value: 'basic', label: '模型与基础信息' },
                { value: 'caps', label: '技能与扩展' },
                { value: 'learning', label: '自主学习' },
              ]}
              onChange={setCfgTab}
            />

            {cfgTab === 'basic' && (
              <div className="ca-form-stack">
                <div className="ca-section" style={{ padding: 12 }}>
                  <div className="ca-field-label" style={{ marginBottom: 6 }}>
                    模型配置（即点即存）
                  </div>
                  <div className="ca-model-list" style={{ maxHeight: 220 }}>
                    <button
                      type="button"
                      className={`ca-model-option ${!cfgModel?.overrides.modelRef ? 'is-selected' : ''}`}
                      disabled={cfgBusy}
                      onClick={() => void handleSetBotModel(null)}
                    >
                      <span>跟随全局默认（{globalDefaultName}）</span>
                      {!cfgModel?.overrides.modelRef && <Check size={14} />}
                    </button>
                    {sortedPickerModels.map(m => {
                      const active = cfgModel?.overrides.modelRef === m.modelRef;
                      return (
                        <button
                          key={m.modelRef}
                          type="button"
                          className={`ca-model-option ${active ? 'is-selected' : ''}`}
                          disabled={cfgBusy}
                          onClick={() => void handleSetBotModel(m.modelRef)}
                        >
                          <div>
                            <div>{m.name}</div>
                            <div className="ca-muted ca-mono">{m.modelRef}</div>
                          </div>
                          {active && <Check size={14} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="ca-section" style={{ padding: 12 }}>
                  <div className="ca-form-stack">
                    <div className="ca-grid-2">
                      <div className="ca-field">
                        <label className="ca-field-label">智能体名称</label>
                        <input
                          type="text"
                          className="ca-input"
                          value={cfgName}
                          onChange={e => setCfgName(e.target.value)}
                        />
                      </div>
                      <div className="ca-field">
                        <label className="ca-field-label">简介</label>
                        <input
                          type="text"
                          className="ca-input"
                          value={cfgDesc}
                          onChange={e => setCfgDesc(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="ca-field">
                      <label className="ca-field-label">工作目录 (CWD · 离线可修改，在线后自动同步)</label>
                      <input
                        type="text"
                        className="ca-input ca-mono"
                        placeholder="/path/to/workspace"
                        value={cfgCwd}
                        onChange={e => setCfgCwd(e.target.value)}
                      />
                    </div>

                    <div className="ca-inline-end">
                      <button
                        type="button"
                        className="ca-btn ca-btn-primary ca-btn-sm"
                        disabled={cfgBusy}
                        onClick={() => void handleSaveBotProfileAndCwd()}
                      >
                        保存信息与目录
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {cfgTab === 'caps' && (
              <div className="ca-section">
                <div className="ca-list">
                  {cfgCaps.length === 0 ? (
                    <div className="ca-empty">中心暂无已安装的技能或工具扩展</div>
                  ) : (
                    cfgCaps.map(entry => (
                      <div key={entry.installation.installationId} className="ca-row">
                        <div className="ca-row-main">
                          <div className="ca-row-title">
                            <span>{entry.installation.displayName}</span>
                            <span className="ca-pill ca-pill-muted">{entry.installation.kind}</span>
                          </div>
                          <div className="ca-row-sub">{entry.installation.packageId}</div>
                        </div>
                        <div className="ca-row-actions">
                          <CaSwitch
                            checked={entry.config.enabled}
                            label={`为 ${cfgBot.name} 启用 ${entry.installation.displayName}`}
                            onChange={next => void handleToggleBotCap(entry, next)}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {cfgTab === 'learning' && (
              <div className="ca-form-stack">
                {!cfgLearning ? (
                  <div className="ca-empty">正在读取学习状态或当前智能体暂不支持自主学习…</div>
                ) : (
                  <>
                    <div className="ca-section" style={{ padding: 12 }}>
                      <div className="ca-inline-between">
                        <div>
                          <div className="ca-field-label">空闲自动学习技能</div>
                          <div className="ca-muted">
                            开启后，智能体会在对话间隙自动提炼记忆并沉淀新技能
                          </div>
                        </div>
                        <CaSwitch
                          checked={
                            cfgLearning.settings.enabled ??
                            cfgLearning.settings.curator.enabled ??
                            true
                          }
                          disabled={cfgBusy}
                          onChange={next => void handleToggleLearning(next)}
                        />
                      </div>
                      <div className="ca-inline-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="ca-btn ca-btn-primary ca-btn-sm"
                          disabled={cfgBusy}
                          onClick={() => void handleTriggerReview('review')}
                        >
                          立即复盘
                        </button>
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={cfgBusy}
                          onClick={() => void handleTriggerReview('curate')}
                        >
                          整理记忆与技能
                        </button>
                        {cfgLearning.lastJob && (
                          <span className="ca-muted">
                            最近任务：{cfgLearning.lastJob.mode} · {cfgLearning.lastJob.status}
                          </span>
                        )}
                      </div>
                    </div>

                    <CaDisclosure title="高级学习周期参数">
                      <div className="ca-form-stack">
                        <div className="ca-grid-2">
                          <div className="ca-field">
                            <label className="ca-field-label">记忆复盘间隔（轮次）</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnMemoryEvery}
                              onChange={e => setLearnMemoryEvery(Number(e.target.value))}
                            />
                          </div>
                          <div className="ca-field">
                            <label className="ca-field-label">技能提炼间隔（迭代）</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnSkillEvery}
                              onChange={e => setLearnSkillEvery(Number(e.target.value))}
                            />
                          </div>
                          <div className="ca-field">
                            <label className="ca-field-label">整理周期（小时）</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnIntervalHours}
                              onChange={e => setLearnIntervalHours(Number(e.target.value))}
                            />
                          </div>
                          <div className="ca-field">
                            <label className="ca-field-label">最小空闲时间（小时）</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnMinIdleHours}
                              onChange={e => setLearnMinIdleHours(Number(e.target.value))}
                            />
                          </div>
                        </div>
                        <div className="ca-inline-end">
                          <button
                            type="button"
                            className="ca-btn ca-btn-sm"
                            disabled={cfgBusy}
                            onClick={() => void handleSaveLearningAdvanced()}
                          >
                            保存高级参数
                          </button>
                        </div>
                      </div>
                    </CaDisclosure>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CaModal>
    </div>
  );
}
