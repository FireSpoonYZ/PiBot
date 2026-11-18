import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ExternalLink, FileCode2, Plus, RefreshCw, Sparkles, Trash2, Upload, Wrench } from 'lucide-react';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  BotTreeSelector,
  CaChips,
  CaDisclosure,
  CaExternalUrlBox,
  CaModal,
  CaNotice,
  CaSegmented,
  CaSwitch,
  botKey,
  newRequestId,
} from './primitives';
import { SchemaConfigForm } from './SchemaConfigForm';
import type {
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
  McpOAuthStart,
  Operation,
  PackageVersion,
  SkillVisibilityScope,
} from './types';

function activationLabel(item: Installation): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  const st = item.activation?.status;
  if (item.enabled && st === 'enabled') return { text: '已启用', tone: 'ok' };
  if (item.enabled && st === 'enabling') return { text: '启用中', tone: 'warn' };
  if (st === 'failed') return { text: '启用失败', tone: 'danger' };
  if (item.enabled) return { text: '已开启', tone: 'ok' };
  return { text: '已停用', tone: 'muted' };
}

function scopeLabel(scope?: SkillVisibilityScope): string {
  switch (scope) {
    case 'private':
      return '仅源 Bot 私有';
    case 'assigned':
      return '指定 Bot 共享';
    case 'global':
      return '全局默认可用';
    default:
      return '默认分配';
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

export function CapabilitiesTab({
  api,
  onOpenExternal,
  onOpenExternalUrl,
}: {
  api: CenterApi;
  onOpenExternal?: () => void;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
}): React.JSX.Element {
  const [segment, setSegment] = useState<'skills' | 'tools'>('skills');
  const [skillFilter, setSkillFilter] = useState<'all' | 'shared' | 'learned'>('all');
  const [query, setQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [installations, setInstallations] = useState<Installation[]>([]);
  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [bots, setBots] = useState<CenterBotRef[]>([]);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Create inline skill modal
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillScope, setNewSkillScope] = useState<SkillVisibilityScope>('global');
  const [newSkillFiles, setNewSkillFiles] = useState<Record<string, string>>({
    'SKILL.md': '# 技能说明\n\n描述此技能的目标、触发时机与执行步骤。\n',
  });
  const [newSkillActiveFile, setNewSkillActiveFile] = useState('SKILL.md');
  const [newSkillAddPath, setNewSkillAddPath] = useState('');
  const [createSkillBusy, setCreateSkillBusy] = useState(false);
  const [createSkillError, setCreateSkillError] = useState('');

  // Import package modal (skill archive / URL / npm OR MCP/plugin install)
  const [importOpen, setImportOpen] = useState(false);
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

  // Unified Detail Drawer (Skill editor OR MCP/Plugin configurator)
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailInst, setDetailInst] = useState<Installation | null>(null);
  const [detailNameDraft, setDetailNameDraft] = useState('');
  const [detailScopeDraft, setDetailScopeDraft] = useState<SkillVisibilityScope>('global');
  const [detailConfig, setDetailConfig] = useState<InstallationConfig | null>(null);
  const [detailGlobalDraft, setDetailGlobalDraft] = useState<JsonObject>({});
  const [skillFilesRes, setSkillFilesRes] = useState<InstallationSkillFilesResponse | null>(null);
  const [skillFilesDraft, setSkillFilesDraft] = useState<Record<string, string>>({});
  const [activeSkillPath, setActiveSkillPath] = useState('SKILL.md');
  const [newSubfilePath, setNewSubfilePath] = useState('');
  const [botBindings, setBotBindings] = useState<Map<string, BotCapabilityConfig>>(new Map());
  const [bindingBusyKeys, setBindingBusyKeys] = useState<Set<string>>(new Set());
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailNotice, setDetailNotice] = useState('');

  // Per-Bot Override Modal (for MCP/Plugin)
  const [overrideBot, setOverrideBot] = useState<CenterBotRef | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<JsonObject>({});
  const [overrideRevision, setOverrideRevision] = useState(0);
  const [overrideEnabled, setOverrideEnabled] = useState(true);
  const [overrideSaving, setOverrideSaving] = useState(false);

  // OAuth & Probe/Tools check inside detail drawer
  const [selectedValidationBotKey, setSelectedValidationBotKey] = useState('');
  const [oauthFlow, setOauthFlow] = useState<McpOAuthStart | null>(null);
  const [oauthStatus, setOauthStatus] = useState('');
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<string>('');
  const [toolsResult, setToolsResult] = useState<CapabilityTool[] | null>(null);
  const [deployments, setDeployments] = useState<DeploymentReceipt[]>([]);
  const [updates, setUpdates] = useState<PackageVersion[] | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);

  const oauthTimerRef = useRef<number | null>(null);
  const opTimerRef = useRef<number | null>(null);

  const stopTimers = useCallback(() => {
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

  const loadAll = useCallback(async () => {
    const [caps, sync] = await Promise.all([api.listCapabilities(), api.getBotSync()]);
    setInstallations(caps);
    setDevices(sync.devices);
    setBots(sync.bots ?? []);
  }, [api]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadAll()
      .catch(err => {
        if (active) setError(errorMessage(err, '加载技能与扩展失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAll]);

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
      setDetailError('');
      try {
        const inst = await api.getInstallation(instId);
        setDetailInst(inst);
        setDetailNameDraft(inst.displayName);
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

        const [cfg, sFiles, deps, bindingsRec] = await Promise.all([
          cfgPromise,
          filesPromise,
          depsPromise,
          bindingsPromise,
        ]);

        const bindingMap = new Map<string, BotCapabilityConfig>();
        for (const b of activeBots) {
          const key = botKey(b.deviceId, b.botId);
          const bc = bindingsRec[key];
          if (bc) bindingMap.set(key, bc);
        }
        setBotBindings(bindingMap);
        setDetailConfig(cfg);
        setDetailGlobalDraft(cfg?.globalConfig ?? {});
        setSkillFilesRes(sFiles);
        if (sFiles) {
          setSkillFilesDraft({ ...sFiles.files });
          const sorted = sortSkillPaths(Object.keys(sFiles.files));
          setActiveSkillPath(sorted.includes('SKILL.md') ? 'SKILL.md' : sorted[0] || 'SKILL.md');
        }
        setDeployments(deps);
      } catch (err) {
        setDetailError(errorMessage(err, '加载扩展详情失败'));
      }
    },
    [activeBots, api],
  );

  const openDetailDrawer = (inst: Installation) => {
    stopTimers();
    setSelectedId(inst.installationId);
    setDetailInst(inst);
    setDetailNameDraft(inst.displayName);
    setDetailScopeDraft(inst.visibilityScope ?? (inst.ownerBot ? 'private' : 'global'));
    setDetailNotice('');
    setDetailError('');
    setOauthFlow(null);
    setOauthStatus('');
    setProbeResult('');
    setToolsResult(null);
    setUpdates(null);
    setOperation(null);
    setDetailOpen(true);
    void loadDetail(inst.installationId);
  };

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
            if (selectedId) await loadDetail(selectedId);
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
    [api, loadAll, loadDetail, selectedId],
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
      // If OAuth / validationBot needed, open drawer smoothly so user can complete OAuth right inside drawer
      const msg = errorMessage(err);
      if (msg.toLowerCase().includes('oauth') || msg.includes('validationBot') || msg.includes('授权')) {
        openDetailDrawer(inst);
        setDetailError('此 MCP 需要先完成 OAuth Bot 授权后才能全局启用，请在下方选择 Bot 一键授权。');
      } else {
        setError(msg);
      }
    } finally {
      setTogglingId(null);
    }
  };

  // Create inline skill
  const handleCreateInlineSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newSkillName.trim();
    if (!title) {
      setCreateSkillError('请填写技能名称');
      return;
    }
    const md = newSkillFiles['SKILL.md'] ?? '';
    if (!md.trim()) {
      setCreateSkillError('请填写 SKILL.md 内容');
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
      setCreateSkillOpen(false);
      setNewSkillName('');
      setNewSkillFiles({ 'SKILL.md': '# 技能说明\n\n描述此技能的目标、触发时机与执行步骤。\n' });
      setNewSkillActiveFile('SKILL.md');
      await loadAll();
      if (op?.installationId) {
        const created = await api.getInstallation(op.installationId).catch(() => null);
        if (created) openDetailDrawer(created);
      }
      setNotice(`技能「${title}」已创建并启用`);
    } catch (err) {
      setCreateSkillError(errorMessage(err, '创建技能失败'));
    } finally {
      setCreateSkillBusy(false);
    }
  };

  // Import skill package / install MCP or plugin
  const openImportModal = (defaultKind: CapabilityKind) => {
    setImportKind(defaultKind);
    setImportSource(defaultKind === 'skill' ? 'artifact' : 'npm');
    setImportName('');
    setImportSpec('');
    setImportUrl('');
    setImportFile(null);
    setImportTarget(defaultKind === 'mcp' ? 'center' : 'host');
    setImportAutoEnable(true);
    setImportError('');
    setImportOpen(true);
  };

  const handleSubmitImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = importName.trim();
    if (!name) {
      setImportError('请填写名称');
      return;
    }
    setImportBusy(true);
    setImportError('');
    try {
      let source: Parameters<CenterApi['install']>[0]['source'];
      if (importSource === 'artifact') {
        if (!importFile) throw new Error('请选择要上传的压缩包文件');
        const uploaded = await api.uploadArtifact(importFile);
        source = { type: 'artifact', artifactRef: uploaded.artifactRef };
      } else if (importSource === 'npm') {
        if (!importSpec.trim()) throw new Error('请填写 npm 包名');
        source = { type: 'npm', spec: importSpec.trim() };
      } else {
        if (!importUrl.trim()) throw new Error('请填写 URL 地址');
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
      setImportOpen(false);
      await loadAll();
      watchOperation(accepted.operationId);
      setNotice(`已提交「${name}」安装任务${importAutoEnable ? '（完成后自动启用）' : ''}`);
    } catch (err) {
      setImportError(errorMessage(err, '安装失败'));
    } finally {
      setImportBusy(false);
    }
  };

  // Detail Drawer actions
  const handleSaveDetailMeta = async () => {
    if (!detailInst) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const updated = await api.patchInstallation(detailInst.installationId, {
        expectedRevision: detailInst.revision,
        ...(detailNameDraft.trim() ? { displayName: detailNameDraft.trim() } : {}),
        ...(detailInst.kind === 'skill' ? { visibilityScope: detailScopeDraft } : {}),
      });
      setDetailInst(updated);
      setInstallations(prev => prev.map(x => (x.installationId === updated.installationId ? updated : x)));
      setDetailNotice('名称与共享范围已更新');
    } catch (err) {
      setDetailError(errorMessage(err, '保存信息失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleSaveSkillFiles = async () => {
    if (!detailInst || !skillFilesRes) return;
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
      setDetailNotice('技能文件已保存并下发至关联设备');
    } catch (err) {
      setDetailError(errorMessage(err, '保存技能文件失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleCloneToEditable = async () => {
    if (!detailInst || !skillFilesRes) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      const copyName = `${detailInst.displayName}（可编辑副本）`;
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
        await loadDetail(op.installationId);
        setDetailNotice(`已创建可编辑副本「${copyName}」`);
      } else {
        setDetailNotice(`已创建可编辑副本「${copyName}」，请在列表中打开编辑`);
      }
    } catch (err) {
      setDetailError(errorMessage(err, '转为可编辑副本失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleSaveGlobalToolConfig = async () => {
    if (!detailInst || !detailConfig) return;
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
      setDetailNotice('全局参数已保存');
    } catch (err) {
      setDetailError(errorMessage(err, '保存配置失败'));
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
      setDetailError(errorMessage(err, '更新 Bot 授权失败'));
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
    setOverrideBot(bot);
    setOverrideDraft({ ...(bc.overrides ?? {}) });
    setOverrideRevision(bc.revision);
    setOverrideEnabled(bc.enabled);
  };

  const handleSaveBotOverride = async () => {
    if (!detailInst || !overrideBot) return;
    setOverrideSaving(true);
    setDetailError('');
    try {
      const updated = await api.putBotCapability(
        overrideBot.deviceId,
        overrideBot.botId,
        detailInst.installationId,
        {
          expectedRevision: overrideRevision,
          enabled: overrideEnabled,
          overrides: overrideDraft,
        },
      );
      setBotBindings(prev => {
        const next = new Map(prev);
        next.set(botKey(overrideBot.deviceId, overrideBot.botId), updated);
        return next;
      });
      setOverrideBot(null);
      setDetailNotice(`已保存 ${overrideBot.name} 的独立覆盖参数`);
    } catch (err) {
      setDetailError(errorMessage(err, '保存 Bot 覆盖参数失败'));
    } finally {
      setOverrideSaving(false);
    }
  };

  // OAuth & Enable in detail drawer
  const parseBotKey = (key: string): { deviceId: string; botId: string } | null => {
    const idx = key.indexOf('::');
    if (idx <= 0) return null;
    return { deviceId: key.slice(0, idx), botId: key.slice(idx + 2) };
  };

  const needsOAuth =
    detailInst?.kind === 'mcp' &&
    detailInst.target === 'center' &&
    Boolean(detailConfig?.globalConfig?.oauth === true);

  const handleEnableInDrawer = async () => {
    if (!detailInst) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    const targetBot = parseBotKey(selectedValidationBotKey);
    try {
      const accepted = await api.enableInstallation(detailInst.installationId, {
        requestId: newRequestId(),
        ...(needsOAuth && targetBot ? { validationBot: targetBot } : {}),
      });
      setDetailNotice('已受理全局启用请求');
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, '全局启用失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleDisableInDrawer = async () => {
    if (!detailInst) return;
    setDetailBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const accepted = await api.disableInstallation(detailInst.installationId, {
        requestId: newRequestId(),
      });
      setDetailNotice('已受理全局停用请求');
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, '全局停用失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleStartMcpOAuth = async () => {
    if (!detailInst) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError('请先选择一个在线或可用 Bot 作为 OAuth 校验身份');
      return;
    }
    setDetailBusy(true);
    setDetailError('');
    try {
      const started = await api.startMcpOAuth(detailInst.installationId, targetBot);
      setOauthFlow(started);
      setOauthStatus('pending');
      if (oauthTimerRef.current !== null) window.clearTimeout(oauthTimerRef.current);
      const poll = async () => {
        try {
          const st = await api.getMcpOAuthFlow(started.flowId);
          setOauthStatus(st.error ? `${st.status}: ${st.error}` : st.status);
          if (st.status === 'complete') {
            setDetailNotice('OAuth 授权已完成，正在自动启用…');
            await handleEnableInDrawer();
            return;
          }
          if (st.status === 'pending') {
            oauthTimerRef.current = window.setTimeout(() => void poll(), 1200);
          }
        } catch (pErr) {
          setOauthStatus(errorMessage(pErr));
        }
      };
      oauthTimerRef.current = window.setTimeout(() => void poll(), 1500);
    } catch (err) {
      setDetailError(errorMessage(err, '启动 OAuth 授权失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleCheckAndListTools = async () => {
    if (!detailInst) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError('暂无可用的设备与 Bot 执行连接探测');
      return;
    }
    setProbeBusy(true);
    setProbeResult('');
    setToolsResult(null);
    setDetailError('');
    try {
      const check = await api.validateInstallation(detailInst.installationId, targetBot);
      setProbeResult(check.ok ? `连接正常：${check.message}` : `探测未通过：${check.message}`);
      const tools = await api.listInstallationTools(detailInst.installationId, targetBot).catch(() => null);
      if (tools) setToolsResult(tools.tools);
    } catch (err) {
      setDetailError(errorMessage(err, '探测连接与工具列表失败'));
    } finally {
      setProbeBusy(false);
    }
  };

  const handleCheckUpdates = async () => {
    if (!detailInst) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      const list = await api.checkUpdates(detailInst.installationId);
      setUpdates(list);
      if (list.length === 0) setDetailNotice('当前已是最新版本');
    } catch (err) {
      setDetailError(errorMessage(err, '检查更新失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleApplyUpdate = async (targetVersion: string) => {
    if (!detailInst) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      const accepted = await api.updateInstallation(detailInst.installationId, {
        requestId: newRequestId(),
        targetVersion,
      });
      setDetailNotice(`已发起更新到 ${targetVersion}`);
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, '更新失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleUninstall = async () => {
    if (!detailInst) return;
    if (!window.confirm(`确定卸载「${detailInst.displayName}」吗？此操作会从中心与设备移除。`)) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      await api.uninstallInstallation(detailInst.installationId, { requestId: newRequestId() });
      setDetailOpen(false);
      await loadAll();
      setNotice(`已卸载 ${detailInst.displayName}`);
    } catch (err) {
      setDetailError(errorMessage(err, '卸载失败'));
    } finally {
      setDetailBusy(false);
    }
  };

  // Filtered lists
  const skillItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return installations
      .filter(inst => inst.kind === 'skill')
      .filter(inst => {
        if (skillFilter === 'shared') return !inst.ownerBot;
        if (skillFilter === 'learned') return Boolean(inst.ownerBot);
        return true;
      })
      .filter(inst => !q || inst.displayName.toLowerCase().includes(q) || inst.packageId.toLowerCase().includes(q));
  }, [installations, query, skillFilter]);

  const toolItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return installations
      .filter(inst => inst.kind === 'mcp' || inst.kind === 'plugin')
      .filter(inst => !q || inst.displayName.toLowerCase().includes(q) || inst.packageId.toLowerCase().includes(q));
  }, [installations, query]);

  const selectedBotKeys = useMemo(() => {
    const set = new Set<string>();
    for (const [key, cfg] of botBindings.entries()) {
      if (cfg.enabled) set.add(key);
    }
    return set;
  }, [botBindings]);

  if (loading) {
    return <div className="ca-empty">正在加载技能与扩展…</div>;
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

      <div className="ca-toolbar">
        <CaSegmented
          value={segment}
          options={[
            { value: 'skills', label: '技能 (Skills)' },
            { value: 'tools', label: '工具扩展 (MCP & 插件)' },
          ]}
          onChange={next => {
            setSegment(next);
            setQuery('');
          }}
        />

        <div className="ca-toolbar-group">
          <input
            type="search"
            className="ca-input"
            style={{ width: 180, paddingTop: 5, paddingBottom: 5 }}
            placeholder={segment === 'skills' ? '搜索技能…' : '搜索扩展…'}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {segment === 'skills' ? (
            <>
              <button
                type="button"
                className="ca-btn ca-btn-primary ca-btn-sm"
                onClick={() => {
                  setCreateSkillError('');
                  setCreateSkillOpen(true);
                }}
              >
                <Plus size={14} />
                <span>新建技能</span>
              </button>
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                onClick={() => openImportModal('skill')}
              >
                <Upload size={14} />
                <span>导入技能包</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              onClick={() => openImportModal('mcp')}
            >
              <Plus size={14} />
              <span>安装扩展</span>
            </button>
          )}
        </div>
      </div>

      {segment === 'skills' ? (
        <section className="ca-section">
          <div className="ca-section-head" style={{ flexWrap: 'wrap' }}>
            <CaChips
              value={skillFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'shared', label: '全局共享' },
                { value: 'learned', label: '✨ Bot 习得' },
              ]}
              onChange={setSkillFilter}
            />
            <span className="ca-muted ca-num">{skillItems.length} 项</span>
          </div>

          <div className="ca-list">
            {skillItems.length === 0 ? (
              <div className="ca-empty">暂无技能，点击右上角「+ 新建技能」或「导入技能包」</div>
            ) : (
              skillItems.map(inst => {
                const badge = activationLabel(inst);
                const ownerLabel = inst.ownerBot
                  ? botNameByKey.get(botKey(inst.ownerBot.deviceId, inst.ownerBot.botId)) ||
                    inst.ownerBot.botId
                  : null;
                return (
                  <div
                    key={inst.installationId}
                    className="ca-row is-clickable"
                    onClick={() => openDetailDrawer(inst)}
                  >
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <span>{inst.displayName}</span>
                        <span
                          className={`ca-pill ${
                            badge.tone === 'ok'
                              ? 'ca-pill-ok'
                              : badge.tone === 'warn'
                                ? 'ca-pill-warn'
                                : badge.tone === 'danger'
                                  ? 'ca-pill-danger'
                                  : 'ca-pill-muted'
                          }`}
                        >
                          {badge.text}
                        </span>
                        {inst.ownerBot && (
                          <span className="ca-pill ca-pill-info">
                            <Sparkles size={11} />
                            <span>来自 {ownerLabel}</span>
                          </span>
                        )}
                        {inst.visibilityScope && (
                          <span className="ca-pill ca-pill-muted">{scopeLabel(inst.visibilityScope)}</span>
                        )}
                      </div>
                      <div className="ca-row-sub">
                        {inst.source.type === 'inline' ? '在线 Markdown 技能' : `${inst.packageId} · v${inst.targetVersion}`}
                      </div>
                    </div>
                    <div className="ca-row-actions" onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openDetailDrawer(inst)}
                      >
                        <FileCode2 size={13} />
                        <span>编辑</span>
                      </button>
                      <CaSwitch
                        checked={inst.enabled}
                        disabled={togglingId === inst.installationId}
                        label={`启用 ${inst.displayName}`}
                        onChange={next => void handleToggleGlobalRow(inst, next)}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      ) : (
        <section className="ca-section">
          <div className="ca-section-head">
            <h3 className="ca-section-title">MCP 服务与插件</h3>
            <span className="ca-muted ca-num">{toolItems.length} 项</span>
          </div>

          <div className="ca-list">
            {toolItems.length === 0 ? (
              <div className="ca-empty">尚未安装 MCP 服务或插件，点击右上角「安装扩展」</div>
            ) : (
              toolItems.map(inst => {
                const badge = activationLabel(inst);
                return (
                  <div
                    key={inst.installationId}
                    className="ca-row is-clickable"
                    onClick={() => openDetailDrawer(inst)}
                  >
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <span>{inst.displayName}</span>
                        <span className="ca-pill ca-pill-muted">{inst.kind === 'mcp' ? 'MCP' : '插件'}</span>
                        <span className="ca-pill ca-pill-muted">
                          {inst.target === 'center' ? '中心托管' : '设备运行'}
                        </span>
                        <span
                          className={`ca-pill ${
                            badge.tone === 'ok'
                              ? 'ca-pill-ok'
                              : badge.tone === 'warn'
                                ? 'ca-pill-warn'
                                : badge.tone === 'danger'
                                  ? 'ca-pill-danger'
                                  : 'ca-pill-muted'
                          }`}
                        >
                          {badge.text}
                        </span>
                      </div>
                      <div className="ca-row-sub">
                        {inst.packageId} · v{inst.targetVersion}
                        {inst.activation?.error?.message ? ` · ${inst.activation.error.message}` : ''}
                      </div>
                    </div>
                    <div className="ca-row-actions" onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openDetailDrawer(inst)}
                      >
                        <Wrench size={13} />
                        <span>配置</span>
                      </button>
                      <CaSwitch
                        checked={inst.enabled}
                        disabled={togglingId === inst.installationId}
                        label={`启用 ${inst.displayName}`}
                        onChange={next => void handleToggleGlobalRow(inst, next)}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}

      {/* 1 步新建多文件 Inline Skill 抽屉 */}
      <CaModal
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        title="新建技能"
        description="支持多文件 Markdown 与脚本目录，创建后默认立即可用"
        variant="drawer"
        wide
      >
        <form className="ca-form-stack" onSubmit={e => void handleCreateInlineSkill(e)}>
          {createSkillError && <CaNotice tone="danger">{createSkillError}</CaNotice>}
          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label">
                技能名称 <span className="ca-req">*</span>
              </label>
              <input
                type="text"
                className="ca-input"
                required
                placeholder="例如：代码审查规范 / 日报整理"
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
              />
            </div>
            <div className="ca-field">
              <label className="ca-field-label">可见范围</label>
              <select
                className="ca-select"
                value={newSkillScope}
                onChange={e => setNewSkillScope(e.target.value as SkillVisibilityScope)}
              >
                <option value="global">全局默认可用</option>
                <option value="assigned">仅指定 Bot 共享</option>
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

          <div className="ca-inline-row">
            <input
              type="text"
              className="ca-input ca-mono"
              placeholder="新增附属文件路径（如 scripts/run.py 或 references/guide.md）"
              value={newSkillAddPath}
              onChange={e => setNewSkillAddPath(e.target.value)}
            />
            <button
              type="button"
              className="ca-btn ca-btn-sm"
              disabled={!newSkillAddPath.trim()}
              onClick={() => {
                const p = newSkillAddPath.trim().replace(/^\/+/, '');
                if (!p) return;
                setNewSkillFiles(prev => ({ ...prev, [p]: prev[p] ?? '' }));
                setNewSkillActiveFile(p);
                setNewSkillAddPath('');
              }}
            >
              新增文件
            </button>
            {newSkillActiveFile !== 'SKILL.md' && (
              <button
                type="button"
                className="ca-btn ca-btn-danger ca-btn-sm"
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
                删除当前文件
              </button>
            )}
          </div>

          <textarea
            rows={14}
            className="ca-textarea ca-mono"
            value={newSkillFiles[newSkillActiveFile] ?? ''}
            onChange={e => {
              const val = e.target.value;
              setNewSkillFiles(prev => ({ ...prev, [newSkillActiveFile]: val }));
            }}
          />

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setCreateSkillOpen(false)}>
              取消
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={createSkillBusy}>
              {createSkillBusy ? '创建中…' : '创建并启用'}
            </button>
          </div>
        </form>
      </CaModal>

      {/* 导入技能包 / 安装 MCP & 插件弹窗 */}
      <CaModal
        open={importOpen}
        onOpenChange={setImportOpen}
        title={importKind === 'skill' ? '导入技能包' : '安装工具扩展'}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSubmitImport(e)}>
          {importError && (
            <CaNotice
              tone="danger"
              action={
                importSource === 'artifact' && onOpenExternal ? (
                  <button type="button" className="ca-btn ca-btn-sm" onClick={onOpenExternal}>
                    <ExternalLink size={13} />
                    <span>在浏览器打开</span>
                  </button>
                ) : undefined
              }
            >
              {importError}
            </CaNotice>
          )}

          {importKind !== 'skill' && (
            <div className="ca-grid-2">
              <div className="ca-field">
                <label className="ca-field-label">扩展类型</label>
                <select
                  className="ca-select"
                  value={importKind}
                  onChange={e => {
                    const next = e.target.value as CapabilityKind;
                    setImportKind(next);
                    setImportTarget(next === 'mcp' ? 'center' : 'host');
                    if (next === 'plugin' && importSource === 'http') setImportSource('npm');
                  }}
                >
                  <option value="mcp">MCP 服务</option>
                  <option value="plugin">原生插件</option>
                </select>
              </div>
              <div className="ca-field">
                <label className="ca-field-label">运行位置</label>
                <select
                  className="ca-select"
                  value={importTarget}
                  onChange={e => setImportTarget(e.target.value as 'center' | 'host')}
                >
                  {importKind === 'mcp' && <option value="center">中心托管</option>}
                  <option value="host">设备 Host</option>
                </select>
              </div>
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label">
              显示名称 <span className="ca-req">*</span>
            </label>
            <input
              type="text"
              className="ca-input"
              required
              placeholder={importKind === 'skill' ? '例如：团队规范技能包' : '例如：GitHub MCP'}
              value={importName}
              onChange={e => setImportName(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">来源方式</label>
            <CaSegmented
              value={importSource}
              options={
                importKind === 'plugin'
                  ? [
                      { value: 'npm', label: 'npm 包' },
                      { value: 'artifact', label: '压缩包' },
                    ]
                  : [
                      { value: 'artifact', label: '压缩包' },
                      { value: 'npm', label: 'npm 包' },
                      { value: 'http', label: 'HTTP URL' },
                    ]
              }
              onChange={setImportSource}
            />
          </div>

          {importSource === 'artifact' && (
            <div className="ca-field">
              <label className="ca-field-label">选择包文件 (.zip / .tar.gz / .tgz)</label>
              <input
                type="file"
                className="ca-input"
                accept=".zip,.tar.gz,.tgz,.tar"
                onChange={e => setImportFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}

          {importSource === 'npm' && (
            <div className="ca-field">
              <label className="ca-field-label">npm 包标识</label>
              <input
                type="text"
                className="ca-input ca-mono"
                placeholder="@scope/package@latest"
                value={importSpec}
                onChange={e => setImportSpec(e.target.value)}
              />
            </div>
          )}

          {importSource === 'http' && (
            <div className="ca-field">
              <label className="ca-field-label">URL 地址</label>
              <input
                type="url"
                className="ca-input"
                placeholder="https://example.com/..."
                value={importUrl}
                onChange={e => setImportUrl(e.target.value)}
              />
            </div>
          )}

          <label className="ca-check-label">
            <input
              type="checkbox"
              checked={importAutoEnable}
              onChange={e => setImportAutoEnable(e.target.checked)}
            />
            <span>安装后立即全局启用</span>
          </label>

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={importBusy}>
              {importBusy ? '安装中…' : '开始安装'}
            </button>
          </div>
        </form>
      </CaModal>

      {/* 技能 / 工具扩展统一详情抽屉 */}
      <CaModal
        open={detailOpen}
        onOpenChange={open => {
          if (!open) stopTimers();
          setDetailOpen(open);
        }}
        title={detailInst?.displayName || '扩展配置'}
        description={
          detailInst
            ? `${detailInst.kind === 'skill' ? '技能' : detailInst.kind === 'mcp' ? 'MCP 服务' : '原生插件'} · ${
                detailInst.packageId
              }`
            : ''
        }
        variant="drawer"
        wide
      >
        {detailInst && (
          <div className="ca-form-stack">
            {detailError && <CaNotice tone="danger">{detailError}</CaNotice>}
            {detailNotice && <CaNotice tone="ok">{detailNotice}</CaNotice>}

            {/* 唯一全局启停状态栏 */}
            <div className="ca-section" style={{ padding: 12 }}>
              <div className="ca-inline-between">
                <div>
                  <div className="ca-field-label">全局启用状态</div>
                  <div className="ca-muted">
                    {activationLabel(detailInst).text}
                    {operation ? ` · 任务进度：${operation.phase}` : ''}
                    {detailInst.activation?.error?.message
                      ? ` · ${detailInst.activation.error.message}`
                      : ''}
                  </div>
                </div>
                <CaSwitch
                  checked={detailInst.enabled}
                  disabled={detailBusy}
                  label={`启用 ${detailInst.displayName}`}
                  onChange={next => (next ? void handleEnableInDrawer() : void handleDisableInDrawer())}
                />
              </div>
            </div>

            {/* OAuth MCP 一键解锁与授权（消除 OAuth 死锁） */}
            {(needsOAuth || detailInst.activation?.error?.code?.includes('OAUTH') || detailError.includes('OAuth')) && (
              <div className="ca-section" style={{ padding: 12 }}>
                <div className="ca-field-label" style={{ marginBottom: 6 }}>
                  OAuth 身份授权（选择任意可用 Bot 完成授权即可启用）
                </div>
                <div className="ca-inline-row" style={{ flexWrap: 'wrap' }}>
                  <select
                    className="ca-select"
                    style={{ flex: 1, minWidth: 180 }}
                    value={selectedValidationBotKey}
                    onChange={e => setSelectedValidationBotKey(e.target.value)}
                  >
                    {activeBots.length === 0 && <option value="">暂无可用 Bot</option>}
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
                    发起 OAuth 授权
                  </button>
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    disabled={detailBusy || !selectedValidationBotKey}
                    onClick={() => void handleEnableInDrawer()}
                  >
                    带此身份重试启用
                  </button>
                </div>
                {oauthFlow && (
                  <div className="ca-form-stack" style={{ marginTop: 10, gap: 8 }}>
                    <CaExternalUrlBox
                      url={oauthFlow.authorizationUrl}
                      onOpenUrl={onOpenExternalUrl}
                      onError={err =>
                        setDetailError(
                          errorMessage(err, '无法打开系统默认浏览器，请复制链接手动打开'),
                        )
                      }
                      copyLabel="复制链接"
                    />
                    <span className="ca-muted">当前状态：{oauthStatus || '等待授权…'}</span>
                  </div>
                )}
              </div>
            )}

            {/* 名称与可见范围设置 */}
            <div className="ca-section" style={{ padding: 12 }}>
              <div className={detailInst.kind === 'skill' ? 'ca-grid-2' : 'ca-field'}>
                <div className="ca-field">
                  <label className="ca-field-label">显示名称</label>
                  <input
                    type="text"
                    className="ca-input"
                    value={detailNameDraft}
                    onChange={e => setDetailNameDraft(e.target.value)}
                  />
                </div>
                {detailInst.kind === 'skill' && (
                  <div className="ca-field">
                    <label className="ca-field-label">可用范围</label>
                    <select
                      className="ca-select"
                      value={detailScopeDraft}
                      onChange={e => setDetailScopeDraft(e.target.value as SkillVisibilityScope)}
                    >
                      {detailInst.ownerBot && <option value="private">仅源 Bot 私有</option>}
                      <option value="assigned">仅指定 Bot 共享</option>
                      <option value="global">全局默认可用</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="ca-inline-end" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={detailBusy}
                  onClick={() => void handleSaveDetailMeta()}
                >
                  保存基础信息
                </button>
              </div>
            </div>

            {/* Skill 多文件在线编辑器 */}
            {detailInst.kind === 'skill' && skillFilesRes && (
              <div className="ca-section" style={{ padding: 12 }}>
                <div className="ca-inline-between" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                  <span className="ca-field-label">技能文件</span>
                  {!skillFilesRes.editable && (
                    <button
                      type="button"
                      className="ca-btn ca-btn-primary ca-btn-sm"
                      disabled={detailBusy}
                      onClick={() => void handleCloneToEditable()}
                    >
                      转为可编辑副本
                    </button>
                  )}
                </div>

                {!skillFilesRes.editable && (
                  <CaNotice tone="info">
                    当前技能来自只读安装包；如需在线修改文件内容，可点击上方「转为可编辑副本」。
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
                  <div className="ca-inline-row" style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      className="ca-input ca-mono"
                      placeholder="新增文件（如 scripts/tool.sh、references/spec.md）"
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
                      新增
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
                        删除文件
                      </button>
                    )}
                  </div>
                )}

                <textarea
                  rows={12}
                  className="ca-textarea ca-mono"
                  readOnly={!skillFilesRes.editable}
                  value={skillFilesDraft[activeSkillPath] ?? ''}
                  onChange={e => {
                    const v = e.target.value;
                    setSkillFilesDraft(prev => ({ ...prev, [activeSkillPath]: v }));
                  }}
                />

                {skillFilesRes.editable && (
                  <div className="ca-inline-end" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="ca-btn ca-btn-primary ca-btn-sm"
                      disabled={detailBusy}
                      onClick={() => void handleSaveSkillFiles()}
                    >
                      保存技能文件
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* MCP / Plugin 全局参数配置 */}
            {detailInst.kind !== 'skill' && detailConfig && (
              <div className="ca-section" style={{ padding: 12 }}>
                <div className="ca-field-label" style={{ marginBottom: 8 }}>
                  全局默认参数
                </div>
                <SchemaConfigForm
                  schema={detailConfig.configSchema}
                  uiSchema={detailConfig.uiSchema}
                  formData={detailGlobalDraft}
                  onChange={setDetailGlobalDraft}
                  api={api}
                  submitLabel="保存全局参数"
                  submitBusy={detailBusy}
                  onSubmit={() => void handleSaveGlobalToolConfig()}
                />
              </div>
            )}

            {/* 跨设备树形多选框直接勾选分配 Bot */}
            <div className="ca-section" style={{ padding: 12 }}>
              <div className="ca-field-label" style={{ marginBottom: 8 }}>
                跨设备 Bot 授权分配
              </div>
              <BotTreeSelector
                devices={devices}
                bots={bots}
                selectedKeys={selectedBotKeys}
                busyKeys={bindingBusyKeys}
                onToggleBot={(devId, bId, checked) => void handleToggleBotBinding(devId, bId, checked)}
                renderBotExtra={
                  detailInst.kind !== 'skill' && detailConfig
                    ? bot =>
                        botBindings.get(botKey(bot.deviceId, bot.botId))?.enabled ? (
                          <button
                            type="button"
                            className="ca-btn ca-btn-sm"
                            onClick={() => openBotOverrideModal(bot)}
                          >
                            独立参数
                          </button>
                        ) : null
                    : undefined
                }
              />
            </div>

            {/* MCP / Plugin 连接与工具列表检查 */}
            {detailInst.kind !== 'skill' && (
              <div className="ca-section" style={{ padding: 12 }}>
                <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                  <div>
                    <div className="ca-field-label">连接与工具列表</div>
                    <div className="ca-muted">自动选用在线设备的 Bot 验证连接并读取工具定义</div>
                  </div>
                  <div className="ca-inline-row">
                    {activeBots.length > 1 && (
                      <select
                        className="ca-select"
                        style={{ width: 170 }}
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
                      {probeBusy ? '探测中…' : '检查连接与工具列表'}
                    </button>
                  </div>
                </div>
                {probeResult && (
                  <div className="ca-muted" style={{ marginTop: 8 }}>
                    {probeResult}
                  </div>
                )}
                {toolsResult && (
                  <div className="ca-list" style={{ marginTop: 8, border: '1px solid var(--ca-border)', borderRadius: 7 }}>
                    {toolsResult.length === 0 ? (
                      <div className="ca-empty">未暴露可用工具</div>
                    ) : (
                      toolsResult.map(t => (
                        <div key={t.name} className="ca-row" style={{ padding: '8px 10px' }}>
                          <div className="ca-row-main">
                            <div className="ca-row-title ca-mono">{t.name}</div>
                            {t.description && <div className="ca-row-sub">{t.description}</div>}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 更新、部署回执与卸载折叠区 */}
            <CaDisclosure title="更新、部署状态与卸载">
              <div className="ca-form-stack">
                {deployments.length > 0 && (
                  <div className="ca-cred-box">
                    <div className="ca-field-label" style={{ marginBottom: 4 }}>
                      各节点同步状态
                    </div>
                    {deployments.map((d, idx) => (
                      <div key={idx} className="ca-muted ca-num">
                        {d.deviceId ?? '中心节点'} · {d.phase} · {d.health}
                        {d.error ? `（${d.error.message}）` : ''}
                      </div>
                    ))}
                  </div>
                )}

                {detailInst.source.type !== 'inline' && (
                  <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                    <span className="ca-muted">当前版本：v{detailInst.targetVersion}</span>
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      disabled={detailBusy}
                      onClick={() => void handleCheckUpdates()}
                    >
                      <RefreshCw size={13} />
                      <span>检查更新</span>
                    </button>
                  </div>
                )}

                {updates && updates.length > 0 && (
                  <div className="ca-inline-row" style={{ flexWrap: 'wrap' }}>
                    {updates.map(v => (
                      <button
                        key={v.version}
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => void handleApplyUpdate(v.version)}
                      >
                        更新到 v{v.version}
                      </button>
                    ))}
                  </div>
                )}

                <div className="ca-inline-end">
                  <button
                    type="button"
                    className="ca-btn ca-btn-danger ca-btn-sm"
                    disabled={detailBusy}
                    onClick={() => void handleUninstall()}
                  >
                    <Trash2 size={13} />
                    <span>卸载{detailInst.kind === 'skill' ? '技能' : '扩展'}</span>
                  </button>
                </div>
              </div>
            </CaDisclosure>
          </div>
        )}
      </CaModal>

      {/* 单 Bot 独立参数覆盖子弹窗 */}
      <CaModal
        open={Boolean(overrideBot)}
        onOpenChange={open => {
          if (!open) setOverrideBot(null);
        }}
        title={`独立参数覆盖 · ${overrideBot?.name ?? ''}`}
        description="未勾选覆盖的字段自动继承全局配置"
        variant="modal"
      >
        {overrideBot && detailConfig && (
          <SchemaConfigForm
            schema={detailConfig.configSchema}
            uiSchema={detailConfig.uiSchema}
            formData={overrideDraft}
            baseConfig={detailGlobalDraft}
            onChange={setOverrideDraft}
            api={api}
            submitLabel="保存覆盖参数"
            submitBusy={overrideSaving}
            onSubmit={() => void handleSaveBotOverride()}
          />
        )}
      </CaModal>
    </div>
  );
}
