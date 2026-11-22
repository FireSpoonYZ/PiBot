import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { Archive, ArrowLeft, Check, Pencil, Plus, QrCode, RefreshCw, X } from 'lucide-react';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
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
  botKey,
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
  DeviceRuntimeStatus,
  ModelPickerResponse,
  PairingCaState,
} from './types';

type TranslateFn = (zh: string, en: string) => string;

function formatRuntimeSummary(
  runtime: DeviceRuntimeStatus,
  t: TranslateFn,
): {
  text: string;
  pillTone: 'ok' | 'info' | 'warn' | 'danger' | 'muted';
  showPill: boolean;
  detailTitle?: string;
} {
  const rev = runtime.appliedRevision ?? runtime.desiredRevision;
  const capErrCount = runtime.capabilityErrors.length;
  const detailTitle =
    runtime.error?.message ||
    (capErrCount > 0
      ? runtime.capabilityErrors.map(e => `${e.botId}: ${e.error.code}`).join('; ')
      : undefined);

  switch (runtime.status) {
    case 'applied':
      if (capErrCount > 0) {
        return {
          text: t(`已同步 · ${capErrCount} 项能力异常`, `Synced · ${capErrCount} capability ${capErrCount === 1 ? 'error' : 'errors'}`),
          pillTone: 'warn',
          showPill: true,
          detailTitle,
        };
      }
      return {
        text: t(`配置已同步 (r${rev})`, `Config synced (r${rev})`),
        pillTone: 'ok',
        showPill: false,
        detailTitle,
      };
    case 'applying':
      return {
        text: t(`正在应用配置 (r${runtime.desiredRevision})`, `Applying config (r${runtime.desiredRevision})`),
        pillTone: 'info',
        showPill: true,
        detailTitle,
      };
    case 'waiting-idle':
      return {
        text: t(`等待空闲应用 (r${runtime.desiredRevision})`, `Waiting for idle (r${runtime.desiredRevision})`),
        pillTone: 'warn',
        showPill: true,
        detailTitle,
      };
    case 'failed':
      return {
        text: runtime.error?.code
          ? t(`配置应用失败 (${runtime.error.code})`, `Config apply failed (${runtime.error.code})`)
          : t('配置应用失败', 'Config apply failed'),
        pillTone: 'danger',
        showPill: true,
        detailTitle,
      };
    default:
      return {
        text: t(`配置待同步 (r${runtime.desiredRevision})`, `Sync pending (r${runtime.desiredRevision})`),
        pillTone: 'muted',
        showPill: false,
        detailTitle,
      };
  }
}

interface PendingPairingState {
  id: string;
  code: string;
  expiresAt: string;
  includesCa: boolean;
  target: { deviceId: string; name: string } | null;
}

type DevicesModal =
  | null
  | { kind: 'pairing' }
  | { kind: 'ca' }
  | { kind: 'create-bot'; device: CenterDevice }
  | { kind: 'remove-device'; device: CenterDevice }
  | { kind: 'delete-bot'; bot: CenterBotRef };

interface DevicesCacheData {
  devices: CenterDevice[];
  bots: CenterBotRef[];
  picker: ModelPickerResponse | null;
  pendingPairing: PendingPairingState | null;
  runtimeByDevice?: Record<string, DeviceRuntimeStatus>;
}

interface SavedBotProfileSnapshot {
  name: string;
  description: string;
  cwd: string;
}

interface SavedLearningScheduleSnapshot {
  memoryEvery: number;
  skillEvery: number;
  intervalHours: number;
  minIdleHours: number;
  staleAfterDays: number;
  archiveAfterDays: number;
  consolidate: boolean;
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
  const idPrefix = useId();

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
  const [runtimeByDevice, setRuntimeByDevice] = useState<Record<string, DeviceRuntimeStatus>>(
    () => initialCache?.runtimeByDevice ?? {},
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);
  const runtimeGenRef = useRef(0);
  const botEditorGenRef = useRef(0);

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

  // Unified mutually exclusive modal state (zero overlapping modals)
  const [activeModal, setActiveModal] = useState<DevicesModal>(null);

  // Inline device rename & device row busy state
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [deletingBot, setDeletingBot] = useState(false);
  const [deleteBotError, setDeleteBotError] = useState('');

  // Pairing code state (preserved across modal closes; never revoked on dismiss)
  const [pendingPairing, setPendingPairing] = useState<PendingPairingState | null>(() => {
    const cached = initialCache?.pendingPairing ?? null;
    if (cached && new Date(cached.expiresAt).getTime() > Date.now()) return cached;
    return null;
  });
  const [pairingBusy, setPairingBusy] = useState(false);

  // Private CA certificate modal state
  const [caState, setCaState] = useState<PairingCaState | null>(null);
  const [caDraft, setCaDraft] = useState('');
  const [caBusy, setCaBusy] = useState(false);
  const [caFormError, setCaFormError] = useState('');
  const [caFormNotice, setCaFormNotice] = useState('');

  // Create Bot modal state
  const [newBotRole, setNewBotRole] = useState('');
  const [newBotDesc, setNewBotDesc] = useState('');
  const [newBotCwd, setNewBotCwd] = useState('');
  const [newBotPrimary, setNewBotPrimary] = useState(false);
  const [newBotModelRef, setNewBotModelRef] = useState('');
  const [createBotBusy, setCreateBotBusy] = useState(false);
  const [createBotFormError, setCreateBotFormError] = useState('');

  // In-page Bot configuration sub-view (used when onConfigureBot is not supplied)
  const [cfgBot, setCfgBot] = useState<CenterBotRef | null>(null);
  const [cfgTab, setCfgTab] = useState<'basic' | 'caps' | 'learning'>('basic');
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgModelBusy, setCfgModelBusy] = useState(false);
  const [cfgProfileBusy, setCfgProfileBusy] = useState(false);
  const [cfgLearningBusy, setCfgLearningBusy] = useState(false);
  const [togglingCapId, setTogglingCapId] = useState<string | null>(null);
  const [cfgInlineError, setCfgInlineError] = useState('');
  const [cfgInlineNotice, setCfgInlineNotice] = useState('');
  const [cfgName, setCfgName] = useState('');
  const [cfgDesc, setCfgDesc] = useState('');
  const [cfgCwd, setCfgCwd] = useState('');
  const [cfgCwdRev, setCfgCwdRev] = useState(0);
  const [savedProfile, setSavedProfile] = useState<SavedBotProfileSnapshot>({
    name: '',
    description: '',
    cwd: '',
  });
  const [cfgModel, setCfgModel] = useState<BotModelConfig | null>(null);
  const [cfgCaps, setCfgCaps] = useState<BotCapabilityEntry[]>([]);
  const [cfgLearning, setCfgLearning] = useState<BotLearningStatus | null>(null);
  const [learnMemoryEvery, setLearnMemoryEvery] = useState(5);
  const [learnSkillEvery, setLearnSkillEvery] = useState(10);
  const [learnIntervalHours, setLearnIntervalHours] = useState(12);
  const [learnMinIdleHours, setLearnMinIdleHours] = useState(2);
  const [learnStaleAfterDays, setLearnStaleAfterDays] = useState(14);
  const [learnArchiveAfterDays, setLearnArchiveAfterDays] = useState(30);
  const [learnConsolidate, setLearnConsolidate] = useState(false);
  const [savedLearningSchedule, setSavedLearningSchedule] = useState<SavedLearningScheduleSnapshot>({
    memoryEvery: 5,
    skillEvery: 10,
    intervalHours: 12,
    minIdleHours: 2,
    staleAfterDays: 14,
    archiveAfterDays: 30,
    consolidate: false,
  });

  const refreshRuntimeStatuses = useCallback(
    async (deviceList: readonly CenterDevice[]) => {
      if (deviceList.length === 0) {
        runtimeGenRef.current += 1;
        setRuntimeByDevice({});
        return;
      }
      const gen = ++runtimeGenRef.current;
      const entries = await Promise.all(
        deviceList.map(d =>
          api
            .getDeviceRuntimeStatus(d.deviceId)
            .then(st => [d.deviceId, st] as const)
            .catch(() => null),
        ),
      );
      if (gen !== runtimeGenRef.current) return;
      setRuntimeByDevice(prev => {
        const next: Record<string, DeviceRuntimeStatus> = {};
        for (const d of deviceList) {
          if (prev[d.deviceId]) next[d.deviceId] = prev[d.deviceId];
        }
        for (const entry of entries) {
          if (entry) next[entry[0]] = entry[1];
        }
        return next;
      });
    },
    [api],
  );

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
    void refreshRuntimeStatuses(mergedDevices);

    // Sync first non-expired active pairing code if we do not already have a newer one with full code text
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
  }, [api, cacheKey, clearNotice, refreshRuntimeStatuses]);

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll();
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const msg = errorMessage(err, t('加载设备与 Bot 失败，请重试', 'Failed to load devices and Bots. Please try again.'));
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
      runtimeGenRef.current += 1;
      botEditorGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<DevicesCacheData>(cacheKey, 'devices', {
      devices,
      bots,
      picker,
      pendingPairing,
      runtimeByDevice,
    });
  }, [bots, cacheKey, devices, hasLoaded, pendingPairing, picker, runtimeByDevice]);

  const hasInFlightRuntime = useMemo(
    () =>
      devices.some(d => {
        const st = runtimeByDevice[d.deviceId]?.status;
        return st === 'pending' || st === 'applying' || st === 'waiting-idle';
      }),
    [devices, runtimeByDevice],
  );

  // Active-tab device runtime status polling (paused when tab is hidden)
  useEffect(() => {
    if (!active || devices.length === 0) return;
    const intervalMs = hasInFlightRuntime ? 3000 : 15000;
    const timer = window.setInterval(() => {
      void refreshRuntimeStatuses(devicesRef.current);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, devices.length, hasInFlightRuntime, refreshRuntimeStatuses]);

  // Poll active learning job status while viewing the Bot learning section
  const activeLearningJobId = cfgLearning?.activeJob?.jobId ?? null;
  useEffect(() => {
    if (!active || !cfgBot || cfgTab !== 'learning' || !activeLearningJobId) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    const timer = window.setInterval(() => {
      void api
        .getBotLearningStatus(targetDeviceId, targetBotId)
        .then(refreshed => {
          if (botEditorGenRef.current !== gen) return;
          setCfgLearning(refreshed);
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [active, activeLearningJobId, api, cfgBot, cfgTab]);

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
            setActiveModal(prev => (prev?.kind === 'pairing' ? null : prev));
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

  // Clear expired local pairing banner
  useEffect(() => {
    if (pendingPairing && new Date(pendingPairing.expiresAt).getTime() <= nowMs) {
      setPendingPairing(null);
    }
  }, [nowMs, pendingPairing]);

  const closeBuiltinBotConfig = useCallback(() => {
    botEditorGenRef.current += 1;
    setCfgBot(null);
    setCfgLoading(false);
    setCfgProfileBusy(false);
    setCfgModelBusy(false);
    setCfgLearningBusy(false);
    setTogglingCapId(null);
    setCfgInlineError('');
    setCfgInlineNotice('');
  }, []);

  useEffect(() => {
    if (!active || !cfgBot) return;
    return registerOverlayBackHandler(() => {
      closeBuiltinBotConfig();
    });
  }, [active, cfgBot, closeBuiltinBotConfig]);

  const handleOpenPairing = async (targetDeviceId?: string) => {
    // Reuse existing pending code if it matches the same target and has > 15s remaining
    if (
      pendingPairing &&
      (pendingPairing.target?.deviceId ?? undefined) === targetDeviceId &&
      new Date(pendingPairing.expiresAt).getTime() - Date.now() > 15_000
    ) {
      setActiveModal({ kind: 'pairing' });
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
      setActiveModal({ kind: 'pairing' });
    } catch (err) {
      setError(errorMessage(err, t('生成配对码失败，请检查中心连接后重试', 'Failed to generate pairing code. Check center connectivity and try again.')));
    } finally {
      setPairingBusy(false);
    }
  };

  const handleRevokePendingPairing = async () => {
    if (!pendingPairing) return;
    const targetId = pendingPairing.id;
    setPendingPairing(null);
    setActiveModal(prev => (prev?.kind === 'pairing' ? null : prev));
    try {
      await api.revokePairingCode(targetId);
      setNotice(t('已作废待用配对码', 'Pending pairing code revoked'));
    } catch (err) {
      setError(errorMessage(err, t('作废配对码失败，请重试', 'Failed to revoke pairing code. Please retry.')));
    }
  };

  // Private CA certificate settings
  const openCaDrawer = () => {
    setCaFormError('');
    setCaFormNotice('');
    setActiveModal({ kind: 'ca' });
    void api
      .getPairingCa()
      .then(st => {
        setCaState(st);
        setCaDraft(st.ca ?? '');
      })
      .catch(err => setCaFormError(errorMessage(err, t('读取证书配置失败，请关闭重试', 'Failed to load certificate settings. Close and try again.'))));
  };

  const handleSaveCa = async (nextCa: string | null) => {
    setCaBusy(true);
    setCaFormError('');
    setCaFormNotice('');
    try {
      const updated = await api.putPairingCa(nextCa);
      setCaState(updated);
      setCaDraft(updated.ca ?? '');
      const msg = nextCa
        ? t('私有 CA 证书已保存，新生成的配对码将自动携带', 'Private CA certificate saved; new pairing codes will embed it automatically')
        : t('已清除私有 CA 证书', 'Private CA certificate cleared');
      setCaFormNotice(msg);
      setNotice(msg);
    } catch (err) {
      setCaFormError(
        errorMessage(err, t('保存证书失败，请检查 PEM 证书格式后重试', 'Failed to save certificate. Verify the PEM format and try again.')),
      );
    } finally {
      setCaBusy(false);
    }
  };

  // Device controls
  const handleSaveDeviceRename = async (device: CenterDevice) => {
    const trimmed = renameDraft.trim();
    if (!trimmed || renamingBusy) return;
    setRenamingBusy(true);
    setError('');
    try {
      const updated = await api.renameDevice(device.deviceId, trimmed);
      setDevices(prev => prev.map(d => (d.deviceId === updated.deviceId ? { ...d, ...updated } : d)));
      setRenamingDeviceId(null);
    } catch (err) {
      setError(errorMessage(err, t('重命名设备失败，请重试', 'Failed to rename device. Please try again.')));
    } finally {
      setRenamingBusy(false);
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
      setError(errorMessage(err, t('切换中心管理权限失败，请重试', 'Failed to update center admin access. Please try again.')));
    } finally {
      setOauthBusyId(null);
    }
  };

  const openCreateBotModal = (device: CenterDevice) => {
    setNewBotRole('');
    setNewBotDesc('');
    setNewBotCwd('');
    setNewBotPrimary(false);
    setNewBotModelRef('');
    setCreateBotFormError('');
    setActiveModal({ kind: 'create-bot', device });
  };

  // Bot actions
  const handleCreateBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (activeModal?.kind !== 'create-bot') return;
    const targetDevice = activeModal.device;
    const role = newBotRole.trim();
    if (!role) {
      setCreateBotFormError(t('请填写 Bot 名称后再创建', 'Enter a Bot name before creating'));
      return;
    }
    setCreateBotBusy(true);
    setCreateBotFormError('');
    try {
      const created = await api.createBot(targetDevice.deviceId, {
        role,
        ...(newBotDesc.trim() ? { description: newBotDesc.trim() } : {}),
        ...(newBotCwd.trim() ? { cwd: newBotCwd.trim() } : {}),
        makePrimary: newBotPrimary,
      });
      if (newBotModelRef) {
        const currentCfg = await api.getBotModelConfig(targetDevice.deviceId, created.botId);
        await api.putBotModelConfig(targetDevice.deviceId, created.botId, {
          expectedRevision: currentCfg.revision,
          value: { modelRef: newBotModelRef },
        });
      }
      setActiveModal(null);
      setNewBotRole('');
      setNewBotDesc('');
      setNewBotCwd('');
      setNewBotPrimary(false);
      setNewBotModelRef('');
      await loadAll();
      setNotice(t(`已创建 Bot「${created.name}」`, `Created Bot "${created.name}"`));
    } catch (err) {
      setCreateBotFormError(
        errorMessage(err, t('创建 Bot 失败，请检查名称与设备状态后重试', 'Failed to create Bot. Check the name and device status, then try again.')),
      );
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
        setDeleteBotError('');
        setActiveModal({ kind: 'delete-bot', bot });
        return;
      }
      await loadAll();
    } catch (err) {
      setError(errorMessage(err, t('操作 Bot 失败，请重试', 'Bot operation failed. Please try again.')));
    }
  };

  const handleConfirmDeleteBot = async () => {
    if (activeModal?.kind !== 'delete-bot') return;
    const target = activeModal.bot;
    setDeletingBot(true);
    setDeleteBotError('');
    try {
      await api.deleteBot(target.deviceId, target.botId);
      setActiveModal(null);
      setNotice(t(`已删除「${target.name}」`, `Deleted "${target.name}"`));
      await loadAll();
    } catch (err) {
      setDeleteBotError(errorMessage(err, t('删除 Bot 失败，请稍后重试', 'Failed to delete Bot. Please try again.')));
    } finally {
      setDeletingBot(false);
    }
  };

  // In-page Bot configuration sub-view
  const openBuiltinBotConfig = async (bot: CenterBotRef) => {
    const gen = ++botEditorGenRef.current;
    setActiveModal(null);
    setCfgBot(bot);
    setCfgTab('basic');
    setCfgProfileBusy(false);
    setCfgModelBusy(false);
    setCfgLearningBusy(false);
    setTogglingCapId(null);
    setCfgInlineError('');
    setCfgInlineNotice('');
    const initName = bot.name;
    const initDesc = bot.description ?? '';
    const initCwd = bot.cwd ?? '';
    setCfgName(initName);
    setCfgDesc(initDesc);
    setCfgCwd(initCwd);
    setCfgCwdRev(bot.cwdRevision ?? 0);
    setSavedProfile({ name: initName, description: initDesc, cwd: initCwd });
    setCfgModel(null);
    setCfgCaps([]);
    setCfgLearning(null);
    setCfgLoading(true);
    try {
      const [modelCfg, cwdCfg, capsList, learningRes] = await Promise.all([
        api.getBotModelConfig(bot.deviceId, bot.botId).catch(() => null),
        api.getBotCwd(bot.deviceId, bot.botId).catch(() => null),
        api.listBotCapabilities(bot.deviceId, bot.botId).catch(() => [] as BotCapabilityEntry[]),
        api.getBotLearningStatus(bot.deviceId, bot.botId).catch(() => null),
      ]);
      if (gen !== botEditorGenRef.current) return;
      if (modelCfg) setCfgModel(modelCfg);
      if (cwdCfg) {
        const nextCwd = cwdCfg.value ?? '';
        setCfgCwd(nextCwd);
        setCfgCwdRev(cwdCfg.revision);
        setSavedProfile(prev => ({ ...prev, cwd: nextCwd }));
      }
      setCfgCaps(capsList);
      if (learningRes) {
        setCfgLearning(learningRes);
        const snap: SavedLearningScheduleSnapshot = {
          memoryEvery: learningRes.settings.review.memoryEvery,
          skillEvery: learningRes.settings.review.skillEvery,
          intervalHours: learningRes.settings.curator.intervalHours,
          minIdleHours: learningRes.settings.curator.minIdleHours,
          staleAfterDays: learningRes.settings.curator.staleAfterDays,
          archiveAfterDays: learningRes.settings.curator.archiveAfterDays,
          consolidate: Boolean(learningRes.settings.curator.consolidate),
        };
        setLearnMemoryEvery(snap.memoryEvery);
        setLearnSkillEvery(snap.skillEvery);
        setLearnIntervalHours(snap.intervalHours);
        setLearnMinIdleHours(snap.minIdleHours);
        setLearnStaleAfterDays(snap.staleAfterDays);
        setLearnArchiveAfterDays(snap.archiveAfterDays);
        setLearnConsolidate(snap.consolidate);
        setSavedLearningSchedule(snap);
      }
    } catch (err) {
      if (gen !== botEditorGenRef.current) return;
      setCfgInlineError(errorMessage(err, t('读取 Bot 配置失败，请返回重试', 'Failed to load Bot settings. Return and try again.')));
    } finally {
      if (gen === botEditorGenRef.current) setCfgLoading(false);
    }
  };

  const handleSetBotModel = async (modelRef: string | null) => {
    if (!cfgBot || !cfgModel) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    setCfgModelBusy(true);
    setCfgInlineError('');
    setCfgInlineNotice('');
    try {
      const nextOverrides = { ...cfgModel.overrides };
      if (modelRef) nextOverrides.modelRef = modelRef;
      else delete nextOverrides.modelRef;
      const updated = await api.putBotModelConfig(targetDeviceId, targetBotId, {
        expectedRevision: cfgModel.revision,
        value: nextOverrides,
      });
      if (botEditorGenRef.current === gen) {
        setCfgModel(updated);
        setCfgInlineNotice(
          modelRef
            ? t('已切换专属模型', 'Switched to dedicated model')
            : t('已设为跟随全局默认模型', 'Set to follow global default model'),
        );
      }
      await loadAll();
    } catch (err) {
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(errorMessage(err, t('保存模型设置失败，请重试', 'Failed to save model settings. Please try again.')));
      }
    } finally {
      if (botEditorGenRef.current === gen) setCfgModelBusy(false);
    }
  };

  const handleDiscardProfileChanges = () => {
    setCfgName(savedProfile.name);
    setCfgDesc(savedProfile.description);
    setCfgCwd(savedProfile.cwd);
    setCfgInlineError('');
  };

  const handleSaveBotProfileAndCwd = async () => {
    if (!cfgBot) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const targetBotKey = botKey(targetDeviceId, targetBotId);
    const gen = botEditorGenRef.current;
    const trimmedName = cfgName.trim() || cfgBot.name;
    const trimmedDesc = cfgDesc.trim();
    const trimmedCwd = cfgCwd.trim();
    const initialSavedCwd = savedProfile.cwd;
    const initialCwdRev = cfgCwdRev;

    setCfgProfileBusy(true);
    setCfgInlineError('');
    setCfgInlineNotice('');
    let profileSaved = false;
    try {
      await api.updateBot(targetDeviceId, targetBotId, {
        name: trimmedName,
        description: trimmedDesc,
      });
      profileSaved = true;
      let resolvedCwd = initialSavedCwd;
      if (trimmedCwd) {
        const nextCwd = await api.putBotCwd(targetDeviceId, targetBotId, {
          expectedRevision: initialCwdRev,
          value: trimmedCwd,
        });
        resolvedCwd = nextCwd.value ?? '';
        if (botEditorGenRef.current === gen) {
          setCfgCwd(resolvedCwd);
          setCfgCwdRev(nextCwd.revision);
        }
      }
      if (botEditorGenRef.current === gen) {
        setCfgName(trimmedName);
        setCfgDesc(trimmedDesc);
        setSavedProfile({ name: trimmedName, description: trimmedDesc, cwd: resolvedCwd });
        setCfgBot(prev =>
          prev && botKey(prev.deviceId, prev.botId) === targetBotKey
            ? { ...prev, name: trimmedName, description: trimmedDesc, cwd: resolvedCwd }
            : prev,
        );
      }
      await loadAll();
      if (botEditorGenRef.current === gen) {
        setCfgInlineNotice(t('基础信息与工作目录已保存', 'Profile and working directory saved'));
      }
    } catch (err) {
      if (profileSaved) {
        void loadAll().catch(() => {});
      }
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(
          errorMessage(err, t('保存基础信息或工作目录失败，请核对后重试', 'Failed to save profile or working directory. Check the inputs and try again.')),
        );
      }
    } finally {
      if (botEditorGenRef.current === gen) {
        setCfgProfileBusy(false);
      }
    }
  };

  const handleToggleBotCap = async (entry: BotCapabilityEntry, nextEnabled: boolean) => {
    if (!cfgBot) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    setTogglingCapId(entry.installation.installationId);
    setCfgInlineError('');
    try {
      const updated = await api.putBotCapability(
        targetDeviceId,
        targetBotId,
        entry.installation.installationId,
        {
          expectedRevision: entry.config.revision,
          enabled: nextEnabled,
          overrides: entry.config.overrides,
        },
      );
      if (botEditorGenRef.current === gen) {
        setCfgCaps(prev =>
          prev.map(item =>
            item.installation.installationId === entry.installation.installationId
              ? { ...item, config: updated }
              : item,
          ),
        );
      }
    } catch (err) {
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(errorMessage(err, t('切换能力授权失败，请重试', 'Failed to update capability authorization. Please retry.')));
      }
    } finally {
      if (botEditorGenRef.current === gen) setTogglingCapId(null);
    }
  };

  const handleToggleLearning = async (nextEnabled: boolean) => {
    if (!cfgBot || !cfgLearning) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    setCfgLearningBusy(true);
    setCfgInlineError('');
    setCfgInlineNotice('');
    try {
      const res = await api.configureBotLearning(targetDeviceId, targetBotId, cfgLearning.settings.revision, {
        review: { enabled: nextEnabled },
      });
      if (botEditorGenRef.current !== gen) return;
      setCfgLearning(prev =>
        prev?.deviceId === targetDeviceId && prev.botId === targetBotId
          ? { ...prev, settings: res.settings }
          : prev,
      );
      setCfgInlineNotice(
        nextEnabled
          ? t('已开启自动反思', 'Automatic reflection enabled')
          : t('已关闭自动反思', 'Automatic reflection disabled'),
      );
    } catch (err) {
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(errorMessage(err, t('更新自动反思设置失败，请重试', 'Failed to update automatic reflection. Please try again.')));
      }
    } finally {
      if (botEditorGenRef.current === gen) setCfgLearningBusy(false);
    }
  };

  const handleTriggerReview = async (mode: 'review' | 'curate') => {
    if (!cfgBot) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    setCfgLearningBusy(true);
    setCfgInlineError('');
    setCfgInlineNotice('');
    try {
      const res = await api.triggerBotLearning(targetDeviceId, targetBotId, mode);
      const refreshed = await api.getBotLearningStatus(targetDeviceId, targetBotId).catch(() => null);
      if (botEditorGenRef.current !== gen) return;
      if (refreshed) setCfgLearning(refreshed);
      setCfgInlineNotice(
        res.reason ||
          (mode === 'review'
            ? t('已提交复盘任务', 'Review task submitted')
            : t('已提交整理任务', 'Curate task submitted')),
      );
    } catch (err) {
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(errorMessage(err, t('触发学习任务失败，请确认 Bot 在线后重试', 'Failed to trigger learning task. Verify the Bot is online and retry.')));
      }
    } finally {
      if (botEditorGenRef.current === gen) setCfgLearningBusy(false);
    }
  };

  const handleCancelLearningJob = async (jobId: string) => {
    if (!cfgBot || !jobId) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    setCfgLearningBusy(true);
    setCfgInlineError('');
    setCfgInlineNotice('');
    try {
      await api.cancelBotLearning(targetDeviceId, targetBotId, jobId);
      const refreshed = await api.getBotLearningStatus(targetDeviceId, targetBotId).catch(() => null);
      if (botEditorGenRef.current !== gen) return;
      if (refreshed) setCfgLearning(refreshed);
      setCfgInlineNotice(t('已请求取消学习任务', 'Cancellation requested for learning job'));
    } catch (err) {
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(errorMessage(err, t('取消学习任务失败，请刷新后重试', 'Failed to cancel learning job. Refresh and retry.')));
      }
    } finally {
      if (botEditorGenRef.current === gen) setCfgLearningBusy(false);
    }
  };

  const handleDiscardLearningSchedule = () => {
    setLearnMemoryEvery(savedLearningSchedule.memoryEvery);
    setLearnSkillEvery(savedLearningSchedule.skillEvery);
    setLearnIntervalHours(savedLearningSchedule.intervalHours);
    setLearnMinIdleHours(savedLearningSchedule.minIdleHours);
    setLearnStaleAfterDays(savedLearningSchedule.staleAfterDays);
    setLearnArchiveAfterDays(savedLearningSchedule.archiveAfterDays);
    setLearnConsolidate(savedLearningSchedule.consolidate);
    setCfgInlineError('');
  };

  const handleSaveLearningAdvanced = async () => {
    if (!cfgBot || !cfgLearning) return;
    const targetDeviceId = cfgBot.deviceId;
    const targetBotId = cfgBot.botId;
    const gen = botEditorGenRef.current;
    const nextMemoryEvery = Math.max(1, Math.round(Number(learnMemoryEvery) || 5));
    const nextSkillEvery = Math.max(1, Math.round(Number(learnSkillEvery) || 10));
    const nextIntervalHours = Math.max(1, Math.round(Number(learnIntervalHours) || 12));
    const parsedMinIdle = Number(learnMinIdleHours);
    const nextMinIdleHours = Number.isFinite(parsedMinIdle) && parsedMinIdle >= 0 ? parsedMinIdle : 2;
    const nextStaleAfterDays = Math.max(1, Math.round(Number(learnStaleAfterDays) || 14));
    const nextArchiveAfterDays = Math.max(1, Math.round(Number(learnArchiveAfterDays) || 30));
    const nextConsolidate = Boolean(learnConsolidate);

    setCfgLearningBusy(true);
    setCfgInlineError('');
    setCfgInlineNotice('');
    try {
      const res = await api.configureBotLearning(targetDeviceId, targetBotId, cfgLearning.settings.revision, {
        review: { memoryEvery: nextMemoryEvery, skillEvery: nextSkillEvery },
        curator: {
          intervalHours: nextIntervalHours,
          minIdleHours: nextMinIdleHours,
          staleAfterDays: nextStaleAfterDays,
          archiveAfterDays: nextArchiveAfterDays,
          consolidate: nextConsolidate,
        },
      });
      if (botEditorGenRef.current !== gen) return;
      setCfgLearning(prev => (prev ? { ...prev, settings: res.settings } : prev));
      const snap: SavedLearningScheduleSnapshot = {
        memoryEvery: res.settings.review.memoryEvery,
        skillEvery: res.settings.review.skillEvery,
        intervalHours: res.settings.curator.intervalHours,
        minIdleHours: res.settings.curator.minIdleHours,
        staleAfterDays: res.settings.curator.staleAfterDays,
        archiveAfterDays: res.settings.curator.archiveAfterDays,
        consolidate: Boolean(res.settings.curator.consolidate),
      };
      setLearnMemoryEvery(snap.memoryEvery);
      setLearnSkillEvery(snap.skillEvery);
      setLearnIntervalHours(snap.intervalHours);
      setLearnMinIdleHours(snap.minIdleHours);
      setLearnStaleAfterDays(snap.staleAfterDays);
      setLearnArchiveAfterDays(snap.archiveAfterDays);
      setLearnConsolidate(snap.consolidate);
      setSavedLearningSchedule(snap);
      setCfgInlineNotice(t('学习周期与整理参数已保存', 'Learning schedule and curator settings saved'));
    } catch (err) {
      if (botEditorGenRef.current === gen) {
        setCfgInlineError(errorMessage(err, t('保存学习参数失败，请检查数值后重试', 'Failed to save learning parameters. Check the values and try again.')));
      }
    } finally {
      if (botEditorGenRef.current === gen) setCfgLearningBusy(false);
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

  const renderBotConfigSubView = () => {
    if (!cfgBot) return null;

    const liveBot = bots.find(b => b.deviceId === cfgBot.deviceId && b.botId === cfgBot.botId) ?? cfgBot;
    const ownerDevice = devices.find(d => d.deviceId === liveBot.deviceId);
    const botOnline = Boolean(liveBot.online ?? ownerDevice?.online);
    const currentEffectiveModel = cfgModel?.overrides.modelRef
      ? picker?.models.find(m => m.modelRef === cfgModel.overrides.modelRef)?.name || cfgModel.overrides.modelRef
      : botModelDisplay(liveBot).label;
    const profileDirty =
      cfgName !== savedProfile.name ||
      cfgDesc !== savedProfile.description ||
      cfgCwd !== savedProfile.cwd;
    const learningDirty =
      Number(learnMemoryEvery) !== savedLearningSchedule.memoryEvery ||
      Number(learnSkillEvery) !== savedLearningSchedule.skillEvery ||
      Number(learnIntervalHours) !== savedLearningSchedule.intervalHours ||
      Number(learnMinIdleHours) !== savedLearningSchedule.minIdleHours ||
      Number(learnStaleAfterDays) !== savedLearningSchedule.staleAfterDays ||
      Number(learnArchiveAfterDays) !== savedLearningSchedule.archiveAfterDays ||
      learnConsolidate !== savedLearningSchedule.consolidate;

    return (
      <div className="ca-form-stack">
        {/* Sub-view header bar */}
        <div className="ca-toolbar">
          <button
            type="button"
            className="ca-btn ca-btn-ghost ca-btn-sm"
            onClick={closeBuiltinBotConfig}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            <span>{t('返回设备列表', 'Back to Devices')}</span>
          </button>
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
        </div>

        {/* Bot Live Readiness summary */}
        <section className="ca-section">
          <div className="ca-default-card">
            <div className="ca-row-main">
              <div className="ca-row-title">
                <span className={`ca-dot ${botOnline ? 'is-online' : ''}`} aria-hidden="true" />
                <span>{liveBot.name}</span>
                {liveBot.isPrimary && <span className="ca-pill ca-pill-info">{t('主 Bot', 'Primary')}</span>}
              </div>
              <div className="ca-row-sub ca-num">
                {`${ownerDevice?.name || liveBot.deviceName || liveBot.deviceId} · ${currentEffectiveModel}`}
              </div>
            </div>
          </div>
        </section>

        {cfgInlineError && <CaNotice tone="danger">{cfgInlineError}</CaNotice>}
        {cfgInlineNotice && <CaNotice tone="ok">{cfgInlineNotice}</CaNotice>}

        {cfgLoading ? (
          <CaSectionSkeleton rows={3} headWidth={140} trailingWidth={88} label={t('正在加载 Bot 配置…', 'Loading Bot settings…')} />
        ) : (
          <>
            {cfgTab === 'basic' && (
              <>
                <section className="ca-section">
                  <div className="ca-section-head">
                    <h3 className="ca-section-title">{t('模型配置', 'Model selection')}</h3>
                    <span className="ca-muted">
                      {cfgModelBusy ? t('保存中…', 'Saving…') : t('点击即保存', 'Saves immediately')}
                    </span>
                  </div>
                  <div className="ca-section-body">
                    <div className="ca-model-list ca-model-list-sm">
                      <button
                        type="button"
                        className={`ca-model-option ${!cfgModel?.overrides.modelRef ? 'is-selected' : ''}`}
                        disabled={cfgModelBusy || !cfgModel}
                        onClick={() => void handleSetBotModel(null)}
                      >
                        <span>{t(`跟随全局默认（${globalDefaultName}）`, `Follow global default (${globalDefaultName})`)}</span>
                        {!cfgModel?.overrides.modelRef && <Check size={14} aria-hidden="true" />}
                      </button>
                      {sortedPickerModels.map(m => {
                        const selected = cfgModel?.overrides.modelRef === m.modelRef;
                        return (
                          <button
                            key={m.modelRef}
                            type="button"
                            className={`ca-model-option ${selected ? 'is-selected' : ''}`}
                            disabled={cfgModelBusy || !cfgModel}
                            onClick={() => void handleSetBotModel(m.modelRef)}
                          >
                            <span className="ca-model-option-main">
                              <span>{m.name}</span>
                              <span className="ca-muted ca-mono">{m.modelRef}</span>
                            </span>
                            {selected && <Check size={14} aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

                <section className="ca-section">
                  <div className="ca-section-head">
                    <h3 className="ca-section-title">{t('基础信息与工作目录', 'Profile & working directory')}</h3>
                  </div>
                  <div className="ca-section-body ca-form-stack">
                    <div className="ca-grid-2">
                      <div className="ca-field">
                        <label className="ca-field-label" htmlFor={`${idPrefix}-bot-name`}>{t('Bot 名称', 'Bot Name')}</label>
                        <input
                          id={`${idPrefix}-bot-name`}
                          type="text"
                          className="ca-input"
                          disabled={cfgProfileBusy}
                          value={cfgName}
                          onChange={e => setCfgName(e.target.value)}
                        />
                      </div>
                      <div className="ca-field">
                        <label className="ca-field-label" htmlFor={`${idPrefix}-bot-desc`}>{t('简介', 'Description')}</label>
                        <input
                          id={`${idPrefix}-bot-desc`}
                          type="text"
                          className="ca-input"
                          disabled={cfgProfileBusy}
                          value={cfgDesc}
                          onChange={e => setCfgDesc(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="ca-field">
                      <label className="ca-field-label" htmlFor={`${idPrefix}-bot-cwd`}>
                        {t('工作目录 (CWD · 离线可修改，在线后自动同步)', 'Working Directory (CWD · editable offline, syncs when online)')}
                      </label>
                      <input
                        id={`${idPrefix}-bot-cwd`}
                        type="text"
                        className="ca-input ca-mono"
                        disabled={cfgProfileBusy}
                        placeholder="/path/to/workspace"
                        value={cfgCwd}
                        onChange={e => setCfgCwd(e.target.value)}
                      />
                    </div>

                    <div className="ca-form-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        disabled={cfgProfileBusy || !profileDirty}
                        onClick={handleDiscardProfileChanges}
                      >
                        {t('还原更改', 'Discard changes')}
                      </button>
                      <button
                        type="button"
                        className="ca-btn ca-btn-primary ca-btn-sm"
                        disabled={cfgProfileBusy || !profileDirty}
                        onClick={() => void handleSaveBotProfileAndCwd()}
                      >
                        <LabelStack
                          active={cfgProfileBusy ? t('保存中…', 'Saving…') : t('保存信息与目录', 'Save Profile & CWD')}
                          labels={[t('保存信息与目录', 'Save Profile & CWD'), t('保存中…', 'Saving…')]}
                        />
                      </button>
                    </div>
                  </div>
                </section>
              </>
            )}

            {cfgTab === 'caps' && (
              <section className="ca-section">
                <div className="ca-section-head">
                  <h3 className="ca-section-title">{t('技能与扩展授权', 'Skills & extensions')}</h3>
                </div>
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
                            disabled={togglingCapId === entry.installation.installationId}
                            label={t(`为 ${liveBot.name} 启用 ${entry.installation.displayName}`, `Enable ${entry.installation.displayName} for ${liveBot.name}`)}
                            onChange={next => void handleToggleBotCap(entry, next)}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            )}

            {cfgTab === 'learning' && (
              <section className="ca-section">
                {!cfgLearning ? (
                  <div className="ca-empty">
                    {t('当前 Bot 暂不支持自主学习或未能读取学习状态', 'This Bot does not support self-learning yet, or status is unavailable')}
                  </div>
                ) : (
                  <>
                    <div className="ca-section-head">
                      <div>
                        <h3 className="ca-section-title">{t('自动反思', 'Automatic reflection')}</h3>
                        <div className="ca-muted">
                          {t('Bot 空闲时自动复盘记忆并提炼技能', 'Review memories and extract skills when the Bot is idle')}
                        </div>
                      </div>
                      <CaSwitch
                        checked={cfgLearning.settings.review.enabled !== false}
                        disabled={cfgLearningBusy}
                        label={t('自动反思', 'Automatic reflection')}
                        onChange={next => void handleToggleLearning(next)}
                      />
                    </div>
                    <div className="ca-section-body ca-form-stack">
                      <div className="ca-inline-row ca-wrap">
                        <button
                          type="button"
                          className="ca-btn ca-btn-primary ca-btn-sm"
                          disabled={cfgLearningBusy}
                          onClick={() => void handleTriggerReview('review')}
                        >
                          {t('立即复盘', 'Review Now')}
                        </button>
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={cfgLearningBusy}
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

                      {cfgLearning.activeJob && (
                        <div className="ca-cred-box ca-inline-between ca-wrap">
                          <div className="ca-inline-row">
                            <span className="ca-pill ca-pill-info">{cfgLearning.activeJob.status}</span>
                            <span className="ca-muted">
                              {t(`进行中任务：${cfgLearning.activeJob.mode} (${cfgLearning.activeJob.jobId.slice(0, 8)})`, `Active job: ${cfgLearning.activeJob.mode} (${cfgLearning.activeJob.jobId.slice(0, 8)})`)}
                            </span>
                          </div>
                          {(cfgLearning.activeJob.status === 'running' || cfgLearning.activeJob.status === 'queued') && (
                            <button
                              type="button"
                              className="ca-btn ca-btn-danger ca-btn-sm"
                              disabled={cfgLearningBusy}
                              onClick={() => void handleCancelLearningJob(cfgLearning.activeJob!.jobId)}
                            >
                              {t('取消学习任务', 'Cancel job')}
                            </button>
                          )}
                        </div>
                      )}

                      <CaDisclosure title={t('高级学习周期与整理参数', 'Advanced Learning & Curator Settings')}>
                        <div className="ca-form-stack">
                          <div className="ca-grid-2">
                            <div className="ca-field">
                              <label className="ca-field-label" htmlFor={`${idPrefix}-learn-memory-every`}>
                                {t('记忆复盘间隔（轮次）', 'Memory review interval (turns)')}
                              </label>
                              <input
                                id={`${idPrefix}-learn-memory-every`}
                                type="number"
                                min={1}
                                className="ca-input ca-num"
                                disabled={cfgLearningBusy}
                                value={learnMemoryEvery}
                                onChange={e => setLearnMemoryEvery(Number(e.target.value))}
                              />
                            </div>
                            <div className="ca-field">
                              <label className="ca-field-label" htmlFor={`${idPrefix}-learn-skill-every`}>
                                {t('技能提炼间隔（迭代）', 'Skill extraction interval (iterations)')}
                              </label>
                              <input
                                id={`${idPrefix}-learn-skill-every`}
                                type="number"
                                min={1}
                                className="ca-input ca-num"
                                disabled={cfgLearningBusy}
                                value={learnSkillEvery}
                                onChange={e => setLearnSkillEvery(Number(e.target.value))}
                              />
                            </div>
                            <div className="ca-field">
                              <label className="ca-field-label" htmlFor={`${idPrefix}-learn-interval-hours`}>
                                {t('整理周期（小时）', 'Curation interval (hours)')}
                              </label>
                              <input
                                id={`${idPrefix}-learn-interval-hours`}
                                type="number"
                                min={1}
                                className="ca-input ca-num"
                                disabled={cfgLearningBusy}
                                value={learnIntervalHours}
                                onChange={e => setLearnIntervalHours(Number(e.target.value))}
                              />
                            </div>
                            <div className="ca-field">
                              <label className="ca-field-label" htmlFor={`${idPrefix}-learn-min-idle-hours`}>
                                {t('最小空闲时间（小时）', 'Minimum idle time (hours)')}
                              </label>
                              <input
                                id={`${idPrefix}-learn-min-idle-hours`}
                                type="number"
                                min={0}
                                className="ca-input ca-num"
                                disabled={cfgLearningBusy}
                                value={learnMinIdleHours}
                                onChange={e => setLearnMinIdleHours(Number(e.target.value))}
                              />
                            </div>
                            <div className="ca-field">
                              <label className="ca-field-label" htmlFor={`${idPrefix}-learn-stale-days`}>
                                {t('陈旧判定阈值（天）', 'Stale threshold (days)')}
                              </label>
                              <input
                                id={`${idPrefix}-learn-stale-days`}
                                type="number"
                                min={1}
                                className="ca-input ca-num"
                                disabled={cfgLearningBusy}
                                value={learnStaleAfterDays}
                                onChange={e => setLearnStaleAfterDays(Number(e.target.value))}
                              />
                            </div>
                            <div className="ca-field">
                              <label className="ca-field-label" htmlFor={`${idPrefix}-learn-archive-days`}>
                                {t('自动归档阈值（天）', 'Archive threshold (days)')}
                              </label>
                              <input
                                id={`${idPrefix}-learn-archive-days`}
                                type="number"
                                min={1}
                                className="ca-input ca-num"
                                disabled={cfgLearningBusy}
                                value={learnArchiveAfterDays}
                                onChange={e => setLearnArchiveAfterDays(Number(e.target.value))}
                              />
                            </div>
                          </div>
                          <div className="ca-inline-between">
                            <div>
                              <div className="ca-field-label">{t('合并相似技能与记忆', 'Consolidate overlapping entries')}</div>
                              <div className="ca-muted">
                                {t('整理时允许自动合并重复或高度重叠的条目', 'Allow curator runs to merge duplicate or overlapping skills and memories')}
                              </div>
                            </div>
                            <CaSwitch
                              checked={learnConsolidate}
                              disabled={cfgLearningBusy}
                              label={t('合并相似技能与记忆', 'Consolidate overlapping entries')}
                              onChange={setLearnConsolidate}
                            />
                          </div>
                          <div className="ca-form-actions">
                            <button
                              type="button"
                              className="ca-btn ca-btn-sm"
                              disabled={cfgLearningBusy || !learningDirty}
                              onClick={handleDiscardLearningSchedule}
                            >
                              {t('还原更改', 'Discard changes')}
                            </button>
                            <button
                              type="button"
                              className="ca-btn ca-btn-primary ca-btn-sm"
                              disabled={cfgLearningBusy || !learningDirty}
                              onClick={() => void handleSaveLearningAdvanced()}
                            >
                              <LabelStack
                                active={cfgLearningBusy ? t('保存中…', 'Saving…') : t('保存学习周期', 'Save Schedule')}
                                labels={[t('保存学习周期', 'Save Schedule'), t('保存中…', 'Saving…')]}
                              />
                            </button>
                          </div>
                        </div>
                      </CaDisclosure>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    );
  };

  const renderDevicesOverview = () => (
    <>
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
                  onClick={() => setActiveModal({ kind: 'pairing' })}
                >
                  {t('查看二维码', 'View QR Code')}
                </button>
                <CopyButton value={pendingPairing.code} label={t('复制配对码', 'Copy Code')} />
                <button
                  type="button"
                  className="ca-btn ca-btn-danger ca-btn-sm"
                  onClick={() => void handleRevokePendingPairing()}
                >
                  {t('作废配对码', 'Revoke Code')}
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

      {/* Header toolbar: single primary CTA + overflow for Private CA */}
      <div className="ca-toolbar">
        <div className="ca-muted ca-num">
          {t(`共 ${devices.length} 台设备 · ${activeBotCount} 个活跃 Bot`, `${devices.length} ${devices.length === 1 ? 'device' : 'devices'} · ${activeBotCount} active ${activeBotCount === 1 ? 'Bot' : 'Bots'}`)}
        </div>
        <div className="ca-toolbar-group">
          <button
            type="button"
            className="ca-btn ca-btn-primary ca-btn-sm"
            disabled={pairingBusy}
            onClick={() => void handleOpenPairing()}
          >
            <QrCode size={14} aria-hidden="true" />
            <LabelStack
              active={pairingBusy ? t('生成中…', 'Generating…') : t('配对设备', 'Pair Device')}
              labels={[t('配对设备', 'Pair Device'), t('生成中…', 'Generating…')]}
            />
          </button>
          <ActionMenu
            items={[
              {
                label: t('私有 CA 证书', 'Private CA'),
                onSelect: openCaDrawer,
              },
            ]}
          />
        </div>
      </div>

      {/* Devices list with Live Readiness Row headers and flat Bot rows directly beneath */}
      {devices.length === 0 ? (
        <section className="ca-section">
          <div className="ca-empty">
            {t('暂无已绑定设备，点击右上角「配对设备」生成配对码连接桌面或手机客户端', 'No paired devices yet. Click "Pair Device" in the top right to generate a pairing code for desktop or mobile.')}
          </div>
        </section>
      ) : (
        devices.map(device => {
          const devBots = activeBotsByDevice.get(device.deviceId) ?? [];
          const isRenaming = renamingDeviceId === device.deviceId;
          const oauthEnabled = device.oauthAdminEnabled !== false;
          const runtime = runtimeByDevice[device.deviceId];
          const runtimeSummary = runtime ? formatRuntimeSummary(runtime, t) : null;
          const statusParts = [
            device.online ? t('在线', 'Online') : t('离线', 'Offline'),
            t(`${devBots.length} 个 Bot`, `${devBots.length} ${devBots.length === 1 ? 'Bot' : 'Bots'}`),
          ];
          if (runtimeSummary) {
            statusParts.push(runtimeSummary.text);
          }
          if (!oauthEnabled) {
            statusParts.push(t('中心管理已关闭', 'Admin access off'));
          }

          return (
            <section key={device.deviceId} className="ca-section">
              <div className="ca-section-head">
                <div className="ca-row-main ca-device-head-main">
                  <div className="ca-row-title">
                    <span className={`ca-dot ${device.online ? 'is-online' : ''}`} aria-hidden="true" />
                    {isRenaming ? (
                      <div className="ca-inline-row ca-rename-row">
                        <input
                          type="text"
                          className="ca-input ca-input-compact"
                          disabled={renamingBusy}
                          value={renameDraft}
                          onChange={e => setRenameDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') void handleSaveDeviceRename(device);
                            if (e.key === 'Escape' && !renamingBusy) setRenamingDeviceId(null);
                          }}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="ca-btn ca-btn-ghost ca-btn-icon"
                          disabled={renamingBusy || !renameDraft.trim()}
                          onClick={() => void handleSaveDeviceRename(device)}
                          aria-label={t('保存名称', 'Save name')}
                        >
                          <Check size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="ca-btn ca-btn-ghost ca-btn-icon"
                          disabled={renamingBusy}
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
                    {runtimeSummary?.showPill && (
                      <span
                        className={`ca-pill ca-pill-${runtimeSummary.pillTone}`}
                        title={runtimeSummary.detailTitle}
                      >
                        {runtimeSummary.text}
                      </span>
                    )}
                  </div>
                  <div className="ca-row-sub ca-num" title={runtimeSummary?.detailTitle}>
                    {statusParts.join(' · ')}
                  </div>
                </div>

                <div className="ca-row-actions">
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => openCreateBotModal(device)}
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>{t('新建 Bot', 'New Bot')}</span>
                  </button>
                  <ActionMenu
                    items={[
                      {
                        label: t('重新扫码绑定', 'Re-pair via QR'),
                        onSelect: () => void handleOpenPairing(device.deviceId),
                      },
                      {
                        label: oauthEnabled
                          ? t('关闭中心管理权限', 'Disable center admin access')
                          : t('开启中心管理权限', 'Enable center admin access'),
                        disabled: oauthBusyId === device.deviceId,
                        onSelect: () => void handleToggleOAuthGrant(device, !oauthEnabled),
                      },
                      {
                        label: t('移除设备', 'Remove device'),
                        danger: true,
                        onSelect: () => setActiveModal({ kind: 'remove-device', device }),
                      },
                    ]}
                  />
                </div>
              </div>

              {/* Flat hairline Bot rows directly beneath the device header */}
              <div className="ca-list">
                {devBots.length === 0 ? (
                  <div className="ca-empty">
                    {t('此设备暂无 Bot，点击上方「新建 Bot」创建', 'No Bots on this device yet. Click "New Bot" above to create one.')}
                  </div>
                ) : (
                  devBots.map(bot => {
                    const modelDisp = botModelDisplay(bot);
                    const secondaryLine = modelDisp.unset
                      ? bot.description || t('请在配置中选择模型', 'Select a model in Configure')
                      : bot.description
                        ? `${modelDisp.label} · ${bot.description}`
                        : modelDisp.label;
                    return (
                      <div key={bot.botId} className="ca-row">
                        <div className="ca-row-main">
                          <div className="ca-row-title">
                            <span>{bot.name}</span>
                            {bot.isPrimary && <span className="ca-pill ca-pill-info">{t('主 Bot', 'Primary')}</span>}
                            {modelDisp.unset && <span className="ca-pill ca-pill-warn">{modelDisp.label}</span>}
                          </div>
                          <div className="ca-row-sub">{secondaryLine}</div>
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

      {/* Archived bots tucked cleanly in a disclosure with flat hairline rows */}
      {archivedBots.length > 0 && (
        <div className="ca-section-gap">
          <CaDisclosure title={t(`已归档 Bot (${archivedBots.length})`, `Archived Bots (${archivedBots.length})`)}>
            <div className="ca-list">
              {archivedBots.map(bot => (
                <div key={`${bot.deviceId}-${bot.botId}`} className="ca-row">
                  <div className="ca-row-main">
                    <div className="ca-row-title">
                      <Archive size={14} aria-hidden="true" />
                      <span>{bot.name}</span>
                    </div>
                    <div className="ca-row-sub">{bot.deviceName || bot.deviceId}</div>
                  </div>
                  <div className="ca-row-actions">
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      onClick={() => void handleBotMenuAction(bot, 'unarchive')}
                    >
                      {t('恢复 Bot', 'Restore')}
                    </button>
                    <button
                      type="button"
                      className="ca-btn ca-btn-danger ca-btn-sm"
                      onClick={() => void handleBotMenuAction(bot, 'delete')}
                    >
                      {t('删除 Bot', 'Delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CaDisclosure>
        </div>
      )}
    </>
  );

  const createBotDevice = activeModal?.kind === 'create-bot' ? activeModal.device : null;
  const deviceToRemove = activeModal?.kind === 'remove-device' ? activeModal.device : null;
  const botToDelete = activeModal?.kind === 'delete-bot' ? activeModal.bot : null;

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      {cfgBot ? renderBotConfigSubView() : renderDevicesOverview()}

      {/* Single modal slot: Remove Device Confirmation */}
      {deviceToRemove && (
        <RemoveDeviceDialog
          name={deviceToRemove.name}
          onClose={() => setActiveModal(null)}
          onRemove={async () => {
            await api.deleteDevice(deviceToRemove.deviceId);
            setError('');
            setNotice(t(`已移除设备 ${deviceToRemove.name}`, `Removed device ${deviceToRemove.name}`));
            void loadAll().catch(err => setError(errorMessage(err, t('刷新设备目录失败，请重试', 'Failed to refresh device directory. Please retry.'))));
          }}
        />
      )}

      {/* Single modal slot: Pair / Re-pair Device QR (closing never revokes pending code) */}
      <CaModal
        open={activeModal?.kind === 'pairing'}
        onOpenChange={open => {
          if (!open) setActiveModal(null);
        }}
        title={
          pendingPairing?.target
            ? t(`重新绑定设备 · ${pendingPairing.target.name}`, `Re-pair Device · ${pendingPairing.target.name}`)
            : t('配对设备', 'Pair Device')
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

      {/* Single modal slot: Private CA Certificate Drawer */}
      <CaModal
        open={activeModal?.kind === 'ca'}
        onOpenChange={open => {
          if (!open && !caBusy) {
            setCaFormError('');
            setCaFormNotice('');
            setActiveModal(null);
          }
        }}
        title={t('私有 CA 证书', 'Private CA')}
        description={t('若中心使用自签或内网 HTTPS 证书，可在此配置信任根证书（新配对码将自动携带）', 'Configure a trusted root CA if the center uses a self-signed or private HTTPS certificate (embedded in new pairing codes)')}
        variant="drawer"
      >
        <div className="ca-form-stack">
          {caFormError && <CaNotice tone="danger">{caFormError}</CaNotice>}
          {caFormNotice && <CaNotice tone="ok">{caFormNotice}</CaNotice>}

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
            <label className="ca-field-label" htmlFor={`${idPrefix}-private-ca-pem`}>
              {t('PEM 根证书内容', 'PEM Root Certificate')}
            </label>
            <textarea
              id={`${idPrefix}-private-ca-pem`}
              rows={8}
              className="ca-textarea ca-mono"
              disabled={caBusy}
              placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
              value={caDraft}
              onChange={e => setCaDraft(e.target.value)}
            />
          </div>

          <div className="ca-form-actions ca-form-actions-between">
            <button
              type="button"
              className="ca-btn ca-btn-danger ca-btn-sm"
              disabled={caBusy || !caState?.ca}
              onClick={() => void handleSaveCa(null)}
            >
              {t('清除证书', 'Clear Certificate')}
            </button>
            <div className="ca-inline-row">
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                disabled={caBusy}
                onClick={() => {
                  setCaFormError('');
                  setCaFormNotice('');
                  setActiveModal(null);
                }}
              >
                {t('关闭', 'Close')}
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
        </div>
      </CaModal>

      {/* Single modal slot: Create Bot */}
      <CaModal
        open={Boolean(createBotDevice)}
        onOpenChange={open => {
          if (!open && !createBotBusy) {
            setCreateBotFormError('');
            setActiveModal(null);
          }
        }}
        title={t(`在「${createBotDevice?.name ?? ''}」新建 Bot`, `New Bot on "${createBotDevice?.name ?? ''}"`)}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleCreateBot(e)}>
          {createBotFormError && <CaNotice tone="danger">{createBotFormError}</CaNotice>}

          <div className="ca-field">
            <label className="ca-field-label" htmlFor={`${idPrefix}-new-bot-role`}>
              {t('Bot 名称', 'Bot Name')} <span className="ca-req">*</span>
            </label>
            <input
              id={`${idPrefix}-new-bot-role`}
              type="text"
              className="ca-input"
              required
              disabled={createBotBusy}
              placeholder={t('例如：代码助手 / 运维助理', 'e.g. Coding Assistant / Ops Helper')}
              value={newBotRole}
              onChange={e => setNewBotRole(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label" htmlFor={`${idPrefix}-new-bot-model`}>{t('模型选择', 'Model')}</label>
            <select
              id={`${idPrefix}-new-bot-model`}
              className="ca-select"
              disabled={createBotBusy}
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
            <label className="ca-field-label" htmlFor={`${idPrefix}-new-bot-desc`}>{t('简介（可选）', 'Description (optional)')}</label>
            <input
              id={`${idPrefix}-new-bot-desc`}
              type="text"
              className="ca-input"
              disabled={createBotBusy}
              placeholder={t('简述职责或定位', 'Briefly describe its role')}
              value={newBotDesc}
              onChange={e => setNewBotDesc(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label" htmlFor={`${idPrefix}-new-bot-cwd`}>{t('工作目录 CWD（可选）', 'Working Directory CWD (optional)')}</label>
            <input
              id={`${idPrefix}-new-bot-cwd`}
              type="text"
              className="ca-input ca-mono"
              disabled={createBotBusy}
              placeholder={t('留空由设备端分配默认目录', 'Leave empty to use device default')}
              value={newBotCwd}
              onChange={e => setNewBotCwd(e.target.value)}
            />
          </div>

          <label className="ca-check-label">
            <input
              type="checkbox"
              disabled={createBotBusy}
              checked={newBotPrimary}
              onChange={e => setNewBotPrimary(e.target.checked)}
            />
            <span>{t('设为此设备主 Bot', 'Set as Primary Bot on this device')}</span>
          </label>

          <div className="ca-form-actions">
            <button
              type="button"
              className="ca-btn"
              disabled={createBotBusy}
              onClick={() => {
                setCreateBotFormError('');
                setActiveModal(null);
              }}
            >
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

      {/* Single modal slot: Confirm Delete Bot */}
      <CaConfirmDialog
        open={Boolean(botToDelete)}
        title={t('删除 Bot', 'Delete Bot')}
        description={
          botToDelete ? (
            <>
              <span>
                {t(`彻底删除 Bot「${botToDelete.name}」后将无法恢复，该 Bot 的配置与中心绑定将被永久清除。`, `Permanently deleting Bot "${botToDelete.name}" cannot be undone. Its settings and center bindings will be removed.`)}
              </span>
              {deleteBotError ? (
                <>
                  <br />
                  <span className="ca-error-text">{deleteBotError}</span>
                </>
              ) : null}
            </>
          ) : ''
        }
        confirmLabel={deletingBot ? t('删除中…', 'Deleting…') : t('删除 Bot', 'Delete Bot')}
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={deletingBot}
        onCancel={() => {
          if (!deletingBot) {
            setDeleteBotError('');
            setActiveModal(null);
          }
        }}
        onConfirm={() => void handleConfirmDeleteBot()}
      />
    </div>
  );
}
