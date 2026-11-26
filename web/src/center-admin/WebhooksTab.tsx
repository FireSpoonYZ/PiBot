import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { registerOverlayBackHandler } from '../components/ui/overlayStack';
import { LabelStack } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  CaConfirmDialog,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSwitch,
  CopyButton,
  botKey,
  copyToClipboard,
  formatTime,
  useCaTabNotices,
  useUiLocale,
} from './primitives';
import type {
  CenterAdminTab,
  CenterBotRef,
  CenterDevice,
  WebhookEvent,
  WebhookRoute,
} from './types';

type TranslateFn = ReturnType<typeof useText>;

const DEFAULT_EVENT_LIMIT = 10;

function eventStatusMeta(
  status: WebhookEvent['status'],
  t: TranslateFn,
): {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted';
} {
  switch (status) {
    case 'succeeded':
      return { label: t('已完成', 'Succeeded'), tone: 'ok' };
    case 'running':
    case 'queued':
    case 'dispatching':
    case 'pending':
      return { label: t('执行中', 'Running'), tone: 'info' };
    case 'cancelled':
      return { label: t('已取消', 'Cancelled'), tone: 'muted' };
    case 'expired':
      return { label: t('已过期', 'Expired'), tone: 'warn' };
    default:
      return { label: t('失败', 'Failed'), tone: 'danger' };
  }
}

function parseTargetKey(key: string): { deviceId: string; botId: string } | null {
  const idx = key.indexOf('::');
  if (idx <= 0) return null;
  return { deviceId: key.slice(0, idx), botId: key.slice(idx + 2) };
}

interface WebhooksCacheData {
  devices: CenterDevice[];
  bots: CenterBotRef[];
  routes: WebhookRoute[];
  events: WebhookEvent[];
}

export function WebhooksTab({
  api,
  active = true,
  cacheKey = 'default',
  onRegisterNavGuard,
  onNavigateTab,
  onRegisterBackHandler,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  onRegisterNavGuard?: (guard: ((nextTab: CenterAdminTab) => boolean) | null) => void;
  onNavigateTab?: (tab: CenterAdminTab) => void;
  onRegisterBackHandler?: (handler: () => boolean) => () => void;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();

  const initialCache = useMemo(
    () => readTabCache<WebhooksCacheData>(cacheKey, 'webhooks')?.data ?? null,
    [cacheKey],
  );
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');

  const [devices, setDevices] = useState<CenterDevice[]>(() => initialCache?.devices ?? []);
  const [bots, setBots] = useState<CenterBotRef[]>(() => initialCache?.bots ?? []);
  const [routes, setRoutes] = useState<WebhookRoute[]>(() => initialCache?.routes ?? []);
  const [events, setEvents] = useState<WebhookEvent[]>(() => initialCache?.events ?? []);

  const [selectedRouteFilter, setSelectedRouteFilter] = useState<string>('all');
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [eventsRefreshing, setEventsRefreshing] = useState(false);
  const [togglingRouteId, setTogglingRouteId] = useState<string | null>(null);

  // In-page create / edit sub-view state (avoids stacking modals on modals)
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<WebhookRoute | null>(null);
  const [hookName, setHookName] = useState('');
  const [hookTargetKey, setHookTargetKey] = useState('');
  const [hookInstruction, setHookInstruction] = useState('');
  const [hookEnabled, setHookEnabled] = useState(true);
  const [hookBusy, setHookBusy] = useState(false);
  const [editorError, setEditorError] = useState('');

  // One-time Bearer token reveal + copy tracking
  const [revealedToken, setRevealedToken] = useState<{ url: string; token: string } | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [copiedKind, setCopiedKind] = useState<'token' | 'curl' | null>(null);
  const [discardTokenOpen, setDiscardTokenOpen] = useState(false);
  const [pendingTargetTab, setPendingTargetTab] = useState<CenterAdminTab | null>(null);

  // Single top-level destructive confirmation
  const [confirmAction, setConfirmAction] = useState<'rotate' | 'delete' | null>(null);

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);
  const eventsGenRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const editorOpenRef = useRef(editorOpen);
  editorOpenRef.current = editorOpen;
  const hookBusyRef = useRef(hookBusy);
  hookBusyRef.current = hookBusy;
  const revealedTokenRef = useRef(revealedToken);
  revealedTokenRef.current = revealedToken;
  const tokenCopiedRef = useRef(tokenCopied);
  tokenCopiedRef.current = tokenCopied;
  const requestCloseEditorRef = useRef<() => void>(() => {});

  const { showNotice, clearNotice } = useCaTabNotices('webhooks', active);

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

  const activeBots = useMemo(() => bots.filter(b => !b.archivedAt), [bots]);

  const botDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bots) {
      map.set(botKey(b.deviceId, b.botId), `${b.deviceName || b.deviceId} / ${b.name || b.botId}`);
    }
    return map;
  }, [bots]);

  const groupedBotOptions = useMemo(() => {
    const groups = new Map<string, { deviceName: string; bots: CenterBotRef[] }>();
    for (const d of devices) {
      groups.set(d.deviceId, { deviceName: d.name || d.deviceId, bots: [] });
    }
    for (const b of activeBots) {
      const existing = groups.get(b.deviceId) ?? {
        deviceName: b.deviceName || b.deviceId,
        bots: [],
      };
      existing.bots.push(b);
      groups.set(b.deviceId, existing);
    }
    return [...groups.entries()].filter(([, g]) => g.bots.length > 0);
  }, [activeBots, devices]);

  const loadWebhookEventsForRoutes = useCallback(
    async (routeList: WebhookRoute[]) => {
      const gen = ++eventsGenRef.current;
      if (routeList.length === 0) {
        setEvents([]);
        return;
      }
      const chunks = await Promise.all(
        routeList.map(r => api.listWebhookEvents(r.id).then(res => res.items).catch(() => [] as WebhookEvent[])),
      );
      if (gen !== eventsGenRef.current) return;
      const merged = chunks
        .flat()
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
      setEvents(merged);
    },
    [api],
  );

  const loadAll = useCallback(
    async (gen: number) => {
      const [sync, hookRes] = await Promise.all([api.getBotSync(), api.listWebhooks()]);
      if (gen !== loadGenRef.current) return;
      setDevices(sync.devices);
      setBots(sync.bots ?? []);
      setRoutes(hookRes.items);
      await loadWebhookEventsForRoutes(hookRes.items);
      if (gen !== loadGenRef.current) return;
      hasLoadedRef.current = true;
      cacheKeyRef.current = cacheKey;
      setHasLoaded(true);
      setInitialError('');
      clearNotice('load-error');
    },
    [api, cacheKey, clearNotice, loadWebhookEventsForRoutes],
  );

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll(gen);
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const reason = errorMessage(err, t('中心服务暂不可用', 'Center service unavailable'));
      const msg = t(`加载 Webhook 列表失败：${reason}。请检查中心连接后重试。`, `Failed to load webhooks: ${reason}. Check your center connection and retry.`);
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
      eventsGenRef.current += 1;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<WebhooksCacheData>(cacheKey, 'webhooks', {
      devices,
      bots,
      routes,
      events,
    });
  }, [bots, cacheKey, devices, events, hasLoaded, routes]);

  // 5s silent auto-refresh for recent trigger events while list view is active
  useEffect(() => {
    if (!active || editorOpen || routes.length === 0) return;
    const timer = window.setInterval(() => {
      void loadWebhookEventsForRoutes(routes);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, editorOpen, loadWebhookEventsForRoutes, routes]);

  const resetTokenReveal = () => {
    revealedTokenRef.current = null;
    tokenCopiedRef.current = false;
    setRevealedToken(null);
    setTokenCopied(false);
    setCopiedKind(null);
  };

  const closeEditorImmediately = () => {
    setDiscardTokenOpen(false);
    setPendingTargetTab(null);
    setConfirmAction(null);
    setEditorError('');
    editorOpenRef.current = false;
    resetTokenReveal();
    setEditorOpen(false);
  };

  const requestCloseEditor = () => {
    if (hookBusyRef.current) return;
    if (revealedTokenRef.current && !tokenCopiedRef.current) {
      setPendingTargetTab(null);
      setDiscardTokenOpen(true);
      return;
    }
    closeEditorImmediately();
  };
  requestCloseEditorRef.current = requestCloseEditor;

  const handleConfirmDiscardToken = () => {
    const targetTab = pendingTargetTab;
    closeEditorImmediately();
    if (targetTab) {
      onNavigateTab?.(targetTab);
    }
  };

  // Block tab switches while create/rotate/save is in flight or an uncopied one-time token is shown
  useEffect(() => {
    if (!active || !onRegisterNavGuard) return;
    const guard = (nextTab: CenterAdminTab): boolean => {
      if (hookBusyRef.current) {
        return false;
      }
      if (editorOpenRef.current && revealedTokenRef.current && !tokenCopiedRef.current) {
        setPendingTargetTab(nextTab);
        setDiscardTokenOpen(true);
        return false;
      }
      return true;
    };
    onRegisterNavGuard(guard);
    return () => {
      onRegisterNavGuard(null);
    };
  }, [active, onRegisterNavGuard]);

  // Intercept app/hardware Back while editor is open (blocks during busy, prompts if token uncopied)
  useEffect(() => {
    if (!active || !editorOpen) return;
    const handleBack = () => {
      requestCloseEditorRef.current();
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
  }, [active, editorOpen, onRegisterBackHandler]);

  const openCreateWebhook = () => {
    setEditingRoute(null);
    setHookName('');
    const first = activeBots[0];
    setHookTargetKey(first ? botKey(first.deviceId, first.botId) : '');
    setHookInstruction('');
    setHookEnabled(true);
    setEditorError('');
    setPendingTargetTab(null);
    resetTokenReveal();
    editorOpenRef.current = true;
    setEditorOpen(true);
  };

  const openEditWebhook = (route: WebhookRoute) => {
    setEditingRoute(route);
    setHookName(route.name);
    setHookTargetKey(botKey(route.deviceId, route.botId));
    setHookInstruction(route.instruction);
    setHookEnabled(route.enabled);
    setEditorError('');
    setPendingTargetTab(null);
    resetTokenReveal();
    editorOpenRef.current = true;
    setEditorOpen(true);
  };

  const handleCopyRevealed = async (kind: 'token' | 'curl') => {
    if (!revealedToken) return;
    const payload =
      kind === 'token'
        ? revealedToken.token
        : `curl -X POST "${revealedToken.url}" -H "Authorization: Bearer ${revealedToken.token}" -H "Content-Type: application/json" -d '{"payload":{"event":"ping"}}'`;
    const ok = await copyToClipboard(payload);
    if (!ok) {
      setEditorError(t('无法自动复制到剪贴板，请手动选中上方一次性密钥进行复制。', 'Could not copy to clipboard automatically. Select and copy the one-time token above manually.'));
      return;
    }
    tokenCopiedRef.current = true;
    setTokenCopied(true);
    setCopiedKind(kind);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopiedKind(null);
    }, 1800);
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = parseTargetKey(hookTargetKey);
    if (!hookName.trim()) {
      setEditorError(t('无法保存 Webhook：未填写入口名称。请先输入名称后再保存。', 'Cannot save webhook: name is required. Enter a webhook name and try again.'));
      return;
    }
    if (!target) {
      setEditorError(t('无法保存 Webhook：未选择目标 Bot。请先选择一个可用设备的 Bot。', 'Cannot save webhook: no target Bot selected. Choose a Bot on an available device first.'));
      return;
    }
    if (!hookInstruction.trim()) {
      setEditorError(t('无法保存 Webhook：未填写触发指令。请说明收到外部事件后 Bot 需要执行的操作。', 'Cannot save webhook: trigger instruction is empty. Describe what the Bot should do when triggered.'));
      return;
    }

    hookBusyRef.current = true;
    setHookBusy(true);
    setEditorError('');
    try {
      if (editingRoute) {
        const updated = await api.updateWebhook(editingRoute.id, {
          name: hookName.trim(),
          instruction: hookInstruction.trim(),
          enabled: hookEnabled,
          deviceId: target.deviceId,
          botId: target.botId,
        });
        setRoutes(prev => prev.map(r => (r.id === updated.id ? updated : r)));
        setEditingRoute(updated);
        setNotice(t(`已保存 Webhook「${updated.name}」`, `Saved webhook "${updated.name}"`));
        if (!revealedTokenRef.current || tokenCopiedRef.current) {
          closeEditorImmediately();
        }
      } else {
        const receipt = await api.createWebhook({
          name: hookName.trim(),
          deviceId: target.deviceId,
          botId: target.botId,
          instruction: hookInstruction.trim(),
          enabled: hookEnabled,
        });
        const nextRevealed = { url: receipt.route.url, token: receipt.token };
        setRoutes(prev => [...prev, receipt.route]);
        setEditingRoute(receipt.route);
        revealedTokenRef.current = nextRevealed;
        tokenCopiedRef.current = false;
        setRevealedToken(nextRevealed);
        setTokenCopied(false);
        setCopiedKind(null);
        setNotice(t(`已创建 Webhook「${receipt.route.name}」，请复制保存下方一次性密钥`, `Created webhook "${receipt.route.name}". Copy and store the one-time token below.`));
      }
    } catch (err) {
      const reason = errorMessage(err, t('请稍后重试', 'Please try again'));
      setEditorError(t(`保存 Webhook 失败：${reason}。请检查输入或中心连接后重试。`, `Failed to save webhook: ${reason}. Check your inputs or center connection and retry.`));
    } finally {
      hookBusyRef.current = false;
      setHookBusy(false);
    }
  };

  const handleToggleWebhookRow = async (route: WebhookRoute, nextEnabled: boolean) => {
    setTogglingRouteId(route.id);
    setError('');
    try {
      const updated = await api.updateWebhook(route.id, {
        name: route.name,
        instruction: route.instruction,
        enabled: nextEnabled,
        deviceId: route.deviceId,
        botId: route.botId,
      });
      setRoutes(prev => prev.map(r => (r.id === updated.id ? updated : r)));
    } catch (err) {
      const reason = errorMessage(err, t('请求失败', 'Request failed'));
      setError(t(`切换 Webhook「${route.name}」状态失败：${reason}。请稍后重试。`, `Failed to toggle webhook "${route.name}": ${reason}. Please try again.`));
    } finally {
      setTogglingRouteId(null);
    }
  };

  const handleRotateWebhookToken = async () => {
    if (!editingRoute) return;
    hookBusyRef.current = true;
    setHookBusy(true);
    setEditorError('');
    try {
      const receipt = await api.rotateWebhookToken(editingRoute.id);
      const nextRevealed = { url: receipt.route.url, token: receipt.token };
      setConfirmAction(null);
      setEditingRoute(receipt.route);
      setRoutes(prev => prev.map(r => (r.id === receipt.route.id ? receipt.route : r)));
      revealedTokenRef.current = nextRevealed;
      tokenCopiedRef.current = false;
      setRevealedToken(nextRevealed);
      setTokenCopied(false);
      setCopiedKind(null);
      setNotice(t('已生成新的 Bearer 密钥，旧密钥已立即失效', 'New Bearer token generated; the previous token is now invalid'));
    } catch (err) {
      setConfirmAction(null);
      const reason = errorMessage(err, t('请求失败', 'Request failed'));
      setEditorError(t(`轮换密钥失败：${reason}。请重试。`, `Failed to rotate token: ${reason}. Please retry.`));
    } finally {
      hookBusyRef.current = false;
      setHookBusy(false);
    }
  };

  const handleDeleteWebhook = async () => {
    if (!editingRoute) return;
    const deleted = editingRoute;
    hookBusyRef.current = true;
    setHookBusy(true);
    setEditorError('');
    try {
      await api.deleteWebhook(deleted.id);
      const remaining = routes.filter(r => r.id !== deleted.id);
      setRoutes(remaining);
      if (selectedRouteFilter === deleted.id) {
        setSelectedRouteFilter('all');
        setShowAllEvents(false);
      }
      closeEditorImmediately();
      await loadWebhookEventsForRoutes(remaining);
      setNotice(t(`已删除 Webhook「${deleted.name}」`, `Deleted webhook "${deleted.name}"`));
    } catch (err) {
      setConfirmAction(null);
      const reason = errorMessage(err, t('请求失败', 'Request failed'));
      setEditorError(t(`删除 Webhook 失败：${reason}。请检查中心连接后重试。`, `Failed to delete webhook: ${reason}. Check your center connection and retry.`));
    } finally {
      hookBusyRef.current = false;
      setHookBusy(false);
    }
  };

  const handleManualRefreshEvents = async () => {
    setEventsRefreshing(true);
    try {
      await loadWebhookEventsForRoutes(routes);
    } finally {
      setEventsRefreshing(false);
    }
  };

  const filteredEvents = useMemo(() => {
    if (selectedRouteFilter === 'all') return events;
    return events.filter(ev => ev.routeId === selectedRouteFilter);
  }, [events, selectedRouteFilter]);

  const visibleEvents = useMemo(
    () => (showAllEvents ? filteredEvents : filteredEvents.slice(0, DEFAULT_EVENT_LIMIT)),
    [filteredEvents, showAllEvents],
  );

  const hasCurrentTargetOption = useMemo(() => {
    if (!hookTargetKey) return true;
    return groupedBotOptions.some(([, group]) =>
      group.bots.some(b => botKey(b.deviceId, b.botId) === hookTargetKey),
    );
  }, [groupedBotOptions, hookTargetKey]);

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaSectionSkeleton rows={3} headWidth={148} trailingWidth={112} label={t('正在加载 Webhook 触发入口…', 'Loading webhooks…')} />
        <CaSectionSkeleton rows={3} lines={1} headWidth={156} trailingWidth={132} />
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
                <span>{t('重试加载', 'Retry')}</span>
              </button>
            }
          >
            {initialError}
          </CaNotice>
        </div>
      </section>
    );
  }

  if (editorOpen) {
    const tokenCopyLabel = t('复制 Bearer 密钥', 'Copy Bearer Token');
    const tokenCopiedLabel = t('已复制密钥', 'Token Copied');
    const curlCopyLabel = t('复制 curl 示例', 'Copy curl Example');
    const curlCopiedLabel = t('已复制 curl', 'curl Copied');

    return (
      <div className="ca-form-stack">
        <CaRefreshBar active={refreshing} />

        <div className="ca-toolbar">
          <button
            type="button"
            className="ca-btn ca-btn-ghost ca-btn-sm"
            disabled={hookBusy}
            onClick={requestCloseEditor}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            <span>{t('返回 Webhook 列表', 'Back to Webhooks')}</span>
          </button>

          {editingRoute && (
            <span className={`ca-pill ${editingRoute.enabled ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
              {editingRoute.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}
            </span>
          )}
        </div>

        <section className="ca-section">
          <div className="ca-section-head">
            <h3 className="ca-section-title">
              {editingRoute
                ? t(`配置 Webhook · ${editingRoute.name}`, `Configure Webhook · ${editingRoute.name}`)
                : t('新建 Webhook', 'Create Webhook')}
            </h3>
          </div>

          <form className="ca-section-body ca-form-stack" onSubmit={e => void handleSaveWebhook(e)}>
            {editorError && <CaNotice tone="danger">{editorError}</CaNotice>}

            {revealedToken && (
              <div className="ca-cred-box">
                <div className="ca-inline-between">
                  <span className="ca-field-label">
                    {t('一次性 Bearer 密钥（离开后无法再次查看明文）', 'One-time Bearer token (cannot be viewed again after leaving)')}
                  </span>
                  <span className={`ca-pill ${tokenCopied ? 'ca-pill-ok' : 'ca-pill-warn'}`}>
                    {tokenCopied ? t('已复制', 'Copied') : t('尚未复制', 'Not copied yet')}
                  </span>
                </div>
                <div className="ca-muted ca-mono ca-mt-1 ca-break-all">
                  POST {revealedToken.url}
                </div>
                <div className="ca-mono ca-mt-1 ca-break-all">
                  Bearer {revealedToken.token}
                </div>
                <div className="ca-inline-row ca-wrap ca-mt-2">
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    onClick={() => void handleCopyRevealed('token')}
                  >
                    {copiedKind === 'token' ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Copy size={13} aria-hidden="true" />
                    )}
                    <LabelStack
                      active={copiedKind === 'token' ? tokenCopiedLabel : tokenCopyLabel}
                      labels={[tokenCopyLabel, tokenCopiedLabel]}
                    />
                  </button>
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => void handleCopyRevealed('curl')}
                  >
                    {copiedKind === 'curl' ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Copy size={13} aria-hidden="true" />
                    )}
                    <LabelStack
                      active={copiedKind === 'curl' ? curlCopiedLabel : curlCopyLabel}
                      labels={[curlCopyLabel, curlCopiedLabel]}
                    />
                  </button>
                </div>
              </div>
            )}

            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-webhook-name">
                {t('入口名称', 'Webhook Name')} <span className="ca-req">*</span>
              </label>
              <input
                id="ca-webhook-name"
                type="text"
                className="ca-input"
                required
                placeholder={t('例如：GitHub CI 告警', 'e.g. GitHub CI Alerts')}
                value={hookName}
                onChange={e => setHookName(e.target.value)}
              />
            </div>

            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-webhook-target">
                {t('目标 Bot', 'Target Bot')} <span className="ca-req">*</span>
              </label>
              <select
                id="ca-webhook-target"
                className="ca-select"
                value={hookTargetKey}
                onChange={e => setHookTargetKey(e.target.value)}
              >
                {groupedBotOptions.length === 0 && !hookTargetKey && (
                  <option value="">{t('暂无可用 Bot', 'No available Bots')}</option>
                )}
                {!hasCurrentTargetOption && hookTargetKey && (
                  <option value={hookTargetKey}>
                    {botDisplayMap.get(hookTargetKey) || hookTargetKey.replace('::', ' / ')}
                  </option>
                )}
                {groupedBotOptions.map(([devId, group]) => (
                  <optgroup key={devId} label={group.deviceName}>
                    {group.bots.map(b => (
                      <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                        {b.name || b.botId}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-webhook-instruction">
                {t('触发指令', 'Trigger Instruction')} <span className="ca-req">*</span>
              </label>
              <textarea
                id="ca-webhook-instruction"
                rows={5}
                className="ca-textarea"
                required
                placeholder={t('收到外部 Webhook payload 后交给目标 Bot 执行的指令', 'Instruction sent to the target Bot when an external Webhook payload arrives')}
                value={hookInstruction}
                onChange={e => setHookInstruction(e.target.value)}
              />
            </div>

            <div className="ca-inline-between">
              <span className="ca-field-label">{t('启用此 Webhook', 'Enable this webhook')}</span>
              <CaSwitch
                checked={hookEnabled}
                label={t('启用此 Webhook', 'Enable this webhook')}
                onChange={setHookEnabled}
              />
            </div>

            {editingRoute && (
              <div className="ca-cred-box">
                <div className="ca-inline-between ca-wrap">
                  <span className="ca-muted ca-mono ca-break-all">{editingRoute.url}</span>
                  <div className="ca-inline-row">
                    <CopyButton value={editingRoute.url} label={t('复制地址', 'Copy URL')} />
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      disabled={hookBusy}
                      onClick={() => setConfirmAction('rotate')}
                    >
                      {t('轮换密钥', 'Rotate Token')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="ca-form-actions ca-form-actions-between">
              <div>
                {editingRoute && (
                  <button
                    type="button"
                    className="ca-btn ca-btn-danger ca-btn-sm"
                    disabled={hookBusy}
                    onClick={() => setConfirmAction('delete')}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span>{t('删除 Webhook', 'Delete Webhook')}</span>
                  </button>
                )}
              </div>
              <div className="ca-inline-row">
                <button
                  type="button"
                  className="ca-btn"
                  disabled={hookBusy}
                  onClick={requestCloseEditor}
                >
                  {t('返回列表', 'Back to List')}
                </button>
                <button type="submit" className="ca-btn ca-btn-primary" disabled={hookBusy}>
                  <LabelStack
                    active={
                      hookBusy
                        ? editingRoute
                          ? t('保存中…', 'Saving…')
                          : t('创建中…', 'Creating…')
                        : editingRoute
                          ? t('保存修改', 'Save Changes')
                          : t('创建 Webhook', 'Create Webhook')
                    }
                    labels={[
                      editingRoute ? t('保存修改', 'Save Changes') : t('创建 Webhook', 'Create Webhook'),
                      editingRoute ? t('保存中…', 'Saving…') : t('创建中…', 'Creating…'),
                    ]}
                  />
                </button>
              </div>
            </div>
          </form>
        </section>

        <CaConfirmDialog
          open={confirmAction !== null && Boolean(editingRoute)}
          title={
            confirmAction === 'rotate'
              ? t('轮换 Bearer 密钥', 'Rotate Bearer Token')
              : t('删除 Webhook', 'Delete Webhook')
          }
          description={
            editingRoute
              ? confirmAction === 'rotate'
                ? t(`轮换「${editingRoute.name}」的密钥后，旧密钥会立即失效，使用旧密钥的外部请求将被拒绝。`, `Rotating the token for "${editingRoute.name}" immediately invalidates the old token. External callers using it will be rejected.`)
                : t(`删除「${editingRoute.name}」后，该地址将立即停止接收外部请求且无法恢复。`, `Deleting "${editingRoute.name}" stops all incoming requests to this endpoint permanently and cannot be undone.`)
              : ''
          }
          confirmLabel={
            confirmAction === 'rotate'
              ? t('确认轮换密钥', 'Rotate Token')
              : t('确认删除 Webhook', 'Delete Webhook')
          }
          cancelLabel={t('取消', 'Cancel')}
          danger
          busy={hookBusy}
          onCancel={() => {
            if (!hookBusy) setConfirmAction(null);
          }}
          onConfirm={() => {
            if (confirmAction === 'rotate') void handleRotateWebhookToken();
            else if (confirmAction === 'delete') void handleDeleteWebhook();
          }}
        />

        <CaConfirmDialog
          open={discardTokenOpen}
          title={t('尚未复制一次性 Bearer 密钥', 'One-time Bearer token not copied')}
          description={t('此 Bearer 密钥仅显示一次，离开当前页面后将无法再次查看明文。如果之后遗忘密钥，只能通过「轮换密钥」重新生成。', 'This Bearer token is shown only once and cannot be retrieved after leaving this view. If lost, you will need to rotate the token to generate a new one.')}
          confirmLabel={t('放弃密钥并离开', 'Discard Token & Leave')}
          cancelLabel={t('留下并复制', 'Stay and Copy')}
          danger
          onCancel={() => {
            setDiscardTokenOpen(false);
            setPendingTargetTab(null);
          }}
          onConfirm={handleConfirmDiscardToken}
        />
      </div>
    );
  }

  return (
    <div className="ca-form-stack">
      <CaRefreshBar active={refreshing} />

      <section className="ca-section">
        <div className="ca-section-head">
          <h3 className="ca-section-title">
            {t(`Webhook 触发入口 (${routes.length})`, `Webhooks (${routes.length})`)}
          </h3>
          <button
            type="button"
            className="ca-btn ca-btn-primary ca-btn-sm"
            onClick={openCreateWebhook}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t('新建 Webhook', 'Create Webhook')}</span>
          </button>
        </div>

        <div className="ca-list">
          {routes.length === 0 ? (
            <div className="ca-empty">
              <div className="ca-form-stack ca-center-stack">
                <div>{t('暂无 Webhook 触发入口。创建后可通过外部 HTTP POST 触发指定 Bot 执行任务。', 'No webhooks yet. Create one to trigger a target Bot via external HTTP POST requests.')}</div>
                <button
                  type="button"
                  className="ca-btn ca-btn-primary ca-btn-sm"
                  onClick={openCreateWebhook}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{t('新建首个 Webhook', 'Create First Webhook')}</span>
                </button>
              </div>
            </div>
          ) : (
            routes.map(route => {
              const targetLabel =
                botDisplayMap.get(botKey(route.deviceId, route.botId)) ||
                `${route.deviceId} / ${route.botId}`;
              return (
                <div key={route.id} className="ca-row ca-row-split">
                  <button
                    type="button"
                    className="ca-row-trigger"
                    onClick={() => openEditWebhook(route)}
                  >
                    <span className="ca-row-title">
                      <span
                        className={`ca-dot ${route.enabled ? 'is-online' : ''}`}
                        aria-hidden="true"
                      />
                      <span>{route.name}</span>
                      <span className={`ca-pill ${route.enabled ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
                        {route.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}
                      </span>
                    </span>
                    <span className="ca-row-sub">
                      {t(`目标 Bot：${targetLabel}`, `Target Bot: ${targetLabel}`)}
                    </span>
                  </button>
                  <div className="ca-row-actions">
                    <CaSwitch
                      checked={route.enabled}
                      disabled={togglingRouteId === route.id}
                      label={t(`启用 Webhook ${route.name}`, `Enable webhook ${route.name}`)}
                      onChange={next => void handleToggleWebhookRow(route, next)}
                    />
                    <button
                      type="button"
                      className="ca-btn ca-btn-ghost ca-btn-sm"
                      onClick={() => openEditWebhook(route)}
                    >
                      <span>{t('配置', 'Configure')}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="ca-section">
        <div className="ca-section-head">
          <h3 className="ca-section-title">
            {t('最近触发记录', 'Recent Trigger Events')}
            {filteredEvents.length > 0 ? (
              <span className="ca-muted ca-num"> ({filteredEvents.length})</span>
            ) : null}
          </h3>
          <div className="ca-inline-row">
            {routes.length > 0 && (
              <select
                className="ca-select ca-select-compact"
                aria-label={t('按 Webhook 筛选触发记录', 'Filter events by webhook')}
                value={selectedRouteFilter}
                onChange={e => {
                  setSelectedRouteFilter(e.target.value);
                  setShowAllEvents(false);
                }}
              >
                <option value="all">{t('全部 Webhook', 'All Webhooks')}</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ca-btn ca-btn-ghost ca-btn-icon"
              aria-label={t('刷新触发记录', 'Refresh trigger events')}
              title={t('刷新触发记录', 'Refresh trigger events')}
              disabled={eventsRefreshing}
              onClick={() => void handleManualRefreshEvents()}
            >
              <RefreshCw
                size={14}
                className={eventsRefreshing ? 'ca-spin' : undefined}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <div className="ca-list">
          {filteredEvents.length === 0 ? (
            <div className="ca-empty">
              {t('暂无触发记录。向已启用的 Webhook 发送请求后，事件会显示在这里。', 'No trigger events yet. Events appear here after requests hit an enabled webhook.')}
            </div>
          ) : (
            <>
              {visibleEvents.map(ev => {
                const meta = eventStatusMeta(ev.status, t);
                const expanded = expandedEventId === ev.id;
                const targetName =
                  botDisplayMap.get(botKey(ev.deviceId, ev.botId)) || `${ev.deviceId} / ${ev.botId}`;
                return (
                  <div
                    key={ev.id}
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    className="ca-row is-clickable ca-row-col"
                    onClick={() => setExpandedEventId(expanded ? null : ev.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedEventId(expanded ? null : ev.id);
                      }
                    }}
                  >
                    <div className="ca-inline-between ca-full-w">
                      <div className="ca-row-title ca-text-sm">
                        <span className="ca-muted ca-num">{formatTime(ev.receivedAt, locale)}</span>
                        <span>{ev.routeName}</span>
                        <span className="ca-muted">→ {targetName}</span>
                      </div>
                      <span className={`ca-pill ca-pill-${meta.tone}`}>{meta.label}</span>
                    </div>

                    {expanded && (
                      <div className="ca-cred-box ca-full-w smooth-expand-mount">
                        <div className="ca-muted ca-mono">requestId: {ev.requestId}</div>
                        <div className="ca-muted ca-mono">idempotencyKey: {ev.idempotencyKey}</div>
                        {ev.admission && (
                          <div className="ca-muted">
                            {t(`准入状态：${ev.admission.phase}`, `Admission: ${ev.admission.phase}`)}
                            {ev.admission.error ? ` (${ev.admission.error.message})` : ''}
                          </div>
                        )}
                        {ev.error && <div className="ca-error-text">{ev.error.message}</div>}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredEvents.length > DEFAULT_EVENT_LIMIT && (
                <div className="ca-row ca-justify-center">
                  <button
                    type="button"
                    className="ca-btn ca-btn-ghost ca-btn-sm"
                    onClick={() => setShowAllEvents(prev => !prev)}
                  >
                    <span>
                      {showAllEvents
                        ? t('收起为最近 10 条', 'Show latest 10')
                        : t('查看全部记录', 'Show all events')}
                    </span>
                    {!showAllEvents && (
                      <span className="ca-muted ca-num">({filteredEvents.length})</span>
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
