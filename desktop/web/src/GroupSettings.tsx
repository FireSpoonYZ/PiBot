import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Check,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { DesktopIdentity, DesktopViewApi } from './types';
import type { ScopeReadApi } from './scope-api';
import type {
  MessageMember,
  MessageScope,
  ScopeInfo,
} from '../../../host-core/index.js';
import { GrokBotAvatar, resolveBotAvatarPreset } from '../../../web/src/GrokBotAvatar';
import {
  ConversationGroupAvatar,
  conversationMemberName,
  conversationTitle,
} from '../../../web/src/gbot-ui';
import type { ConversationBot } from '../../../web/src/gbot-ui';

/** 扩展可选自然展示字段：兼容基础 ConversationBot，同时支持目录已有自然设备名/平台/描述。 */
export type ScopeBotInfo = ConversationBot & {
  deviceName?: string;
  hostLabel?: string;
  platform?: string;
  description?: string;
};

export function sessionKey(id: DesktopIdentity | null): string {
  return id ? `${id.profileId}|${id.kind}|${id.generation}|${id.targetDeviceId}` : '';
}

/** 只有 error.outcome 明确 not-sent（未派发）才可判定未入队；其余一律视为结果未知。 */
export function isNotSent(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { outcome?: unknown }).outcome === 'not-sent';
}

/** 明确终态失败（未发出或远端已明确拒绝）：此时不冻结原 requestId；其余视为回执未确认。 */
function isDefinitiveFailure(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const outcome = (e as { outcome?: unknown }).outcome;
  return outcome === 'not-sent' || outcome === 'responded';
}

function errorCodeOf(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** 读取 room 自定义标题（trim 后非空才有效）。 */
export function readScopeTitle(scope: MessageScope): string {
  return typeof scope.title === 'string' ? scope.title.trim() : '';
}

/** 检测 scope 是否已带删除墓碑 deletedAt。 */
export function isScopeDeleted(scope: ScopeInfo | null | undefined): boolean {
  if (!scope) return false;
  return typeof scope.scope.deletedAt === 'string' && scope.scope.deletedAt.trim().length > 0;
}

/** 忽略自定义 title，始终计算成员拼接的默认群聊名。 */
export function roomAutoTitle(scope: MessageScope, bots: readonly ConversationBot[]): string {
  return conversationTitle({ ...scope, title: undefined }, bots);
}

/** 成员/消息作者与已知 Bot 匹配时复用其定制头像；否则按 deviceId:botId 种子给出稳定预设。 */
export function memberAvatar(
  member: { deviceId: string; botId: string },
  bots: readonly ConversationBot[],
  size: number,
): ReactNode {
  const known = bots.find((b) => b.deviceId === member.deviceId && b.botId === member.botId);
  if (known) {
    return (
      <GrokBotAvatar
        preset={resolveBotAvatarPreset(`${known.deviceId}:${known.botId}`, known.role, known.isPrimary)}
        size={size}
      />
    );
  }
  return (
    <GrokBotAvatar
      preset={resolveBotAvatarPreset(`${member.deviceId}:${member.botId}`, member.botId, false)}
      size={size}
    />
  );
}

/** 过滤疑似技术 ID（UUID、长 hex、deviceId/botId 截断前缀），绝不向界面暴露技术 ID。 */
function isTechnicalIdLike(text: string, member: { deviceId: string; botId: string }): boolean {
  const v = text.trim();
  if (!v) return true;
  const lower = v.toLowerCase();
  const devLower = member.deviceId.toLowerCase();
  const botLower = member.botId.toLowerCase();
  if (lower === devLower || lower === botLower) return true;
  if (devLower && lower.length >= 6 && devLower.startsWith(lower)) return true;
  if (botLower && lower.length >= 6 && botLower.startsWith(lower)) return true;
  if (/^[0-9a-f]{8,}$/i.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return true;
  if (/^(dev|bot|host|scope|node)[-_][0-9a-z]{6,}$/i.test(v)) return true;
  return false;
}

function naturalPlatformName(platform: string | undefined): string {
  if (!platform) return '';
  const p = platform.trim().toLowerCase();
  if (p === 'android') return 'Android 设备';
  if (p === 'ios') return 'iOS 设备';
  if (p === 'windows' || p === 'win32') return 'Windows 设备';
  if (p === 'macos' || p === 'darwin') return 'Mac 设备';
  if (p === 'linux') return 'Linux 设备';
  return '';
}

/**
 * 成员自然副标题（设备自然名 + 角色状态）：
 * 只使用目录与档案中已有的自然名称字段，绝不回退或拼接 deviceId/botId/scopeId。
 */
export function memberMetaText(
  member: { deviceId: string; botId: string },
  bots: readonly ScopeBotInfo[],
  api?: ScopeReadApi,
): string {
  const known = bots.find((b) => b.deviceId === member.deviceId && b.botId === member.botId);
  if (!known) return '已不在当前目录';

  let deviceLabel = '';
  const candidateDevice = (known.deviceName ?? known.hostLabel ?? '').trim();
  if (candidateDevice && !isTechnicalIdLike(candidateDevice, member)) {
    deviceLabel = candidateDevice;
  }
  if (!deviceLabel && api?.snapshot?.state?.profiles) {
    const profile = api.snapshot.state.profiles.find((p) => {
      const targetId = p.kind === 'relay' ? p.deviceId : p.expectedDeviceId;
      return targetId === member.deviceId;
    });
    if (profile?.title && !isTechnicalIdLike(profile.title, member)) {
      deviceLabel = profile.title.trim();
    }
  }
  if (!deviceLabel) {
    deviceLabel = naturalPlatformName(known.platform);
  }
  if (!deviceLabel && api?.identity?.targetDeviceId === member.deviceId && api.identity.kind === 'local') {
    deviceLabel = '本机';
  }

  const roleLabel = known.isPrimary ? '主智能体' : '智能体';
  const desc = known.description?.trim() ?? '';
  const parts = [deviceLabel, roleLabel, desc].filter(Boolean);
  return parts.join(' · ');
}

export interface GroupSettingsProps {
  api: ScopeReadApi;
  /** 指向权威节点的写通道（非权威或未就绪时为 null）。 */
  membersApi: DesktopViewApi | null;
  scope: ScopeInfo;
  bots: readonly ScopeBotInfo[];
  memberCandidates: readonly ScopeBotInfo[];
  canWrite: boolean;
  onChanged: (s: ScopeInfo) => void;
  onClose: () => void;
  onDeleted?: () => void;
}

export function GroupSettings({
  api,
  membersApi,
  scope,
  bots,
  memberCandidates,
  canWrite,
  onChanged,
  onClose,
  onDeleted,
}: GroupSettingsProps) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const wIdentity = membersApi?.identity ?? null;
  const wOnline = Boolean(membersApi && wIdentity && membersApi.transportConnected);
  const hasAuthorityNode = Boolean(scope.authorityDeviceId);
  const canManage = canWrite && hasAuthorityNode && Boolean(membersApi);

  const savedTitle = readScopeTitle(scope.scope);
  const autoTitle = roomAutoTitle(scope.scope, bots);
  const displayTitle = conversationTitle(scope.scope, bots);
  const memberCount = scope.scope.members.length;

  /** 最近一次从权威节点确认的 revision 基线。 */
  const authorityBaselineRef = useRef<{ revision: number } | null>(null);
  const [syncingState, setSyncingState] = useState(false);
  const [syncStateError, setSyncStateError] = useState<string | null>(null);

  // ————— 群名称编辑状态（明确按钮保存，绝不 blur+click 重复提交） —————
  const [titleInput, setTitleInput] = useState<string>(() => savedTitle);
  const titleDirtyRef = useRef(false);
  const titleBaselineRef = useRef<{ revision: number; baseTitle: string } | null>(null);
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [titleNotice, setTitleNotice] = useState<string | null>(null);
  const [titleFrozenAttempt, setTitleFrozenAttempt] = useState<{
    requestId: string;
    expectedRevision: number;
    title: string;
  } | null>(null);

  // ————— 群成员 CAS 编辑状态 —————
  const [editMode, setEditMode] = useState(false);
  const [editMembers, setEditMembers] = useState<MessageMember[]>(() =>
    scope.scope.members.map((m) => ({ ...m })),
  );
  const editBaselineRef = useRef<{ revision: number } | null>(null);
  const [enteringEdit, setEnteringEdit] = useState(false);
  const [enterEditError, setEnterEditError] = useState<string | null>(null);
  const [savingMembers, setSavingMembers] = useState(false);
  const [saveMembersError, setSaveMembersError] = useState<string | null>(null);
  const [membersFrozenAttempt, setMembersFrozenAttempt] = useState<{
    requestId: string;
    expectedRevision: number;
    members: MessageMember[];
  } | null>(null);

  // ————— 解散并删除群聊状态（React 内联二次确认，不用 window.confirm/prompt） —————
  const [preparingDelete, setPreparingDelete] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteBaselineRef = useRef<{ revision: number } | null>(null);
  const [deleteFrozenAttempt, setDeleteFrozenAttempt] = useState<{
    requestId: string;
    expectedRevision: number;
  } | null>(null);

  // 被动 prop 刷新：未改名时同步名称显示；未处于成员编辑时同步成员列表。
  useEffect(() => {
    if (!titleDirtyRef.current && !titleFrozenAttempt) {
      setTitleInput(savedTitle);
    }
  }, [savedTitle, scope.scope.revision, titleFrozenAttempt]);

  useEffect(() => {
    if (!editMode && !membersFrozenAttempt) {
      setEditMembers(scope.scope.members.map((m) => ({ ...m })));
    }
  }, [scope.scope.scopeId, scope.scope.revision, scope.scope.members, editMode, membersFrozenAttempt]);

  /** 从权威节点读取最新 ScopeInfo 并捕获 CAS 基线；检测到已删除立即触发退出。 */
  async function fetchLatestFromAuthority(): Promise<ScopeInfo | null> {
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) return null;
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const localScope = scope.scope.scopeId;
    setSyncingState(true);
    setSyncStateError(null);
    try {
      const latest = await membersApi.call(id, 'getScopeState', { scopeId: localScope });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return null;
      if (latest.scope.scopeId !== localScope) return null;
      if (isScopeDeleted(latest)) {
        onDeleted?.();
        return null;
      }
      authorityBaselineRef.current = { revision: latest.scope.revision };
      onChanged(latest);
      if (!titleDirtyRef.current && !titleFrozenAttempt) {
        setTitleInput(readScopeTitle(latest.scope));
      }
      if (!editMode && !membersFrozenAttempt) {
        setEditMembers(latest.scope.members.map((m) => ({ ...m })));
      }
      return latest;
    } catch (e) {
      if (mountedRef.current && sessionKey(membersApi.identity) === localSess) {
        setSyncStateError('读取权威节点最新状态失败，请重试。');
        membersApi.reportError(e);
      }
      return null;
    } finally {
      if (mountedRef.current) setSyncingState(false);
    }
  }

  // 打开群设置或权威写通道恢复在线时，自动读取一次最新权威状态捕获基线。
  useEffect(() => {
    if (!wOnline) return;
    void fetchLatestFromAuthority();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.scope.scopeId, wOnline]);

  // ————— 群名称保存逻辑 —————
  function handleTitleInputChange(next: string) {
    if (!titleDirtyRef.current) {
      titleBaselineRef.current = {
        revision: authorityBaselineRef.current?.revision ?? scope.scope.revision,
        baseTitle: savedTitle,
      };
    }
    titleDirtyRef.current = true;
    setTitleInput(next);
    if (titleError && !titleFrozenAttempt) setTitleError(null);
    if (titleNotice) setTitleNotice(null);
  }

  function handleClearTitleInput() {
    if (!titleDirtyRef.current) {
      titleBaselineRef.current = {
        revision: authorityBaselineRef.current?.revision ?? scope.scope.revision,
        baseTitle: savedTitle,
      };
    }
    titleDirtyRef.current = true;
    setTitleInput('');
    if (titleError && !titleFrozenAttempt) setTitleError(null);
    if (titleNotice) setTitleNotice(null);
  }

  function handleResetTitleInput() {
    titleDirtyRef.current = false;
    titleBaselineRef.current = null;
    setTitleInput(savedTitle);
    setTitleError(null);
    setTitleNotice(null);
  }

  async function saveTitle() {
    if (titleSaving || titleFrozenAttempt) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      setTitleError('权威节点未连接，暂不能保存群名称；您的输入已保留。');
      return;
    }
    const trimmed = titleInput.trim();
    if (trimmed.length > 120) {
      setTitleError('群聊名称最多 120 个字符，请精简后再保存。');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const localScope = scope.scope.scopeId;
    setTitleSaving(true);
    setTitleError(null);
    setTitleNotice(null);
    try {
      // 先向权威节点读取最新状态捕获 expectedRevision，避免覆盖其他成员变更或陈旧 revision。
      let latest: ScopeInfo;
      try {
        latest = await membersApi.call(id, 'getScopeState', { scopeId: localScope });
      } catch (e) {
        if (mountedRef.current && sessionKey(membersApi.identity) === localSess) {
          setTitleError('读取最新群状态失败，您的名称输入已保留，请重试。');
          membersApi.reportError(e);
        }
        return;
      }
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (isScopeDeleted(latest)) {
        onDeleted?.();
        return;
      }
      authorityBaselineRef.current = { revision: latest.scope.revision };
      onChanged(latest);

      const latestTitle = readScopeTitle(latest.scope);
      const baseTitle = titleBaselineRef.current?.baseTitle ?? savedTitle;
      if (latestTitle !== baseTitle && latestTitle !== trimmed) {
        titleBaselineRef.current = { revision: latest.scope.revision, baseTitle: latestTitle };
        setTitleError(
          `群名称已在其他设备更新为「${latestTitle || '默认成员名'}」，您的输入已保留；请确认后再次点击保存。`,
        );
        return;
      }

      const requestId = crypto.randomUUID();
      const expectedRevision = latest.scope.revision;
      try {
        // 仅提交 title 字段，不传 members，绝不覆盖其他成员变更。
        const updated = await membersApi.mutateIntent(id, 'updateScope', {
          scopeId: localScope,
          input: {
            requestId,
            expectedRevision,
            title: trimmed,
          },
        });
        if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
        if (isScopeDeleted(updated)) {
          onDeleted?.();
          return;
        }
        authorityBaselineRef.current = { revision: updated.scope.revision };
        const updatedTitle = readScopeTitle(updated.scope);
        titleBaselineRef.current = { revision: updated.scope.revision, baseTitle: updatedTitle };
        titleDirtyRef.current = false;
        setTitleFrozenAttempt(null);
        setTitleInput(updatedTitle);
        setTitleError(null);
        setTitleNotice(updatedTitle ? '群聊名称已保存。' : '已恢复为成员默认名称。');
        onChanged(updated);
      } catch (e) {
        if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
        membersApi.reportError(e);
        if (isDefinitiveFailure(e)) {
          setTitleFrozenAttempt(null);
          const code = errorCodeOf(e);
          setTitleError(
            code === 'REQUEST_CONFLICT'
              ? '群状态已变更（版本冲突），您的输入已保留，请再次点击保存重试。'
              : '群名称保存失败，您的输入已保留，请重试。',
          );
        } else {
          // 回执未知：冻结原 requestId 与 expectedRevision，不盲目用新 ID 重发。
          setTitleFrozenAttempt({ requestId, expectedRevision, title: trimmed });
          setTitleError('群名称保存回执未确认。已保留您的输入且不会用新请求盲目重发；请先查询状态或用原请求重试。');
        }
      }
    } finally {
      if (mountedRef.current) setTitleSaving(false);
    }
  }

  async function reconcileTitleAttempt() {
    if (!titleFrozenAttempt || titleSaving) return;
    const latest = await fetchLatestFromAuthority();
    if (!latest || !mountedRef.current) return;
    const latestTitle = readScopeTitle(latest.scope);
    if (latest.scope.revision > titleFrozenAttempt.expectedRevision && latestTitle === titleFrozenAttempt.title) {
      titleBaselineRef.current = { revision: latest.scope.revision, baseTitle: latestTitle };
      titleDirtyRef.current = false;
      setTitleFrozenAttempt(null);
      setTitleInput(latestTitle);
      setTitleError(null);
      setTitleNotice('已确认群名称保存成功。');
    } else if (latest.scope.revision === titleFrozenAttempt.expectedRevision) {
      setTitleError('权威节点尚未应用该修改，可点击“原请求重试”安全重发。');
    } else {
      titleBaselineRef.current = { revision: latest.scope.revision, baseTitle: latestTitle };
      setTitleFrozenAttempt(null);
      setTitleError('权威节点版本已更新，原请求未生效；您的输入已保留，可重新点击保存。');
    }
  }

  async function retryFrozenTitleAttempt() {
    if (!titleFrozenAttempt || titleSaving) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      setTitleError('权威节点未连接，请连接后再重试原请求。');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const frozen = titleFrozenAttempt;
    setTitleSaving(true);
    setTitleError(null);
    try {
      const updated = await membersApi.mutateIntent(id, 'updateScope', {
        scopeId: scope.scope.scopeId,
        input: {
          requestId: frozen.requestId,
          expectedRevision: frozen.expectedRevision,
          title: frozen.title,
        },
      });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (isScopeDeleted(updated)) {
        onDeleted?.();
        return;
      }
      authorityBaselineRef.current = { revision: updated.scope.revision };
      const updatedTitle = readScopeTitle(updated.scope);
      titleBaselineRef.current = { revision: updated.scope.revision, baseTitle: updatedTitle };
      titleDirtyRef.current = false;
      setTitleFrozenAttempt(null);
      setTitleInput(updatedTitle);
      setTitleError(null);
      setTitleNotice(updatedTitle ? '群聊名称已保存。' : '已恢复为成员默认名称。');
      onChanged(updated);
    } catch (e) {
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      membersApi.reportError(e);
      if (isDefinitiveFailure(e)) {
        setTitleFrozenAttempt(null);
        setTitleError('原请求未通过，您的输入已保留，可重新点击保存。');
      } else {
        setTitleError('重试回执仍未确认，保持原请求冻结；请稍后查询状态或再次重试。');
      }
    } finally {
      if (mountedRef.current) setTitleSaving(false);
    }
  }

  // ————— 群成员 CAS 编辑逻辑 —————
  function startMemberEdit(latest: ScopeInfo) {
    editBaselineRef.current = { revision: latest.scope.revision };
    authorityBaselineRef.current = { revision: latest.scope.revision };
    setEditMembers(latest.scope.members.map((m) => ({ ...m })));
    setSaveMembersError(null);
    setEnterEditError(null);
    setMembersFrozenAttempt(null);
    setEditMode(true);
  }

  async function enterEdit() {
    if (enteringEdit) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      startMemberEdit(scope);
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const localScope = scope.scope.scopeId;
    setEnteringEdit(true);
    setEnterEditError(null);
    try {
      const latest = await membersApi.call(id, 'getScopeState', { scopeId: localScope });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (latest.scope.scopeId !== localScope) return;
      if (isScopeDeleted(latest)) {
        onDeleted?.();
        return;
      }
      onChanged(latest);
      startMemberEdit(latest);
    } catch (e) {
      if (mountedRef.current && sessionKey(membersApi.identity) === localSess) {
        setEnterEditError('读取最新成员失败，请重试；未开启编辑。');
        membersApi.reportError(e);
      }
    } finally {
      if (mountedRef.current) setEnteringEdit(false);
    }
  }

  function cancelEdit() {
    editBaselineRef.current = null;
    setMembersFrozenAttempt(null);
    setEditMembers(scope.scope.members.map((m) => ({ ...m })));
    setSaveMembersError(null);
    setEditMode(false);
  }

  async function syncBaselineKeepMemberSelection() {
    if (enteringEdit || savingMembers) return;
    const latest = await fetchLatestFromAuthority();
    if (!latest || !mountedRef.current) return;
    editBaselineRef.current = { revision: latest.scope.revision };
    setMembersFrozenAttempt(null);
    setSaveMembersError('已同步最新群版本，您的成员选择已保留，请再次点击“保存成员”。');
  }

  async function saveMembers() {
    if (savingMembers || membersFrozenAttempt) return;
    if (!membersApi || !membersApi.identity) {
      setSaveMembersError('写通道未连接，不能保存成员变更；选择已保留，可稍后重试。');
      return;
    }
    if (!membersApi.transportConnected) {
      setSaveMembersError('权威节点未连接，不能保存成员变更；选择已保留，可稍后重试。');
      return;
    }
    if (editMembers.length < 2) {
      setSaveMembersError('群聊至少保留 2 个成员 Bot');
      return;
    }
    const baseline = editBaselineRef.current;
    if (!baseline) {
      setSaveMembersError('请重新进入编辑后再保存');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const requestId = crypto.randomUUID();
    const frozenMembers = editMembers.map((m) => ({ ...m }));
    setSavingMembers(true);
    setSaveMembersError(null);
    try {
      const updated = await membersApi.mutateIntent(id, 'updateScope', {
        scopeId: scope.scope.scopeId,
        input: {
          requestId,
          expectedRevision: baseline.revision,
          members: frozenMembers,
        },
      });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (isScopeDeleted(updated)) {
        onDeleted?.();
        return;
      }
      authorityBaselineRef.current = { revision: updated.scope.revision };
      editBaselineRef.current = null;
      setMembersFrozenAttempt(null);
      setEditMode(false);
      onChanged(updated);
    } catch (e) {
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      membersApi.reportError(e);
      if (isDefinitiveFailure(e)) {
        setMembersFrozenAttempt(null);
        const code = errorCodeOf(e);
        setSaveMembersError(
          code === 'REQUEST_CONFLICT'
            ? '群状态已在其他位置更新（版本冲突），当前成员选择已保留；请同步最新状态后再保存。'
            : '成员保存失败，请重试；当前选择已保留。',
        );
      } else {
        setMembersFrozenAttempt({
          requestId,
          expectedRevision: baseline.revision,
          members: frozenMembers,
        });
        setSaveMembersError('成员保存回执未确认。已保留当前选择且不会用新请求盲目重发；请先查询状态或用原请求重试。');
      }
    } finally {
      if (mountedRef.current) setSavingMembers(false);
    }
  }

  async function reconcileMembersAttempt() {
    if (!membersFrozenAttempt || savingMembers) return;
    const latest = await fetchLatestFromAuthority();
    if (!latest || !mountedRef.current) return;
    const sameMembers =
      latest.scope.members.length === membersFrozenAttempt.members.length &&
      latest.scope.members.every((m, idx) => {
        const target = membersFrozenAttempt.members[idx];
        return target && m.deviceId === target.deviceId && m.botId === target.botId;
      });
    if (latest.scope.revision > membersFrozenAttempt.expectedRevision && sameMembers) {
      editBaselineRef.current = null;
      setMembersFrozenAttempt(null);
      setSaveMembersError(null);
      setEditMode(false);
    } else if (latest.scope.revision === membersFrozenAttempt.expectedRevision) {
      setSaveMembersError('权威节点尚未应用该成员变更，可点击“原请求重试”安全重发。');
    } else {
      editBaselineRef.current = { revision: latest.scope.revision };
      setMembersFrozenAttempt(null);
      setSaveMembersError('权威节点版本已变更，原请求未生效；当前成员选择已保留，请确认后再次保存。');
    }
  }

  async function retryFrozenMembersAttempt() {
    if (!membersFrozenAttempt || savingMembers) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      setSaveMembersError('权威节点未连接，请连接后再重试原请求。');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const frozen = membersFrozenAttempt;
    setSavingMembers(true);
    setSaveMembersError(null);
    try {
      const updated = await membersApi.mutateIntent(id, 'updateScope', {
        scopeId: scope.scope.scopeId,
        input: {
          requestId: frozen.requestId,
          expectedRevision: frozen.expectedRevision,
          members: frozen.members,
        },
      });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (isScopeDeleted(updated)) {
        onDeleted?.();
        return;
      }
      authorityBaselineRef.current = { revision: updated.scope.revision };
      editBaselineRef.current = null;
      setMembersFrozenAttempt(null);
      setEditMode(false);
      onChanged(updated);
    } catch (e) {
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      membersApi.reportError(e);
      if (isDefinitiveFailure(e)) {
        setMembersFrozenAttempt(null);
        setSaveMembersError('原请求未通过，当前选择已保留，请同步最新状态后重试。');
      } else {
        setSaveMembersError('重试回执仍未确认，保持原请求冻结；请稍后查询状态或再次重试。');
      }
    } finally {
      if (mountedRef.current) setSavingMembers(false);
    }
  }

  // ————— 解散并删除群聊逻辑 —————
  async function requestDeleteRoom() {
    if (preparingDelete || deleting) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      setDeleteError('权威节点未连接，暂无法解散并删除群聊。');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const localScope = scope.scope.scopeId;
    setPreparingDelete(true);
    setDeleteError(null);
    try {
      const latest = await membersApi.call(id, 'getScopeState', { scopeId: localScope });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (latest.scope.scopeId !== localScope) return;
      if (isScopeDeleted(latest)) {
        onDeleted?.();
        return;
      }
      authorityBaselineRef.current = { revision: latest.scope.revision };
      deleteBaselineRef.current = { revision: latest.scope.revision };
      onChanged(latest);
      setDeleteFrozenAttempt(null);
      setConfirmDeleteOpen(true);
    } catch (e) {
      if (mountedRef.current && sessionKey(membersApi.identity) === localSess) {
        setDeleteError('读取最新群状态失败，请重试后再确认解散。');
        membersApi.reportError(e);
      }
    } finally {
      if (mountedRef.current) setPreparingDelete(false);
    }
  }

  function cancelDeleteRoom() {
    if (deleting) return;
    setConfirmDeleteOpen(false);
    setDeleteFrozenAttempt(null);
    setDeleteError(null);
  }

  async function confirmDeleteRoom() {
    if (deleting) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      setDeleteError('权威节点未连接，暂无法执行解散操作。');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    const expectedRevision =
      deleteFrozenAttempt?.expectedRevision ??
      deleteBaselineRef.current?.revision ??
      authorityBaselineRef.current?.revision ??
      scope.scope.revision;
    const attempt = deleteFrozenAttempt ?? {
      requestId: crypto.randomUUID(),
      expectedRevision,
    };
    setDeleting(true);
    setDeleteError(null);
    try {
      await membersApi.mutateIntent(id, 'deleteScope', {
        scopeId: scope.scope.scopeId,
        input: {
          requestId: attempt.requestId,
          expectedRevision: attempt.expectedRevision,
        },
      });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      setDeleteFrozenAttempt(null);
      setConfirmDeleteOpen(false);
      onDeleted?.();
    } catch (e) {
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      membersApi.reportError(e);
      if (isDefinitiveFailure(e)) {
        setDeleteFrozenAttempt(null);
        const code = errorCodeOf(e);
        setDeleteError(
          code === 'REQUEST_CONFLICT'
            ? '群聊状态已在其他设备更新，请点击“重新同步状态”后再确认解散。'
            : '解散并删除群聊失败，请重试。',
        );
      } else {
        setDeleteFrozenAttempt(attempt);
        setDeleteError('解散请求回执未确认，不会用新请求盲目重发；请先查询群状态，或用原请求重试。');
      }
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }

  async function reconcileDeleteAttempt() {
    if (!deleteFrozenAttempt || deleting) return;
    if (!membersApi || !membersApi.identity || !membersApi.transportConnected) {
      setDeleteError('权威节点未连接，请连接后查询群状态。');
      return;
    }
    const id = membersApi.identity;
    const localSess = sessionKey(id);
    setDeleting(true);
    try {
      const latest = await membersApi.call(id, 'getScopeState', { scopeId: scope.scope.scopeId });
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (isScopeDeleted(latest)) {
        setDeleteFrozenAttempt(null);
        setConfirmDeleteOpen(false);
        onDeleted?.();
        return;
      }
      authorityBaselineRef.current = { revision: latest.scope.revision };
      deleteBaselineRef.current = { revision: latest.scope.revision };
      onChanged(latest);
      if (latest.scope.revision === deleteFrozenAttempt.expectedRevision) {
        setDeleteError('权威节点尚未执行解散，可点击“原请求重试”安全重发。');
      } else {
        setDeleteFrozenAttempt(null);
        setDeleteError('权威节点版本已变更，原解散请求未生效；请再次点击“确认解散并删除”。');
      }
    } catch (e) {
      if (!mountedRef.current || sessionKey(membersApi.identity) !== localSess) return;
      if (errorCodeOf(e) === 'SCOPE_NOT_FOUND') {
        setDeleteFrozenAttempt(null);
        setConfirmDeleteOpen(false);
        onDeleted?.();
        return;
      }
      setDeleteError('查询群状态失败，请稍后重试。');
      membersApi.reportError(e);
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }

  const trimmedTitleInput = titleInput.trim();
  const isTitleChanged = trimmedTitleInput !== savedTitle;
  const candidateChoices = memberCandidates.filter(
    (b) => !editMembers.some((m) => m.deviceId === b.deviceId && m.botId === b.botId),
  );

  return (
    <div className="scope-settings-view" aria-label="群聊详情">
      <header className="scope-settings-topbar">
        <button
          type="button"
          className="conversation-chat-header__circle"
          onClick={onClose}
          aria-label="返回聊天"
          title="返回聊天"
        >
          <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 16 16" width="18">
            <path
              d="m9.75 3.25-4.5 4.75 4.5 4.75"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
          </svg>
        </button>
        <h2 className="scope-settings-topbar-title">群聊详情</h2>
        <span aria-hidden="true" className="conversation-chat-header__spacer" />
      </header>

      <div className="scope-settings-scroll">
        <div className="scope-settings-container">
          {/* ————— 顶部居中组合头像 88px + 群名 + 成员数量 ————— */}
          <section className="scope-settings-hero">
            <div className="scope-settings-hero-avatar">
              <ConversationGroupAvatar members={scope.scope.members} bots={bots} size={88} />
            </div>
            <h1 className="scope-settings-hero-title">{displayTitle}</h1>
            <p className="scope-settings-hero-subtitle">{memberCount} 位成员</p>
          </section>

          {!canManage ? (
            <div className="status scope-settings-status-bar" role="status">
              {!canWrite
                ? '当前为只读浏览模式，仅供查看群聊信息。'
                : '当前仅群聊权威节点可修改群名称、管理成员或解散群聊。'}
            </div>
          ) : !wOnline ? (
            <div className="status scope-settings-status-bar" role="status">
              权威节点待连接，连接后可修改群名称、管理成员或解散群聊；本地输入会为您保留。
            </div>
          ) : null}

          {syncStateError ? (
            <div className="error-banner" role="alert">
              {syncStateError}
              <button
                type="button"
                onClick={() => void fetchLatestFromAuthority()}
                disabled={syncingState || !wOnline}
              >
                {syncingState ? '同步中…' : '重试同步'}
              </button>
            </div>
          ) : null}

          {/* ————— 群名称卡片：输入与明确保存、清空恢复默认自动名 ————— */}
          <section className="scope-settings-section" aria-label="群聊名称">
            <div className="scope-settings-section-head">
              <span className="scope-settings-section-label">群聊名称</span>
              {savedTitle ? (
                <span className="scope-settings-section-meta">已设自定义名称</span>
              ) : (
                <span className="scope-settings-section-meta">当前使用成员自动名称</span>
              )}
            </div>
            <div className="scope-settings-card">
              <div className="scope-title-input-row">
                <input
                  type="text"
                  className="scope-title-input"
                  value={titleInput}
                  maxLength={120}
                  placeholder={autoTitle || '输入群聊名称（留空则按成员自动拼接）'}
                  aria-label="群聊名称"
                  disabled={!canManage || titleSaving || Boolean(titleFrozenAttempt)}
                  onChange={(e) => handleTitleInputChange(e.target.value)}
                />
                {canManage && titleInput.length > 0 && !titleSaving && !titleFrozenAttempt ? (
                  <button
                    type="button"
                    className="icon-button scope-title-clear-btn"
                    onClick={handleClearTitleInput}
                    title="清空输入（保存后恢复自动群名）"
                    aria-label="清空群聊名称输入"
                  >
                    <X size={15} />
                  </button>
                ) : null}
              </div>

              {canManage ? (
                <div className="scope-title-actions-row">
                  <span className="scope-title-hint">
                    {trimmedTitleInput.length === 0
                      ? savedTitle
                        ? `保存空名称将恢复默认群名：${autoTitle}`
                        : `留空时默认显示：${autoTitle}`
                      : `${trimmedTitleInput.length} / 120 字符`}
                  </span>
                  <div className="scope-title-buttons">
                    {titleDirtyRef.current && isTitleChanged && !titleFrozenAttempt ? (
                      <button
                        type="button"
                        className="secondary-button scope-compact-btn"
                        disabled={titleSaving}
                        onClick={handleResetTitleInput}
                      >
                        重置
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="primary-button scope-compact-btn"
                      disabled={!wOnline || titleSaving || !isTitleChanged || Boolean(titleFrozenAttempt)}
                      onClick={() => void saveTitle()}
                    >
                      <Check size={14} />
                      {titleSaving
                        ? '保存中…'
                        : trimmedTitleInput === '' && savedTitle !== ''
                          ? '恢复默认名称'
                          : '保存名称'}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {titleNotice ? (
              <div className="status scope-settings-notice" role="status">
                {titleNotice}
              </div>
            ) : null}

            {titleError ? (
              <div className="error-banner" role="alert">
                <span>{titleError}</span>
                {titleFrozenAttempt ? (
                  <span className="scope-inline-banner-actions">
                    <button
                      type="button"
                      onClick={() => void reconcileTitleAttempt()}
                      disabled={titleSaving || syncingState || !wOnline}
                    >
                      查询最新状态
                    </button>
                    <button
                      type="button"
                      onClick={() => void retryFrozenTitleAttempt()}
                      disabled={titleSaving || !wOnline}
                    >
                      原请求重试
                    </button>
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* ————— 群成员卡片：自然名称与设备信息，CAS 添加/移除（最少 2 位） ————— */}
          <section className="scope-settings-section" aria-label="群成员">
            <div className="scope-settings-section-head">
              <span className="scope-settings-section-label">
                {editMode ? `编辑群成员（已选 ${editMembers.length} 位）` : `群成员（${memberCount} 位）`}
              </span>
              {canManage && !editMode ? (
                <button
                  type="button"
                  className="secondary-button scope-member-edit-btn"
                  onClick={() => void enterEdit()}
                  disabled={enteringEdit}
                >
                  <RefreshCw size={13} className={enteringEdit ? 'scope-spin' : undefined} />
                  {enteringEdit ? '读取最新成员…' : '管理成员'}
                </button>
              ) : null}
            </div>

            {enterEditError ? (
              <div className="error-banner" role="alert">
                <span>{enterEditError}</span>
                <button type="button" onClick={() => void enterEdit()} disabled={enteringEdit}>
                  重试
                </button>
              </div>
            ) : null}

            <div className="scope-settings-card">
              <ul className="member-list scope-settings-member-list">
                {(editMode ? editMembers : scope.scope.members).map((m) => {
                  const name = conversationMemberName(m, bots);
                  const meta = memberMetaText(m, bots, api);
                  return (
                    <li key={`${m.deviceId}:${m.botId}`} className="member-row scope-settings-member-row">
                      <span className="member-row-avatar">{memberAvatar(m, bots, 38)}</span>
                      <span className="member-row-text scope-settings-member-info">
                        <span className="entity-title scope-settings-member-name">{name}</span>
                        {meta ? <span className="scope-settings-member-meta">{meta}</span> : null}
                      </span>
                      {editMode ? (
                        <button
                          type="button"
                          className="icon-button"
                          disabled={savingMembers || Boolean(membersFrozenAttempt)}
                          title={`移除成员 ${name}`}
                          aria-label={`移除成员 ${name}`}
                          onClick={() => {
                            setEditMembers(
                              editMembers.filter((x) => !(x.deviceId === m.deviceId && x.botId === m.botId)),
                            );
                            if (saveMembersError && !membersFrozenAttempt) setSaveMembersError(null);
                          }}
                        >
                          <X size={15} />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {editMode ? (
                <>
                  {editMembers.length < 2 ? (
                    <div className="scope-settings-min-warning" role="status">
                      群聊至少需要保留 2 位成员 Bot，请继续添加后再保存。
                    </div>
                  ) : null}

                  <div className="scope-settings-candidates-block">
                    <span className="scope-settings-candidates-title">添加成员</span>
                    {candidateChoices.length > 0 ? (
                      <div className="member-quick-row scope-settings-candidates-grid">
                        {candidateChoices.map((b) => {
                          const meta = memberMetaText(b, bots, api);
                          const displayRole = b.role.trim() || '未命名 Bot';
                          return (
                            <button
                              key={`${b.deviceId}:${b.botId}`}
                              type="button"
                              className="member-chip scope-candidate-chip"
                              disabled={savingMembers || Boolean(membersFrozenAttempt)}
                              title={`添加成员 ${displayRole}`}
                              onClick={() => {
                                setEditMembers([...editMembers, { deviceId: b.deviceId, botId: b.botId }]);
                                if (saveMembersError && !membersFrozenAttempt) setSaveMembersError(null);
                              }}
                            >
                              {memberAvatar(b, bots, 26)}
                              <span className="scope-candidate-chip-text">
                                <span className="member-chip-name">{displayRole}</span>
                                {meta ? <span className="scope-candidate-chip-meta">{meta}</span> : null}
                              </span>
                              <Plus size={14} className="scope-candidate-chip-plus" />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="hint">所有可用智能体均已在群聊中。</span>
                    )}
                  </div>

                  {!wOnline ? (
                    <div className="status scope-settings-inner-status">
                      写通道未连接，暂不能保存成员变更；当前选择已保留。
                    </div>
                  ) : null}

                  {saveMembersError ? (
                    <div className="error-banner scope-settings-inner-banner" role="alert">
                      <span>{saveMembersError}</span>
                      {membersFrozenAttempt ? (
                        <span className="scope-inline-banner-actions">
                          <button
                            type="button"
                            onClick={() => void reconcileMembersAttempt()}
                            disabled={savingMembers || syncingState || !wOnline}
                          >
                            查询最新状态
                          </button>
                          <button
                            type="button"
                            onClick={() => void retryFrozenMembersAttempt()}
                            disabled={savingMembers || !wOnline}
                          >
                            原请求重试
                          </button>
                        </span>
                      ) : (
                        <span className="scope-inline-banner-actions">
                          <button
                            type="button"
                            onClick={() => void syncBaselineKeepMemberSelection()}
                            disabled={savingMembers || enteringEdit || syncingState || !wOnline}
                          >
                            同步最新状态
                          </button>
                        </span>
                      )}
                    </div>
                  ) : null}

                  <div className="form-actions scope-settings-edit-actions">
                    <button
                      type="button"
                      className="secondary-button scope-compact-btn"
                      disabled={savingMembers}
                      onClick={cancelEdit}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="primary-button scope-compact-btn"
                      disabled={savingMembers || Boolean(membersFrozenAttempt) || !wOnline}
                      onClick={() => void saveMembers()}
                    >
                      {savingMembers ? '保存中…' : '保存成员'}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </section>

          {/* ————— 最底部红色：解散并删除群聊（二次确认所有设备历史删除） ————— */}
          {canManage ? (
            <section className="scope-settings-section scope-settings-danger-section" aria-label="解散并删除群聊">
              {!confirmDeleteOpen ? (
                <>
                  <div className="scope-settings-card">
                    <button
                      type="button"
                      className="scope-danger-row-btn"
                      disabled={preparingDelete || deleting || !wOnline}
                      onClick={() => void requestDeleteRoom()}
                    >
                      <Trash2 size={18} />
                      <span>{preparingDelete ? '正在读取群状态…' : '解散并删除群聊'}</span>
                    </button>
                  </div>
                  {deleteError ? (
                    <div className="error-banner" role="alert">
                      <span>{deleteError}</span>
                      <button
                        type="button"
                        onClick={() => void requestDeleteRoom()}
                        disabled={preparingDelete || !wOnline}
                      >
                        重试
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="scope-delete-confirm-card" role="alertdialog" aria-label="确认解散并删除群聊">
                  <div className="scope-delete-confirm-head">
                    <Trash2 size={18} />
                    <strong>确认解散并删除群聊「{displayTitle}」？</strong>
                  </div>
                  <p className="scope-delete-confirm-desc">
                    解散后将永久删除该群聊，所有设备上的群聊历史消息与成员关系都会一并删除，且不可恢复。
                  </p>
                  {deleteError ? (
                    <div className="error-banner" role="alert">
                      <span>{deleteError}</span>
                      {deleteFrozenAttempt ? (
                        <span className="scope-inline-banner-actions">
                          <button
                            type="button"
                            onClick={() => void reconcileDeleteAttempt()}
                            disabled={deleting || !wOnline}
                          >
                            查询群状态
                          </button>
                          <button
                            type="button"
                            onClick={() => void confirmDeleteRoom()}
                            disabled={deleting || !wOnline}
                          >
                            原请求重试
                          </button>
                        </span>
                      ) : (
                        <span className="scope-inline-banner-actions">
                          <button
                            type="button"
                            onClick={() => void requestDeleteRoom()}
                            disabled={preparingDelete || deleting || !wOnline}
                          >
                            重新同步状态
                          </button>
                        </span>
                      )}
                    </div>
                  ) : null}
                  <div className="confirm-delete-actions scope-delete-confirm-actions">
                    <button
                      type="button"
                      className="secondary-button scope-compact-btn"
                      disabled={deleting}
                      onClick={cancelDeleteRoom}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="primary-button danger-button scope-compact-btn"
                      disabled={deleting || !wOnline}
                      onClick={() => void confirmDeleteRoom()}
                    >
                      {deleting ? '正在解散并删除…' : '确认解散并删除'}
                    </button>
                  </div>
                </div>
              )}
              <p className="scope-settings-footnote">
                解散群聊会同步清除所有参与设备上的该群聊与全部历史记录。
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
