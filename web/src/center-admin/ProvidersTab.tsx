import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { Check, Plus, RefreshCw, RotateCcw, Search, Star, Trash2 } from 'lucide-react';
import { ANTIGRAVITY_PROVIDER_ID } from '../../../center-contract/antigravity.js';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  CaChips,
  CaDisclosure,
  CaModal,
  CaNotice,
  CaSegmented,
  CaSwitch,
  CopyButton,
  formatTime,
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

type ThinkingChoice = '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const THINKING_OPTIONS: readonly { value: ThinkingChoice; label: string }[] = [
  { value: '', label: '默认' },
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '很高' },
  { value: 'max', label: '最高' },
];

type CodeModeChoice = 'off' | 'on' | 'only';

const CODEMODE_OPTIONS: readonly { value: CodeModeChoice; label: string }[] = [
  { value: 'off', label: '标准工具' },
  { value: 'on', label: '开启 Code Mode' },
  { value: 'only', label: '仅 Code Mode' },
];

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

export function ProvidersTab({ api }: { api: CenterApi }): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [providers, setProviders] = useState<Provider[]>([]);
  const [picker, setPicker] = useState<ModelPickerResponse | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [authByProvider, setAuthByProvider] = useState<Record<string, ProviderAuthStatus>>({});
  const [modelCountByProvider, setModelCountByProvider] = useState<Record<string, number>>({});

  // Global model selector modal
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState<'all' | 'starred'>('all');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  // Provider search
  const [providerQuery, setProviderQuery] = useState('');
  const [togglingProviderId, setTogglingProviderId] = useState<string | null>(null);

  // Provider unified drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<Provider | null>(null);
  const [customIdEdited, setCustomIdEdited] = useState(false);
  const [customJson, setCustomJson] = useState('{}');
  const [keyValue, setKeyValue] = useState('');
  const [credential, setCredential] = useState<CredentialInfo | null>(null);
  const [authStatus, setAuthStatus] = useState<ProviderAuthStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [removedModels, setRemovedModels] = useState<Model[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [savingProvider, setSavingProvider] = useState(false);
  const [validatingProvider, setValidatingProvider] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [drawerNotice, setDrawerNotice] = useState('');

  // OAuth flow state
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ProviderAuthFlow | null>(null);
  const [promptInput, setPromptInput] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const flowTimerRef = useRef<number | null>(null);

  // Model edit modal
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [modelCreating, setModelCreating] = useState(false);
  const [modelDraft, setModelDraft] = useState<Model | null>(null);
  const [modelExtraJson, setModelExtraJson] = useState('{}');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState('');

  // Discover / Restore models modal
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverMode, setDiscoverMode] = useState<'remote' | 'restore'>('remote');
  const [discovered, setDiscovered] = useState<Model[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [discoverDeviceId, setDiscoverDeviceId] = useState('');
  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState('');

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

    const counts: Record<string, number> = {};
    for (const item of pickerRes.models) {
      const slash = item.modelRef.indexOf('/');
      if (slash > 0) {
        const pid = item.modelRef.slice(0, slash);
        counts[pid] = (counts[pid] ?? 0) + 1;
      }
    }
    setModelCountByProvider(counts);

    if (batchAuth && (Object.keys(batchAuth).length > 0 || !provList.some(p => p.native))) {
      setAuthByProvider(batchAuth);
    } else {
      void api
        .providerAuthStatuses(provList.filter(p => p.native).map(p => p.id))
        .then(next => setAuthByProvider(next))
        .catch(() => {});
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    refreshPageData()
      .catch(err => {
        if (active) setError(errorMessage(err, '加载模型配置失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshPageData]);

  const stopFlowPoll = useCallback(() => {
    if (flowTimerRef.current !== null) {
      window.clearTimeout(flowTimerRef.current);
      flowTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopFlowPoll(), [stopFlowPoll]);

  const loadProviderDetails = useCallback(
    async (provider: Provider) => {
      setDrawerError('');
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
        setModels(allModels.filter(m => !m.removed));
        setRemovedModels(allModels.filter(m => m.removed));
        setAuthStatus(status);
        if (status) {
          setAuthByProvider(prev => ({ ...prev, [provider.id]: status }));
        }
        setCredential(cred);
      } catch (err) {
        setDrawerError(errorMessage(err, '读取服务商详情失败'));
      }
    },
    [api],
  );

  const openExistingProvider = (provider: Provider) => {
    stopFlowPoll();
    setFlowId(null);
    setFlow(null);
    setCreating(false);
    setEdit({ ...provider });
    setCustomIdEdited(true);
    setCustomJson(JSON.stringify(provider.custom ?? {}, null, 2));
    setKeyValue('');
    setModelQuery('');
    setDrawerNotice('');
    setDrawerError('');
    setModels([]);
    setRemovedModels([]);
    setCredential(null);
    setAuthStatus(authByProvider[provider.id] ?? null);
    setDrawerOpen(true);
    void loadProviderDetails(provider);
  };

  const openCreateProvider = () => {
    stopFlowPoll();
    setFlowId(null);
    setFlow(null);
    setCreating(true);
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
    setDrawerNotice('');
    setDrawerError('');
    setModels([]);
    setRemovedModels([]);
    setCredential(null);
    setAuthStatus(null);
    setDrawerOpen(true);
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
      return (
        item.name.toLowerCase().includes(q) ||
        item.modelRef.toLowerCase().includes(q)
      );
    });
    // In 'all' mode, pin starred models at the top while keeping original relative order
    return [...list].sort((a, b) => {
      const sa = starredSet.has(a.modelRef) ? 0 : 1;
      const sb = starredSet.has(b.modelRef) ? 0 : 1;
      return sa - sb;
    });
  }, [picker, pickerFilter, pickerQuery, starredSet]);

  const saveGlobalSelection = async (patch: Partial<ModelSelection>, successMsg?: string) => {
    if (!modelConfig) return;
    setPickerBusy(true);
    setError('');
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
      if (successMsg) setNotice(successMsg);
    } catch (err) {
      setError(errorMessage(err, '保存全局默认模型失败'));
    } finally {
      setPickerBusy(false);
    }
  };

  const handleToggleStar = async (modelRef: string, nextStar: boolean) => {
    try {
      const res = await api.setModelStar(modelRef, nextStar);
      setPicker(prev => (prev ? { ...prev, starredModels: res.starredModels } : prev));
    } catch (err) {
      setError(errorMessage(err, '收藏状态更新失败'));
    }
  };

  const handleSyncCatalog = async () => {
    setSyncBusy(true);
    setError('');
    try {
      const res = await api.syncModelCatalog();
      await refreshPageData();
      if (res.error) setError(res.error);
      else setNotice(`模型目录已同步${res.modelsAdded ? `（新增 ${res.modelsAdded} 个）` : ''}`);
    } catch (err) {
      setError(errorMessage(err, '同步模型目录失败'));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleToggleProviderRow = async (provider: Provider, nextEnabled: boolean) => {
    setTogglingProviderId(provider.id);
    setError('');
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
    } catch (err) {
      setError(errorMessage(err, '切换服务商状态失败'));
    } finally {
      setTogglingProviderId(null);
    }
  };

  const persistProvider = async (verifyAfterSave: boolean) => {
    if (!edit) return;
    setDrawerError('');
    setDrawerNotice('');

    let parsedCustom: JsonObject = {};
    try {
      const raw = JSON.parse(customJson || '{}') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        setDrawerError('高级协议覆盖必须是 JSON 对象');
        return;
      }
      parsedCustom = raw as JsonObject;
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : '高级协议 JSON 解析失败');
      return;
    }

    if (!edit.native && !edit.baseUrl.trim() && typeof parsedCustom.baseUrl !== 'string') {
      setDrawerError('请填写 API Base URL（例如 https://api.example.com/v1）');
      return;
    }

    const existingIds = new Set(providers.map(p => p.id));
    const finalId = creating
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
      enabled: creating || Boolean(trimmedKey) ? true : edit.enabled,
      custom: parsedCustom,
    };

    setSavingProvider(true);
    try {
      const saved = creating
        ? await api.createProvider(payload)
        : await api.putProvider(payload.id, {
            expectedRevision: edit.revision,
            value: payload,
          });

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

      setCreating(false);
      setEdit(saved);

      let verifyMsg = '';
      if (verifyAfterSave) {
        setValidatingProvider(true);
        try {
          const check = await api.validateProvider(saved.id, {});
          verifyMsg = check.ok ? `连接验证通过：${check.message}` : `已保存，但验证未通过：${check.message}`;
        } catch (vErr) {
          verifyMsg = `已保存，验证失败：${errorMessage(vErr)}`;
        } finally {
          setValidatingProvider(false);
        }
      }

      await refreshPageData();
      await loadProviderDetails(saved);
      setDrawerNotice(verifyMsg || (creating ? '服务商已创建并启用' : '配置已保存'));
    } catch (err) {
      setDrawerError(errorMessage(err, '保存服务商失败'));
    } finally {
      setSavingProvider(false);
    }
  };

  const handleValidateOnly = async () => {
    if (!edit || creating) return;
    setValidatingProvider(true);
    setDrawerError('');
    setDrawerNotice('');
    try {
      const res = await api.validateProvider(edit.id, keyValue.trim() ? { apiKey: keyValue.trim() } : {});
      if (res.ok) setDrawerNotice(`连接正常：${res.message}`);
      else setDrawerError(`连接验证失败：${res.message}`);
    } catch (err) {
      setDrawerError(errorMessage(err, '验证连接失败'));
    } finally {
      setValidatingProvider(false);
    }
  };

  const handleDeleteProvider = async () => {
    if (!edit || creating) return;
    const msg = edit.native
      ? `确定重置内置服务商「${edit.name}」的凭据与自定义配置吗？`
      : `确定删除自定义服务商「${edit.name}」及其所有模型吗？`;
    if (!window.confirm(msg)) return;
    setSavingProvider(true);
    setDrawerError('');
    try {
      await api.deleteProvider(edit.id);
      setDrawerOpen(false);
      setEdit(null);
      await refreshPageData();
      setNotice(edit.native ? `已重置 ${edit.name}` : `已删除 ${edit.name}`);
    } catch (err) {
      setDrawerError(errorMessage(err, '删除服务商失败'));
    } finally {
      setSavingProvider(false);
    }
  };

  // OAuth Login flow polling
  const pollLoginFlow = useCallback(
    (providerId: string, nextFlowId: string) => {
      stopFlowPoll();
      const tick = async () => {
        try {
          const state = await api.providerLoginStatus(providerId, nextFlowId);
          setFlow(state);
          if (state.status === 'pending') {
            flowTimerRef.current = window.setTimeout(() => void tick(), 1200);
          } else if (state.status === 'complete') {
            setDrawerNotice('OAuth 授权已完成');
            const updatedProvider = await api.getProvider(providerId);
            setEdit(updatedProvider);
            await refreshPageData();
            await loadProviderDetails(updatedProvider);
          } else if (state.error) {
            setDrawerError(state.error);
          }
        } catch (err) {
          setDrawerError(errorMessage(err, '获取授权进度失败'));
        }
      };
      void tick();
    },
    [api, loadProviderDetails, refreshPageData, stopFlowPoll],
  );

  const handleStartOAuth = async () => {
    if (!edit) return;
    setAuthBusy(true);
    setDrawerError('');
    setDrawerNotice('');
    try {
      const { flowId: nextId } = await api.providerLogin(edit.id);
      setFlowId(nextId);
      setFlow({ status: 'pending', events: [], prompt: null, error: null });
      pollLoginFlow(edit.id, nextId);
    } catch (err) {
      setDrawerError(errorMessage(err, '启动 OAuth 登录失败'));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSubmitPrompt = async (answer: string) => {
    if (!edit || !flowId || !answer.trim()) return;
    setAuthBusy(true);
    setDrawerError('');
    try {
      await api.providerLoginAnswer(edit.id, flowId, answer.trim());
      setPromptInput('');
      pollLoginFlow(edit.id, flowId);
    } catch (err) {
      setDrawerError(errorMessage(err, '提交授权输入失败'));
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
    setDrawerError('');
    setDrawerNotice('');
    try {
      const next = await api.providerLogout(edit.id);
      setAuthStatus(next);
      setAuthByProvider(prev => ({ ...prev, [edit.id]: next }));
      if (next.method === 'oauth') {
        setDrawerError('退出 OAuth 授权未生效，请重试');
      } else {
        setDrawerNotice('已退出 OAuth 授权');
        void refreshPageData().catch(() => {});
      }
    } catch (err) {
      setDrawerError(errorMessage(err, '退出授权失败'));
    } finally {
      setAuthBusy(false);
    }
  };

  // Single Model Management
  const handleToggleModelEnabled = async (model: Model, nextEnabled: boolean) => {
    if (!edit) return;
    setDrawerError('');
    try {
      const updated = await api.putModel(edit.id, model.id, {
        expectedRevision: model.revision,
        value: { ...model, enabled: nextEnabled },
      });
      setModels(prev => prev.map(m => (m.id === updated.id ? updated : m)));
      const pickerRes = await api.getModelPicker();
      setPicker(pickerRes);
    } catch (err) {
      setDrawerError(errorMessage(err, '切换模型状态失败'));
    }
  };

  const openAddModelModal = () => {
    setModelCreating(true);
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
    setModelError('');
    setModelModalOpen(true);
  };

  const openEditModelModal = (model: Model) => {
    const { base, extraJson } = splitModelExtra(model);
    setModelCreating(false);
    setModelDraft({ ...base });
    setModelExtraJson(extraJson);
    setModelError('');
    setModelModalOpen(true);
  };

  const handleSaveModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit || !modelDraft) return;
    const trimmedId = modelDraft.id.trim();
    if (!trimmedId) {
      setModelError('请填写模型 ID');
      return;
    }

    let extra: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(modelExtraJson || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setModelError('高级协议覆盖必须是 JSON 对象');
        return;
      }
      extra = parsed as Record<string, unknown>;
    } catch (err) {
      setModelError(err instanceof Error ? err.message : '高级覆盖 JSON 解析失败');
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
    setModelError('');
    try {
      if (modelCreating) {
        await api.createModel(edit.id, payload);
      } else {
        await api.putModel(edit.id, payload.id, {
          expectedRevision: modelDraft.revision,
          value: payload,
        });
      }
      setModelModalOpen(false);
      await loadProviderDetails(edit);
      await refreshPageData();
      setDrawerNotice(modelCreating ? `已添加模型 ${payload.name}` : `已更新模型 ${payload.name}`);
    } catch (err) {
      setModelError(errorMessage(err, '保存模型失败'));
    } finally {
      setModelSaving(false);
    }
  };

  const handleDeleteModel = async (model: Model) => {
    if (!edit) return;
    if (!window.confirm(`确定移除模型「${model.name || model.id}」吗？`)) return;
    setDrawerError('');
    try {
      await api.deleteModel(edit.id, model.id);
      await loadProviderDetails(edit);
      await refreshPageData();
      setDrawerNotice(`已移除模型 ${model.name || model.id}`);
    } catch (err) {
      setDrawerError(errorMessage(err, '移除模型失败'));
    }
  };

  // Discover / Restore
  const runDiscoverFetch = async (provider: Provider, deviceId: string) => {
    setDiscoverBusy(true);
    setDiscoverError('');
    try {
      const res = await api.discoverModels(provider.id, {
        ...(deviceId ? { deviceId } : {}),
        ...(keyValue.trim() ? { apiKey: keyValue.trim() } : {}),
      });
      const activeIds = new Set(models.map(m => m.id));
      const candidates = res.models.filter(m => !activeIds.has(m.id));
      setDiscovered(candidates);
      setSelectedIds(new Set(candidates.map(m => m.id)));
    } catch (err) {
      setDiscoverError(errorMessage(err, '从接口拉取模型列表失败'));
    } finally {
      setDiscoverBusy(false);
    }
  };

  const openDiscoverModal = () => {
    if (!edit) return;
    setDiscoverMode('remote');
    setDiscovered([]);
    setSelectedIds(new Set());
    setDiscoverQuery('');
    setDiscoverDeviceId('');
    setDiscoverError('');
    setDiscoverOpen(true);
    void api.listDevices().then(setDevices).catch(() => {});
    void runDiscoverFetch(edit, '');
  };

  const openRestoreModal = () => {
    setDiscoverMode('restore');
    const candidates = removedModels.map(m => ({ ...m, removed: false, enabled: true }));
    setDiscovered(candidates);
    setSelectedIds(new Set(candidates.map(m => m.id)));
    setDiscoverQuery('');
    setDiscoverError('');
    setDiscoverOpen(true);
  };

  const confirmBatchModels = async () => {
    if (!edit || selectedIds.size === 0) return;
    setDiscoverBusy(true);
    setDiscoverError('');
    try {
      const chosen = discovered
        .filter(m => selectedIds.has(m.id))
        .map(m => ({ ...m, enabled: true, removed: false, revision: 0 }));
      await api.createModelsBatch(edit.id, { models: chosen });
      if (!edit.configured) {
        const updated = await api.putProvider(edit.id, {
          expectedRevision: edit.revision,
          value: { ...edit, configured: true },
        });
        setEdit(updated);
      }
      setDiscoverOpen(false);
      await loadProviderDetails(edit);
      await refreshPageData();
      setDrawerNotice(
        discoverMode === 'restore'
          ? `已恢复 ${chosen.length} 个模型`
          : `已添加 ${chosen.length} 个模型`,
      );
    } catch (err) {
      setDiscoverError(errorMessage(err, '批量保存模型失败'));
    } finally {
      setDiscoverBusy(false);
    }
  };

  const sortedProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase();
    return [...providers]
      .filter(p => {
        if (!q) return true;
        return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const ra = providerSortRank(a);
        const rb = providerSortRank(b);
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });
  }, [providerQuery, providers]);

  const filteredDrawerModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [modelQuery, models]);

  const filteredDiscovered = useMemo(() => {
    const q = discoverQuery.trim().toLowerCase();
    if (!q) return discovered;
    return discovered.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [discoverQuery, discovered]);

  const currentThinking: ThinkingChoice = (modelConfig?.global.thinkingLevel as ThinkingChoice | undefined) ?? '';
  const currentCodeMode: CodeModeChoice = modelConfig?.global.codemodeOnly
    ? 'only'
    : modelConfig?.global.codemode
      ? 'on'
      : 'off';

  const providerStatusSummary = (p: Provider): string => {
    const count = modelCountByProvider[p.id] ?? 0;
    const auth = authByProvider[p.id];
    const parts: string[] = [];
    if (p.id === ANTIGRAVITY_PROVIDER_ID && auth?.oauth) {
      parts.push('OAuth 已授权');
    } else if (p.configured || p.credentialRef) {
      parts.push('已配置');
    } else {
      parts.push('未配置凭据');
    }
    if (count > 0) parts.push(`${count} 个模型可用`);
    else if (!p.enabled) parts.push('已停用');
    return parts.join(' · ');
  };

  if (loading) {
    return <div className="ca-empty">正在加载模型与服务商配置…</div>;
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

      {/* 1. 顶部单行全局默认模型卡片 */}
      <section className="ca-section">
        <div className="ca-default-card">
          <div className="ca-row-main">
            <div className="ca-row-title">
              <span>全局默认模型</span>
              {currentDefaultItem ? (
                <span className="ca-pill ca-pill-ok">{currentDefaultItem.name}</span>
              ) : currentGlobalModelRef ? (
                <span className="ca-pill ca-pill-muted">{currentGlobalModelRef}</span>
              ) : (
                <span className="ca-pill ca-pill-warn">尚未设置默认模型</span>
              )}
            </div>
            <div className="ca-row-sub">
              {currentDefaultItem
                ? `${currentDefaultItem.modelRef} · 上下文 ${Math.round(currentDefaultItem.contextWindow / 1000)}k`
                : '未单独指定模型的智能体将默认使用此模型'}
            </div>
          </div>
          <div className="ca-row-actions">
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              onClick={() => {
                setPickerFilter('all');
                setPickerQuery('');
                setPickerOpen(true);
              }}
            >
              {currentGlobalModelRef ? '更换默认模型' : '选择默认模型'}
            </button>
          </div>
        </div>

        {/* 仅在当前默认模型支持推理时展示中文思考强度胶囊 */}
        {currentDefaultItem?.reasoning && (
          <div
            style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--ca-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span className="ca-field-label">思考强度</span>
            <CaChips
              value={currentThinking}
              options={THINKING_OPTIONS}
              onChange={val => void saveGlobalSelection({ thinkingLevel: val || null }, '思考强度已保存')}
            />
          </div>
        )}

        {/* 高级工具调用方式 & 目录同步折叠区 */}
        <div style={{ padding: '0 16px 12px' }}>
          <CaDisclosure title="高级设置（工具调用方式 / 模型目录同步）">
            <div className="ca-form-stack">
              <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                <div>
                  <div className="ca-field-label">工具调用模式</div>
                  <div className="ca-muted">控制模型通过标准 Function Calling 还是代码沙箱执行工具</div>
                </div>
                <CaSegmented
                  value={currentCodeMode}
                  options={CODEMODE_OPTIONS}
                  onChange={val =>
                    void saveGlobalSelection(
                      {
                        codemode: val === 'on' || val === 'only',
                        codemodeOnly: val === 'only',
                      },
                      '工具调用模式已更新',
                    )
                  }
                />
              </div>

              <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                <div>
                  <div className="ca-field-label">内置模型目录同步</div>
                  <div className="ca-muted">
                    最近同步：{picker?.sync.syncedAt ? formatTime(picker.sync.syncedAt) : '尚未同步'}
                    {picker?.sync.error ? `（${picker.sync.error}）` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={syncBusy}
                  onClick={() => void handleSyncCatalog()}
                >
                  <RefreshCw size={13} />
                  <span>{syncBusy ? '同步中…' : '同步目录'}</span>
                </button>
              </div>
            </div>
          </CaDisclosure>
        </div>
      </section>

      {/* 2. 服务商极简列表 */}
      <section className="ca-section">
        <div className="ca-section-head">
          <h3 className="ca-section-title">模型服务商</h3>
          <div className="ca-toolbar-group ca-provider-toolbar">
            <div className="ca-inline-row ca-provider-search">
              <Search size={14} style={{ position: 'absolute', left: 9, color: 'var(--ca-text-muted)' }} />
              <input
                type="search"
                className="ca-input"
                style={{ paddingLeft: 28, paddingTop: 4, paddingBottom: 4 }}
                placeholder="筛选服务商…"
                value={providerQuery}
                onChange={e => setProviderQuery(e.target.value)}
              />
            </div>
            <button type="button" className="ca-btn ca-btn-sm" onClick={openCreateProvider}>
              <Plus size={14} />
              <span>自定义服务商</span>
            </button>
          </div>
        </div>

        <div className="ca-list">
          {sortedProviders.length === 0 ? (
            <div className="ca-empty">没有匹配的服务商</div>
          ) : (
            sortedProviders.map(provider => (
              <div
                key={provider.id}
                className="ca-row is-clickable"
                onClick={() => openExistingProvider(provider)}
              >
                <div className="ca-row-main">
                  <div className="ca-row-title">
                    <span>{provider.name || provider.id}</span>
                    {!provider.native && <span className="ca-pill ca-pill-muted">自定义</span>}
                    {provider.id === ANTIGRAVITY_PROVIDER_ID && (
                      <span className="ca-pill ca-pill-info">Antigravity</span>
                    )}
                  </div>
                  <div className="ca-row-sub ca-num">{providerStatusSummary(provider)}</div>
                </div>
                <div className="ca-row-actions" onClick={e => e.stopPropagation()}>
                  <CaSwitch
                    checked={provider.enabled}
                    disabled={togglingProviderId === provider.id}
                    label={`启用 ${provider.name || provider.id}`}
                    onChange={next => void handleToggleProviderRow(provider, next)}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* 全局默认模型选择器 Modal */}
      <CaModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="选择全局默认模型"
        description="默认显示全部可用模型，收藏模型自动置顶"
        variant="modal"
      >
        <div className="ca-form-stack">
          <div className="ca-inline-between" style={{ gap: 8, flexWrap: 'wrap' }}>
            <CaSegmented
              value={pickerFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'starred', label: `★ 收藏 (${picker?.starredModels.length ?? 0})` },
              ]}
              onChange={setPickerFilter}
            />
            <input
              type="search"
              className="ca-input"
              style={{ maxWidth: 220 }}
              placeholder="搜索模型名称或 ID…"
              value={pickerQuery}
              onChange={e => setPickerQuery(e.target.value)}
            />
          </div>

          <div className="ca-model-list">
            {sortedPickerModels.length === 0 ? (
              <div className="ca-empty">
                {pickerFilter === 'starred' ? '暂无收藏模型，可切回“全部”查看' : '暂无可用模型，请先配置并启用服务商'}
              </div>
            ) : (
              sortedPickerModels.map(item => {
                const isSelected = item.modelRef === currentGlobalModelRef;
                const isStarred = starredSet.has(item.modelRef);
                return (
                  <div
                    key={item.modelRef}
                    className={`ca-model-option ${isSelected ? 'is-selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (pickerBusy) return;
                      void saveGlobalSelection({ modelRef: item.modelRef }, `默认模型已切换为 ${item.name}`).then(
                        () => setPickerOpen(false),
                      );
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void saveGlobalSelection({ modelRef: item.modelRef }, `默认模型已切换为 ${item.name}`).then(
                          () => setPickerOpen(false),
                        );
                      }
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="ca-inline-row">
                        <span>{item.name}</span>
                        {item.reasoning && <span className="ca-pill ca-pill-info">推理</span>}
                        {isSelected && <Check size={14} />}
                      </div>
                      <div className="ca-muted ca-mono">{item.modelRef}</div>
                    </div>
                    <button
                      type="button"
                      className="ca-btn ca-btn-ghost ca-btn-icon"
                      aria-label={isStarred ? '取消收藏' : '收藏模型'}
                      onClick={e => {
                        e.stopPropagation();
                        void handleToggleStar(item.modelRef, !isStarred);
                      }}
                    >
                      <Star
                        size={14}
                        fill={isStarred ? 'currentColor' : 'none'}
                        color={isStarred ? '#f59e0b' : 'currentColor'}
                      />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </CaModal>

      {/* 统一服务商详情与凭据抽屉 */}
      <CaModal
        open={drawerOpen}
        onOpenChange={open => {
          if (!open) stopFlowPoll();
          setDrawerOpen(open);
        }}
        title={creating ? '添加自定义服务商' : edit?.name || edit?.id || '服务商设置'}
        description={creating ? '填写兼容接口地址与密钥后即可拉取模型' : `服务商 ID：${edit?.id ?? ''}`}
        variant="drawer"
        wide
      >
        {edit && (
          <div className="ca-form-stack">
            {drawerError && <CaNotice tone="danger">{drawerError}</CaNotice>}
            {drawerNotice && <CaNotice tone="ok">{drawerNotice}</CaNotice>}

            {/* OAuth / Antigravity 授权流程 */}
            {!creating && (authStatus?.oauth || edit.id === ANTIGRAVITY_PROVIDER_ID) && (
              <div className="ca-section" style={{ padding: 12 }}>
                <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                  <div>
                    <div className="ca-field-label">OAuth 账号授权</div>
                    <div className="ca-muted">
                      {authStatus?.method === 'oauth'
                        ? '已通过 OAuth 授权登录'
                        : authStatus?.label
                          ? `未授权 · 可${authStatus.label}`
                          : '尚未登录'}
                    </div>
                  </div>
                  <div className="ca-inline-row">
                    {authStatus?.method === 'oauth' ? (
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        disabled={authBusy}
                        onClick={() => void handleOAuthLogout()}
                      >
                        退出授权
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ca-btn ca-btn-primary ca-btn-sm"
                        disabled={authBusy || flow?.status === 'pending'}
                        onClick={() => void handleStartOAuth()}
                      >
                        {flow?.status === 'pending' ? '授权进行中…' : '登录 OAuth 授权'}
                      </button>
                    )}
                  </div>
                </div>

                {flow && flow.status === 'pending' && (
                  <div className="ca-form-stack" style={{ marginTop: 10 }}>
                    {flow.events.map((ev, idx) => (
                      <div key={idx} className="ca-cred-box">
                        {ev.message && <div style={{ fontSize: 13 }}>{ev.message}</div>}
                        {ev.instructions && <div className="ca-muted">{ev.instructions}</div>}
                        {(ev.url || ev.verificationUri) && (
                          <div className="ca-inline-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                            <a
                              href={ev.url || ev.verificationUri}
                              target="_blank"
                              rel="noreferrer"
                              className="ca-btn ca-btn-sm"
                            >
                              打开授权页面
                            </a>
                            {ev.userCode && (
                              <>
                                <span className="ca-pill ca-pill-info ca-mono">验证码：{ev.userCode}</span>
                                <CopyButton value={ev.userCode} label="复制验证码" />
                              </>
                            )}
                          </div>
                        )}
                        {ev.links?.map((lk, lIdx) => (
                          <div key={lIdx} style={{ marginTop: 4 }}>
                            <a href={lk.url} target="_blank" rel="noreferrer" className="ca-muted">
                              {lk.label}
                            </a>
                          </div>
                        ))}
                      </div>
                    ))}

                    {flow.prompt && (
                      <div className="ca-cred-box">
                        <div className="ca-field-label">{flow.prompt.message}</div>
                        {flow.prompt.options && flow.prompt.options.length > 0 ? (
                          <div className="ca-inline-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
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
                        ) : (
                          <div className="ca-inline-row" style={{ marginTop: 6 }}>
                            <input
                              type="text"
                              className="ca-input"
                              placeholder={flow.prompt.placeholder || '粘贴授权码或回调 URL'}
                              value={promptInput}
                              onChange={e => setPromptInput(e.target.value)}
                            />
                            <button
                              type="button"
                              className="ca-btn ca-btn-primary ca-btn-sm"
                              disabled={authBusy || !promptInput.trim()}
                              onClick={() => void handleSubmitPrompt(promptInput)}
                            >
                              提交
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="ca-inline-end">
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-sm"
                        onClick={() => void handleCancelOAuth()}
                      >
                        取消授权
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 基础连接与凭据表单（统一通过「保存并验证」落库） */}
            <div className="ca-form-stack">
              {!edit.native && (
                <>
                  <div className="ca-grid-2">
                    <div className="ca-field">
                      <label className="ca-field-label">显示名称</label>
                      <input
                        type="text"
                        className="ca-input"
                        placeholder="如 SiliconFlow / 本地 Ollama"
                        value={edit.name}
                        onChange={e => setEdit({ ...edit, name: e.target.value })}
                      />
                    </div>
                    <div className="ca-field">
                      <label className="ca-field-label">API 协议</label>
                      <select
                        className="ca-select"
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
                      <label className="ca-field-label">服务商 ID（可选）</label>
                      <input
                        type="text"
                        className="ca-input ca-mono"
                        placeholder="留空则按名称自动生成"
                        value={edit.id}
                        onChange={e => {
                          setCustomIdEdited(true);
                          setEdit({ ...edit, id: e.target.value });
                        }}
                      />
                    </div>
                  )}
                </>
              )}

              <div className="ca-field">
                <label className="ca-field-label">API 地址 (Base URL)</label>
                <input
                  type="url"
                  className="ca-input"
                  placeholder={edit.native ? '留空保持内置默认地址' : 'https://api.example.com/v1'}
                  value={edit.baseUrl}
                  onChange={e => setEdit({ ...edit, baseUrl: e.target.value })}
                />
              </div>

              {(!authStatus || authStatus.apiKey !== false) && (
                <div className="ca-field">
                  <div className="ca-field-head">
                    <label className="ca-field-label">API Key</label>
                    <span className={`ca-pill ${credential?.configured ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
                      {credential?.configured ? '已保存密钥（不回显）' : '未配置密钥'}
                    </span>
                  </div>
                  <input
                    type="password"
                    className="ca-input"
                    autoComplete="new-password"
                    placeholder={credential?.configured ? '输入新密钥以替换现有密钥' : '粘贴 API Key'}
                    value={keyValue}
                    onChange={e => setKeyValue(e.target.value)}
                  />
                </div>
              )}

              <CaDisclosure title="高级协议覆盖 (models.json)">
                <div className="ca-field">
                  <textarea
                    rows={4}
                    className="ca-textarea ca-mono"
                    value={customJson}
                    onChange={e => setCustomJson(e.target.value)}
                  />
                  <p className="ca-field-help">对应 Pi models.json 服务商级附加字段（如 headers、compat）；保持 {'{}'} 即可。</p>
                </div>
              </CaDisclosure>

              <div className="ca-inline-between" style={{ flexWrap: 'wrap', paddingTop: 4 }}>
                <div>
                  {!creating && (
                    <button
                      type="button"
                      className="ca-btn ca-btn-danger ca-btn-sm"
                      disabled={savingProvider}
                      onClick={() => void handleDeleteProvider()}
                    >
                      <Trash2 size={13} />
                      <span>{edit.native ? '重置配置' : '删除服务商'}</span>
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
                      {validatingProvider ? '验证中…' : '验证连接'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    disabled={savingProvider || validatingProvider}
                    onClick={() => void persistProvider(true)}
                  >
                    {savingProvider ? '保存中…' : '保存并验证'}
                  </button>
                </div>
              </div>
            </div>

            {/* 模型列表管理 */}
            {!creating && (
              <div className="ca-section" style={{ marginTop: 6 }}>
                <div className="ca-section-head" style={{ flexWrap: 'wrap' }}>
                  <span className="ca-section-title">模型列表 ({models.length})</span>
                  <div className="ca-inline-row" style={{ flexWrap: 'wrap' }}>
                    <input
                      type="search"
                      className="ca-input"
                      style={{ width: 140, paddingTop: 4, paddingBottom: 4 }}
                      placeholder="筛选模型…"
                      value={modelQuery}
                      onChange={e => setModelQuery(e.target.value)}
                    />
                    <button type="button" className="ca-btn ca-btn-sm" onClick={openDiscoverModal}>
                      拉取目录
                    </button>
                    {removedModels.length > 0 && (
                      <button type="button" className="ca-btn ca-btn-sm" onClick={openRestoreModal}>
                        <RotateCcw size={13} />
                        <span>恢复 ({removedModels.length})</span>
                      </button>
                    )}
                    <button type="button" className="ca-btn ca-btn-sm" onClick={openAddModelModal}>
                      <Plus size={13} />
                      <span>新增模型</span>
                    </button>
                  </div>
                </div>

                <div className="ca-list">
                  {filteredDrawerModels.length === 0 ? (
                    <div className="ca-empty">暂无模型，点击「拉取目录」或「新增模型」添加</div>
                  ) : (
                    filteredDrawerModels.map(m => {
                      const ref = `${edit.id}/${m.id}`;
                      const isStarred = starredSet.has(ref);
                      return (
                        <div key={m.id} className="ca-row">
                          <div className="ca-row-main">
                            <div className="ca-row-title">
                              <span>{m.name || m.id}</span>
                              {m.reasoning && <span className="ca-pill ca-pill-info">推理</span>}
                            </div>
                            <div className="ca-row-sub ca-mono ca-num">
                              {m.id} · {Math.round(m.contextWindow / 1000)}k / {Math.round(m.maxTokens / 1000)}k
                            </div>
                          </div>
                          <div className="ca-row-actions">
                            <button
                              type="button"
                              className="ca-btn ca-btn-ghost ca-btn-icon"
                              aria-label={isStarred ? '取消收藏' : '收藏'}
                              onClick={() => void handleToggleStar(ref, !isStarred)}
                            >
                              <Star
                                size={14}
                                fill={isStarred ? 'currentColor' : 'none'}
                                color={isStarred ? '#f59e0b' : 'currentColor'}
                              />
                            </button>
                            <CaSwitch
                              checked={m.enabled}
                              label={`启用模型 ${m.name || m.id}`}
                              onChange={next => void handleToggleModelEnabled(m, next)}
                            />
                            <button
                              type="button"
                              className="ca-btn ca-btn-sm"
                              onClick={() => openEditModelModal(m)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="ca-btn ca-btn-ghost ca-btn-icon"
                              aria-label="移除模型"
                              onClick={() => void handleDeleteModel(m)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CaModal>

      {/* 新增 / 编辑自定义模型弹窗（极简直观字段 + 折叠高级项） */}
      <CaModal
        open={modelModalOpen}
        onOpenChange={setModelModalOpen}
        title={modelCreating ? '新增模型' : `编辑模型 · ${modelDraft?.name || modelDraft?.id || ''}`}
        variant="modal"
      >
        {modelDraft && (
          <form className="ca-form-stack" onSubmit={e => void handleSaveModel(e)}>
            {modelError && <CaNotice tone="danger">{modelError}</CaNotice>}
            <div className="ca-field">
              <label className="ca-field-label">
                模型 ID <span className="ca-req">*</span>
              </label>
              <input
                type="text"
                className="ca-input ca-mono"
                disabled={!modelCreating}
                required
                placeholder="如 gpt-4.1 / claude-sonnet-4"
                value={modelDraft.id}
                onChange={e => setModelDraft({ ...modelDraft, id: e.target.value })}
              />
            </div>

            <div className="ca-field">
              <label className="ca-field-label">显示名称（可选）</label>
              <input
                type="text"
                className="ca-input"
                placeholder="留空默认使用模型 ID"
                value={modelDraft.name}
                onChange={e => setModelDraft({ ...modelDraft, name: e.target.value })}
              />
            </div>

            <div className="ca-inline-between">
              <span className="ca-field-label">支持深度推理 (Reasoning)</span>
              <CaSwitch
                checked={modelDraft.reasoning}
                onChange={next => setModelDraft({ ...modelDraft, reasoning: next })}
              />
            </div>

            <div className="ca-field">
              <label className="ca-field-label">输入模态</label>
              <div className="ca-check-group">
                {(['text', 'image', 'audio'] as const).map(mod => {
                  const label = mod === 'text' ? '文本' : mod === 'image' ? '图片' : '音频';
                  const checked = modelDraft.input.includes(mod);
                  return (
                    <label key={mod} className="ca-check-label">
                      <input
                        type="checkbox"
                        checked={checked}
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

            <CaDisclosure title="Token 上限（默认 128k / 16k）">
              <div className="ca-grid-2">
                <div className="ca-field">
                  <label className="ca-field-label">上下文窗口</label>
                  <input
                    type="number"
                    className="ca-input ca-num"
                    value={modelDraft.contextWindow}
                    onChange={e =>
                      setModelDraft({ ...modelDraft, contextWindow: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className="ca-field">
                  <label className="ca-field-label">最大输出 Token</label>
                  <input
                    type="number"
                    className="ca-input ca-num"
                    value={modelDraft.maxTokens}
                    onChange={e =>
                      setModelDraft({ ...modelDraft, maxTokens: Number(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
            </CaDisclosure>

            <CaDisclosure title="高级协议覆盖 (models.json)">
              <textarea
                rows={4}
                className="ca-textarea ca-mono"
                value={modelExtraJson}
                onChange={e => setModelExtraJson(e.target.value)}
              />
            </CaDisclosure>

            <div className="ca-form-actions">
              <button
                type="button"
                className="ca-btn"
                onClick={() => setModelModalOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="ca-btn ca-btn-primary" disabled={modelSaving}>
                {modelSaving ? '保存中…' : '保存模型'}
              </button>
            </div>
          </form>
        )}
      </CaModal>

      {/* 拉取 / 恢复模型弹窗 */}
      <CaModal
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        title={discoverMode === 'restore' ? '恢复已移除的模型' : '从 /v1/models 拉取模型'}
        variant="modal"
      >
        <div className="ca-form-stack">
          {discoverError && <CaNotice tone="danger">{discoverError}</CaNotice>}
          <div className="ca-inline-row" style={{ flexWrap: 'wrap' }}>
            <input
              type="search"
              className="ca-input"
              style={{ flex: 1 }}
              placeholder="筛选模型…"
              value={discoverQuery}
              onChange={e => setDiscoverQuery(e.target.value)}
            />
            {discoverMode === 'remote' && (
              <>
                <select
                  className="ca-select"
                  style={{ width: 160 }}
                  value={discoverDeviceId}
                  onChange={e => {
                    const nextDev = e.target.value;
                    setDiscoverDeviceId(nextDev);
                    if (edit) void runDiscoverFetch(edit, nextDev);
                  }}
                >
                  <option value="">中心直连拉取</option>
                  {devices
                    .filter(d => d.online)
                    .map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        经 {d.name} 探测
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={discoverBusy || !edit}
                  onClick={() => edit && void runDiscoverFetch(edit, discoverDeviceId)}
                >
                  {discoverBusy ? '拉取中…' : '重新拉取'}
                </button>
              </>
            )}
          </div>

          <div className="ca-model-list">
            {discoverBusy && discovered.length === 0 ? (
              <div className="ca-empty">正在读取可用模型…</div>
            ) : filteredDiscovered.length === 0 ? (
              <div className="ca-empty">暂无可添加的新模型</div>
            ) : (
              filteredDiscovered.map(item => {
                const checked = selectedIds.has(item.id);
                return (
                  <label key={item.id} className="ca-model-option" style={{ cursor: 'pointer' }}>
                    <div className="ca-inline-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => {
                          const next = new Set(selectedIds);
                          if (e.target.checked) next.add(item.id);
                          else next.delete(item.id);
                          setSelectedIds(next);
                        }}
                      />
                      <div>
                        <div>{item.name || item.id}</div>
                        <div className="ca-muted ca-mono">{item.id}</div>
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setDiscoverOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary"
              disabled={discoverBusy || selectedIds.size === 0}
              onClick={() => void confirmBatchModels()}
            >
              {discoverMode === 'restore'
                ? `恢复所选 (${selectedIds.size})`
                : `添加所选 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      </CaModal>
    </div>
  );
}
