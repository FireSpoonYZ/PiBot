import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  ArrowLeft,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import { LabelStack, ReservedSlot } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  BotTreeSelector,
  CaChips,
  CaConfirmDialog,
  CaExternalUrlBox,
  CaModal,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSegmented,
  CaSwitch,
  CaToolbarSkeleton,
  botKey,
  newRequestId,
  useCaTabNotices,
} from './primitives';
import { SchemaConfigForm } from './SchemaConfigForm';
import type {
  ActionDescriptor,
  BotCapabilityConfig,
  CapabilityKind,
  CapabilityTool,
  CenterBotRef,
  CenterDevice,
  DeploymentReceipt,
  Installation,
  InstallationConfig,
  InstallationSkillFilesResponse,
  JsonObject,
  JsonSchema,
  McpOAuthStart,
  Operation,
  PackageVersion,
  SkillVisibilityScope,
} from './types';

type TranslateFn = (zh: string, en: string) => string;

interface CapabilitiesCacheData {
  installations: Installation[];
  devices: CenterDevice[];
  bots: CenterBotRef[];
  enabledBotCounts?: Record<string, number>;
}

type CapabilitySegment = 'all' | 'skills' | 'tools';

type CapabilityModal =
  | null
  | { kind: 'install'; defaultKind: CapabilityKind }
  | { kind: 'create-skill' }
  | { kind: 'rename'; inst: Installation }
  | { kind: 'bot-override'; bot: CenterBotRef }
  | { kind: 'confirm'; inst: Installation };

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'muted' }): React.JSX.Element {
  const bg =
    tone === 'ok'
      ? 'var(--ca-ok)'
      : tone === 'warn'
        ? 'var(--ca-warn)'
        : tone === 'danger'
          ? 'var(--ca-danger)'
          : 'var(--ca-text-subtle)';
  return <span className="ca-dot" style={{ background: bg }} aria-hidden="true" />;
}

function activationLabel(item: Installation, t: TranslateFn): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  const st = item.activation?.status;
  if (item.enabled && st === 'enabled') return { text: t('已启用', 'Enabled'), tone: 'ok' };
  if (item.enabled && st === 'enabling') return { text: t('启用中', 'Enabling'), tone: 'warn' };
  if (st === 'failed') return { text: t('启用失败', 'Failed'), tone: 'danger' };
  if (item.enabled) return { text: t('已开启', 'On'), tone: 'ok' };
  return { text: t('已停用', 'Disabled'), tone: 'muted' };
}

function kindLabel(kind: CapabilityKind, t: TranslateFn): string {
  if (kind === 'skill') return t('技能', 'Skill');
  if (kind === 'mcp') return 'MCP';
  return t('插件', 'Plugin');
}

function scopeLabel(scope: SkillVisibilityScope | undefined, t: TranslateFn): string {
  switch (scope) {
    case 'private':
      return t('仅源 Bot 私有', 'Source Bot only');
    case 'assigned':
      return t('指定 Bot 共享', 'Assigned Bots');
    case 'global':
      return t('全局默认可用', 'Global default');
    default:
      return t('默认分配', 'Default scope');
  }
}

function sortSkillPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    if (a === 'SKILL.md') return -1;
    if (b === 'SKILL.md') return 1;
    return a.localeCompare(b);
  });
}

function normalizeInlineSkillMarkdown(name: string, body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('---')) return body;
  const safeName = (name.trim() || 'custom-skill').replace(/"/g, '\\"');
  return `---\nname: "${safeName}"\ndescription: "${safeName}"\n---\n\n${body}`;
}

function countEnabledBots(
  bindingsRec: Record<string, BotCapabilityConfig>,
  activeBots: readonly CenterBotRef[],
): number {
  let count = 0;
  for (const b of activeBots) {
    const cfg = bindingsRec[botKey(b.deviceId, b.botId)] ?? bindingsRec[`${b.deviceId}:${b.botId}`];
    if (cfg?.enabled) count += 1;
  }
  return count;
}

function actionHasInputFields(schema: JsonSchema): boolean {
  if (typeof schema === 'boolean') return false;
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    return Object.keys(schema.properties).length > 0;
  }
  return false;
}

export function CapabilitiesTab({
  api,
  active = true,
  cacheKey = 'default',
  onOpenExternal,
  onOpenExternalUrl,
  onRegisterBackHandler,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  onOpenExternal?: () => void;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
  onRegisterBackHandler?: (handler: () => boolean) => () => void;
}): React.JSX.Element {
  const t = useText();
  const idPrefix = useId();
  const defaultSkillMarkdown = t('# 技能说明\n\n描述此技能的目标、触发时机与执行步骤。\n', '# Skill Guide\n\nDescribe the goal, triggers, and execution steps for this skill.\n');

  const initialCache = useMemo(
    () => readTabCache<CapabilitiesCacheData>(cacheKey, 'capabilities')?.data ?? null,
    [cacheKey],
  );
  const [segment, setSegment] = useState<CapabilitySegment>('all');
  const [skillFilter, setSkillFilter] = useState<'all' | 'shared' | 'learned'>('all');
  const [query, setQuery] = useState('');

  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');

  const [installations, setInstallations] = useState<Installation[]>(() => initialCache?.installations ?? []);
  const [devices, setDevices] = useState<CenterDevice[]>(() => initialCache?.devices ?? []);
  const [bots, setBots] = useState<CenterBotRef[]>(() => initialCache?.bots ?? []);
  const [enabledBotCounts, setEnabledBotCounts] = useState<Record<string, number>>(
    () => initialCache?.enabledBotCounts ?? {},
  );
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Mutually exclusive modal state (never stacked)
  const [modal, setModal] = useState<CapabilityModal>(null);

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('capabilities', active);

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

  // Create inline skill form state
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillScope, setNewSkillScope] = useState<SkillVisibilityScope>('global');
  const [newSkillFiles, setNewSkillFiles] = useState<Record<string, string>>(() => ({
    'SKILL.md': defaultSkillMarkdown,
  }));
  const [newSkillActiveFile, setNewSkillActiveFile] = useState('SKILL.md');
  const [newSkillAddPath, setNewSkillAddPath] = useState('');
  const [createSkillBusy, setCreateSkillBusy] = useState(false);
  const [createSkillError, setCreateSkillError] = useState('');

  // Install / import capability form state
  const [importKind, setImportKind] = useState<CapabilityKind>('skill');
  const [importSource, setImportSource] = useState<'artifact' | 'npm' | 'http'>('artifact');
  const [importName, setImportName] = useState('');
  const [importSpec, setImportSpec] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importTarget, setImportTarget] = useState<'center' | 'host'>('host');
  const [importAutoEnable, setImportAutoEnable] = useState(true);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importNeedsBrowser, setImportNeedsBrowser] = useState(false);

  // Rename modal form state
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');

  // In-page Capability Detail view state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const [detailInst, setDetailInst] = useState<Installation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailScopeDraft, setDetailScopeDraft] = useState<SkillVisibilityScope>('global');
  const [detailConfig, setDetailConfig] = useState<InstallationConfig | null>(null);
  const [detailGlobalDraft, setDetailGlobalDraft] = useState<JsonObject>({});
  const [skillFilesRes, setSkillFilesRes] = useState<InstallationSkillFilesResponse | null>(null);
  const [skillFilesDraft, setSkillFilesDraft] = useState<Record<string, string>>({});
  const [activeSkillPath, setActiveSkillPath] = useState('SKILL.md');
  const [newSubfilePath, setNewSubfilePath] = useState('');
  const [botBindings, setBotBindings] = useState<Map<string, BotCapabilityConfig>>(new Map());
  const detailBindingsLoadedForRef = useRef<string | null>(null);
  const [bindingBusyKeys, setBindingBusyKeys] = useState<Set<string>>(new Set());
  const [detailBusy, setDetailBusy] = useState(false);
  const [oauthHintNeeded, setOauthHintNeeded] = useState(false);

  const setDetailError = useCallback(
    (msg: string, withBrowserAction = false) => {
      if (msg) {
        const t = tRef.current;
        if (msg.includes('OAuth')) setOauthHintNeeded(true);
        showNotice('detail-error', msg, {
          tone: 'danger',
          action:
            withBrowserAction && onOpenExternal
              ? { label: t('在浏览器打开', 'Open in browser'), onClick: onOpenExternal }
              : undefined,
        });
      } else {
        clearNotice('detail-error');
      }
    },
    [clearNotice, onOpenExternal, showNotice],
  );

  const setDetailNotice = useCallback(
    (msg: string) => {
      if (msg) showNotice('detail-notice', msg, { tone: 'ok' });
      else clearNotice('detail-notice');
    },
    [clearNotice, showNotice],
  );

  // Per-Bot Override modal form state (opens over in-page detail view, never stacked)
  const [overrideDraft, setOverrideDraft] = useState<JsonObject>({});
  const [overrideRevision, setOverrideRevision] = useState(0);
  const [overrideEnabled, setOverrideEnabled] = useState(true);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState('');

  // OAuth & Probe/Tools check inside detail view
  const [selectedValidationBotKey, setSelectedValidationBotKey] = useState('');
  const [oauthFlow, setOauthFlow] = useState<McpOAuthStart | null>(null);
  const [oauthStatus, setOauthStatus] = useState('');
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState('');
  const [toolsResult, setToolsResult] = useState<CapabilityTool[] | null>(null);
  const [detailActions, setDetailActions] = useState<ActionDescriptor[]>([]);
  const [actionDrafts, setActionDrafts] = useState<Record<string, JsonObject>>({});
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const [actionResults, setActionResults] = useState<Record<string, { ok: boolean; output: string }>>({});
  const [deployments, setDeployments] = useState<DeploymentReceipt[]>([]);
  const [updates, setUpdates] = useState<PackageVersion[] | null>(null);
  const [updateArtifactFile, setUpdateArtifactFile] = useState<File | null>(null);
  const [updateArtifactInputKey, setUpdateArtifactInputKey] = useState(0);
  const [operation, setOperation] = useState<Operation | null>(null);

  const oauthFlowGenRef = useRef(0);
  const oauthTimerRef = useRef<number | null>(null);
  const opTimerRef = useRef<number | null>(null);

  const stopTimers = useCallback(() => {
    oauthFlowGenRef.current += 1;
    if (oauthTimerRef.current !== null) {
      window.clearTimeout(oauthTimerRef.current);
      oauthTimerRef.current = null;
    }
    if (opTimerRef.current !== null) {
      window.clearTimeout(opTimerRef.current);
      opTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopTimers(), [stopTimers]);

  useEffect(() => {
    if (selectedId && operation?.phase === 'failed' && operation.error?.message) {
      const msg = operation.error.code
        ? `${operation.error.code}: ${operation.error.message}`
        : operation.error.message;
      showNotice('op-error', msg, { tone: 'danger' });
    } else {
      clearNotice('op-error');
    }
  }, [clearNotice, operation, selectedId, showNotice]);

  const loadAll = useCallback(async () => {
    const [caps, sync] = await Promise.all([api.listCapabilities(), api.getBotSync()]);
    const nextDevices = sync.devices;
    const nextBots = sync.bots ?? [];
    const activeBotList = nextBots.filter(b => !b.archivedAt);

    setInstallations(caps);
    setDevices(nextDevices);
    setBots(nextBots);
    hasLoadedRef.current = true;
    cacheKeyRef.current = cacheKey;
    setHasLoaded(true);
    setInitialError('');
    clearNotice('load-error');

    // Fetch per-installation Bot binding counts without N*M fallback fanout
    if (caps.length > 0 && activeBotList.length > 0) {
      const countEntries = await Promise.all(
        caps.map(async inst => {
          try {
            const rec = await api.getInstallationBotBindings(inst.installationId, []);
            return [inst.installationId, countEnabledBots(rec, activeBotList)] as const;
          } catch {
            return null;
          }
        }),
      );
      setEnabledBotCounts(prev => {
        const next: Record<string, number> = { ...prev };
        for (const entry of countEntries) {
          if (entry) next[entry[0]] = entry[1];
        }
        return next;
      });
    } else if (activeBotList.length === 0) {
      const zeroed: Record<string, number> = {};
      for (const inst of caps) zeroed[inst.installationId] = 0;
      setEnabledBotCounts(zeroed);
    }
  }, [api, cacheKey, clearNotice]);

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll();
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const msg = errorMessage(err, t('加载能力列表失败，请检查中心连接后重试', 'Failed to load capabilities. Check center connectivity and retry.'));
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
    writeTabCache<CapabilitiesCacheData>(cacheKey, 'capabilities', {
      installations,
      devices,
      bots,
      enabledBotCounts,
    });
  }, [bots, cacheKey, devices, enabledBotCounts, hasLoaded, installations]);

  const activeBots = useMemo(() => bots.filter(b => !b.archivedAt), [bots]);
  const onlineBots = useMemo(
    () => activeBots.filter(b => b.online !== false && devices.find(d => d.deviceId === b.deviceId)?.online !== false),
    [activeBots, devices],
  );

  // Default probe/validation bot
  useEffect(() => {
    if (selectedValidationBotKey && activeBots.some(b => botKey(b.deviceId, b.botId) === selectedValidationBotKey)) {
      return;
    }
    const candidate = onlineBots[0] ?? activeBots[0];
    if (candidate) setSelectedValidationBotKey(botKey(candidate.deviceId, candidate.botId));
  }, [activeBots, onlineBots, selectedValidationBotKey]);

  const botNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bots) map.set(botKey(b.deviceId, b.botId), b.name || b.botId);
    return map;
  }, [bots]);

  const loadDetail = useCallback(
    async (instId: string) => {
      setDetailLoading(true);
      setDetailError('');
      try {
        const inst = await api.getInstallation(instId);
        if (selectedIdRef.current !== instId) return;
        setDetailInst(inst);
        setDetailScopeDraft(inst.visibilityScope ?? (inst.ownerBot ? 'private' : 'global'));

        const cfgPromise =
          inst.kind === 'skill'
            ? Promise.resolve(null)
            : api.getInstallationConfig(instId).catch(() => null);
        const filesPromise =
          inst.kind === 'skill'
            ? api.getInstallationSkillFiles(instId).catch(() => null)
            : Promise.resolve(null);
        const depsPromise = api.listDeployments(instId).catch(() => [] as DeploymentReceipt[]);
        const bindingsPromise = api
          .getInstallationBotBindings(instId, activeBots)
          .catch(() => ({} as Record<string, BotCapabilityConfig>));
        const actionsPromise =
          inst.kind === 'skill'
            ? Promise.resolve([] as ActionDescriptor[])
            : api.listActions(instId).catch(() => [] as ActionDescriptor[]);

        const [cfg, sFiles, deps, bindingsRec, actionsList] = await Promise.all([
          cfgPromise,
          filesPromise,
          depsPromise,
          bindingsPromise,
          actionsPromise,
        ]);
        if (selectedIdRef.current !== instId) return;

        const bindingMap = new Map<string, BotCapabilityConfig>();
        let enabledCount = 0;
        for (const b of activeBots) {
          const key = botKey(b.deviceId, b.botId);
          const bc = bindingsRec[key] ?? bindingsRec[`${b.deviceId}:${b.botId}`];
          if (bc) {
            bindingMap.set(key, bc);
            if (bc.enabled) enabledCount += 1;
          }
        }
        setBotBindings(bindingMap);
        detailBindingsLoadedForRef.current = instId;
        setEnabledBotCounts(prev => ({ ...prev, [instId]: enabledCount }));
        setDetailConfig(cfg);
        setDetailGlobalDraft(cfg?.globalConfig ?? {});
        setDetailActions(actionsList);
        setSkillFilesRes(sFiles);
        if (sFiles) {
          setSkillFilesDraft({ ...sFiles.files });
          const sorted = sortSkillPaths(Object.keys(sFiles.files));
          setActiveSkillPath(sorted.includes('SKILL.md') ? 'SKILL.md' : sorted[0] || 'SKILL.md');
        }
        setDeployments(deps);
      } catch (err) {
        if (selectedIdRef.current === instId) {
          setDetailError(errorMessage(err, t('加载能力详情失败，请返回列表后重试', 'Failed to load capability details. Return to the list and try again.')));
        }
      } finally {
        if (selectedIdRef.current === instId) {
          setDetailLoading(false);
        }
      }
    },
    [activeBots, api, setDetailError, t],
  );

  const openDetailView = useCallback(
    (inst: Installation) => {
      stopTimers();
      setModal(null);
      setSelectedId(inst.installationId);
      selectedIdRef.current = inst.installationId;
      setDetailInst(inst);
      setDetailScopeDraft(inst.visibilityScope ?? (inst.ownerBot ? 'private' : 'global'));
      setDetailConfig(null);
      setDetailGlobalDraft({});
      setDetailActions([]);
      setActionDrafts({});
      setRunningActionId(null);
      setActionResults({});
      setDetailBusy(false);
      setSkillFilesRes(null);
      setSkillFilesDraft({});
      setBotBindings(new Map());
      detailBindingsLoadedForRef.current = null;
      setDetailNotice('');
      setDetailError('');
      setOauthHintNeeded(false);
      setOauthFlow(null);
      setOauthStatus('');
      setProbeResult('');
      setToolsResult(null);
      setDeployments([]);
      setUpdates(null);
      setUpdateArtifactFile(null);
      setUpdateArtifactInputKey(k => k + 1);
      setOperation(null);
      void loadDetail(inst.installationId);
    },
    [loadDetail, setDetailError, setDetailNotice, stopTimers],
  );

  const closeDetailView = useCallback(() => {
    stopTimers();
    setModal(null);
    setSelectedId(null);
    selectedIdRef.current = null;
    detailBindingsLoadedForRef.current = null;
    setDetailInst(null);
    setDetailActions([]);
    setActionDrafts({});
    setRunningActionId(null);
    setActionResults({});
    setDetailBusy(false);
    setOauthFlow(null);
    setOauthStatus('');
    setDetailError('');
    setDetailNotice('');
    clearNotice('op-error');
  }, [clearNotice, setDetailError, setDetailNotice, stopTimers]);

  const closeDetailViewRef = useRef(closeDetailView);
  closeDetailViewRef.current = closeDetailView;
  const hasDetail = selectedId !== null;
  useEffect(() => {
    if (!active || !hasDetail) return;
    const handleBack = () => {
      closeDetailViewRef.current();
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
  }, [active, hasDetail, onRegisterBackHandler]);

  const watchOperation = useCallback(
    (operationId: string, onDone?: () => void) => {
      if (opTimerRef.current !== null) window.clearTimeout(opTimerRef.current);
      let attempts = 0;
      const tick = async () => {
        attempts += 1;
        try {
          const op = await api.getOperation(operationId);
          setOperation(op);
          if (op.phase === 'applied' || op.phase === 'failed' || op.phase === 'removed' || attempts > 30) {
            await loadAll();
            if (selectedIdRef.current) await loadDetail(selectedIdRef.current);
            onDone?.();
            return;
          }
          opTimerRef.current = window.setTimeout(() => void tick(), 1200);
        } catch {
          await loadAll();
        }
      };
      opTimerRef.current = window.setTimeout(() => void tick(), 900);
    },
    [api, loadAll, loadDetail],
  );

  const handleToggleGlobalRow = async (inst: Installation, nextEnabled: boolean) => {
    setTogglingId(inst.installationId);
    setError('');
    try {
      if (nextEnabled) {
        const candidate = onlineBots[0] ?? activeBots[0];
        const res = await api.enableInstallation(inst.installationId, {
          requestId: newRequestId(),
          ...(inst.kind === 'mcp' && inst.target === 'center' && candidate
            ? { validationBot: { deviceId: candidate.deviceId, botId: candidate.botId } }
            : {}),
        });
        watchOperation(res.operationId);
      } else {
        const res = await api.disableInstallation(inst.installationId, { requestId: newRequestId() });
        watchOperation(res.operationId);
      }
      await loadAll();
    } catch (err) {
      const msg = errorMessage(err, t('切换启用状态失败', 'Failed to toggle status'));
      if (msg.toLowerCase().includes('oauth') || msg.includes('validationBot') || msg.includes('授权')) { // i18n-ok
        openDetailView(inst);
        setOauthHintNeeded(true);
        setDetailError(t('此 MCP 需要先完成 OAuth Bot 授权后才能全局启用，请在下方选择 Bot 发起授权。', 'This MCP requires OAuth authorization with a Bot before enabling globally. Select a Bot below to authorize.'));
      } else {
        setError(msg);
      }
    } finally {
      setTogglingId(null);
    }
  };

  const openCreateSkillModal = () => {
    setNewSkillName('');
    setNewSkillScope('global');
    setNewSkillFiles({ 'SKILL.md': defaultSkillMarkdown });
    setNewSkillActiveFile('SKILL.md');
    setNewSkillAddPath('');
    setCreateSkillError('');
    setModal({ kind: 'create-skill' });
  };

  const handleCreateInlineSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createSkillBusy) return;
    const title = newSkillName.trim();
    if (!title) {
      setCreateSkillError(t('请填写技能名称后再创建', 'Enter a skill name before creating.'));
      return;
    }
    const md = newSkillFiles['SKILL.md'] ?? '';
    if (!md.trim()) {
      setCreateSkillError(t('请填写 SKILL.md 内容后再创建', 'Enter SKILL.md content before creating.'));
      return;
    }
    const preparedFiles: Record<string, string> = {
      ...newSkillFiles,
      'SKILL.md': normalizeInlineSkillMarkdown(title, md),
    };
    setCreateSkillBusy(true);
    setCreateSkillError('');
    try {
      const accepted = await api.install({
        requestId: newRequestId(),
        displayName: title,
        kind: 'skill',
        target: 'host',
        autoEnable: true,
        visibilityScope: newSkillScope,
        source: { type: 'inline', files: preparedFiles },
      });
      const op = await api.getOperation(accepted.operationId).catch(() => null);
      setModal(null);
      setNewSkillName('');
      setNewSkillFiles({ 'SKILL.md': defaultSkillMarkdown });
      setNewSkillActiveFile('SKILL.md');
      await loadAll();
      if (op?.installationId) {
        const created = await api.getInstallation(op.installationId).catch(() => null);
        if (created) openDetailView(created);
      }
      setNotice(t(`技能「${title}」已创建并启用`, `Skill "${title}" created and enabled`));
    } catch (err) {
      const detail = errorMessage(err, t('中心未能创建技能', 'Center could not create the skill'));
      setCreateSkillError(t(`创建技能失败：${detail}。请检查名称和文件内容后重试。`, `Failed to create skill: ${detail}. Check the name and files, then try again.`));
    } finally {
      setCreateSkillBusy(false);
    }
  };

  const openInstallModal = (defaultKind: CapabilityKind) => {
    setImportKind(defaultKind);
    setImportSource(defaultKind === 'skill' ? 'artifact' : 'npm');
    setImportName('');
    setImportSpec('');
    setImportUrl('');
    setImportFile(null);
    setImportTarget(defaultKind === 'mcp' ? 'center' : 'host');
    setImportAutoEnable(true);
    setImportError('');
    setImportNeedsBrowser(false);
    setModal({ kind: 'install', defaultKind });
  };

  const handleSubmitImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (importBusy) return;
    const name = importName.trim();
    if (!name) {
      setImportError(t('请填写显示名称后再安装', 'Enter a display name before installing.'));
      return;
    }
    setImportBusy(true);
    setImportError('');
    setImportNeedsBrowser(false);
    try {
      let source: Parameters<CenterApi['install']>[0]['source'];
      if (importSource === 'artifact') {
        if (!importFile) throw new Error(t('请选择要上传的压缩包文件', 'Select an archive file to upload.'));
        const uploaded = await api.uploadArtifact(importFile);
        source = { type: 'artifact', artifactRef: uploaded.artifactRef };
      } else if (importSource === 'npm') {
        if (!importSpec.trim()) throw new Error(t('请填写 npm 包标识', 'Enter an npm package spec.'));
        source = { type: 'npm', spec: importSpec.trim() };
      } else {
        if (!importUrl.trim()) throw new Error(t('请填写 HTTP URL 地址', 'Enter an HTTP URL.'));
        source = { type: 'http', url: importUrl.trim() };
      }

      const accepted = await api.install({
        requestId: newRequestId(),
        displayName: name,
        kind: importKind,
        target: importKind === 'skill' ? 'host' : importTarget,
        autoEnable: importAutoEnable,
        source,
      });
      setModal(null);
      await loadAll();
      watchOperation(accepted.operationId);
      setNotice(
        importAutoEnable
          ? t(`已提交「${name}」安装任务（完成后自动启用）`, `Submitted install task for "${name}" (auto-enable on completion)`)
          : t(`已提交「${name}」安装任务`, `Submitted install task for "${name}"`),
      );
    } catch (err) {
      const needsBrowser =
        importSource === 'artifact' &&
        err instanceof CenterApiError &&
        err.code === 'UNSUPPORTED_FORM_DATA';
      setImportNeedsBrowser(needsBrowser);
      const detail = errorMessage(err, t('安装请求被拒绝', 'Install request failed'));
      setImportError(
        t(`安装失败：${detail}。请检查来源配置后重试。`, `Installation failed: ${detail}. Verify the source settings and try again.`),
      );
    } finally {
      setImportBusy(false);
    }
  };

  const openRenameModal = (inst: Installation) => {
    setRenameDraft(inst.displayName);
    setRenameError('');
    setModal({ kind: 'rename', inst });
  };

  const handleSubmitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (modal?.kind !== 'rename' || renameBusy) return;
    const nextName = renameDraft.trim();
    if (!nextName) {
      setRenameError(t('显示名称不能为空', 'Display name cannot be empty.'));
      return;
    }
    setRenameBusy(true);
    setRenameError('');
    try {
      const updated = await api.patchInstallation(modal.inst.installationId, {
        expectedRevision: modal.inst.revision,
        displayName: nextName,
      });
      setDetailInst(prev => (prev?.installationId === updated.installationId ? updated : prev));
      setInstallations(prev => prev.map(x => (x.installationId === updated.installationId ? updated : x)));
      setModal(null);
      setDetailNotice(t(`已重命名为「${updated.displayName}」`, `Renamed to "${updated.displayName}"`));
    } catch (err) {
      const detail = errorMessage(err, t('重命名请求失败', 'Rename request failed'));
      setRenameError(t(`保存名称失败：${detail}。请刷新后重试。`, `Failed to rename: ${detail}. Refresh and try again.`));
    } finally {
      setRenameBusy(false);
    }
  };

  const handleSaveSkillVisibility = async () => {
    if (!detailInst || detailInst.kind !== 'skill' || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const updated = await api.patchInstallation(detailInst.installationId, {
        expectedRevision: detailInst.revision,
        visibilityScope: detailScopeDraft,
      });
      setDetailInst(updated);
      setInstallations(prev => prev.map(x => (x.installationId === updated.installationId ? updated : x)));
      setDetailNotice(t('共享范围已更新', 'Visibility scope updated'));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存共享范围失败，请刷新后重试', 'Failed to save visibility scope. Refresh and retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleSaveSkillFiles = async () => {
    if (!detailInst || !skillFilesRes || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const payloadFiles: Record<string, string | null> = {};
      for (const oldPath of Object.keys(skillFilesRes.files)) {
        if (!(oldPath in skillFilesDraft)) payloadFiles[oldPath] = null;
      }
      for (const [p, content] of Object.entries(skillFilesDraft)) {
        payloadFiles[p] = content;
      }
      const updated = await api.putInstallationSkillFiles(detailInst.installationId, {
        files: payloadFiles,
        requestId: newRequestId(),
      });
      setSkillFilesRes(updated);
      setSkillFilesDraft({ ...updated.files });
      setDetailNotice(t('技能文件已保存并同步到关联设备', 'Skill files saved and synced to connected devices'));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存技能文件失败，请检查内容后重试', 'Failed to save skill files. Check content and retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleCloneToEditable = async () => {
    if (!detailInst || !skillFilesRes || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      const copyName = t(`${detailInst.displayName}（可编辑副本）`, `${detailInst.displayName} (Editable Copy)`);
      const accepted = await api.install({
        requestId: newRequestId(),
        displayName: copyName,
        kind: 'skill',
        target: 'host',
        autoEnable: true,
        visibilityScope: detailScopeDraft,
        source: { type: 'inline', files: { ...skillFilesRes.files } },
      });
      const op = await api.getOperation(accepted.operationId).catch(() => null);
      await loadAll();
      if (op?.installationId) {
        setSelectedId(op.installationId);
        selectedIdRef.current = op.installationId;
        await loadDetail(op.installationId);
        setDetailNotice(t(`已创建可编辑副本「${copyName}」`, `Created editable copy "${copyName}"`));
      } else {
        setDetailNotice(t(`已创建可编辑副本「${copyName}」，请返回列表打开编辑`, `Created editable copy "${copyName}". Open it from the list to edit.`));
      }
    } catch (err) {
      setDetailError(errorMessage(err, t('转为可编辑副本失败，请重试', 'Failed to create editable copy. Please retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleSaveGlobalToolConfig = async () => {
    if (!detailInst || !detailConfig || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const updated = await api.putInstallationConfig(detailInst.installationId, {
        expectedRevision: detailConfig.revision,
        globalConfig: detailGlobalDraft,
      });
      setDetailConfig(updated);
      setDetailGlobalDraft(updated.globalConfig);
      setDetailNotice(t('全局配置已保存', 'Global settings saved'));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存全局配置失败，请检查字段值后重试', 'Failed to save global settings. Verify fields and retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleToggleBotBinding = async (deviceId: string, botId: string, nextChecked: boolean) => {
    if (!detailInst) return;
    const key = botKey(deviceId, botId);
    setBindingBusyKeys(prev => new Set(prev).add(key));
    setDetailError('');
    try {
      const existing = botBindings.get(key) ?? (await api.getBotCapability(deviceId, botId, detailInst.installationId));
      const updated = await api.putBotCapability(deviceId, botId, detailInst.installationId, {
        expectedRevision: existing.revision,
        enabled: nextChecked,
        overrides: existing.overrides ?? {},
      });
      setBotBindings(prev => {
        const next = new Map(prev);
        next.set(key, updated);
        return next;
      });
    } catch (err) {
      setDetailError(errorMessage(err, t('更新 Bot 启用状态失败，请重试', 'Failed to update Bot access. Please retry.')));
    } finally {
      setBindingBusyKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const openBotOverrideModal = (bot: CenterBotRef) => {
    const bc = botBindings.get(botKey(bot.deviceId, bot.botId));
    if (!bc) return;
    setOverrideDraft({ ...(bc.overrides ?? {}) });
    setOverrideRevision(bc.revision);
    setOverrideEnabled(bc.enabled);
    setOverrideError('');
    setModal({ kind: 'bot-override', bot });
  };

  const handleSaveBotOverride = async () => {
    if (!detailInst || modal?.kind !== 'bot-override' || overrideSaving) return;
    const targetBot = modal.bot;
    setOverrideSaving(true);
    setOverrideError('');
    try {
      const updated = await api.putBotCapability(
        targetBot.deviceId,
        targetBot.botId,
        detailInst.installationId,
        {
          expectedRevision: overrideRevision,
          enabled: overrideEnabled,
          overrides: overrideDraft,
        },
      );
      setBotBindings(prev => {
        const next = new Map(prev);
        next.set(botKey(targetBot.deviceId, targetBot.botId), updated);
        return next;
      });
      setModal(null);
      setDetailNotice(t(`已保存 ${targetBot.name} 的独立覆盖参数`, `Saved override settings for ${targetBot.name}`));
    } catch (err) {
      const detail = errorMessage(err, t('中心拒绝了覆盖配置', 'Center rejected override settings'));
      setOverrideError(t(`保存覆盖参数失败：${detail}。请检查字段后重试。`, `Failed to save overrides: ${detail}. Verify fields and try again.`));
    } finally {
      setOverrideSaving(false);
    }
  };

  const parseBotKey = (key: string): { deviceId: string; botId: string } | null => {
    const idx = key.indexOf('::');
    if (idx <= 0) return null;
    return { deviceId: key.slice(0, idx), botId: key.slice(idx + 2) };
  };

  const needsOAuth =
    detailInst?.kind === 'mcp' &&
    detailInst.target === 'center' &&
    Boolean(detailConfig?.globalConfig?.oauth === true);

  const handleEnableInDetail = async () => {
    if (!detailInst || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    const targetBot = parseBotKey(selectedValidationBotKey);
    try {
      const accepted = await api.enableInstallation(detailInst.installationId, {
        requestId: newRequestId(),
        ...(needsOAuth && targetBot ? { validationBot: targetBot } : {}),
      });
      setDetailNotice(t('已受理全局启用请求', 'Global enable request accepted'));
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, t('全局启用失败，请检查配置与授权状态后重试', 'Failed to enable globally. Verify settings and authorization, then retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleDisableInDetail = async () => {
    if (!detailInst || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const accepted = await api.disableInstallation(detailInst.installationId, {
        requestId: newRequestId(),
      });
      setDetailNotice(t('已受理全局停用请求', 'Global disable request accepted'));
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, t('全局停用失败，请重试', 'Failed to disable globally. Please retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleStartMcpOAuth = async () => {
    if (!detailInst || detailBusy) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError(t('请先选择一个可用 Bot 作为 OAuth 授权身份', 'Select an available Bot to authorize OAuth.'));
      return;
    }
    const instId = detailInst.installationId;
    const gen = ++oauthFlowGenRef.current;
    if (oauthTimerRef.current !== null) {
      window.clearTimeout(oauthTimerRef.current);
      oauthTimerRef.current = null;
    }
    setDetailBusy(true);
    setDetailError('');
    try {
      const started = await api.startMcpOAuth(instId, targetBot);
      if (gen !== oauthFlowGenRef.current) return;
      setOauthFlow(started);
      setOauthStatus('pending');
      const poll = async () => {
        if (gen !== oauthFlowGenRef.current) return;
        try {
          const st = await api.getMcpOAuthFlow(started.flowId);
          if (gen !== oauthFlowGenRef.current) return;
          setOauthStatus(st.error ? `${st.status}: ${st.error}` : st.status);
          if (st.status === 'complete') {
            setDetailNotice(t('OAuth 授权已完成，正在自动启用…', 'OAuth authorized, enabling automatically…'));
            const accepted = await api.enableInstallation(instId, {
              requestId: newRequestId(),
              validationBot: targetBot,
            });
            if (gen !== oauthFlowGenRef.current) return;
            watchOperation(accepted.operationId);
            return;
          }
          if (st.status === 'pending') {
            oauthTimerRef.current = window.setTimeout(() => void poll(), 1200);
          }
        } catch (pErr) {
          if (gen !== oauthFlowGenRef.current) return;
          setOauthStatus(errorMessage(pErr, t('查询授权状态失败', 'Failed to check OAuth status')));
        }
      };
      oauthTimerRef.current = window.setTimeout(() => void poll(), 1500);
    } catch (err) {
      if (gen !== oauthFlowGenRef.current) return;
      setDetailError(errorMessage(err, t('启动 OAuth 授权失败，请重试', 'Failed to start OAuth authorization. Please retry.')));
    } finally {
      if (gen === oauthFlowGenRef.current) setDetailBusy(false);
    }
  };

  const handleLogoutMcpOAuth = async (targetOverride?: { deviceId: string; botId: string }) => {
    if (!detailInst || detailBusy) return;
    const targetBot = targetOverride ?? parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError(t('请先选择一个 Bot 再断开 OAuth 授权', 'Select a Bot before disconnecting OAuth.'));
      return;
    }
    const instId = detailInst.installationId;
    oauthFlowGenRef.current += 1;
    if (oauthTimerRef.current !== null) {
      window.clearTimeout(oauthTimerRef.current);
      oauthTimerRef.current = null;
    }
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      await api.logoutMcpOAuth(instId, targetBot);
      if (selectedIdRef.current !== instId) return;
      setOauthFlow(null);
      setOauthStatus('');
      await loadDetail(instId);
      if (selectedIdRef.current !== instId) return;
      setDetailNotice(t('已断开该 Bot 的 OAuth 授权', 'Disconnected OAuth authorization for this Bot'));
      void loadAll().catch(() => {});
    } catch (err) {
      if (selectedIdRef.current !== instId) return;
      setDetailError(errorMessage(err, t('断开 OAuth 授权失败，请重试', 'Failed to disconnect OAuth. Please retry.')));
    } finally {
      if (selectedIdRef.current === instId) setDetailBusy(false);
    }
  };

  const handleRunAction = async (descriptor: ActionDescriptor) => {
    if (!detailInst || runningActionId !== null) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError(t('请先选择一个可用 Bot 再执行扩展操作', 'Select an available Bot before running an extension action.'));
      return;
    }
    const instId = detailInst.installationId;
    const inputPayload: JsonObject = actionHasInputFields(descriptor.inputSchema)
      ? (actionDrafts[descriptor.id] ?? {})
      : {};
    setRunningActionId(descriptor.id);
    setDetailError('');
    setDetailNotice('');
    try {
      const res = await api.runAction(instId, descriptor.id, {
        requestId: newRequestId(),
        deviceId: targetBot.deviceId,
        botId: targetBot.botId,
        input: inputPayload,
      });
      if (selectedIdRef.current !== instId) return;
      const formatted =
        typeof res.result === 'string'
          ? res.result
          : JSON.stringify(res.result ?? null, null, 2);
      setActionResults(prev => ({
        ...prev,
        [descriptor.id]: { ok: true, output: formatted },
      }));
      setDetailNotice(t(`操作「${descriptor.title || descriptor.id}」执行完成`, `Action "${descriptor.title || descriptor.id}" completed`));
    } catch (err) {
      if (selectedIdRef.current !== instId) return;
      const msg = errorMessage(err, t('执行操作失败，请确认扩展与所选 Bot 均已启用后重试', 'Failed to run action. Confirm both the extension and selected Bot are enabled, then retry.'));
      setActionResults(prev => ({
        ...prev,
        [descriptor.id]: { ok: false, output: msg },
      }));
      setDetailError(msg);
    } finally {
      if (selectedIdRef.current === instId) setRunningActionId(null);
    }
  };

  const handleCheckAndListTools = async () => {
    if (!detailInst || probeBusy) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError(t('暂无可用的设备与 Bot 执行连接探测', 'No available device and Bot to run connection check.'));
      return;
    }
    setProbeBusy(true);
    setProbeResult('');
    setToolsResult(null);
    setDetailError('');
    try {
      const check = await api.validateInstallation(detailInst.installationId, targetBot);
      setProbeResult(
        check.ok
          ? t(`连接正常：${check.message}`, `Connection OK: ${check.message}`)
          : t(`探测未通过：${check.message}`, `Probe failed: ${check.message}`),
      );
      const tools = await api.listInstallationTools(detailInst.installationId, targetBot).catch(() => null);
      if (tools) setToolsResult(tools.tools);
    } catch (err) {
      setDetailError(errorMessage(err, t('探测连接与工具列表失败，请确认设备在线后重试', 'Failed to check connection and tools. Confirm the device is online and retry.')));
    } finally {
      setProbeBusy(false);
    }
  };

  const handleCheckUpdates = async () => {
    if (!detailInst || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const list = await api.checkUpdates(detailInst.installationId);
      setUpdates(list);
      if (list.length === 0) setDetailNotice(t('当前已是最新版本', 'Already up to date'));
    } catch (err) {
      setDetailError(errorMessage(err, t('检查更新失败，请稍后重试', 'Failed to check updates. Try again later.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleApplyUpdate = async (targetVersion: string) => {
    if (!detailInst || detailBusy) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    setOperation(null);
    try {
      const accepted = await api.updateInstallation(detailInst.installationId, {
        requestId: newRequestId(),
        targetVersion,
      });
      setDetailNotice(t(`已发起更新到 v${targetVersion}`, `Started update to v${targetVersion}`));
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, t('更新失败，请重试', 'Update failed. Please retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleApplyArtifactUpdate = async () => {
    if (!detailInst || detailInst.source.type !== 'artifact' || detailBusy) return;
    if (!updateArtifactFile) {
      setDetailError(t('请先选择新版制品压缩包 (.tgz / .tar.gz / .zip)', 'Select a new package archive (.tgz / .tar.gz / .zip) first.'));
      return;
    }
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    setOperation(null);
    try {
      const uploaded = await api.uploadArtifact(updateArtifactFile);
      const accepted = await api.updateInstallation(detailInst.installationId, {
        requestId: newRequestId(),
        source: { type: 'artifact', artifactRef: uploaded.artifactRef },
      });
      setUpdateArtifactFile(null);
      setUpdateArtifactInputKey(k => k + 1);
      setDetailNotice(t('已上传制品并发起原地更新（保留原实例与 Bot 绑定）', 'Artifact uploaded; in-place update started (preserving installation and Bot bindings)'));
      watchOperation(accepted.operationId);
    } catch (err) {
      const needsBrowser = err instanceof CenterApiError && err.code === 'UNSUPPORTED_FORM_DATA';
      setDetailError(errorMessage(err, t('制品更新失败，请检查压缩包格式后重试', 'Artifact update failed. Verify the archive format and retry.')), needsBrowser);
    } finally {
      setDetailBusy(false);
    }
  };

  const handleUninstall = async () => {
    if (modal?.kind !== 'confirm' || detailBusy) return;
    const targetInst = modal.inst;
    setDetailBusy(true);
    setDetailError('');
    try {
      await api.uninstallInstallation(targetInst.installationId, { requestId: newRequestId() });
      setModal(null);
      closeDetailView();
      await loadAll();
      setNotice(t(`已卸载 ${targetInst.displayName}`, `Uninstalled ${targetInst.displayName}`));
    } catch (err) {
      setModal(null);
      setDetailError(errorMessage(err, t('卸载失败，请重试', 'Uninstall failed. Please retry.')));
    } finally {
      setDetailBusy(false);
    }
  };

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return installations
      .filter(inst => {
        if (segment === 'skills') {
          if (inst.kind !== 'skill') return false;
          if (skillFilter === 'shared') return !inst.ownerBot;
          if (skillFilter === 'learned') return Boolean(inst.ownerBot);
          return true;
        }
        if (segment === 'tools') {
          return inst.kind === 'mcp' || inst.kind === 'plugin';
        }
        return true;
      })
      .filter(
        inst =>
          !q ||
          inst.displayName.toLowerCase().includes(q) ||
          inst.packageId.toLowerCase().includes(q),
      );
  }, [installations, query, segment, skillFilter]);

  const selectedBotKeys = useMemo(() => {
    const set = new Set<string>();
    for (const [key, cfg] of botBindings.entries()) {
      if (cfg.enabled) set.add(key);
    }
    return set;
  }, [botBindings]);

  useEffect(() => {
    if (!selectedId || detailBindingsLoadedForRef.current !== selectedId) return;
    const count = selectedBotKeys.size;
    setEnabledBotCounts(prev => (prev[selectedId] === count ? prev : { ...prev, [selectedId]: count }));
  }, [selectedBotKeys, selectedId]);

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaToolbarSkeleton leftWidth={210} rightWidth={172} />
        <CaSectionSkeleton rows={5} headWidth={176} trailingWidth={48} label={t('正在加载能力列表…', 'Loading capabilities…')} />
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

  const activeDetail =
    selectedId !== null
      ? detailInst ?? installations.find(inst => inst.installationId === selectedId) ?? null
      : null;

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      {activeDetail ? (
        /* In-page Capability Detail View (eliminates modal-on-modal stacking) */
        <div className="ca-form-stack">
          <div className="ca-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="ca-btn ca-btn-ghost ca-btn-sm"
              onClick={closeDetailView}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>{t('返回能力列表', 'Back to Capabilities')}</span>
            </button>
            <div className="ca-toolbar-group">
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                disabled={detailBusy}
                onClick={() => openRenameModal(activeDetail)}
              >
                <Pencil size={13} aria-hidden="true" />
                <span>{t('重命名', 'Rename')}</span>
              </button>
              <CaSwitch
                checked={activeDetail.enabled}
                disabled={detailBusy}
                label={t(`全局启用 ${activeDetail.displayName}`, `Enable ${activeDetail.displayName} globally`)}
                onChange={next => (next ? void handleEnableInDetail() : void handleDisableInDetail())}
              />
            </div>
          </div>

          {/* Section 1: Overview & Config */}
          <section className="ca-section" aria-labelledby="ca-cap-overview-heading">
            <div className="ca-section-head">
              <div className="ca-row-main">
                <div className="ca-row-title">
                  <StatusDot tone={activationLabel(activeDetail, t).tone} />
                  <h3 id="ca-cap-overview-heading" className="ca-section-title">
                    {activeDetail.displayName}
                  </h3>
                  <span className="ca-pill ca-pill-muted">{kindLabel(activeDetail.kind, t)}</span>
                  {activeDetail.kind !== 'skill' && (
                    <span className="ca-pill ca-pill-muted">
                      {activeDetail.target === 'center' ? t('中心托管', 'Center-hosted') : t('设备运行', 'On-device')}
                    </span>
                  )}
                </div>
                <span className="ca-row-sub">
                  {t('概览与配置', 'Overview & Config')}
                  {' · '}
                  {activationLabel(activeDetail, t).text}
                  {operation ? t(` · 任务进度 ${operation.phase}`, ` · Task ${operation.phase}`) : ''}
                  {activeDetail.source.type === 'inline'
                    ? t(' · 在线技能', ' · Inline skill')
                    : ` · ${activeDetail.packageId} · v${activeDetail.targetVersion}`}
                </span>
              </div>
            </div>

            <div className="ca-section-body ca-form-stack">
              {activeDetail.activation?.error?.message && (
                <CaNotice tone="danger">
                  {activeDetail.activation.error.message}
                </CaNotice>
              )}

              {/* OAuth authorization for center-hosted OAuth MCP */}
              {(needsOAuth || activeDetail.activation?.error?.code?.includes('OAUTH') || oauthHintNeeded) && (
                <div className="ca-cred-box ca-form-stack">
                  <label className="ca-field-label" htmlFor={`${idPrefix}-oauth-bot`}>
                    {t('OAuth 身份授权（选择可用 Bot 完成授权即可启用）', 'OAuth authorization (choose an available Bot to authorize and enable)')}
                  </label>
                  <div className="ca-inline-row ca-wrap">
                    <select
                      id={`${idPrefix}-oauth-bot`}
                      className="ca-select ca-oauth-bot-select"
                      value={selectedValidationBotKey}
                      onChange={e => setSelectedValidationBotKey(e.target.value)}
                    >
                      {activeBots.length === 0 && <option value="">{t('暂无可用 Bot', 'No available Bots')}</option>}
                      {activeBots.map(b => (
                        <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                          {b.deviceName || b.deviceId} / {b.name || b.botId}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ca-btn ca-btn-primary ca-btn-sm"
                      disabled={detailBusy || !selectedValidationBotKey}
                      onClick={() => void handleStartMcpOAuth()}
                    >
                      {t('发起 OAuth 授权', 'Start OAuth')}
                    </button>
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      disabled={detailBusy || !selectedValidationBotKey}
                      onClick={() => void handleEnableInDetail()}
                    >
                      {t('重试全局启用', 'Retry enable')}
                    </button>
                    <button
                      type="button"
                      className="ca-btn ca-btn-danger ca-btn-sm"
                      disabled={detailBusy || !selectedValidationBotKey}
                      onClick={() => void handleLogoutMcpOAuth()}
                    >
                      {t('断开授权', 'Disconnect OAuth')}
                    </button>
                  </div>
                  {oauthFlow && (
                    <div className="ca-form-stack">
                      <CaExternalUrlBox
                        url={oauthFlow.authorizationUrl}
                        onOpenUrl={onOpenExternalUrl}
                        onError={err =>
                          setDetailError(
                            errorMessage(err, t('无法打开系统浏览器，请复制链接手动打开', 'Could not open browser; copy and open the link manually')),
                          )
                        }
                        copyLabel={t('复制链接', 'Copy link')}
                      />
                      <span className="ca-muted">
                        {t('授权状态：', 'Authorization status: ')}
                        {oauthStatus || t('等待授权…', 'Waiting for authorization…')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Skill visibility & multi-file editor */}
              {activeDetail.kind === 'skill' && (
                <>
                  <div className="ca-field">
                    <label className="ca-field-label" htmlFor="ca-cap-skill-scope">
                      {t('可用范围', 'Visibility scope')}
                    </label>
                    <div className="ca-inline-row" style={{ flexWrap: 'nowrap' }}>
                      <select
                        id="ca-cap-skill-scope"
                        className="ca-select"
                        style={{ flex: 1 }}
                        disabled={detailBusy}
                        value={detailScopeDraft}
                        onChange={e => setDetailScopeDraft(e.target.value as SkillVisibilityScope)}
                      >
                        {activeDetail.ownerBot && <option value="private">{t('仅源 Bot 私有', 'Source Bot only')}</option>}
                        <option value="assigned">{t('仅指定 Bot 共享', 'Assigned Bots only')}</option>
                        <option value="global">{t('全局默认可用', 'Global default')}</option>
                      </select>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        disabled={detailBusy || detailScopeDraft === (activeDetail.visibilityScope ?? (activeDetail.ownerBot ? 'private' : 'global'))}
                        onClick={() => void handleSaveSkillVisibility()}
                      >
                        <LabelStack
                          active={detailBusy ? t('保存中…', 'Saving…') : t('保存范围', 'Save scope')}
                          labels={[t('保存范围', 'Save scope'), t('保存中…', 'Saving…')]}
                        />
                      </button>
                    </div>
                  </div>

                  {detailLoading && !skillFilesRes ? (
                    <div className="ca-muted">{t('正在加载技能文件…', 'Loading skill files…')}</div>
                  ) : skillFilesRes ? (
                    <div className="ca-form-stack">
                      <div className="ca-inline-between ca-wrap">
                        <span className="ca-field-label">{t('技能文件', 'Skill files')}</span>
                        {!skillFilesRes.editable && (
                          <button
                            type="button"
                            className="ca-btn ca-btn-primary ca-btn-sm"
                            disabled={detailBusy}
                            onClick={() => void handleCloneToEditable()}
                          >
                            {t('转为可编辑副本', 'Clone to editable copy')}
                          </button>
                        )}
                      </div>

                      {!skillFilesRes.editable && (
                        <CaNotice tone="info">
                          {t('当前技能来自只读安装包；如需在线编辑内容，请点击「转为可编辑副本」。', 'This skill comes from a read-only package. Click "Clone to editable copy" to edit inline.')}
                        </CaNotice>
                      )}

                      <div className="ca-file-tabs">
                        {sortSkillPaths(Object.keys(skillFilesDraft)).map(path => (
                          <button
                            key={path}
                            type="button"
                            className={`ca-file-tab ${activeSkillPath === path ? 'is-active' : ''}`}
                            onClick={() => setActiveSkillPath(path)}
                          >
                            <span>{path}</span>
                          </button>
                        ))}
                      </div>

                      {skillFilesRes.editable && (
                        <div className="ca-inline-row ca-skill-subfile-row">
                          <input
                            type="text"
                            className="ca-input ca-mono"
                            style={{ flex: 1 }}
                            placeholder={t('新增文件（如 scripts/tool.sh、references/spec.md）', 'Add file (e.g. scripts/tool.sh, references/spec.md)')}
                            value={newSubfilePath}
                            onChange={e => setNewSubfilePath(e.target.value)}
                          />
                          <button
                            type="button"
                            className="ca-btn ca-btn-sm"
                            disabled={!newSubfilePath.trim()}
                            onClick={() => {
                              const p = newSubfilePath.trim().replace(/^\/+/, '');
                              if (!p) return;
                              setSkillFilesDraft(prev => ({ ...prev, [p]: prev[p] ?? '' }));
                              setActiveSkillPath(p);
                              setNewSubfilePath('');
                            }}
                          >
                            {t('新增文件', 'Add file')}
                          </button>
                          {activeSkillPath !== 'SKILL.md' && (
                            <button
                              type="button"
                              className="ca-btn ca-btn-danger ca-btn-sm"
                              onClick={() => {
                                const target = activeSkillPath;
                                setSkillFilesDraft(prev => {
                                  const copy = { ...prev };
                                  delete copy[target];
                                  return copy;
                                });
                                setActiveSkillPath('SKILL.md');
                              }}
                            >
                              {t('删除文件', 'Delete file')}
                            </button>
                          )}
                        </div>
                      )}

                      <textarea
                        rows={12}
                        className="ca-textarea ca-mono"
                        readOnly={!skillFilesRes.editable}
                        disabled={detailBusy}
                        value={skillFilesDraft[activeSkillPath] ?? ''}
                        onChange={e => {
                          const v = e.target.value;
                          setSkillFilesDraft(prev => ({ ...prev, [activeSkillPath]: v }));
                        }}
                      />

                      {skillFilesRes.editable && (
                        <div className="ca-form-actions" style={{ flexWrap: 'nowrap', marginTop: 0 }}>
                          <button
                            type="button"
                            className="ca-btn ca-btn-primary ca-btn-sm"
                            disabled={detailBusy}
                            aria-busy={detailBusy}
                            onClick={() => void handleSaveSkillFiles()}
                          >
                            <LabelStack
                              active={detailBusy ? t('保存中…', 'Saving…') : t('保存技能文件', 'Save skill files')}
                              labels={[t('保存技能文件', 'Save skill files'), t('保存中…', 'Saving…')]}
                            />
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              )}

              {/* MCP / Plugin global settings & connection probe */}
              {activeDetail.kind !== 'skill' && (
                <>
                  {detailLoading && !detailConfig ? (
                    <div className="ca-muted">{t('正在加载全局参数配置…', 'Loading global settings…')}</div>
                  ) : detailConfig ? (
                    <SchemaConfigForm
                      schema={detailConfig.configSchema}
                      uiSchema={detailConfig.uiSchema}
                      formData={detailGlobalDraft}
                      onChange={setDetailGlobalDraft}
                      api={api}
                      submitLabel={t('保存全局参数', 'Save global settings')}
                      submitBusy={detailBusy}
                      onSubmit={() => void handleSaveGlobalToolConfig()}
                    />
                  ) : null}

                  <div className="ca-disclosure" style={{ marginTop: 4 }}>
                    <div className="ca-inline-between ca-wrap">
                      <div>
                        <div className="ca-field-label">{t('连接与工具探测', 'Connection & tool check')}</div>
                        <div className="ca-muted">
                          {t('选用在线 Bot 验证扩展连接并拉取可用工具列表', 'Verify connectivity and inspect exposed tools using an available Bot')}
                        </div>
                      </div>
                      <div className="ca-inline-row ca-probe-actions">
                        {activeBots.length > 1 && (
                          <select
                            aria-label={t('选择探测 Bot', 'Select Bot for probe')}
                            className="ca-select ca-probe-select"
                            value={selectedValidationBotKey}
                            onChange={e => setSelectedValidationBotKey(e.target.value)}
                          >
                            {activeBots.map(b => (
                              <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                                {b.deviceName || b.deviceId} / {b.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={probeBusy || !selectedValidationBotKey}
                          onClick={() => void handleCheckAndListTools()}
                        >
                          <LabelStack
                            active={probeBusy ? t('探测中…', 'Probing…') : t('检查连接与工具', 'Check connection & tools')}
                            labels={[t('检查连接与工具', 'Check connection & tools'), t('探测中…', 'Probing…')]}
                          />
                        </button>
                      </div>
                    </div>

                    {probeResult && <div className="ca-muted ca-mt-2">{probeResult}</div>}

                    {toolsResult && (
                      <div className="ca-list ca-tools-list">
                        {toolsResult.length === 0 ? (
                          <div className="ca-empty">{t('未暴露可用工具', 'No tools exposed')}</div>
                        ) : (
                          toolsResult.map(tool => (
                            <div key={tool.name} className="ca-row ca-row-compact">
                              <div className="ca-row-main">
                                <div className="ca-row-title ca-mono">{tool.name}</div>
                                {tool.description && <div className="ca-row-sub">{tool.description}</div>}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {detailActions.length > 0 && (
                    <div className="ca-disclosure ca-form-stack" style={{ marginTop: 4 }}>
                      <div className="ca-inline-between ca-wrap">
                        <div>
                          <div className="ca-field-label">{t('扩展操作', 'Extension actions')}</div>
                          <div className="ca-muted">
                            {t('调用扩展声明的自定义操作并查看返回结果', 'Run descriptor-driven actions declared by this extension')}
                          </div>
                        </div>
                        {activeBots.length > 0 && (
                          <div className="ca-inline-row">
                            <label className="ca-field-label" htmlFor={`${idPrefix}-action-bot`}>
                              {t('执行 Bot', 'Target Bot')}
                            </label>
                            <select
                              id={`${idPrefix}-action-bot`}
                              className="ca-select ca-probe-select"
                              disabled={runningActionId !== null}
                              value={selectedValidationBotKey}
                              onChange={e => setSelectedValidationBotKey(e.target.value)}
                            >
                              {activeBots.map(b => (
                                <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                                  {b.deviceName || b.deviceId} / {b.name || b.botId}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>

                      {detailActions.map(act => {
                        const hasFields = actionHasInputFields(act.inputSchema);
                        const isRunning = runningActionId === act.id;
                        const result = actionResults[act.id];
                        return (
                          <div key={act.id} className="ca-cred-box ca-form-stack">
                            <div className="ca-inline-between ca-wrap">
                              <div>
                                <div className="ca-field-label">{act.title || act.id}</div>
                                <div className="ca-muted ca-mono">{act.id}</div>
                              </div>
                              {!hasFields && (
                                <button
                                  type="button"
                                  className="ca-btn ca-btn-sm"
                                  disabled={runningActionId !== null || !selectedValidationBotKey}
                                  aria-busy={isRunning}
                                  onClick={() => void handleRunAction(act)}
                                >
                                  <LabelStack
                                    active={isRunning ? t('执行中…', 'Running…') : t('执行', 'Run')}
                                    labels={[t('执行', 'Run'), t('执行中…', 'Running…')]}
                                  />
                                </button>
                              )}
                            </div>

                            {hasFields && (
                              <SchemaConfigForm
                                schema={act.inputSchema}
                                formData={actionDrafts[act.id] ?? {}}
                                onChange={next => setActionDrafts(prev => ({ ...prev, [act.id]: next }))}
                                api={api}
                                disabled={runningActionId !== null || !selectedValidationBotKey}
                                submitLabel={t('执行操作', 'Run action')}
                                submitBusy={isRunning}
                                onSubmit={() => void handleRunAction(act)}
                              />
                            )}

                            {result && (
                              <pre
                                className={`ca-mono ${result.ok ? 'ca-muted' : 'ca-error-text'}`}
                                style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto' }}
                              >
                                {result.output}
                              </pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Section 2: Bot Access & Overrides */}
          <section className="ca-section" aria-labelledby="ca-cap-bots-heading">
            <div className="ca-section-head">
              <h3 id="ca-cap-bots-heading" className="ca-section-title">
                {t('Bot 启用与覆盖', 'Bot Access & Overrides')}
              </h3>
              <span className="ca-muted ca-num">
                {t(`已启用 ${selectedBotKeys.size} / ${activeBots.length} 个 Bot`, `${selectedBotKeys.size} / ${activeBots.length} enabled`)}
              </span>
            </div>
            <div className="ca-section-body">
              <BotTreeSelector
                devices={devices}
                bots={bots}
                selectedKeys={selectedBotKeys}
                busyKeys={bindingBusyKeys}
                onToggleBot={(devId, bId, checked) => void handleToggleBotBinding(devId, bId, checked)}
                renderBotExtra={
                  activeDetail.kind !== 'skill' &&
                  (detailConfig || needsOAuth || activeDetail.activation?.error?.code?.includes('OAUTH') || oauthHintNeeded)
                    ? bot => {
                        const bc = botBindings.get(botKey(bot.deviceId, bot.botId));
                        const showOAuthDisconnect = Boolean(
                          needsOAuth || activeDetail.activation?.error?.code?.includes('OAUTH') || oauthHintNeeded,
                        );
                        if (!bc?.enabled && !showOAuthDisconnect) return null;
                        const overrideCount = Object.keys(bc?.overrides ?? {}).length;
                        return (
                          <div className="ca-inline-row" style={{ flexWrap: 'nowrap' }}>
                            {bc?.enabled && overrideCount > 0 && (
                              <span className="ca-pill ca-pill-info ca-num">
                                {t(`${overrideCount} 项覆盖`, `${overrideCount} overridden`)}
                              </span>
                            )}
                            {bc?.enabled && detailConfig && (
                              <button
                                type="button"
                                className="ca-btn ca-btn-sm"
                                onClick={() => openBotOverrideModal(bot)}
                              >
                                {t('配置覆盖', 'Overrides')}
                              </button>
                            )}
                            {showOAuthDisconnect && (
                              <button
                                type="button"
                                className="ca-btn ca-btn-danger ca-btn-sm"
                                disabled={detailBusy}
                                onClick={() => void handleLogoutMcpOAuth({ deviceId: bot.deviceId, botId: bot.botId })}
                              >
                                {t('断开授权', 'Disconnect OAuth')}
                              </button>
                            )}
                          </div>
                        );
                      }
                    : undefined
                }
              />
            </div>
          </section>

          {/* Section 3: Maintenance (Updates, Deployments, Uninstall) */}
          <section className="ca-section" aria-labelledby="ca-cap-maint-heading">
            <div className="ca-section-head">
              <h3 id="ca-cap-maint-heading" className="ca-section-title">
                {t('更新与卸载', 'Maintenance')}
              </h3>
              <span className="ca-muted ca-mono">
                {activeDetail.source.type === 'inline'
                  ? t('在线技能', 'Inline')
                  : `v${activeDetail.targetVersion}`}
              </span>
            </div>
            <div className="ca-section-body ca-form-stack">
              {deployments.length > 0 && (
                <div className="ca-cred-box">
                  <div className="ca-field-label ca-mb-1">
                    {t('节点同步状态', 'Node sync status')}
                  </div>
                  {deployments.map((d, idx) => (
                    <div key={idx} className="ca-muted ca-num">
                      {d.deviceId ?? t('中心节点', 'Center node')} · {d.phase} · {d.health}
                      {d.error ? t(`（${d.error.message}）`, ` (${d.error.message})`) : ''}
                    </div>
                  ))}
                </div>
              )}

              {detailInst && detailInst.source.type === 'npm' && (
                <div className="ca-form-stack">
                  <div className="ca-inline-between ca-wrap">
                    <span className="ca-muted">
                      {t(`npm 包版本：v${detailInst.targetVersion}`, `npm version: v${detailInst.targetVersion}`)}
                    </span>
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      disabled={detailBusy}
                      onClick={() => void handleCheckUpdates()}
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      <span>{t('检查更新', 'Check updates')}</span>
                    </button>
                  </div>
                  {updates && updates.length > 0 && (
                    <div className="ca-inline-row ca-wrap">
                      {updates.map(v => (
                        <button
                          key={v.version}
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={detailBusy}
                          onClick={() => void handleApplyUpdate(v.version)}
                        >
                          {t(`更新到 v${v.version}`, `Update to v${v.version}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {detailInst && detailInst.source.type === 'artifact' && (
                <div className="ca-form-stack">
                  <div className="ca-field">
                    <label className="ca-field-label" htmlFor="ca-cap-artifact-update">
                      {t('上传新版制品包 (.tgz / .tar.gz / .zip)', 'Upload new package archive (.tgz / .tar.gz / .zip)')}
                    </label>
                    <input
                      id="ca-cap-artifact-update"
                      key={updateArtifactInputKey}
                      type="file"
                      className="ca-input"
                      accept=".tgz,.tar.gz,.zip,.tar"
                      disabled={detailBusy}
                      onChange={e => setUpdateArtifactFile(e.target.files?.[0] ?? null)}
                    />
                    <span className="ca-field-help">
                      {t(`包 ID 须为 ${detailInst.packageId}；原地更新保留原实例、启用状态与 Bot 绑定。`, `Package ID must match ${detailInst.packageId}; in-place update preserves the installation ID, enable state, and Bot bindings.`)}
                    </span>
                  </div>
                  <div className="ca-inline-row">
                    <button
                      type="button"
                      className="ca-btn ca-btn-primary ca-btn-sm"
                      disabled={detailBusy || !updateArtifactFile}
                      onClick={() => void handleApplyArtifactUpdate()}
                    >
                      <Upload size={13} aria-hidden="true" />
                      <span>{t('上传并原地更新', 'Upload & update in place')}</span>
                    </button>
                  </div>
                </div>
              )}

              {activeDetail.source.type === 'http' && (
                <span className="ca-muted">
                  {t('远程 HTTP MCP 直接连接远端服务，无需包更新。', 'Remote HTTP MCP connects directly to the remote endpoint; no package update is required.')}
                </span>
              )}

              {activeDetail.source.type === 'inline' && (
                <span className="ca-muted">
                  {t('在线技能可直接在上方「概览与配置」中修改文件并实时同步。', 'Inline skills are edited directly in Overview & Config above and sync automatically.')}
                </span>
              )}

              <div className="ca-form-actions ca-form-actions-between" style={{ marginTop: 4 }}>
                <span className="ca-muted">
                  {t('卸载后将从中心目录与所有已同步设备移除，现有 Bot 绑定一并失效。', 'Uninstalling removes this capability from the center and all synced devices, revoking Bot bindings.')}
                </span>
                <button
                  type="button"
                  className="ca-btn ca-btn-danger ca-btn-sm"
                  disabled={detailBusy}
                  onClick={() => setModal({ kind: 'confirm', inst: activeDetail })}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span>{activeDetail.kind === 'skill' ? t('卸载技能', 'Uninstall skill') : t('卸载扩展', 'Uninstall extension')}</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : (
        /* Main Capabilities List View */
        <>
          <div className="ca-toolbar">
            <CaSegmented<CapabilitySegment>
              value={segment}
              ariaLabel={t('能力分类', 'Capability filter')}
              options={[
                { value: 'all', label: t('全部能力', 'All') },
                { value: 'skills', label: t('技能', 'Skills') },
                { value: 'tools', label: t('MCP 与插件', 'MCP & Plugins') },
              ]}
              onChange={next => {
                setSegment(next);
                setQuery('');
              }}
            />

            <div className="ca-toolbar-group">
              <input
                type="search"
                className="ca-input ca-toolbar-search"
                placeholder={t('搜索能力名称或包 ID…', 'Search by name or package ID…')}
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {segment !== 'tools' && (
                <button
                  type="button"
                  className="ca-btn ca-btn-primary ca-btn-sm"
                  onClick={openCreateSkillModal}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{t('新建技能', 'New skill')}</span>
                </button>
              )}
              <button
                type="button"
                className={`ca-btn ca-btn-sm${segment === 'tools' ? ' ca-btn-primary' : ''}`}
                onClick={() => openInstallModal(segment === 'skills' ? 'skill' : 'mcp')}
              >
                {segment === 'skills' ? (
                  <>
                    <Upload size={14} aria-hidden="true" />
                    <span>{t('导入技能包', 'Import skill')}</span>
                  </>
                ) : (
                  <>
                    <Plus size={14} aria-hidden="true" />
                    <span>{t('安装扩展', 'Install extension')}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <section className="ca-section">
            <div className="ca-section-head">
              {segment === 'skills' ? (
                <CaChips
                  value={skillFilter}
                  ariaLabel={t('技能来源筛选', 'Filter skills')}
                  options={[
                    { value: 'all', label: t('全部技能', 'All skills') },
                    { value: 'shared', label: t('共享技能', 'Shared') },
                    { value: 'learned', label: t('Bot 习得', 'Learned by Bot') },
                  ]}
                  onChange={setSkillFilter}
                />
              ) : (
                <h3 className="ca-section-title">
                  {segment === 'tools'
                    ? t('MCP 服务与插件', 'MCP Servers & Plugins')
                    : t('全部已安装能力', 'Installed Capabilities')}
                </h3>
              )}
              <span className="ca-muted ca-num">{t(`${filteredItems.length} 项`, `${filteredItems.length} items`)}</span>
            </div>

            <div className="ca-list">
              {filteredItems.length === 0 ? (
                <div className="ca-empty">
                  {query.trim()
                    ? t('没有匹配的能力条目', 'No matching capabilities')
                    : segment === 'tools'
                      ? t('尚未安装 MCP 服务或插件，点击上方「安装扩展」添加。', 'No MCP servers or plugins installed. Click "Install extension" above.')
                      : t('暂无已安装能力，点击上方「新建技能」或「安装扩展」。', 'No capabilities yet. Click "New skill" or "Install extension" above.')}
                </div>
              ) : (
                filteredItems.map(inst => {
                  const badge = activationLabel(inst, t);
                  const enabledCount = enabledBotCounts[inst.installationId];
                  const ownerLabel = inst.ownerBot
                    ? botNameByKey.get(botKey(inst.ownerBot.deviceId, inst.ownerBot.botId)) ||
                      inst.ownerBot.botId
                    : null;

                  return (
                    <div key={inst.installationId} className="ca-row ca-row-split">
                      <button
                        type="button"
                        className="ca-row-main ca-row-trigger"
                        onClick={() => openDetailView(inst)}
                      >
                        <span className="ca-row-title">
                          <StatusDot tone={badge.tone} />
                          <span>{inst.displayName}</span>
                          <span className="ca-pill ca-pill-muted">{kindLabel(inst.kind, t)}</span>
                          {inst.ownerBot && (
                            <span className="ca-pill ca-pill-info">
                              <Sparkles size={11} aria-hidden="true" />
                              <span>{t(`来自 ${ownerLabel}`, `From ${ownerLabel}`)}</span>
                            </span>
                          )}
                        </span>
                        <span className="ca-row-sub">
                          {badge.text}
                          {typeof enabledCount === 'number'
                            ? t(` · ${enabledCount} 个 Bot 已启用`, ` · ${enabledCount} ${enabledCount === 1 ? 'Bot' : 'Bots'} enabled`)
                            : ''}
                          {inst.kind === 'skill' && inst.visibilityScope
                            ? ` · ${scopeLabel(inst.visibilityScope, t)}`
                            : inst.kind !== 'skill'
                              ? ` · ${inst.target === 'center' ? t('中心托管', 'Center-hosted') : t('设备运行', 'On-device')} · v${inst.targetVersion}`
                              : ''}
                          {inst.activation?.error?.message ? ` · ${inst.activation.error.message}` : ''}
                        </span>
                      </button>
                      <div className="ca-row-actions">
                        <CaSwitch
                          checked={inst.enabled}
                          disabled={togglingId === inst.installationId}
                          label={t(`启用 ${inst.displayName}`, `Enable ${inst.displayName}`)}
                          onChange={next => void handleToggleGlobalRow(inst, next)}
                        />
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          onClick={() => openDetailView(inst)}
                        >
                          {t('管理', 'Manage')}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}

      {/* Mutually Exclusive Modal 1: Create Inline Skill */}
      <CaModal
        open={modal?.kind === 'create-skill'}
        onOpenChange={open => {
          if (!open && !createSkillBusy) {
            setCreateSkillError('');
            setModal(null);
          }
        }}
        title={t('新建技能', 'New skill')}
        description={t('支持多文件 Markdown 与脚本目录，创建后默认立即可用', 'Supports multi-file Markdown and scripts; enabled immediately on creation')}
        variant="drawer"
        wide
      >
        <form className="ca-form-stack" onSubmit={e => void handleCreateInlineSkill(e)}>
          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-new-skill-name">
                {t('技能名称', 'Skill name')} <span className="ca-req">*</span>
              </label>
              <input
                id="ca-new-skill-name"
                type="text"
                className="ca-input"
                required
                disabled={createSkillBusy}
                placeholder={t('例如：代码审查规范 / 日报整理', 'e.g. Code review checklist / Daily report')}
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
              />
            </div>
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-new-skill-scope">
                {t('可见范围', 'Visibility')}
              </label>
              <select
                id="ca-new-skill-scope"
                className="ca-select"
                disabled={createSkillBusy}
                value={newSkillScope}
                onChange={e => setNewSkillScope(e.target.value as SkillVisibilityScope)}
              >
                <option value="global">{t('全局默认可用', 'Global default')}</option>
                <option value="assigned">{t('仅指定 Bot 共享', 'Assigned Bots only')}</option>
              </select>
            </div>
          </div>

          <div className="ca-file-tabs">
            {sortSkillPaths(Object.keys(newSkillFiles)).map(path => (
              <button
                key={path}
                type="button"
                className={`ca-file-tab ${newSkillActiveFile === path ? 'is-active' : ''}`}
                onClick={() => setNewSkillActiveFile(path)}
              >
                <span>{path}</span>
              </button>
            ))}
          </div>

          <div className="ca-inline-row ca-skill-subfile-row">
            <input
              type="text"
              className="ca-input ca-mono"
              style={{ flex: 1 }}
              disabled={createSkillBusy}
              placeholder={t('新增附属文件路径（如 scripts/run.py 或 references/guide.md）', 'Add file path (e.g. scripts/run.py or references/guide.md)')}
              value={newSkillAddPath}
              onChange={e => setNewSkillAddPath(e.target.value)}
            />
            <button
              type="button"
              className="ca-btn ca-btn-sm"
              disabled={createSkillBusy || !newSkillAddPath.trim()}
              onClick={() => {
                const p = newSkillAddPath.trim().replace(/^\/+/, '');
                if (!p) return;
                setNewSkillFiles(prev => ({ ...prev, [p]: prev[p] ?? '' }));
                setNewSkillActiveFile(p);
                setNewSkillAddPath('');
              }}
            >
              {t('新增文件', 'Add file')}
            </button>
            {newSkillActiveFile !== 'SKILL.md' && (
              <button
                type="button"
                className="ca-btn ca-btn-danger ca-btn-sm"
                disabled={createSkillBusy}
                onClick={() => {
                  const target = newSkillActiveFile;
                  setNewSkillFiles(prev => {
                    const copy = { ...prev };
                    delete copy[target];
                    return copy;
                  });
                  setNewSkillActiveFile('SKILL.md');
                }}
              >
                {t('删除当前文件', 'Delete file')}
              </button>
            )}
          </div>

          <textarea
            rows={12}
            className="ca-textarea ca-mono"
            disabled={createSkillBusy}
            value={newSkillFiles[newSkillActiveFile] ?? ''}
            onChange={e => {
              const val = e.target.value;
              setNewSkillFiles(prev => ({ ...prev, [newSkillActiveFile]: val }));
            }}
          />

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {createSkillError ? (
              <p className="ca-error-text" role="alert">
                {createSkillError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
            <button
              type="button"
              className="ca-btn"
              disabled={createSkillBusy}
              onClick={() => setModal(null)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={createSkillBusy}
              aria-busy={createSkillBusy}
            >
              <LabelStack
                active={createSkillBusy ? t('创建中…', 'Creating…') : t('创建并启用', 'Create & enable')}
                labels={[t('创建并启用', 'Create & enable'), t('创建中…', 'Creating…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Mutually Exclusive Modal 2: Install / Import Capability */}
      <CaModal
        open={modal?.kind === 'install'}
        onOpenChange={open => {
          if (!open && !importBusy) {
            setImportError('');
            setImportNeedsBrowser(false);
            setModal(null);
          }
        }}
        title={importKind === 'skill' ? t('导入技能包', 'Import skill package') : t('安装工具扩展', 'Install extension')}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSubmitImport(e)}>
          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-install-kind">
                {t('能力类型', 'Capability type')}
              </label>
              <select
                id="ca-install-kind"
                className="ca-select"
                disabled={importBusy}
                value={importKind}
                onChange={e => {
                  const next = e.target.value as CapabilityKind;
                  setImportKind(next);
                  setImportTarget(next === 'mcp' ? 'center' : 'host');
                  if (next === 'plugin' && importSource === 'http') setImportSource('npm');
                }}
              >
                <option value="mcp">{t('MCP 服务', 'MCP server')}</option>
                <option value="plugin">{t('原生插件', 'Native plugin')}</option>
                <option value="skill">{t('技能包', 'Skill package')}</option>
              </select>
            </div>
            {importKind !== 'skill' && (
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-install-target">
                  {t('运行位置', 'Runtime target')}
                </label>
                <select
                  id="ca-install-target"
                  className="ca-select"
                  disabled={importBusy}
                  value={importTarget}
                  onChange={e => setImportTarget(e.target.value as 'center' | 'host')}
                >
                  {importKind === 'mcp' && <option value="center">{t('中心托管', 'Center-hosted')}</option>}
                  <option value="host">{t('设备 Host', 'Device Host')}</option>
                </select>
              </div>
            )}
          </div>

          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-install-name">
              {t('显示名称', 'Display name')} <span className="ca-req">*</span>
            </label>
            <input
              id="ca-install-name"
              type="text"
              className="ca-input"
              required
              disabled={importBusy}
              placeholder={importKind === 'skill' ? t('例如：团队规范技能包', 'e.g. Team guidelines skill') : t('例如：GitHub MCP', 'e.g. GitHub MCP')}
              value={importName}
              onChange={e => setImportName(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">{t('来源方式', 'Source')}</label>
            <CaSegmented
              value={importSource}
              ariaLabel={t('来源方式', 'Source')}
              options={
                importKind === 'plugin'
                  ? [
                      { value: 'npm', label: t('npm 包', 'npm package') },
                      { value: 'artifact', label: t('压缩包', 'Archive') },
                    ]
                  : [
                      { value: 'artifact', label: t('压缩包', 'Archive') },
                      { value: 'npm', label: t('npm 包', 'npm package') },
                      { value: 'http', label: 'HTTP URL' },
                    ]
              }
              onChange={setImportSource}
            />
          </div>

          {importSource === 'artifact' && (
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-install-file">
                {t('选择包文件 (.zip / .tar.gz / .tgz)', 'Select package archive (.zip / .tar.gz / .tgz)')}
              </label>
              <input
                id="ca-install-file"
                type="file"
                className="ca-input"
                disabled={importBusy}
                accept=".zip,.tar.gz,.tgz,.tar"
                onChange={e => setImportFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}

          {importSource === 'npm' && (
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-install-npm">
                {t('npm 包标识', 'npm package spec')}
              </label>
              <input
                id="ca-install-npm"
                type="text"
                className="ca-input ca-mono"
                disabled={importBusy}
                placeholder="@scope/package@latest"
                value={importSpec}
                onChange={e => setImportSpec(e.target.value)}
              />
            </div>
          )}

          {importSource === 'http' && (
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-install-http">
                {t('URL 地址', 'URL')}
              </label>
              <input
                id="ca-install-http"
                type="url"
                className="ca-input"
                disabled={importBusy}
                placeholder="https://example.com/..."
                value={importUrl}
                onChange={e => setImportUrl(e.target.value)}
              />
            </div>
          )}

          <label className="ca-check-label">
            <input
              type="checkbox"
              disabled={importBusy}
              checked={importAutoEnable}
              onChange={e => setImportAutoEnable(e.target.checked)}
            />
            <span>{t('安装后立即全局启用', 'Enable globally right after install')}</span>
          </label>

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {importError ? (
              <div className="ca-inline-between ca-wrap" style={{ width: '100%' }}>
                <p className="ca-error-text" role="alert">
                  {importError}
                </p>
                {importNeedsBrowser && onOpenExternal && (
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={onOpenExternal}
                  >
                    {t('在浏览器打开', 'Open in browser')}
                  </button>
                )}
              </div>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
            <button
              type="button"
              className="ca-btn"
              disabled={importBusy}
              onClick={() => setModal(null)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={importBusy}
              aria-busy={importBusy}
            >
              <LabelStack
                active={importBusy ? t('安装中…', 'Installing…') : t('开始安装', 'Install')}
                labels={[t('开始安装', 'Install'), t('安装中…', 'Installing…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Mutually Exclusive Modal 3: Rename Capability */}
      <CaModal
        open={modal?.kind === 'rename'}
        onOpenChange={open => {
          if (!open && !renameBusy) {
            setRenameError('');
            setModal(null);
          }
        }}
        title={t('重命名能力', 'Rename Capability')}
        description={modal?.kind === 'rename' ? modal.inst.packageId : undefined}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSubmitRename(e)}>
          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-cap-rename-input">
              {t('显示名称', 'Display name')} <span className="ca-req">*</span>
            </label>
            <input
              id="ca-cap-rename-input"
              type="text"
              className="ca-input"
              required
              autoFocus
              disabled={renameBusy}
              value={renameDraft}
              onChange={e => {
                setRenameDraft(e.target.value);
                if (renameError) setRenameError('');
              }}
            />
          </div>

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {renameError ? (
              <p className="ca-error-text" role="alert">
                {renameError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
            <button
              type="button"
              className="ca-btn"
              disabled={renameBusy}
              onClick={() => setModal(null)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={renameBusy || !renameDraft.trim()}
              aria-busy={renameBusy}
            >
              <LabelStack
                active={renameBusy ? t('保存中…', 'Saving…') : t('保存名称', 'Save name')}
                labels={[t('保存名称', 'Save name'), t('保存中…', 'Saving…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Mutually Exclusive Modal 4: Per-Bot Parameter Override (single modal over in-page detail) */}
      <CaModal
        open={modal?.kind === 'bot-override' && Boolean(detailConfig)}
        onOpenChange={open => {
          if (!open && !overrideSaving) {
            setOverrideError('');
            setModal(null);
          }
        }}
        title={
          modal?.kind === 'bot-override'
            ? t(`独立参数覆盖 · ${modal.bot.name}`, `Override settings · ${modal.bot.name}`)
            : t('独立参数覆盖', 'Override settings')
        }
        description={t('未勾选覆盖的字段自动继承全局配置', 'Unchecked fields automatically inherit global settings')}
        variant="modal"
      >
        {modal?.kind === 'bot-override' && detailConfig && (
          <SchemaConfigForm
            schema={detailConfig.configSchema}
            uiSchema={detailConfig.uiSchema}
            formData={overrideDraft}
            baseConfig={detailGlobalDraft}
            onChange={setOverrideDraft}
            api={api}
            submitLabel={t('保存覆盖参数', 'Save overrides')}
            submitBusy={overrideSaving}
            cancelLabel={t('取消', 'Cancel')}
            onCancel={() => {
              if (!overrideSaving) setModal(null);
            }}
            error={overrideError}
            onSubmit={() => void handleSaveBotOverride()}
          />
        )}
      </CaModal>

      {/* Mutually Exclusive Modal 5: Confirm Uninstall */}
      <CaConfirmDialog
        open={modal?.kind === 'confirm'}
        title={
          modal?.kind === 'confirm' && modal.inst.kind === 'skill'
            ? t('卸载技能', 'Uninstall Skill')
            : t('卸载扩展', 'Uninstall Extension')
        }
        description={
          modal?.kind === 'confirm'
            ? t(`卸载「${modal.inst.displayName}」后，该能力将从中心目录与所有已同步设备中移除，现有 Bot 绑定也会一并失效。`, `Uninstalling "${modal.inst.displayName}" removes it from the center catalog and all synced devices, and revokes existing Bot bindings.`)
            : ''
        }
        confirmLabel={
          modal?.kind === 'confirm' && modal.inst.kind === 'skill'
            ? t('卸载技能', 'Uninstall Skill')
            : t('卸载扩展', 'Uninstall Extension')
        }
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={detailBusy}
        onCancel={() => {
          if (!detailBusy) setModal(null);
        }}
        onConfirm={() => void handleUninstall()}
      />
    </div>
  );
}
