// 单 Bot 完整技能闭环页：空闲自动提炼总开关 + 立即复盘 + 新建技能（含 YAML frontmatter 自动补齐）
// + 聚合技能列表（支持自动全局启用）+ 内置多文件编辑器（只读包一键转为可编辑副本）+ 可用范围切换。
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Copy, Edit3, Lock, Pin, Plus, RefreshCw, Sparkles, Trash2, Unlock } from 'lucide-react';
import type {
  BotLearningSettings,
  BotLearningStatus,
  Installation,
  InstallationSkillFilesResponse,
  JsonObject,
  SkillVisibilityScope,
} from '../../../center-contract/index.js';
import type { CenterBotCapabilityEntry } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ConfirmDialog } from '../components/ui/dialog';
import { ErrorNotice, errorText, useText } from '../ui';
import { centerAdminRequest, isCenterAuthOrBindError, newRequestId, pollCenterOperation } from './centerAdminBroker';
import {
  Badge,
  Chips,
  Disclosure,
  EmptyState,
  LoadingState,
  Row,
  SearchField,
  Segmented,
  Switch,
  useSettingsSheetBack,
} from './primitives';
import './bot-skills.css';

export interface BotSkillsPageProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  botName?: string;
}

interface LearnedSkillItem {
  skillId: string;
  name: string;
  path?: string;
  category?: string;
  description: string | null;
  revision?: number;
  state: 'active' | 'stale' | 'archived' | string;
  pinned: boolean;
  locked: boolean;
  installationId?: string | null;
  visibilityScope?: SkillVisibilityScope;
  lastActivityAt?: string;
  source?: { mode?: string; createdAt?: string } | null;
}

interface UnifiedSkill {
  key: string;
  name: string;
  description: string;
  installationId?: string;
  capability?: CenterBotCapabilityEntry;
  learned?: LearnedSkillItem;
  visibilityScope: SkillVisibilityScope;
  isOwnedByThisBot: boolean;
  isArchived: boolean;
  botEnabled: boolean;
}

type SkillFilter = 'all' | 'enabled' | 'learned' | 'archived';

interface ExtraDraftFile {
  path: string;
  content: string;
}

interface ActiveEditorTarget {
  key: string;
  name: string;
  installation?: Installation;
  learned?: LearnedSkillItem;
  editable: boolean;
  files: Record<string, string>;
  originalFiles: Record<string, string>;
}

type ConfirmAction =
  | { kind: 'archive-switch'; skill: UnifiedSkill }
  | { kind: 'archive-detail'; name: string }
  | { kind: 'delete-file'; filePath: string }
  | { kind: 'discard-create' }
  | { kind: 'discard-detail'; exitToList: boolean };

function hasFileChanges(files: Record<string, string>, originalFiles: Record<string, string>): boolean {
  const keys = Object.keys(files);
  const origKeys = Object.keys(originalFiles);
  if (keys.length !== origKeys.length) return true;
  return keys.some(k => !Object.prototype.hasOwnProperty.call(originalFiles, k) || files[k] !== originalFiles[k]);
}

const ALLOWED_SUBDIRS = ['references/', 'scripts/', 'templates/', 'assets/'] as const;

function extractFrontmatterDescription(markdown: string | undefined): string {
  if (!markdown) return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown.trimStart());
  if (!match) return '';
  const descMatch = /^description:\s*(.+)$/m.exec(match[1]);
  if (!descMatch) return '';
  return descMatch[1].trim().replace(/^["']|["']$/g, '');
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.trim());
}

function ensureSkillMarkdown(name: string, description: string, rawBody: string): string {
  const cleanName = name.trim() || 'custom-skill';
  const cleanDesc = description.trim().slice(0, 1024) || cleanName;
  const trimmed = rawBody.trimStart();
  const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(trimmed);
  if (hasFrontmatter) {
    const endMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(trimmed);
    const fm = endMatch?.[1] ?? '';
    const rest = endMatch?.[2]?.trim() ?? '';
    const hasName = /^name:/m.test(fm);
    const hasDesc = /^description:/m.test(fm);
    const updatedFm = [
      fm.trimEnd(),
      ...(hasName ? [] : [`name: ${yamlScalar(cleanName)}`]),
      ...(hasDesc ? [] : [`description: ${yamlScalar(cleanDesc)}`]),
    ].filter(Boolean).join('\n');
    const finalBody = rest || `# ${cleanName}\n\n${cleanDesc}`;
    return `---\n${updatedFm}\n---\n\n${finalBody}\n`;
  }
  const body = rawBody.trim() || `# ${cleanName}\n\n${cleanDesc}`;
  return `---\nname: ${yamlScalar(cleanName)}\ndescription: ${yamlScalar(cleanDesc)}\n---\n\n${body}\n`;
}

function normalizeExtraFilePath(prefix: string, rawName: string): string {
  const trimmed = rawName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed) return '';
  for (const dir of ALLOWED_SUBDIRS) {
    if (trimmed.startsWith(dir)) return trimmed;
  }
  return `${prefix}${trimmed}`;
}

export function BotSkillsPage({
  api,
  identity,
  deviceId,
  botId,
  botName,
}: BotSkillsPageProps) {
  const t = useText();
  const advIdPrefix = useId();
  const aliveRef = useRef(true);
  const lastActiveSkillEveryRef = useRef(10);

  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authIssue, setAuthIssue] = useState<'none' | 'oauth' | 'offline'>('none');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const [capabilities, setCapabilities] = useState<CenterBotCapabilityEntry[]>([]);
  const [learnedItems, setLearnedItems] = useState<LearnedSkillItem[]>([]);
  const [learning, setLearning] = useState<BotLearningStatus | null>(null);
  const [learningDraft, setLearningDraft] = useState<BotLearningSettings | null>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');

  // 新建技能表单
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newExtraFiles, setNewExtraFiles] = useState<ExtraDraftFile[]>([]);
  const [extraPrefix, setExtraPrefix] = useState<(typeof ALLOWED_SUBDIRS)[number]>('references/');
  const [extraFileName, setExtraFileName] = useState('');

  // 技能详情与多文件编辑器
  const [detailTarget, setDetailTarget] = useState<ActiveEditorTarget | null>(null);
  const [selectedFile, setSelectedFile] = useState('SKILL.md');
  const [editingFiles, setEditingFiles] = useState(false);
  const [editPrefix, setEditPrefix] = useState<(typeof ALLOWED_SUBDIRS)[number]>('references/');
  const [editNewFileName, setEditNewFileName] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  const botBasePath = `/api/devices/${encodeURIComponent(deviceId)}/bots/${encodeURIComponent(botId)}`;

  const handleFailure = useCallback((failure: unknown) => {
    const auth = isCenterAuthOrBindError(failure);
    if (auth.oauthRevoked || auth.unauthorized) {
      setAuthIssue('oauth');
      setError('');
      return;
    }
    if (auth.notConnected) {
      setAuthIssue('offline');
      setError('');
      return;
    }
    setError(errorText(failure));
  }, []);

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [capsRes, reviewsRes, learningRes] = await Promise.all([
        api.broker(identity, 'center_bot_capabilities_get', { deviceId, botId }),
        centerAdminRequest<{ items?: LearnedSkillItem[] }>(api, identity, {
          method: 'POST',
          path: `${botBasePath}/skill-reviews`,
          body: { action: 'list', includeArchived: true },
        }).catch(() => ({ items: [] as LearnedSkillItem[] })),
        centerAdminRequest<BotLearningStatus>(api, identity, {
          method: 'POST',
          path: `${botBasePath}/learning`,
          body: { action: 'status' },
        }).catch(() => null),
      ]);
      if (!aliveRef.current) return;
      setAuthIssue('none');
      setCapabilities((capsRes ?? []).filter(entry => entry.installation.kind === 'skill'));
      setLearnedItems(Array.isArray(reviewsRes?.items) ? reviewsRes.items : []);
      if (learningRes) {
        setLearning(learningRes);
        setLearningDraft(learningRes.settings);
        if (learningRes.settings.review.skillEvery < 1000) {
          lastActiveSkillEveryRef.current = learningRes.settings.review.skillEvery;
        }
      }
    } catch (failure) {
      if (!aliveRef.current) return;
      handleFailure(failure);
    } finally {
      if (aliveRef.current && !silent) setLoading(false);
    }
  }, [api, identity, deviceId, botId, botBasePath, handleFailure]);

  useEffect(() => {
    aliveRef.current = true;
    void loadAll(false);
    return () => {
      aliveRef.current = false;
    };
  }, [loadAll]);

  // 复盘任务运行中自动轮询状态
  const activeJobStatus = learning?.activeJob?.status;
  useEffect(() => {
    if (activeJobStatus !== 'queued' && activeJobStatus !== 'running') return;
    const timer = setInterval(() => {
      void loadAll(true);
    }, 2500);
    return () => clearInterval(timer);
  }, [activeJobStatus, loadAll]);

  const unifiedSkills = useMemo<UnifiedSkill[]>(() => {
    const learnedByInstId = new Map<string, LearnedSkillItem>();
    for (const item of learnedItems) {
      if (item.installationId) learnedByInstId.set(item.installationId, item);
    }

    const usedLearnedIds = new Set<string>();
    const list: UnifiedSkill[] = [];

    for (const cap of capabilities) {
      const inst = cap.installation;
      const ownedByBot = Boolean(inst.ownerBot && inst.ownerBot.deviceId === deviceId && inst.ownerBot.botId === botId);
      const matchedLearned =
        learnedByInstId.get(inst.installationId)
        ?? (ownedByBot && inst.ownerBot?.skillId
          ? learnedItems.find(item => item.skillId === inst.ownerBot?.skillId)
          : undefined);
      if (matchedLearned) usedLearnedIds.add(matchedLearned.skillId);

      const isArchived = matchedLearned?.state === 'archived';
      const botEnabled =
        !isArchived
        && Boolean(cap.config?.enabled)
        && Boolean(inst.enabled)
        && inst.activation?.status === 'enabled';

      list.push({
        key: `inst:${inst.installationId}`,
        name: inst.displayName || matchedLearned?.name || inst.packageId,
        description: matchedLearned?.description ?? '',
        installationId: inst.installationId,
        capability: cap,
        learned: matchedLearned,
        visibilityScope: inst.visibilityScope ?? matchedLearned?.visibilityScope ?? 'global',
        isOwnedByThisBot: ownedByBot || Boolean(matchedLearned),
        isArchived,
        botEnabled,
      });
    }

    for (const item of learnedItems) {
      if (usedLearnedIds.has(item.skillId)) continue;
      list.push({
        key: `learned:${item.skillId}`,
        name: item.name,
        description: item.description ?? '',
        installationId: item.installationId ?? undefined,
        learned: item,
        visibilityScope: item.visibilityScope ?? 'private',
        isOwnedByThisBot: true,
        isArchived: item.state === 'archived',
        botEnabled: item.state !== 'archived',
      });
    }

    return list;
  }, [capabilities, learnedItems, deviceId, botId]);

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unifiedSkills.filter(skill => {
      if (filter === 'archived') {
        if (!skill.isArchived) return false;
      } else {
        if (skill.isArchived) return false;
        if (filter === 'enabled' && !skill.botEnabled) return false;
        if (filter === 'learned' && !skill.learned) return false;
      }
      if (!q) return true;
      return (
        skill.name.toLowerCase().includes(q)
        || skill.description.toLowerCase().includes(q)
        || (skill.learned?.category?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [unifiedSkills, filter, query]);

  const archivedCount = useMemo(
    () => unifiedSkills.filter(s => s.isArchived).length,
    [unifiedSkills],
  );

  // 保存学习策略（严格只传 allowlist 字段，绝不传 enabled）
  const saveLearningConfig = useCallback(async (
    nextSettings: BotLearningSettings,
    successText: string,
  ) => {
    if (!learning) return;
    setBusyKey('learning');
    setError('');
    try {
      const response = await centerAdminRequest<{ settings: BotLearningSettings }>(api, identity, {
        method: 'POST',
        path: `${botBasePath}/learning`,
        body: {
          action: 'configure',
          expectedRevision: nextSettings.revision,
          config: {
            review: nextSettings.review,
            curator: nextSettings.curator,
            budget: nextSettings.budget,
            reviewModelRef: nextSettings.reviewModelRef,
            curatorModelRef: nextSettings.curatorModelRef,
          },
        },
      });
      if (!aliveRef.current) return;
      const updatedSettings = response?.settings ?? nextSettings;
      setLearning(prev => prev ? { ...prev, settings: updatedSettings } : prev);
      setLearningDraft(updatedSettings);
      if (updatedSettings.review.skillEvery < 1000) {
        lastActiveSkillEveryRef.current = updatedSettings.review.skillEvery;
      }
      setNotice(successText);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  }, [api, identity, botBasePath, learning, handleFailure]);

  const toggleAutoExtract = async (enabled: boolean) => {
    if (!learning) return;
    const current = learning.settings;
    if (current.review.skillEvery < 1000) {
      lastActiveSkillEveryRef.current = current.review.skillEvery;
    }
    const nextSkillEvery = enabled ? (lastActiveSkillEveryRef.current || 10) : 10000;
    await saveLearningConfig(
      {
        ...current,
        review: { ...current.review, skillEvery: nextSkillEvery },
      },
      enabled ? t('已开启空闲时自动提炼技能', 'Auto skill extraction enabled') : t('已暂停自动提炼技能', 'Auto skill extraction paused'),
    );
  };

  const triggerReview = async () => {
    setBusyKey('review');
    setError('');
    try {
      await centerAdminRequest(api, identity, {
        method: 'POST',
        path: `${botBasePath}/learning`,
        body: { action: 'review' },
      });
      if (!aliveRef.current) return;
      setNotice(t('已触发技能复盘与提炼', 'Skill review started'));
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const cancelActiveJob = async () => {
    const jobId = learning?.activeJob?.jobId;
    if (!jobId) return;
    setBusyKey('review');
    setError('');
    try {
      await centerAdminRequest(api, identity, {
        method: 'POST',
        path: `${botBasePath}/learning`,
        body: { action: 'cancel', jobId },
      });
      if (!aliveRef.current) return;
      setNotice(t('已取消当前复盘任务', 'Review job cancelled'));
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const createInlineInstallation = async (
    displayName: string,
    files: Record<string, string>,
  ): Promise<string> => {
    const baseBody = {
      requestId: newRequestId(),
      displayName: displayName.trim(),
      kind: 'skill',
      target: 'host',
      autoEnable: true,
      source: { type: 'inline', files },
    };

    let accepted: { operationId: string };
    try {
      accepted = await centerAdminRequest<{ operationId: string }>(api, identity, {
        method: 'POST',
        path: '/api/installations',
        body: { ...baseBody, visibilityScope: 'assigned' },
      });
    } catch (failure) {
      const msg = errorText(failure);
      if (/visibilityScope|ownerBot/i.test(msg)) {
        accepted = await centerAdminRequest<{ operationId: string }>(api, identity, {
          method: 'POST',
          path: '/api/installations',
          body: { ...baseBody, requestId: newRequestId() },
        });
      } else {
        throw failure;
      }
    }

    const op = await pollCenterOperation(api, identity, accepted.operationId, { t });
    if (!op.installationId) {
      throw new Error(t('技能已创建但未返回安装标识，请刷新列表', 'Skill created without installationId; please refresh'));
    }
    return op.installationId;
  };

  const bindInstallationToBot = async (installationId: string, enabled: boolean, overrides: JsonObject = {}) => {
    let expectedRevision = 0;
    try {
      const binding = await centerAdminRequest<{ revision?: number }>(api, identity, {
        method: 'GET',
        path: `${botBasePath}/capabilities/${encodeURIComponent(installationId)}`,
      });
      if (typeof binding?.revision === 'number') expectedRevision = binding.revision;
    } catch {
      expectedRevision = 0;
    }
    await api.broker(identity, 'center_bot_capability_set', {
      deviceId,
      botId,
      installationId,
      expectedRevision,
      enabled,
      overrides,
    });
  };

  const toggleSkillForBot = async (skill: UnifiedSkill, nextEnabled: boolean) => {
    setBusyKey(skill.key);
    setError('');
    try {
      if (nextEnabled && skill.learned && skill.isArchived) {
        await centerAdminRequest(api, identity, {
          method: 'POST',
          path: `${botBasePath}/skill-reviews`,
          body: { action: 'restore', skillId: skill.learned.skillId, requestId: newRequestId() },
        });
      }

      if (skill.capability && skill.installationId) {
        const inst = skill.capability.installation;
        if (nextEnabled && (!inst.enabled || inst.activation?.status !== 'enabled')) {
          const op = await centerAdminRequest<{ operationId?: string }>(api, identity, {
            method: 'POST',
            path: `/api/installations/${encodeURIComponent(skill.installationId)}/enable`,
            body: { requestId: newRequestId() },
          });
          if (op?.operationId) {
            await pollCenterOperation(api, identity, op.operationId, { t });
          }
        }
        await api.broker(identity, 'center_bot_capability_set', {
          deviceId,
          botId,
          installationId: skill.installationId,
          expectedRevision: skill.capability.config?.revision ?? 0,
          enabled: nextEnabled,
          overrides: skill.capability.config?.overrides ?? {},
        });
      } else if (skill.learned && !nextEnabled) {
        await archiveLearnedSkill(skill.learned, skill.installationId);
      }

      if (!aliveRef.current) return;
      setNotice(nextEnabled ? t(`已启用「${skill.name}」`, `Enabled "${skill.name}"`) : t(`已停用「${skill.name}」`, `Disabled "${skill.name}"`));
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const archiveLearnedSkill = async (learned: LearnedSkillItem, installationId?: string) => {
    try {
      await centerAdminRequest(api, identity, {
        method: 'POST',
        path: `${botBasePath}/skill-reviews`,
        body: {
          action: 'archive',
          skillId: learned.skillId,
          requestId: newRequestId(),
          forceUnshare: true,
        },
      });
    } catch (failure) {
      const msg = errorText(failure);
      if (installationId && /shared|INVALID_STATE|visibility/i.test(msg)) {
        const latestInst = await centerAdminRequest<Installation>(api, identity, {
          method: 'GET',
          path: `/api/installations/${encodeURIComponent(installationId)}`,
        });
        await centerAdminRequest(api, identity, {
          method: 'PATCH',
          path: `/api/installations/${encodeURIComponent(installationId)}`,
          body: { expectedRevision: latestInst.revision, visibilityScope: 'private' },
        });
        await centerAdminRequest(api, identity, {
          method: 'POST',
          path: `${botBasePath}/skill-reviews`,
          body: {
            action: 'archive',
            skillId: learned.skillId,
            requestId: newRequestId(),
            forceUnshare: true,
          },
        });
        return;
      }
      throw failure;
    }
  };

  const openSkillDetail = async (skill: UnifiedSkill) => {
    setDetailLoading(true);
    setEditingFiles(false);
    setError('');
    try {
      if (skill.installationId) {
        const filesRes = await centerAdminRequest<InstallationSkillFilesResponse>(api, identity, {
          method: 'GET',
          path: `/api/installations/${encodeURIComponent(skill.installationId)}/skill-files`,
        });
        if (!aliveRef.current) return;
        const files = filesRes.files ?? {};
        const firstFile = files['SKILL.md'] !== undefined ? 'SKILL.md' : (Object.keys(files)[0] ?? 'SKILL.md');
        setSelectedFile(firstFile);
        setDetailTarget({
          key: skill.key,
          name: skill.name,
          installation: skill.capability?.installation,
          learned: skill.learned,
          editable: filesRes.editable !== false,
          files: { ...files },
          originalFiles: { ...files },
        });
      } else if (skill.learned) {
        const detailRes = await centerAdminRequest<{ files?: Record<string, string> }>(api, identity, {
          method: 'POST',
          path: `${botBasePath}/skill-reviews`,
          body: { action: 'read', skillId: skill.learned.skillId },
        });
        if (!aliveRef.current) return;
        const files = detailRes.files ?? {};
        const firstFile = files['SKILL.md'] !== undefined ? 'SKILL.md' : (Object.keys(files)[0] ?? 'SKILL.md');
        setSelectedFile(firstFile);
        setDetailTarget({
          key: skill.key,
          name: skill.name,
          learned: skill.learned,
          editable: true,
          files: { ...files },
          originalFiles: { ...files },
        });
      }
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setDetailLoading(false);
    }
  };

  const handleCreateSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = newName.trim();
    const cleanDesc = newDesc.trim();
    if (!cleanName) {
      setError(t('请填写技能名称', 'Please enter a skill name'));
      return;
    }
    if (!cleanDesc && !/^---\r?\n[\s\S]*?description:/m.test(newBody)) {
      setError(t('请填写一句话触发描述', 'Please enter a trigger description'));
      return;
    }

    setBusyKey('create');
    setError('');
    try {
      const files: Record<string, string> = {
        'SKILL.md': ensureSkillMarkdown(cleanName, cleanDesc, newBody),
      };
      for (const extra of newExtraFiles) {
        const path = extra.path.trim();
        if (path && path !== 'SKILL.md') files[path] = extra.content;
      }
      const installationId = await createInlineInstallation(cleanName, files);
      await bindInstallationToBot(installationId, true);
      if (!aliveRef.current) return;
      setCreating(false);
      setNewName('');
      setNewDesc('');
      setNewBody('');
      setNewExtraFiles([]);
      setNotice(t(`已创建并启用技能「${cleanName}」`, `Created and enabled "${cleanName}"`));
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const saveSkillFiles = async () => {
    if (!detailTarget) return;
    setBusyKey('save-files');
    setError('');
    try {
      if (detailTarget.installation) {
        const patch: Record<string, string | null> = { ...detailTarget.files };
        for (const oldPath of Object.keys(detailTarget.originalFiles)) {
          if (!(oldPath in detailTarget.files)) {
            patch[oldPath] = null;
          }
        }
        const updated = await centerAdminRequest<InstallationSkillFilesResponse>(api, identity, {
          method: 'PUT',
          path: `/api/installations/${encodeURIComponent(detailTarget.installation.installationId)}/skill-files`,
          body: { files: patch, requestId: newRequestId() },
        });
        if (!aliveRef.current) return;
        const nextFiles = updated?.files ?? detailTarget.files;
        setDetailTarget(prev => prev ? {
          ...prev,
          files: { ...nextFiles },
          originalFiles: { ...nextFiles },
        } : null);
      } else if (detailTarget.learned) {
        await centerAdminRequest(api, identity, {
          method: 'POST',
          path: `${botBasePath}/skills`,
          body: {
            action: 'update',
            skillId: detailTarget.learned.skillId,
            files: detailTarget.files,
            requestId: newRequestId(),
          },
        });
        if (!aliveRef.current) return;
        setDetailTarget(prev => prev ? {
          ...prev,
          originalFiles: { ...detailTarget.files },
        } : null);
      }
      setEditingFiles(false);
      setNotice(t('技能内容已保存', 'Skill files saved'));
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const convertToEditableCopy = async () => {
    if (!detailTarget?.installation) return;
    setBusyKey('convert-copy');
    setError('');
    try {
      const copyName = `${detailTarget.name} (${t('可编辑副本', 'Editable copy')})`;
      const descFromSkill = extractFrontmatterDescription(detailTarget.files['SKILL.md']) || detailTarget.name;
      const filesToCopy: Record<string, string> = {
        ...detailTarget.files,
        'SKILL.md': ensureSkillMarkdown(copyName, descFromSkill, detailTarget.files['SKILL.md'] ?? ''),
      };
      const newInstallationId = await createInlineInstallation(copyName, filesToCopy);
      await bindInstallationToBot(newInstallationId, true);
      // 自动停用旧只读包，避免同技能重复生效
      await bindInstallationToBot(detailTarget.installation.installationId, false);
      if (!aliveRef.current) return;

      const freshFiles = await centerAdminRequest<InstallationSkillFilesResponse>(api, identity, {
        method: 'GET',
        path: `/api/installations/${encodeURIComponent(newInstallationId)}/skill-files`,
      });
      await loadAll(true);
      if (!aliveRef.current) return;
      const loadedFiles = freshFiles.files ?? filesToCopy;
      setSelectedFile('SKILL.md');
      setDetailTarget({
        key: `inst:${newInstallationId}`,
        name: copyName,
        editable: true,
        files: { ...loadedFiles },
        originalFiles: { ...loadedFiles },
        installation: {
          ...detailTarget.installation,
          installationId: newInstallationId,
          displayName: copyName,
          revision: 0,
        },
      });
      setEditingFiles(true);
      setNotice(t('已创建可编辑副本并绑定当前 Bot', 'Editable copy created and bound to this Bot'));
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const changeVisibilityScope = async (nextScope: SkillVisibilityScope) => {
    if (!detailTarget?.installation) return;
    setBusyKey('scope');
    setError('');
    try {
      const updated = await centerAdminRequest<Installation>(api, identity, {
        method: 'PATCH',
        path: `/api/installations/${encodeURIComponent(detailTarget.installation.installationId)}`,
        body: { expectedRevision: detailTarget.installation.revision, visibilityScope: nextScope },
      });
      if (!aliveRef.current) return;
      setDetailTarget(prev => prev ? { ...prev, installation: updated } : null);
      setNotice(t('可用范围已更新', 'Visibility scope updated'));
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const runLearnedAction = async (action: 'pin' | 'lock' | 'archive' | 'restore') => {
    const learned = detailTarget?.learned;
    if (!learned) return;
    setBusyKey(`learned-${action}`);
    setError('');
    try {
      if (action === 'archive') {
        await archiveLearnedSkill(learned, detailTarget.installation?.installationId);
        if (!aliveRef.current) return;
        setNotice(t(`已归档「${learned.name}」`, `Archived "${learned.name}"`));
        setDetailTarget(null);
      } else {
        const body: Record<string, unknown> = {
          action,
          skillId: learned.skillId,
          requestId: newRequestId(),
        };
        if (action === 'pin') body.pinned = !learned.pinned;
        if (action === 'lock') body.locked = !learned.locked;
        const updated = await centerAdminRequest<LearnedSkillItem>(api, identity, {
          method: 'POST',
          path: `${botBasePath}/skill-reviews`,
          body,
        });
        if (!aliveRef.current) return;
        setDetailTarget(prev => prev ? { ...prev, learned: updated } : null);
        setNotice(t('状态已更新', 'Status updated'));
      }
      await loadAll(true);
    } catch (failure) {
      if (aliveRef.current) handleFailure(failure);
    } finally {
      if (aliveRef.current) setBusyKey(null);
    }
  };

  const hasCreateDraft = Boolean(
    newName.trim()
    || newDesc.trim()
    || newBody.trim()
    || newExtraFiles.length > 0
    || extraFileName.trim(),
  );

  const hasDetailUnsavedChanges = Boolean(
    detailTarget
    && editingFiles
    && hasFileChanges(detailTarget.files, detailTarget.originalFiles),
  );

  const exitCreate = useCallback(() => {
    setCreating(false);
    setNewName('');
    setNewDesc('');
    setNewBody('');
    setNewExtraFiles([]);
    setExtraFileName('');
    setError('');
  }, []);

  const handleBackFromCreate = useCallback(() => {
    if (hasCreateDraft) {
      setConfirmAction({ kind: 'discard-create' });
      return;
    }
    exitCreate();
  }, [hasCreateDraft, exitCreate]);

  const exitDetail = useCallback(() => {
    setDetailTarget(null);
    setEditingFiles(false);
    setEditNewFileName('');
    setError('');
  }, []);

  const handleBackFromDetail = useCallback(() => {
    if (hasDetailUnsavedChanges) {
      setConfirmAction({ kind: 'discard-detail', exitToList: true });
      return;
    }
    exitDetail();
  }, [hasDetailUnsavedChanges, exitDetail]);

  const revertDetailFiles = useCallback(() => {
    setDetailTarget(prev => {
      if (!prev) return null;
      return { ...prev, files: { ...prev.originalFiles } };
    });
    if (detailTarget && !Object.prototype.hasOwnProperty.call(detailTarget.originalFiles, selectedFile)) {
      const origKeys = Object.keys(detailTarget.originalFiles);
      setSelectedFile(origKeys.includes('SKILL.md') ? 'SKILL.md' : (origKeys[0] ?? 'SKILL.md'));
    }
    setEditingFiles(false);
    setEditNewFileName('');
  }, [detailTarget, selectedFile]);

  const handleCancelEditFiles = useCallback(() => {
    if (hasDetailUnsavedChanges) {
      setConfirmAction({ kind: 'discard-detail', exitToList: false });
      return;
    }
    revertDetailFiles();
  }, [hasDetailUnsavedChanges, revertDetailFiles]);

  const subviewBackHandler = creating ? handleBackFromCreate : detailTarget ? handleBackFromDetail : null;
  const inSheet = useSettingsSheetBack(subviewBackHandler);
  const subviewBackRef = useRef(subviewBackHandler);
  subviewBackRef.current = subviewBackHandler;
  const inSubview = Boolean(subviewBackHandler);

  useEffect(() => {
    if (inSheet || !inSubview) return;
    const onAppBack = (event: Event) => {
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const handler = subviewBackRef.current;
      if (!handler) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handler();
    };
    window.addEventListener('app-back', onAppBack, true);
    return () => window.removeEventListener('app-back', onAppBack, true);
  }, [inSheet, inSubview]);

  const renderAuthBanner = () => {
    if (authIssue === 'oauth') {
      return (
        <div className="bs-auth-note">
          {t('当前中心授权已失效，请在设置中重新扫码绑定中心后重试。', 'Center authorization expired. Please re-bind via QR code and retry.')}
        </div>
      );
    }
    if (authIssue === 'offline') {
      return (
        <div className="bs-auth-note">
          {t('当前设备尚未连接中心，连接后即可新建、编辑与同步技能。', 'Device is not connected to a center yet. Connect to create and sync skills.')}
        </div>
      );
    }
    return null;
  };

  let view: ReactNode;

  // --- View A: 新建技能表单 ---
  if (creating) {
    view = (
      <div className="bs-inline-panel bs-skills">
        <div className="bs-skills-detail-head">
          {!inSheet ? (
            <button
              type="button"
              className="bs-btn is-ghost is-small"
              onClick={handleBackFromCreate}
            >
              <ArrowLeft aria-hidden="true" />
              {t('返回技能列表', 'Back to skills')}
            </button>
          ) : null}
          <span className="bs-skills-detail-title">
            {t('新建技能', 'New skill')}
            {botName ? <Badge>{botName}</Badge> : null}
          </span>
        </div>

        <ErrorNotice error={error} onDismiss={() => setError('')} />

        <form className="bs-skills-form" onSubmit={e => void handleCreateSubmit(e)}>
          <div className="bs-skills-field">
            <label htmlFor={`${advIdPrefix}-new-skill-name`}>{t('技能名称', 'Skill name')}</label>
            <input
              id={`${advIdPrefix}-new-skill-name`}
              className="bs-input"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder={t('例如：代码审查助手', 'e.g. Code Review Helper')}
              disabled={busyKey === 'create'}
            />
          </div>

          <div className="bs-skills-field">
            <label htmlFor={`${advIdPrefix}-new-skill-desc`}>{t('一句话触发描述', 'Trigger description')}</label>
            <input
              id={`${advIdPrefix}-new-skill-desc`}
              className="bs-input"
              maxLength={1024}
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder={t('说明何时自动触发该技能，例如：当用户请求审查代码变更或 PR 时使用', 'When to trigger this skill (max 1024 chars)')}
              disabled={busyKey === 'create'}
            />
          </div>

          <div className="bs-skills-field">
            <label htmlFor={`${advIdPrefix}-new-skill-body`}>
              {t('SKILL.md 正文（如未写 YAML 头部，提交时将自动补齐）', 'SKILL.md body (YAML frontmatter auto-completed if omitted)')}
            </label>
            <textarea
              id={`${advIdPrefix}-new-skill-body`}
              className="bs-textarea bs-skills-editor-area"
              value={newBody}
              onChange={e => setNewBody(e.target.value)}
              placeholder={t('# 执行步骤\n\n1. 先检查差异文件...\n2. 输出关键风险与修改建议...', '# Instructions\n\n1. Inspect diff...\n2. Summarize findings...')}
              disabled={busyKey === 'create'}
            />
          </div>

          <div className="bs-skills-field">
            <span className="bs-skills-label">{t('可选附属文件（references / scripts / templates / assets）', 'Optional attachment files')}</span>
            <div className="bs-skills-actions-row">
              <select
                className="bs-select bs-skills-prefix-select"
                aria-label={t('附属文件目录', 'Attachment directory')}
                value={extraPrefix}
                onChange={e => setExtraPrefix(e.target.value as (typeof ALLOWED_SUBDIRS)[number])}
              >
                {ALLOWED_SUBDIRS.map(dir => <option key={dir} value={dir}>{dir}</option>)}
              </select>
              <input
                className="bs-input bs-skills-filename-input"
                aria-label={t('附属文件名', 'Attachment filename')}
                value={extraFileName}
                onChange={e => setExtraFileName(e.target.value)}
                placeholder={t('文件名，如 checklist.md', 'Filename, e.g. checklist.md')}
              />
              <button
                type="button"
                className="bs-btn is-small"
                onClick={() => {
                  const full = normalizeExtraFilePath(extraPrefix, extraFileName);
                  if (!full || newExtraFiles.some(f => f.path === full)) return;
                  setNewExtraFiles(prev => [...prev, { path: full, content: '' }]);
                  setExtraFileName('');
                }}
              >
                <Plus aria-hidden="true" />
                {t('添加文件', 'Add file')}
              </button>
            </div>

            {newExtraFiles.map((file, idx) => (
              <div key={file.path} className="bs-skills-extra-row">
                <div className="bs-skills-extra-head">
                  <strong>{file.path}</strong>
                  <button
                    type="button"
                    className="bs-btn is-ghost is-danger is-small"
                    onClick={() => setNewExtraFiles(prev => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 aria-hidden="true" />
                    {t('移除', 'Remove')}
                  </button>
                </div>
                <textarea
                  className="bs-textarea"
                  aria-label={t(`编辑附属文件 ${file.path}`, `Edit attachment ${file.path}`)}
                  rows={4}
                  value={file.content}
                  onChange={e => {
                    const nextVal = e.target.value;
                    setNewExtraFiles(prev => prev.map((f, i) => (i === idx ? { ...f, content: nextVal } : f)));
                  }}
                />
              </div>
            ))}
          </div>

          <div className="bs-skills-actions-row">
            <button type="submit" className="bs-btn is-primary" disabled={busyKey === 'create'}>
              {busyKey === 'create' ? t('创建并绑定中...', 'Creating...') : t('创建并为此 Bot 启用', 'Create & enable for Bot')}
            </button>
            <button type="button" className="bs-btn is-ghost" onClick={handleBackFromCreate}>
              {t('取消', 'Cancel')}
            </button>
          </div>
        </form>
      </div>
    );
  } else if (detailTarget) {
    // --- View B: 技能详情与多文件编辑器 ---
    const fileKeys = Object.keys(detailTarget.files);
    const activeContent = detailTarget.files[selectedFile] ?? '';
    const learnedDetail = detailTarget.learned;
    const currentScope: SkillVisibilityScope =
      detailTarget.installation?.visibilityScope
      ?? learnedDetail?.visibilityScope
      ?? 'global';
    const isShared = currentScope === 'global' || currentScope === 'assigned';
    const canSwitchScope = Boolean(
      detailTarget.installation
      && (detailTarget.installation.ownerBot || detailTarget.installation.visibilityScope),
    );

    view = (
      <div className="bs-inline-panel bs-skills">
        <div className="bs-skills-detail">
          <div className="bs-skills-detail-head">
            {!inSheet ? (
              <button
                type="button"
                className="bs-btn is-ghost is-small"
                onClick={handleBackFromDetail}
              >
                <ArrowLeft aria-hidden="true" />
                {t('返回列表', 'Back')}
              </button>
            ) : null}

            <div className="bs-skills-actions-row">
              {detailTarget.editable ? (
                editingFiles ? (
                  <>
                    <button
                      type="button"
                      className="bs-btn is-primary is-small"
                      disabled={busyKey === 'save-files'}
                      onClick={() => void saveSkillFiles()}
                    >
                      {busyKey === 'save-files' ? t('保存中...', 'Saving...') : t('保存', 'Save')}
                    </button>
                    <button
                      type="button"
                      className="bs-btn is-ghost is-small"
                      onClick={handleCancelEditFiles}
                    >
                      {t('取消', 'Cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="bs-btn is-primary is-small"
                    onClick={() => setEditingFiles(true)}
                  >
                    <Edit3 aria-hidden="true" />
                    {t('编辑技能', 'Edit skill')}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="bs-btn is-primary is-small"
                  disabled={busyKey === 'convert-copy'}
                  onClick={() => void convertToEditableCopy()}
                >
                  <Copy aria-hidden="true" />
                  {busyKey === 'convert-copy' ? t('创建副本中...', 'Creating copy...') : t('转为可编辑副本', 'Convert to editable copy')}
                </button>
              )}
            </div>
          </div>

          <div className="bs-skills-detail-title">
            <span>{detailTarget.name}</span>
            {learnedDetail ? <Badge tone="accent"><span aria-hidden="true">✨</span> {t('本 Bot 习得', 'Learned')}</Badge> : null}
            {!detailTarget.editable ? <Badge tone="warning">{t('只读导入包', 'Read-only package')}</Badge> : null}
          </div>

          <ErrorNotice error={error} onDismiss={() => setError('')} />
          {notice ? <ErrorNotice error={notice} tone="success" compact onDismiss={() => setNotice('')} /> : null}

          {detailTarget.installation && isShared ? (
            <div className="bs-skills-shared-banner">
              {t('此技能正由其他 Bot 共享，保存后将同步更新。', 'This skill is shared with other Bots; saving updates them as well.')}
            </div>
          ) : null}

          {canSwitchScope ? (
            <div className="bs-skills-scope-bar">
              <span className="bs-skills-label">{t('可用范围', 'Availability scope')}</span>
              <Segmented<SkillVisibilityScope>
                label={t('可用范围', 'Availability scope')}
                value={currentScope}
                disabled={busyKey === 'scope'}
                onChange={next => void changeVisibilityScope(next)}
                options={[
                  { value: 'private', label: t('仅此 Bot', 'This Bot only') },
                  { value: 'assigned', label: t('指定 Bot', 'Assigned Bots') },
                  { value: 'global', label: t('全局可用', 'Global') },
                ]}
              />
            </div>
          ) : null}

          {learnedDetail ? (
            <div className="bs-skills-actions-row">
              <button
                type="button"
                className="bs-btn is-small"
                disabled={busyKey !== null}
                onClick={() => void runLearnedAction('pin')}
              >
                <Pin aria-hidden="true" />
                {learnedDetail.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')}
              </button>
              <button
                type="button"
                className="bs-btn is-small"
                disabled={busyKey !== null}
                onClick={() => void runLearnedAction('lock')}
              >
                {learnedDetail.locked ? <Unlock aria-hidden="true" /> : <Lock aria-hidden="true" />}
                {learnedDetail.locked ? t('解锁内容', 'Unlock') : t('锁定保护', 'Lock')}
              </button>
              {learnedDetail.state === 'archived' ? (
                <button
                  type="button"
                  className="bs-btn is-small"
                  disabled={busyKey !== null}
                  onClick={() => void runLearnedAction('restore')}
                >
                  {t('恢复启用', 'Restore')}
                </button>
              ) : (
                <button
                  type="button"
                  className="bs-btn is-danger is-small"
                  disabled={busyKey !== null}
                  onClick={() => setConfirmAction({ kind: 'archive-detail', name: learnedDetail.name })}
                >
                  {t('归档技能', 'Archive')}
                </button>
              )}
            </div>
          ) : null}

          <div className="bs-skills-files-bar" role="group" aria-label={t('技能文件', 'Skill files')}>
            {fileKeys.map(filePath => (
              <button
                key={filePath}
                type="button"
                aria-pressed={selectedFile === filePath}
                className={`bs-skills-file-tab${selectedFile === filePath ? ' is-active' : ''}`}
                onClick={() => setSelectedFile(filePath)}
              >
                {filePath}
              </button>
            ))}
          </div>

          {editingFiles ? (
            <>
              <div className="bs-skills-actions-row">
                <select
                  className="bs-select bs-skills-prefix-select"
                  aria-label={t('新增文件目录', 'New file directory')}
                  value={editPrefix}
                  onChange={e => setEditPrefix(e.target.value as (typeof ALLOWED_SUBDIRS)[number])}
                >
                  {ALLOWED_SUBDIRS.map(dir => <option key={dir} value={dir}>{dir}</option>)}
                </select>
                <input
                  className="bs-input bs-skills-filename-input"
                  aria-label={t('新增文件名', 'New filename')}
                  value={editNewFileName}
                  onChange={e => setEditNewFileName(e.target.value)}
                  placeholder={t('新增附属文件，如 run.sh', 'Add file, e.g. run.sh')}
                />
                <button
                  type="button"
                  className="bs-btn is-small"
                  onClick={() => {
                    const nextPath = normalizeExtraFilePath(editPrefix, editNewFileName);
                    if (!nextPath) return;
                    setDetailTarget(prev => prev ? {
                      ...prev,
                      files: { ...prev.files, [nextPath]: prev.files[nextPath] ?? '' },
                    } : null);
                    setSelectedFile(nextPath);
                    setEditNewFileName('');
                  }}
                >
                  <Plus aria-hidden="true" />
                  {t('新增文件', 'Add file')}
                </button>
                {selectedFile !== 'SKILL.md' && fileKeys.length > 1 ? (
                  <button
                    type="button"
                    className="bs-btn is-danger is-small"
                    onClick={() => setConfirmAction({ kind: 'delete-file', filePath: selectedFile })}
                  >
                    <Trash2 aria-hidden="true" />
                    {t('删除当前文件', 'Delete file')}
                  </button>
                ) : null}
              </div>

              <textarea
                className="bs-textarea bs-skills-editor-area"
                aria-label={t(`编辑文件 ${selectedFile}`, `Edit file ${selectedFile}`)}
                value={activeContent}
                onChange={e => {
                  const val = e.target.value;
                  setDetailTarget(prev => prev ? {
                    ...prev,
                    files: { ...prev.files, [selectedFile]: val },
                  } : null);
                }}
              />
            </>
          ) : (
            <pre className="bs-skills-code-view">{activeContent || t('（空文件）', '(Empty file)')}</pre>
          )}
        </div>
      </div>
    );
  } else {
    // --- View C: 主列表视图 ---
    const autoExtractEnabled = Boolean(learning && learning.settings.review.skillEvery < 1000);
    const jobActive = learning?.activeJob?.status === 'queued' || learning?.activeJob?.status === 'running';

    view = (
      <div className="bs-inline-panel bs-skills">
        {renderAuthBanner()}
        <ErrorNotice error={error} onDismiss={() => setError('')} />
        {notice ? <ErrorNotice error={notice} tone="success" compact onDismiss={() => setNotice('')} /> : null}

        <div className="bs-skills-topbar">
          <span className="bs-skills-label">
            {botName ? `${botName} · ${t('技能与习得库', 'Skills & Learned Library')}` : t('技能与习得库', 'Skills & Learned Library')}
          </span>
          <div className="bs-skills-topbar-actions">
            {jobActive ? (
              <button
                type="button"
                className="bs-btn is-small"
                disabled={busyKey === 'review'}
                onClick={() => void cancelActiveJob()}
              >
                {t('复盘中 · 取消', 'Reviewing · Cancel')}
              </button>
            ) : (
              <button
                type="button"
                className="bs-btn is-small"
                disabled={!learning || busyKey === 'review'}
                onClick={() => void triggerReview()}
              >
                <RefreshCw aria-hidden="true" className={busyKey === 'review' ? 'bs-spin' : undefined} />
                {t('立即复盘', 'Review now')}
              </button>
            )}
            <button
              type="button"
              className="bs-btn is-primary is-small"
              onClick={() => { setCreating(true); setError(''); }}
            >
              <Plus aria-hidden="true" />
              {t('新建技能', 'New skill')}
            </button>
          </div>
        </div>

        {learning ? (
          <div className="bs-skills-learning-card">
            <Row
              title={t('空闲时自动提炼技能', 'Auto-extract skills when idle')}
              subtitle={
                autoExtractEnabled
                  ? t(`每 ${learning.settings.review.skillEvery} 轮交互自动复盘提炼可复用技能`, `Reviews every ${learning.settings.review.skillEvery} iterations`)
                  : t('已暂停自动提炼，仍可随时点击「立即复盘」', 'Automatic extraction paused; manual review still available')
              }
              trailing={(
                <Switch
                  checked={autoExtractEnabled}
                  label={t('空闲时自动提炼技能', 'Auto-extract skills when idle')}
                  disabled={busyKey === 'learning'}
                  onChange={next => void toggleAutoExtract(next)}
                />
              )}
            />
            {learning.lastJob?.summary ? (
              <div className="bs-skills-learning-meta">
                <span>{t('最近复盘：', 'Last review: ')}{learning.lastJob.summary}</span>
              </div>
            ) : null}

            {learningDraft ? (
              <Disclosure title={t('高级学习策略', 'Advanced learning policy')} defaultOpen={false}>
                <div className="bs-skills-adv-grid">
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-memory-every`}>{t('记忆复盘周期 (轮)', 'Memory review every')}</label>
                    <input
                      id={`${advIdPrefix}-memory-every`}
                      type="number"
                      min={1}
                      max={10000}
                      className="bs-input"
                      value={learningDraft.review.memoryEvery}
                      onChange={e => setLearningDraft(d => d ? { ...d, review: { ...d.review, memoryEvery: Math.max(1, Number(e.target.value) || 1) } } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-skill-every`}>{t('技能提炼周期 (步)', 'Skill review every')}</label>
                    <input
                      id={`${advIdPrefix}-skill-every`}
                      type="number"
                      min={1}
                      max={10000}
                      className="bs-input"
                      value={learningDraft.review.skillEvery}
                      onChange={e => setLearningDraft(d => d ? { ...d, review: { ...d.review, skillEvery: Math.max(1, Number(e.target.value) || 1) } } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-interval-hours`}>{t('整理间隔 (小时)', 'Curator interval (h)')}</label>
                    <input
                      id={`${advIdPrefix}-interval-hours`}
                      type="number"
                      min={1}
                      max={720}
                      className="bs-input"
                      value={learningDraft.curator.intervalHours}
                      onChange={e => setLearningDraft(d => d ? { ...d, curator: { ...d.curator, intervalHours: Math.max(1, Number(e.target.value) || 1) } } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-min-idle-hours`}>{t('最小空闲时长 (小时)', 'Min idle hours')}</label>
                    <input
                      id={`${advIdPrefix}-min-idle-hours`}
                      type="number"
                      min={0}
                      max={720}
                      className="bs-input"
                      value={learningDraft.curator.minIdleHours}
                      onChange={e => setLearningDraft(d => d ? { ...d, curator: { ...d.curator, minIdleHours: Math.max(0, Number(e.target.value) || 0) } } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-stale-days`}>{t('陈旧判定 (天)', 'Stale after (days)')}</label>
                    <input
                      id={`${advIdPrefix}-stale-days`}
                      type="number"
                      min={1}
                      max={3650}
                      className="bs-input"
                      value={learningDraft.curator.staleAfterDays}
                      onChange={e => setLearningDraft(d => d ? { ...d, curator: { ...d.curator, staleAfterDays: Math.max(1, Number(e.target.value) || 1) } } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-archive-days`}>{t('自动归档 (天)', 'Archive after (days)')}</label>
                    <input
                      id={`${advIdPrefix}-archive-days`}
                      type="number"
                      min={1}
                      max={3650}
                      className="bs-input"
                      value={learningDraft.curator.archiveAfterDays}
                      onChange={e => setLearningDraft(d => d ? { ...d, curator: { ...d.curator, archiveAfterDays: Math.max(1, Number(e.target.value) || 1) } } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-review-model`}>{t('复盘模型 (可留空跟随默认)', 'Review model ref')}</label>
                    <input
                      id={`${advIdPrefix}-review-model`}
                      className="bs-input"
                      value={learningDraft.reviewModelRef ?? ''}
                      placeholder={t('跟随 Bot 默认模型', 'Use Bot default')}
                      onChange={e => setLearningDraft(d => d ? { ...d, reviewModelRef: e.target.value.trim() || null } : d)}
                    />
                  </div>
                  <div className="bs-skills-field">
                    <label htmlFor={`${advIdPrefix}-curator-model`}>{t('整理模型 (可留空跟随默认)', 'Curator model ref')}</label>
                    <input
                      id={`${advIdPrefix}-curator-model`}
                      className="bs-input"
                      value={learningDraft.curatorModelRef ?? ''}
                      placeholder={t('跟随 Bot 默认模型', 'Use Bot default')}
                      onChange={e => setLearningDraft(d => d ? { ...d, curatorModelRef: e.target.value.trim() || null } : d)}
                    />
                  </div>
                </div>
                <div className="bs-skills-adv-footer">
                  <label className="bs-skills-consolidate-label">
                    <input
                      type="checkbox"
                      checked={learningDraft.curator.consolidate}
                      onChange={e => setLearningDraft(d => d ? { ...d, curator: { ...d.curator, consolidate: e.target.checked } } : d)}
                    />
                    {t('自动合并重复技能', 'Consolidate duplicate skills')}
                  </label>
                  <button
                    type="button"
                    className="bs-btn is-primary is-small"
                    disabled={busyKey === 'learning'}
                    onClick={() => void saveLearningConfig(learningDraft, t('学习策略已保存', 'Learning policy saved'))}
                  >
                    {t('保存策略', 'Save policy')}
                  </button>
                </div>
              </Disclosure>
            ) : null}
          </div>
        ) : null}

        <div className="bs-skills-toolbar">
          <div className="bs-skills-toolbar-search">
            <SearchField value={query} onChange={setQuery} placeholder={t('搜索技能名称或描述', 'Search skills')} />
          </div>
          <Chips<SkillFilter>
            label={t('技能筛选', 'Skill filter')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('全部', 'All') },
              { value: 'enabled', label: t('已启用', 'Enabled') },
              { value: 'learned', label: t('本 Bot 习得', 'Learned') },
              ...(archivedCount > 0 ? [{ value: 'archived' as const, label: `${t('已归档', 'Archived')} (${archivedCount})` }] : []),
            ]}
          />
        </div>

        {loading ? <LoadingState text={t('正在读取技能列表...', 'Loading skills...')} /> : null}
        {detailLoading ? <LoadingState text={t('正在打开技能文件...', 'Opening skill files...')} /> : null}

        {!loading && filteredSkills.length === 0 ? (
          <EmptyState
            icon={<Sparkles aria-hidden="true" />}
            title={t('暂无符合条件的技能', 'No skills found')}
            hint={t('可点击右上角「新建技能」手动编写，或开启自动提炼从对话中积累技能。', 'Click "New skill" to write one or enable auto-extraction.')}
          />
        ) : (
          <div className="bs-skills-list">
            {filteredSkills.map(skill => {
              const scopeLabel =
                skill.visibilityScope === 'private'
                  ? t('私有', 'Private')
                  : skill.visibilityScope === 'assigned'
                    ? t('指定 Bot', 'Assigned Bots')
                    : t('全局共享', 'Global');
              return (
                <div key={skill.key} className="bs-skills-item">
                  <button
                    type="button"
                    className="bs-skills-item-main"
                    onClick={() => void openSkillDetail(skill)}
                  >
                    <span className="bs-skills-item-title-row">
                      <span className="bs-skills-item-title">{skill.name}</span>
                      {skill.learned ? <Badge tone="accent"><span aria-hidden="true">✨</span> {t('本 Bot 习得', 'Learned')}</Badge> : null}
                      <Badge>{scopeLabel}</Badge>
                      {skill.learned?.pinned ? <Badge>{t('置顶', 'Pinned')}</Badge> : null}
                      {skill.learned?.locked ? <Badge>{t('已锁定', 'Locked')}</Badge> : null}
                      {skill.learned?.state === 'stale' ? <Badge tone="warning">{t('待复审', 'Needs review')}</Badge> : null}
                      {skill.isArchived ? <Badge>{t('已归档', 'Archived')}</Badge> : null}
                    </span>
                    {skill.description ? <span className="bs-skills-item-desc">{skill.description}</span> : null}
                  </button>

                  <div className="bs-skills-item-side">
                    <Switch
                      checked={skill.botEnabled}
                      label={t(`为本 Bot 启用 ${skill.name}`, `Enable ${skill.name} for this Bot`)}
                      disabled={busyKey === skill.key}
                      onChange={next => {
                        if (!next && !(skill.capability && skill.installationId) && skill.learned) {
                          setConfirmAction({ kind: 'archive-switch', skill });
                          return;
                        }
                        void toggleSkillForBot(skill, next);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const confirmProps = (() => {
    if (!confirmAction) return null;
    switch (confirmAction.kind) {
      case 'archive-switch':
        return {
          title: t('归档并停用技能？', 'Archive and disable skill?'),
          description: t(`关闭开关将归档已学技能「${confirmAction.skill.name}」并取消共享，确认继续吗？`, `Turning this off archives the learned skill "${confirmAction.skill.name}" and removes sharing. Continue?`),
          danger: true,
          onConfirm: () => {
            const { skill } = confirmAction;
            setConfirmAction(null);
            void toggleSkillForBot(skill, false);
          },
        };
      case 'archive-detail':
        return {
          title: t('归档技能？', 'Archive skill?'),
          description: t(`归档「${confirmAction.name}」将从本 Bot 停用并取消共享，后续可在已归档列表中恢复。确认归档吗？`, `Archiving "${confirmAction.name}" disables it on this Bot and removes sharing. You can restore it later from Archived. Continue?`),
          danger: true,
          onConfirm: () => {
            setConfirmAction(null);
            void runLearnedAction('archive');
          },
        };
      case 'delete-file':
        return {
          title: t('删除当前文件？', 'Delete current file?'),
          description: t(`确认删除文件「${confirmAction.filePath}」吗？保存后该文件将从技能中移除。`, `Delete "${confirmAction.filePath}"? It will be removed from this skill when you save.`),
          danger: true,
          onConfirm: () => {
            const targetPath = confirmAction.filePath;
            const remaining = Object.keys(detailTarget?.files ?? {}).filter(k => k !== targetPath);
            setConfirmAction(null);
            setDetailTarget(prev => {
              if (!prev) return null;
              const nextFiles = { ...prev.files };
              delete nextFiles[targetPath];
              return { ...prev, files: nextFiles };
            });
            setSelectedFile(remaining[0] ?? 'SKILL.md');
          },
        };
      case 'discard-create':
        return {
          title: t('放弃修改？', 'Discard changes?'),
          description: t('当前有未保存的新建技能内容，返回将丢失这些修改。确认放弃吗？', 'You have unsaved new skill changes. Going back will discard them. Continue?'),
          danger: true,
          onConfirm: () => {
            setConfirmAction(null);
            exitCreate();
          },
        };
      case 'discard-detail':
        return {
          title: t('放弃修改？', 'Discard changes?'),
          description: t('当前有未保存的技能文件修改，继续将丢失这些更改。确认放弃吗？', 'You have unsaved skill file changes. Continuing will discard them. Continue?'),
          danger: true,
          onConfirm: () => {
            const { exitToList } = confirmAction;
            setConfirmAction(null);
            if (exitToList) {
              exitDetail();
            } else {
              revertDetailFiles();
            }
          },
        };
    }
  })();

  return (
    <>
      {view}
      <ConfirmDialog
        open={confirmProps !== null}
        title={confirmProps?.title ?? ''}
        description={confirmProps?.description ?? ''}
        danger={confirmProps?.danger}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => confirmProps?.onConfirm()}
      />
    </>
  );
}
