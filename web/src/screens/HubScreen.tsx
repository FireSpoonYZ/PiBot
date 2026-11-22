import { useEffect, useMemo, useRef, useState, type RefObject, type TouchEvent } from 'react';
import { PanelLeft, Plus, RefreshCw, Search, Sparkles, Users, X } from 'lucide-react';
import { mobileHaptic } from '../native/tauri-host';
import type { ConnectionPhase } from '../connection';
import { useNotice } from '../notice';
import { Skeleton, SkeletonRow, useBottomChromeMeasure, useFlipList } from '../layout';
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
import { humanizeError, useText } from '../ui';
import { PlatformLogoIcon, type BotPreviewMeta, type UnifiedBotItem } from '../hub/shared';
import { ActionBar, Chips } from '../components/ui';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import { HubPrimaryHero } from './HubParts';
import type { HubContextMenuState, HubListEntry } from './types';

const HUB_ROOMS_ERROR_NOTICE_ID = 'hub-rooms-error';
const HUB_PINS_ERROR_NOTICE_ID = 'hub-pins-error';
const HUB_ACTION_ERROR_NOTICE_ID = 'hub-action-error';

export interface HubScreenProps {
  visible: boolean;
  anyDrawerOpen: boolean;
  leftDrawerOpen: boolean;
  navigationTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenLeftDrawer(): void;
  connectionPhase: ConnectionPhase;
  connectionDetail: string;
  ipcReconnecting: boolean;
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
  chatPinsError: string | null;
  actionError: string;
  onOpenCenterSettings(): void;
  onTriggerRefresh(): void;
  remoteConnected: boolean;
  hasLocalHost: boolean;
  hasConfiguredCenter: boolean;
  botsHydrated: boolean;
  roomConversationsHydrated: boolean;
  roomConversationsError: string | null;
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
  connectionPhase,
  connectionDetail,
  ipcReconnecting,
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
  chatPinsError,
  actionError,
  onOpenCenterSettings,
  onTriggerRefresh,
  remoteConnected,
  hasLocalHost,
  hasConfiguredCenter,
  botsHydrated,
  roomConversationsHydrated,
  roomConversationsError,
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
  const { notify, dismiss } = useNotice();
  const [connPopoverOpen, setConnPopoverOpen] = useState(false);

  const bottomBarRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  useBottomChromeMeasure(bottomBarRef, visible);

  const flipKeys = useMemo(() => visibleHubItems.map(entry => entry.pinKey), [visibleHubItems]);
  useFlipList(flipKeys, listRef, { enabled: visible });

  const tRef = useRef(t);
  tRef.current = t;
  const actionsRef = useRef({
    onRefreshRoomConversations,
    onTriggerRefresh,
    onOpenCenterSettings,
    onCloseHubAddMenu,
  });
  actionsRef.current = {
    onRefreshRoomConversations,
    onTriggerRefresh,
    onOpenCenterSettings,
    onCloseHubAddMenu,
  };

  useEffect(() => {
    if (!visible || anyDrawerOpen || connectionPhase === 'online' || hubAddMenuOpen) {
      setConnPopoverOpen(false);
    }
  }, [visible, anyDrawerOpen, connectionPhase, hubAddMenuOpen]);

  const connPopoverVisible = visible && connPopoverOpen && connectionPhase !== 'online' && !anyDrawerOpen;
  const hubAddMenuVisible = visible && hubAddMenuOpen && !anyDrawerOpen;

  useEffect(() => {
    if (!connPopoverVisible) return;
    return registerOverlayBackHandler(() => setConnPopoverOpen(false));
  }, [connPopoverVisible]);

  useEffect(() => {
    if (!connPopoverVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConnPopoverOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connPopoverVisible]);

  useEffect(() => {
    if (!hubAddMenuVisible) return;
    return registerOverlayBackHandler(() => actionsRef.current.onCloseHubAddMenu());
  }, [hubAddMenuVisible]);

  useEffect(() => {
    if (!hubAddMenuVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        actionsRef.current.onCloseHubAddMenu();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hubAddMenuVisible]);

  // H5: 群聊加载失败走 F1 浮层通知，带重试按钮；成功或离页立即清除。
  useEffect(() => {
    const err = visible ? roomConversationsError?.trim() : '';
    if (!err) {
      dismiss(HUB_ROOMS_ERROR_NOTICE_ID);
      return;
    }
    const t = tRef.current;
    notify({
      id: HUB_ROOMS_ERROR_NOTICE_ID,
      tone: 'error',
      title: t('群聊列表加载失败', 'Failed to load groups'),
      detail: err,
      action: {
        label: t('重试', 'Retry'),
        onClick: () => actionsRef.current.onRefreshRoomConversations(),
      },
    });
  }, [visible, roomConversationsError, notify, dismiss]);

  // H2: 置顶同步异常与操作失败路由到 F1 浮层，不插入列表文档流。
  useEffect(() => {
    const err = visible ? chatPinsError?.trim() : '';
    if (!err) {
      dismiss(HUB_PINS_ERROR_NOTICE_ID);
      return;
    }
    const t = tRef.current;
    notify({
      id: HUB_PINS_ERROR_NOTICE_ID,
      tone: 'warning',
      title: t('置顶状态保存失败', 'Failed to save pinned chats'),
      detail: err,
    });
  }, [visible, chatPinsError, notify, dismiss]);

  useEffect(() => {
    const err = visible ? actionError.trim() : '';
    if (!err) {
      dismiss(HUB_ACTION_ERROR_NOTICE_ID);
      return;
    }
    const humanized = humanizeError(err, tRef.current);
    const title = humanized?.title || err;
    const detailParts = [humanized?.description, humanized?.detail].filter(Boolean);
    notify({
      id: HUB_ACTION_ERROR_NOTICE_ID,
      tone: 'error',
      title,
      detail: detailParts.length > 0 ? detailParts.join('\n') : undefined,
    });
  }, [visible, actionError, notify, dismiss]);

  useEffect(() => () => {
    dismiss(HUB_ROOMS_ERROR_NOTICE_ID);
    dismiss(HUB_PINS_ERROR_NOTICE_ID);
    dismiss(HUB_ACTION_ERROR_NOTICE_ID);
  }, [dismiss]);

  const titleObscured = hubRefreshing || pullDistance > 4;
  const hubHydrated =
    hubFilter === 'rooms'
      ? roomConversationsHydrated
      : hubFilter === 'bots'
        ? botsHydrated
        : botsHydrated && (roomConversationsHydrated || (!hasConfiguredCenter && !hasLocalHost));

  const statusText =
    connectionPhase === 'connecting'
      ? t('连接中…', 'Connecting…')
      : connectionPhase === 'offline'
        ? t('离线', 'Offline')
        : t('连接异常', 'Connection issue');

  const statusHeading =
    connectionPhase === 'connecting'
      ? (ipcReconnecting ? t('正在恢复本地服务…', 'Reconnecting local service…') : t('正在恢复连接…', 'Reconnecting…'))
      : connectionPhase === 'offline'
        ? t('与中心未连接', 'Disconnected from center')
        : t('中心连接异常', 'Center connection issue');

  const statusDescription =
    connectionDetail.trim() ||
    (connectionPhase === 'connecting'
      ? t('正在同步中心连接与远端设备在线状态。', 'Syncing center connection and remote device availability.')
      : connectionPhase === 'offline'
        ? t('当前未连接到中心，远端设备状态待确认。', 'Not connected to center; remote device status is pending.')
        : t('中心连接出现错误，请检查网络或中心配置。', 'Center connection failed. Check your network or center settings.'));

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
          style={{ flexShrink: 0 }}
          aria-label={t('打开侧边栏', 'Open sidebar')}
          aria-haspopup="dialog"
          aria-expanded={leftDrawerOpen}
          onClick={() => {
            setConnPopoverOpen(false);
            if (hubAddMenuOpen) onCloseHubAddMenu();
            onOpenLeftDrawer();
          }}
        >
          <PanelLeft size={20} strokeWidth={2} />
        </button>

        {connectionPhase === 'online' ? (
          <h1
            className={`hub-top-title${titleObscured ? ' is-obscured' : ''}`}
            style={{ whiteSpace: 'nowrap' }}
          >
            PiBot
          </h1>
        ) : (
          <button
            type="button"
            className={`hub-top-title hub-top-status-btn is-${connectionPhase}${titleObscured ? ' is-obscured' : ''}`}
            style={{ whiteSpace: 'nowrap', minWidth: 0 }}
            aria-haspopup="dialog"
            aria-expanded={connPopoverVisible}
            aria-label={`${statusText} - ${t('查看连接详情', 'View connection details')}`}
            onClick={() => {
              if (hubAddMenuOpen) onCloseHubAddMenu();
              setConnPopoverOpen(v => !v);
            }}
          >
            {connectionPhase === 'connecting' ? (
              <RefreshCw size={15} strokeWidth={2.2} className="hub-top-status-spin" aria-hidden="true" />
            ) : (
              <span className={`hub-top-status-dot is-${connectionPhase}`} aria-hidden="true" />
            )}
            <span className="hub-top-status-label" style={{ whiteSpace: 'nowrap' }}>{statusText}</span>
          </button>
        )}

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
          style={{ flexShrink: 0 }}
          aria-label={t('新建', 'New')}
          aria-haspopup="menu"
          aria-expanded={hubAddMenuVisible}
          onClick={() => {
            setConnPopoverOpen(false);
            onToggleHubAddMenu();
          }}
        >
          <Plus size={22} strokeWidth={2.2} />
        </button>

        {connPopoverVisible && (
          <>
            <div className="grok-menu-backdrop" onClick={() => setConnPopoverOpen(false)} />
            <div
              className="hub-conn-popover"
              role="dialog"
              aria-label={t('连接状态详情', 'Connection status details')}
            >
              <div className={`hub-conn-popover-head is-${connectionPhase}`}>
                {connectionPhase === 'connecting' ? (
                  <RefreshCw size={15} className="hub-top-status-spin" aria-hidden="true" />
                ) : (
                  <span className={`hub-top-status-dot is-${connectionPhase}`} aria-hidden="true" />
                )}
                <span>{statusHeading}</span>
              </div>
              <p className="hub-conn-popover-desc">{statusDescription}</p>
              <p className="hub-conn-popover-hint">
                {t('提示：在首页下拉也可立即检查并尝试恢复连接。', 'Tip: Pull down on Hub to check and retry connecting.')}
              </p>
              <ActionBar align="end" className="hub-conn-popover-actions">
                <button
                  type="button"
                  className="hub-conn-popover-btn"
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  onClick={() => {
                    setConnPopoverOpen(false);
                    onTriggerRefresh();
                  }}
                >
                  {t('重试连接', 'Retry connection')}
                </button>
                <button
                  type="button"
                  className="hub-conn-popover-btn is-primary"
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  onClick={() => {
                    setConnPopoverOpen(false);
                    onOpenCenterSettings();
                  }}
                >
                  {t('打开设置', 'Open settings')}
                </button>
              </ActionBar>
            </div>
          </>
        )}

        {hubAddMenuVisible && (
          <>
            <div className="grok-menu-backdrop" onClick={onCloseHubAddMenu} />
            <div className="grok-floating-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                style={{ whiteSpace: 'nowrap' }}
                onClick={() => {
                  onCloseHubAddMenu();
                  onOpenCreateBot(false);
                }}
              >
                <Sparkles size={19} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t('新建 Bot', 'New Bot')}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                style={{ whiteSpace: 'nowrap' }}
                onClick={() => {
                  onCloseHubAddMenu();
                  onOpenCreateGroup();
                }}
              >
                <Users size={19} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t('创建群聊', 'Create Group Chat')}
                </span>
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
          ) : !botsHydrated ? (
            <div
              className="hub-hero-button hub-hero-card hub-hero-skeleton"
              role="status"
              aria-busy="true"
              aria-label={t('正在加载主 Bot…', 'Loading primary Bot…')}
            >
              <Skeleton variant="circle" width={64} height={64} />
              <div className="hub-hero-card-text">
                <Skeleton variant="text" width="44%" height={16} />
                <Skeleton variant="pill" width={64} height={20} />
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="hub-hero-button hub-hero-card hub-hero-placeholder"
              style={{ minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
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
              <div className="hub-hero-card-text" style={{ minWidth: 0 }}>
                <span
                  className="hub-hero-name"
                  style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {t('创建主 Bot', 'Create Primary Bot')}
                </span>
                <span
                  className="hub-bot-host-badge local"
                  style={{ whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '100%', fontVariantNumeric: 'tabular-nums' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                    <PlatformLogoIcon platform="android" size={12} />
                  </span>
                  <span
                    className="hub-bot-host-text"
                    style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {t('本机', 'Local')}
                  </span>
                </span>
              </div>
            </button>
          )}
        </section>

        {/* Pinned & Regular Bots and Rooms (Archived section moved to Settings) */}
        <section className="hub-bot-list" aria-label={t('Bot 列表', 'Bots')}>
          <div className="hub-filter-chips" style={{ minWidth: 0 }}>
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
          {visibleHubItems.length === 0 ? (
            !searchQuery.trim() && !hubHydrated ? (
              <SkeletonRow
                variant="hub"
                count={3}
                label={t('正在加载列表…', 'Loading list…')}
              />
            ) : (
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
            <ul ref={listRef} className="hub-bot-list-items">
              {visibleHubItems.map(entry => {
                if (entry.room) {
                  const room = entry.room;
                  const rowNode = (
                    <ConversationRow
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
                  return (
                    <li
                      key={entry.pinKey}
                      className="hub-bot-list-item"
                      data-flip-key={entry.pinKey}
                    >
                      {entry.pinned ? (
                        <SortablePinnedChat
                          chatKey={entry.pinKey}
                          keys={visiblePinnedKeys}
                          onReorder={onReorderPinnedKeys}
                        >
                          {rowNode}
                        </SortablePinnedChat>
                      ) : (
                        rowNode
                      )}
                    </li>
                  );
                }
                const item = entry.bot!;
                const meta = botMetaMap[item.key];
                const offline = botIsOffline(item);
                const statusUnknown = item.hostKind === 'local' ? !hasLocalHost : !remoteConnected;
                const isRemoteConnecting = item.hostKind === 'remote' && connectionPhase === 'connecting';
                const statusDotClass =
                  isRemoteConnecting || statusUnknown
                    ? 'is-connecting'
                    : offline
                      ? 'is-offline'
                      : 'is-online';
                const connectionLabel =
                  isRemoteConnecting || statusUnknown
                    ? t('连接状态待确认', 'Connection status unknown')
                    : offline
                      ? t('离线', 'Offline')
                      : t('在线', 'Online');
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
                    className="hub-bot-row"
                    title={item.role}
                    preview={preview}
                    timestamp={entry.sortMs || null}
                    connectionLabel={connectionLabel}
                    unread={unreadConversationKeys.has(entry.pinKey)}
                    pinned={entry.pinned}
                    avatar={
                      <span className="hub-bot-avatar-wrap">
                        <GrokBotAvatar
                          preset={resolveBotAvatarPreset(botAvatarKey(item), item.role, Boolean(item.isPrimary))}
                          offline={isRemoteConnecting ? false : offline}
                          size={40}
                        />
                        <span className={`hub-bot-status-dot ${statusDotClass}`} aria-hidden="true" />
                      </span>
                    }
                    onOpen={() => onOpenBotChat(item)}
                    onOpenMenu={(position) => { mobileHaptic('longPress'); onOpenContextMenu({ ...position, bot: item }); }}
                  />
                );
                return (
                  <li
                    key={entry.pinKey}
                    className="hub-bot-list-item"
                    data-flip-key={entry.pinKey}
                  >
                    {entry.pinned ? (
                      <SortablePinnedChat
                        chatKey={entry.pinKey}
                        keys={visiblePinnedKeys}
                        onReorder={onReorderPinnedKeys}
                      >
                        {rowNode}
                      </SortablePinnedChat>
                    ) : (
                      rowNode
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <footer ref={bottomBarRef} className="hub-bottom-bar">
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
