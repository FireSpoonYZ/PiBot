import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { Archive, Check, Pencil, Plus, QrCode, RefreshCw, Shield, Trash2, X } from 'lucide-react';
import { LabelStack } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { RemoveDeviceDialog } from './RemoveDeviceDialog';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  ActionMenu,
  CaConfirmDialog,
  CaDisclosure,
  CaModal,
  CaNotice,
  CaQrBox,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSegmented,
  CaSwitch,
  CaToolbarSkeleton,
  CopyButton,
  formatCountdown,
  formatTime,
  platformLabel,
  useCaTabNotices,
  useUiLocale,
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

interface DevicesCacheData {
  devices: CenterDevice[];
  bots: CenterBotRef[];
  picker: ModelPickerResponse | null;
  pendingPairing: PendingPairingState | null;
}

export function DevicesTab({
  api,
  active = true,
  cacheKey = 'default',
  onConfigureBot,
  renderQr,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  onConfigureBot?: (deviceId: string, botId: string) => void;
  renderQr?: (value: string, label: string) => React.ReactNode;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();

  const initialCache = useMemo(
    () => readTabCache<DevicesCacheData>(cacheKey, 'devices')?.data ?? null,
    [cacheKey],
  );
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');

  const [devices, setDevices] = useState<CenterDevice[]>(() => initialCache?.devices ?? []);
  const [bots, setBots] = useState<CenterBotRef[]>(() => initialCache?.bots ?? []);
  const [picker, setPicker] = useState<ModelPickerResponse | null>(() => initialCache?.picker ?? null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('devices', active);

  const setError = useCallback(
    (msg: string) => {
      if (msg) showNotice('error', msg, { tone: 'danger' });
      else clearNotice('error');
    },
    [clearNotice, showNotice],
  );

  const setNotice = useCallback(
    (msg: string) => {
      if (msg) showNotice('notice', msg, { tone: 'ok' });
      else clearNotice('notice');
    },
    [clearNotice, showNotice],
  );

  const setCaError = useCallback(
    (msg: string) => {
      if (msg) showNotice('ca-error', msg, { tone: 'danger' });
      else clearNotice('ca-error');
    },
    [clearNotice, showNotice],
  );

  const setCreateBotError = useCallback(
    (msg: string) => {
      if (msg) showNotice('create-bot-error', msg, { tone: 'danger' });
      else clearNotice('create-bot-error');
    },
    [clearNotice, showNotice],
  );

  const setCfgError = useCallback(
    (msg: string) => {
      if (msg) showNotice('cfg-error', msg, { tone: 'danger' });
      else clearNotice('cfg-error');
    },
    [clearNotice, showNotice],
  );

  const setCfgNotice = useCallback(
    (msg: string) => {
      if (msg) showNotice('cfg-notice', msg, { tone: 'ok' });
      else clearNotice('cfg-notice');
    },
    [clearNotice, showNotice],
  );

  // Inline device rename
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [deviceToRemove, setDeviceToRemove] = useState<CenterDevice | null>(null);
  const [botToDelete, setBotToDelete] = useState<CenterBotRef | null>(null);
  const [deletingBot, setDeletingBot] = useState(false);

  // Pairing code state (NEVER deleted on modal close!)
  const [pendingPairing, setPendingPairing] = useState<PendingPairingState | null>(() => {
    const cached = initialCache?.pendingPairing ?? null;
    if (cached && new Date(cached.expiresAt).getTime() > Date.now()) return cached;
    return null;
  });
  const [pairingModalOpen, setPairingModalOpen] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);

  // CA drawer
  const [caOpen, setCaOpen] = useState(false);
  const [caState, setCaState] = useState<PairingCaState | null>(null);
  const [caDraft, setCaDraft] = useState('');
  const [caBusy, setCaBusy] = useState(false);

  // Create Bot modal
  const [createBotDevice, setCreateBotDevice] = useState<CenterDevice | null>(null);
  const [newBotRole, setNewBotRole] = useState('');
  const [newBotDesc, setNewBotDesc] = useState('');
  const [newBotCwd, setNewBotCwd] = useState('');
  const [newBotPrimary, setNewBotPrimary] = useState(false);
  const [newBotModelRef, setNewBotModelRef] = useState('');
  const [createBotBusy, setCreateBotBusy] = useState(false);

  // Built-in aggregated Bot Config drawer (used when onConfigureBot is not supplied)
  const [cfgBot, setCfgBot] = useState<CenterBotRef | null>(null);
  const [cfgTab, setCfgTab] = useState<'basic' | 'caps' | 'learning'>('basic');
  const [cfgBusy, setCfgBusy] = useState(false);
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
    hasLoadedRef.current = true;
    cacheKeyRef.current = cacheKey;
    setHasLoaded(true);
    setInitialError('');
    clearNotice('load-error');
  }, [api, cacheKey, clearNotice]);

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll();
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const msg = errorMessage(err, t('加载设备与 Bot 失败', 'Failed to load devices and Bots'));
      if (hasLoadedRef.current) {
        if (activeRef.current) {
          showNotice('load-error', msg, {
            tone: 'danger',
            action: {
              label: t('重试', 'Retry'),
              onClick: () => void runLoad(),
            },
          });
        }
      } else {
        setInitialError(msg);
      }
    } finally {
      if (gen === loadGenRef.current) setRefreshing(false);
    }
  }, [loadAll, showNotice]);

  useEffect(() => {
    void runLoad();
  }, [runLoad]);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive && active && (hasLoadedRef.current || initialError)) {
      setNowMs(Date.now());
      void runLoad();
    }
  }, [active, initialError, runLoad]);

  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<DevicesCacheData>(cacheKey, 'devices', {
      devices,
      bots,
      picker,
      pendingPairing,
    });
  }, [bots, cacheKey, devices, hasLoaded, pendingPairing, picker]);

  // Countdown tick & pairing status poll (paused when tab is hidden)
  useEffect(() => {
    if (!active || !pendingPairing) return;
    setNowMs(Date.now());
    const checkPairing = () => {
      void api
        .getPairingCode(pendingPairing.id)
        .then(state => {
          if (state.status === 'redeemed') {
            const t = tRef.current;
            setPendingPairing(null);
            setPairingModalOpen(false);
            const deviceName = state.device?.name || t('新设备', 'New device');
            setNotice(t(`设备「${deviceName}」已扫码绑定成功`, `Device "${deviceName}" paired successfully`));
            void loadAll();
          } else if (state.status === 'expired' || state.status === 'revoked') {
            setPendingPairing(null);
          }
        })
        .catch(() => {
          // Ignore transient poll errors
        });
    };
    const tickTimer = window.setInterval(() => setNowMs(Date.now()), 1000);
    const pollTimer = window.setInterval(checkPairing, 2000);

    return () => {
      window.clearInterval(tickTimer);
      window.clearInterval(pollTimer);
    };
  }, [active, api, loadAll, pendingPairing, setNotice]);

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
      setError(errorMessage(err, t('生成配对码失败', 'Failed to generate pairing code')));
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
      setNotice(t('已作废待用配对码', 'Pending pairing code revoked'));
    } catch (err) {
      setError(errorMessage(err, t('作废配对码失败', 'Failed to revoke pairing code')));
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
      .catch(err => setCaError(errorMessage(err, t('读取证书配置失败', 'Failed to load certificate settings'))));
  };

  const handleSaveCa = async (nextCa: string | null) => {
    setCaBusy(true);
    setCaError('');
    try {
      const updated = await api.putPairingCa(nextCa);
      setCaState(updated);
      setCaDraft(updated.ca ?? '');
      setNotice(
        nextCa
          ? t('私有 CA 证书已保存，新生成的配对码将自动携带', 'Private CA certificate saved; new pairing codes will embed it automatically')
          : t('已清除私有 CA 证书', 'Private CA certificate cleared'),
      );
    } catch (err) {
      setCaError(errorMessage(err, t('保存证书失败', 'Failed to save certificate')));
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
      setError(errorMessage(err, t('重命名设备失败', 'Failed to rename device')));
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
          ? t(`已开启「${device.name}」的中心管理权限`, `Enabled center admin access for "${device.name}"`)
          : t(`已收回「${device.name}」的中心管理权限`, `Revoked center admin access for "${device.name}"`),
      );
    } catch (err) {
      setError(errorMessage(err, t('切换中心管理权限失败', 'Failed to update center admin access')));
    } finally {
      setOauthBusyId(null);
    }
  };

  // Bot actions
  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createBotDevice) return;
    const role = newBotRole.trim();
    if (!role) {
      setCreateBotError(t('请填写 Bot 名称', 'Please enter a Bot name'));
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
      setNotice(t(`已创建 Bot「${created.name}」`, `Created Bot "${created.name}"`));
    } catch (err) {
      setCreateBotError(errorMessage(err, t('创建 Bot 失败', 'Failed to create Bot')));
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
        setNotice(t(`已将「${bot.name}」设为主 Bot`, `Set "${bot.name}" as Primary Bot`));
      } else if (action === 'archive') {
        await api.archiveBot(bot.deviceId, bot.botId);
        setNotice(t(`已归档「${bot.name}」`, `Archived "${bot.name}"`));
      } else if (action === 'unarchive') {
        await api.unarchiveBot(bot.deviceId, bot.botId);
        setNotice(t(`已恢复「${bot.name}」`, `Restored "${bot.name}"`));
      } else {
        setBotToDelete(bot);
        return;
      }
      await loadAll();
    } catch (err) {
      setError(errorMessage(err, t('操作 Bot 失败', 'Bot operation failed')));
    }
  };

  const handleConfirmDeleteBot = async () => {
    if (!botToDelete) return;
    const target = botToDelete;
    setDeletingBot(true);
    setError('');
    try {
      await api.deleteBot(target.deviceId, target.botId);
      setBotToDelete(null);
      setNotice(t(`已删除「${target.name}」`, `Deleted "${target.name}"`));
      await loadAll();
    } catch (err) {
      setBotToDelete(null);
      setError(errorMessage(err, t('操作 Bot 失败', 'Bot operation failed')));
    } finally {
      setDeletingBot(false);
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
      setCfgError(errorMessage(err, t('读取 Bot 配置失败', 'Failed to load Bot settings')));
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
      setCfgNotice(
        modelRef
          ? t('已切换专属模型', 'Switched to dedicated model')
          : t('已设为跟随全局默认模型', 'Set to follow global default model'),
      );
      await loadAll();
    } catch (err) {
      setCfgError(errorMessage(err, t('保存模型设置失败', 'Failed to save model settings')));
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
      setCfgNotice(t('基础信息与工作目录已保存', 'Profile and working directory saved'));
    } catch (err) {
      setCfgError(errorMessage(err, t('保存失败', 'Failed to save')));
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
      setCfgError(errorMessage(err, t('切换能力授权失败', 'Failed to update capability authorization')));
    }
  };

  const handleToggleLearning = async (nextEnabled: boolean) => {
    if (!cfgBot || !cfgLearning) return;
    setCfgBusy(true);
    setCfgError('');
    setCfgNotice('');
    try {
      const res = await api.configureBotLearning(cfgBot.deviceId, cfgBot.botId, cfgLearning.settings.revision, {
        review: { enabled: nextEnabled },
      });
      setCfgLearning(prev => prev?.deviceId === cfgBot.deviceId && prev.botId === cfgBot.botId
        ? { ...prev, settings: res.settings }
        : prev);
      setCfgNotice(
        nextEnabled
          ? t('已开启自动反思', 'Automatic reflection enabled')
          : t('已关闭自动反思', 'Automatic reflection disabled'),
      );
    } catch (err) {
      setCfgError(errorMessage(err, t('无法更新自动反思设置', 'Failed to update automatic reflection')));
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
      setCfgNotice(
        res.reason ||
          (mode === 'review'
            ? t('已提交复盘任务', 'Review task submitted')
            : t('已提交整理任务', 'Curate task submitted')),
      );
      const refreshed = await api.getBotLearningStatus(cfgBot.deviceId, cfgBot.botId).catch(() => null);
      if (refreshed) setCfgLearning(refreshed);
    } catch (err) {
      setCfgError(errorMessage(err, t('触发学习任务失败', 'Failed to trigger learning task')));
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
      setCfgNotice(t('学习周期参数已保存', 'Learning schedule parameters saved'));
    } catch (err) {
      setCfgError(errorMessage(err, t('保存学习参数失败', 'Failed to save learning parameters')));
    } finally {
      setCfgBusy(false);
    }
  };

  const globalDefaultName = useMemo(() => {
    if (!picker?.defaultModel) return t('未设置', 'Not set');
    const found = picker.models.find(m => m.modelRef === picker.defaultModel);
    return found?.name || picker.defaultModel;
  }, [picker, t]);

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
        label: bot.resolvedModel.effectiveModelName || t('未配置模型', 'Model not set'),
        unset: !bot.resolvedModel.effectiveModelName || bot.resolvedModel.source === 'unset',
      };
    }
    if (bot.modelRef) {
      const found = picker?.models.find(m => m.modelRef === bot.modelRef);
      return { label: found?.name || bot.modelRef, unset: false };
    }
    if (picker?.defaultModel) {
      return { label: t(`默认 (${globalDefaultName})`, `Default (${globalDefaultName})`), unset: false };
    }
    return { label: t('未配置模型', 'Model not set'), unset: true };
  };

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaToolbarSkeleton leftWidth={168} rightWidth={152} />
        <CaSectionSkeleton rows={2} headWidth={144} trailingWidth={136} label={t('正在加载设备与 Bot…', 'Loading devices and Bots…')} />
        <CaSectionSkeleton rows={2} headWidth={132} trailingWidth={136} />
      </div>
    );
  }

  if (!hasLoaded && initialError) {
    return (
      <section className="ca-section">
        <div className="ca-section-body">
          <CaNotice
            tone="danger"
            action={
              <button type="button" className="ca-btn ca-btn-sm" onClick={() => void runLoad()}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重试', 'Retry')}</span>
              </button>
            }
          >
            {initialError}
          </CaNotice>
        </div>
      </section>
    );
  }

  const activeBotCount = bots.filter(b => !b.archivedAt).length;

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      {/* Active unredeemed pairing code bar (closing modal does not revoke it) */}
      {pendingPairing && (
        <div className="smooth-expand-mount">
          <CaNotice
            tone="info"
            action={
              <>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  onClick={() => setPairingModalOpen(true)}
                >
                  {t('查看二维码', 'View QR Code')}
                </button>
                <CopyButton value={pendingPairing.code} label={t('复制配对码', 'Copy Code')} />
                <button
                  type="button"
                  className="ca-btn ca-btn-danger ca-btn-sm"
                  onClick={() => void handleRevokePendingPairing()}
                >
                  {t('作废', 'Revoke')}
                </button>
              </>
            }
          >
            <span className="ca-num">
              {pendingPairing.target
                ? t(`设备「${pendingPairing.target.name}」待重绑配对码生效中（剩余 ${formatCountdown(pendingPairing.expiresAt, nowMs)}）`, `Re-pairing code active for "${pendingPairing.target.name}" (${formatCountdown(pendingPairing.expiresAt, nowMs)} left)`)
                : t(`新设备待绑定配对码生效中（剩余 ${formatCountdown(pendingPairing.expiresAt, nowMs)}）`, `New device pairing code active (${formatCountdown(pendingPairing.expiresAt, nowMs)} left)`)}
            </span>
          </CaNotice>
        </div>
      )}

      {/* Toolbar */}
      <div className="ca-toolbar">
        <div className="ca-muted ca-num">
          {t(`共 ${devices.length} 台设备 · ${activeBotCount} 个活跃 Bot`, `${devices.length} ${devices.length === 1 ? 'device' : 'devices'} · ${activeBotCount} active ${activeBotCount === 1 ? 'Bot' : 'Bots'}`)}
        </div>
        <div className="ca-toolbar-group">
          <button type="button" className="ca-btn ca-btn-sm" onClick={openCaDrawer}>
            <Shield size={14} aria-hidden="true" />
            <span>{t('证书设置', 'CA Settings')}</span>
          </button>
          <button
            type="button"
            className="ca-btn ca-btn-primary ca-btn-sm"
            disabled={pairingBusy}
            onClick={() => void handleOpenPairing()}
          >
            <QrCode size={14} aria-hidden="true" />
            <LabelStack
              active={pairingBusy ? t('生成中…', 'Generating…') : t('扫码添加设备', 'Pair Device')}
              labels={[t('扫码添加设备', 'Pair Device'), t('生成中…', 'Generating…')]}
            />
          </button>
        </div>
      </div>

      {/* 设备列表 */}
      {devices.length === 0 ? (
        <section className="ca-section">
          <div className="ca-empty">
            {t('暂无已绑定设备，点击右上角「扫码添加设备」生成配对码连接桌面或手机客户端', 'No paired devices yet. Click "Pair Device" in the top right to generate a pairing code for desktop or mobile.')}
          </div>
        </section>
      ) : (
        devices.map(device => {
          const devBots = activeBotsByDevice.get(device.deviceId) ?? [];
          const isRenaming = renamingDeviceId === device.deviceId;
          const oauthEnabled = device.oauthAdminEnabled !== false;

          return (
            <section key={device.deviceId} className="ca-section">
              <div className="ca-section-head">
                <div className="ca-inline-row ca-device-head-main">
                  <span className={`ca-dot ${device.online ? 'is-online' : ''}`} />
                  {isRenaming ? (
                    <div className="ca-inline-row ca-rename-row">
                      <input
                        type="text"
                        className="ca-input ca-input-compact"
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
                        aria-label={t('保存名称', 'Save name')}
                      >
                        <Check size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-icon"
                        onClick={() => setRenamingDeviceId(null)}
                        aria-label={t('取消', 'Cancel')}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="ca-section-title">{device.name}</span>
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-icon"
                        aria-label={t('重命名设备', 'Rename device')}
                        onClick={() => {
                          setRenamingDeviceId(device.deviceId);
                          setRenameDraft(device.name);
                        }}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  {device.platform && (
                    <span className="ca-pill ca-pill-muted">{platformLabel(device.platform, t)}</span>
                  )}
                  <span className={`ca-pill ${device.online ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
                    {device.online ? t('在线', 'Online') : t('离线', 'Offline')}
                  </span>
                </div>

                <div className="ca-inline-row ca-wrap">
                  <label
                    className="ca-inline-row ca-switch-label"
                    title={t('控制该设备扫码绑定后是否具备免密管理中心的 OAuth 权限', 'Controls whether this device has passwordless OAuth admin access to the center after pairing')}
                  >
                    <span>{t('中心管理权限', 'Center admin access')}</span>
                    <CaSwitch
                      checked={oauthEnabled}
                      disabled={oauthBusyId === device.deviceId}
                      label={t(`切换 ${device.name} 中心管理权限`, `Toggle center admin access for ${device.name}`)}
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
                    <Plus size={13} aria-hidden="true" />
                    <span>{t('新建 Bot', 'New Bot')}</span>
                  </button>
                  <button
                    type="button"
                    className="ca-btn ca-btn-ghost ca-btn-icon"
                    aria-label={t(`移除设备 ${device.name}`, `Remove device ${device.name}`)}
                    title={t('移除设备', 'Remove device')}
                    onClick={() => setDeviceToRemove(device)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                  <ActionMenu
                    items={[{
                      label: t('重新扫码绑定', 'Re-pair via QR'),
                      onSelect: () => void handleOpenPairing(device.deviceId),
                    }]}
                  />
                </div>
              </div>

              {/* 下属 Bot 列表：极简行，直显 Bot 名 + 当前真实生效模型名 */}
              <div className="ca-list">
                {devBots.length === 0 ? (
                  <div className="ca-empty">
                    {t('此设备暂无 Bot，点击上方「+ 新建 Bot」创建', 'No Bots on this device yet. Click "+ New Bot" above to create one.')}
                  </div>
                ) : (
                  devBots.map(bot => {
                    const modelDisp = botModelDisplay(bot);
                    return (
                      <div key={bot.botId} className="ca-row">
                        <div className="ca-row-main">
                          <div className="ca-row-title">
                            <span>{bot.name}</span>
                            {bot.isPrimary && <span className="ca-pill ca-pill-info">{t('主 Bot', 'Primary Bot')}</span>}
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
                            {t('配置', 'Configure')}
                          </button>
                          <ActionMenu
                            items={[
                              {
                                label: t('设为主 Bot', 'Set as Primary Bot'),
                                disabled: Boolean(bot.isPrimary),
                                onSelect: () => void handleBotMenuAction(bot, 'primary'),
                              },
                              {
                                label: t('归档 Bot', 'Archive Bot'),
                                onSelect: () => void handleBotMenuAction(bot, 'archive'),
                              },
                              {
                                label: t('删除 Bot', 'Delete Bot'),
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

      {/* 已归档 Bot 折叠区 */}
      {archivedBots.length > 0 && (
        <div className="ca-section-gap">
          <CaDisclosure title={t(`已归档 Bot (${archivedBots.length})`, `Archived Bots (${archivedBots.length})`)}>
            <section className="ca-section">
              <div className="ca-list">
                {archivedBots.map(bot => (
                  <div key={`${bot.deviceId}-${bot.botId}`} className="ca-row">
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <Archive size={14} aria-hidden="true" />
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
                        {t('恢复', 'Restore')}
                      </button>
                      <button
                        type="button"
                        className="ca-btn ca-btn-danger ca-btn-sm"
                        onClick={() => void handleBotMenuAction(bot, 'delete')}
                      >
                        {t('删除', 'Delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </CaDisclosure>
        </div>
      )}

      {deviceToRemove && (
        <RemoveDeviceDialog
          name={deviceToRemove.name}
          onClose={() => setDeviceToRemove(null)}
          onRemove={async () => {
            await api.deleteDevice(deviceToRemove.deviceId);
            setError('');
            setNotice(t(`已移除设备 ${deviceToRemove.name}`, `Removed device ${deviceToRemove.name}`));
            void loadAll().catch(err => setError(errorMessage(err, t('刷新设备目录失败', 'Failed to refresh device directory'))));
          }}
        />
      )}

      {/* 扫码添加 / 重绑设备弹窗（关闭时不核销配对码） */}
      <CaModal
        open={pairingModalOpen}
        onOpenChange={setPairingModalOpen}
        title={
          pendingPairing?.target
            ? t(`重新绑定设备 · ${pendingPairing.target.name}`, `Re-pair Device · ${pendingPairing.target.name}`)
            : t('扫码添加设备', 'Pair Device')
        }
        description={t('使用手机端或桌面端扫一扫 / 粘贴配对码即可完成绑定', 'Scan the QR code or paste the pairing code on mobile or desktop to pair')}
        variant="modal"
      >
        {pendingPairing ? (
          <div className="ca-form-stack ca-center-stack">
            <CaQrBox value={pendingPairing.code} label={t('设备配对二维码', 'Device pairing QR code')} renderQr={renderQr} />

            <div className="ca-muted ca-num">
              {t('有效期剩余 ', 'Expires in ')}
              <strong>{formatCountdown(pendingPairing.expiresAt, nowMs)}</strong>
              {pendingPairing.includesCa ? t(' · 已内嵌私有 CA 证书', ' · Private CA embedded') : ''}
            </div>

            <div className="ca-inline-row ca-wrap ca-justify-center">
              <CopyButton value={pendingPairing.code} label={t('复制配对码', 'Copy Code')} />
              <button
                type="button"
                className="ca-btn ca-btn-danger ca-btn-sm"
                onClick={() => void handleRevokePendingPairing()}
              >
                {t('作废此配对码', 'Revoke Code')}
              </button>
            </div>
            <p className="ca-field-help">
              {t('关闭此窗口不会作废配对码，可在设备页顶部状态条随时重新打开或作废。', 'Closing this window will not revoke the code. You can reopen or revoke it from the status bar at the top of the Devices tab.')}
            </p>
          </div>
        ) : (
          <div className="ca-empty">{t('正在生成配对码…', 'Generating pairing code…')}</div>
        )}
      </CaModal>

      {/* Private CA certificate drawer */}
      <CaModal
        open={caOpen}
        onOpenChange={open => {
          if (!open) setCaError('');
          setCaOpen(open);
        }}
        title={t('私有 CA 证书设置', 'Private CA Certificate Settings')}
        description={t('若中心使用自签或内网 HTTPS 证书，可在此配置信任根证书（新配对码将自动携带）', 'Configure a trusted root CA if the center uses a self-signed or private HTTPS certificate (embedded in new pairing codes)')}
        variant="drawer"
      >
        <div className="ca-form-stack">
          {caState && caState.certificates.length > 0 && (
            <div className="ca-cred-box">
              <div className="ca-field-label ca-mb-1">
                {t(`当前已解析证书 (${caState.certificates.length})`, `Parsed Certificates (${caState.certificates.length})`)}
              </div>
              {caState.certificates.map(cert => (
                <div key={cert.fingerprint256} className="ca-muted ca-mt-1">
                  <div>{cert.subject}</div>
                  <div className="ca-mono">
                    {t(`有效期至 ${formatTime(cert.validTo, locale)}`, `Valid until ${formatTime(cert.validTo, locale)}`)}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label">{t('PEM 根证书内容', 'PEM Root Certificate')}</label>
            <textarea
              rows={8}
              className="ca-textarea ca-mono"
              placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
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
              {t('清除证书', 'Clear Certificate')}
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              disabled={caBusy || !caDraft.trim()}
              onClick={() => void handleSaveCa(caDraft)}
            >
              <LabelStack
                active={caBusy ? t('保存中…', 'Saving…') : t('保存证书', 'Save Certificate')}
                labels={[t('保存证书', 'Save Certificate'), t('保存中…', 'Saving…')]}
              />
            </button>
          </div>
        </div>
      </CaModal>

      {/* Create Bot modal */}
      <CaModal
        open={Boolean(createBotDevice)}
        onOpenChange={open => {
          if (!open) {
            setCreateBotDevice(null);
            setCreateBotError('');
          }
        }}
        title={t(`在「${createBotDevice?.name ?? ''}」新建 Bot`, `New Bot on "${createBotDevice?.name ?? ''}"`)}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleCreateBot(e)}>
          <div className="ca-field">
            <label className="ca-field-label">
              {t('Bot 名称', 'Bot Name')} <span className="ca-req">*</span>
            </label>
            <input
              type="text"
              className="ca-input"
              required
              placeholder={t('例如：代码助手 / 运维助理', 'e.g. Coding Assistant / Ops Helper')}
              value={newBotRole}
              onChange={e => setNewBotRole(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">{t('模型选择', 'Model')}</label>
            <select
              className="ca-select"
              value={newBotModelRef}
              onChange={e => setNewBotModelRef(e.target.value)}
            >
              <option value="">{t(`跟随默认（${globalDefaultName}）`, `Follow default (${globalDefaultName})`)}</option>
              {sortedPickerModels.map(m => (
                <option key={m.modelRef} value={m.modelRef}>
                  {m.name} ({m.modelRef})
                </option>
              ))}
            </select>
          </div>

          <div className="ca-field">
            <label className="ca-field-label">{t('简介（可选）', 'Description (optional)')}</label>
            <input
              type="text"
              className="ca-input"
              placeholder={t('简述职责或定位', 'Briefly describe its role')}
              value={newBotDesc}
              onChange={e => setNewBotDesc(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">{t('工作目录 CWD（可选）', 'Working Directory CWD (optional)')}</label>
            <input
              type="text"
              className="ca-input ca-mono"
              placeholder={t('留空由设备端分配默认目录', 'Leave empty to use device default')}
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
            <span>{t('设为此设备主 Bot', 'Set as Primary Bot on this device')}</span>
          </label>

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setCreateBotDevice(null)}>
              {t('取消', 'Cancel')}
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={createBotBusy}>
              <LabelStack
                active={createBotBusy ? t('创建中…', 'Creating…') : t('创建 Bot', 'Create Bot')}
                labels={[t('创建 Bot', 'Create Bot'), t('创建中…', 'Creating…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Built-in Bot configuration drawer (used when onConfigureBot is not provided) */}
      <CaModal
        open={Boolean(cfgBot)}
        onOpenChange={open => {
          if (!open) {
            setCfgBot(null);
            setCfgError('');
            setCfgNotice('');
          }
        }}
        title={t(`配置 Bot · ${cfgBot?.name ?? ''}`, `Configure Bot · ${cfgBot?.name ?? ''}`)}
        description={cfgBot?.deviceName || cfgBot?.deviceId}
        variant="drawer"
        wide
      >
        {cfgBot && (
          <div className="ca-form-stack">
            <CaSegmented
              ariaLabel={t('Bot 配置分区', 'Bot configuration sections')}
              value={cfgTab}
              options={[
                { value: 'basic', label: t('模型与基础信息', 'Model & Profile') },
                { value: 'caps', label: t('技能与扩展', 'Skills & Extensions') },
                { value: 'learning', label: t('自主学习', 'Self-Learning') },
              ]}
              onChange={setCfgTab}
            />

            {cfgTab === 'basic' && (
              <div className="ca-form-stack">
                <div className="ca-section ca-section-pad">
                  <div className="ca-field-label ca-mb-2">
                    {t('模型配置（即点即存）', 'Model Selection (saves immediately)')}
                  </div>
                  <div className="ca-model-list ca-model-list-sm">
                    <button
                      type="button"
                      className={`ca-model-option ${!cfgModel?.overrides.modelRef ? 'is-selected' : ''}`}
                      disabled={cfgBusy}
                      onClick={() => void handleSetBotModel(null)}
                    >
                      <span>{t(`跟随全局默认（${globalDefaultName}）`, `Follow global default (${globalDefaultName})`)}</span>
                      {!cfgModel?.overrides.modelRef && <Check size={14} aria-hidden="true" />}
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
                          <span className="ca-model-option-main">
                            <span>{m.name}</span>
                            <span className="ca-muted ca-mono">{m.modelRef}</span>
                          </span>
                          {active && <Check size={14} aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="ca-section ca-section-pad">
                  <div className="ca-form-stack">
                    <div className="ca-grid-2">
                      <div className="ca-field">
                        <label className="ca-field-label">{t('Bot 名称', 'Bot Name')}</label>
                        <input
                          type="text"
                          className="ca-input"
                          value={cfgName}
                          onChange={e => setCfgName(e.target.value)}
                        />
                      </div>
                      <div className="ca-field">
                        <label className="ca-field-label">{t('简介', 'Description')}</label>
                        <input
                          type="text"
                          className="ca-input"
                          value={cfgDesc}
                          onChange={e => setCfgDesc(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="ca-field">
                      <label className="ca-field-label">
                        {t('工作目录 (CWD · 离线可修改，在线后自动同步)', 'Working Directory (CWD · editable offline, syncs when online)')}
                      </label>
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
                        {t('保存信息与目录', 'Save Profile & CWD')}
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
                    <div className="ca-empty">{t('中心暂无已安装的技能或工具扩展', 'No skills or extensions installed in center yet')}</div>
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
                            label={t(`为 ${cfgBot.name} 启用 ${entry.installation.displayName}`, `Enable ${entry.installation.displayName} for ${cfgBot.name}`)}
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
                  <div className="ca-empty">
                    {t('正在读取学习状态或当前 Bot 暂不支持自主学习…', 'Loading learning status, or this Bot does not support self-learning yet…')}
                  </div>
                ) : (
                  <>
                    <div className="ca-section ca-section-pad">
                      <div className="ca-inline-between">
                        <div>
                          <div className="ca-field-label">{t('自动反思', 'Automatic reflection')}</div>
                          <div className="ca-muted">
                            {t('Bot 空闲时自动复盘记忆并提炼技能', 'Review memories and extract skills when the Bot is idle')}
                          </div>
                        </div>
                        <CaSwitch
                          checked={cfgLearning.settings.review.enabled !== false}
                          disabled={cfgBusy}
                          label={t('自动反思', 'Automatic reflection')}
                          onChange={next => void handleToggleLearning(next)}
                        />
                      </div>
                      <div className="ca-inline-row ca-wrap ca-mt-3">
                        <button
                          type="button"
                          className="ca-btn ca-btn-primary ca-btn-sm"
                          disabled={cfgBusy}
                          onClick={() => void handleTriggerReview('review')}
                        >
                          {t('立即复盘', 'Review Now')}
                        </button>
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={cfgBusy}
                          onClick={() => void handleTriggerReview('curate')}
                        >
                          {t('整理记忆与技能', 'Curate Memory & Skills')}
                        </button>
                        {cfgLearning.lastJob && (
                          <span className="ca-muted">
                            {t(`最近任务：${cfgLearning.lastJob.mode} · ${cfgLearning.lastJob.status}`, `Last job: ${cfgLearning.lastJob.mode} · ${cfgLearning.lastJob.status}`)}
                          </span>
                        )}
                      </div>
                    </div>

                    <CaDisclosure title={t('高级学习周期参数', 'Advanced Learning Schedule')}>
                      <div className="ca-form-stack">
                        <div className="ca-grid-2">
                          <div className="ca-field">
                            <label className="ca-field-label">{t('记忆复盘间隔（轮次）', 'Memory review interval (turns)')}</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnMemoryEvery}
                              onChange={e => setLearnMemoryEvery(Number(e.target.value))}
                            />
                          </div>
                          <div className="ca-field">
                            <label className="ca-field-label">{t('技能提炼间隔（迭代）', 'Skill extraction interval (iterations)')}</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnSkillEvery}
                              onChange={e => setLearnSkillEvery(Number(e.target.value))}
                            />
                          </div>
                          <div className="ca-field">
                            <label className="ca-field-label">{t('整理周期（小时）', 'Curation interval (hours)')}</label>
                            <input
                              type="number"
                              className="ca-input ca-num"
                              value={learnIntervalHours}
                              onChange={e => setLearnIntervalHours(Number(e.target.value))}
                            />
                          </div>
                          <div className="ca-field">
                            <label className="ca-field-label">{t('最小空闲时间（小时）', 'Minimum idle time (hours)')}</label>
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
                            {t('保存高级参数', 'Save Advanced Settings')}
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

      <CaConfirmDialog
        open={Boolean(botToDelete)}
        title={t('删除 Bot', 'Delete Bot')}
        description={
          botToDelete
            ? t(`彻底删除 Bot「${botToDelete.name}」后将无法恢复，该 Bot 的配置与中心绑定将被永久清除。`, `Permanently deleting Bot "${botToDelete.name}" cannot be undone. Its settings and center bindings will be removed.`)
            : ''
        }
        confirmLabel={t('删除 Bot', 'Delete Bot')}
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={deletingBot}
        onCancel={() => {
          if (!deletingBot) setBotToDelete(null);
        }}
        onConfirm={() => void handleConfirmDeleteBot()}
      />
    </div>
  );
}
