import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, ExternalLink, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import type {
  CredentialInfo,
  Device,
  JsonObject,
  Model,
  ModelConfig,
  ModelPickerResponse,
  ModelSelection,
  Provider,
  ProviderAuthFlow,
  ProviderAuthStatus,
} from '@e-launcher/center-contract';
import { api, CenterApiError } from '../api';
import { CenterModelPicker } from '../components/CenterModelPicker';
import {
  Chips,
  Disclosure,
  Row,
  SearchInput,
  Section,
  Segmented,
  Switch,
  type ChoiceOption,
} from '../components/primitives';
import { SheetModal } from '../components/SheetModal';

const PROTOCOL_OPTIONS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions (/v1/chat/completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses (/v1/responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
  { value: 'google-generative-ai', label: 'Google Gemini (/v1beta/models)' },
  { value: 'pi-messages', label: 'Pi Messages' },
];

const PRIORITY_PROVIDERS = [
  'openai',
  'openai-codex',
  'anthropic',
  'google',
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

type ThinkingChoice = '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const THINKING_OPTIONS: ChoiceOption<ThinkingChoice>[] = [
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

const CODEMODE_OPTIONS: ChoiceOption<CodeModeChoice>[] = [
  { value: 'off', label: '标准工具' },
  { value: 'on', label: '开启 Code Mode' },
  { value: 'only', label: '仅 Code Mode' },
];

const BLANK_PROVIDER: Provider = {
  id: '',
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  credentialRef: null,
  native: false,
  enabled: true,
  configured: true,
  revision: 0,
};

const BLANK_MODEL: Model = {
  id: '',
  name: '',
  contextWindow: 128000,
  maxTokens: 16384,
  input: ['text'],
  reasoning: false,
  enabled: true,
  revision: 0,
};

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

const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}K`;

function deriveProviderSlug(name: string, baseUrl: string, existingIds: Set<string>): string {
  const clean = (raw: string) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

  let base = clean(name);
  if (!base && baseUrl.trim()) {
    try {
      const host = new URL(baseUrl.trim()).hostname.replace(/^(api|models|llm)\./i, '');
      base = clean(host);
    } catch {
      // ignore invalid draft URL
    }
  }
  if (!base) base = 'custom';
  if (!existingIds.has(base)) return base;
  let seq = 2;
  while (existingIds.has(`${base}-${seq}`)) seq += 1;
  return `${base}-${seq}`;
}

function deriveProviderName(name: string, baseUrl: string): string {
  if (name.trim()) return name.trim();
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return '自定义接口';
  }
}

function codeModeOf(sel?: ModelSelection): CodeModeChoice {
  if (sel?.codemodeOnly === true) return 'only';
  if (sel?.codemode === true) return 'on';
  return 'off';
}

function applyCodeMode(sel: ModelSelection, mode: CodeModeChoice): ModelSelection {
  const next: ModelSelection = { ...sel };
  if (mode === 'only') {
    next.codemode = true;
    next.codemodeOnly = true;
  } else if (mode === 'on') {
    next.codemode = true;
    next.codemodeOnly = false;
  } else {
    delete next.codemode;
    delete next.codemodeOnly;
  }
  return next;
}

function formatOAuthOption(option: { id: string; label: string }): { title: string; hint?: string } {
  if (option.id === 'browser') {
    return {
      title: '浏览器授权登录',
      hint: '打开授权页登录；若中心在远程服务器，粘贴跳转链接即可完成',
    };
  }
  if (option.id === 'device_code') {
    return {
      title: '设备码登录（远程推荐）',
      hint: '生成一次性验证码并在浏览器输入，无需本地回调端口',
    };
  }
  return { title: option.label };
}

export default function Providers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [authByProvider, setAuthByProvider] = useState<Record<string, ProviderAuthStatus>>({});
  const [picker, setPicker] = useState<ModelPickerResponse>({
    models: [],
    starredModels: [],
    defaultModel: null,
    sync: { source: 'pi', syncedAt: null, error: null },
  });
  const [globalConfig, setGlobalConfig] = useState<ModelConfig | null>(null);

  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const [pageNotice, setPageNotice] = useState('');

  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');

  // Provider drawer state
  const [edit, setEdit] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [customIdEdited, setCustomIdEdited] = useState(false);
  const [customJson, setCustomJson] = useState('{}');
  const [auth, setAuth] = useState<ProviderAuthStatus | null>(null);
  const [credential, setCredential] = useState<CredentialInfo | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ProviderAuthFlow | null>(null);
  const [reply, setReply] = useState('');
  const [copiedText, setCopiedText] = useState('');

  const [allModels, setAllModels] = useState<Model[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [drawerNotice, setDrawerNotice] = useState('');

  // Discover / restore models sub-sheet state
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverMode, setDiscoverMode] = useState<'remote' | 'restore'>('remote');
  const [discovered, setDiscovered] = useState<Model[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [discoverDeviceId, setDiscoverDeviceId] = useState('');
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState('');

  // Single model create/edit sub-sheet state
  const [modelEdit, setModelEdit] = useState<Model | null>(null);
  const [modelCreating, setModelCreating] = useState(false);
  const [modelInputTypes, setModelInputTypes] = useState('text');
  const [modelAdvancedJson, setModelAdvancedJson] = useState('{}');
  const [modelError, setModelError] = useState('');

  const refreshPageData = useCallback(async () => {
    const [nextProviders, nextPicker, nextGlobal] = await Promise.all([
      api.listProviders(),
      api.getModelPicker(),
      api.getModelConfig(),
    ]);
    setProviders(nextProviders);
    setPicker(nextPicker);
    setGlobalConfig(nextGlobal);

    const configuredList = nextProviders.filter(p => p.configured);
    const statuses = await Promise.all(
      configuredList.map(p =>
        api
          .providerAuthStatus(p.id)
          .then(s => [p.id, s] as const)
          .catch(() => null),
      ),
    );
    const map: Record<string, ProviderAuthStatus> = {};
    for (const item of statuses) {
      if (item) map[item[0]] = item[1];
    }
    setAuthByProvider(map);
    return nextProviders;
  }, []);

  useEffect(() => {
    void refreshPageData().catch(e => {
      setPageError(e instanceof Error ? e.message : String(e));
    });
  }, [refreshPageData]);

  const providerNames = useMemo(
    () => new Map(providers.map(p => [p.id, p.name || p.id])),
    [providers],
  );

  const configuredProviders = useMemo(
    () => providers.filter(p => p.configured),
    [providers],
  );

  const unconfiguredProviders = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    const list = providers.filter(
      p => !p.configured && (!q || `${p.name} ${p.id}`.toLowerCase().includes(q)),
    );
    return list.sort((a, b) => {
      const ia = PRIORITY_PROVIDERS.indexOf(a.id);
      const ib = PRIORITY_PROVIDERS.indexOf(b.id);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  }, [providers, addQuery]);

  const activeModels = useMemo(
    () => allModels.filter(m => !m.removed),
    [allModels],
  );
  const removedModels = useMemo(
    () => allModels.filter(m => m.removed),
    [allModels],
  );
  const visibleModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return activeModels;
    return activeModels.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(q));
  }, [activeModels, modelQuery]);

  const loadProviderDetails = useCallback(async (provider: Provider) => {
    const [status, key, models] = await Promise.all([
      api.providerAuthStatus(provider.id),
      provider.credentialRef
        ? api.getCredential(provider.credentialRef).catch(e => {
            if (e instanceof CenterApiError && e.status === 404) return null;
            throw e;
          })
        : Promise.resolve(null),
      api.listModels(provider.id, true),
    ]);
    setAuth(status);
    setAuthByProvider(prev => ({ ...prev, [provider.id]: status }));
    setCredential(key);
    setAllModels(models);
  }, []);

  const openProvider = useCallback(
    async (provider: Provider, isNew = false) => {
      setAddOpen(false);
      setDrawerError('');
      setDrawerNotice('');
      setCreating(isNew);
      setCustomIdEdited(false);
      setCustomJson(JSON.stringify(provider.custom ?? {}, null, 2));
      setKeyValue('');
      setFlowId(null);
      setFlow(null);
      setReply('');
      setModelQuery('');
      if (isNew) {
        const existingIds = new Set(providers.map(p => p.id));
        const id = deriveProviderSlug('', '', existingIds);
        setEdit({ ...provider, id });
        setAuth(null);
        setCredential(null);
        setAllModels([]);
        return;
      }
      setEdit(provider);
      setDrawerBusy(true);
      try {
        await loadProviderDetails(provider);
      } catch (e) {
        setDrawerError(e instanceof Error ? e.message : String(e));
      } finally {
        setDrawerBusy(false);
      }
    },
    [loadProviderDetails, providers],
  );

  // Handle legacy deep-link `/providers?open=<providerId>`
  useEffect(() => {
    const targetId = searchParams.get('open');
    if (!targetId || providers.length === 0) return;
    const found = providers.find(p => p.id === targetId);
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
    if (found) {
      void openProvider(found, false);
    }
  }, [openProvider, providers, searchParams, setSearchParams]);

  // Poll OAuth login flow status identically to Pi's interactive LoginDialog
  useEffect(() => {
    if (!flowId || !edit) return;
    let cancelled = false;
    const providerId = edit.id;

    const poll = async () => {
      try {
        const state = await api.providerLoginStatus(providerId, flowId);
        if (cancelled) return;
        setFlow(state);
        if (state.status === 'complete') {
          setFlowId(null);
          setDrawerError('');
          setDrawerNotice('账号已连接，模型目录已同步');
          const latestProviders = await refreshPageData();
          const refreshed = latestProviders.find(p => p.id === providerId);
          if (refreshed) {
            setEdit(refreshed);
            await loadProviderDetails(refreshed);
          }
          return;
        }
        if (state.status === 'failed' || state.status === 'cancelled') {
          setFlowId(null);
        }
      } catch (e) {
        if (!cancelled) {
          setDrawerError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void poll();
    const fastKick = setTimeout(() => {
      void poll();
    }, 300);
    const timer = setInterval(() => {
      void poll();
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(fastKick);
      clearInterval(timer);
    };
  }, [flowId, edit?.id, loadProviderDetails, refreshPageData]);

  const closeDrawer = () => {
    if (flowId && edit) {
      void api.providerLoginCancel(edit.id, flowId).catch(() => {});
    }
    setEdit(null);
    setFlowId(null);
    setFlow(null);
  };

  const runPageAction = async (work: () => Promise<void>) => {
    setPageBusy(true);
    setPageError('');
    setPageNotice('');
    try {
      await work();
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      setPageBusy(false);
    }
  };

  const runDrawerAction = async (work: () => Promise<void>) => {
    setDrawerBusy(true);
    setDrawerError('');
    setDrawerNotice('');
    try {
      await work();
    } catch (e) {
      setDrawerError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrawerBusy(false);
    }
  };

  const updateGlobalSelection = async (nextValue: ModelSelection, message?: string) => {
    if (!globalConfig) return;
    await runPageAction(async () => {
      const saved = await api.putModelConfig({
        expectedRevision: globalConfig.revision,
        value: nextValue,
      });
      setGlobalConfig(saved);
      if (message) setPageNotice(message);
    });
  };

  const toggleProviderEnabled = async (provider: Provider, nextEnabled: boolean) => {
    await runPageAction(async () => {
      await api.putProvider(provider.id, {
        expectedRevision: provider.revision,
        value: { ...provider, enabled: nextEnabled, configured: true },
      });
      await refreshPageData();
    });
  };

  const parseCustomSettings = (): JsonObject => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(customJson || '{}');
    } catch {
      throw new Error('高级覆盖配置必须是合法的 JSON 对象');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('高级覆盖配置必须是 JSON 对象');
    }
    const obj = parsed as JsonObject;
    if (obj.apiKey !== undefined) {
      throw new Error('请使用上方的 API Key 输入框安全保存密钥，不要写入 JSON');
    }
    return obj;
  };

  // Persist custom or native provider settings (and any typed API Key in one step)
  const persistProvider = useCallback(
    async (opts?: { silentNotice?: boolean }): Promise<Provider> => {
      if (!edit) throw new Error('未选择服务商');
      const settings = parseCustomSettings();
      const trimmedKey = keyValue.trim();

      if (!edit.native && !edit.baseUrl.trim() && typeof settings.baseUrl !== 'string') {
        throw new Error('请填写 API 地址（例如 https://api.example.com/v1）');
      }

      const existingIds = new Set(providers.map(p => p.id));
      const finalId = creating
        ? (customIdEdited && edit.id.trim()
            ? edit.id.trim()
            : deriveProviderSlug(edit.name, edit.baseUrl, existingIds))
        : edit.id;
      const finalName = !edit.native ? deriveProviderName(edit.name, edit.baseUrl) : edit.name;

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
        enabled: creating ? true : trimmedKey ? true : edit.enabled,
        custom: settings,
      };

      const saved = creating
        ? await api.createProvider(payload)
        : await api.putProvider(payload.id, {
            expectedRevision: edit.revision,
            value: payload,
          });

      if (trimmedKey && saved.credentialRef) {
        const currentCred =
          credential?.credentialId === saved.credentialRef
            ? credential
            : await api.getCredential(saved.credentialRef).catch(e => {
                if (e instanceof CenterApiError && e.status === 404) return null;
                throw e;
              });
        const written = await api.putCredential(saved.credentialRef, {
          value: trimmedKey,
          expectedRevision: currentCred?.revision ?? null,
        });
        setCredential(written);
        setKeyValue('');
      }

      setCreating(false);
      setEdit(saved);
      await refreshPageData();
      await loadProviderDetails(saved);
      if (!opts?.silentNotice) {
        setDrawerNotice(creating ? '服务商已创建' : '设置已保存');
      }
      return saved;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [creating, credential, customIdEdited, customJson, edit, keyValue, loadProviderDetails, providers, refreshPageData],
  );

  const saveNativeApiKey = async () => {
    if (!edit || !keyValue.trim()) return;
    await runDrawerAction(async () => {
      const ref = edit.credentialRef || `${edit.id}-api-key`;
      const savedCred = await api.putCredential(ref, {
        value: keyValue.trim(),
        expectedRevision: credential?.revision ?? null,
      });
      setCredential(savedCred);
      setKeyValue('');
      const updated = await api.putProvider(edit.id, {
        expectedRevision: edit.revision,
        value: { ...edit, credentialRef: ref, enabled: true, configured: true },
      });
      setEdit(updated);
      await refreshPageData();
      await loadProviderDetails(updated);
      setDrawerNotice('API Key 已保存并启用');
    });
  };

  const clearApiKey = async () => {
    if (!edit || !edit.credentialRef || !credential?.configured) return;
    await runDrawerAction(async () => {
      await api.deleteCredential(edit.credentialRef!, {
        expectedRevision: credential.revision,
        value: null,
      });
      setCredential(null);
      if (!edit.native) {
        const updated = await api.putProvider(edit.id, {
          expectedRevision: edit.revision,
          value: { ...edit, credentialRef: null, configured: true },
        });
        setEdit(updated);
        await refreshPageData();
        await loadProviderDetails(updated);
        setDrawerNotice('已清除密钥并切换为免密钥模式');
      } else {
        const nextStatus = await api.providerAuthStatus(edit.id);
        let target = edit;
        if (nextStatus.method === 'none' && edit.enabled) {
          target = await api.putProvider(edit.id, {
            expectedRevision: edit.revision,
            value: { ...edit, enabled: false, configured: true },
          });
          setEdit(target);
        }
        await refreshPageData();
        await loadProviderDetails(target);
        setDrawerNotice('已清除保存的密钥');
      }
    });
  };

  const startOAuthLogin = async () => {
    if (!edit) return;
    await runDrawerAction(async () => {
      const { flowId: nextId } = await api.providerLogin(edit.id);
      setFlow(null);
      setReply('');
      setFlowId(nextId);
    });
  };

  const submitOAuthAnswer = async (value: string) => {
    if (!edit || !flowId) return;
    setDrawerBusy(true);
    setDrawerError('');
    try {
      await api.providerLoginAnswer(edit.id, flowId, value);
      setReply('');
      const state = await api.providerLoginStatus(edit.id, flowId);
      setFlow(state);
    } catch (e) {
      // Keep flowId alive on validation errors (e.g. incomplete callback URL) so user can re-paste!
      setDrawerError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrawerBusy(false);
    }
  };

  const copyToClipboard = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(tag);
      setTimeout(() => {
        setCopiedText(prev => (prev === tag ? '' : prev));
      }, 1800);
    } catch {
      // Clipboard API unavailable on non-HTTPS origin; user can select manually.
    }
  };

  const handleDeleteProvider = async () => {
    if (!edit || creating) return;
    const label = edit.name || edit.id;
    const confirmed = window.confirm(
      `确定删除服务商「${label}」吗？\n\n这会一并清除已登录的账号授权、保存的 API Key 及自定义模型配置。`,
    );
    if (!confirmed) return;
    await runDrawerAction(async () => {
      if (flowId) {
        await api.providerLoginCancel(edit.id, flowId).catch(() => {});
        setFlowId(null);
      }
      await api.deleteProvider(edit.id);
      setEdit(null);
      await refreshPageData();
      setPageNotice(`已删除服务商「${label}」`);
    });
  };

  // Discover from /v1/models or restore removed catalog models
  const runDiscoverFetch = async (targetProvider: Provider, viaDeviceId = '') => {
    setDiscoverBusy(true);
    setDiscoverError('');
    try {
      const settings = parseCustomSettings();
      const headers =
        settings.headers && typeof settings.headers === 'object' && !Array.isArray(settings.headers)
          ? (settings.headers as JsonObject)
          : undefined;
      const result = await api.discoverModels(targetProvider.id, {
        ...(viaDeviceId ? { deviceId: viaDeviceId } : {}),
        ...(!targetProvider.native && edit?.baseUrl.trim() ? { baseUrl: edit.baseUrl.trim() } : {}),
        ...(!targetProvider.native && edit?.api.trim() ? { api: edit.api.trim() } : {}),
        ...(keyValue.trim() ? { apiKey: keyValue.trim() } : {}),
        ...(headers ? { headers } : {}),
      });
      setDiscovered(result.models);
      const existingSet = new Set(activeModels.map(m => m.id));
      const freshIds = result.models.filter(m => !existingSet.has(m.id)).map(m => m.id);
      setSelectedIds(new Set(freshIds));
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscoverBusy(false);
    }
  };

  const openDiscoverSheet = async () => {
    if (!edit) return;
    setDrawerError('');
    let target = edit;
    if (creating) {
      setDrawerBusy(true);
      try {
        target = await persistProvider({ silentNotice: true });
      } catch (e) {
        setDrawerError(e instanceof Error ? e.message : String(e));
        setDrawerBusy(false);
        return;
      }
      setDrawerBusy(false);
    }
    setDiscoverMode('remote');
    setDiscovered([]);
    setSelectedIds(new Set());
    setDiscoverQuery('');
    setDiscoverDeviceId('');
    setDiscoverError('');
    setDiscoverOpen(true);
    void api
      .listDevices()
      .then(setDevices)
      .catch(() => {});
    await runDiscoverFetch(target, '');
  };

  const openRestoreSheet = () => {
    setDiscoverMode('restore');
    setDiscovered(removedModels.map(m => ({ ...m, removed: false, enabled: true })));
    setSelectedIds(new Set(removedModels.map(m => m.id)));
    setDiscoverQuery('');
    setDiscoverError('');
    setDiscoverOpen(true);
  };

  const confirmBatchAddModels = async () => {
    if (!edit || selectedIds.size === 0) return;
    setDiscoverBusy(true);
    setDiscoverError('');
    try {
      const chosen = discovered
        .filter(m => selectedIds.has(m.id))
        .map(m => ({
          ...m,
          enabled: true,
          removed: false,
          revision: 0,
        }));
      await api.createModelsBatch(edit.id, { models: chosen });
      if (!edit.configured) {
        const updated = await api.putProvider(edit.id, {
          expectedRevision: edit.revision,
          value: { ...edit, configured: true },
        });
        setEdit(updated);
      }
      await loadProviderDetails(edit);
      await refreshPageData();
      setDiscoverOpen(false);
      setDrawerNotice(`已添加 ${chosen.length} 个模型`);
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscoverBusy(false);
    }
  };

  const openModelEditor = async (model: Model, isNew: boolean) => {
    if (!edit) return;
    if (creating) {
      setDrawerBusy(true);
      try {
        await persistProvider({ silentNotice: true });
      } catch (e) {
        setDrawerError(e instanceof Error ? e.message : String(e));
        setDrawerBusy(false);
        return;
      }
      setDrawerBusy(false);
    }
    setModelEdit(model);
    setModelCreating(isNew);
    setModelError('');
    setModelInputTypes(model.input.join(', '));
    const extra: Record<string, unknown> = {};
    for (const key of EXTRA_MODEL_KEYS) {
      if (model[key] !== undefined) extra[key] = model[key];
    }
    setModelAdvancedJson(JSON.stringify(extra, null, 2));
  };

  const saveModelEditor = async () => {
    if (!edit || !modelEdit) return;
    setDrawerBusy(true);
    setModelError('');
    try {
      let extra: unknown;
      try {
        extra = JSON.parse(modelAdvancedJson || '{}');
      } catch {
        throw new Error('高级参数必须是合法的 JSON 对象');
      }
      if (
        !extra ||
        Array.isArray(extra) ||
        typeof extra !== 'object' ||
        Object.keys(extra).some(k => !(EXTRA_MODEL_KEYS as readonly string[]).includes(k))
      ) {
        throw new Error('高级参数包含不支持的字段');
      }
      const input = modelInputTypes
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      if (input.length === 0) throw new Error('至少填写一个输入类型（例如 text）');
      if (!modelEdit.id.trim()) throw new Error('请填写模型 ID');

      const base: Record<string, unknown> = { ...modelEdit };
      for (const key of EXTRA_MODEL_KEYS) delete base[key];
      const payload = {
        ...(base as unknown as Model),
        ...(extra as JsonObject),
        id: modelEdit.id.trim(),
        name: modelEdit.name.trim() || modelEdit.id.trim(),
        input,
      } as Model;

      if (modelCreating) {
        await api.createModel(edit.id, payload);
      } else {
        await api.putModel(edit.id, modelEdit.id, {
          expectedRevision: modelEdit.revision,
          value: payload,
        });
      }
      if (!edit.configured) {
        const updated = await api.putProvider(edit.id, {
          expectedRevision: edit.revision,
          value: { ...edit, configured: true },
        });
        setEdit(updated);
      }
      await loadProviderDetails(edit);
      await refreshPageData();
      setModelEdit(null);
      setDrawerNotice(modelCreating ? '模型已添加' : '模型已更新');
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrawerBusy(false);
    }
  };

  const toggleModelEnabled = async (model: Model, nextEnabled: boolean) => {
    if (!edit) return;
    await runDrawerAction(async () => {
      await api.putModel(edit.id, model.id, {
        expectedRevision: model.revision,
        value: { ...model, enabled: nextEnabled },
      });
      await loadProviderDetails(edit);
      await refreshPageData();
    });
  };

  const handleDeleteModel = async (model: Model) => {
    if (!edit) return;
    const label = model.name || model.id;
    if (!window.confirm(`确定删除模型「${label}」吗？`)) return;
    await runDrawerAction(async () => {
      await api.deleteModel(edit.id, model.id);
      await loadProviderDetails(edit);
      await refreshPageData();
      setDrawerNotice(`已删除模型「${label}」`);
    });
  };

  // Derived values for Default Settings section
  const selectedModelRef = globalConfig?.global.modelRef ?? null;
  const selectedModelItem = useMemo(
    () => (selectedModelRef ? picker.models.find(m => m.modelRef === selectedModelRef) : undefined),
    [picker.models, selectedModelRef],
  );
  const currentThinking = ((globalConfig?.global.thinkingLevel ?? '') as ThinkingChoice);
  const currentCodeMode = codeModeOf(globalConfig?.global);

  const renderProviderStatus = (provider: Provider) => {
    const status = authByProvider[provider.id];
    let connected = false;
    let text = '';
    if (status?.method === 'oauth') {
      connected = true;
      text = '账号已连接';
    } else if (status?.method === 'api_key') {
      connected = true;
      text = 'API Key 已配置';
    } else if (!provider.native && !provider.credentialRef) {
      connected = true;
      text = provider.baseUrl ? `免密钥 · ${provider.baseUrl}` : '免密钥接口';
    } else {
      text = '待配置认证';
    }
    if (!provider.enabled) text += ' · 已停用';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span className={`cw-status-dot ${connected && provider.enabled ? 'is-ok' : !connected ? 'is-warn' : ''}`} />
        <span>{text}</span>
      </span>
    );
  };

  // OAuth flow latest events
  const latestAuthEvent = useMemo(
    () =>
      flow?.events
        .filter(e => e.type === 'auth_url' || e.type === 'device_code')
        .slice(-1)[0] ?? null,
    [flow?.events],
  );
  const infoEvents = useMemo(
    () => flow?.events.filter(e => e.type === 'info' || e.type === 'progress').slice(-2) ?? [],
    [flow?.events],
  );

  const supportsApiKey = !edit?.native || auth?.apiKey !== false;
  const hideKeyInDisclosure = Boolean(edit?.native && auth?.oauth && auth.method === 'oauth' && supportsApiKey);

  const filteredDiscovered = useMemo(() => {
    const q = discoverQuery.trim().toLowerCase();
    if (!q) return discovered;
    return discovered.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(q));
  }, [discovered, discoverQuery]);

  const existingActiveSet = useMemo(() => new Set(activeModels.map(m => m.id)), [activeModels]);
  const selectableDiscoveredIds = useMemo(
    () =>
      filteredDiscovered
        .filter(m => discoverMode === 'restore' || !existingActiveSet.has(m.id))
        .map(m => m.id),
    [discoverMode, existingActiveSet, filteredDiscovered],
  );

  const renderNativeApiKeyFields = () => {
    if (!edit || !supportsApiKey) return null;
    return (
      <div className="cw-block">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>API Key 密钥</span>
          <span className="secondary" style={{ fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`cw-status-dot ${credential?.configured ? 'is-ok' : ''}`} />
            {credential?.configured ? '已保存密钥' : '未配置'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="password"
            style={{ flex: '1 1 220px' }}
            value={keyValue}
            autoComplete="new-password"
            placeholder={credential?.configured ? '输入新密钥以替换现有密钥' : '粘贴 API Key'}
            onChange={e => setKeyValue(e.target.value)}
          />
          <button
            type="button"
            className="cw-btn is-primary"
            disabled={!keyValue.trim() || drawerBusy}
            onClick={() => void saveNativeApiKey()}
          >
            保存密钥
          </button>
          {credential?.configured ? (
            <button
              type="button"
              className="cw-btn is-ghost is-danger"
              disabled={drawerBusy}
              onClick={() => void clearApiKey()}
            >
              清除已存密钥
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <main className="cw-page">
      <header className="cw-header">
        <h1>模型</h1>
        <button
          type="button"
          className="cw-btn is-primary"
          onClick={() => {
            setAddQuery('');
            setAddOpen(true);
          }}
        >
          <Plus size={16} />
          添加服务商
        </button>
      </header>

      {pageError ? <p role="alert" className="inline-error">{pageError}</p> : null}
      {pageNotice ? <p role="status" className="inline-notice">{pageNotice}</p> : null}

      {/* Section 1: Default Model + Default Thinking Level in a single minimalist card */}
      <Section title="默认设置">
        <Row
          title="默认模型"
          subtitle={
            selectedModelRef
              ? selectedModelItem
                ? `${selectedModelItem.name} · ${selectedModelRef}`
                : `${selectedModelRef}（对应服务商未启用或模型已移除）`
              : '未设置，点击选择全局默认模型'
          }
          trailing={selectedModelRef ? '修改' : '选择'}
          chevron
          disabled={pageBusy || !globalConfig}
          onClick={() => setPickerOpen(true)}
        />
        <div className="cw-block">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: '0.92rem', fontWeight: 550 }}>默认思考强度</span>
            <span className="secondary" style={{ fontSize: '0.78rem' }}>
              {currentThinking ? `当前：${THINKING_OPTIONS.find(o => o.value === currentThinking)?.label ?? currentThinking}` : '跟随模型 SDK 默认'}
            </span>
          </div>
          <Chips
            label="默认思考强度"
            value={currentThinking}
            options={THINKING_OPTIONS}
            disabled={pageBusy || !globalConfig}
            onChange={next => {
              if (!globalConfig) return;
              const copy: ModelSelection = { ...globalConfig.global };
              if (!next) delete copy.thinkingLevel;
              else copy.thinkingLevel = next;
              void updateGlobalSelection(copy);
            }}
          />
        </div>
      </Section>

      <Disclosure label="高级策略">
        <div className="cw-field">
          <span>工具执行模式 (Code Mode)</span>
          <Segmented
            label="工具执行模式"
            value={currentCodeMode}
            options={CODEMODE_OPTIONS}
            disabled={pageBusy || !globalConfig}
            onChange={mode => {
              if (!globalConfig) return;
              void updateGlobalSelection(applyCodeMode(globalConfig.global, mode));
            }}
          />
          <span className="secondary" style={{ fontSize: '0.77rem' }}>
            开启后模型可在 QuickJS 沙盒中编排多工具脚本；「仅 Code Mode」将所有工具转为按需渐进加载。
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 4 }}>
          <span className="secondary" style={{ fontSize: '0.8rem' }}>
            从 models.dev 拉取最新内置服务商模型目录
          </span>
          <button
            type="button"
            className="cw-btn is-small"
            disabled={pageBusy}
            onClick={() =>
              void runPageAction(async () => {
                const res = await api.syncModelCatalog();
                await refreshPageData();
                setPageNotice(res.error || '内置模型目录已同步');
              })
            }
          >
            <RefreshCw size={14} />
            同步目录
          </button>
        </div>
      </Disclosure>

      {/* Section 2: Configured Providers single-column hairline list */}
      <Section title="服务商" bare={configuredProviders.length === 0}>
        {configuredProviders.length === 0 ? (
          <div className="cw-empty">
            <strong>还没有配置模型服务商</strong>
            <p className="secondary">
              点击右上角「添加服务商」，可登录 ChatGPT / Codex / Claude 账号，填写 API Key，或接入任意 OpenAI 兼容接口。
            </p>
          </div>
        ) : (
          configuredProviders.map(provider => (
            <Row
              key={provider.id}
              muted={!provider.enabled}
              title={provider.name || provider.id}
              subtitle={renderProviderStatus(provider)}
              chevron
              onClick={() => void openProvider(provider, false)}
              trailing={
                <Switch
                  checked={provider.enabled}
                  disabled={pageBusy}
                  label={`启用 ${provider.name || provider.id}`}
                  onChange={next => void toggleProviderEnabled(provider, next)}
                />
              }
            />
          ))
        )}
      </Section>

      {/* Sheet 1: Default Model Picker */}
      <SheetModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="选择默认模型"
        description="所有未单独指定模型覆盖的 Bot 默认使用此模型"
        size="lg"
      >
        <CenterModelPicker
          catalog={picker}
          providerNames={providerNames}
          value={selectedModelRef}
          disabled={pageBusy}
          onStarsChange={starredModels => setPicker(prev => ({ ...prev, starredModels }))}
          onChange={nextModelRef => {
            if (!globalConfig) return;
            const copy: ModelSelection = { ...globalConfig.global };
            if (nextModelRef === null) delete copy.modelRef;
            else copy.modelRef = nextModelRef;
            setPickerOpen(false);
            void updateGlobalSelection(copy, nextModelRef ? '默认模型已更新' : '已清空默认模型');
          }}
        />
      </SheetModal>

      {/* Sheet 2: Add Provider Selector */}
      <SheetModal
        open={addOpen}
        onOpenChange={setAddOpen}
        title="添加服务商"
        description="连接主流平台账号 / API Key，或接入自建兼容接口"
        size="lg"
      >
        <div className="cw-drawer-stack">
          <div className="cw-card">
            <Row
              icon={<Plus size={17} />}
              title="自定义兼容接口"
              subtitle="OpenAI / Anthropic / Gemini 兼容 API，或本地免密 Ollama / vLLM"
              chevron
              onClick={() => void openProvider({ ...BLANK_PROVIDER }, true)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SearchInput
              value={addQuery}
              onChange={setAddQuery}
              placeholder="搜索内置服务商（如 OpenAI、Codex、Claude、Gemini、DeepSeek）…"
            />
            <div className="cw-picker-scroll">
              {unconfiguredProviders.length > 0 ? (
                <div className="cw-card">
                  {unconfiguredProviders.map(p => (
                    <Row
                      key={p.id}
                      title={p.name || p.id}
                      subtitle={p.id}
                      chevron
                      onClick={() => void openProvider(p, false)}
                    />
                  ))}
                </div>
              ) : (
                <div className="cw-empty">
                  <strong>没有匹配的内置服务商</strong>
                  <p className="secondary">你可以使用上方的「自定义兼容接口」接入任意兼容服务。</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </SheetModal>

      {/* Sheet 3: Unified Provider Configuration Drawer */}
      <SheetModal
        open={edit !== null}
        onOpenChange={isOpen => {
          if (!isOpen) closeDrawer();
        }}
        title={creating ? '添加兼容接口' : (edit?.name || edit?.id || '服务商设置')}
        description={
          edit?.native
            ? `${edit.id} · 内置服务商`
            : creating
              ? '填写接口地址与可选密钥，即可直接从 /v1/models 拉取模型'
              : `${edit?.id ?? ''} · 自定义兼容接口`
        }
        size="lg"
      >
        {edit ? (
          <div className="cw-drawer-stack">
            {drawerError ? <p role="alert" className="inline-error">{drawerError}</p> : null}
            {drawerNotice ? <p role="status" className="inline-notice">{drawerNotice}</p> : null}

            {/* Connection & Authentication Card */}
            <Section title={edit.native ? '连接认证' : '接口与认证'}>
              {/* Native OAuth section (ported from Pi LoginDialog) */}
              {!creating && auth?.oauth ? (
                <div className="cw-block">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: '0.93rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <span className={`cw-status-dot ${auth.method === 'oauth' ? 'is-ok' : ''}`} />
                        {auth.method === 'oauth' ? '账号已连接' : '账号授权'}
                      </span>
                      <span className="secondary" style={{ fontSize: '0.79rem' }}>
                        {auth.method === 'oauth'
                          ? '已通过 Pi 原生 OAuth 授权并自动维护令牌续期'
                          : '使用官方账号授权直接调用订阅或账户模型'}
                      </span>
                    </div>
                    {auth.method === 'oauth' ? (
                      <button
                        type="button"
                        className="cw-btn is-small is-ghost is-danger"
                        disabled={drawerBusy}
                        onClick={() =>
                          void runDrawerAction(async () => {
                            const nextStatus = await api.providerLogout(edit.id);
                            setAuth(nextStatus);
                            await refreshPageData();
                            await loadProviderDetails(edit);
                            setDrawerNotice('已退出账号登录');
                          })
                        }
                      >
                        退出登录
                      </button>
                    ) : !flowId ? (
                      <button
                        type="button"
                        className="cw-btn is-accent"
                        disabled={drawerBusy}
                        onClick={() => void startOAuthLogin()}
                      >
                        {auth.label || '连接账号'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="cw-btn is-small is-ghost"
                        onClick={() => {
                          if (flowId) void api.providerLoginCancel(edit.id, flowId).catch(() => {});
                          setFlowId(null);
                          setFlow(null);
                        }}
                      >
                        取消授权
                      </button>
                    )}
                  </div>

                  {/* Active or failed OAuth interactive flow */}
                  {flow && (flowId || flow.status === 'failed') ? (
                    <div className="cw-oauth-flow">
                      {/* 1. Method selection prompt (e.g. OpenAI Codex: browser vs device_code) */}
                      {flow.prompt?.type === 'select' && flow.prompt.options ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <span style={{ fontSize: '0.84rem', fontWeight: 550 }}>选择登录方式：</span>
                          <div className="cw-card">
                            {flow.prompt.options.map(opt => {
                              const desc = formatOAuthOption(opt);
                              return (
                                <Row
                                  key={opt.id}
                                  title={desc.title}
                                  subtitle={desc.hint}
                                  chevron
                                  disabled={drawerBusy}
                                  onClick={() => void submitOAuthAnswer(opt.id)}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {/* 2. Browser authorization URL event */}
                      {latestAuthEvent?.type === 'auth_url' && latestAuthEvent.url ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            <a
                              className="cw-btn is-accent"
                              href={latestAuthEvent.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink size={15} />
                              打开授权页面
                            </a>
                            <button
                              type="button"
                              className="cw-btn is-small"
                              onClick={() => void copyToClipboard(latestAuthEvent.url!, 'auth_url')}
                            >
                              {copiedText === 'auth_url' ? <Check size={14} /> : <Copy size={14} />}
                              {copiedText === 'auth_url' ? '已复制链接' : '复制授权链接'}
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {/* 3. Device code event (mirrors Pi LoginDialog.activateDeviceCode) */}
                      {latestAuthEvent?.type === 'device_code' && latestAuthEvent.userCode ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span className="secondary" style={{ fontSize: '0.83rem' }}>一次性授权码：</span>
                            <span className="cw-code-pill">{latestAuthEvent.userCode}</span>
                            <button
                              type="button"
                              className="cw-btn is-small is-ghost"
                              onClick={() => void copyToClipboard(latestAuthEvent.userCode!, 'device_code')}
                            >
                              {copiedText === 'device_code' ? <Check size={14} /> : <Copy size={14} />}
                              {copiedText === 'device_code' ? '已复制' : '复制'}
                            </button>
                          </div>
                          {latestAuthEvent.verificationUri ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              <a
                                className="cw-btn is-accent"
                                href={latestAuthEvent.verificationUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => void copyToClipboard(latestAuthEvent.userCode!, 'device_code')}
                              >
                                <ExternalLink size={15} />
                                复制授权码并打开验证页
                              </a>
                            </div>
                          ) : null}
                          <span className="secondary" style={{ fontSize: '0.79rem' }}>
                            在打开的验证页输入上方授权码后，此处会自动完成连接…
                          </span>
                        </div>
                      ) : null}

                      {/* 4. Manual callback / code prompt */}
                      {flow.prompt && flow.prompt.type !== 'select' ? (
                        <form
                          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                          onSubmit={e => {
                            e.preventDefault();
                            if (reply.trim()) void submitOAuthAnswer(reply);
                          }}
                        >
                          <span className="secondary" style={{ fontSize: '0.79rem', lineHeight: 1.45 }}>
                            {flow.prompt.type === 'manual_code'
                              ? '若中心运行在远程服务器，浏览器登录完成后跳转到 localhost / 127.0.0.1 显示无法访问属正常现象——直接复制浏览器地址栏的完整链接粘贴到下方即可：'
                              : flow.prompt.message}
                          </span>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type={flow.prompt.type === 'secret' ? 'password' : 'text'}
                              style={{ flex: '1 1 220px' }}
                              value={reply}
                              placeholder={flow.prompt.placeholder || '粘贴完整回调链接或授权码'}
                              onChange={e => setReply(e.target.value)}
                            />
                            <button
                              type="submit"
                              className="cw-btn is-primary"
                              disabled={!reply.trim() || drawerBusy}
                            >
                              完成验证
                            </button>
                          </div>
                        </form>
                      ) : null}

                      {/* 5. Progress / info / error status */}
                      {infoEvents.map((ev, idx) => (
                        <span key={idx} className="secondary" style={{ fontSize: '0.79rem' }}>
                          {ev.message}
                        </span>
                      ))}
                      {flow.status === 'pending' && !flow.prompt && !latestAuthEvent ? (
                        <span className="secondary" style={{ fontSize: '0.8rem' }}>正在准备授权流程…</span>
                      ) : null}
                      {flow.error ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                          <span className="inline-error" style={{ margin: 0, flex: '1 1 200px' }}>{flow.error}</span>
                          <button
                            type="button"
                            className="cw-btn is-small"
                            disabled={drawerBusy}
                            onClick={() => void startOAuthLogin()}
                          >
                            重新发起登录
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Native API Key (direct when primary auth, or tucked into disclosure when OAuth is connected) */}
              {edit.native && !hideKeyInDisclosure ? renderNativeApiKeyFields() : null}

              {/* Custom Provider Connection Fields */}
              {!edit.native ? (
                <div className="cw-block">
                  <div className="cw-field-grid">
                    <label className="cw-field">
                      <span>显示名称</span>
                      <input
                        value={edit.name}
                        placeholder="例如：本地 Ollama / DeepSeek 代理"
                        onChange={e => {
                          const nextName = e.target.value;
                          const existingIds = new Set(providers.map(p => p.id));
                          setEdit({
                            ...edit,
                            name: nextName,
                            ...(creating && !customIdEdited
                              ? { id: deriveProviderSlug(nextName, edit.baseUrl, existingIds) }
                              : {}),
                          });
                        }}
                      />
                    </label>
                    <label className="cw-field">
                      <span>协议类型</span>
                      <select
                        value={edit.api}
                        onChange={e => setEdit({ ...edit, api: e.target.value })}
                      >
                        {PROTOCOL_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                        {!PROTOCOL_OPTIONS.some(o => o.value === edit.api) ? (
                          <option value={edit.api}>{edit.api}</option>
                        ) : null}
                      </select>
                    </label>
                  </div>

                  <label className="cw-field">
                    <span>API 地址</span>
                    <input
                      type="url"
                      value={edit.baseUrl}
                      placeholder="https://api.example.com/v1 或 http://127.0.0.1:11434/v1"
                      onChange={e => {
                        const nextUrl = e.target.value;
                        const existingIds = new Set(providers.map(p => p.id));
                        setEdit({
                          ...edit,
                          baseUrl: nextUrl,
                          ...(creating && !customIdEdited
                            ? { id: deriveProviderSlug(edit.name, nextUrl, existingIds) }
                            : {}),
                        });
                      }}
                    />
                  </label>

                  <div className="cw-field">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span>API Key（可选）</span>
                      <span className="secondary" style={{ fontSize: '0.77rem' }}>
                        {credential?.configured ? '已保存密钥' : '本地免密钥服务可直接留空'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="password"
                        style={{ flex: '1 1 220px' }}
                        value={keyValue}
                        autoComplete="new-password"
                        placeholder={
                          credential?.configured
                            ? '输入新密钥以替换（留空保持不变）'
                            : '粘贴 API Key（免密接口留空即可）'
                        }
                        onChange={e => setKeyValue(e.target.value)}
                      />
                      {!creating && credential?.configured ? (
                        <button
                          type="button"
                          className="cw-btn is-ghost is-danger"
                          disabled={drawerBusy}
                          onClick={() => void clearApiKey()}
                        >
                          清除密钥（改为免密）
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </Section>

            {hideKeyInDisclosure ? (
              <Disclosure label="改用 API Key 密钥">
                {renderNativeApiKeyFields()}
              </Disclosure>
            ) : null}

            {/* Models Section inside the same unified drawer */}
            <Section
              title={`模型 (${activeModels.length})`}
              bare={activeModels.length === 0}
              action={
                <>
                  <button
                    type="button"
                    className="cw-btn is-small"
                    disabled={drawerBusy}
                    onClick={() => void openDiscoverSheet()}
                  >
                    <Sparkles size={14} />
                    从 /v1/models 拉取
                  </button>
                  <button
                    type="button"
                    className="cw-btn is-small"
                    disabled={drawerBusy}
                    onClick={() => void openModelEditor({ ...BLANK_MODEL }, true)}
                  >
                    <Plus size={14} />
                    手动添加
                  </button>
                </>
              }
              hint={
                removedModels.length > 0 ? (
                  <span>
                    已从此服务商移除 {removedModels.length} 个内置目录模型 ·{' '}
                    <button
                      type="button"
                      style={{ color: 'var(--accent)', fontWeight: 550, padding: 0 }}
                      onClick={openRestoreSheet}
                    >
                      恢复
                    </button>
                  </span>
                ) : undefined
              }
            >
              {activeModels.length > 6 ? (
                <div className="cw-block" style={{ paddingBottom: 10 }}>
                  <SearchInput
                    value={modelQuery}
                    onChange={setModelQuery}
                    placeholder="筛选此服务商下的模型…"
                  />
                </div>
              ) : null}

              {activeModels.length === 0 ? (
                <div className="cw-empty" style={{ padding: '26px 18px' }}>
                  <strong>暂无已添加的模型</strong>
                  <p className="secondary">
                    点击「从 /v1/models 拉取」自动获取模型列表，或手动填写模型 ID。
                  </p>
                </div>
              ) : (
                <div className="cw-model-scroll">
                  {visibleModels.map(model => (
                    <Row
                      key={model.id}
                      muted={!model.enabled}
                      title={model.name || model.id}
                      subtitle={`${model.id} · ${formatTokens(model.contextWindow)}${model.reasoning ? ' · 推理' : ''}`}
                      onClick={() => void openModelEditor(model, false)}
                      trailing={
                        <>
                          <Switch
                            checked={model.enabled}
                            disabled={drawerBusy}
                            label={`启用模型 ${model.name || model.id}`}
                            onChange={next => void toggleModelEnabled(model, next)}
                          />
                          <button
                            type="button"
                            className="cw-icon-btn is-danger"
                            title="删除模型"
                            aria-label={`删除模型 ${model.name || model.id}`}
                            disabled={drawerBusy}
                            onClick={e => {
                              e.stopPropagation();
                              void handleDeleteModel(model);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      }
                    />
                  ))}
                </div>
              )}
            </Section>

            {/* Low-frequency Advanced Settings tucked away */}
            <Disclosure label="高级设置">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: '0.88rem', fontWeight: 550 }}>启用此服务商</span>
                <Switch
                  checked={edit.enabled}
                  disabled={drawerBusy}
                  label="启用此服务商"
                  onChange={next => setEdit({ ...edit, enabled: next })}
                />
              </div>

              <div className="cw-field-grid">
                <label className="cw-field">
                  <span>服务商 ID</span>
                  <input
                    disabled={!creating}
                    value={edit.id}
                    placeholder="custom"
                    onChange={e => {
                      setCustomIdEdited(true);
                      setEdit({ ...edit, id: e.target.value });
                    }}
                  />
                </label>
                {edit.native ? (
                  <label className="cw-field">
                    <span>显示名称覆盖</span>
                    <input
                      value={edit.name}
                      onChange={e => setEdit({ ...edit, name: e.target.value })}
                    />
                  </label>
                ) : null}
              </div>

              {!creating ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <span className="secondary" style={{ fontSize: '0.79rem' }}>
                    测试当前地址与凭证是否可连通上游接口
                  </span>
                  <button
                    type="button"
                    className="cw-btn is-small"
                    disabled={drawerBusy}
                    onClick={() =>
                      void runDrawerAction(async () => {
                        const res = await api.validateProvider(edit.id, {
                          ...(!edit.native && edit.baseUrl.trim() ? { baseUrl: edit.baseUrl.trim() } : {}),
                          ...(!edit.native && edit.api.trim() ? { api: edit.api.trim() } : {}),
                          ...(keyValue.trim() ? { apiKey: keyValue.trim() } : {}),
                        });
                        if (!res.ok) throw new Error(res.message || '连通性测试未通过');
                        setDrawerNotice(res.message || '连通性测试通过');
                      })
                    }
                  >
                    连通性测试
                  </button>
                </div>
              ) : null}

              <label className="cw-field">
                <span>Pi models.json 高级覆盖 (JSON)</span>
                <textarea
                  rows={5}
                  spellCheck={false}
                  value={customJson}
                  onChange={e => setCustomJson(e.target.value)}
                />
                <span className="secondary" style={{ fontSize: '0.75rem' }}>
                  支持覆盖 headers、baseUrl、api、modelOverrides 等字段；无需定制保持 {'{}'} 即可。
                </span>
              </label>
            </Disclosure>

            {/* Drawer Footer */}
            <div className="cw-drawer-footer">
              <div>
                {!creating && edit.configured ? (
                  <button
                    type="button"
                    className="cw-btn is-ghost is-danger"
                    disabled={drawerBusy}
                    onClick={() => void handleDeleteProvider()}
                  >
                    <Trash2 size={15} />
                    删除服务商
                  </button>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="cw-btn is-ghost" onClick={closeDrawer}>
                  关闭
                </button>
                <button
                  type="button"
                  className="cw-btn is-primary"
                  disabled={drawerBusy}
                  onClick={() =>
                    void runDrawerAction(async () => {
                      await persistProvider();
                    })
                  }
                >
                  {creating ? '创建并保存' : '保存设置'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetModal>

      {/* Sub-sheet 4: Batch Discover from /v1/models or Restore Removed Catalog Models */}
      <SheetModal
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        title={discoverMode === 'restore' ? '恢复已移除的内置模型' : '从 /v1/models 拉取模型'}
        description={
          discoverMode === 'restore'
            ? '勾选需要恢复显示的内置目录模型'
            : `由中心直接请求 ${edit?.name || edit?.id || ''} 的模型列表，勾选后批量添加`
        }
        size="lg"
      >
        <div className="cw-drawer-stack">
          {discoverError ? <p role="alert" className="inline-error">{discoverError}</p> : null}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}>
              <SearchInput
                value={discoverQuery}
                onChange={setDiscoverQuery}
                disabled={discoverBusy}
                placeholder="搜索模型名称或 ID…"
              />
            </div>
            {selectableDiscoveredIds.length > 0 ? (
              <button
                type="button"
                className="cw-btn is-small"
                disabled={discoverBusy}
                onClick={() => {
                  const allSelected = selectableDiscoveredIds.every(id => selectedIds.has(id));
                  setSelectedIds(prev => {
                    const next = new Set(prev);
                    for (const id of selectableDiscoveredIds) {
                      if (allSelected) next.delete(id);
                      else next.add(id);
                    }
                    return next;
                  });
                }}
              >
                {selectableDiscoveredIds.every(id => selectedIds.has(id)) ? '取消全选' : '全选可选'}
              </button>
            ) : null}
            {discoverMode === 'remote' && edit ? (
              <button
                type="button"
                className="cw-btn is-small"
                disabled={discoverBusy}
                onClick={() => void runDiscoverFetch(edit, discoverDeviceId)}
              >
                <RefreshCw size={14} />
                重新拉取
              </button>
            ) : null}
          </div>

          {discoverMode === 'remote' && edit ? (
            <Disclosure label="高级：通过局域网在线设备代理拉取">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  style={{ flex: '1 1 200px' }}
                  value={discoverDeviceId}
                  onChange={e => setDiscoverDeviceId(e.target.value)}
                >
                  <option value="">由中心直接请求（默认）</option>
                  {devices
                    .filter(d => d.online)
                    .map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        通过设备：{d.name || d.deviceId}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="cw-btn is-small"
                  disabled={discoverBusy}
                  onClick={() => void runDiscoverFetch(edit, discoverDeviceId)}
                >
                  用所选方式拉取
                </button>
              </div>
              <span className="secondary" style={{ fontSize: '0.76rem' }}>
                仅当模型接口运行在某台设备的本机回环（如该 PC 上的 127.0.0.1:11434）且中心无法直连时才需指定设备。
              </span>
            </Disclosure>
          ) : null}

          <div className="cw-picker-scroll">
            {discoverBusy ? (
              <div className="cw-empty">
                <strong>正在拉取模型列表…</strong>
                <p className="secondary">正在请求上游 /v1/models 接口，请稍候。</p>
              </div>
            ) : filteredDiscovered.length === 0 ? (
              <div className="cw-empty">
                <strong>{discovered.length === 0 ? '未拉取到可用模型' : '没有匹配的模型'}</strong>
                <p className="secondary">
                  {discovered.length === 0
                    ? '请检查 API 地址与密钥是否正确，或关闭此窗口后使用「手动添加」直接录入模型 ID。'
                    : '换个搜索词试试。'}
                </p>
              </div>
            ) : (
              <div className="cw-card">
                {filteredDiscovered.map(m => {
                  const alreadyExists = discoverMode === 'remote' && existingActiveSet.has(m.id);
                  const checked = alreadyExists || selectedIds.has(m.id);
                  return (
                    <Row
                      key={m.id}
                      radio
                      selected={checked}
                      disabled={alreadyExists || discoverBusy}
                      muted={alreadyExists}
                      title={m.name || m.id}
                      subtitle={`${m.id} · ${formatTokens(m.contextWindow)}${m.reasoning ? ' · 推理' : ''}`}
                      trailing={alreadyExists ? '已添加' : undefined}
                      onClick={() => {
                        if (alreadyExists) return;
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        });
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <div className="cw-drawer-footer">
            <span className="secondary" style={{ fontSize: '0.82rem' }}>
              已选 {selectedIds.size} 个模型
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="cw-btn is-ghost" onClick={() => setDiscoverOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="cw-btn is-primary"
                disabled={discoverBusy || selectedIds.size === 0}
                onClick={() => void confirmBatchAddModels()}
              >
                {discoverMode === 'restore' ? `恢复所选 (${selectedIds.size})` : `添加所选 (${selectedIds.size})`}
              </button>
            </div>
          </div>
        </div>
      </SheetModal>

      {/* Sub-sheet 5: Single Model Create / Edit */}
      <SheetModal
        open={modelEdit !== null}
        onOpenChange={isOpen => {
          if (!isOpen) setModelEdit(null);
        }}
        title={modelCreating ? '手动添加模型' : `编辑模型：${modelEdit?.name || modelEdit?.id || ''}`}
        description={modelCreating ? `向 ${edit?.name || edit?.id || ''} 添加模型` : `模型 ID：${modelEdit?.id ?? ''}`}
      >
        {modelEdit ? (
          <form
            className="cw-drawer-stack"
            onSubmit={e => {
              e.preventDefault();
              void saveModelEditor();
            }}
          >
            {modelError ? <p role="alert" className="inline-error">{modelError}</p> : null}

            <div className="cw-field-grid">
              <label className="cw-field">
                <span>模型 ID</span>
                <input
                  required
                  disabled={!modelCreating}
                  placeholder="例如 gpt-4.1 / deepseek-chat"
                  value={modelEdit.id}
                  onChange={e =>
                    setModelEdit({
                      ...modelEdit,
                      id: e.target.value,
                      ...(modelCreating && !modelEdit.name ? {} : {}),
                    })
                  }
                />
              </label>
              <label className="cw-field">
                <span>显示名称</span>
                <input
                  placeholder="留空默认与模型 ID 相同"
                  value={modelEdit.name}
                  onChange={e => setModelEdit({ ...modelEdit, name: e.target.value })}
                />
              </label>
            </div>

            <div className="cw-field-grid">
              <label className="cw-field">
                <span>上下文窗口 (tokens)</span>
                <input
                  type="number"
                  min="1"
                  required
                  value={modelEdit.contextWindow}
                  onChange={e => setModelEdit({ ...modelEdit, contextWindow: Number(e.target.value) })}
                />
              </label>
              <label className="cw-field">
                <span>最大输出 (tokens)</span>
                <input
                  type="number"
                  min="1"
                  required
                  value={modelEdit.maxTokens}
                  onChange={e => setModelEdit({ ...modelEdit, maxTokens: Number(e.target.value) })}
                />
              </label>
            </div>

            <label className="cw-field">
              <span>输入模态（逗号分隔）</span>
              <input
                required
                placeholder="text, image"
                value={modelInputTypes}
                onChange={e => setModelInputTypes(e.target.value)}
              />
            </label>

            <div className="cw-card">
              <div className="cw-block" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 550 }}>支持思考推理 (Reasoning)</span>
                <Switch
                  checked={modelEdit.reasoning}
                  label="支持思考推理"
                  onChange={next => setModelEdit({ ...modelEdit, reasoning: next })}
                />
              </div>
              <div className="cw-block" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 550 }}>启用此模型</span>
                <Switch
                  checked={modelEdit.enabled}
                  label="启用此模型"
                  onChange={next => setModelEdit({ ...modelEdit, enabled: next })}
                />
              </div>
            </div>

            <Disclosure label="单模型高级参数 (JSON)">
              <label className="cw-field">
                <span>可选覆盖字段</span>
                <textarea
                  rows={5}
                  spellCheck={false}
                  value={modelAdvancedJson}
                  onChange={e => setModelAdvancedJson(e.target.value)}
                />
                <span className="secondary" style={{ fontSize: '0.75rem' }}>
                  可覆盖单模型的 api、baseUrl、headers、thinkingLevelMap、compat 等；保持 {'{}'} 即可。
                </span>
              </label>
            </Disclosure>

            <div className="cw-drawer-footer">
              <div>
                {!modelCreating ? (
                  <button
                    type="button"
                    className="cw-btn is-ghost is-danger"
                    disabled={drawerBusy}
                    onClick={() => {
                      const target = modelEdit;
                      setModelEdit(null);
                      void handleDeleteModel(target);
                    }}
                  >
                    <Trash2 size={15} />
                    删除模型
                  </button>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="cw-btn is-ghost" onClick={() => setModelEdit(null)}>
                  取消
                </button>
                <button type="submit" className="cw-btn is-primary" disabled={drawerBusy}>
                  {modelCreating ? '添加模型' : '保存更改'}
                </button>
              </div>
            </div>
          </form>
        ) : null}
      </SheetModal>
    </main>
  );
}
