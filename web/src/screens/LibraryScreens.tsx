import { useRef } from 'react';
import { Archive, ArrowLeft, Globe } from 'lucide-react';
import { Scopes, type ScopeBotInfo } from '../../../desktop/web/src/Scopes';
import type { RoomApiResolver, ScopeReadApi } from '../../../desktop/web/src/scope-api';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { DevicesDirectoryItem, MessageMember } from '../../../host-core/index.js';
import type { ScopeConversation, ScopeConversationSource } from '../gbot-ui';
import { BotSkillsPage } from '../bot-settings/BotSkillsPage';
import { SkillReviewPanel, type SkillReviewCall } from '../learning/SkillReviewPanel';
import { GrokBotAvatar, resolveBotAvatarPreset } from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { ErrorNotice, useText } from '../ui';
import { ReservedSlot } from '../layout';
import { Button, InlineBanner, Skeleton } from '../components/ui';
import {
  PlatformLogoIcon,
  formatArchivedRemainingDays,
  type UnifiedBotItem,
} from '../hub/shared';
import { PendingInbox } from '../hub/PendingInbox';
import { HubArchivedRow } from './HubParts';
import type { ActionController, HubContextMenuState, MobileBotItem } from './types';

export interface ScopesSubpageScreenProps {
  mode: 'conversation' | 'dm' | 'pending';
  active: boolean;
  scopeConversationTarget: ScopeConversation | null;
  scopeConversationSources: ScopeConversationSource[];
  localScopeApi: ScopeReadApi | null;
  resolveRoomApi: RoomApiResolver;
  roomMemberCandidates: ScopeBotInfo[];
  knownBots: ScopeBotInfo[];
  onMarkRoomHistoryViewed(scopeId: string, lastMessageAt: string): void;
  roomSettingsOpen: boolean;
  onRoomSettingsOpenChange(open: boolean): void;
  onRoomDeleted(deletedScopeId: string): void;
  onOpenScopeLink(href: string): void;
  onBackFromConversation(): void;
  onOpenBot(botId: string, deviceId: string): void;
  dmTarget: { bot: UnifiedBotItem } | null;
  dmSelectedScopeId: string | null;
  onSelectDmScope(scopeId: string | null): void;
  onBackFromDm(): void;
  onBackFromPending(): void;
  remoteApi: DesktopPanelApi | null;
  remoteIdentity: DesktopIdentity | null;
  remoteConnected: boolean;
  remoteDevices: DevicesDirectoryItem[];
  allBotItems: UnifiedBotItem[];
  roomConversations: ScopeConversation[];
  onOpenCenterSettings(): void;
}

export function ScopesSubpageScreen({
  mode,
  active,
  scopeConversationTarget,
  scopeConversationSources,
  localScopeApi,
  resolveRoomApi,
  roomMemberCandidates,
  knownBots,
  onMarkRoomHistoryViewed,
  roomSettingsOpen,
  onRoomSettingsOpenChange,
  onRoomDeleted,
  onOpenScopeLink,
  onBackFromConversation,
  onOpenBot,
  dmTarget,
  dmSelectedScopeId,
  onSelectDmScope,
  onBackFromDm,
  onBackFromPending,
  remoteApi,
  remoteIdentity,
  remoteConnected,
  remoteDevices,
  allBotItems,
  roomConversations,
  onOpenCenterSettings,
}: ScopesSubpageScreenProps) {
  const t = useText();
  const dmSource =
    mode === 'dm' && dmTarget
      ? scopeConversationSources.find(source => {
          if (dmTarget.bot.hostKind === 'local') return source.api === localScopeApi;
          return source.identity?.targetDeviceId === dmTarget.bot.hostId;
        })
      : undefined;
  const showConversationFallbackHeader = mode === 'conversation' && !scopeConversationTarget;
  const showDmFallbackHeader = mode === 'dm' && (!dmTarget || !dmSource);
  const useScrollBody = mode === 'pending' || showConversationFallbackHeader || showDmFallbackHeader;

  return (
    <main className="grok-subpage grok-page-enter">
      {mode === 'pending' && (
        <header className="grok-subpage-topbar">
          <button
            type="button"
            className="grok-floating-circle-btn"
            onClick={onBackFromPending}
            aria-label={t('返回', 'Back')}
          >
            <ArrowLeft size={20} />
          </button>
          <h2 className="grok-subpage-header-title">{t('待发消息', 'Pending messages')}</h2>
          <span className="shell-topbar-spacer" />
        </header>
      )}
      {showConversationFallbackHeader && (
        <header className="grok-subpage-topbar">
          <button
            type="button"
            className="grok-floating-circle-btn"
            onClick={onBackFromConversation}
            aria-label={t('返回', 'Back')}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <h2 className="grok-subpage-header-title">{t('群聊', 'Group chat')}</h2>
          <span className="grok-topbar-spacer" aria-hidden="true" />
        </header>
      )}
      {showDmFallbackHeader && (
        <header className="grok-subpage-topbar">
          <button
            type="button"
            className="grok-floating-circle-btn"
            onClick={onBackFromDm}
            aria-label={t('返回', 'Back')}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <h2 className="grok-subpage-header-title">
            {dmTarget ? t(`${dmTarget.bot.role} · 私聊`, `${dmTarget.bot.role} · DMs`) : t('私聊', 'Private chats')}
          </h2>
          <span className="grok-topbar-spacer" aria-hidden="true" />
        </header>
      )}
      {/* conversation/dm 页面头由 Scopes 会话头承担：宿主不再叠一层标题栏，
          容器占满高、消息区独立滚动、底部输入不随页面滚动离开。 */}
      <div className={useScrollBody ? 'grok-subpage-scroll' : 'grok-subpage-fill'}>
        {mode === 'conversation' ? (
          scopeConversationTarget ? (
            // 打开时捕获的 api 可能带旧 targetOnline/失效代际；按稳定 profile/kind/device
            // 重新解析当前来源 api，离线/上线切换即生效。
            (() => {
              const tid = scopeConversationTarget.identity;
              const liveApi = scopeConversationSources.find(s =>
                s.identity?.profileId === tid.profileId &&
                s.identity?.kind === tid.kind &&
                s.identity?.targetDeviceId === tid.targetDeviceId,
              )?.api ?? scopeConversationTarget.api;
              return (
                <div className="grok-scopes-mobile-container">
                  <Scopes
                    key={`room-${scopeConversationTarget.key}`}
                    api={liveApi}
                    pageActive={active}
                    // 群聊开放用户写入口：写端由 resolver 路由（成员→authority、发送→成员 Host）；
                    // 未接入写端显示待连接而非只读。DM 路径不受影响仍只读。
                    readOnly={false}
                    resolveRoomApi={resolveRoomApi}
                    memberCandidates={roomMemberCandidates}
                    detailOnly
                    scopeKind="room"
                    initialScopeId={scopeConversationTarget.scope.scope.scopeId}
                    initialScope={scopeConversationTarget.scope}
                    knownBots={knownBots}
                    onHistoryViewed={onMarkRoomHistoryViewed}
                    settingsOpen={roomSettingsOpen}
                    onSettingsOpenChange={onRoomSettingsOpenChange}
                    onDeleted={() => onRoomDeleted(scopeConversationTarget.scope.scope.scopeId)}
                    onOpenLink={onOpenScopeLink}
                    onBack={onBackFromConversation}
                    onOpenBot={onOpenBot}
                  />
                </div>
              );
            })()
          ) : (
            <section className="grok-card-group grok-schedule-empty" style={{ marginTop: 12 }}>
              <Globe size={28} className="grok-row-icon" aria-hidden="true" />
              <h4>{t('群聊暂不可用', 'Group chat unavailable')}</h4>
              <p>{t('当前群聊会话已不可用，请返回后重新打开。', 'This group chat is unavailable. Go back and open it again.')}</p>
            </section>
          )
        ) : mode === 'dm' ? (
          dmTarget ? (
            (() => {
              const bot = dmTarget.bot;
              if (!dmSource) {
                return (
                  <section className="grok-card-group grok-schedule-empty" style={{ marginTop: 12 }}>
                    <Globe size={28} className="grok-row-icon" />
                    <h4>{bot.hostKind === 'remote' ? t('远端节点未连接', 'Remote node not connected') : t('本机 Host 未就绪', 'Local host not ready')}</h4>
                    <p>{bot.hostKind === 'remote'
                      ? t('连接远端节点后可查看该 Bot 的私聊。', 'Connect to the remote node to view this Bot\'s private chats.')
                      : t('Host 启动后即可查看该 Bot 的私聊记录。', 'Once the host is running you can view this Bot\'s private chats.')}</p>
                  </section>
                );
              }
              const participant: MessageMember = { deviceId: bot.deviceId, botId: bot.botId };
              return (
                <div className="grok-scopes-mobile-container">
                  <Scopes
                    key={`dm-${dmSource.identity?.profileId ?? 'local'}|${dmSource.identity?.generation ?? 0}|${participant.deviceId}|${participant.botId}`}
                    api={dmSource.api}
                    pageActive={active}
                    readOnly
                    scopeKind="dm"
                    participant={participant}
                    participantName={bot.role}
                    selectedScopeId={dmSelectedScopeId}
                    onSelectScope={onSelectDmScope}
                    // DM 列表头返回其来源页；详情返回由受控 selectedScopeId 清空（见 handleStepBack）。
                    onBack={dmSelectedScopeId ? undefined : onBackFromDm}
                    knownBots={knownBots}
                    onOpenLink={onOpenScopeLink}
                    onOpenBot={onOpenBot}
                  />
                </div>
              );
            })()
          ) : (
            <section className="grok-card-group grok-schedule-empty" style={{ marginTop: 12 }}>
              <Globe size={28} className="grok-row-icon" aria-hidden="true" />
              <h4>{t('私聊暂不可用', 'Private chats unavailable')}</h4>
              <p>{t('未找到目标 Bot，请返回上一页重新选择。', 'Target Bot not found. Go back and select a Bot again.')}</p>
            </section>
          )
        ) : (
          <PendingInbox
            api={remoteApi && remoteIdentity ? remoteApi : null}
            identity={remoteIdentity}
            transportConnected={remoteConnected}
            devices={remoteDevices}
            bots={allBotItems}
            rooms={roomConversations}
            onOpenSettings={onOpenCenterSettings}
          />
        )}
      </div>
    </main>
  );
}

export interface BotSkillsScreenProps {
  activeBot: MobileBotItem;
  activeCenter: string;
  localDeviceId?: string | null;
  remoteConnected: boolean;
  remoteIdentity: DesktopIdentity | null;
  remoteApi: DesktopPanelApi | null;
  botPanelIdentityKey: string;
  botPanelConnected: boolean;
  callSkillReview: SkillReviewCall;
  onBack(): void;
  onOpenCenterSettings(): void;
}

export function BotSkillsScreen({
  activeBot,
  activeCenter,
  localDeviceId,
  remoteConnected,
  remoteIdentity,
  remoteApi,
  botPanelIdentityKey,
  botPanelConnected,
  callSkillReview,
  onBack,
  onOpenCenterSettings,
}: BotSkillsScreenProps) {
  const t = useText();
  const skillsBackRef = useRef<(() => boolean) | null>(null);
  const skillsDeviceId = activeBot.hostKind === 'local' ? localDeviceId : activeBot.hostId;
  const showCenterSkills = Boolean(remoteConnected && remoteIdentity && remoteApi && skillsDeviceId);

  return (
    <main className="grok-subpage grok-page-enter bot-skills-page" aria-label={t(`${activeBot.role} · 技能`, `${activeBot.role} · Skills`)}>
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          onClick={() => {
            if (showCenterSkills && skillsBackRef.current?.()) return;
            onBack();
          }}
          aria-label={t('返回', 'Back')}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="grok-subpage-header-title">{t(`${activeBot.role} · 技能`, `${activeBot.role} · Skills`)}</h2>
        <span className="grok-topbar-spacer" aria-hidden="true" />
      </header>
      <div className="grok-subpage-scroll">
        <div className="bot-skills-body">
          {showCenterSkills && remoteIdentity && remoteApi && skillsDeviceId ? (
            <BotSkillsPage
              key={`${activeCenter}|${activeBot.key}|${remoteIdentity.generation}`}
              api={remoteApi}
              identity={remoteApi.identityForTarget(skillsDeviceId)}
              deviceId={skillsDeviceId}
              botId={activeBot.botId}
              botName={activeBot.role}
              backHandlerRef={skillsBackRef}
              hideInlineBack
            />
          ) : (
            <>
              <InlineBanner
                tone="info"
                title={t('中心技能目录', 'Center Skills')}
                detail={t('连接中心后可查看所有可用技能、一键新建技能并在线编辑 SKILL.md 及附属文件。', 'Connect to the center to browse skills, create new ones, and edit SKILL.md inline.')}
                actions={
                  <Button variant="primary" size="sm" onClick={onOpenCenterSettings}>
                    {t('去连接中心', 'Connect to center')}
                  </Button>
                }
              />
              {botPanelConnected && (
                <section className="grok-field-section">
                  <h3 className="grok-section-label">{t('本机已学技能', 'Local Learned Skills')}</h3>
                  <div className="grok-card-group bot-skills-review-card">
                    <SkillReviewPanel key={botPanelIdentityKey} connected={botPanelConnected} call={callSkillReview} />
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export interface ArchivedBotsScreenProps {
  archivedBots: UnifiedBotItem[];
  hasRemoteConfigured: boolean;
  action: ActionController;
  loading?: boolean;
  onBack(): void;
  onOpenBotChat(bot: UnifiedBotItem): void;
  onOpenContextMenu(menu: HubContextMenuState): void;
  onUnarchive(bot: UnifiedBotItem): void;
  onRequestDelete(bot: UnifiedBotItem): void;
}

export function ArchivedBotsScreen({
  archivedBots,
  hasRemoteConfigured,
  action,
  loading = false,
  onBack,
  onOpenBotChat,
  onOpenContextMenu,
  onUnarchive,
  onRequestDelete,
}: ArchivedBotsScreenProps) {
  const t = useText();

  return (
    <main className="grok-subpage grok-page-enter" aria-label={t('已归档 Bot', 'Archived Bots')}>
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          onClick={onBack}
          aria-label={t('返回', 'Back')}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="grok-subpage-header-title">
          {loading && archivedBots.length === 0
            ? t('已归档 Bot', 'Archived Bots')
            : t(`已归档 Bot (${archivedBots.length})`, `Archived Bots (${archivedBots.length})`)}
        </h2>
        <span className="grok-topbar-spacer" aria-hidden="true" />
      </header>

      <div className="grok-subpage-scroll">
        <p className="grok-card-footnote grok-footnote-mt-2">
          {t('已归档的 Bot 保留 14 天，到期后自动清理。点击条目可查看只读历史对话，也可随时恢复或永久删除。', 'Archived bots are retained for 14 days before auto-deletion. Tap a bot to view read-only history, restore, or permanently delete.')}
        </p>
        <ReservedSlot minHeight={48} align="start">
          <ErrorNotice error={action.error} stale={action.errorStale} compact onDismiss={() => action.setError('')} />
        </ReservedSlot>

        {loading && archivedBots.length === 0 ? (
          <section className="grok-card-group archived-skeleton-list">
            <Skeleton lines={3} label={t('正在加载已归档 Bot…', 'Loading archived bots…')} />
          </section>
        ) : archivedBots.length === 0 ? (
          <section className="grok-card-group grok-schedule-empty" role="status">
            <Archive size={28} className="grok-row-icon" aria-hidden="true" />
            <h4>{t('暂无已归档 Bot', 'No Archived Bots')}</h4>
            <p>
              {t('归档后的 Bot 会收纳在此处并保留 14 天，不会继续显示在主页列表中。', 'Archived bots are kept here for 14 days and hidden from the main Hub list.')}
            </p>
          </section>
        ) : (
          <section className="grok-card-group grok-archived-list-group">
            {archivedBots.map(item => {
              const daysLeft = formatArchivedRemainingDays(item.archivedAt);
              const preset = resolveBotAvatarPreset(botAvatarKey(item), item.role, false);
              return (
                <HubArchivedRow
                  key={item.key}
                  className="archived-bot-row"
                  onOpen={() => onOpenBotChat(item)}
                  onOpenMenu={(position) => onOpenContextMenu({ ...position, bot: item })}
                >
                  <div className="archived-bot-avatar">
                    <GrokBotAvatar
                      preset={preset}
                      platformBadge={<PlatformLogoIcon platform={item.platform} size={11} />}
                      size={44}
                    />
                  </div>
                  <div className="archived-bot-content">
                    <div className="archived-bot-line-1">
                      <span className="archived-bot-name">{item.role}</span>
                      {hasRemoteConfigured && (
                        <span className={`hub-bot-host-badge ${item.hostKind}${item.online === false ? ' is-offline' : ''}`}>
                          <PlatformLogoIcon platform={item.platform} size={11} />
                          <span className="hub-bot-host-text">{item.hostLabel}</span>
                        </span>
                      )}
                      <span className="grok-archived-ttl-pill archived-bot-ttl">
                        {t(`剩余 ${daysLeft} 天`, `${daysLeft}d left`)}
                      </span>
                    </div>
                    <div className="archived-bot-line-2">
                      <span className="archived-bot-snippet">
                        {item.lastPreview || item.description || t('只读历史 · 14 天后自动清理', 'Read-only history · auto-deletes in 14d')}
                      </span>
                      <div className="archived-bot-actions">
                        <button
                          type="button"
                          className="hub-outline-btn grok-archived-btn-sm"
                          disabled={action.busy}
                          aria-label={t(`恢复 ${item.role}`, `Restore ${item.role}`)}
                          onClick={e => {
                            e.stopPropagation();
                            onUnarchive(item);
                          }}
                        >
                          {t('恢复', 'Restore')}
                        </button>
                        <button
                          type="button"
                          className="hub-outline-btn danger grok-archived-btn-sm"
                          disabled={action.busy}
                          aria-label={t(`永久删除 ${item.role}`, `Permanently delete ${item.role}`)}
                          onClick={e => {
                            e.stopPropagation();
                            onRequestDelete(item);
                          }}
                        >
                          {t('删除', 'Delete')}
                        </button>
                      </div>
                    </div>
                  </div>
                </HubArchivedRow>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
