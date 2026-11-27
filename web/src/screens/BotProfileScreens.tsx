import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Cpu,
  Globe,
  LockKeyhole,
  MessagesSquare,
  Monitor,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Star,
  Trash2,
  User,
} from 'lucide-react';
import { mobileHaptic } from '../native/tauri-host';
import { formatBotModelSummary, type FormattedBotModel } from '../bot-settings/modelDisplay';
import {
  GROK_COLOR_PALETTE,
  GROK_EXPRESSION_LIST,
  GROK_SHAPE_ORDER,
  GrokBotAvatar,
  JARVIS_AVATAR_PRESET,
  getDefaultBotAvatarPreset,
  resolveBotAvatarPreset,
  type GrokAvatarPreset,
} from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { ErrorNotice, useText } from '../ui';
import { LabelStack, ReservedSlot, Skeleton } from '../layout';
import {
  PlatformLogoIcon,
  SOUL_MAX_BYTES,
  SOUL_SNIPPETS,
  formatArchivedRemainingDays,
  formatScheduleNextRun,
  type BotScheduleDraft,
  type BotScheduleState,
  type BotScheduleTask,
  type UnifiedBotItem,
} from '../hub/shared';
import { Button, ConfirmDialog, InlineBanner, Skeleton as UiSkeleton, Switch } from '../components/ui';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import type { ActionController, MobileBotItem } from './types';

export interface BotProfileScreenProps {
  activeBot: MobileBotItem;
  editName: string;
  onChangeEditName(next: string): void;
  editSubtitle: string;
  onChangeEditSubtitle(next: string): void;
  profileError?: string;
  onDismissProfileError(): void;
  actionBusy: boolean;
  canOpenRemoteBotConfig: boolean;
  connectedToCenter: boolean;
  activeBotModelSummary: FormattedBotModel | null;
  scheduleCount: number;
  isBotBusy: boolean;
  profileManageTriggerRef: RefObject<HTMLButtonElement | null>;
  onBack(): void;
  onSave(): void;
  onOpenAvatarPicker(preset: GrokAvatarPreset): void;
  onOpenBotDms(): void;
  onOpenModelSettings(): void;
  onOpenSoul(): void;
  onOpenSkills(): void;
  onOpenCapabilities(): void;
  onOpenSchedules(): void;
  onOpenVault(): void;
  onOpenComputer(): void;
  onOpenBrowser?: () => void;
  onOpenManage(): void;
}

export function BotProfileScreen({
  activeBot,
  editName,
  onChangeEditName,
  editSubtitle,
  onChangeEditSubtitle,
  profileError,
  onDismissProfileError,
  actionBusy,
  canOpenRemoteBotConfig,
  connectedToCenter,
  activeBotModelSummary,
  scheduleCount,
  isBotBusy,
  profileManageTriggerRef,
  onBack,
  onSave,
  onOpenAvatarPicker,
  onOpenBotDms,
  onOpenModelSettings,
  onOpenSoul,
  onOpenSkills,
  onOpenCapabilities,
  onOpenSchedules,
  onOpenVault,
  onOpenComputer,
  onOpenBrowser,
  onOpenManage,
}: BotProfileScreenProps) {
  const t = useText();
  const modelSummary = activeBotModelSummary ?? formatBotModelSummary(activeBot, { connectedToCenter });
  const avatarPreset = resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const profileDirty =
    editName.trim() !== activeBot.role.trim() ||
    editSubtitle.trim() !== (activeBot.description ?? '').trim();

  useEffect(() => {
    if (!profileDirty) setDiscardConfirmOpen(false);
  }, [profileDirty]);

  const handleRequestBack = useCallback(() => {
    if (actionBusy) return;
    if (profileDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onBack();
  }, [actionBusy, profileDirty, onBack]);

  const handleBackRef = useRef(handleRequestBack);
  handleBackRef.current = handleRequestBack;
  const interceptBack = Boolean(profileDirty || actionBusy);

  useEffect(() => {
    if (!interceptBack) return;
    return registerOverlayBackHandler(() => handleBackRef.current());
  }, [interceptBack]);

  return (
    <main className="grok-subpage grok-page-enter bot-profile-page">
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          aria-label={t('返回', 'Back')}
          disabled={actionBusy}
          onClick={handleRequestBack}
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="grok-subpage-header-title">
          {activeBot.role ? t(`${activeBot.role} · 资料`, `${activeBot.role} · Profile`) : t('Bot 资料', 'Bot profile')}
        </h2>
        <button
          type="button"
          className="grok-done-pill-btn"
          disabled={actionBusy || !editName.trim()}
          onClick={onSave}
        >
          <LabelStack
            active={actionBusy ? t('保存中…', 'Saving…') : t('保存', 'Save')}
            labels={[t('保存中…', 'Saving…'), t('保存', 'Save')]}
          />
        </button>
      </header>

      <div className="grok-subpage-scroll">
        <section className="grok-profile-hero">
          <button
            type="button"
            className="grok-profile-avatar-btn"
            onClick={() => onOpenAvatarPicker(avatarPreset)}
            aria-label={t('更换头像', 'Change avatar')}
          >
            <GrokBotAvatar
              preset={avatarPreset}
              isPrimary={activeBot.isPrimary}
              starBadge={activeBot.isPrimary}
              platformBadge={<PlatformLogoIcon platform={activeBot.platform} size={11} />}
              size={88}
            />
            <span className="grok-avatar-pencil-badge">
              <Pencil size={16} />
            </span>
          </button>
          <input
            className="grok-profile-title-input"
            value={editName}
            onChange={e => onChangeEditName(e.target.value)}
            placeholder={t('输入 Bot 名称', 'Enter Bot name')}
            aria-label={t('名称', 'Name')}
          />
          <input
            className="grok-profile-subtitle-input"
            value={editSubtitle}
            onChange={e => onChangeEditSubtitle(e.target.value)}
            placeholder={t('描述 Bot 的用途（可选）', 'Describe what this Bot does (optional)')}
            aria-label={t('用途', 'Purpose')}
          />
        </section>

        <ReservedSlot minHeight={44} align="start">
          <ErrorNotice error={profileError} stale={actionBusy} compact onDismiss={onDismissProfileError} />
        </ReservedSlot>
        <section className="grok-field-section">
          <h3 className="grok-section-label">{t('Bot 协作', 'Bot collaboration')}</h3>
          <div className="grok-card-group">
            <button
              type="button"
              className="grok-card-row bot-profile-dm-row"
              onClick={onOpenBotDms}
            >
              <span className="bot-profile-dm-icon" aria-hidden="true">
                <MessagesSquare size={18} />
              </span>
              <span className="bot-profile-dm-text">
                <span className="grok-row-label">{t('查看该 Bot 的私聊', 'View this bot’s private chats')}</span>
                <span className="bot-profile-dm-sub">
                  {t('查看与其他 Bot 的收发私聊记录', 'Browse incoming & outgoing DMs with other bots')}
                </span>
              </span>
              <ChevronRight size={18} className="grok-row-chevron" aria-hidden="true" />
            </button>
          </div>
        </section>

        <section className="grok-field-section">
          <h3 className="grok-section-label">{t('常用设置', 'Common settings')}</h3>
          <div className="grok-card-group">
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenModelSettings}
            >
              <Cpu size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('模型', 'Model')}</span>
              <span
                className={`grok-row-value grok-row-value-path${
                  modelSummary.tone === 'warn'
                    ? ' is-warn'
                    : modelSummary.tone === 'muted'
                      ? ' is-muted'
                      : ''
                }`}
              >
                {modelSummary.primaryText}
                {modelSummary.badgeText ? ` · ${modelSummary.badgeText}` : ''}
              </span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenSoul}
            >
              <User size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('人设', 'Persona')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenSkills}
            >
              <Sparkles size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('技能', 'Skills')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenCapabilities}
            >
              <Puzzle size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('工具扩展', 'Tools & Extensions')}</span>
              <span className="grok-row-value">
                {canOpenRemoteBotConfig ? t('MCP & 插件', 'MCP & Plugins') : t('连接中心后可用', 'Connect center')}
              </span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenSchedules}
            >
              <Clock size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('定时任务', 'Schedules')}</span>
              <span className="grok-row-value">
                {scheduleCount > 0 ? t(`${scheduleCount} 个已开启`, `${scheduleCount} active`) : ''}
              </span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenVault}
            >
              <LockKeyhole size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('密码凭据', 'Password Vault')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
          </div>
        </section>

        <section className="grok-field-section">
          <h3 className="grok-section-label">{t('更多管理', 'More management')}</h3>
          <div className="grok-card-group">
            <button
              type="button"
              className="grok-card-row"
              onClick={onOpenComputer}
            >
              <Monitor size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('电脑', 'Computer')}</span>
              <span className="grok-row-value">{isBotBusy ? t('运行中', 'Active') : t('空闲', 'Idle')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
            {onOpenBrowser ? (
              <button
                type="button"
                className="grok-card-row"
                onClick={onOpenBrowser}
              >
                <Globe size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('Bot 浏览器', 'Bot Browser')}</span>
                <span className="grok-row-value">{t('独立会话', 'Isolated')}</span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>
            ) : null}
            <button ref={profileManageTriggerRef} type="button" className="grok-card-row" onClick={onOpenManage}>
              <Settings size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('管理 Bot', 'Manage bot')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={discardConfirmOpen && profileDirty}
        title={t('放弃未保存的资料修改？', 'Discard unsaved profile changes?')}
        description={t('当前 Bot 的名称或用途有未保存的修改，返回将丢弃这些更改。', 'Your edits to this Bot’s name or purpose have not been saved. Going back will discard them.')}
        danger
        busy={actionBusy}
        confirmLabel={t('放弃修改', 'Discard')}
        cancelLabel={t('继续编辑', 'Keep editing')}
        onCancel={() => {
          if (!actionBusy) setDiscardConfirmOpen(false);
        }}
        onConfirm={() => {
          if (actionBusy) return;
          setDiscardConfirmOpen(false);
          onChangeEditName(activeBot.role);
          onChangeEditSubtitle(activeBot.description ?? '');
          onDismissProfileError();
          onBack();
        }}
      />
    </main>
  );
}

export interface BotProfileManageScreenProps {
  activeBot: MobileBotItem;
  connectedToCenter: boolean;
  editCwd: string;
  editCwdBaseline: string;
  editCwdRevision: number | null;
  editCwdError: string;
  editCwdSaved: boolean;
  cwdSaveError?: string;
  onChangeEditCwd(next: string): void;
  onDiscardEditCwd?: () => void;
  onReloadEditCwd(): void;
  onSaveEditCwd(): void;
  onDismissCwdSaveError(): void;
  onOpenCenterSettings(): void;
  action: ActionController;
  onBack(): void;
  onSetPrimary(bot: UnifiedBotItem): void;
  onRequestArchive(bot: UnifiedBotItem): void;
  onUnarchive(bot: UnifiedBotItem): void;
  onRequestDelete(bot: UnifiedBotItem): void;
}

export function BotProfileManageScreen({
  activeBot,
  connectedToCenter,
  editCwd,
  editCwdBaseline,
  editCwdRevision,
  editCwdError,
  editCwdSaved,
  cwdSaveError,
  onChangeEditCwd,
  onDiscardEditCwd,
  onReloadEditCwd,
  onSaveEditCwd,
  onDismissCwdSaveError,
  onOpenCenterSettings,
  action,
  onBack,
  onSetPrimary,
  onRequestArchive,
  onUnarchive,
  onRequestDelete,
}: BotProfileManageScreenProps) {
  const t = useText();
  const localOfflineCwd = activeBot.hostKind === 'local' && !connectedToCenter;
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const cwdDirty = !localOfflineCwd && editCwdRevision !== null && editCwd.trim() !== editCwdBaseline.trim();

  useEffect(() => {
    if (!cwdDirty) setDiscardConfirmOpen(false);
  }, [cwdDirty]);

  const handleRequestBack = useCallback(() => {
    if (action.busy) return;
    if (cwdDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onBack();
  }, [action.busy, cwdDirty, onBack]);

  const handleBackRef = useRef(handleRequestBack);
  handleBackRef.current = handleRequestBack;
  const interceptBack = Boolean(cwdDirty || action.busy);

  useEffect(() => {
    if (!interceptBack) return;
    return registerOverlayBackHandler(() => handleBackRef.current());
  }, [interceptBack]);

  return (
    <main className="grok-subpage grok-page-enter bot-profile-page">
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          aria-label={t('返回 Bot 资料', 'Back to bot profile')}
          disabled={action.busy}
          onClick={handleRequestBack}
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="grok-subpage-header-title">{t(`${activeBot.role} · 管理`, `${activeBot.role} · Manage`)}</h2>
        <span className="grok-topbar-spacer" aria-hidden="true" />
      </header>

      <div className="grok-subpage-scroll">
        <section className="grok-field-section">
          <label className="grok-section-label" htmlFor="profile-working-directory">{t('工作目录', 'Working directory')}</label>
          <div className="grok-card-group">
            <input
              id="profile-working-directory"
              className="grok-card-input"
              value={editCwd}
              readOnly={localOfflineCwd}
              disabled={action.busy}
              onChange={e => {
                if (localOfflineCwd) return;
                onChangeEditCwd(e.target.value);
              }}
              placeholder={t('目标 Host 上的绝对路径；空闲后生效', 'Absolute path on the target Host; applies when idle')}
            />
            {localOfflineCwd ? (
              <>
                <p className="secondary profile-card-hint">
                  {t('当前未连接中心，展示本机工作目录；扫码连接中心后可在线修改。',
                    'Showing the local working directory while offline; connect to the center to edit it.')}
                </p>
                <div className="profile-directory-actions">
                  <button type="button" className="hub-outline-btn" onClick={onOpenCenterSettings}>
                    {t('去连接中心', 'Connect to center')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {editCwdError && (
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label profile-inline-error">{editCwdError}</span>
                    <button
                      type="button"
                      className="hub-outline-btn"
                      disabled={action.busy}
                      onClick={onReloadEditCwd}
                    >
                      {t('重新读取', 'Reload')}
                    </button>
                  </div>
                )}
                <p className="secondary profile-card-hint">
                  {t('保存到中心后在该 Bot 空闲时生效；运行中的任务保持原目录，不会移动文件。',
                    'Saved to the center and applied when this Bot is idle; running work keeps its directory and no files are moved.')}
                </p>
                <ReservedSlot
                  minHeight={20}
                  align="center"
                  className="profile-card-hint"
                  role="status"
                  aria-live="polite"
                  contentKey={!editCwdError && editCwdRevision === null ? 'loading' : editCwdSaved ? 'saved' : 'idle'}
                >
                  {!editCwdError && editCwdRevision === null ? (
                    <Skeleton variant="text" width={120} height={12} inline label={t('正在读取目录…', 'Loading directory…')} />
                  ) : editCwdSaved ? (
                    <span className="secondary">{t('工作目录已保存', 'Working directory saved')}</span>
                  ) : null}
                </ReservedSlot>
                <div className="profile-directory-actions">
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    disabled={action.busy || editCwdRevision === null || !editCwd.trim() || editCwd.trim() === editCwdBaseline}
                    onClick={onSaveEditCwd}
                  >
                    {t('保存工作目录', 'Save working directory')}
                  </button>
                </div>
              </>
            )}
          </div>
          <ReservedSlot minHeight={44} align="start">
            <ErrorNotice error={cwdSaveError} stale={action.errorStale} compact onDismiss={onDismissCwdSaveError} />
          </ReservedSlot>
        </section>

        <section className="grok-field-section">
          <h3 className="grok-section-label">{t('Bot 状态', 'Bot status')}</h3>
          <section className="grok-card-group">
            {activeBot.isPrimary ? (
              <div className="grok-card-row no-active">
                <Star size={19} className="grok-row-icon" />
                <span className="grok-row-label profile-lifecycle-label">
                  {t('主 Bot', 'Primary Bot')}
                  <small className="profile-lifecycle-note">{t('切换主 Bot 后可归档或删除', 'Switch primary to archive/delete')}</small>
                </span>
              </div>
            ) : (
              <>
                {!activeBot.archivedAt && (
                  <button
                    type="button"
                    className="grok-card-row"
                    disabled={action.busy}
                    onClick={() => onSetPrimary(activeBot)}
                  >
                    <Star size={19} className="grok-row-icon" />
                    <span className="grok-row-label">{t('设为主 Bot', 'Set as Primary Bot')}</span>
                    <ChevronRight size={18} className="grok-row-chevron" />
                  </button>
                )}
                {!activeBot.archivedAt ? (
                  <button
                    type="button"
                    className="grok-card-row"
                    disabled={action.busy}
                    onClick={() => onRequestArchive(activeBot)}
                  >
                    <Archive size={19} className="grok-row-icon" />
                    <span className="grok-row-label">{t('归档 Bot', 'Archive Bot')}</span>
                    <span className="grok-row-value">{t('14 天后自动清理', '14d auto-delete')}</span>
                    <ChevronRight size={18} className="grok-row-chevron" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="grok-card-row"
                    disabled={action.busy}
                    onClick={() => onUnarchive(activeBot)}
                  >
                    <RotateCcw size={19} className="grok-row-icon" />
                    <span className="grok-row-label">{t('恢复 Bot（解除归档）', 'Unarchive Bot')}</span>
                    <span className="grok-row-value">
                      {t(`剩余 ${formatArchivedRemainingDays(activeBot.archivedAt)} 天`, `${formatArchivedRemainingDays(activeBot.archivedAt)}d left`)}
                    </span>
                    <ChevronRight size={18} className="grok-row-chevron" />
                  </button>
                )}
                <button
                  type="button"
                  className="grok-card-row danger-text"
                  disabled={action.busy}
                  onClick={() => onRequestDelete(activeBot)}
                >
                  <Trash2 size={19} />
                  <span className="grok-row-label">{t('永久删除 Bot', 'Permanently Delete Bot')}</span>
                </button>
              </>
            )}
          </section>
          <ReservedSlot minHeight={52} align="start">
            <ErrorNotice error={action.error} stale={action.errorStale} onDismiss={() => action.setError('')} />
          </ReservedSlot>
        </section>
      </div>
      <ConfirmDialog
        open={discardConfirmOpen && cwdDirty}
        title={t('放弃未保存的工作目录修改？', 'Discard unsaved working directory changes?')}
        description={t('工作目录有未保存的修改，返回将丢弃这些更改。', 'Your working directory edits have not been saved. Going back will discard them.')}
        danger
        busy={action.busy}
        confirmLabel={t('放弃修改', 'Discard')}
        cancelLabel={t('继续编辑', 'Keep editing')}
        onCancel={() => {
          if (!action.busy) setDiscardConfirmOpen(false);
        }}
        onConfirm={() => {
          if (action.busy) return;
          setDiscardConfirmOpen(false);
          if (onDiscardEditCwd) {
            onDiscardEditCwd();
          } else {
            onChangeEditCwd(editCwdBaseline);
            onDismissCwdSaveError();
          }
          onBack();
        }}
      />
    </main>
  );
}

export interface BotAvatarScreenProps {
  activeBot: MobileBotItem | null;
  avatarTab: 'shape' | 'expression';
  onChangeAvatarTab(tab: 'shape' | 'expression'): void;
  draftAvatar: GrokAvatarPreset;
  setDraftAvatar: Dispatch<SetStateAction<GrokAvatarPreset>>;
  action: ActionController;
  onBack(): void;
  onDone(): void;
}

export function BotAvatarScreen({
  activeBot,
  avatarTab,
  onChangeAvatarTab,
  draftAvatar,
  setDraftAvatar,
  action,
  onBack,
  onDone,
}: BotAvatarScreenProps) {
  const t = useText();
  const baseId = useId();
  const shapeTabId = `${baseId}-shape-tab`;
  const exprTabId = `${baseId}-expr-tab`;
  const shapePanelId = `${baseId}-shape-panel`;
  const exprPanelId = `${baseId}-expr-panel`;
  const shapeTabRef = useRef<HTMLButtonElement>(null);
  const exprTabRef = useRef<HTMLButtonElement>(null);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextTab: 'shape' | 'expression' | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      nextTab = avatarTab === 'shape' ? 'expression' : 'shape';
    } else if (event.key === 'Home') {
      nextTab = 'shape';
    } else if (event.key === 'End') {
      nextTab = 'expression';
    }
    if (!nextTab) return;
    event.preventDefault();
    onChangeAvatarTab(nextTab);
    requestAnimationFrame(() => {
      (nextTab === 'shape' ? shapeTabRef : exprTabRef).current?.focus();
    });
  };

  return (
    <main className="grok-subpage grok-page-enter">
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          aria-label={t('返回', 'Back')}
          onClick={onBack}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="grok-subpage-header-title">
          {activeBot ? t(`${activeBot.role} · 头像`, `${activeBot.role} · Avatar`) : t('选择头像', 'Choose avatar')}
        </h2>
        <button
          type="button"
          className="grok-done-pill-btn"
          disabled={action.busy}
          onClick={onDone}
        >
          {t('完成', 'Done')}
        </button>
      </header>

      <div className="grok-subpage-scroll">
        {/* Top Segmented Tabs */}
        <div
          className="grok-segmented-tabs"
          role="tablist"
          aria-label={t('头像样式选项', 'Avatar style options')}
        >
          <button
            ref={shapeTabRef}
            id={shapeTabId}
            type="button"
            role="tab"
            aria-selected={avatarTab === 'shape'}
            aria-controls={shapePanelId}
            tabIndex={avatarTab === 'shape' ? 0 : -1}
            className={avatarTab === 'shape' ? 'active' : ''}
            onClick={() => onChangeAvatarTab('shape')}
            onKeyDown={handleTabKeyDown}
          >
            {t('形状', 'Shape')}
          </button>
          <button
            ref={exprTabRef}
            id={exprTabId}
            type="button"
            role="tab"
            aria-selected={avatarTab === 'expression'}
            aria-controls={exprPanelId}
            tabIndex={avatarTab === 'expression' ? 0 : -1}
            className={avatarTab === 'expression' ? 'active' : ''}
            onClick={() => onChangeAvatarTab('expression')}
            onKeyDown={handleTabKeyDown}
          >
            {t('表情', 'Expression')}
          </button>
        </div>

        {/* Large Centered Live Preview */}
        <div className="grok-avatar-big-preview">
          <GrokBotAvatar preset={draftAvatar} size={118} />
        </div>

        {/* Avatar shapes, expressions and online colors. */}
        <section className="grok-avatar-card">
          {avatarTab === 'shape' ? (
            <div
              id={shapePanelId}
              role="tabpanel"
              aria-labelledby={shapeTabId}
              className="grok-shapes-grid"
            >
              {GROK_SHAPE_ORDER.map(item => {
                const selected = draftAvatar.shape === item.shape;
                const itemPreset: GrokAvatarPreset = {
                  ...draftAvatar,
                  id: `${item.shape}-${draftAvatar.color}`,
                  shape: item.shape,
                  rotation: item.rotation,
                };
                return (
                  <button
                    key={item.shape}
                    type="button"
                    className={`grok-shape-cell${selected ? ' selected' : ''}`}
                    onClick={() =>
                      setDraftAvatar(prev => ({
                        ...prev,
                        id: `${item.shape}-${prev.color}`,
                        shape: item.shape,
                        rotation: item.rotation,
                      }))
                    }
                    aria-label={t(`形状：${item.labelZh}`, `Shape: ${item.labelEn}`)}
                    aria-pressed={selected}
                  >
                    <GrokBotAvatar preset={itemPreset} size={46} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div
              id={exprPanelId}
              role="tabpanel"
              aria-labelledby={exprTabId}
              className="grok-expressions-grid"
            >
              {GROK_EXPRESSION_LIST.map(expr => {
                const selected = draftAvatar.expressionIndex === expr.index;
                const exprPreset: GrokAvatarPreset = {
                  ...draftAvatar,
                  expressionIndex: expr.index,
                };
                return (
                  <button
                    key={expr.index}
                    type="button"
                    className={`grok-expression-cell${selected ? ' selected' : ''}`}
                    onClick={() =>
                      setDraftAvatar(prev => ({
                        ...prev,
                        expressionIndex: expr.index,
                      }))
                    }
                    aria-label={t(`表情：${expr.labelZh}`, `Expression: ${expr.labelEn}`)}
                    aria-pressed={selected}
                  >
                    <GrokBotAvatar preset={exprPreset} size={52} />
                    <span>{t(expr.labelZh, expr.labelEn)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Selectable Color Swatches */}
          <div className="grok-colors-grid" role="group" aria-label={t('选择颜色', 'Choose color')}>
            {GROK_COLOR_PALETTE.map(c => {
              const selected = draftAvatar.color.toLowerCase() === c.hex.toLowerCase();
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`grok-color-swatch${selected ? ' selected' : ''}`}
                  onClick={() =>
                    setDraftAvatar(prev => ({
                      ...prev,
                      id: `${prev.shape}-${c.id}`,
                      color: c.hex,
                    }))
                  }
                  aria-label={t(`颜色：${c.labelZh}`, `Color: ${c.labelEn}`)}
                  title={t(c.labelZh, c.labelEn)}
                  aria-pressed={selected}
                >
                  <span style={{ backgroundColor: c.hex }} />
                </button>
              );
            })}
          </div>

          <div className="grok-avatar-card-footer">
            <button
              type="button"
              className="grok-reset-link"
              onClick={() => {
                const def = activeBot
                  ? getDefaultBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)
                  : JARVIS_AVATAR_PRESET;
                setDraftAvatar({ ...def });
              }}
            >
              {t('重置为默认', 'Reset to default')}
            </button>
          </div>
        </section>
        <ReservedSlot minHeight={52} align="start">
          <ErrorNotice error={action.error} stale={action.errorStale} onDismiss={() => action.setError('')} />
        </ReservedSlot>
      </div>
    </main>
  );
}

export interface BotSoulScreenProps {
  activeBot: MobileBotItem | null;
  soulDraft: string;
  setSoulDraft: Dispatch<SetStateAction<string>>;
  soulDirty: boolean;
  setSoulDirty(dirty: boolean): void;
  soulSaved: boolean;
  soulDraftBytes: number;
  soulByteRatio: number;
  soulLoading?: boolean;
  soulError?: string;
  onRetryLoad?: () => void;
  action: ActionController;
  onBack(): void;
  onDiscardAndBack?: () => void;
  onSave(): void;
  onReload(bot: UnifiedBotItem): void;
}

export function BotSoulScreen({
  activeBot,
  soulDraft,
  setSoulDraft,
  soulDirty,
  setSoulDirty,
  soulSaved,
  soulDraftBytes,
  soulByteRatio,
  soulLoading = false,
  soulError = '',
  onRetryLoad,
  action,
  onBack,
  onDiscardAndBack,
  onSave,
  onReload,
}: BotSoulScreenProps) {
  const t = useText();
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const initialLoading = soulLoading && !soulDraft && !soulDirty;
  const initialLoadFailed = Boolean(soulError) && !soulDraft && !soulDirty && !soulLoading;

  useEffect(() => {
    if (!soulDirty) setDiscardConfirmOpen(false);
  }, [soulDirty]);

  const handleRequestBack = useCallback(() => {
    if (action.busy) return;
    if (soulDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onBack();
  }, [action.busy, soulDirty, onBack]);

  const handleBackRef = useRef(handleRequestBack);
  handleBackRef.current = handleRequestBack;
  const interceptBack = Boolean(soulDirty || action.busy);

  useEffect(() => {
    if (!interceptBack) return;
    return registerOverlayBackHandler(() => handleBackRef.current());
  }, [interceptBack]);

  return (
    <main className="grok-subpage grok-page-enter">
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          aria-label={t('返回', 'Back')}
          disabled={action.busy}
          onClick={handleRequestBack}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="grok-subpage-header-title">
          {activeBot ? t(`${activeBot.role} · 人设`, `${activeBot.role} · Persona`) : t('人设', 'Persona')}
        </h2>
        <button
          type="button"
          className="grok-done-pill-btn"
          disabled={action.busy || initialLoading || initialLoadFailed || soulDraftBytes > SOUL_MAX_BYTES}
          onClick={onSave}
        >
          <LabelStack
            active={action.busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}
            labels={[t('保存中…', 'Saving…'), t('保存', 'Save')]}
          />
        </button>
      </header>

      <div className="grok-subpage-scroll">
        {soulError ? (
          <InlineBanner
            tone="danger"
            title={t('人设加载失败', 'Failed to load persona')}
            detail={soulError}
            actions={
              activeBot ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => (onRetryLoad ? onRetryLoad() : onReload(activeBot))}
                >
                  {t('重试', 'Retry')}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {initialLoading ? (
          <section className="grok-card-group profile-loading-card">
            <UiSkeleton lines={5} label={t('正在加载人设…', 'Loading persona…')} />
          </section>
        ) : !initialLoadFailed ? (
          <>
            <div className="soul-snippet-bar">
              {SOUL_SNIPPETS.map(item => (
                <button
                  key={item.zh}
                  type="button"
                  className="snippet-chip"
                  onClick={() => {
                    setSoulDraft(prev => (prev ? prev.trimEnd() + '\n' : '') + item.text.trimStart());
                    setSoulDirty(true);
                  }}
                >
                  {t(item.zh, item.en)}
                </button>
              ))}
              {soulDraft.length > 0 && (
                <button
                  type="button"
                  className="snippet-chip danger"
                  disabled={action.busy}
                  onClick={() => setClearConfirmOpen(true)}
                >
                  {t('清空', 'Clear')}
                </button>
              )}
            </div>

            <section className="grok-card-group avatar-soul-card">
              <textarea
                className="grok-soul-textarea"
                rows={14}
                spellCheck={false}
                aria-label={t('核心人设内容', 'Persona instructions')}
                value={soulDraft}
                onChange={e => {
                  setSoulDraft(e.target.value);
                  setSoulDirty(true);
                }}
                placeholder={t('# 核心人设\n在这里编写 Bot 的身份、说话语气、专业领域和行为边界…', '# Core Persona\nWrite the Bot identity, tone, expertise, and boundaries here…')}
              />
              <div className="soul-meta-row">
                <span className="soul-meta-status">
                  {soulSaved ? t('已保存', 'Saved') : t('未保存修改', 'Unsaved changes')}
                </span>
                <span className="soul-meta-count">
                  {soulByteRatio > 0.8 && (
                    <span className={`soul-meta-limit${soulDraftBytes > SOUL_MAX_BYTES ? ' over' : ''}`}>
                      {soulDraftBytes > SOUL_MAX_BYTES
                        ? t('超出上限', 'Over limit')
                        : t('接近上限', 'Near limit')}
                    </span>
                  )}
                  {t(`${soulDraft.length} 字`, `${soulDraft.length} chars`)}
                </span>
              </div>
              {soulByteRatio > 0.8 && (
                <div className="soul-byte-progress">
                  <div className="soul-byte-bar">
                    <div
                      className={`soul-byte-fill${soulDraftBytes > SOUL_MAX_BYTES ? ' over' : ''}`}
                      style={{ width: `${Math.min(100, Math.round(soulByteRatio * 100))}%` }}
                    />
                  </div>
                </div>
              )}
            </section>
            <p className="grok-card-footnote">
              {t('定义该 Bot 的人设、语气风格与行动准则，每次对话会自动生效。', 'Defines the persona, tone, and principles automatically applied in every conversation.')}
            </p>

            {soulDirty && activeBot && (
              <section className="grok-card-group">
                <button
                  type="button"
                  className="grok-card-row"
                  onClick={() => onReload(activeBot)}
                >
                  <RefreshCw size={18} className="grok-row-icon" aria-hidden="true" />
                  <span className="grok-row-label">{t('放弃未保存修改', 'Discard unsaved changes')}</span>
                </button>
              </section>
            )}
          </>
        ) : null}

        <ReservedSlot minHeight={52} align="start">
          <ErrorNotice error={action.error} stale={action.errorStale} onDismiss={() => action.setError('')} />
        </ReservedSlot>
      </div>
      <ConfirmDialog
        open={clearConfirmOpen && soulDraft.length > 0}
        title={t('清空人设内容？', 'Clear persona draft?')}
        description={t('将清空当前编辑器中的全部人设内容，保存前仍可通过「放弃未保存修改」恢复。', 'This will clear all persona text in the editor. You can still discard unsaved changes before saving.')}
        danger
        confirmLabel={t('清空', 'Clear')}
        cancelLabel={t('取消', 'Cancel')}
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={() => {
          setClearConfirmOpen(false);
          setSoulDraft('');
          setSoulDirty(true);
        }}
      />
      <ConfirmDialog
        open={discardConfirmOpen && soulDirty}
        title={t('放弃未保存的人设修改？', 'Discard unsaved persona changes?')}
        description={t('当前人设内容有未保存的修改，返回将丢弃这些更改。', 'Your persona edits have not been saved. Going back will discard them.')}
        danger
        busy={action.busy}
        confirmLabel={t('放弃修改', 'Discard')}
        cancelLabel={t('继续编辑', 'Keep editing')}
        onCancel={() => {
          if (!action.busy) setDiscardConfirmOpen(false);
        }}
        onConfirm={() => {
          if (action.busy) return;
          setDiscardConfirmOpen(false);
          if (onDiscardAndBack) {
            onDiscardAndBack();
          } else {
            setSoulDirty(false);
            action.setError('');
            onBack();
          }
        }}
      />
    </main>
  );
}

export interface BotSchedulesScreenProps {
  activeBot: MobileBotItem;
  botDisplayName: string;
  botScheduleState: BotScheduleState & { botKey?: string };
  scheduleTasks: BotScheduleTask[];
  scheduleError?: string;
  schedulesLoading?: boolean;
  schedulesLoadError?: string;
  onRetryLoad?: () => void;
  scheduleOffline: boolean;
  scheduleFilter: 'all' | 'enabled' | 'paused';
  onChangeScheduleFilter(next: 'all' | 'enabled' | 'paused'): void;
  scheduleEditing: 'new' | 'edit' | null;
  scheduleDirty?: boolean;
  onCancelEditing(): void;
  scheduleDraft: BotScheduleDraft;
  setScheduleDraft: Dispatch<SetStateAction<BotScheduleDraft>>;
  scheduleCustomWeekdays: boolean;
  setScheduleCustomWeekdays(v: boolean): void;
  scheduleDeleteTarget: BotScheduleTask | null;
  setScheduleDeleteTarget(task: BotScheduleTask | null): void;
  action: ActionController;
  onBack(): void;
  onOpenCreate(): void;
  onOpenEdit(task: BotScheduleTask): void;
  onSaveSchedule(): void;
  onToggleSchedule(task: BotScheduleTask, next: boolean): void;
  onDeleteSchedule(task: BotScheduleTask): void;
  onRequestExactAlarm(): void;
}

export function BotSchedulesScreen({
  activeBot,
  botDisplayName,
  botScheduleState,
  scheduleTasks,
  scheduleError,
  schedulesLoading = false,
  schedulesLoadError = '',
  onRetryLoad,
  scheduleOffline,
  scheduleFilter,
  onChangeScheduleFilter,
  scheduleEditing,
  scheduleDirty = false,
  onCancelEditing,
  scheduleDraft,
  setScheduleDraft,
  scheduleCustomWeekdays,
  setScheduleCustomWeekdays,
  scheduleDeleteTarget,
  setScheduleDeleteTarget,
  action,
  onBack,
  onOpenCreate,
  onOpenEdit,
  onSaveSchedule,
  onToggleSchedule,
  onDeleteSchedule,
  onRequestExactAlarm,
}: BotSchedulesScreenProps) {
  const t = useText();
  const schedulePromptId = useId();
  const scheduleRepeatId = useId();
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const hasLoadedBotSchedules = botScheduleState.botKey === activeBot.key;
  const initialSchedulesLoading = schedulesLoading && !hasLoadedBotSchedules;
  const initialSchedulesFailed = Boolean(schedulesLoadError) && !hasLoadedBotSchedules && !schedulesLoading;

  useEffect(() => {
    if (!scheduleEditing || !scheduleDirty) setDiscardConfirmOpen(false);
  }, [scheduleEditing, scheduleDirty]);

  const handleRequestBack = useCallback(() => {
    if (scheduleEditing !== null) {
      if (action.busy) return;
      if (scheduleDirty) {
        setDiscardConfirmOpen(true);
        return;
      }
      onCancelEditing();
      return;
    }
    onBack();
  }, [scheduleEditing, action.busy, scheduleDirty, onCancelEditing, onBack]);

  const handleBackRef = useRef(handleRequestBack);
  handleBackRef.current = handleRequestBack;
  const interceptBack = scheduleEditing !== null;

  useEffect(() => {
    if (!interceptBack) return;
    return registerOverlayBackHandler(() => handleBackRef.current());
  }, [interceptBack]);

  return (
    <main className="grok-subpage grok-page-enter">
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          aria-label={t('返回', 'Back')}
          disabled={Boolean(scheduleEditing && action.busy)}
          onClick={handleRequestBack}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="grok-subpage-header-title">
          {scheduleEditing
            ? scheduleDraft.id
              ? t(`${botDisplayName} · 编辑定时任务`, `${botDisplayName} · Edit schedule`)
              : t(`${botDisplayName} · 新建定时任务`, `${botDisplayName} · New schedule`)
            : t(`${botDisplayName} · 定时任务`, `${botDisplayName} · Schedules`)}
        </h2>
        {scheduleEditing ? (
          <button
            type="button"
            className="grok-done-pill-btn"
            disabled={action.busy || scheduleOffline || !scheduleDraft.prompt.trim()}
            onClick={onSaveSchedule}
          >
            <LabelStack
              active={action.busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}
              labels={[t('保存中…', 'Saving…'), t('保存', 'Save')]}
            />
          </button>
        ) : (
          <button
            type="button"
            className="grok-done-pill-btn"
            disabled={action.busy || scheduleOffline}
            onClick={onOpenCreate}
          >
            <Plus size={16} className="grok-icon-mr-4" aria-hidden="true" />
            {t('新建', 'New')}
          </button>
        )}
      </header>

      {!scheduleEditing ? (
        <div className="grok-subpage-scroll">
          {(scheduleFilter !== 'all' ||
            (scheduleTasks.some(task => task.enabled !== false) && scheduleTasks.some(task => task.enabled === false))) && (
            <div className="grok-schedule-filter-bar" role="group" aria-label={t('按任务状态筛选', 'Filter by schedule status')}>
              {([
                { id: 'all', label: t('全部', 'All') },
                { id: 'enabled', label: t('已开启', 'Active') },
                { id: 'paused', label: t('已暂停', 'Paused') },
              ] as const).map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={scheduleFilter === tab.id}
                  className={`grok-schedule-filter-tab${scheduleFilter === tab.id ? ' active' : ''}`}
                  onClick={() => onChangeScheduleFilter(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {scheduleOffline && (
            <InlineBanner
              tone="neutral"
              compact
              role="status"
              title={t('目标设备离线，连接后可修改定时任务。', 'The target device is offline. Reconnect to change schedules.')}
            />
          )}

          {schedulesLoadError ? (
            <InlineBanner
              tone="danger"
              title={t('定时任务加载失败', 'Failed to load schedules')}
              detail={schedulesLoadError}
              actions={
                onRetryLoad ? (
                  <Button variant="secondary" size="sm" onClick={onRetryLoad}>
                    {t('重试', 'Retry')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {hasLoadedBotSchedules && !botScheduleState.exactAlarmGranted && (
            <InlineBanner
              tone="attention"
              title={t('精确闹钟权限未开启', 'Exact alarm permission needed')}
              detail={t('开启后可保证定时任务在锁屏与后台状态下准点唤醒该 Bot 执行。', 'Grant exact alarm permission for punctual background execution.')}
              actions={
                <Button variant="primary" size="sm" onClick={onRequestExactAlarm}>
                  {t('去授权', 'Grant')}
                </Button>
              }
            />
          )}

          {initialSchedulesLoading ? (
            <section className="grok-card-group profile-loading-card">
              <UiSkeleton lines={3} label={t('正在加载定时任务…', 'Loading schedules…')} />
            </section>
          ) : initialSchedulesFailed ? null : (() => {
            const filteredTasks = scheduleTasks.filter(task => {
              if (scheduleFilter === 'enabled') return task.enabled !== false;
              if (scheduleFilter === 'paused') return task.enabled === false;
              return true;
            });

            if (filteredTasks.length === 0) {
              return (
                <section className="grok-card-group grok-schedule-empty">
                  <Clock size={32} className="grok-row-icon" aria-hidden="true" />
                  <h4>
                    {scheduleOffline && !hasLoadedBotSchedules
                      ? t('暂无可查看的任务记录', 'No schedule records available')
                      : scheduleFilter === 'enabled'
                        ? t('暂无已开启的定时任务', 'No active schedules')
                        : scheduleFilter === 'paused'
                          ? t('暂无已暂停的定时任务', 'No paused schedules')
                          : t(`还没有为「${botDisplayName}」设置定时任务`, `No schedules for ${botDisplayName}`)}
                  </h4>
                  <p>
                    {t('定时任务到点后会自动唤醒该 Bot 执行指令（例如：每日早报汇总、待办提醒、定时巡检）。', 'Scheduled tasks wake this Bot at the specified time to run your prompt automatically.')}
                  </p>
                  <button
                    type="button"
                    className="grok-done-pill-btn grok-btn-mt-8"
                    disabled={action.busy || scheduleOffline}
                    onClick={onOpenCreate}
                  >
                    <Plus size={16} className="grok-icon-mr-4" aria-hidden="true" />
                    {t('新建定时任务', 'Create Schedule')}
                  </button>
                </section>
              );
            }

            return (
              <div className="grok-card-group grok-schedule-list">
                {filteredTasks.map(task => {
                  const isEnabled = task.enabled !== false;
                  const prompt = Array.from(task.prompt?.trim().replace(/\s+/g, ' ') ?? '');
                  const promptTitle = prompt.slice(0, 48).join('') + (prompt.length > 48 ? '…' : '');
                  const title = task.title?.trim() || promptTitle ||
                    t('未命名定时任务', 'Untitled schedule');
                  const latestStatus = task.latestRun?.status;
                  const runNotice = latestStatus === 'unconfirmed'
                    ? t('上次结果待确认', 'Last run unconfirmed')
                    : latestStatus === 'unanswered'
                      ? t('上次未完成', 'Last run incomplete')
                      : latestStatus === 'not_sent' || latestStatus === 'skipped_offline' || latestStatus === 'skipped_capacity'
                        ? t('上次未执行', 'Last run skipped')
                        : '';
                  return (
                    <div key={task.id} className="grok-schedule-row">
                      <button
                        type="button"
                        className="grok-schedule-entry"
                        disabled={action.busy}
                        onClick={() => onOpenEdit(task)}
                      >
                        <span className="grok-schedule-title">{title}</span>
                        <span className="grok-schedule-next">
                          {isEnabled
                            ? t('下次执行 · ', 'Next run · ') + formatScheduleNextRun(task.nextRunAt, botScheduleState.timeZone, t, Boolean(task.date))
                            : t('已暂停', 'Paused')}
                          {runNotice && <span className="grok-schedule-run-notice">{` · ${runNotice}`}</span>}
                        </span>
                      </button>
                      <div className="grok-schedule-toggle">
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={next => onToggleSchedule(task, next)}
                          disabled={action.busy || scheduleOffline}
                          aria-label={t(`启用任务「${title}」`, `Enable schedule “${title}”`)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <ReservedSlot minHeight={52} align="start">
            <ErrorNotice
              error={action.error || scheduleError}
              stale={Boolean(action.error && action.errorStale)}
              onDismiss={action.error ? () => action.setError('') : undefined}
            />
          </ReservedSlot>
        </div>
      ) : (
        <div className="grok-subpage-scroll">
          {scheduleOffline && (
            <p className="grok-card-footnote" role="status">{t('目标设备离线，连接后可修改定时任务。', 'The target device is offline. Reconnect to change schedules.')}</p>
          )}
          {/* Time & Repeat Section */}
          <div className="grok-field-section">
            <h3 className="grok-section-label">{t('执行时间与周期', 'Time & Recurrence')}</h3>
            <section className="grok-card-group">
              <label className="grok-card-row grok-input-row">
                <span className="grok-input-label">{t('触发时间', 'Time')}</span>
                <input
                  type="time"
                  className="grok-inline-input grok-time-input"
                  value={scheduleDraft.time}
                  onChange={e => setScheduleDraft(prev => ({ ...prev, time: e.target.value || '09:00' }))}
                />
              </label>

              <div className="grok-card-row no-active">
                <label className="grok-row-label" htmlFor={scheduleRepeatId}>{t('重复周期', 'Repeat')}</label>
                <span className="grok-select-wrap">
                  <select
                    id={scheduleRepeatId}
                    aria-label={t('重复周期', 'Repeat')}
                    value={
                      scheduleDraft.repeat === 'weekly' && !scheduleCustomWeekdays
                        ? scheduleDraft.weekdays.length === 5 &&
                          [1, 2, 3, 4, 5].every(d => scheduleDraft.weekdays.includes(d))
                          ? 'weekdays-mon-fri'
                          : scheduleDraft.weekdays.length === 2 &&
                              [6, 7].every(d => scheduleDraft.weekdays.includes(d))
                            ? 'weekends-sat-sun'
                            : 'weekly'
                        : scheduleDraft.repeat
                    }
                    onChange={e => {
                      const val = e.target.value;
                      if (val === 'weekdays-mon-fri') {
                        setScheduleCustomWeekdays(false);
                        setScheduleDraft(prev => ({
                          ...prev,
                          repeat: 'weekly',
                          weekdays: [1, 2, 3, 4, 5],
                          deleteAfterRun: false,
                        }));
                      } else if (val === 'weekends-sat-sun') {
                        setScheduleCustomWeekdays(false);
                        setScheduleDraft(prev => ({
                          ...prev,
                          repeat: 'weekly',
                          weekdays: [6, 7],
                          deleteAfterRun: false,
                        }));
                      } else if (val === 'weekly') {
                        setScheduleCustomWeekdays(true);
                        setScheduleDraft(prev => ({
                          ...prev,
                          repeat: 'weekly',
                          weekdays: prev.weekdays.length > 0 ? prev.weekdays : [1],
                          deleteAfterRun: false,
                        }));
                      } else {
                        setScheduleCustomWeekdays(false);
                        const mode = val as BotScheduleDraft['repeat'];
                        setScheduleDraft(prev => ({
                          ...prev,
                          repeat: mode,
                          deleteAfterRun: mode === 'once' ? prev.deleteAfterRun : false,
                        }));
                      }
                    }}
                  >
                    <option value="daily">{t('每天', 'Daily')}</option>
                    <option value="statutoryWorkday">{t('法定工作日', 'Statutory Workdays')}</option>
                    <option value="statutoryHoliday">{t('法定节假日', 'Statutory Holidays')}</option>
                    <option value="weekdays-mon-fri">{t('每周一至周五', 'Mon–Fri')}</option>
                    <option value="weekends-sat-sun">{t('周末', 'Weekends')}</option>
                    <option value="weekly">{t('自定义每周几…', 'Custom Weekdays…')}</option>
                    <option value="monthly">{t('每月固定日期', 'Monthly')}</option>
                    <option value="once">{t('仅一次', 'Once')}</option>
                  </select>
                  <ChevronsUpDown size={15} aria-hidden="true" />
                </span>
              </div>

              {scheduleDraft.repeat === 'once' && (
                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('执行日期（可选）', 'Date (optional)')}</span>
                  <input
                    type="date"
                    className="grok-inline-input grok-time-input"
                    max="9999-12-31"
                    value={scheduleDraft.date ?? ''}
                    disabled={action.busy || scheduleOffline}
                    onChange={e => setScheduleDraft(prev => ({ ...prev, date: e.target.value }))}
                  />
                </label>
              )}

              {scheduleDraft.repeat === 'weekly' && scheduleCustomWeekdays && (
                <div className="grok-card-row grok-weekday-row">
                  {[
                    { day: 1, zh: '一', en: 'M', fullZh: '星期一', fullEn: 'Monday' }, // i18n-ok
                    { day: 2, zh: '二', en: 'T', fullZh: '星期二', fullEn: 'Tuesday' }, // i18n-ok
                    { day: 3, zh: '三', en: 'W', fullZh: '星期三', fullEn: 'Wednesday' }, // i18n-ok
                    { day: 4, zh: '四', en: 'T', fullZh: '星期四', fullEn: 'Thursday' }, // i18n-ok
                    { day: 5, zh: '五', en: 'F', fullZh: '星期五', fullEn: 'Friday' }, // i18n-ok
                    { day: 6, zh: '六', en: 'S', fullZh: '星期六', fullEn: 'Saturday' }, // i18n-ok
                    { day: 7, zh: '日', en: 'S', fullZh: '星期日', fullEn: 'Sunday' }, // i18n-ok
                  ].map(item => {
                    const active = scheduleDraft.weekdays.includes(item.day);
                    return (
                      <button
                        key={item.day}
                        type="button"
                        className={`grok-weekday-chip${active ? ' active' : ''}`}
                        aria-pressed={active}
                        aria-label={t(item.fullZh, item.fullEn)}
                        onClick={() => {
                          setScheduleDraft(prev => {
                            const exists = prev.weekdays.includes(item.day);
                            const next = exists
                              ? prev.weekdays.filter(d => d !== item.day)
                              : [...prev.weekdays, item.day].sort((a, b) => a - b);
                            return { ...prev, weekdays: next.length > 0 ? next : [item.day] };
                          });
                        }}
                      >
                        {t(item.zh, item.en)}
                      </button>
                    );
                  })}
                </div>
              )}

              {scheduleDraft.repeat === 'monthly' && (
                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('每月几号', 'Day of Month')}</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className="grok-inline-input"
                    value={scheduleDraft.monthDay}
                    onChange={e => {
                      const d = Math.max(1, Math.min(31, Number(e.target.value) || 1));
                      setScheduleDraft(prev => ({ ...prev, monthDay: d }));
                    }}
                  />
                </label>
              )}
            </section>
            {scheduleDraft.repeat === 'once' && (
              <p className="grok-card-footnote">
                {t('按目标设备时区计算；不选日期则在下一次到点时执行。',
                  'Uses the target device’s time zone. With no date, runs at the next matching time.')}
              </p>
            )}
          </div>

          {/* Task Content Section */}
          <div className="grok-field-section">
            <h3 className="grok-section-label">{t('任务标题与执行指令', 'Task Title & Prompt')}</h3>
            <section className="grok-card-group">
              <label className="grok-card-row grok-input-row">
                <span className="grok-input-label">{t('任务名称', 'Title')}</span>
                <input
                  className="grok-inline-input"
                  value={scheduleDraft.title}
                  onChange={e => setScheduleDraft(prev => ({ ...prev, title: e.target.value }))}
                  placeholder={t('例如：每日科技早报、下班打卡提醒', 'e.g. Daily briefing, Standup reminder')}
                />
              </label>
              <div className="grok-card-textarea-wrap">
                <label htmlFor={schedulePromptId} className="sr-only">
                  {t('执行指令', 'Prompt instructions')}
                </label>
                <textarea
                  id={schedulePromptId}
                  rows={4}
                  value={scheduleDraft.prompt}
                  onChange={e => setScheduleDraft(prev => ({ ...prev, prompt: e.target.value }))}
                  placeholder={t('到点后发送给该 Bot 执行的指令内容，例如：汇总今天的日程与待办事项，并生成简短提醒。',
                    'Prompt sent to this Bot when triggered, e.g. Summarize my agenda and key tasks for today.')}
                />
                <ReservedSlot minHeight={20} align="start">
                  {!scheduleDraft.prompt.trim() && (
                    <div className="grok-schedule-prompt-hint">{t('填写指令后才能保存', 'Fill in the prompt to save')}</div>
                  )}
                </ReservedSlot>
              </div>
            </section>
          </div>

          {/* Reminder & Lifecycle Section */}
          <div className="grok-field-section">
            <h3 className="grok-section-label">{t('提醒方式与状态', 'Notification & Status')}</h3>
            <section className="grok-card-group">
              <div className="grok-card-row no-active">
                <span className="grok-row-label">{t('强提醒模式（响铃与弹窗）', 'Alarm Mode (Ring & Alert)')}</span>
                <Switch
                  checked={scheduleDraft.alarmMode === 'alarmClock'}
                  onCheckedChange={checked =>
                    setScheduleDraft(prev => ({
                      ...prev,
                      alarmMode: checked ? 'alarmClock' : 'exact',
                    }))
                  }
                  aria-label={t('强提醒模式（响铃与弹窗）', 'Alarm Mode (Ring & Alert)')}
                />
              </div>

              {scheduleDraft.alarmMode === 'alarmClock' && (
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('震动提醒', 'Vibrate')}</span>
                  <Switch
                    checked={scheduleDraft.vibrate}
                    onCheckedChange={checked => setScheduleDraft(prev => ({ ...prev, vibrate: checked }))}
                    aria-label={t('震动提醒', 'Vibrate')}
                  />
                </div>
              )}

              {scheduleDraft.repeat === 'once' && (
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('触发后自动删除任务', 'Delete After Run')}</span>
                  <Switch
                    checked={scheduleDraft.deleteAfterRun}
                    onCheckedChange={checked => setScheduleDraft(prev => ({ ...prev, deleteAfterRun: checked }))}
                    aria-label={t('触发后自动删除任务', 'Delete After Run')}
                  />
                </div>
              )}
            </section>
          </div>

          {scheduleDraft.id && (
            <section className="grok-card-group">
              <button
                type="button"
                className="grok-card-row danger-text"
                disabled={action.busy || scheduleOffline}
                onClick={() => {
                  const existing = scheduleTasks.find(task => task.id === scheduleDraft.id);
                  if (existing) {
                    action.setError('');
                    setScheduleDeleteTarget(existing);
                  }
                }}
              >
                <Trash2 size={18} />
                <span className="grok-row-label">{t('删除该定时任务', 'Delete Schedule')}</span>
              </button>
            </section>
          )}

          <ReservedSlot minHeight={52} align="start">
            <ErrorNotice
              error={scheduleDeleteTarget ? '' : action.error || scheduleError}
              stale={Boolean(!scheduleDeleteTarget && action.error && action.errorStale)}
              onDismiss={action.error ? () => action.setError('') : undefined}
            />
          </ReservedSlot>
        </div>
      )}
      <ConfirmDialog
        open={scheduleDeleteTarget !== null}
        title={t('删除定时任务', 'Delete schedule')}
        description={
          scheduleDeleteTarget
            ? t(`确定要删除定时任务「${scheduleDeleteTarget.title?.trim() || t('未命名定时任务', 'Untitled schedule')}」吗？此操作不可恢复。`, `Delete schedule "${scheduleDeleteTarget.title?.trim() || t('未命名定时任务', 'Untitled schedule')}"? This cannot be undone.`)
            : ''
        }
        danger
        busy={action.busy}
        confirmLabel={t('删除定时任务', 'Delete schedule')}
        cancelLabel={t('取消', 'Cancel')}
        onCancel={() => {
          if (!action.busy) setScheduleDeleteTarget(null);
        }}
        onConfirm={() => {
          if (!scheduleDeleteTarget || action.busy || scheduleOffline) return;
          mobileHaptic('confirm');
          const target = scheduleDeleteTarget;
          setScheduleDeleteTarget(null);
          onDeleteSchedule(target);
        }}
      />
      <ConfirmDialog
        open={discardConfirmOpen && scheduleEditing !== null && scheduleDirty}
        title={t('放弃未保存的定时任务修改？', 'Discard unsaved schedule changes?')}
        description={t('当前定时任务有未保存的修改，返回将丢弃这些更改。', 'Your schedule edits have not been saved. Going back will discard them.')}
        danger
        busy={action.busy}
        confirmLabel={t('放弃修改', 'Discard')}
        cancelLabel={t('继续编辑', 'Keep editing')}
        onCancel={() => {
          if (!action.busy) setDiscardConfirmOpen(false);
        }}
        onConfirm={() => {
          if (action.busy) return;
          setDiscardConfirmOpen(false);
          action.setError('');
          onCancelEditing();
        }}
      />
    </main>
  );
}
