import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ExternalLink, FileCode2, Plus, RefreshCw, Sparkles, Trash2, Upload, Wrench } from 'lucide-react';
import { useText } from '../ui';
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

type TranslateFn = (zh: string, en: string) => string;

function activationLabel(item: Installation, t: TranslateFn): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  const st = item.activation?.status;
  if (item.enabled && st === 'enabled') return { text: t('已启用', 'Enabled'), tone: 'ok' };
  if (item.enabled && st === 'enabling') return { text: t('启用中', 'Enabling'), tone: 'warn' };
  if (st === 'failed') return { text: t('启用失败', 'Failed'), tone: 'danger' };
  if (item.enabled) return { text: t('已开启', 'On'), tone: 'ok' };
  return { text: t('已停用', 'Disabled'), tone: 'muted' };
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

export function CapabilitiesTab({
  api,
  onOpenExternal,
  onOpenExternalUrl,
}: {
  api: CenterApi;
  onOpenExternal?: () => void;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
}): React.JSX.Element {
  const t = useText();
  const defaultSkillMarkdown = t('# 技能说明\n\n描述此技能的目标、触发时机与执行步骤。\n', '# Skill Guide\n\nDescribe the goal, triggers, and execution steps for this skill.\n');

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
  const [newSkillFiles, setNewSkillFiles] = useState<Record<string, string>>(() => ({
    'SKILL.md': defaultSkillMarkdown,
  }));
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
        if (active) setError(errorMessage(err, t('加载技能与扩展失败', 'Failed to load skills and extensions')));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAll, t]);

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
        setDetailError(errorMessage(err, t('加载扩展详情失败', 'Failed to load extension details')));
      }
    },
    [activeBots, api, t],
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
      const msg = errorMessage(err, t('操作失败', 'Operation failed'));
      if (msg.toLowerCase().includes('oauth') || msg.includes('validationBot') || msg.includes('授权')) { // i18n-ok
        openDetailDrawer(inst);
        setDetailError(t('此 MCP 需要先完成 OAuth Bot 授权后才能全局启用，请在下方选择 Bot 一键授权。', 'This MCP requires OAuth authorization with a Bot before enabling globally. Choose a Bot below to authorize.'));
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
      setCreateSkillError(t('请填写技能名称', 'Please enter a skill name'));
      return;
    }
    const md = newSkillFiles['SKILL.md'] ?? '';
    if (!md.trim()) {
      setCreateSkillError(t('请填写 SKILL.md 内容', 'Please enter SKILL.md content'));
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
      setNewSkillFiles({ 'SKILL.md': defaultSkillMarkdown });
      setNewSkillActiveFile('SKILL.md');
      await loadAll();
      if (op?.installationId) {
        const created = await api.getInstallation(op.installationId).catch(() => null);
        if (created) openDetailDrawer(created);
      }
      setNotice(t(`技能「${title}」已创建并启用`, `Skill "${title}" created and enabled`));
    } catch (err) {
      setCreateSkillError(errorMessage(err, t('创建技能失败', 'Failed to create skill')));
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
      setImportError(t('请填写名称', 'Please enter a name'));
      return;
    }
    setImportBusy(true);
    setImportError('');
    try {
      let source: Parameters<CenterApi['install']>[0]['source'];
      if (importSource === 'artifact') {
        if (!importFile) throw new Error(t('请选择要上传的压缩包文件', 'Please select an archive file to upload'));
        const uploaded = await api.uploadArtifact(importFile);
        source = { type: 'artifact', artifactRef: uploaded.artifactRef };
      } else if (importSource === 'npm') {
        if (!importSpec.trim()) throw new Error(t('请填写 npm 包名', 'Please enter an npm package spec'));
        source = { type: 'npm', spec: importSpec.trim() };
      } else {
        if (!importUrl.trim()) throw new Error(t('请填写 URL 地址', 'Please enter a URL'));
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
      setNotice(
        importAutoEnable
          ? t(`已提交「${name}」安装任务（完成后自动启用）`, `Submitted install task for "${name}" (auto-enable on completion)`)
          : t(`已提交「${name}」安装任务`, `Submitted install task for "${name}"`),
      );
    } catch (err) {
      setImportError(errorMessage(err, t('安装失败', 'Installation failed')));
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
      setDetailNotice(t('名称与共享范围已更新', 'Name and visibility updated'));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存信息失败', 'Failed to save details')));
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
      setDetailNotice(t('技能文件已保存并下发至关联设备', 'Skill files saved and synced to connected devices'));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存技能文件失败', 'Failed to save skill files')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleCloneToEditable = async () => {
    if (!detailInst || !skillFilesRes) return;
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
        await loadDetail(op.installationId);
        setDetailNotice(t(`已创建可编辑副本「${copyName}」`, `Created editable copy "${copyName}"`));
      } else {
        setDetailNotice(t(`已创建可编辑副本「${copyName}」，请在列表中打开编辑`, `Created editable copy "${copyName}". Open it from the list to edit.`));
      }
    } catch (err) {
      setDetailError(errorMessage(err, t('转为可编辑副本失败', 'Failed to create editable copy')));
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
      setDetailNotice(t('全局参数已保存', 'Global settings saved'));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存配置失败', 'Failed to save settings')));
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
      setDetailError(errorMessage(err, t('更新 Bot 授权失败', 'Failed to update Bot access')));
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
      setDetailNotice(t(`已保存 ${overrideBot.name} 的独立覆盖参数`, `Saved override settings for ${overrideBot.name}`));
    } catch (err) {
      setDetailError(errorMessage(err, t('保存 Bot 覆盖参数失败', 'Failed to save Bot override settings')));
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
      setDetailNotice(t('已受理全局启用请求', 'Global enable request accepted'));
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, t('全局启用失败', 'Failed to enable globally')));
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
      setDetailNotice(t('已受理全局停用请求', 'Global disable request accepted'));
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, t('全局停用失败', 'Failed to disable globally')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleStartMcpOAuth = async () => {
    if (!detailInst) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError(t('请先选择一个在线或可用 Bot 作为 OAuth 校验身份', 'Select an available Bot to authorize OAuth'));
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
            setDetailNotice(t('OAuth 授权已完成，正在自动启用…', 'OAuth authorized, enabling automatically…'));
            await handleEnableInDrawer();
            return;
          }
          if (st.status === 'pending') {
            oauthTimerRef.current = window.setTimeout(() => void poll(), 1200);
          }
        } catch (pErr) {
          setOauthStatus(errorMessage(pErr, t('查询授权状态失败', 'Failed to check OAuth status')));
        }
      };
      oauthTimerRef.current = window.setTimeout(() => void poll(), 1500);
    } catch (err) {
      setDetailError(errorMessage(err, t('启动 OAuth 授权失败', 'Failed to start OAuth authorization')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleCheckAndListTools = async () => {
    if (!detailInst) return;
    const targetBot = parseBotKey(selectedValidationBotKey);
    if (!targetBot) {
      setDetailError(t('暂无可用的设备与 Bot 执行连接探测', 'No available device and Bot to run connection check'));
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
      setDetailError(errorMessage(err, t('探测连接与工具列表失败', 'Failed to check connection and tools')));
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
      if (list.length === 0) setDetailNotice(t('当前已是最新版本', 'Already up to date'));
    } catch (err) {
      setDetailError(errorMessage(err, t('检查更新失败', 'Failed to check updates')));
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
      setDetailNotice(t(`已发起更新到 ${targetVersion}`, `Started update to ${targetVersion}`));
      watchOperation(accepted.operationId);
    } catch (err) {
      setDetailError(errorMessage(err, t('更新失败', 'Update failed')));
    } finally {
      setDetailBusy(false);
    }
  };

  const handleUninstall = async () => {
    if (!detailInst) return;
    if (!window.confirm(t(`确定卸载「${detailInst.displayName}」吗？此操作会从中心与设备移除。`, `Uninstall "${detailInst.displayName}"? This removes it from center and devices.`))) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      await api.uninstallInstallation(detailInst.installationId, { requestId: newRequestId() });
      setDetailOpen(false);
      await loadAll();
      setNotice(t(`已卸载 ${detailInst.displayName}`, `Uninstalled ${detailInst.displayName}`));
    } catch (err) {
      setDetailError(errorMessage(err, t('卸载失败', 'Uninstall failed')));
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
    return <div className="ca-empty">{t('正在加载技能与扩展…', 'Loading skills and extensions…')}</div>;
  }

  return (
    <div>
      {error && <CaNotice tone="danger">{error}</CaNotice>}
      {notice && (
        <CaNotice
          tone="ok"
          action={
            <button type="button" className="ca-btn ca-btn-ghost ca-btn-sm" onClick={() => setNotice('')}>
              {t('关闭', 'Close')}
            </button>
          }
        >
          {notice}
        </CaNotice>
      )}

      <div className="ca-toolbar">
        <CaSegmented
          value={segment}
          ariaLabel={t('能力分类', 'Capability category')}
          options={[
            { value: 'skills', label: t('技能 (Skills)', 'Skills') },
            { value: 'tools', label: t('工具扩展 (MCP & 插件)', 'Extensions (MCP & Plugins)') },
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
            placeholder={segment === 'skills' ? t('搜索技能…', 'Search skills…') : t('搜索扩展…', 'Search extensions…')}
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
                <span>{t('新建技能', 'New skill')}</span>
              </button>
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                onClick={() => openImportModal('skill')}
              >
                <Upload size={14} />
                <span>{t('导入技能包', 'Import skill')}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              onClick={() => openImportModal('mcp')}
            >
              <Plus size={14} />
              <span>{t('安装扩展', 'Install extension')}</span>
            </button>
          )}
        </div>
      </div>

      {segment === 'skills' ? (
        <section className="ca-section">
          <div className="ca-section-head">
            <CaChips
              value={skillFilter}
              ariaLabel={t('技能筛选', 'Filter skills')}
              options={[
                { value: 'all', label: t('全部', 'All') },
                { value: 'shared', label: t('全局共享', 'Shared') },
                { value: 'learned', label: t('✨ Bot 习得', '✨ Learned by Bot') },
              ]}
              onChange={setSkillFilter}
            />
            <span className="ca-muted ca-num">{t(`${skillItems.length} 项`, `${skillItems.length} items`)}</span>
          </div>

          <div className="ca-list">
            {skillItems.length === 0 ? (
              <div className="ca-empty">{t('暂无技能，点击右上角「+ 新建技能」或「导入技能包」', 'No skills yet. Click "+ New skill" or "Import skill" above.')}</div>
            ) : (
              skillItems.map(inst => {
                const badge = activationLabel(inst, t);
                const ownerLabel = inst.ownerBot
                  ? botNameByKey.get(botKey(inst.ownerBot.deviceId, inst.ownerBot.botId)) ||
                    inst.ownerBot.botId
                  : null;
                return (
                  <div key={inst.installationId} className="ca-row ca-row-split">
                    <button
                      type="button"
                      className="ca-row-main ca-row-trigger"
                      onClick={() => openDetailDrawer(inst)}
                    >
                      <span className="ca-row-title">
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
                            <span>{t(`来自 ${ownerLabel}`, `From ${ownerLabel}`)}</span>
                          </span>
                        )}
                        {inst.visibilityScope && (
                          <span className="ca-pill ca-pill-muted">{scopeLabel(inst.visibilityScope, t)}</span>
                        )}
                      </span>
                      <span className="ca-row-sub">
                        {inst.source.type === 'inline'
                          ? t('在线 Markdown 技能', 'Inline Markdown skill')
                          : `${inst.packageId} · v${inst.targetVersion}`}
                      </span>
                    </button>
                    <div className="ca-row-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openDetailDrawer(inst)}
                      >
                        <FileCode2 size={13} />
                        <span>{t('编辑', 'Edit')}</span>
                      </button>
                      <CaSwitch
                        checked={inst.enabled}
                        disabled={togglingId === inst.installationId}
                        label={t(`启用 ${inst.displayName}`, `Enable ${inst.displayName}`)}
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
            <h3 className="ca-section-title">{t('MCP 服务与插件', 'MCP servers & plugins')}</h3>
            <span className="ca-muted ca-num">{t(`${toolItems.length} 项`, `${toolItems.length} items`)}</span>
          </div>

          <div className="ca-list">
            {toolItems.length === 0 ? (
              <div className="ca-empty">{t('尚未安装 MCP 服务或插件，点击右上角「安装扩展」', 'No MCP servers or plugins installed. Click "Install extension" above.')}</div>
            ) : (
              toolItems.map(inst => {
                const badge = activationLabel(inst, t);
                return (
                  <div key={inst.installationId} className="ca-row ca-row-split">
                    <button
                      type="button"
                      className="ca-row-main ca-row-trigger"
                      onClick={() => openDetailDrawer(inst)}
                    >
                      <span className="ca-row-title">
                        <span>{inst.displayName}</span>
                        <span className="ca-pill ca-pill-muted">{inst.kind === 'mcp' ? 'MCP' : t('插件', 'Plugin')}</span>
                        <span className="ca-pill ca-pill-muted">
                          {inst.target === 'center' ? t('中心托管', 'Center-hosted') : t('设备运行', 'On-device')}
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
                      </span>
                      <span className="ca-row-sub">
                        {inst.packageId} · v{inst.targetVersion}
                        {inst.activation?.error?.message ? ` · ${inst.activation.error.message}` : ''}
                      </span>
                    </button>
                    <div className="ca-row-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openDetailDrawer(inst)}
                      >
                        <Wrench size={13} />
                        <span>{t('配置', 'Configure')}</span>
                      </button>
                      <CaSwitch
                        checked={inst.enabled}
                        disabled={togglingId === inst.installationId}
                        label={t(`启用 ${inst.displayName}`, `Enable ${inst.displayName}`)}
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
        title={t('新建技能', 'New skill')}
        description={t('支持多文件 Markdown 与脚本目录，创建后默认立即可用', 'Supports multi-file Markdown and scripts; enabled immediately on creation')}
        variant="drawer"
        wide
      >
        <form className="ca-form-stack" onSubmit={e => void handleCreateInlineSkill(e)}>
          {createSkillError && <CaNotice tone="danger">{createSkillError}</CaNotice>}
          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label">
                {t('技能名称', 'Skill name')} <span className="ca-req">*</span>
              </label>
              <input
                type="text"
                className="ca-input"
                required
                placeholder={t('例如：代码审查规范 / 日报整理', 'e.g. Code review checklist / Daily report')}
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
              />
            </div>
            <div className="ca-field">
              <label className="ca-field-label">{t('可见范围', 'Visibility')}</label>
              <select
                className="ca-select"
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
              placeholder={t('新增附属文件路径（如 scripts/run.py 或 references/guide.md）', 'Add file path (e.g. scripts/run.py or references/guide.md)')}
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
              {t('新增文件', 'Add file')}
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
                {t('删除当前文件', 'Delete file')}
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
              {t('取消', 'Cancel')}
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={createSkillBusy}>
              {createSkillBusy ? t('创建中…', 'Creating…') : t('创建并启用', 'Create & enable')}
            </button>
          </div>
        </form>
      </CaModal>

      {/* 导入技能包 / 安装 MCP & 插件弹窗 */}
      <CaModal
        open={importOpen}
        onOpenChange={setImportOpen}
        title={importKind === 'skill' ? t('导入技能包', 'Import skill package') : t('安装工具扩展', 'Install extension')}
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
                    <span>{t('在浏览器打开', 'Open in browser')}</span>
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
                <label className="ca-field-label">{t('扩展类型', 'Extension type')}</label>
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
                  <option value="mcp">{t('MCP 服务', 'MCP server')}</option>
                  <option value="plugin">{t('原生插件', 'Native plugin')}</option>
                </select>
              </div>
              <div className="ca-field">
                <label className="ca-field-label">{t('运行位置', 'Runtime target')}</label>
                <select
                  className="ca-select"
                  value={importTarget}
                  onChange={e => setImportTarget(e.target.value as 'center' | 'host')}
                >
                  {importKind === 'mcp' && <option value="center">{t('中心托管', 'Center-hosted')}</option>}
                  <option value="host">{t('设备 Host', 'Device Host')}</option>
                </select>
              </div>
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label">
              {t('显示名称', 'Display name')} <span className="ca-req">*</span>
            </label>
            <input
              type="text"
              className="ca-input"
              required
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
              <label className="ca-field-label">{t('选择包文件 (.zip / .tar.gz / .tgz)', 'Select package archive (.zip / .tar.gz / .tgz)')}</label>
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
              <label className="ca-field-label">{t('npm 包标识', 'npm package spec')}</label>
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
              <label className="ca-field-label">{t('URL 地址', 'URL')}</label>
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
            <span>{t('安装后立即全局启用', 'Enable globally right after install')}</span>
          </label>

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setImportOpen(false)}>
              {t('取消', 'Cancel')}
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={importBusy}>
              {importBusy ? t('安装中…', 'Installing…') : t('开始安装', 'Install')}
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
        title={detailInst?.displayName || t('扩展配置', 'Extension settings')}
        description={
          detailInst
            ? `${detailInst.kind === 'skill' ? t('技能', 'Skill') : detailInst.kind === 'mcp' ? t('MCP 服务', 'MCP server') : t('原生插件', 'Native plugin')} · ${
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
            <div className="ca-section ca-section-pad">
              <div className="ca-inline-between">
                <div>
                  <div className="ca-field-label">{t('全局启用状态', 'Global status')}</div>
                  <div className="ca-muted">
                    {activationLabel(detailInst, t).text}
                    {operation ? t(` · 任务进度：${operation.phase}`, ` · Task: ${operation.phase}`) : ''}
                    {detailInst.activation?.error?.message
                      ? ` · ${detailInst.activation.error.message}`
                      : ''}
                  </div>
                </div>
                <CaSwitch
                  checked={detailInst.enabled}
                  disabled={detailBusy}
                  label={t(`启用 ${detailInst.displayName}`, `Enable ${detailInst.displayName}`)}
                  onChange={next => (next ? void handleEnableInDrawer() : void handleDisableInDrawer())}
                />
              </div>
            </div>

            {/* OAuth MCP 一键解锁与授权（消除 OAuth 死锁） */}
            {(needsOAuth || detailInst.activation?.error?.code?.includes('OAUTH') || detailError.includes('OAuth')) && (
              <div className="ca-section ca-section-pad">
                <div className="ca-field-label ca-mb-2">
                  {t('OAuth 身份授权（选择任意可用 Bot 完成授权即可启用）', 'OAuth authorization (choose any available Bot to authorize and enable)')}
                </div>
                <div className="ca-inline-row ca-wrap">
                  <select
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
                    onClick={() => void handleEnableInDrawer()}
                  >
                    {t('带此身份重试启用', 'Retry enable with Bot')}
                  </button>
                </div>
                {oauthFlow && (
                  <div className="ca-form-stack ca-oauth-status-box">
                    <CaExternalUrlBox
                      url={oauthFlow.authorizationUrl}
                      onOpenUrl={onOpenExternalUrl}
                      onError={err =>
                        setDetailError(
                          errorMessage(err, t('无法打开系统默认浏览器，请复制链接手动打开', 'Could not open browser; please copy and open the link manually')),
                        )
                      }
                      copyLabel={t('复制链接', 'Copy link')}
                    />
                    <span className="ca-muted">
                      {t('当前状态：', 'Status: ')}
                      {oauthStatus || t('等待授权…', 'Waiting for authorization…')}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* 名称与可见范围设置 */}
            <div className="ca-section ca-section-pad">
              <div className={detailInst.kind === 'skill' ? 'ca-grid-2' : 'ca-field'}>
                <div className="ca-field">
                  <label className="ca-field-label">{t('显示名称', 'Display name')}</label>
                  <input
                    type="text"
                    className="ca-input"
                    value={detailNameDraft}
                    onChange={e => setDetailNameDraft(e.target.value)}
                  />
                </div>
                {detailInst.kind === 'skill' && (
                  <div className="ca-field">
                    <label className="ca-field-label">{t('可用范围', 'Visibility')}</label>
                    <select
                      className="ca-select"
                      value={detailScopeDraft}
                      onChange={e => setDetailScopeDraft(e.target.value as SkillVisibilityScope)}
                    >
                      {detailInst.ownerBot && <option value="private">{t('仅源 Bot 私有', 'Source Bot only')}</option>}
                      <option value="assigned">{t('仅指定 Bot 共享', 'Assigned Bots only')}</option>
                      <option value="global">{t('全局默认可用', 'Global default')}</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="ca-inline-end ca-mt-3">
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={detailBusy}
                  onClick={() => void handleSaveDetailMeta()}
                >
                  {t('保存基础信息', 'Save info')}
                </button>
              </div>
            </div>

            {/* Skill 多文件在线编辑器 */}
            {detailInst.kind === 'skill' && skillFilesRes && (
              <div className="ca-section ca-section-pad">
                <div className="ca-inline-between ca-wrap ca-mb-2">
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
                    {t('当前技能来自只读安装包；如需在线修改文件内容，可点击上方「转为可编辑副本」。', 'This skill comes from a read-only package. Click "Clone to editable copy" above to edit files inline.')}
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
                  <div className="ca-inline-row ca-mb-2 ca-skill-subfile-row">
                    <input
                      type="text"
                      className="ca-input ca-mono"
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
                      {t('新增', 'Add')}
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
                  value={skillFilesDraft[activeSkillPath] ?? ''}
                  onChange={e => {
                    const v = e.target.value;
                    setSkillFilesDraft(prev => ({ ...prev, [activeSkillPath]: v }));
                  }}
                />

                {skillFilesRes.editable && (
                  <div className="ca-inline-end ca-mt-2">
                    <button
                      type="button"
                      className="ca-btn ca-btn-primary ca-btn-sm"
                      disabled={detailBusy}
                      onClick={() => void handleSaveSkillFiles()}
                    >
                      {t('保存技能文件', 'Save skill files')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* MCP / Plugin 全局参数配置 */}
            {detailInst.kind !== 'skill' && detailConfig && (
              <div className="ca-section ca-section-pad">
                <div className="ca-field-label ca-mb-2">
                  {t('全局默认参数', 'Global default settings')}
                </div>
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
              </div>
            )}

            {/* 跨设备树形多选框直接勾选分配 Bot */}
            <div className="ca-section ca-section-pad">
              <div className="ca-field-label ca-mb-2">
                {t('跨设备 Bot 授权分配', 'Cross-device Bot access')}
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
                            {t('独立参数', 'Overrides')}
                          </button>
                        ) : null
                    : undefined
                }
              />
            </div>

            {/* MCP / Plugin 连接与工具列表检查 */}
            {detailInst.kind !== 'skill' && (
              <div className="ca-section ca-section-pad">
                <div className="ca-inline-between ca-wrap">
                  <div>
                    <div className="ca-field-label">{t('连接与工具列表', 'Connection & tools')}</div>
                    <div className="ca-muted">{t('自动选用在线设备的 Bot 验证连接并读取工具定义', 'Automatically uses an online Bot to verify connectivity and inspect tools')}</div>
                  </div>
                  <div className="ca-inline-row ca-probe-actions">
                    {activeBots.length > 1 && (
                      <select
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
                      {probeBusy ? t('探测中…', 'Probing…') : t('检查连接与工具列表', 'Check connection & tools')}
                    </button>
                  </div>
                </div>
                {probeResult && (
                  <div className="ca-muted ca-mt-2">
                    {probeResult}
                  </div>
                )}
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
            )}

            {/* 更新、部署回执与卸载折叠区 */}
            <CaDisclosure title={t('更新、部署状态与卸载', 'Updates, deployment & uninstall')}>
              <div className="ca-form-stack">
                {deployments.length > 0 && (
                  <div className="ca-cred-box">
                    <div className="ca-field-label ca-mb-1">
                      {t('各节点同步状态', 'Node sync status')}
                    </div>
                    {deployments.map((d, idx) => (
                      <div key={idx} className="ca-muted ca-num">
                        {d.deviceId ?? t('中心节点', 'Center node')} · {d.phase} · {d.health}
                        {d.error ? t(`（${d.error.message}）`, ` (${d.error.message})`) : ''}
                      </div>
                    ))}
                  </div>
                )}

                {detailInst.source.type !== 'inline' && (
                  <div className="ca-inline-between ca-wrap">
                    <span className="ca-muted">{t(`当前版本：v${detailInst.targetVersion}`, `Current version: v${detailInst.targetVersion}`)}</span>
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      disabled={detailBusy}
                      onClick={() => void handleCheckUpdates()}
                    >
                      <RefreshCw size={13} />
                      <span>{t('检查更新', 'Check updates')}</span>
                    </button>
                  </div>
                )}

                {updates && updates.length > 0 && (
                  <div className="ca-inline-row ca-wrap">
                    {updates.map(v => (
                      <button
                        key={v.version}
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => void handleApplyUpdate(v.version)}
                      >
                        {t(`更新到 v${v.version}`, `Update to v${v.version}`)}
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
                    <span>{detailInst.kind === 'skill' ? t('卸载技能', 'Uninstall skill') : t('卸载扩展', 'Uninstall extension')}</span>
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
        title={t(`独立参数覆盖 · ${overrideBot?.name ?? ''}`, `Override settings · ${overrideBot?.name ?? ''}`)}
        description={t('未勾选覆盖的字段自动继承全局配置', 'Unchecked fields automatically inherit global settings')}
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
            submitLabel={t('保存覆盖参数', 'Save overrides')}
            submitBusy={overrideSaving}
            onSubmit={() => void handleSaveBotOverride()}
          />
        )}
      </CaModal>
    </div>
  );
}
