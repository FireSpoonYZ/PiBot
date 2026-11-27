import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ArrowLeft, Check, Plus, RefreshCw, RotateCcw, Search, Star, Trash2 } from 'lucide-react';
import { ANTIGRAVITY_PROVIDER_ID } from '../../../center-contract/antigravity.js';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import { LabelStack } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import { openExternalUrl } from './openExternalUrl';
import {
  areAllVisibleSelected,
  buildDiscoverRequest,
  deselectVisibleModelIds,
  saveModelsInChunks,
  selectVisibleModelIds,
} from './providerDiscoverHelpers';
import {
  CaCardSkeleton,
  CaChips,
  CaConfirmDialog,
  CaDisclosure,
  CaModal,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSegmented,
  CaSwitch,
  CopyButton,
  formatTime,
  useCaTabNotices,
  useUiLocale,
} from './primitives';
import type {
  CenterDevice,
  CredentialInfo,
  JsonObject,
  Model,
  ModelCatalogItem,
  ModelConfig,
  ModelPickerResponse,
  ModelSelection,
  Provider,
  ProviderAuthFlow,
  ProviderAuthStatus,
} from './types';

const NATIVE_PROVIDER_ORDER = [
  'openai',
  'openai-codex',
  'anthropic',
  'google',
  ANTIGRAVITY_PROVIDER_ID,
  'github-copilot',
  'openrouter',
  'deepseek',
  'xai',
  'groq',
  'mistral',
  'moonshotai',
  'minimax',
  'zai',
];

const API_PROTOCOLS = [
  { value: 'openai-completions', label: 'OpenAI Completions (/v1/chat/completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses (/v1/responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

type TranslateFn = (zh: string, en: string) => string;

type ThinkingChoice = '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function getThinkingOptions(t: TranslateFn): readonly { value: ThinkingChoice; label: string }[] {
  return [
    { value: '', label: t('默认', 'Default') },
    { value: 'off', label: t('关闭', 'Off') },
    { value: 'minimal', label: t('极低', 'Minimal') },
    { value: 'low', label: t('低', 'Low') },
    { value: 'medium', label: t('中', 'Medium') },
    { value: 'high', label: t('高', 'High') },
    { value: 'xhigh', label: t('很高', 'Very High') },
    { value: 'max', label: t('最高', 'Max') },
  ];
}

type CodeModeChoice = 'off' | 'on' | 'only';

function getCodeModeOptions(t: TranslateFn): readonly { value: CodeModeChoice; label: string }[] {
  return [
    { value: 'off', label: t('标准工具', 'Standard tools') },
    { value: 'on', label: t('开启 Code Mode', 'Enable Code Mode') },
    { value: 'only', label: t('仅 Code Mode', 'Code Mode only') },
  ];
}

const EXTRA_MODEL_KEYS = [
  'api',
  'baseUrl',
  'headers',
  'thinkingLevelMap',
  'cost',
  'compat',
  'inputLimits',
  'promptCache',
  'samplingParams',
  'samplingParamsByThinkingLevel',
] as const;

type ProviderDetailView =
  | { mode: 'list' }
  | { mode: 'create' }
  | { mode: 'detail'; providerId: string };

type ProvidersModal =
  | null
  | { kind: 'default-picker' }
  | { kind: 'discover'; mode: 'remote' | 'restore' }
  | { kind: 'edit-model'; creating: boolean }
  | { kind: 'confirm-delete-provider' }
  | { kind: 'confirm-clear-key' }
  | { kind: 'confirm-delete-model'; model: Model; returnToEdit: boolean };

function deriveSlug(name: string, baseUrl: string, existingIds: Set<string>): string {
  const fromName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let base = fromName;
  if (!base && baseUrl.trim()) {
    try {
      base = new URL(baseUrl.trim()).hostname.replace(/^api\./, '').replace(/[^a-z0-9]+/g, '-');
    } catch {
      base = 'custom';
    }
  }
  if (!base) base = 'custom';
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function splitModelExtra(model: Model): { base: Model; extraJson: string } {
  const extra: Record<string, unknown> = {};
  for (const key of EXTRA_MODEL_KEYS) {
    const val = model[key];
    if (val !== undefined) extra[key] = val;
  }
  return {
    base: model,
    extraJson: Object.keys(extra).length > 0 ? JSON.stringify(extra, null, 2) : '{}',
  };
}

function providerSortRank(p: Provider): number {
  const idx = NATIVE_PROVIDER_ORDER.indexOf(p.id);
  if (idx >= 0) return idx;
  return p.native ? 100 : 200;
}

function countModelsByProvider(pickerRes: ModelPickerResponse): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of pickerRes.models) {
    const slash = item.modelRef.indexOf('/');
    if (slash > 0) {
      const pid = item.modelRef.slice(0, slash);
      counts[pid] = (counts[pid] ?? 0) + 1;
    }
  }
  return counts;
}

interface ProvidersCacheData {
  providers: Provider[];
  picker: ModelPickerResponse | null;
  modelConfig: ModelConfig | null;
  authByProvider: Record<string, ProviderAuthStatus>;
  modelCountByProvider: Record<string, number>;
}

export function ProvidersTab({
  api,
  active = true,
  cacheKey = 'default',
  onOpenExternalUrl,
  onRegisterBackHandler,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
  onRegisterBackHandler?: (handler: () => boolean) => () => void;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();
  const idPrefix = useId();
  const thinkingOptions = useMemo(() => getThinkingOptions(t), [t]);
  const codeModeOptions = useMemo(() => getCodeModeOptions(t), [t]);

  const initialCache = useMemo(
    () => readTabCache<ProvidersCacheData>(cacheKey, 'providers')?.data ?? null,
    [cacheKey],
  );
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');

  const [providers, setProviders] = useState<Provider[]>(() => initialCache?.providers ?? []);
  const [picker, setPicker] = useState<ModelPickerResponse | null>(() => initialCache?.picker ?? null);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(() => initialCache?.modelConfig ?? null);
  const [authByProvider, setAuthByProvider] = useState<Record<string, ProviderAuthStatus>>(
    () => initialCache?.authByProvider ?? {},
  );
  const [modelCountByProvider, setModelCountByProvider] = useState<Record<string, number>>(
    () => initialCache?.modelCountByProvider ?? {},
  );

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);
  const detailLoadGenRef = useRef(0);
  const discoverGenRef = useRef(0);
  const clearKeyGenRef = useRef(0);
  const flowGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('providers', active);

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

  // Unified mutually exclusive modal state (max modal depth = 1)
  const [activeModal, setActiveModal] = useState<ProvidersModal>(null);
  const [confirmError, setConfirmError] = useState('');

  // Global default picker & overview state
  const [pickerFilter, setPickerFilter] = useState<'all' | 'starred'>('all');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);

  // Provider overview filter & row state
  const [providerQuery, setProviderQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'enabled' | 'all'>('enabled');
  const [togglingProviderId, setTogglingProviderId] = useState<string | null>(null);

  // In-page Provider Detail view state
  const [detailView, setDetailView] = useState<ProviderDetailView>({ mode: 'list' });
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailNotice, setDetailNotice] = useState('');
  const [edit, setEdit] = useState<Provider | null>(null);
  const [customIdEdited, setCustomIdEdited] = useState(false);
  const [customJson, setCustomJson] = useState('{}');
  const [keyValue, setKeyValue] = useState('');
  const [credential, setCredential] = useState<CredentialInfo | null>(null);
  const [authStatus, setAuthStatus] = useState<ProviderAuthStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [removedModels, setRemovedModels] = useState<Model[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [validatingProvider, setValidatingProvider] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // OAuth flow state
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ProviderAuthFlow | null>(null);
  const [promptInput, setPromptInput] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const flowTimerRef = useRef<number | null>(null);

  // Single-layer Model edit modal state
  const [modelDraft, setModelDraft] = useState<Model | null>(null);
  const [modelExtraJson, setModelExtraJson] = useState('{}');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelFormError, setModelFormError] = useState('');

  // Single-layer Discover / Restore models modal state
  const [discovered, setDiscovered] = useState<Model[]>([]);
  const [discoverTotalCount, setDiscoverTotalCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverDeviceId, setDiscoverDeviceId] = useState('');
  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [discoverFetching, setDiscoverFetching] = useState(false);
  const [discoverSaving, setDiscoverSaving] = useState(false);
  const [discoverFormError, setDiscoverFormError] = useState('');

  const creating = detailView.mode === 'create';
  const inDetailView = detailView.mode !== 'list';

  const refreshPageData = useCallback(async () => {
    const [provList, pickerRes, cfgRes, batchAuth] = await Promise.all([
      api.listProviders(),
      api.getModelPicker(),
      api.getModelConfig(),
      api.providerAuthStatuses().catch(() => null),
    ]);
    setProviders(provList);
    setPicker(pickerRes);
    setModelConfig(cfgRes);
    setModelCountByProvider(countModelsByProvider(pickerRes));

    if (batchAuth && (Object.keys(batchAuth).length > 0 || !provList.some(p => p.native))) {
      setAuthByProvider(batchAuth);
    } else {
      void api
        .providerAuthStatuses(provList.filter(p => p.native).map(p => p.id))
        .then(next => setAuthByProvider(next))
        .catch(() => {});
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
      await refreshPageData();
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const msg = errorMessage(err, t('加载模型配置失败，请重试', 'Failed to load model settings. Please try again.'));
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
  }, [refreshPageData, showNotice]);

  useEffect(() => {
    void runLoad();
  }, [runLoad]);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive && active && (hasLoadedRef.current || initialError)) {
      void runLoad();
    }
  }, [active, initialError, runLoad]);

  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
      detailLoadGenRef.current += 1;
      discoverGenRef.current += 1;
      clearKeyGenRef.current += 1;
      flowGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<ProvidersCacheData>(cacheKey, 'providers', {
      providers,
      picker,
      modelConfig,
      authByProvider,
      modelCountByProvider,
    });
  }, [authByProvider, cacheKey, hasLoaded, modelConfig, modelCountByProvider, picker, providers]);

  const stopFlowPoll = useCallback(() => {
    flowGenRef.current += 1;
    if (flowTimerRef.current !== null) {
      window.clearTimeout(flowTimerRef.current);
      flowTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopFlowPoll(), [stopFlowPoll]);

  const closeProviderDetail = useCallback(() => {
    detailLoadGenRef.current += 1;
    discoverGenRef.current += 1;
    clearKeyGenRef.current += 1;
    stopFlowPoll();
    setFlowId(null);
    setFlow(null);
    setPromptInput('');
    setDetailError('');
    setDetailNotice('');
    setDetailLoading(false);
    setDiscoverFetching(false);
    setClearingKey(false);
    setActiveModal(null);
    setConfirmError('');
    setDetailView({ mode: 'list' });
    setEdit(null);
  }, [stopFlowPoll]);

  const closeProviderDetailRef = useRef(closeProviderDetail);
  closeProviderDetailRef.current = closeProviderDetail;

  useEffect(() => {
    if (!active || !inDetailView) return;
    const handleBack = () => {
      closeProviderDetailRef.current();
      return true;
    };
    const unregisterOverlay = registerOverlayBackHandler(() => {
      handleBack();
    });
    const unregisterPanel = onRegisterBackHandler?.(handleBack);
    return () => {
      unregisterPanel?.();
      unregisterOverlay();
    };
  }, [active, inDetailView, onRegisterBackHandler]);

  const loadProviderDetails = useCallback(
    async (provider: Provider) => {
      const gen = ++detailLoadGenRef.current;
      setDetailLoading(true);
      setDetailError('');
      try {
        const [allModels, status, cred] = await Promise.all([
          api.listModels(provider.id, true),
          api.providerAuthStatus(provider.id).catch(() => null),
          provider.credentialRef
            ? api.getCredential(provider.credentialRef).catch(err => {
                if (err instanceof CenterApiError && err.status === 404) return null;
                return null;
              })
            : Promise.resolve(null),
        ]);
        if (gen !== detailLoadGenRef.current) return;
        setModels(allModels.filter(m => !m.removed));
        setRemovedModels(allModels.filter(m => m.removed));
        setAuthStatus(status);
        if (status) {
          setAuthByProvider(prev => ({ ...prev, [provider.id]: status }));
        }
        setCredential(cred);
      } catch (err) {
        if (gen !== detailLoadGenRef.current) return;
        setDetailError(
          errorMessage(
            err,
            t('读取服务商详情失败，请检查中心连接后重试', 'Failed to load provider details. Check center connectivity and retry.'),
          ),
        );
      } finally {
        if (gen === detailLoadGenRef.current) setDetailLoading(false);
      }
    },
    [api, t],
  );

  const openExistingProvider = (provider: Provider) => {
    detailLoadGenRef.current += 1;
    discoverGenRef.current += 1;
    clearKeyGenRef.current += 1;
    setDiscoverFetching(false);
    setClearingKey(false);
    stopFlowPoll();
    setFlowId(null);
    setFlow(null);
    setPromptInput('');
    setActiveModal(null);
    setConfirmError('');
    setDetailView({ mode: 'detail', providerId: provider.id });
    setEdit({ ...provider });
    setCustomIdEdited(true);
    setCustomJson(JSON.stringify(provider.custom ?? {}, null, 2));
    setKeyValue('');
    setModelQuery('');
    setDetailNotice('');
    setDetailError('');
    setModels([]);
    setRemovedModels([]);
    setCredential(null);
    setAuthStatus(authByProvider[provider.id] ?? null);
    setAdvancedOpen(
      Boolean(
        provider.baseUrl.trim() || (provider.custom && Object.keys(provider.custom).length > 0),
      ),
    );
    void loadProviderDetails(provider);
  };

  const openCreateProvider = () => {
    detailLoadGenRef.current += 1;
    discoverGenRef.current += 1;
    clearKeyGenRef.current += 1;
    setDiscoverFetching(false);
    setClearingKey(false);
    stopFlowPoll();
    setFlowId(null);
    setFlow(null);
    setPromptInput('');
    setActiveModal(null);
    setConfirmError('');
    setDetailLoading(false);
    setDetailView({ mode: 'create' });
    setEdit({
      id: '',
      name: '',
      baseUrl: '',
      api: 'openai-completions',
      credentialRef: null,
      native: false,
      enabled: true,
      configured: true,
      revision: 0,
    });
    setCustomIdEdited(false);
    setCustomJson('{}');
    setKeyValue('');
    setModelQuery('');
    setDetailNotice('');
    setDetailError('');
    setModels([]);
    setRemovedModels([]);
    setCredential(null);
    setAuthStatus(null);
    setAdvancedOpen(false);
  };

  const starredSet = useMemo(() => new Set(picker?.starredModels ?? []), [picker]);

  const currentGlobalModelRef = modelConfig?.global.modelRef || picker?.defaultModel || null;

  const currentDefaultItem = useMemo<ModelCatalogItem | null>(() => {
    if (!currentGlobalModelRef || !picker) return null;
    return picker.models.find(m => m.modelRef === currentGlobalModelRef) ?? null;
  }, [currentGlobalModelRef, picker]);

  const sortedPickerModels = useMemo(() => {
    if (!picker) return [];
    const q = pickerQuery.trim().toLowerCase();
    const list = picker.models.filter(item => {
      if (pickerFilter === 'starred' && !starredSet.has(item.modelRef)) return false;
      if (!q) return true;
      return item.name.toLowerCase().includes(q) || item.modelRef.toLowerCase().includes(q);
    });
    // Pin starred models to the top while keeping original relative order
    return [...list].sort((a, b) => {
      const sa = starredSet.has(a.modelRef) ? 0 : 1;
      const sb = starredSet.has(b.modelRef) ? 0 : 1;
      return sa - sb;
    });
  }, [picker, pickerFilter, pickerQuery, starredSet]);

  const saveGlobalSelection = async (
    patch: Partial<ModelSelection>,
    successMsg?: string,
    options?: { reportInlinePicker?: boolean },
  ): Promise<boolean> => {
    if (!modelConfig) return false;
    setPickerBusy(true);
    setError('');
    if (options?.reportInlinePicker) setPickerError('');
    try {
      const next: ModelSelection = { ...modelConfig.global, ...patch };
      if (!next.modelRef) delete next.modelRef;
      if (!next.thinkingLevel) delete next.thinkingLevel;
      if (next.codemode === null || next.codemode === undefined) delete next.codemode;
      if (next.codemodeOnly === null || next.codemodeOnly === undefined) delete next.codemodeOnly;
      const updated = await api.putModelConfig({
        expectedRevision: modelConfig.revision,
        value: next,
      });
      setModelConfig(updated);
      const refreshedPicker = await api.getModelPicker();
      setPicker(refreshedPicker);
      setModelCountByProvider(countModelsByProvider(refreshedPicker));
      if (successMsg) setNotice(successMsg);
      return true;
    } catch (err) {
      const msg = errorMessage(
        err,
        t('保存全局默认模型失败，请检查配置并重试', 'Failed to save global default model. Check settings and try again.'),
      );
      if (options?.reportInlinePicker) setPickerError(msg);
      else setError(msg);
      return false;
    } finally {
      setPickerBusy(false);
    }
  };

  const handleToggleStar = async (modelRef: string, nextStar: boolean) => {
    try {
      const res = await api.setModelStar(modelRef, nextStar);
      setPicker(prev => (prev ? { ...prev, starredModels: res.starredModels } : prev));
    } catch (err) {
      const msg = errorMessage(err, t('更新收藏状态失败，请重试', 'Failed to update star status. Please retry.'));
      if (activeModal?.kind === 'default-picker') setPickerError(msg);
      else if (inDetailView) setDetailError(msg);
      else setError(msg);
    }
  };

  const handleSyncCatalog = async () => {
    setSyncBusy(true);
    setError('');
    try {
      const res = await api.syncModelCatalog();
      await refreshPageData();
      if (res.error) setError(res.error);
      else {
        setNotice(
          res.modelsAdded
            ? t(`模型目录已同步（新增 ${res.modelsAdded} 个）`, `Model catalog synced (${res.modelsAdded} added)`)
            : t('模型目录已同步', 'Model catalog synced'),
        );
      }
    } catch (err) {
      setError(errorMessage(err, t('同步模型目录失败，请检查网络后重试', 'Failed to sync model catalog. Check connectivity and try again.')));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleToggleProviderRow = async (provider: Provider, nextEnabled: boolean) => {
    setTogglingProviderId(provider.id);
    setError('');
    if (inDetailView) setDetailError('');
    try {
      const updated = await api.putProvider(provider.id, {
        expectedRevision: provider.revision,
        value: {
          ...provider,
          enabled: nextEnabled,
          configured: provider.configured || nextEnabled,
        },
      });
      setProviders(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      if (edit?.id === updated.id) setEdit(updated);
      const pickerRes = await api.getModelPicker();
      setPicker(pickerRes);
      setModelCountByProvider(countModelsByProvider(pickerRes));
    } catch (err) {
      const msg = errorMessage(err, t('切换服务商状态失败，请重试', 'Failed to update provider status. Please retry.'));
      if (inDetailView) setDetailError(msg);
      else setError(msg);
    } finally {
      setTogglingProviderId(null);
    }
  };

  const persistProvider = async (verifyAfterSave: boolean) => {
    if (!edit) return;
    setDetailError('');
    setDetailNotice('');

    let parsedCustom: JsonObject = {};
    try {
      const raw = JSON.parse(customJson || '{}') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        setDetailError(
          t('高级协议覆盖必须是 JSON 对象（例如 {}），请修正后再保存。', 'Advanced protocol overrides must be a JSON object (e.g. {}). Fix the value and save again.'),
        );
        return;
      }
      parsedCustom = raw as JsonObject;
    } catch (err) {
      const reason = err instanceof Error ? err.message : t('JSON 语法无效', 'Invalid JSON syntax');
      setDetailError(
        t(`高级协议 JSON 解析失败（${reason}），请修正格式或恢复为 {}。`, `Invalid advanced protocol JSON (${reason}). Fix the syntax or reset to {}.`),
      );
      return;
    }

    if (!edit.native && !edit.baseUrl.trim() && typeof parsedCustom.baseUrl !== 'string') {
      setDetailError(
        t('请填写 API Base URL（例如 https://api.example.com/v1），再点击保存。', 'Enter an API Base URL (e.g. https://api.example.com/v1), then save again.'),
      );
      return;
    }

    const existingIds = new Set(providers.map(p => p.id));
    const wasCreating = creating;
    const finalId = wasCreating
      ? customIdEdited && edit.id.trim()
        ? edit.id.trim()
        : deriveSlug(edit.name, edit.baseUrl, existingIds)
      : edit.id;
    const finalName = edit.name.trim() || finalId;
    const trimmedKey = keyValue.trim();

    let credentialRef = edit.credentialRef;
    if (trimmedKey && !credentialRef) {
      credentialRef = `${finalId}-api-key`;
    }

    const payload: Provider = {
      ...edit,
      id: finalId,
      name: finalName,
      baseUrl: edit.baseUrl.trim(),
      api: edit.api.trim() || 'openai-completions',
      credentialRef,
      configured: true,
      enabled: wasCreating || Boolean(trimmedKey) ? true : edit.enabled,
      custom: parsedCustom,
    };

    setSavingProvider(true);
    try {
      const saved = wasCreating
        ? await api.createProvider(payload)
        : await api.putProvider(payload.id, {
            expectedRevision: edit.revision,
            value: payload,
          });

      setDetailView({ mode: 'detail', providerId: saved.id });
      setEdit(saved);

      if (trimmedKey && saved.credentialRef) {
        const curCred =
          credential?.credentialId === saved.credentialRef
            ? credential
            : await api.getCredential(saved.credentialRef).catch(err => {
                if (err instanceof CenterApiError && err.status === 404) return null;
                throw err;
              });
        const written = await api.putCredential(saved.credentialRef, {
          value: trimmedKey,
          expectedRevision: curCred?.revision ?? null,
        });
        setCredential(written);
        setKeyValue('');
      }

      let verifyMsg = '';
      let verifyFailed = false;
      if (verifyAfterSave) {
        setValidatingProvider(true);
        try {
          const check = await api.validateProvider(saved.id, {});
          if (check.ok) {
            verifyMsg = t(`连接验证通过：${check.message}`, `Connection verified: ${check.message}`);
          } else {
            verifyFailed = true;
            verifyMsg = t(`配置已保存，但连接验证未通过：${check.message}。请检查密钥或接口地址后重试。`, `Settings saved, but verification failed: ${check.message}. Check the key or API URL and retry.`);
          }
        } catch (vErr) {
          verifyFailed = true;
          const errMsg = errorMessage(vErr, t('请求未响应', 'Request failed'));
          verifyMsg = t(`配置已保存，但连接验证失败：${errMsg}。请检查网络或配置后重试。`, `Settings saved, but verification failed: ${errMsg}. Check connectivity or settings and retry.`);
        } finally {
          setValidatingProvider(false);
        }
      }

      await refreshPageData();
      await loadProviderDetails(saved);
      if (verifyFailed) {
        setDetailError(verifyMsg);
      } else {
        setDetailNotice(
          verifyMsg || (wasCreating ? t('服务商已创建并启用', 'Provider created and enabled') : t('服务商配置已保存', 'Provider settings saved')),
        );
      }
    } catch (err) {
      setDetailError(
        errorMessage(
          err,
          t('保存服务商失败，请检查输入内容与中心连接后重试', 'Failed to save provider. Check the fields and center connection, then try again.'),
        ),
      );
    } finally {
      setSavingProvider(false);
    }
  };

  const handleValidateOnly = async () => {
    if (!edit || creating) return;
    setValidatingProvider(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const res = await api.validateProvider(edit.id, keyValue.trim() ? { apiKey: keyValue.trim() } : {});
      if (res.ok) setDetailNotice(t(`连接正常：${res.message}`, `Connection OK: ${res.message}`));
      else setDetailError(t(`连接验证失败：${res.message}。请核对密钥或接口地址后重试。`, `Connection check failed: ${res.message}. Verify the key or API URL and retry.`));
    } catch (err) {
      setDetailError(
        errorMessage(err, t('验证连接失败，请检查中心网络后重试', 'Failed to verify connection. Check center connectivity and try again.')),
      );
    } finally {
      setValidatingProvider(false);
    }
  };

  const handleDeleteProvider = async () => {
    if (!edit || creating) return;
    setSavingProvider(true);
    setConfirmError('');
    try {
      const deletedName = edit.name || edit.id;
      const wasNative = edit.native;
      await api.deleteProvider(edit.id);
      closeProviderDetail();
      await refreshPageData();
      setNotice(wasNative ? t(`已重置 ${deletedName}`, `Reset ${deletedName}`) : t(`已删除 ${deletedName}`, `Deleted ${deletedName}`));
    } catch (err) {
      setConfirmError(
        errorMessage(err, t('删除服务商失败，请重试', 'Failed to delete provider. Please try again.')),
      );
    } finally {
      setSavingProvider(false);
    }
  };

  const handleClearApiKey = async () => {
    if (!edit || creating || !edit.credentialRef || !credential?.configured || clearingKey) return;
    const targetProvider = edit;
    const credRef = edit.credentialRef;
    const expectedCredRevision = credential.revision;
    const restoreNoKeyMode = !edit.native;
    const clearGen = ++clearKeyGenRef.current;

    setClearingKey(true);
    setConfirmError('');
    setDetailError('');
    setDetailNotice('');
    try {
      await api.deleteCredential(credRef, {
        expectedRevision: expectedCredRevision,
        value: null,
      });

      if (clearGen === clearKeyGenRef.current) {
        setKeyValue('');
        setCredential({
          credentialId: credRef,
          configured: false,
          revision: expectedCredRevision + 1,
        });
      }

      let updatedProvider = targetProvider;
      if (restoreNoKeyMode) {
        try {
          updatedProvider = await api.putProvider(targetProvider.id, {
            expectedRevision: targetProvider.revision,
            value: {
              ...targetProvider,
              credentialRef: null,
            },
          });
          if (clearGen === clearKeyGenRef.current) {
            setEdit(updatedProvider);
            setCredential(null);
          }
        } catch (provErr) {
          const fresh = await api.getProvider(targetProvider.id).catch(() => null);
          await refreshPageData().catch(() => {});
          if (clearGen === clearKeyGenRef.current) {
            if (fresh) setEdit(fresh);
            await loadProviderDetails(fresh ?? targetProvider).catch(() => {});
            setActiveModal(null);
            setDetailError(
              errorMessage(provErr, t('密钥已清除，但恢复无密钥模式失败，请重新保存配置', 'API key was cleared, but restoring no-key mode failed. Please save settings again.')),
            );
          }
          return;
        }
      }

      await refreshPageData();
      if (clearGen === clearKeyGenRef.current) {
        setActiveModal(null);
        await loadProviderDetails(updatedProvider);
        if (clearGen === clearKeyGenRef.current) {
          setDetailNotice(
            restoreNoKeyMode
              ? t('已清除 API 密钥，已恢复无密钥模式', 'API key cleared; no-key mode restored')
              : t('已清除已保存的 API 密钥', 'Saved API key cleared'),
          );
        }
      }
    } catch (err) {
      if (clearGen === clearKeyGenRef.current) {
        setConfirmError(
          errorMessage(err, t('清除密钥失败，请刷新后重试', 'Failed to clear API key. Refresh and try again.')),
        );
      }
    } finally {
      if (clearGen === clearKeyGenRef.current) {
        setClearingKey(false);
      }
    }
  };

  // OAuth login flow polling
  const pollLoginFlow = useCallback(
    (providerId: string, nextFlowId: string) => {
      stopFlowPoll();
      const pollGen = flowGenRef.current;
      const tick = async () => {
        try {
          const state = await api.providerLoginStatus(providerId, nextFlowId);
          if (pollGen !== flowGenRef.current) return;
          setFlow(state);
          if (state.status === 'pending') {
            flowTimerRef.current = window.setTimeout(() => void tick(), 1200);
          } else if (state.status === 'complete') {
            setDetailNotice(t('OAuth 授权已完成', 'OAuth authorization completed'));
            const updatedProvider = await api.getProvider(providerId);
            if (pollGen !== flowGenRef.current) return;
            setEdit(updatedProvider);
            await refreshPageData();
            await loadProviderDetails(updatedProvider);
          } else if (state.error) {
            setDetailError(state.error);
          }
        } catch (err) {
          if (pollGen !== flowGenRef.current) return;
          setDetailError(
            errorMessage(err, t('获取授权进度失败，请重新发起 OAuth 登录', 'Failed to check authorization progress. Restart OAuth sign-in to retry.')),
          );
        }
      };
      void tick();
    },
    [api, loadProviderDetails, refreshPageData, stopFlowPoll, t],
  );

  const handleStartOAuth = async () => {
    if (!edit) return;
    setAuthBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const { flowId: nextId } = await api.providerLogin(edit.id);
      setFlowId(nextId);
      setFlow({ status: 'pending', events: [], prompt: null, error: null });
      pollLoginFlow(edit.id, nextId);
    } catch (err) {
      setDetailError(errorMessage(err, t('启动 OAuth 登录失败，请重试', 'Failed to start OAuth login. Please try again.')));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSubmitPrompt = async (answer: string) => {
    if (!edit || !flowId || !answer.trim()) return;
    setAuthBusy(true);
    setDetailError('');
    try {
      await api.providerLoginAnswer(edit.id, flowId, answer.trim());
      setPromptInput('');
      pollLoginFlow(edit.id, flowId);
    } catch (err) {
      setDetailError(errorMessage(err, t('提交授权码失败，请核对内容后重试', 'Failed to submit authorization code. Verify the input and retry.')));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleCancelOAuth = async () => {
    if (!edit || !flowId) return;
    stopFlowPoll();
    try {
      await api.providerLoginCancel(edit.id, flowId);
    } catch {
      // Ignore cancel cleanup errors
    }
    setFlowId(null);
    setFlow(null);
  };

  const handleOAuthLogout = async () => {
    if (!edit) return;
    setAuthBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const next = await api.providerLogout(edit.id);
      setAuthStatus(next);
      setAuthByProvider(prev => ({ ...prev, [edit.id]: next }));
      if (next.method === 'oauth') {
        setDetailError(t('退出 OAuth 授权未生效，请重试', 'OAuth sign-out did not take effect. Please try again.'));
      } else {
        setDetailNotice(t('已退出 OAuth 授权', 'Signed out of OAuth'));
        void refreshPageData().catch(() => {});
      }
    } catch (err) {
      setDetailError(errorMessage(err, t('退出授权失败，请重试', 'Failed to sign out. Please try again.')));
    } finally {
      setAuthBusy(false);
    }
  };

  // Single model management
  const handleToggleModelEnabled = async (model: Model, nextEnabled: boolean) => {
    if (!edit) return;
    setTogglingModelId(model.id);
    setDetailError('');
    try {
      const updated = await api.putModel(edit.id, model.id, {
        expectedRevision: model.revision,
        value: { ...model, enabled: nextEnabled },
      });
      setModels(prev => prev.map(m => (m.id === updated.id ? updated : m)));
      const pickerRes = await api.getModelPicker();
      setPicker(pickerRes);
      setModelCountByProvider(countModelsByProvider(pickerRes));
    } catch (err) {
      setDetailError(errorMessage(err, t('切换模型状态失败，请重试', 'Failed to update model status. Please retry.')));
    } finally {
      setTogglingModelId(null);
    }
  };

  const openAddModelModal = () => {
    setModelDraft({
      id: '',
      name: '',
      contextWindow: 262144,
      maxTokens: 16384,
      input: ['text'],
      reasoning: false,
      enabled: true,
      revision: 0,
    });
    setModelExtraJson('{}');
    setModelFormError('');
    setConfirmError('');
    setActiveModal({ kind: 'edit-model', creating: true });
  };

  const openEditModelModal = (model: Model) => {
    const { base, extraJson } = splitModelExtra(model);
    setModelDraft({ ...base });
    setModelExtraJson(extraJson);
    setModelFormError('');
    setConfirmError('');
    setActiveModal({ kind: 'edit-model', creating: false });
  };

  const handleSaveModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit || !modelDraft || activeModal?.kind !== 'edit-model') return;
    const isCreatingModel = activeModal.creating;
    const trimmedId = modelDraft.id.trim();
    if (!trimmedId) {
      setModelFormError(t('请填写模型 ID（例如 gpt-4.1），再点击保存。', 'Enter a model ID (e.g. gpt-4.1), then save again.'));
      return;
    }

    let extra: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(modelExtraJson || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setModelFormError(t('高级协议覆盖必须是 JSON 对象（例如 {}），请修正后再保存。', 'Advanced protocol overrides must be a JSON object (e.g. {}). Fix the value and save again.'));
        return;
      }
      extra = parsed as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : t('JSON 语法无效', 'Invalid JSON syntax');
      setModelFormError(t(`高级覆盖 JSON 解析失败（${reason}），请修正语法或恢复为 {}。`, `Invalid advanced overrides JSON (${reason}). Fix the syntax or reset to {}.`));
      return;
    }

    const payload: Model = {
      ...modelDraft,
      id: trimmedId,
      name: modelDraft.name.trim() || trimmedId,
      input: modelDraft.input.length > 0 ? modelDraft.input : ['text'],
      contextWindow: Number(modelDraft.contextWindow) || 262144,
      maxTokens: Number(modelDraft.maxTokens) || 16384,
    };
    for (const key of EXTRA_MODEL_KEYS) {
      if (key in extra) {
        (payload as unknown as Record<string, unknown>)[key] = extra[key];
      } else {
        delete (payload as unknown as Record<string, unknown>)[key];
      }
    }

    setModelSaving(true);
    setModelFormError('');
    try {
      if (isCreatingModel) {
        await api.createModel(edit.id, payload);
      } else {
        await api.putModel(edit.id, payload.id, {
          expectedRevision: modelDraft.revision,
          value: payload,
        });
      }
      setActiveModal(null);
      await loadProviderDetails(edit);
      await refreshPageData();
      setDetailNotice(
        isCreatingModel
          ? t(`已添加模型 ${payload.name}`, `Added model ${payload.name}`)
          : t(`已更新模型 ${payload.name}`, `Updated model ${payload.name}`),
      );
    } catch (err) {
      setModelFormError(
        errorMessage(err, t('保存模型失败，请检查模型参数后重试', 'Failed to save model. Check the model fields and try again.')),
      );
    } finally {
      setModelSaving(false);
    }
  };

  const handleDeleteModel = async (model: Model) => {
    if (!edit) return;
    setModelSaving(true);
    setConfirmError('');
    try {
      await api.deleteModel(edit.id, model.id);
      setActiveModal(null);
      await loadProviderDetails(edit);
      await refreshPageData();
      setDetailNotice(t(`已移除模型 ${model.name || model.id}`, `Removed model ${model.name || model.id}`));
    } catch (err) {
      setConfirmError(
        errorMessage(err, t('移除模型失败，请稍后重试', 'Failed to remove model. Please try again.')),
      );
    } finally {
      setModelSaving(false);
    }
  };

  // Discover / Restore models
  const runDiscoverFetch = async (provider: Provider, deviceId: string) => {
    const gen = ++discoverGenRef.current;
    setDiscoverFetching(true);
    setDiscoverFormError('');
    try {
      const req = buildDiscoverRequest(provider, {
        deviceId,
        apiKey: keyValue,
        customJson,
      });
      const res = await api.discoverModels(provider.id, req);
      if (gen !== discoverGenRef.current) return;
      const activeIds = new Set(models.map(m => m.id));
      const candidates = res.models.filter(m => !activeIds.has(m.id));
      setDiscoverTotalCount(res.models.length);
      setDiscovered(candidates);
      setSelectedIds(new Set(candidates.map(m => m.id)));
    } catch (err) {
      if (gen !== discoverGenRef.current) return;
      setDiscoverFormError(
        errorMessage(
          err,
          t('从接口拉取模型列表失败，请确认 API 密钥与接口地址有效后重试', 'Failed to fetch models from API. Verify the API key and URL, then try again.'),
        ),
      );
    } finally {
      if (gen === discoverGenRef.current) setDiscoverFetching(false);
    }
  };

  const handleSyncAntigravityModels = async () => {
    if (!edit || edit.id !== ANTIGRAVITY_PROVIDER_ID || discoverFetching) return;
    const target = edit;
    const gen = ++discoverGenRef.current;
    setDiscoverFetching(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const res = await api.discoverModels(target.id, {});
      if (gen !== discoverGenRef.current) return;
      await loadProviderDetails(target);
      await refreshPageData();
      if (gen !== discoverGenRef.current) return;
      setDetailNotice(
        t(`已同步并保存 ${res.models.length} 个 Antigravity 模型`, `Synced and saved ${res.models.length} Antigravity models`),
      );
    } catch (err) {
      if (gen !== discoverGenRef.current) return;
      setDetailError(
        errorMessage(
          err,
          t('拉取 Antigravity 模型列表失败，请确认 OAuth 已授权后重试', 'Failed to sync Antigravity models. Verify OAuth authorization and try again.'),
        ),
      );
    } finally {
      if (gen === discoverGenRef.current) setDiscoverFetching(false);
    }
  };

  const closeDiscoverModal = () => {
    discoverGenRef.current += 1;
    setDiscoverFetching(false);
    setDiscoverFormError('');
    setActiveModal(null);
  };

  const openDiscoverModal = () => {
    if (!edit) return;
    setDiscovered([]);
    setDiscoverTotalCount(0);
    setSelectedIds(new Set());
    setDiscoverQuery('');
    setDiscoverDeviceId('');
    setDiscoverFormError('');
    setActiveModal({ kind: 'discover', mode: 'remote' });
    void api.listDevices().then(setDevices).catch(() => {});
    void runDiscoverFetch(edit, '');
  };

  const openRestoreModal = () => {
    const candidates = removedModels.map(m => ({ ...m, removed: false, enabled: true }));
    setDiscoverTotalCount(candidates.length);
    setDiscovered(candidates);
    setSelectedIds(new Set(candidates.map(m => m.id)));
    setDiscoverQuery('');
    setDiscoverFormError('');
    setActiveModal({ kind: 'discover', mode: 'restore' });
  };

  const confirmBatchModels = async () => {
    if (!edit || selectedIds.size === 0 || activeModal?.kind !== 'discover') return;
    const target = edit;
    const mode = activeModal.mode;
    setDiscoverSaving(true);
    setDiscoverFormError('');
    const chosen = discovered
      .filter(m => selectedIds.has(m.id))
      .map(m => ({ ...m, enabled: true, removed: false, revision: 0 }));
    try {
      const { savedIds, failedError } = await saveModelsInChunks(chosen, batch =>
        api.createModelsBatch(target.id, { models: batch }),
      );
      if (failedError) {
        if (savedIds.length > 0) {
          const savedSet = new Set(savedIds);
          setDiscovered(prev => prev.filter(m => !savedSet.has(m.id)));
          setSelectedIds(prev => {
            const next = new Set(prev);
            for (const id of savedSet) next.delete(id);
            return next;
          });
          void loadProviderDetails(target).catch(() => {});
          void refreshPageData().catch(() => {});
        }
        const baseMsg = errorMessage(
          failedError,
          t('批量保存模型失败，请检查所选模型后重试', 'Failed to save selected models. Please try again.'),
        );
        setDiscoverFormError(
          savedIds.length > 0
            ? t(`已保存前 ${savedIds.length} 个模型，剩余模型保存失败：${baseMsg}`, `Saved the first ${savedIds.length} models, but remaining models failed: ${baseMsg}`)
            : baseMsg,
        );
        return;
      }
      if (!target.configured) {
        const updated = await api.putProvider(target.id, {
          expectedRevision: target.revision,
          value: { ...target, configured: true },
        });
        setEdit(updated);
      }
      setActiveModal(null);
      await loadProviderDetails(target);
      await refreshPageData();
      setDetailNotice(
        mode === 'restore'
          ? t(`已恢复并保存 ${chosen.length} 个模型`, `Restored and saved ${chosen.length} models`)
          : t(`已保存 ${chosen.length} 个模型`, `Saved ${chosen.length} models`),
      );
    } catch (err) {
      setDiscoverFormError(
        errorMessage(err, t('批量保存模型失败，请检查所选模型后重试', 'Failed to save selected models. Please try again.')),
      );
    } finally {
      setDiscoverSaving(false);
    }
  };

  const sortedProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase();
    return providers
      .filter(
        p =>
          (providerFilter === 'all' || p.enabled) &&
          (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const ra = providerSortRank(a);
        const rb = providerSortRank(b);
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });
  }, [providerFilter, providerQuery, providers]);

  const filteredDetailModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [modelQuery, models]);

  const filteredDiscovered = useMemo(() => {
    const q = discoverQuery.trim().toLowerCase();
    if (!q) return discovered;
    return discovered.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [discoverQuery, discovered]);

  const filteredDiscoveredIds = useMemo(
    () => filteredDiscovered.map(m => m.id),
    [filteredDiscovered],
  );

  const allVisibleDiscoveredSelected = useMemo(
    () => areAllVisibleSelected(selectedIds, filteredDiscoveredIds),
    [filteredDiscoveredIds, selectedIds],
  );

  const currentThinking: ThinkingChoice = (modelConfig?.global.thinkingLevel as ThinkingChoice | undefined) ?? '';
  const currentThinkingLabel =
    thinkingOptions.find(opt => opt.value === currentThinking)?.label ?? t('默认', 'Default');
  const currentCodeMode: CodeModeChoice = modelConfig?.global.codemodeOnly
    ? 'only'
    : modelConfig?.global.codemode
      ? 'on'
      : 'off';

  const isProviderReady = (p: Provider): boolean => {
    if (!p.enabled) return false;
    const auth = authByProvider[p.id];
    if (auth?.method === 'oauth') return true;
    if (p.id === ANTIGRAVITY_PROVIDER_ID) return false;
    return Boolean(p.configured || p.credentialRef);
  };

  const providerStatusSummary = (p: Provider): string => {
    const count = modelCountByProvider[p.id] ?? 0;
    const auth = authByProvider[p.id];
    const parts: string[] = [];
    if (auth?.method === 'oauth') {
      parts.push(t('OAuth 已授权', 'OAuth connected'));
    } else if (p.id === ANTIGRAVITY_PROVIDER_ID && auth && auth.method === 'none') {
      parts.push(t('未授权', 'Not authorized'));
    } else if (p.configured || p.credentialRef) {
      parts.push(t('已配置凭据', 'Credentials set'));
    } else {
      parts.push(t('未配置凭据', 'No credentials'));
    }
    if (p.enabled) {
      parts.push(t(`${count} 个已启用模型`, `${count} enabled ${count === 1 ? 'model' : 'models'}`));
    } else {
      parts.push(t('已停用', 'Disabled'));
    }
    return parts.join(' · ');
  };

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaCardSkeleton height={58} subbar label={t('正在加载模型与服务商配置…', 'Loading models and providers…')} />
        <CaSectionSkeleton rows={5} headWidth={128} trailingWidth={112} />
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

  const renderProviderDetail = () => {
    if (!edit) return null;

    const supportsOAuth = Boolean(
      !creating && (authStatus?.oauth || edit.id === ANTIGRAVITY_PROVIDER_ID),
    );
    const supportsApiKey =
      edit.id === ANTIGRAVITY_PROVIDER_ID
        ? false
        : !authStatus || authStatus.apiKey !== false;
    const collapseForOAuth = Boolean(!creating && edit.native && supportsOAuth);
    const hasCustomOverride = Boolean(
      edit.baseUrl.trim() || (customJson.trim() && customJson.trim() !== '{}'),
    );
    const enabledCount = models.filter(m => m.enabled).length;
    const providerReady = !creating && isProviderReady(edit);

    const baseUrlInputId = `${idPrefix}-provider-base-url`;
    const apiKeyInputId = `${idPrefix}-provider-api-key`;
    const customJsonInputId = `${idPrefix}-provider-custom-json`;
    const displayNameInputId = `${idPrefix}-provider-name`;
    const protocolSelectId = `${idPrefix}-provider-protocol`;
    const providerIdInputId = `${idPrefix}-provider-id`;

    const baseUrlField = (
      <div className="ca-field">
        <label className="ca-field-label" htmlFor={baseUrlInputId}>
          {t('API 地址 (Base URL)', 'API URL (Base URL)')}
        </label>
        <input
          id={baseUrlInputId}
          type="url"
          className="ca-input"
          disabled={savingProvider || clearingKey}
          placeholder={edit.native ? t('留空保持内置默认地址', 'Leave empty for built-in default URL') : 'https://api.example.com/v1'}
          value={edit.baseUrl}
          onChange={e => setEdit({ ...edit, baseUrl: e.target.value })}
        />
      </div>
    );

    const apiKeyField = supportsApiKey ? (
      <div className="ca-field">
        <div className="ca-field-head">
          <label className="ca-field-label" htmlFor={apiKeyInputId}>API Key</label>
          <div className="ca-inline-row">
            <span className={`ca-pill ${credential?.configured ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
              {credential?.configured ? t('已保存密钥（不回显）', 'Key saved (hidden)') : t('未配置密钥', 'No key set')}
            </span>
            {!creating && edit.credentialRef && credential?.configured && (
              <button
                type="button"
                className="ca-btn ca-btn-danger ca-btn-sm"
                disabled={savingProvider || validatingProvider || clearingKey}
                onClick={() => {
                  setConfirmError('');
                  setActiveModal({ kind: 'confirm-clear-key' });
                }}
              >
                {t('清除密钥', 'Clear key')}
              </button>
            )}
          </div>
        </div>
        <input
          id={apiKeyInputId}
          type="password"
          className="ca-input"
          autoComplete="new-password"
          disabled={savingProvider || clearingKey}
          placeholder={credential?.configured ? t('输入新密钥以替换现有密钥', 'Enter a new key to replace the existing one') : t('粘贴 API Key', 'Paste API Key')}
          value={keyValue}
          onChange={e => setKeyValue(e.target.value)}
        />
      </div>
    ) : null;

    const customJsonField = (
      <div className="ca-field">
        <label className="ca-field-label" htmlFor={customJsonInputId}>
          {t('高级协议覆盖 (models.json)', 'Advanced protocol overrides (models.json)')}
        </label>
        <textarea
          id={customJsonInputId}
          rows={4}
          className="ca-textarea ca-mono"
          disabled={savingProvider || clearingKey}
          value={customJson}
          onChange={e => setCustomJson(e.target.value)}
        />
        <p className="ca-field-help">
          {t('对应 Pi models.json 服务商级附加字段（如 headers、compat）；保持 {} 即可。', 'Maps to Pi models.json provider-level extra fields (e.g. headers, compat); leave as {} if unused.')}
        </p>
      </div>
    );

    const saveActionLabel = creating ? t('创建并验证', 'Create & verify') : t('保存并验证', 'Save & verify');
    const savingActionLabel = creating ? t('创建中…', 'Creating…') : t('保存中…', 'Saving…');

    const providerActionRow = (
      <div className="ca-inline-between ca-provider-form-actions">
        <div>
          {!creating && (
            <button
              type="button"
              className="ca-btn ca-btn-danger ca-btn-sm"
              disabled={savingProvider || validatingProvider}
              onClick={() => {
                setConfirmError('');
                setActiveModal({ kind: 'confirm-delete-provider' });
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
              <span>{edit.native ? t('重置配置', 'Reset settings') : t('删除服务商', 'Delete provider')}</span>
            </button>
          )}
        </div>
        <div className="ca-inline-row">
          {!creating && (
            <button
              type="button"
              className="ca-btn ca-btn-sm"
              disabled={savingProvider || validatingProvider}
              onClick={() => void handleValidateOnly()}
            >
              <LabelStack
                active={validatingProvider ? t('验证中…', 'Verifying…') : t('验证连接', 'Verify connection')}
                labels={[t('验证连接', 'Verify connection'), t('验证中…', 'Verifying…')]}
              />
            </button>
          )}
          <button
            type="button"
            className="ca-btn ca-btn-primary ca-btn-sm"
            disabled={savingProvider || validatingProvider}
            onClick={() => void persistProvider(true)}
          >
            <LabelStack
              active={savingProvider ? savingActionLabel : saveActionLabel}
              labels={[saveActionLabel, savingActionLabel]}
            />
          </button>
        </div>
      </div>
    );

    const connectionSection = collapseForOAuth ? (
      <details
        key={edit.id}
        className="ca-section ca-advanced-collapse"
        open={advancedOpen}
        onToggle={e => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary className="ca-advanced-summary">{t('高级连接与协议覆盖', 'Advanced connection & protocol overrides')}</summary>
        <div className="ca-advanced-body ca-form-stack">
          {baseUrlField}
          {apiKeyField}
          {customJsonField}
          {providerActionRow}
        </div>
      </details>
    ) : (
      <section className="ca-section">
        <div className="ca-section-head">
          <h3 className="ca-section-title">
            {creating ? t('服务商配置', 'Provider configuration') : t('连接与凭据', 'Connection & credentials')}
          </h3>
        </div>
        <div className="ca-section-body ca-form-stack">
          {!edit.native && (
            <>
              <div className="ca-grid-2">
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor={displayNameInputId}>{t('显示名称', 'Display name')}</label>
                  <input
                    id={displayNameInputId}
                    type="text"
                    className="ca-input"
                    disabled={savingProvider || clearingKey}
                    placeholder={t('如 SiliconFlow / 本地 Ollama', 'e.g. SiliconFlow / Local Ollama')}
                    value={edit.name}
                    onChange={e => setEdit({ ...edit, name: e.target.value })}
                  />
                </div>
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor={protocolSelectId}>{t('API 协议', 'API protocol')}</label>
                  <select
                    id={protocolSelectId}
                    className="ca-select"
                    disabled={savingProvider || clearingKey}
                    value={edit.api}
                    onChange={e => setEdit({ ...edit, api: e.target.value })}
                  >
                    {API_PROTOCOLS.map(p => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {creating && (
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor={providerIdInputId}>{t('服务商 ID（可选）', 'Provider ID (optional)')}</label>
                  <input
                    id={providerIdInputId}
                    type="text"
                    className="ca-input ca-mono"
                    disabled={savingProvider || clearingKey}
                    placeholder={t('留空则按名称自动生成', 'Leave blank to generate from name')}
                    value={edit.id}
                    onChange={e => {
                      setCustomIdEdited(true);
                      setEdit({ ...edit, id: e.target.value });
                    }}
                  />
                </div>
              )}
              {baseUrlField}
            </>
          )}

          {apiKeyField}

          {edit.native ? (
            <CaDisclosure
              key={`${edit.id}-adv`}
              title={t('自定义接口地址与协议覆盖', 'Custom API URL & protocol overrides')}
              defaultOpen={hasCustomOverride}
            >
              <div className="ca-form-stack">
                {baseUrlField}
                {customJsonField}
              </div>
            </CaDisclosure>
          ) : (
            <CaDisclosure
              key={`${edit.id}-json`}
              title={t('高级协议覆盖 (models.json)', 'Advanced protocol overrides (models.json)')}
              defaultOpen={Boolean(customJson.trim() && customJson.trim() !== '{}')}
            >
              {customJsonField}
            </CaDisclosure>
          )}

          {providerActionRow}
        </div>
      </section>
    );

    const isAntigravityProvider = edit.id === ANTIGRAVITY_PROVIDER_ID;

    const modelsSection = !creating ? (
      <section className="ca-section">
        <div className="ca-section-head ca-models-head">
          <div className="ca-models-head-top ca-models-toolbar">
            <h3 className="ca-section-title">
              {t(`模型列表 (${enabledCount}/${models.length})`, `Models (${enabledCount}/${models.length})`)}
            </h3>
            <div className="ca-inline-row ca-models-actions">
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                disabled={isAntigravityProvider && discoverFetching}
                onClick={() => {
                  if (isAntigravityProvider) void handleSyncAntigravityModels();
                  else openDiscoverModal();
                }}
              >
                {isAntigravityProvider ? (
                  <LabelStack
                    active={discoverFetching ? t('拉取中…', 'Fetching…') : t('拉取模型', 'Discover models')}
                    labels={[t('拉取模型', 'Discover models'), t('拉取中…', 'Fetching…')]}
                  />
                ) : (
                  t('拉取模型', 'Discover models')
                )}
              </button>
              {removedModels.length > 0 && (
                <button type="button" className="ca-btn ca-btn-sm" onClick={openRestoreModal}>
                  <RotateCcw size={13} aria-hidden="true" />
                  <span>{t(`恢复 (${removedModels.length})`, `Restore (${removedModels.length})`)}</span>
                </button>
              )}
              <button type="button" className="ca-btn ca-btn-sm" onClick={openAddModelModal}>
                <Plus size={13} aria-hidden="true" />
                <span>{t('新增模型', 'Add model')}</span>
              </button>
            </div>
          </div>
          {(models.length > 0 || Boolean(modelQuery)) && (
            <div className="ca-models-search">
              <Search size={14} className="ca-models-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="ca-input"
                placeholder={t('筛选模型名称或 ID…', 'Filter model name or ID…')}
                value={modelQuery}
                onChange={e => setModelQuery(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="ca-list">
          {detailLoading && models.length === 0 ? (
            <div className="ca-empty">{t('正在加载模型列表…', 'Loading models…')}</div>
          ) : filteredDetailModels.length === 0 ? (
            <div className="ca-empty">
              {models.length === 0
                ? t('暂无模型，点击「拉取模型」或「新增模型」添加', 'No models yet. Click "Discover models" or "Add model" to add some.')
                : t('没有匹配的模型', 'No matching models')}
            </div>
          ) : (
            filteredDetailModels.map(m => {
              const ref = `${edit.id}/${m.id}`;
              const isStarred = starredSet.has(ref);
              return (
                <div key={m.id} className="ca-row ca-row-split ca-model-row">
                  <button
                    type="button"
                    className="ca-row-main ca-row-trigger"
                    onClick={() => openEditModelModal(m)}
                  >
                    <span className="ca-row-title ca-model-row-title">
                      <span className={`ca-dot ${m.enabled ? 'is-online' : ''}`} aria-hidden="true" />
                      <span className="ca-model-row-name">{m.name || m.id}</span>
                      {m.reasoning && <span className="ca-pill ca-pill-info">{t('推理', 'Reasoning')}</span>}
                    </span>
                    <span className="ca-row-sub ca-mono ca-num">
                      {m.id} · {Math.round(m.contextWindow / 1000)}k / {Math.round(m.maxTokens / 1000)}k
                    </span>
                  </button>
                  <div className="ca-row-actions">
                    <button
                      type="button"
                      className="ca-btn ca-btn-ghost ca-btn-icon"
                      aria-label={isStarred ? t('取消收藏', 'Unstar') : t('收藏', 'Star')}
                      onClick={() => void handleToggleStar(ref, !isStarred)}
                    >
                      <Star
                        size={14}
                        className={isStarred ? 'ca-star-icon is-starred' : 'ca-star-icon'}
                        fill={isStarred ? 'currentColor' : 'none'}
                      />
                    </button>
                    <CaSwitch
                      checked={m.enabled}
                      disabled={togglingModelId === m.id}
                      label={t(`启用模型 ${m.name || m.id}`, `Enable model ${m.name || m.id}`)}
                      onChange={next => void handleToggleModelEnabled(m, next)}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    ) : null;

    return (
      <div className="ca-form-stack">
        {/* In-page detail header bar */}
        <div className="ca-toolbar">
          <button
            type="button"
            className="ca-btn ca-btn-ghost ca-btn-sm"
            onClick={closeProviderDetail}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            <span>{t('返回服务商列表', 'Back to Providers')}</span>
          </button>
          {!creating && (
            <div className="ca-inline-row">
              <span className="ca-muted">{edit.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span>
              <CaSwitch
                checked={edit.enabled}
                disabled={togglingProviderId === edit.id || savingProvider}
                label={t(`启用 ${edit.name || edit.id}`, `Enable ${edit.name || edit.id}`)}
                onChange={next => void handleToggleProviderRow(edit, next)}
              />
            </div>
          )}
        </div>

        {/* Provider identity summary */}
        <section className="ca-section">
          <div className="ca-default-card">
            <div className="ca-row-main">
              <div className="ca-row-title">
                {!creating && <span className={`ca-dot ${providerReady ? 'is-online' : ''}`} aria-hidden="true" />}
                <span>
                  {creating
                    ? t('添加自定义服务商', 'Add custom provider')
                    : edit.name || edit.id}
                </span>
                {!creating && !edit.native && (
                  <span className="ca-pill ca-pill-muted">{t('自定义', 'Custom')}</span>
                )}
                {!creating && edit.id === ANTIGRAVITY_PROVIDER_ID && (
                  <span className="ca-pill ca-pill-info">Antigravity</span>
                )}
              </div>
              <div className="ca-row-sub ca-num">
                {creating
                  ? t('填写兼容接口地址与密钥后，即可保存并拉取可用模型', 'Enter a compatible API URL and key to save and discover available models')
                  : `${edit.id} · ${providerStatusSummary(edit)}`}
              </div>
            </div>
          </div>
        </section>

        {detailError && <CaNotice tone="danger">{detailError}</CaNotice>}
        {detailNotice && <CaNotice tone="ok">{detailNotice}</CaNotice>}

        {/* OAuth / Antigravity authorization */}
        {supportsOAuth && (
          <section className="ca-section ca-oauth-card">
            <div className="ca-oauth-head">
              <div className="ca-oauth-head-main">
                <div className="ca-field-label">{t('OAuth 账号授权', 'OAuth account authorization')}</div>
                <div className="ca-muted">
                  {flow?.status === 'pending'
                    ? t('正在等待浏览器完成登录授权…', 'Waiting for browser authorization…')
                    : authStatus?.method === 'oauth'
                      ? t('已通过 OAuth 授权登录', 'Authorized via OAuth')
                      : authStatus?.label
                        ? t(`未授权 · 可${authStatus.label}`, `Not authorized · ${authStatus.label}`)
                        : t('尚未登录', 'Not signed in')}
                </div>
              </div>
              <div className="ca-inline-row">
                {flow?.status === 'pending' ? (
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => void handleCancelOAuth()}
                  >
                    {t('取消授权', 'Cancel authorization')}
                  </button>
                ) : authStatus?.method === 'oauth' ? (
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    disabled={authBusy}
                    onClick={() => void handleOAuthLogout()}
                  >
                    {t('退出授权', 'Sign out')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    disabled={authBusy}
                    onClick={() => void handleStartOAuth()}
                  >
                    {t('登录 OAuth 授权', 'Sign in with OAuth')}
                  </button>
                )}
              </div>
            </div>

            {flow && flow.status === 'pending' && (
              <div className="ca-oauth-flow">
                {flow.events.length === 0 && !flow.prompt && (
                  <div className="ca-muted">{t('正在获取授权链接…', 'Fetching authorization link…')}</div>
                )}

                {flow.events.map((ev, idx) => {
                  const targetUrl = ev.url || ev.verificationUri;
                  if (targetUrl) {
                    return (
                      <div key={idx} className="ca-oauth-step">
                        <div className="ca-oauth-step-label">
                          {ev.instructions || ev.message || t('1. 点击下方链接在系统默认浏览器中完成登录：', '1. Open the link below in your browser to sign in:')}
                        </div>
                        {ev.userCode && (
                          <div className="ca-inline-row ca-wrap">
                            <span className="ca-muted">{t('一次性验证码：', 'One-time code:')}</span>
                            <span className="ca-pill ca-pill-info ca-mono">{ev.userCode}</span>
                            <CopyButton value={ev.userCode} label={t('复制验证码', 'Copy code')} />
                          </div>
                        )}
                        <div className="ca-oauth-url-row">
                          <a
                            href={targetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ca-oauth-link"
                            onClick={e => {
                              e.preventDefault();
                              void openExternalUrl(targetUrl, onOpenExternalUrl).catch(err =>
                                setDetailError(
                                  errorMessage(err, t('无法打开系统默认浏览器，请复制链接手动打开', 'Could not open browser; please copy and open the link manually')),
                                ),
                              );
                            }}
                          >
                            {targetUrl}
                          </a>
                          <CopyButton value={targetUrl} />
                        </div>
                        {ev.links?.map((lk, lIdx) => (
                          <div key={lIdx}>
                            <a
                              href={lk.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ca-oauth-inline-link"
                              onClick={e => {
                                e.preventDefault();
                                void openExternalUrl(lk.url, onOpenExternalUrl).catch(err =>
                                  setDetailError(errorMessage(err, t('无法打开系统默认浏览器，请复制链接手动打开', 'Could not open system browser; copy and open manually'))),
                                );
                              }}
                            >
                              {lk.label || lk.url}
                            </a>
                          </div>
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div key={idx} className="ca-oauth-step">
                      {ev.message && <div className="ca-oauth-msg">{ev.message}</div>}
                      {ev.instructions && <div className="ca-oauth-hint">{ev.instructions}</div>}
                      {ev.userCode && (
                        <div className="ca-inline-row ca-wrap">
                          <span className="ca-muted">{t('一次性验证码：', 'One-time code:')}</span>
                          <span className="ca-pill ca-pill-info ca-mono">{ev.userCode}</span>
                          <CopyButton value={ev.userCode} label={t('复制验证码', 'Copy code')} />
                        </div>
                      )}
                      {ev.links?.map((lk, lIdx) => (
                        <div key={lIdx}>
                          <a
                            href={lk.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ca-oauth-inline-link"
                            onClick={e => {
                              e.preventDefault();
                              void openExternalUrl(lk.url, onOpenExternalUrl).catch(err =>
                                setDetailError(errorMessage(err, t('无法打开系统默认浏览器，请复制链接手动打开', 'Could not open system browser; copy and open manually'))),
                              );
                            }}
                          >
                            {lk.label || lk.url}
                          </a>
                        </div>
                      ))}
                    </div>
                  );
                })}

                {flow.prompt && (
                  <div className="ca-oauth-step ca-oauth-prompt">
                    {flow.prompt.options && flow.prompt.options.length > 0 ? (
                      <>
                        <div className="ca-oauth-step-label">
                          {flow.prompt.message || t('请选择登录授权方式：', 'Choose an authorization method:')}
                        </div>
                        <div className="ca-inline-row ca-wrap">
                          {flow.prompt.options.map(opt => (
                            <button
                              key={opt.id}
                              type="button"
                              className="ca-btn ca-btn-sm"
                              disabled={authBusy}
                              onClick={() => void handleSubmitPrompt(opt.id)}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="ca-oauth-step-label">
                          {flow.prompt.message
                            ? flow.prompt.message.startsWith('2.')
                              ? flow.prompt.message
                              : `2. ${flow.prompt.message}`
                            : t('2. 粘贴授权码或跳转后的完整回调地址：', '2. Paste the authorization code or full callback URL:')}
                        </div>
                        <form
                          className="ca-oauth-input-row"
                          onSubmit={e => {
                            e.preventDefault();
                            if (!authBusy && promptInput.trim()) {
                              void handleSubmitPrompt(promptInput);
                            }
                          }}
                        >
                          <input
                            type="text"
                            className="ca-input"
                            placeholder={flow.prompt.placeholder || t('粘贴授权码或回调 URL', 'Paste authorization code or callback URL')}
                            value={promptInput}
                            onChange={e => setPromptInput(e.target.value)}
                          />
                          <button
                            type="submit"
                            className="ca-btn ca-btn-primary ca-btn-sm"
                            disabled={authBusy || !promptInput.trim()}
                          >
                            {t('提交授权码', 'Submit code')}
                          </button>
                        </form>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {collapseForOAuth ? (
          <>
            {modelsSection}
            {connectionSection}
          </>
        ) : (
          <>
            {connectionSection}
            {modelsSection}
          </>
        )}
      </div>
    );
  };

  const renderOverview = () => (
    <>
      {/* 1. Top Live Readiness card: global default model + thinking level */}
      <section className="ca-section">
        <div className="ca-default-card">
          <div className="ca-row-main">
            <div className="ca-row-title">
              <span className={`ca-dot ${currentDefaultItem ? 'is-online' : ''}`} aria-hidden="true" />
              <span>{t('全局默认模型', 'Global default model')}</span>
              {currentDefaultItem ? (
                <span className="ca-pill ca-pill-ok">{currentDefaultItem.name}</span>
              ) : currentGlobalModelRef ? (
                <span className="ca-pill ca-pill-muted">{currentGlobalModelRef}</span>
              ) : (
                <span className="ca-pill ca-pill-warn">{t('未设置', 'Not set')}</span>
              )}
            </div>
            <div className="ca-row-sub ca-num">
              {currentDefaultItem
                ? currentDefaultItem.reasoning
                  ? t(`${currentDefaultItem.modelRef} · 上下文 ${Math.round(currentDefaultItem.contextWindow / 1000)}k · 思考强度 ${currentThinkingLabel}`, `${currentDefaultItem.modelRef} · ${Math.round(currentDefaultItem.contextWindow / 1000)}k context · Thinking: ${currentThinkingLabel}`)
                  : t(`${currentDefaultItem.modelRef} · 上下文 ${Math.round(currentDefaultItem.contextWindow / 1000)}k`, `${currentDefaultItem.modelRef} · ${Math.round(currentDefaultItem.contextWindow / 1000)}k context`)
                : currentGlobalModelRef
                  ? t(`${currentGlobalModelRef} · 当前未启用，请重新选择默认模型`, `${currentGlobalModelRef} · Currently unavailable; select another default model`)
                  : t('未单独指定模型的 Bot 将默认使用此模型', 'Bots without a dedicated model will use this default')}
            </div>
          </div>
          <div className="ca-row-actions">
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              onClick={() => {
                setPickerFilter('all');
                setPickerQuery('');
                setPickerError('');
                setActiveModal({ kind: 'default-picker' });
              }}
            >
              {t('切换默认模型', 'Change default')}
            </button>
          </div>
        </div>

        {/* Thinking level chips when current default model supports reasoning */}
        {currentDefaultItem?.reasoning && (
          <div className="ca-default-subbar">
            <span className="ca-field-label">{t('思考强度', 'Thinking level')}</span>
            <CaChips
              value={currentThinking}
              options={thinkingOptions}
              ariaLabel={t('思考强度', 'Thinking level')}
              onChange={val => {
                if (pickerBusy) return;
                void saveGlobalSelection({ thinkingLevel: val || null }, t('思考强度已保存', 'Thinking level saved'));
              }}
            />
          </div>
        )}

        {/* Quiet disclosure for tool calling mode & catalog sync */}
        <div className="ca-default-disclosure-wrap">
          <CaDisclosure title={t('工具调用与模型目录同步', 'Tool calling & catalog sync')}>
            <div className="ca-form-stack">
              <div className="ca-inline-between ca-wrap">
                <div>
                  <div className="ca-field-label">{t('工具调用模式', 'Tool calling mode')}</div>
                  <div className="ca-muted">{t('控制模型通过标准 Function Calling 还是代码沙箱执行工具', 'Control whether models call tools via standard Function Calling or code sandbox')}</div>
                </div>
                <CaSegmented
                  value={currentCodeMode}
                  options={codeModeOptions}
                  ariaLabel={t('工具调用模式', 'Tool calling mode')}
                  onChange={val => {
                    if (pickerBusy) return;
                    void saveGlobalSelection(
                      {
                        codemode: val === 'on' || val === 'only',
                        codemodeOnly: val === 'only',
                      },
                      t('工具调用模式已更新', 'Tool calling mode updated'),
                    );
                  }}
                />
              </div>

              <div className="ca-inline-between ca-wrap">
                <div>
                  <div className="ca-field-label">{t('内置模型目录同步', 'Built-in model catalog sync')}</div>
                  <div className="ca-muted">
                    {t('最近同步：', 'Last synced: ')}
                    {picker?.sync.syncedAt ? formatTime(picker.sync.syncedAt, locale) : t('尚未同步', 'Not synced yet')}
                    {picker?.sync.error ? t(`（${picker.sync.error}）`, ` (${picker.sync.error})`) : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={syncBusy}
                  onClick={() => void handleSyncCatalog()}
                >
                  <RefreshCw size={13} className={syncBusy ? 'ca-spin' : undefined} aria-hidden="true" />
                  <LabelStack
                    active={syncBusy ? t('同步中…', 'Syncing…') : t('同步目录', 'Sync catalog')}
                    labels={[t('同步目录', 'Sync catalog'), t('同步中…', 'Syncing…')]}
                  />
                </button>
              </div>
            </div>
          </CaDisclosure>
        </div>
      </section>

      {/* 2. Scannable Providers list */}
      <section className="ca-section">
        <div className="ca-section-head">
          <div className="ca-inline-row">
            <h3 className="ca-section-title">{t('模型服务商', 'Model providers')}</h3>
            <CaSegmented
              value={providerFilter}
              ariaLabel={t('服务商筛选', 'Filter providers')}
              options={[
                { value: 'enabled', label: t('已启用', 'Enabled') },
                { value: 'all', label: t('全部', 'All') },
              ]}
              onChange={setProviderFilter}
            />
          </div>
          <div className="ca-toolbar-group ca-provider-toolbar">
            <div className="ca-inline-row ca-provider-search">
              <Search size={14} className="ca-provider-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="ca-input"
                placeholder={t('筛选服务商…', 'Filter providers…')}
                value={providerQuery}
                onChange={e => setProviderQuery(e.target.value)}
              />
            </div>
            <button type="button" className="ca-btn ca-btn-sm" onClick={openCreateProvider}>
              <Plus size={14} aria-hidden="true" />
              <span>{t('添加自定义服务商', 'Add custom provider')}</span>
            </button>
          </div>
        </div>

        <div className="ca-list">
          {sortedProviders.length === 0 ? (
            <div className="ca-empty">
              {providerFilter === 'enabled' && !providerQuery.trim()
                ? t('暂无已启用的服务商。切换到「全部」可查看并启用。', 'No enabled providers yet. Switch to "All" to view and enable providers.')
                : t('没有匹配的服务商', 'No matching providers')}
            </div>
          ) : (
            sortedProviders.map(provider => {
              const ready = isProviderReady(provider);
              return (
                <div key={provider.id} className="ca-row ca-row-split">
                  <button
                    type="button"
                    className="ca-row-main ca-row-trigger"
                    onClick={() => openExistingProvider(provider)}
                  >
                    <span className="ca-row-title">
                      <span className={`ca-dot ${ready ? 'is-online' : ''}`} aria-hidden="true" />
                      <span>{provider.name || provider.id}</span>
                      {!provider.native && <span className="ca-pill ca-pill-muted">{t('自定义', 'Custom')}</span>}
                      {provider.id === ANTIGRAVITY_PROVIDER_ID && (
                        <span className="ca-pill ca-pill-info">Antigravity</span>
                      )}
                    </span>
                    <span className="ca-row-sub ca-num">{providerStatusSummary(provider)}</span>
                  </button>
                  <div className="ca-row-actions">
                    <CaSwitch
                      checked={provider.enabled}
                      disabled={togglingProviderId === provider.id}
                      label={t(`启用 ${provider.name || provider.id}`, `Enable ${provider.name || provider.id}`)}
                      onChange={next => void handleToggleProviderRow(provider, next)}
                    />
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      onClick={() => openExistingProvider(provider)}
                    >
                      {t('配置', 'Manage')}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );

  const editModelModalOpen = activeModal?.kind === 'edit-model';
  const editModelCreating = activeModal?.kind === 'edit-model' ? activeModal.creating : false;
  const discoverModalOpen = activeModal?.kind === 'discover';
  const discoverMode = activeModal?.kind === 'discover' ? activeModal.mode : 'remote';
  const deleteModelTarget = activeModal?.kind === 'confirm-delete-model' ? activeModal : null;

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      {inDetailView ? renderProviderDetail() : renderOverview()}

      {/* Single top-level modal slot: Global Default Model Picker */}
      <CaModal
        open={activeModal?.kind === 'default-picker'}
        onOpenChange={open => {
          if (!open && !pickerBusy) {
            setPickerError('');
            setActiveModal(null);
          }
        }}
        title={t('选择全局默认模型', 'Select global default model')}
        description={t('默认显示全部可用模型，收藏模型自动置顶', 'Shows all available models by default with starred models pinned at the top')}
        variant="modal"
      >
        <div className="ca-form-stack">
          {pickerError && <CaNotice tone="danger">{pickerError}</CaNotice>}
          <div className="ca-inline-between ca-wrap ca-picker-bar">
            <CaSegmented
              value={pickerFilter}
              ariaLabel={t('模型筛选', 'Filter models')}
              options={[
                { value: 'all', label: t('全部', 'All') },
                { value: 'starred', label: t(`★ 收藏 (${picker?.starredModels.length ?? 0})`, `★ Starred (${picker?.starredModels.length ?? 0})`) },
              ]}
              onChange={setPickerFilter}
            />
            <input
              type="search"
              className="ca-input ca-picker-search"
              placeholder={t('搜索模型名称或 ID…', 'Search model name or ID…')}
              value={pickerQuery}
              onChange={e => setPickerQuery(e.target.value)}
            />
          </div>

          <div className="ca-model-list">
            {sortedPickerModels.length === 0 ? (
              <div className="ca-empty">
                {pickerFilter === 'starred'
                  ? t('暂无收藏模型，可切回「全部」查看', 'No starred models yet. Switch back to "All" to browse.')
                  : t('暂无可用模型，请先配置并启用服务商', 'No available models. Configure and enable a provider first.')}
              </div>
            ) : (
              sortedPickerModels.map(item => {
                const isSelected = item.modelRef === currentGlobalModelRef;
                const isStarred = starredSet.has(item.modelRef);
                return (
                  <div
                    key={item.modelRef}
                    className={`ca-model-option ca-model-option-split ${isSelected ? 'is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="ca-model-option-trigger"
                      disabled={pickerBusy}
                      onClick={() => {
                        if (pickerBusy) return;
                        void saveGlobalSelection(
                          { modelRef: item.modelRef },
                          t(`默认模型已切换为 ${item.name}`, `Default model switched to ${item.name}`),
                          { reportInlinePicker: true },
                        ).then(ok => {
                          if (ok) setActiveModal(null);
                        });
                      }}
                    >
                      <span className="ca-inline-row">
                        <span>{item.name}</span>
                        {item.reasoning && <span className="ca-pill ca-pill-info">{t('推理', 'Reasoning')}</span>}
                        {isSelected && <Check size={14} aria-hidden="true" />}
                      </span>
                      <span className="ca-muted ca-mono">{item.modelRef}</span>
                    </button>
                    <button
                      type="button"
                      className="ca-btn ca-btn-ghost ca-btn-icon"
                      aria-label={isStarred ? t('取消收藏', 'Unstar model') : t('收藏模型', 'Star model')}
                      onClick={() => void handleToggleStar(item.modelRef, !isStarred)}
                    >
                      <Star
                        size={14}
                        className={isStarred ? 'ca-star-icon is-starred' : 'ca-star-icon'}
                        fill={isStarred ? 'currentColor' : 'none'}
                      />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </CaModal>

      {/* Single top-level modal slot: Add / Edit Model */}
      <CaModal
        open={editModelModalOpen}
        onOpenChange={open => {
          if (!open && !modelSaving) {
            setModelFormError('');
            setActiveModal(null);
          }
        }}
        title={
          editModelCreating
            ? t('新增模型', 'Add model')
            : t(`编辑模型 · ${modelDraft?.name || modelDraft?.id || ''}`, `Edit model · ${modelDraft?.name || modelDraft?.id || ''}`)
        }
        variant="modal"
      >
        {modelDraft && (
          <form className="ca-form-stack" onSubmit={e => void handleSaveModel(e)}>
            {modelFormError && <CaNotice tone="danger">{modelFormError}</CaNotice>}

            <div className="ca-field">
              <label className="ca-field-label" htmlFor={`${idPrefix}-model-id`}>
                {t('模型 ID', 'Model ID')} <span className="ca-req">*</span>
              </label>
              <input
                id={`${idPrefix}-model-id`}
                type="text"
                className="ca-input ca-mono"
                disabled={!editModelCreating || modelSaving}
                required
                placeholder={t('如 gpt-4.1 / claude-sonnet-4', 'e.g. gpt-4.1 / claude-sonnet-4')}
                value={modelDraft.id}
                onChange={e => setModelDraft({ ...modelDraft, id: e.target.value })}
              />
            </div>

            <div className="ca-field">
              <label className="ca-field-label" htmlFor={`${idPrefix}-model-name`}>{t('显示名称（可选）', 'Display name (optional)')}</label>
              <input
                id={`${idPrefix}-model-name`}
                type="text"
                className="ca-input"
                disabled={modelSaving}
                placeholder={t('留空默认使用模型 ID', 'Leave empty to use model ID')}
                value={modelDraft.name}
                onChange={e => setModelDraft({ ...modelDraft, name: e.target.value })}
              />
            </div>

            <div className="ca-inline-between">
              <span className="ca-field-label">{t('支持深度推理 (Reasoning)', 'Supports reasoning')}</span>
              <CaSwitch
                checked={modelDraft.reasoning}
                disabled={modelSaving}
                label={t('支持深度推理 (Reasoning)', 'Supports reasoning')}
                onChange={next => setModelDraft({ ...modelDraft, reasoning: next })}
              />
            </div>

            <div className="ca-field">
              <span id={`${idPrefix}-model-modalities`} className="ca-field-label">{t('输入模态', 'Input modalities')}</span>
              <div className="ca-check-group" role="group" aria-labelledby={`${idPrefix}-model-modalities`}>
                {(['text', 'image', 'audio'] as const).map(mod => {
                  const label = mod === 'text' ? t('文本', 'Text') : mod === 'image' ? t('图片', 'Image') : t('音频', 'Audio');
                  const checked = modelDraft.input.includes(mod);
                  return (
                    <label key={mod} className="ca-check-label">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={modelSaving}
                        onChange={ev => {
                          const next = new Set(modelDraft.input);
                          if (ev.target.checked) next.add(mod);
                          else next.delete(mod);
                          setModelDraft({ ...modelDraft, input: [...next] });
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <CaDisclosure title={t('Token 上限（默认 256k / 16k）', 'Token limits (default 256k / 16k)')}>
              <div className="ca-grid-2">
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor={`${idPrefix}-model-ctx`}>{t('上下文窗口', 'Context window')}</label>
                  <input
                    id={`${idPrefix}-model-ctx`}
                    type="number"
                    className="ca-input ca-num"
                    disabled={modelSaving}
                    value={modelDraft.contextWindow}
                    onChange={e =>
                      setModelDraft({ ...modelDraft, contextWindow: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor={`${idPrefix}-model-max-tokens`}>{t('最大输出 Token', 'Max output tokens')}</label>
                  <input
                    id={`${idPrefix}-model-max-tokens`}
                    type="number"
                    className="ca-input ca-num"
                    disabled={modelSaving}
                    value={modelDraft.maxTokens}
                    onChange={e =>
                      setModelDraft({ ...modelDraft, maxTokens: Number(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
            </CaDisclosure>

            <CaDisclosure title={t('高级协议覆盖 (models.json)', 'Advanced protocol overrides (models.json)')}>
              <label htmlFor={`${idPrefix}-model-extra-json`} className="sr-only">
                {t('高级协议覆盖 (models.json)', 'Advanced protocol overrides (models.json)')}
              </label>
              <textarea
                id={`${idPrefix}-model-extra-json`}
                rows={4}
                className="ca-textarea ca-mono"
                disabled={modelSaving}
                value={modelExtraJson}
                onChange={e => setModelExtraJson(e.target.value)}
              />
            </CaDisclosure>

            <div className="ca-form-actions ca-form-actions-between">
              <div>
                {!editModelCreating && (
                  <button
                    type="button"
                    className="ca-btn ca-btn-danger ca-btn-sm"
                    disabled={modelSaving}
                    onClick={() => {
                      setConfirmError('');
                      setActiveModal({ kind: 'confirm-delete-model', model: modelDraft, returnToEdit: true });
                    }}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span>{t('移除模型', 'Remove model')}</span>
                  </button>
                )}
              </div>
              <div className="ca-inline-row">
                <button
                  type="button"
                  className="ca-btn"
                  disabled={modelSaving}
                  onClick={() => {
                    setModelFormError('');
                    setActiveModal(null);
                  }}
                >
                  {t('取消', 'Cancel')}
                </button>
                <button type="submit" className="ca-btn ca-btn-primary" disabled={modelSaving}>
                  <LabelStack
                    active={modelSaving ? t('保存中…', 'Saving…') : t('保存模型', 'Save model')}
                    labels={[t('保存模型', 'Save model'), t('保存中…', 'Saving…')]}
                  />
                </button>
              </div>
            </div>
          </form>
        )}
      </CaModal>

      {/* Single top-level modal slot: Discover / Restore Models */}
      <CaModal
        open={discoverModalOpen}
        onOpenChange={open => {
          if (!open && !discoverSaving) {
            closeDiscoverModal();
          }
        }}
        title={discoverMode === 'restore' ? t('恢复已移除的模型', 'Restore removed models') : t('从 /v1/models 拉取模型', 'Discover models from /v1/models')}
        variant="modal"
        bodyClassName="ca-dialog-body-flex"
        footer={
          <>
            <button
              type="button"
              className="ca-btn"
              disabled={discoverSaving}
              onClick={closeDiscoverModal}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary"
              disabled={discoverFetching || discoverSaving || selectedIds.size === 0}
              onClick={() => void confirmBatchModels()}
            >
              {discoverSaving
                ? t('保存中…', 'Saving…')
                : discoverMode === 'restore'
                  ? t(`恢复并保存 (${selectedIds.size})`, `Restore & save (${selectedIds.size})`)
                  : t(`保存所选 (${selectedIds.size})`, `Save selected (${selectedIds.size})`)}
            </button>
          </>
        }
      >
        {discoverFormError && <CaNotice tone="danger">{discoverFormError}</CaNotice>}

        <div className="ca-inline-row ca-wrap ca-discover-bar">
          <input
            type="search"
            className="ca-input ca-discover-search"
            placeholder={t('筛选模型…', 'Filter models…')}
            value={discoverQuery}
            onChange={e => setDiscoverQuery(e.target.value)}
          />
          {discoverMode === 'remote' && (
            <>
              <select
                className="ca-select ca-discover-device"
                disabled={discoverFetching || discoverSaving}
                value={discoverDeviceId}
                onChange={e => {
                  const nextDev = e.target.value;
                  setDiscoverDeviceId(nextDev);
                  if (edit) void runDiscoverFetch(edit, nextDev);
                }}
              >
                <option value="">{t('中心直连拉取', 'Direct from center')}</option>
                {devices
                  .filter(d => d.online)
                  .map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {t(`经 ${d.name} 探测`, `Via ${d.name}`)}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                disabled={discoverFetching || discoverSaving || !edit}
                onClick={() => edit && void runDiscoverFetch(edit, discoverDeviceId)}
              >
                <LabelStack
                  active={discoverFetching ? t('拉取中…', 'Fetching…') : t('重新拉取', 'Refetch')}
                  labels={[t('重新拉取', 'Refetch'), t('拉取中…', 'Fetching…')]}
                />
              </button>
            </>
          )}
        </div>

        {discovered.length > 0 && (
          <div className="ca-discover-summary">
            <span className="ca-muted ca-num">
              {discoverQuery.trim()
                ? t(`已选 ${selectedIds.size} / ${discovered.length}（当前匹配 ${filteredDiscovered.length}）`, `Selected ${selectedIds.size} / ${discovered.length} (${filteredDiscovered.length} matching)`)
                : t(`已选 ${selectedIds.size} / ${discovered.length}`, `Selected ${selectedIds.size} / ${discovered.length}`)}
            </span>
            <div className="ca-inline-row">
              <button
                type="button"
                className="ca-btn ca-btn-ghost ca-btn-sm"
                disabled={discoverSaving || filteredDiscoveredIds.length === 0}
                onClick={() =>
                  setSelectedIds(prev =>
                    allVisibleDiscoveredSelected
                      ? deselectVisibleModelIds(prev, filteredDiscoveredIds)
                      : selectVisibleModelIds(prev, filteredDiscoveredIds),
                  )
                }
              >
                {allVisibleDiscoveredSelected
                  ? discoverQuery.trim()
                    ? t('取消选中匹配', 'Deselect matches')
                    : t('取消全选', 'Deselect all')
                  : discoverQuery.trim()
                    ? t('全选匹配', 'Select matches')
                    : t('全选', 'Select all')}
              </button>
              {discoverQuery.trim() && (
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-sm"
                  disabled={discoverSaving || selectedIds.size === 0}
                  onClick={() => setSelectedIds(new Set())}
                >
                  {t('清空已选', 'Clear all')}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="ca-model-list ca-discover-list">
          {discoverFetching && discovered.length === 0 ? (
            <div className="ca-empty">{t('正在读取可用模型…', 'Loading available models…')}</div>
          ) : discovered.length === 0 ? (
            <div className="ca-empty">
              {discoverMode === 'remote' && discoverTotalCount > 0
                ? t(`已拉取 ${discoverTotalCount} 个模型，均已添加到当前服务商`, `Fetched ${discoverTotalCount} models; all are already added to this provider`)
                : t('暂无可添加的新模型', 'No new models to add')}
            </div>
          ) : filteredDiscovered.length === 0 ? (
            <div className="ca-empty">{t('没有匹配的模型', 'No matching models')}</div>
          ) : (
            filteredDiscovered.map(item => {
              const checked = selectedIds.has(item.id);
              return (
                <label key={item.id} className="ca-model-option ca-discover-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={discoverSaving}
                    onChange={e => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      setSelectedIds(next);
                    }}
                  />
                  <span className="ca-model-option-main">
                    <span>{item.name || item.id}</span>
                    <span className="ca-muted ca-mono">{item.id}</span>
                  </span>
                </label>
              );
            })
          )}
        </div>
      </CaModal>

      {/* Single top-level modal slot: Confirm Clear API Key */}
      <CaConfirmDialog
        open={activeModal?.kind === 'confirm-clear-key' && Boolean(edit) && !creating}
        title={t('清除 API 密钥', 'Clear API Key')}
        description={
          edit ? (
            <>
              <span>
                {!edit.native
                  ? t(`清除服务商「${edit.name || edit.id}」的已保存 API 密钥后，将从中心永久移除该密钥并恢复无密钥模式。`, `Clearing the saved API key for "${edit.name || edit.id}" permanently removes it from the center and restores no-key mode.`)
                  : t(`清除服务商「${edit.name || edit.id}」的已保存 API 密钥后，将从中心永久移除该密钥；重新填写密钥或完成 OAuth 授权前无法通过密钥调用。`, `Clearing the saved API key for "${edit.name || edit.id}" permanently removes it from the center until you save a new key or sign in with OAuth.`)}
              </span>
              {confirmError ? (
                <>
                  <br />
                  <span className="ca-error-text">{confirmError}</span>
                </>
              ) : null}
            </>
          ) : ''
        }
        confirmLabel={clearingKey ? t('清除中…', 'Clearing…') : t('清除密钥', 'Clear key')}
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={clearingKey}
        onCancel={() => {
          if (!clearingKey) {
            setConfirmError('');
            setActiveModal(null);
          }
        }}
        onConfirm={() => void handleClearApiKey()}
      />

      {/* Single top-level modal slot: Confirm Reset / Delete Provider */}
      <CaConfirmDialog
        open={activeModal?.kind === 'confirm-delete-provider' && Boolean(edit) && !creating}
        title={edit?.native ? t('重置内置服务商', 'Reset Built-in Provider') : t('删除自定义服务商', 'Delete Custom Provider')}
        description={
          edit ? (
            <>
              <span>
                {edit.native
                  ? t(`重置内置服务商「${edit.name || edit.id}」将清除已保存的凭据与自定义配置，并恢复默认状态。`, `Resetting built-in provider "${edit.name || edit.id}" clears saved credentials and custom settings, restoring its default state.`)
                  : t(`删除自定义服务商「${edit.name || edit.id}」将一并移除其下所有模型，且无法恢复。`, `Deleting custom provider "${edit.name || edit.id}" removes all of its models and cannot be undone.`)}
              </span>
              {confirmError ? (
                <>
                  <br />
                  <span className="ca-error-text">{confirmError}</span>
                </>
              ) : null}
            </>
          ) : ''
        }
        confirmLabel={
          savingProvider
            ? t('处理中…', 'Working…')
            : edit?.native
              ? t('重置服务商', 'Reset Provider')
              : t('删除服务商', 'Delete Provider')
        }
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={savingProvider}
        onCancel={() => {
          if (!savingProvider) {
            setConfirmError('');
            setActiveModal(null);
          }
        }}
        onConfirm={() => void handleDeleteProvider()}
      />

      {/* Single top-level modal slot: Confirm Remove Model */}
      <CaConfirmDialog
        open={Boolean(deleteModelTarget) && Boolean(edit)}
        title={t('移除模型', 'Remove Model')}
        description={
          deleteModelTarget ? (
            <>
              <span>
                {t(`移除模型「${deleteModelTarget.model.name || deleteModelTarget.model.id}」后，该模型将不再出现在当前服务商的可用列表中。`, `Removing model "${deleteModelTarget.model.name || deleteModelTarget.model.id}" removes it from this provider's available model list.`)}
              </span>
              {confirmError ? (
                <>
                  <br />
                  <span className="ca-error-text">{confirmError}</span>
                </>
              ) : null}
            </>
          ) : ''
        }
        confirmLabel={modelSaving ? t('移除中…', 'Removing…') : t('移除模型', 'Remove Model')}
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={modelSaving}
        onCancel={() => {
          if (!modelSaving) {
            setConfirmError('');
            if (deleteModelTarget?.returnToEdit) {
              setActiveModal({ kind: 'edit-model', creating: false });
            } else {
              setActiveModal(null);
            }
          }
        }}
        onConfirm={() => {
          if (deleteModelTarget) void handleDeleteModel(deleteModelTarget.model);
        }}
      />
    </div>
  );
}
