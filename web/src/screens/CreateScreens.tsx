import { useEffect, useId } from 'react';
import { ArrowLeft, Check, Pencil, Search, X } from 'lucide-react';
import type { CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { DevicesDirectoryItem, MessageMember } from '../../../host-core/index.js';
import { GrokBotAvatar, resolveBotAvatarPreset, type GrokAvatarPreset } from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { ErrorNotice, useText } from '../ui';
import { useNotice } from '../notice';
import { LabelStack, ReservedSlot } from '../layout';
import { PlatformLogoIcon, type GroupCreateAttempt, type UnifiedBotItem } from '../hub/shared';
import { ActionBar, Button, InlineNotice, ListRow, Switch } from '../components/ui';
import type { ActionController, CreateBotAttempt } from './types';

const PRIMARY_BACK_NOTICE_ID = 'create-bot:primary-required';

export interface CreateBotScreenProps {
  mustCreatePrimaryBot: boolean;
  editMakePrimary: boolean;
  onChangeMakePrimary(checked: boolean): void;
  editName: string;
  onChangeName(next: string): void;
  editSubtitle: string;
  onChangeSubtitle(next: string): void;
  editCwd: string;
  onChangeCwd(next: string): void;
  editTargetHost: string;
  onChangeTargetHost(next: string): void;
  editAvatarPreset: GrokAvatarPreset;
  editModelRef: string;
  onChangeModelRef(next: string): void;
  createAttempt: CreateBotAttempt | null;
  onReconcileCreateAttempt(): void;
  onClearCreateAttempt(): void;
  hasRemoteConfigured: boolean;
  localDeviceId?: string | null;
  remoteDevices: DevicesDirectoryItem[];
  remoteConnected: boolean;
  createModelPicker: CenterModelPicker | null;
  createModelLoading: boolean;
  action: ActionController;
  primaryBackNotice?: { text: string; seq: number } | null;
  onDismissPrimaryBackNotice?(): void;
  onBack(): void;
  onSave(): void;
  onOpenAvatarPicker(preset: GrokAvatarPreset): void;
}

export function CreateBotScreen({
  mustCreatePrimaryBot,
  editMakePrimary,
  onChangeMakePrimary,
  editName,
  onChangeName,
  editSubtitle,
  onChangeSubtitle,
  editCwd,
  onChangeCwd,
  editTargetHost,
  onChangeTargetHost,
  editAvatarPreset,
  editModelRef,
  onChangeModelRef,
  createAttempt,
  onReconcileCreateAttempt,
  onClearCreateAttempt,
  hasRemoteConfigured,
  localDeviceId,
  remoteDevices,
  remoteConnected,
  createModelPicker,
  createModelLoading,
  action,
  primaryBackNotice,
  onBack,
  onSave,
  onOpenAvatarPicker,
}: CreateBotScreenProps) {
  const t = useText();
  const { notify, dismiss } = useNotice();
  const createNameId = useId();
  const createSubtitleId = useId();
  const createCwdId = useId();
  const createHostId = useId();
  const createModelId = useId();

  const hasPrimaryBackNotice = Boolean(primaryBackNotice);
  const primaryBackNoticeSeq = primaryBackNotice?.seq;
  const primaryBackNoticeText = primaryBackNotice?.text ?? '';

  useEffect(() => {
    if (!hasPrimaryBackNotice || !primaryBackNoticeText) {
      dismiss(PRIMARY_BACK_NOTICE_ID);
      return;
    }
    notify({
      id: PRIMARY_BACK_NOTICE_ID,
      tone: 'warning',
      title: primaryBackNoticeText,
      durationMs: 3000,
    });
  }, [hasPrimaryBackNotice, primaryBackNoticeSeq, primaryBackNoticeText, notify, dismiss]);

  useEffect(() => {
    return () => {
      dismiss(PRIMARY_BACK_NOTICE_ID);
    };
  }, [dismiss]);

  return (
    <main className="grok-subpage grok-page-enter">
      <header className="grok-subpage-topbar">
        {mustCreatePrimaryBot ? (
          <span className="bot-profile-topbar-spacer" />
        ) : (
          <button
            type="button"
            className="grok-floating-circle-btn"
            aria-label={t('返回', 'Back')}
            onClick={onBack}
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <h2 className="grok-subpage-header-title">
          {mustCreatePrimaryBot || editMakePrimary
            ? t('创建主 Bot', 'Create Primary Bot')
            : t('新建 Bot', 'New Bot')}
        </h2>
        <button
          type="button"
          className="grok-done-pill-btn"
          disabled={action.busy || !editName.trim()}
          onClick={onSave}
        >
          <LabelStack
            active={action.busy ? t('保存中', 'Saving') : t('完成', 'Done')}
            labels={[t('保存中', 'Saving'), t('完成', 'Done')]}
          />
        </button>
      </header>

      <div className="grok-subpage-scroll">
        {mustCreatePrimaryBot && (
          <InlineNotice
            tone="info"
            title={t('当前设备尚未创建主 Bot', 'Primary Bot Required')}
            description={t('每台设备至少需要一个主 Bot。请先创建本机主 Bot 后再进入主页。', 'Every device requires at least one primary bot. Create one to enter the hub.')}
          />
        )}
        {createAttempt && (
          <div className="grok-field-section">
            <section className="grok-card-group grok-pending-freeze-card">
              <div className="grok-pending-freeze-head">
                <span className="grok-pending-freeze-badge">{t('创建回执未确认', 'Creation Unconfirmed')}</span>
                <code className="grok-pending-freeze-id">{createAttempt.requestId.slice(0, 12)}</code>
              </div>
              <p className="grok-pending-freeze-desc">
                {t('上次创建请求的回执尚未确认，请先按原请求 ID 对账，避免重复创建。', 'Previous creation receipt is unconfirmed. Reconcile the original request ID first.')}
              </p>
              <ActionBar align="end">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={action.busy}
                  onClick={onClearCreateAttempt}
                >
                  {t('清除冻结状态', 'Clear Freeze')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={action.busy}
                  disabled={action.busy}
                  onClick={onReconcileCreateAttempt}
                >
                  {t('按原 ID 对账', 'Reconcile Original ID')}
                </Button>
              </ActionBar>
            </section>
          </div>
        )}
        {/* Hero Avatar with Pencil Badge (15847.jpg) */}
        <section className="grok-profile-hero compact">
          <button
            type="button"
            className="grok-edit-avatar-wrap"
            onClick={() => onOpenAvatarPicker(editAvatarPreset)}
            aria-label={t('选择头像', 'Choose avatar')}
          >
            <GrokBotAvatar preset={editAvatarPreset} size={104} />
            <span className="grok-avatar-pencil-badge">
              <Pencil size={16} />
            </span>
          </button>
        </section>

        <div className="grok-field-section">
          <label className="grok-section-label" htmlFor={createNameId}>{t('名称', 'Name')}</label>
          <div className="grok-card-group">
            <input
              id={createNameId}
              className="grok-card-input"
              value={editName}
              onChange={e => onChangeName(e.target.value)}
              placeholder={t('输入 Bot 名称', 'Enter Bot name')}
            />
          </div>
        </div>

        <div className="grok-field-section">
          <label className="grok-section-label" htmlFor={createSubtitleId}>{t('标题', 'Subtitle')}</label>
          <div className="grok-card-group">
            <input
              id={createSubtitleId}
              className="grok-card-input"
              value={editSubtitle}
              onChange={e => onChangeSubtitle(e.target.value)}
              placeholder={t('描述 Bot 的用途（可选）', 'Describe what this Bot does (optional)')}
            />
          </div>
        </div>

        <div className="grok-field-section">
          <label className="grok-section-label" htmlFor={createCwdId}>{t('工作目录', 'Working directory')}</label>
          <div className="grok-card-group">
            <input
              id={createCwdId}
              className="grok-card-input"
              value={editCwd}
              onChange={e => onChangeCwd(e.target.value)}
              placeholder={t('目标主机上的绝对路径（留空用默认工作区）', 'Absolute path on the target host (blank uses default workspace)')}
            />
          </div>
        </div>

        <div className="grok-field-section">
          <label className="grok-section-label">{t('外观', 'Appearance')}</label>
          <div className="grok-card-group">
            <ListRow
              title={t('头像', 'Avatar')}
              value={t('形状与配色', 'Shape & color')}
              chevron
              onClick={() => onOpenAvatarPicker(editAvatarPreset)}
            />
          </div>
        </div>

        {hasRemoteConfigured && !mustCreatePrimaryBot && (
          <div className="grok-field-section">
            <label className="grok-section-label" htmlFor={createHostId}>{t('运行节点', 'Host')}</label>
            <div className="grok-card-group">
              <div className="grok-card-row no-active">
                <span className="grok-row-label">{t('所属节点', 'Node')}</span>
                <select
                  id={createHostId}
                  className="grok-inline-select"
                  style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '65%' }}
                  value={editTargetHost}
                  onChange={e => onChangeTargetHost(e.target.value)}
                >
                  <option value="local">{t('本机', 'Local')}</option>
                  {remoteDevices.filter(device => device.deviceId !== localDeviceId).map(device => (
                    <option key={device.deviceId} value={device.deviceId} disabled={!device.online}>
                      {device.displayName || device.deviceId}{device.platform ? ` · ${device.platform}` : ''}{device.online ? '' : t(' · 离线', ' · offline')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {!mustCreatePrimaryBot && (
          <div className="grok-field-section">
            <label className="grok-section-label">{t('主 Bot 设置', 'Primary Role')}</label>
            <div className="grok-card-group">
              <ListRow
                title={t('创建后设为该节点的主 Bot', 'Set as Primary Bot on this host')}
                trailing={
                  <Switch
                    checked={editMakePrimary}
                    onCheckedChange={onChangeMakePrimary}
                    aria-label={t('创建后设为该节点的主 Bot', 'Set as Primary Bot on this host')}
                  />
                }
              />
            </div>
          </div>
        )}

        <div className="grok-field-section">
          <label className="grok-section-label" htmlFor={remoteConnected && createModelPicker ? createModelId : undefined}>{t('模型', 'Model')}</label>
          <div className="grok-card-group">
            {remoteConnected && createModelPicker ? (
              <div className="grok-card-row no-active">
                <span className="grok-row-label">{t('使用模型', 'Model')}</span>
                <select
                  id={createModelId}
                  className="grok-inline-select"
                  style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '65%' }}
                  value={editModelRef}
                  onChange={e => onChangeModelRef(e.target.value)}
                >
                  <option value="">
                    {(() => {
                      const defaultRef = createModelPicker.defaultModel;
                      const matched = defaultRef
                        ? createModelPicker.models.find(m => m.modelRef === defaultRef)
                        : undefined;
                      const defaultLabel = matched?.name || defaultRef;
                      return defaultLabel
                        ? t(`跟随默认（${defaultLabel}）`, `Follow default (${defaultLabel})`)
                        : t('跟随默认', 'Follow default');
                    })()}
                  </option>
                  {createModelPicker.models.map(m => (
                    <option key={m.modelRef} value={m.modelRef}>
                      {m.name || m.modelRef}
                    </option>
                  ))}
                </select>
              </div>
            ) : createModelLoading ? (
              <ListRow
                title={t('正在加载中心模型列表…', 'Loading center models…')}
                statusTone="idle"
              />
            ) : (
              <ListRow
                title={t('未连接中心', 'Center not connected')}
                subtitle={t('创建后可在资料页绑定中心并选择模型', 'Bind to a center in Bot profile to choose a model')}
                statusTone="idle"
              />
            )}
          </div>
        </div>

        <ReservedSlot minHeight={52} align="start">
          <ErrorNotice error={action.error} stale={action.errorStale} onDismiss={() => action.setError('')} />
        </ReservedSlot>
      </div>
    </main>
  );
}

export interface CreateGroupScreenProps {
  allBotItems: UnifiedBotItem[];
  groupTitle: string;
  onChangeGroupTitle(next: string): void;
  groupMembers: MessageMember[];
  groupSearchQuery: string;
  onChangeGroupSearchQuery(next: string): void;
  groupCreating: boolean;
  groupCreateError: string;
  onDismissGroupCreateError(): void;
  groupCreateAttempt: GroupCreateAttempt | null;
  onDiscardGroupCreateAttempt(): void;
  onToggleGroupMember(bot: { deviceId: string; botId: string }): void;
  botIsOffline(bot: UnifiedBotItem): boolean;
  onBack(): void;
  onCreateGroup(): void;
  onOpenCreateBot(): void;
}

export function CreateGroupScreen({
  allBotItems,
  groupTitle,
  onChangeGroupTitle,
  groupMembers,
  groupSearchQuery,
  onChangeGroupSearchQuery,
  groupCreating,
  groupCreateError,
  onDismissGroupCreateError,
  groupCreateAttempt,
  onDiscardGroupCreateAttempt,
  onToggleGroupMember,
  botIsOffline,
  onBack,
  onCreateGroup,
  onOpenCreateBot,
}: CreateGroupScreenProps) {
  const t = useText();
  const groupTitleId = useId();
  const unarchivedCandidates = allBotItems.filter(item => !item.archivedAt);
  const q = groupSearchQuery.trim().toLowerCase();
  const filteredCandidates = q
    ? unarchivedCandidates.filter(
        item =>
          item.role.toLowerCase().includes(q) ||
          item.hostLabel.toLowerCase().includes(q) ||
          (item.description ?? '').toLowerCase().includes(q),
      )
    : unarchivedCandidates;
  const activeMembers = groupCreateAttempt ? groupCreateAttempt.members : groupMembers;
  const canSubmit = groupCreateAttempt
    ? !groupCreating
    : !groupCreating && activeMembers.length >= 2 && activeMembers.length <= 64 && [...groupTitle.trim()].length <= 120;

  const createGroupIdleLabel = groupCreateAttempt
    ? t('按原请求重试', 'Retry')
    : activeMembers.length >= 2
      ? t(`创建 (${activeMembers.length})`, `Create (${activeMembers.length})`)
      : t('创建', 'Create');
  const createGroupBusyLabel = t('创建中…', 'Creating…');
  const createGroupActiveLabel = groupCreating ? createGroupBusyLabel : createGroupIdleLabel;

  return (
    <main className="grok-subpage grok-page-enter" aria-label={t('创建群聊', 'Create Group Chat')}>
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          aria-label={t('返回', 'Back')}
          disabled={groupCreating}
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="grok-subpage-header-title">{t('创建群聊', 'Create Group Chat')}</h2>
        <button
          type="button"
          className="grok-done-pill-btn"
          disabled={!canSubmit}
          onClick={onCreateGroup}
        >
          <LabelStack
            active={createGroupActiveLabel}
            labels={[createGroupBusyLabel, createGroupIdleLabel, t('创建', 'Create'), t('按原请求重试', 'Retry')]}
          />
        </button>
      </header>

      <div className="grok-subpage-scroll">
        {groupCreateAttempt && (
          <InlineNotice
            tone="warning"
            title={t('上次建群请求尚未确认', 'Previous group request unconfirmed')}
            description={t('已冻结原请求 ID 与成员列表，点击右上角「按原请求重试」不会重复建群。', 'Original request ID and members are frozen so retrying will not duplicate the group.')}
            action={
              <Button
                variant="secondary"
                size="sm"
                disabled={groupCreating}
                onClick={onDiscardGroupCreateAttempt}
              >
                {t('放弃冻结并重新编辑', 'Discard & Edit Again')}
              </Button>
            }
          />
        )}

        <div className="grok-field-section">
          <label className="grok-section-label" htmlFor={groupTitleId}>{t('群名称（选填）', 'Group Name (Optional)')}</label>
          <div className="grok-card-group">
            <input
              id={groupTitleId}
              className="grok-card-input"
              value={groupCreateAttempt ? groupCreateAttempt.title ?? '' : groupTitle}
              onChange={e => onChangeGroupTitle(e.target.value)}
              maxLength={120}
              disabled={groupCreating || Boolean(groupCreateAttempt)}
              placeholder={t('留空则按成员名称自动生成', 'Leave blank to use member names')}
            />
          </div>
        </div>

        <div className="grok-field-section">
          <label className="grok-section-label">
            {t(`选择成员（已选 ${activeMembers.length} 位，至少 2 位）`,
              `Select Members (${activeMembers.length} selected, min 2)`)}
          </label>

          {activeMembers.length > 0 && (
            <div className="group-create-chips">
              {activeMembers.map(member => {
                const matched = allBotItems.find(
                  item => item.deviceId === member.deviceId && item.botId === member.botId,
                );
                const label = matched?.role || member.botId;
                return (
                  <button
                    key={`${member.deviceId}:${member.botId}`}
                    type="button"
                    className="group-create-chip"
                    disabled={groupCreating || Boolean(groupCreateAttempt)}
                    onClick={() => onToggleGroupMember(member)}
                    aria-label={t(`移除 ${label}`, `Remove ${label}`)}
                  >
                    {matched ? (
                      <GrokBotAvatar
                        preset={resolveBotAvatarPreset(botAvatarKey(matched), matched.role, Boolean(matched.isPrimary))}
                        size={22}
                      />
                    ) : null}
                    <span className="group-create-chip-name">{label}</span>
                    {!groupCreateAttempt && (
                      <span className="group-create-chip-remove" aria-hidden="true">
                        <X size={14} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div className="grok-card-group">
            {unarchivedCandidates.length > 4 && (
              <label className="group-create-search">
                <Search size={16} />
                <input
                  type="search"
                  value={groupSearchQuery}
                  onChange={e => onChangeGroupSearchQuery(e.target.value)}
                  placeholder={t('搜索 Bot 或设备…', 'Search bots or hosts…')}
                  disabled={groupCreating}
                />
                {groupSearchQuery && (
                  <button
                    type="button"
                    onClick={() => onChangeGroupSearchQuery('')}
                    aria-label={t('清除搜索', 'Clear search')}
                  >
                    <X size={15} />
                  </button>
                )}
              </label>
            )}

            {unarchivedCandidates.length < 2 ? (
              <div className="grok-card-row no-active" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ color: 'var(--muted)', fontSize: '.9rem', lineHeight: 1.5 }}>
                  {t('群聊至少需要 2 个未归档 Bot，当前数量不足，请先新建 Bot。',
                    'At least 2 active bots are required for a group chat. Create another bot first.')}
                </span>
                <button
                  type="button"
                  className="grok-done-pill-btn"
                  disabled={groupCreating}
                  onClick={onOpenCreateBot}
                >
                  {t('去新建 Bot', 'Create Bot')}
                </button>
              </div>
            ) : filteredCandidates.length === 0 ? (
              <div className="grok-card-row no-active" style={{ color: 'var(--muted)' }}>
                {t('没有匹配的 Bot', 'No matching bots')}
              </div>
            ) : (
              filteredCandidates.map(bot => {
                const selected = activeMembers.some(m => m.botId === bot.botId);
                const offline = botIsOffline(bot);
                return (
                  <button
                    key={bot.key}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    disabled={groupCreating || Boolean(groupCreateAttempt)}
                    className={`grok-card-row group-create-bot-row${selected ? ' is-selected' : ''}`}
                    onClick={() => onToggleGroupMember(bot)}
                  >
                    <GrokBotAvatar
                      preset={resolveBotAvatarPreset(botAvatarKey(bot), bot.role, Boolean(bot.isPrimary))}
                      isPrimary={Boolean(bot.isPrimary)}
                      starBadge={Boolean(bot.isPrimary)}
                      offline={offline}
                      size={40}
                    />
                    <div className="group-create-bot-meta">
                      <div className="group-create-bot-title-row">
                        <span className="group-create-bot-name">{bot.role}</span>
                        <span className={`hub-bot-host-badge ${bot.hostKind}${offline ? ' is-offline' : ''}`}>
                          <PlatformLogoIcon platform={bot.platform} size={11} />
                          <span className="hub-bot-host-text">
                            {bot.hostLabel}
                            {offline ? t(' · 离线', ' · Offline') : ''}
                          </span>
                        </span>
                      </div>
                      {bot.description ? (
                        <span className="group-create-bot-desc">{bot.description}</span>
                      ) : null}
                    </div>
                    <span className={`group-create-check${selected ? ' is-selected' : ''}`} aria-hidden="true">
                      {selected ? <Check size={14} strokeWidth={3} /> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <p className="grok-card-footnote">
          {t('可选择本机与其他在线设备上的 Bot 共同加入群聊；至少包含一位在线设备上的 Bot 即可创建。',
            'Combine local and remote bots in one group chat; include at least one bot on an online host.')}
        </p>

        <ReservedSlot minHeight={52} align="start">
          <ErrorNotice error={groupCreateError} stale={groupCreating} onDismiss={onDismissGroupCreateError} />
        </ReservedSlot>
      </div>
    </main>
  );
}
