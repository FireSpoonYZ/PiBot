import type { RefObject, TouchEvent } from 'react';
import { PanelLeft, Plus, RefreshCw, Search, Sparkles, Users, X } from 'lucide-react';
import { mobileHaptic } from '../native/tauri-host';
import { useCenterConnection } from '../native/CenterGate';
import {
  ConversationGroupAvatar,
  ConversationRow,
  type ConversationBot,
  type ScopeConversation,
} from '../gbot-ui';
import { SortablePinnedChat } from '../gbot-ui/SortablePinnedChat';
import {
  GrokBotAvatar,
  JARVIS_AVATAR_PRESET,
  resolveBotAvatarPreset,
  type GrokAvatarPreset,
} from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { ErrorNotice, useText } from '../ui';
import { PlatformLogoIcon, type BotPreviewMeta, type UnifiedBotItem } from '../hub/shared';
import { Chips } from '../bot-settings/primitives';
import { HubPrimaryHero } from './HubParts';
import type { HubContextMenuState, HubListEntry } from './types';

export interface HubScreenProps {
  visible: boolean;
  anyDrawerOpen: boolean;
  leftDrawerOpen: boolean;
  navigationTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenLeftDrawer(): void;
  hubRefreshing: boolean;
  pullDistance: number;
  pullThreshold: number;
  hubAddMenuOpen: boolean;
  onToggleHubAddMenu(): void;
  onCloseHubAddMenu(): void;
  onOpenCreateBot(forcePrimary: boolean): void;
  onOpenCreateGroup(): void;
  hubScrollRef: RefObject<HTMLDivElement | null>;
  onTouchStart: (e: TouchEvent<HTMLDivElement>) => void;
  onTouchMove: (e: TouchEvent<HTMLDivElement>) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
  primaryBot?: UnifiedBotItem | null;
  primaryPreset: GrokAvatarPreset;
  onOpenPrimaryCreate(): void;
  botIsOffline(bot: UnifiedBotItem): boolean;
  onOpenBotChat(bot: UnifiedBotItem): void;
  onOpenContextMenu(menu: HubContextMenuState): void;
  hubFilter: 'all' | 'bots' | 'rooms';
  onChangeHubFilter(next: 'all' | 'bots' | 'rooms'): void;
  directoryError: string;
  chatPinsError: string | null;
  actionError: string;
  onDismissDirectoryError(): void;
  onDismissActionError(): void;
  onOpenCenterSettings(): void;
  onTriggerRefresh(): void;
  hasRemoteBots: boolean;
  remoteConnected: boolean;
  hasLocalHost: boolean;
  roomConversationsError: string | null;
  roomConversationsLoaded: boolean;
  roomConversationsLoading: boolean;
  onRefreshRoomConversations(): void;
  visibleHubItems: HubListEntry[];
  visiblePinnedKeys: string[];
  onReorderPinnedKeys(nextVisibleKeys: string[]): void;
  unreadConversationKeys: ReadonlySet<string>;
  knownBots: ConversationBot[];
  onOpenScopeConversation(room: ScopeConversation, openSettings: boolean): void;
  botMetaMap: Record<string, BotPreviewMeta>;
  clearedMap: Record<string, number>;
  scopeForBot(bot: UnifiedBotItem): string;
  searchQuery: string;
  onChangeSearchQuery(next: string): void;
}

export function HubScreen({
  visible,
  anyDrawerOpen,
  leftDrawerOpen,
  navigationTriggerRef,
  onOpenLeftDrawer,
  hubRefreshing,
  pullDistance,
  pullThreshold,
  hubAddMenuOpen,
  onToggleHubAddMenu,
  onCloseHubAddMenu,
  onOpenCreateBot,
  onOpenCreateGroup,
  hubScrollRef,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
  primaryBot,
  primaryPreset,
  onOpenPrimaryCreate,
  botIsOffline,
  onOpenBotChat,
  onOpenContextMenu,
  hubFilter,
  onChangeHubFilter,
  directoryError,
  chatPinsError,
  actionError,
  onDismissDirectoryError,
  onDismissActionError,
  onOpenCenterSettings,
  onTriggerRefresh,
  hasRemoteBots,
  remoteConnected,
  hasLocalHost,
  roomConversationsError,
  roomConversationsLoaded,
  roomConversationsLoading,
  onRefreshRoomConversations,
  visibleHubItems,
  visiblePinnedKeys,
  onReorderPinnedKeys,
  unreadConversationKeys,
  knownBots,
  onOpenScopeConversation,
  botMetaMap,
  clearedMap,
  scopeForBot,
  searchQuery,
  onChangeSearchQuery,
}: HubScreenProps) {
  const t = useText();
  const centerConn = useCenterConnection();

  return (
    <main
      className={`hub-main grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}${visible ? '' : ' hub-hidden'}`}
      aria-label={t('Bot 主页', 'Bot Hub')}
      aria-hidden={!visible || undefined}
    >
      <header className="hub-top-bar">
        <button
          type="button"
          ref={navigationTriggerRef}
          className="hub-circle-btn hub-left-trigger"
          aria-label={t('打开侧边栏', 'Open sidebar')}
          aria-haspopup="dialog"
          aria-expanded={leftDrawerOpen}
          onClick={onOpenLeftDrawer}
        >
          <PanelLeft size={20} strokeWidth={2} />
        </button>

        <h1 className={`hub-top-title${hubRefreshing || pullDistance > 4 ? ' is-obscured' : ''}`}>PiBot</h1>

        {(() => {
          const isSpinning = hubRefreshing;
          const isVisible = isSpinning || pullDistance > 4;
          const progress = Math.min(1, pullDistance / pullThreshold);
          return (
            <div
              className={`hub-top-spinner-indicator${isVisible ? ' visible' : ''}${isSpinning ? ' is-refreshing' : ''}${pullDistance >= pullThreshold ? ' ready' : ''}`}
              style={
                !isSpinning && pullDistance > 0
                  ? {
                      transform: `translateX(-50%) translateY(${Math.min(26, Math.round(pullDistance * 0.36))}px) scale(${0.75 + progress * 0.25})`,
                      opacity: Math.min(1, 0.25 + progress * 0.85),
                    }
                  : undefined
              }
              role="status"
              aria-live="polite"
              aria-label={
                hubRefreshing
                  ? t('正在刷新节点与 Bot…', 'Refreshing nodes and bots…')
                  : pullDistance >= pullThreshold
                    ? t('松手立即刷新', 'Release to refresh')
                    : t('下拉刷新', 'Pull down to refresh')
              }
            >
              <RefreshCw
                size={17}
                strokeWidth={2.3}
                style={
                  !isSpinning && pullDistance > 0
                    ? { transform: `rotate(${Math.round(pullDistance * 3.8)}deg)` }
                    : undefined
                }
              />
            </div>
          );
        })()}

        <button
          type="button"
          className="hub-circle-btn hub-add-btn"
          aria-label={t('新建', 'New')}
          aria-haspopup="menu"
          aria-expanded={hubAddMenuOpen}
          onClick={onToggleHubAddMenu}
        >
          <Plus size={22} strokeWidth={2.2} />
        </button>

        {hubAddMenuOpen && (
          <>
            <div className="grok-menu-backdrop" onClick={onCloseHubAddMenu} />
            <div className="grok-floating-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseHubAddMenu();
                  onOpenCreateBot(false);
                }}
              >
                <Sparkles size={19} />
                <span>{t('新建 Bot', 'New Bot')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseHubAddMenu();
                  onOpenCreateGroup();
                }}
              >
                <Users size={19} />
                <span>{t('创建群聊', 'Create Group Chat')}</span>
              </button>
            </div>
          </>
        )}
      </header>

      <div
        className="hub-scroll-area"
        ref={hubScrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        {/* Local Primary Assistant */}
        <section className="hub-hero-section">
          {primaryBot ? (
            <HubPrimaryHero
              bot={primaryBot}
              preset={primaryPreset}
              offline={botIsOffline(primaryBot)}
              label={`${primaryBot.role} · ${primaryBot.hostLabel} - ${t('点击进入文字对话', 'Tap to chat')}`}
              onOpen={() => onOpenBotChat(primaryBot)}
              onOpenMenu={(position) => { mobileHaptic('longPress'); onOpenContextMenu({ ...position, bot: primaryBot }); }}
            />
          ) : (
            <button
              type="button"
              className="hub-hero-button"
              onClick={onOpenPrimaryCreate}
              aria-label={t('创建主 Bot', 'Create Primary Bot')}
            >
              <GrokBotAvatar
                preset={JARVIS_AVATAR_PRESET}
                isPrimary
                starBadge
                platformBadge={<PlatformLogoIcon platform="android" size={11} />}
                size={64}
              />
              <span className="hub-hero-name">{t('创建主 Bot', 'Create Primary Bot')}</span>
            </button>
          )}
        </section>

        {/* Pinned & Regular Bots and Rooms (Archived section moved to Settings) */}
        <section className="hub-bot-list" aria-label={t('Bot 列表', 'Bots')}>
          <div className="hub-filter-chips">
            <Chips<'all' | 'bots' | 'rooms'>
              value={hubFilter}
              onChange={onChangeHubFilter}
              label={t('按类型筛选', 'Filter by type')}
              options={[
                { value: 'all', label: t('全部', 'All') },
                { value: 'bots', label: t('Bot', 'Bots') },
                { value: 'rooms', label: t('群聊', 'Groups') },
              ]}
            />
          </div>
          <ErrorNotice
            compact
            error={directoryError || (!centerConn.ready ? centerConn.error : '') || chatPinsError || actionError}
            actionLabel={!centerConn.ready && centerConn.status?.error ? t('去设置', 'Settings') : directoryError ? t('刷新', 'Refresh') : undefined}
            onAction={!centerConn.ready && centerConn.status?.error ? onOpenCenterSettings : directoryError ? onTriggerRefresh : undefined}
            onDismiss={directoryError ? onDismissDirectoryError : actionError ? onDismissActionError : undefined}
          />
          {hasRemoteBots && !remoteConnected && (
            <p className="hub-empty-list" role="status">
              {centerConn.connecting
                ? t('正在恢复连接，远端设备状态待确认…', 'Reconnecting; remote device status is unknown…')
                : t('与中心未连接，远端设备状态待确认。下拉可尝试恢复。', 'Disconnected from center. Pull down to check and reconnect.')}
            </p>
          )}
          {roomConversationsError ? (
            <ErrorNotice
              compact
              title={t('群聊列表加载失败', 'Failed to load groups')}
              detail={roomConversationsError}
              actionLabel={t('重试', 'Retry')}
              onAction={onRefreshRoomConversations}
            />
          ) : null}
          {visibleHubItems.length === 0 ? (
            hubFilter === 'rooms' && !roomConversationsLoaded && roomConversationsLoading ? null : (
            <div className="hub-empty-list">
              <p>
                {searchQuery.trim()
                  ? t('没有匹配的 Bot 或群聊', 'No matching bots or groups')
                  : hubFilter === 'rooms'
                    ? t('还没有群聊，点右上角 + 创建群聊', 'No group chats yet. Tap + in the top right to create one')
                    : t('点击上方主 Bot 直接开始对话，或点右上角 + 新建 Bot 或群聊', 'Tap the primary Bot above to chat, or + to create a Bot or group chat')}
              </p>
            </div>
            )
          ) : (
            visibleHubItems.map(entry => {
              if (entry.room) {
                const room = entry.room;
                const rowNode = (
                  <ConversationRow
                    key={entry.pinKey}
                    className="hub-bot-row"
                    title={room.title}
                    preview={room.lastPreview}
                    timestamp={room.lastActivityAt}
                    groupLabel={t('群聊', 'Group chat')}
                    pinned={entry.pinned}
                    unread={unreadConversationKeys.has(entry.pinKey)}
                    avatar={
                      <ConversationGroupAvatar
                        members={room.scope.scope.members}
                        bots={knownBots}
                        size={40}
                      />
                    }
                    onOpen={() => onOpenScopeConversation(room, false)}
                    onOpenMenu={(position) => { mobileHaptic('longPress'); onOpenContextMenu({ ...position, room }); }}
                  />
                );
                return entry.pinned ? (
                  <SortablePinnedChat
                    key={entry.pinKey}
                    chatKey={entry.pinKey}
                    keys={visiblePinnedKeys}
                    onReorder={onReorderPinnedKeys}
                  >
                    {rowNode}
                  </SortablePinnedChat>
                ) : (
                  rowNode
                );
              }
              const item = entry.bot!;
              const meta = botMetaMap[item.key];
              const offline = botIsOffline(item);
              const statusUnknown = item.hostKind === 'local' ? !hasLocalHost : !remoteConnected;
              const connectionLabel = statusUnknown
                ? t('连接状态待确认', 'Connection status unknown')
                : offline ? t('离线', 'Offline') : t('在线', 'Online');
              const cachedPreview = meta?.lastText?.trim();
              // 旧缓存曾将创建占位与清空提示写入摘要，只有存在相应的目录或清空记录时才排除。
              const isCreationPlaceholder = (!item.lastActivityAt || item.lastActivityAt === item.createdAt) &&
                (cachedPreview === meta?.subtitle?.trim() ||
                 cachedPreview === '点击开始文字对话…' || cachedPreview === 'Tap to start chatting…'); // i18n-ok
              const itemScopeKey = scopeForBot(item);
              const isClearNotice = ((itemScopeKey && clearedMap[itemScopeKey] !== undefined) || clearedMap[item.key] !== undefined) &&
                (cachedPreview === '对话已清空' || cachedPreview === 'History cleared'); // i18n-ok
              const preview = item.lastPreview?.trim() ||
                (isCreationPlaceholder || isClearNotice ? undefined : cachedPreview);
              const rowNode = (
                <ConversationRow
                  key={entry.pinKey}
                  className="hub-bot-row"
                  title={item.role}
                  preview={preview}
                  timestamp={entry.sortMs || null}
                  connectionLabel={connectionLabel}
                  unread={unreadConversationKeys.has(entry.pinKey)}
                  pinned={entry.pinned}
                  avatar={
                    <GrokBotAvatar
                      preset={resolveBotAvatarPreset(botAvatarKey(item), item.role, Boolean(item.isPrimary))}
                      offline={offline}
                      size={40}
                    />
                  }
                  onOpen={() => onOpenBotChat(item)}
                  onOpenMenu={(position) => { mobileHaptic('longPress'); onOpenContextMenu({ ...position, bot: item }); }}
                />
              );
              return entry.pinned ? (
                <SortablePinnedChat
                  key={entry.pinKey}
                  chatKey={entry.pinKey}
                  keys={visiblePinnedKeys}
                  onReorder={onReorderPinnedKeys}
                >
                  {rowNode}
                </SortablePinnedChat>
              ) : (
                rowNode
              );
            })
          )}
        </section>
      </div>

      <footer className="hub-bottom-bar">
        <label className="hub-search-box">
          <Search size={18} className="hub-search-icon" />
          <input
            type="search"
            value={searchQuery}
            onChange={e => onChangeSearchQuery(e.target.value)}
            placeholder={t('搜索', 'Search')}
            aria-label={t('搜索 Bot', 'Search bots')}
          />
          {searchQuery && (
            <button
              type="button"
              className="hub-search-clear"
              onClick={() => onChangeSearchQuery('')}
              aria-label={t('清除搜索', 'Clear search')}
            >
              <X size={16} />
            </button>
          )}
        </label>
      </footer>
    </main>
  );
}
