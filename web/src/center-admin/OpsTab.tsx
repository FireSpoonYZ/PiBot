import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  Download,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Webhook,
} from 'lucide-react';
import { LabelStack } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  CaDisclosure,
  CaModal,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSegmented,
  CaSwitch,
  CaToolbarSkeleton,
  CopyButton,
  botKey,
  formatTime,
  useCaTabNotices,
  useUiLocale,
} from './primitives';
import type {
  CenterBotRef,
  CenterDevice,
  ClientReleaseArch,
  ClientReleaseFormat,
  ClientReleaseMetadata,
  ClientReleasePlatform,
  ClientReleaseRecord,
  WebhookEvent,
  WebhookRoute,
} from './types';

type TranslateFn = ReturnType<typeof useText>;

function getPlatformCombinations(
  t: TranslateFn,
): Record<
  ClientReleasePlatform,
  Array<{ arch: ClientReleaseArch; format: ClientReleaseFormat; label: string }>
> {
  return {
    windows: [{ arch: 'x86_64', format: 'nsis', label: 'Windows x86_64 (.exe NSIS)' }],
    linux: [{ arch: 'x86_64', format: 'deb', label: 'Linux x86_64 (.deb)' }],
    macos: [{ arch: 'aarch64', format: 'app', label: 'macOS Apple Silicon (.app.tar.gz)' }],
    android: [
      { arch: 'aarch64', format: 'apk', label: 'Android ARM64 (.apk)' },
      { arch: 'x86_64', format: 'apk', label: t('Android x86_64 (.apk 模拟器)', 'Android x86_64 (.apk emulator)') },
    ],
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function computeSha256Hex(file: File, t: TranslateFn): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(t('当前运行环境不支持 WebCrypto SHA-256 计算', 'Current runtime does not support WebCrypto SHA-256'));
  }
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function inferFromFilename(name: string): Partial<ClientReleaseMetadata> {
  const lower = name.toLowerCase();
  const verMatch = name.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  const version = verMatch ? verMatch[1] : undefined;

  if (lower.endsWith('.exe')) {
    return { version, platform: 'windows', arch: 'x86_64', format: 'nsis' };
  }
  if (lower.endsWith('.deb')) {
    return { version, platform: 'linux', arch: 'x86_64', format: 'deb' };
  }
  if (lower.endsWith('.app.tar.gz') || lower.endsWith('.tar.gz')) {
    return { version, platform: 'macos', arch: 'aarch64', format: 'app' };
  }
  if (lower.endsWith('.apk')) {
    const arch: ClientReleaseArch = lower.includes('x86_64') || lower.includes('x64') ? 'x86_64' : 'aarch64';
    return { version, platform: 'android', arch, format: 'apk' };
  }
  return { version };
}

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

interface OpsCacheData {
  devices: CenterDevice[];
  bots: CenterBotRef[];
  routes: WebhookRoute[];
  events: WebhookEvent[];
  releases: ClientReleaseRecord[];
}

export function OpsTab({
  api,
  active = true,
  cacheKey = 'default',
  onOpenExternal,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  onOpenExternal?: () => void;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();

  const initialCache = useMemo(
    () => readTabCache<OpsCacheData>(cacheKey, 'ops')?.data ?? null,
    [cacheKey],
  );
  const [segment, setSegment] = useState<'webhooks' | 'releases'>('webhooks');
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');

  // Shared device/bot directory for Webhook target picker
  const [devices, setDevices] = useState<CenterDevice[]>(() => initialCache?.devices ?? []);
  const [bots, setBots] = useState<CenterBotRef[]>(() => initialCache?.bots ?? []);

  // Webhooks state
  const [routes, setRoutes] = useState<WebhookRoute[]>(() => initialCache?.routes ?? []);
  const [events, setEvents] = useState<WebhookEvent[]>(() => initialCache?.events ?? []);
  const [selectedRouteFilter, setSelectedRouteFilter] = useState<string>('all');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [togglingRouteId, setTogglingRouteId] = useState<string | null>(null);

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('ops', active);

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

  // Webhook drawer state
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<WebhookRoute | null>(null);
  const [hookName, setHookName] = useState('');
  const [hookTargetKey, setHookTargetKey] = useState('');
  const [hookInstruction, setHookInstruction] = useState('');
  const [hookEnabled, setHookEnabled] = useState(true);
  const [hookBusy, setHookBusy] = useState(false);
  const [revealedToken, setRevealedToken] = useState<{ url: string; token: string } | null>(null);

  const setHookError = useCallback(
    (msg: string) => {
      if (msg) showNotice('hook-error', msg, { tone: 'danger' });
      else clearNotice('hook-error');
    },
    [clearNotice, showNotice],
  );

  // Releases state
  const [releases, setReleases] = useState<ClientReleaseRecord[]>(() => initialCache?.releases ?? []);
  const [releaseFile, setReleaseFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [relVersion, setRelVersion] = useState('');
  const [relPlatform, setRelPlatform] = useState<ClientReleasePlatform>('windows');
  const [relArch, setRelArch] = useState<ClientReleaseArch>('x86_64');
  const [relFormat, setRelFormat] = useState<ClientReleaseFormat>('nsis');
  const [relNotes, setRelNotes] = useState('');
  const [relSha256, setRelSha256] = useState('');
  const [relSize, setRelSize] = useState(0);
  const [relVersionCode, setRelVersionCode] = useState('');
  const [relSourceCommit, setRelSourceCommit] = useState('manual');
  const [relSignature, setRelSignature] = useState('');
  const [relAutoPublish, setRelAutoPublish] = useState(true);
  const [relBusy, setRelBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const setRelError = useCallback(
    (msg: string, needsBrowser = false) => {
      if (msg) {
        const t = tRef.current;
        showNotice('release-error', msg, {
          tone: 'danger',
          action:
            needsBrowser && onOpenExternal
              ? { label: t('在浏览器打开上传', 'Open in browser to upload'), onClick: onOpenExternal }
              : undefined,
        });
      } else {
        clearNotice('release-error');
      }
    },
    [clearNotice, onOpenExternal, showNotice],
  );

  const platformCombinations = useMemo(() => getPlatformCombinations(t), [t]);

  const activeBots = useMemo(() => bots.filter(b => !b.archivedAt), [bots]);

  const botDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bots) {
      map.set(botKey(b.deviceId, b.botId), `${b.deviceName || b.deviceId} / ${b.name || b.botId}`);
    }
    return map;
  }, [bots]);

  const loadWebhookEventsForRoutes = useCallback(
    async (routeList: WebhookRoute[]) => {
      if (routeList.length === 0) {
        setEvents([]);
        return;
      }
      const chunks = await Promise.all(
        routeList.map(r => api.listWebhookEvents(r.id).then(res => res.items).catch(() => [] as WebhookEvent[])),
      );
      const merged = chunks.flat().sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
      setEvents(merged);
    },
    [api],
  );

  const loadAll = useCallback(async () => {
    const [sync, hookRes, relRes] = await Promise.all([
      api.getBotSync(),
      api.listWebhooks().catch(() => ({ items: [] as WebhookRoute[] })),
      api.listClientReleases().catch(() => ({ releases: [] as ClientReleaseRecord[] })),
    ]);
    setDevices(sync.devices);
    setBots(sync.bots ?? []);
    setRoutes(hookRes.items);
    setReleases(relRes.releases);
    await loadWebhookEventsForRoutes(hookRes.items);
    hasLoadedRef.current = true;
    cacheKeyRef.current = cacheKey;
    setHasLoaded(true);
    setInitialError('');
    clearNotice('load-error');
  }, [api, cacheKey, clearNotice, loadWebhookEventsForRoutes]);

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll();
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const msg = errorMessage(err, t('加载触发与版本数据失败', 'Failed to load triggers and releases'));
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
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<OpsCacheData>(cacheKey, 'ops', {
      devices,
      bots,
      routes,
      events,
      releases,
    });
  }, [bots, cacheKey, devices, events, hasLoaded, releases, routes]);

  // 5s silent auto-refresh for Webhook events while tab and Webhook segment are active
  useEffect(() => {
    if (!active || segment !== 'webhooks' || routes.length === 0) return;
    const timer = window.setInterval(() => {
      void loadWebhookEventsForRoutes(routes);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, loadWebhookEventsForRoutes, routes, segment]);

  // Webhook Handlers
  const openCreateWebhook = () => {
    setEditingRoute(null);
    setHookName('');
    const first = activeBots[0];
    setHookTargetKey(first ? botKey(first.deviceId, first.botId) : '');
    setHookInstruction('');
    setHookEnabled(true);
    setHookError('');
    setRevealedToken(null);
    setHookModalOpen(true);
  };

  const openEditWebhook = (route: WebhookRoute) => {
    setEditingRoute(route);
    setHookName(route.name);
    setHookTargetKey(botKey(route.deviceId, route.botId));
    setHookInstruction(route.instruction);
    setHookEnabled(route.enabled);
    setHookError('');
    setRevealedToken(null);
    setHookModalOpen(true);
  };

  const parseTargetKey = (key: string): { deviceId: string; botId: string } | null => {
    const idx = key.indexOf('::');
    if (idx <= 0) return null;
    return { deviceId: key.slice(0, idx), botId: key.slice(idx + 2) };
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = parseTargetKey(hookTargetKey);
    if (!hookName.trim()) {
      setHookError(t('请填写触发入口名称', 'Please enter a webhook name'));
      return;
    }
    if (!target) {
      setHookError(t('请选择目标设备与 Bot', 'Please select a target device and Bot'));
      return;
    }
    if (!hookInstruction.trim()) {
      setHookError(t('请填写触发指令提示词', 'Please enter the trigger instruction'));
      return;
    }
    setHookBusy(true);
    setHookError('');
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
        setNotice(t(`已更新触发入口「${updated.name}」`, `Updated webhook "${updated.name}"`));
        setHookModalOpen(false);
      } else {
        const receipt = await api.createWebhook({
          name: hookName.trim(),
          deviceId: target.deviceId,
          botId: target.botId,
          instruction: hookInstruction.trim(),
          enabled: hookEnabled,
        });
        setRoutes(prev => [...prev, receipt.route]);
        setEditingRoute(receipt.route);
        setRevealedToken({ url: receipt.route.url, token: receipt.token });
        setNotice(t(`已创建触发入口「${receipt.route.name}」，请保存下方一次性密钥`, `Created webhook "${receipt.route.name}". Save the one-time token below.`));
      }
    } catch (err) {
      setHookError(errorMessage(err, t('保存触发入口失败', 'Failed to save webhook')));
    } finally {
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
      setError(errorMessage(err, t('切换触发入口状态失败', 'Failed to toggle webhook status')));
    } finally {
      setTogglingRouteId(null);
    }
  };

  const handleRotateWebhookToken = async () => {
    if (!editingRoute) return;
    if (!window.confirm(t('轮换后旧密钥将立即失效，确认继续吗？', 'Rotating will immediately invalidate the old token. Continue?'))) return;
    setHookBusy(true);
    setHookError('');
    try {
      const receipt = await api.rotateWebhookToken(editingRoute.id);
      setRevealedToken({ url: receipt.route.url, token: receipt.token });
      setEditingRoute(receipt.route);
      setNotice(t('已生成新触发密钥', 'New webhook token generated'));
    } catch (err) {
      setHookError(errorMessage(err, t('轮换密钥失败', 'Failed to rotate token')));
    } finally {
      setHookBusy(false);
    }
  };

  const handleDeleteWebhook = async () => {
    if (!editingRoute) return;
    if (!window.confirm(t(`确定删除触发入口「${editingRoute.name}」吗？`, `Delete webhook "${editingRoute.name}"?`))) return;
    setHookBusy(true);
    setHookError('');
    try {
      await api.deleteWebhook(editingRoute.id);
      const remaining = routes.filter(r => r.id !== editingRoute.id);
      setRoutes(remaining);
      setHookModalOpen(false);
      await loadWebhookEventsForRoutes(remaining);
      setNotice(t(`已删除触发入口「${editingRoute.name}」`, `Deleted webhook "${editingRoute.name}"`));
    } catch (err) {
      setHookError(errorMessage(err, t('删除触发入口失败', 'Failed to delete webhook')));
    } finally {
      setHookBusy(false);
    }
  };

  // Release File Drop / Selection
  const handleFilesSelected = async (fileList: FileList | File[]) => {
    setRelError('');
    const files = Array.from(fileList);
    if (files.length === 0) return;

    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.json')) {
        try {
          const parsed = JSON.parse(await f.text()) as Record<string, unknown>;
          if (typeof parsed.version === 'string') setRelVersion(parsed.version);
          if (
            parsed.platform === 'windows' ||
            parsed.platform === 'linux' ||
            parsed.platform === 'macos' ||
            parsed.platform === 'android'
          ) {
            setRelPlatform(parsed.platform);
          }
          if (parsed.arch === 'x86_64' || parsed.arch === 'aarch64') setRelArch(parsed.arch);
          if (
            parsed.format === 'nsis' ||
            parsed.format === 'deb' ||
            parsed.format === 'app' ||
            parsed.format === 'apk'
          ) {
            setRelFormat(parsed.format);
          }
          if (typeof parsed.notes === 'string') setRelNotes(parsed.notes);
          if (typeof parsed.sourceCommit === 'string') setRelSourceCommit(parsed.sourceCommit);
          if (typeof parsed.signature === 'string') setRelSignature(parsed.signature);
          if (typeof parsed.versionCode === 'number') setRelVersionCode(String(parsed.versionCode));
          if (typeof parsed.sha256 === 'string') setRelSha256(parsed.sha256);
          if (typeof parsed.size === 'number') setRelSize(parsed.size);
        } catch {
          setRelError(t(`元数据文件 ${f.name} JSON 解析失败`, `Failed to parse metadata JSON file ${f.name}`));
        }
      } else if (lower.endsWith('.sig')) {
        const sigText = await f.text().catch(() => '');
        if (sigText) setRelSignature(sigText.trim());
      } else {
        setReleaseFile(f);
        setRelSize(f.size);
        const inferred = inferFromFilename(f.name);
        if (inferred.version) setRelVersion(inferred.version);
        if (inferred.platform) setRelPlatform(inferred.platform);
        if (inferred.arch) setRelArch(inferred.arch);
        if (inferred.format) setRelFormat(inferred.format);
        try {
          const sha = await computeSha256Hex(f, t);
          setRelSha256(sha);
        } catch (err) {
          setRelError(errorMessage(err, t('计算 SHA-256 失败', 'Failed to compute SHA-256')));
        }
      }
    }
  };

  const handleUploadRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!releaseFile) {
      setRelError(t('请先拖入或选择安装包文件', 'Please drop or choose a package file first'));
      return;
    }
    if (!relVersion.trim()) {
      setRelError(t('请填写版本号（如 1.2.3）', 'Please enter a version (e.g. 1.2.3)'));
      return;
    }
    if (!relSha256.trim()) {
      setRelError(t('SHA-256 尚未计算完成，请稍候重试', 'SHA-256 is still computing; please retry shortly'));
      return;
    }
    const parsedCode = relVersionCode.trim() ? Number(relVersionCode.trim()) : undefined;
    if (relFormat === 'apk' && (!parsedCode || !Number.isSafeInteger(parsedCode) || parsedCode < 1)) {
      setRelError(t('Android APK 需要填写正整数 versionCode（可在下方高级元数据展开填写）', 'Android APK requires a positive integer versionCode (expand Advanced Metadata below)'));
      return;
    }

    const meta: ClientReleaseMetadata = {
      version: relVersion.trim(),
      platform: relPlatform,
      arch: relArch,
      format: relFormat,
      size: relSize || releaseFile.size,
      sha256: relSha256.trim().toLowerCase(),
      sourceCommit: relSourceCommit.trim() || 'manual',
      ...(relNotes.trim() ? { notes: relNotes.trim() } : {}),
      ...(relPlatform !== 'android' && relSignature.trim() ? { signature: relSignature.trim() } : {}),
      ...(parsedCode ? { versionCode: parsedCode } : {}),
    };

    setRelBusy(true);
    setRelError('');
    try {
      const created = await api.createClientRelease(meta, releaseFile);
      let finalRecord = created;
      if (relAutoPublish) {
        finalRecord = await api.publishClientRelease(created.id, { published: true });
      }
      setReleases(prev => [finalRecord, ...prev.filter(r => r.id !== finalRecord.id)]);
      setReleaseFile(null);
      setRelNotes('');
      setRelSha256('');
      setRelSize(0);
      setNotice(
        relAutoPublish
          ? t(`版本 v${finalRecord.version} 已上传并发布`, `Release v${finalRecord.version} uploaded and published`)
          : t(`版本 v${finalRecord.version} 已保存为草稿`, `Release v${finalRecord.version} saved as draft`),
      );
    } catch (err) {
      const needsBrowser = err instanceof CenterApiError && err.code === 'UNSUPPORTED_FORM_DATA';
      setRelError(errorMessage(err, t('上传版本失败', 'Failed to upload release')), needsBrowser);
    } finally {
      setRelBusy(false);
    }
  };

  const handleTogglePublishRelease = async (record: ClientReleaseRecord) => {
    setRelBusy(true);
    setError('');
    try {
      const updated = await api.publishClientRelease(record.id, { published: !record.published });
      setReleases(prev => prev.map(r => (r.id === updated.id ? updated : r)));
      setNotice(
        updated.published
          ? t(`已发布 v${updated.version}`, `Published v${updated.version}`)
          : t(`已撤回发布 v${updated.version}`, `Unpublished v${updated.version}`),
      );
    } catch (err) {
      setError(errorMessage(err, t('切换发布状态失败', 'Failed to toggle publish status')));
    } finally {
      setRelBusy(false);
    }
  };

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

  const filteredEvents = useMemo(() => {
    if (selectedRouteFilter === 'all') return events;
    return events.filter(ev => ev.routeId === selectedRouteFilter);
  }, [events, selectedRouteFilter]);

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaToolbarSkeleton leftWidth={210} rightWidth={112} />
        <CaSectionSkeleton rows={3} headWidth={120} trailingWidth={48} label={t('正在加载触发与版本管理…', 'Loading triggers & releases…')} />
        <CaSectionSkeleton rows={3} lines={1} headWidth={176} trailingWidth={132} />
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
                <span>{t('重试', 'Retry')}</span>
              </button>
            }
          >
            {initialError}
          </CaNotice>
        </div>
      </section>
    );
  }

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      <div className="ca-toolbar">
        <CaSegmented
          ariaLabel={t('触发与版本分区', 'Triggers & releases sections')}
          value={segment}
          options={[
            { value: 'webhooks', label: t('外部触发 (Webhook)', 'Webhooks') },
            { value: 'releases', label: t('客户端版本', 'Client Releases') },
          ]}
          onChange={setSegment}
        />

        {segment === 'webhooks' && (
          <button type="button" className="ca-btn ca-btn-primary ca-btn-sm" onClick={openCreateWebhook}>
            <Plus size={14} aria-hidden="true" />
            <span>{t('新建触发入口', 'New Webhook')}</span>
          </button>
        )}
      </div>

      {segment === 'webhooks' ? (
        <div className="ca-form-stack">
          {/* Webhook routes list */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">
                {t(`触发入口 (${routes.length})`, `Webhooks (${routes.length})`)}
              </h3>
            </div>
            <div className="ca-list">
              {routes.length === 0 ? (
                <div className="ca-empty">
                  {t('暂无 Webhook 触发入口，点击右上角「+ 新建触发入口」添加', 'No webhooks yet. Click "+ New Webhook" in the top right to add one.')}
                </div>
              ) : (
                routes.map(route => (
                  <div key={route.id} className="ca-row ca-row-split">
                    <button
                      type="button"
                      className="ca-row-trigger"
                      onClick={() => openEditWebhook(route)}
                    >
                      <span className="ca-row-title">
                        <Webhook size={14} aria-hidden="true" />
                        <span>{route.name}</span>
                        <span className={`ca-pill ${route.enabled ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
                          {route.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}
                        </span>
                      </span>
                      <span className="ca-row-sub">
                        {t(`目标：${botDisplayMap.get(botKey(route.deviceId, route.botId)) || `${route.deviceId} / ${route.botId}`}`, `Target: ${botDisplayMap.get(botKey(route.deviceId, route.botId)) || `${route.deviceId} / ${route.botId}`}`)}
                      </span>
                    </button>
                    <div className="ca-row-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openEditWebhook(route)}
                      >
                        {t('编辑', 'Edit')}
                      </button>
                      <CaSwitch
                        checked={route.enabled}
                        disabled={togglingRouteId === route.id}
                        label={t(`启用触发入口 ${route.name}`, `Enable webhook ${route.name}`)}
                        onChange={next => void handleToggleWebhookRow(route, next)}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Recent webhook trigger events (5s silent auto-refresh) */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">{t('最近触发记录（自动刷新）', 'Recent Trigger Events (Auto-refresh)')}</h3>
              <div className="ca-inline-row">
                <select
                  className="ca-select ca-select-compact"
                  aria-label={t('按触发入口筛选', 'Filter by webhook')}
                  value={selectedRouteFilter}
                  onChange={e => setSelectedRouteFilter(e.target.value)}
                >
                  <option value="all">{t('全部入口', 'All Webhooks')}</option>
                  {routes.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-icon"
                  aria-label={t('刷新记录', 'Refresh events')}
                  onClick={() => void loadWebhookEventsForRoutes(routes)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="ca-list">
              {filteredEvents.length === 0 ? (
                <div className="ca-empty">{t('暂无外部触发事件记录', 'No webhook events yet')}</div>
              ) : (
                filteredEvents.slice(0, 40).map(ev => {
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
                })
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="ca-form-stack">
          {/* Single file dropzone + auto-inferred metadata */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">{t('上传客户端安装包', 'Upload Client Package')}</h3>
            </div>
            <form className="ca-section-body ca-form-stack" onSubmit={e => void handleUploadRelease(e)}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="ca-hidden"
                accept=".exe,.deb,.tar.gz,.apk,.json,.sig"
                onChange={e => {
                  if (e.target.files) void handleFilesSelected(e.target.files);
                }}
              />
              <div
                role="button"
                tabIndex={0}
                className={`ca-dropzone ${dragging ? 'is-dragging' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={e => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragging(false);
                  if (e.dataTransfer.files.length > 0) void handleFilesSelected(e.dataTransfer.files);
                }}
              >
                <Upload size={20} aria-hidden="true" className="ca-dropzone-icon" />
                <div className="ca-dropzone-title">
                  {releaseFile
                    ? `${releaseFile.name} (${formatBytes(relSize || releaseFile.size)})`
                    : t('点击或拖入安装包（可同时拖入 CI release.json / .sig）', 'Click or drop a package here (also supports CI release.json / .sig)')}
                </div>
                <div className="ca-muted ca-mt-1">
                  {t('自动计算 SHA-256 与文件大小，并从文件名或 release.json 自动识别平台与版本号', 'Automatically computes SHA-256 & size and detects platform/version from filename or release.json')}
                </div>
              </div>

              <div className="ca-grid-2">
                <div className="ca-field">
                  <label className="ca-field-label">
                    {t('版本号', 'Version')} <span className="ca-req">*</span>
                  </label>
                  <input
                    type="text"
                    className="ca-input ca-mono"
                    placeholder={t('如 1.4.0', 'e.g. 1.4.0')}
                    value={relVersion}
                    onChange={e => setRelVersion(e.target.value)}
                  />
                </div>
                <div className="ca-field">
                  <label className="ca-field-label">{t('目标平台与格式', 'Target Platform & Format')}</label>
                  <select
                    className="ca-select"
                    value={`${relPlatform}:${relArch}:${relFormat}`}
                    onChange={e => {
                      const [p, a, f] = e.target.value.split(':') as [
                        ClientReleasePlatform,
                        ClientReleaseArch,
                        ClientReleaseFormat,
                      ];
                      setRelPlatform(p);
                      setRelArch(a);
                      setRelFormat(f);
                    }}
                  >
                    {(Object.keys(platformCombinations) as ClientReleasePlatform[]).flatMap(p =>
                      platformCombinations[p].map(combo => (
                        <option
                          key={`${p}:${combo.arch}:${combo.format}`}
                          value={`${p}:${combo.arch}:${combo.format}`}
                        >
                          {combo.label}
                        </option>
                      )),
                    )}
                  </select>
                </div>
              </div>

              <div className="ca-field">
                <label className="ca-field-label">{t('更新说明（可选）', 'Release Notes (optional)')}</label>
                <input
                  type="text"
                  className="ca-input"
                  placeholder={t('简述此版本修复或新增内容', 'Briefly describe fixes or new features')}
                  value={relNotes}
                  onChange={e => setRelNotes(e.target.value)}
                />
              </div>

              <CaDisclosure title={t('高级元数据（versionCode / sourceCommit / 签名 / SHA-256）', 'Advanced Metadata (versionCode / sourceCommit / Signature / SHA-256)')}>
                <div className="ca-form-stack">
                  <div className="ca-grid-2">
                    <div className="ca-field">
                      <label className="ca-field-label">{t('Android versionCode（APK 必填）', 'Android versionCode (required for APK)')}</label>
                      <input
                        type="number"
                        className="ca-input ca-num"
                        placeholder={t('如 10400', 'e.g. 10400')}
                        value={relVersionCode}
                        onChange={e => setRelVersionCode(e.target.value)}
                      />
                    </div>
                    <div className="ca-field">
                      <label className="ca-field-label">{t('源码提交 (sourceCommit)', 'Source Commit (sourceCommit)')}</label>
                      <input
                        type="text"
                        className="ca-input ca-mono"
                        value={relSourceCommit}
                        onChange={e => setRelSourceCommit(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="ca-field">
                    <label className="ca-field-label">SHA-256</label>
                    <input
                      type="text"
                      className="ca-input ca-mono"
                      value={relSha256}
                      onChange={e => setRelSha256(e.target.value)}
                    />
                  </div>
                  {relPlatform !== 'android' && (
                    <div className="ca-field">
                      <label className="ca-field-label">{t('更新签名 (.sig 内容，可选)', 'Update Signature (.sig content, optional)')}</label>
                      <textarea
                        rows={2}
                        className="ca-textarea ca-mono"
                        value={relSignature}
                        onChange={e => setRelSignature(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </CaDisclosure>

              <div className="ca-inline-between ca-wrap">
                <label className="ca-check-label">
                  <input
                    type="checkbox"
                    checked={relAutoPublish}
                    onChange={e => setRelAutoPublish(e.target.checked)}
                  />
                  <span>{t('上传后立即发布给客户端检查更新', 'Publish immediately for client update checks')}</span>
                </label>
                <button type="submit" className="ca-btn ca-btn-primary ca-btn-sm" disabled={relBusy || !releaseFile}>
                  <LabelStack
                    active={
                      relBusy
                        ? t('上传中…', 'Uploading…')
                        : relAutoPublish
                          ? t('上传并发布', 'Upload & Publish')
                          : t('保存为草稿', 'Save Draft')
                    }
                    labels={[t('上传并发布', 'Upload & Publish'), t('保存为草稿', 'Save Draft'), t('上传中…', 'Uploading…')]}
                  />
                </button>
              </div>
            </form>
          </section>

          {/* Uploaded releases list */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">
                {t(`版本历史 (${releases.length})`, `Release History (${releases.length})`)}
              </h3>
            </div>
            <div className="ca-list">
              {releases.length === 0 ? (
                <div className="ca-empty">{t('尚未上传任何客户端安装包', 'No client packages uploaded yet')}</div>
              ) : (
                releases.map(rec => (
                  <div key={rec.id} className="ca-row">
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <span>
                          {rec.platform} · {rec.arch} · v{rec.version}
                        </span>
                        <span className="ca-pill ca-pill-muted">{rec.format}</span>
                        <span className={`ca-pill ${rec.published ? 'ca-pill-ok' : 'ca-pill-warn'}`}>
                          {rec.published ? t('已发布', 'Published') : t('草稿', 'Draft')}
                        </span>
                      </div>
                      <div className="ca-row-sub ca-num">
                        {rec.filename} · {formatBytes(rec.size)} · SHA256:{rec.sha256.slice(0, 12)}…
                        {rec.notes ? ` · ${rec.notes}` : ''}
                      </div>
                    </div>
                    <div className="ca-row-actions">
                      <a href={rec.downloadUrl} download={rec.filename} className="ca-btn ca-btn-sm">
                        <Download size={13} aria-hidden="true" />
                        <span>{t('下载', 'Download')}</span>
                      </a>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        disabled={relBusy}
                        onClick={() => void handleTogglePublishRelease(rec)}
                      >
                        <LabelStack
                          active={rec.published ? t('撤回', 'Unpublish') : t('发布', 'Publish')}
                          labels={[t('发布', 'Publish'), t('撤回', 'Unpublish')]}
                        />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* Webhook create / edit drawer */}
      <CaModal
        open={hookModalOpen}
        onOpenChange={open => {
          if (!open) setHookError('');
          setHookModalOpen(open);
        }}
        title={
          editingRoute
            ? t(`编辑触发入口 · ${editingRoute.name}`, `Edit Webhook · ${editingRoute.name}`)
            : t('新建触发入口', 'New Webhook')
        }
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveWebhook(e)}>
          {revealedToken && (
            <div className="ca-cred-box">
              <div className="ca-field-label">
                {t('触发地址与一次性密钥（关闭后不可再次明文查看）', 'Webhook URL & One-Time Token (cannot be viewed again after closing)')}
              </div>
              <div className="ca-muted ca-mono ca-mt-1 ca-break-all">
                POST {revealedToken.url}
              </div>
              <div className="ca-muted ca-mono ca-mt-1 ca-break-all">
                Bearer {revealedToken.token}
              </div>
              <div className="ca-inline-row ca-wrap ca-mt-2">
                <CopyButton value={revealedToken.token} label={t('复制密钥', 'Copy Token')} />
                <CopyButton
                  value={`curl -X POST "${revealedToken.url}" -H "Authorization: Bearer ${revealedToken.token}" -H "Content-Type: application/json" -d '{"payload":{"event":"ping"}}'`}
                  label={t('复制 curl 示例', 'Copy curl Example')}
                />
              </div>
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label">
              {t('入口名称', 'Webhook Name')} <span className="ca-req">*</span>
            </label>
            <input
              type="text"
              className="ca-input"
              required
              placeholder={t('例如：GitHub CI 告警', 'e.g. GitHub CI Alerts')}
              value={hookName}
              onChange={e => setHookName(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">
              {t('目标 Bot', 'Target Bot')} <span className="ca-req">*</span>
            </label>
            <select
              className="ca-select"
              value={hookTargetKey}
              onChange={e => setHookTargetKey(e.target.value)}
            >
              {groupedBotOptions.length === 0 && <option value="">{t('暂无可用 Bot', 'No available Bots')}</option>}
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
            <label className="ca-field-label">
              {t('触发指令', 'Trigger Instruction')} <span className="ca-req">*</span>
            </label>
            <textarea
              rows={5}
              className="ca-textarea"
              required
              placeholder={t('收到外部 Webhook payload 后交给目标 Bot 执行的指令', 'Instruction sent to the target Bot when an external Webhook payload arrives')}
              value={hookInstruction}
              onChange={e => setHookInstruction(e.target.value)}
            />
          </div>

          <div className="ca-inline-between">
            <span className="ca-field-label">{t('启用此触发入口', 'Enable this webhook')}</span>
            <CaSwitch
              checked={hookEnabled}
              label={t('启用此触发入口', 'Enable this webhook')}
              onChange={setHookEnabled}
            />
          </div>

          {editingRoute && (
            <div className="ca-cred-box">
              <div className="ca-inline-between ca-wrap">
                <span className="ca-muted ca-mono ca-break-all">
                  {editingRoute.url}
                </span>
                <div className="ca-inline-row">
                  <CopyButton value={editingRoute.url} label={t('复制 URL', 'Copy URL')} />
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    disabled={hookBusy}
                    onClick={() => void handleRotateWebhookToken()}
                  >
                    {t('轮换密钥', 'Rotate Token')}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="ca-inline-between ca-pt-2">
            <div>
              {editingRoute && (
                <button
                  type="button"
                  className="ca-btn ca-btn-danger ca-btn-sm"
                  disabled={hookBusy}
                  onClick={() => void handleDeleteWebhook()}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span>{t('删除入口', 'Delete Webhook')}</span>
                </button>
              )}
            </div>
            <div className="ca-inline-row">
              <button type="button" className="ca-btn" onClick={() => setHookModalOpen(false)}>
                {t('关闭', 'Close')}
              </button>
              <button type="submit" className="ca-btn ca-btn-primary" disabled={hookBusy}>
                <LabelStack
                  active={
                    hookBusy
                      ? t('保存中…', 'Saving…')
                      : editingRoute
                        ? t('保存修改', 'Save Changes')
                        : t('创建入口', 'Create Webhook')
                  }
                  labels={[
                    editingRoute ? t('保存修改', 'Save Changes') : t('创建入口', 'Create Webhook'),
                    t('保存中…', 'Saving…'),
                  ]}
                />
              </button>
            </div>
          </div>
        </form>
      </CaModal>
    </div>
  );
}
