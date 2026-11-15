import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Webhook,
} from 'lucide-react';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  CaDisclosure,
  CaModal,
  CaNotice,
  CaSegmented,
  CaSwitch,
  CopyButton,
  botKey,
  formatTime,
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

const PLATFORM_COMBINATIONS: Record<
  ClientReleasePlatform,
  Array<{ arch: ClientReleaseArch; format: ClientReleaseFormat; label: string }>
> = {
  windows: [{ arch: 'x86_64', format: 'nsis', label: 'Windows x86_64 (.exe NSIS)' }],
  linux: [{ arch: 'x86_64', format: 'deb', label: 'Linux x86_64 (.deb)' }],
  macos: [{ arch: 'aarch64', format: 'app', label: 'macOS Apple Silicon (.app.tar.gz)' }],
  android: [
    { arch: 'aarch64', format: 'apk', label: 'Android ARM64 (.apk)' },
    { arch: 'x86_64', format: 'apk', label: 'Android x86_64 (.apk 模拟器)' },
  ],
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function computeSha256Hex(file: File): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前运行环境不支持 WebCrypto SHA-256 计算');
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

function eventStatusMeta(status: WebhookEvent['status']): {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted';
} {
  switch (status) {
    case 'succeeded':
      return { label: '已完成', tone: 'ok' };
    case 'running':
    case 'queued':
    case 'dispatching':
    case 'pending':
      return { label: '执行中', tone: 'info' };
    case 'cancelled':
      return { label: '已取消', tone: 'muted' };
    case 'expired':
      return { label: '已过期', tone: 'warn' };
    default:
      return { label: '失败', tone: 'danger' };
  }
}

export function OpsTab({
  api,
  onOpenExternal,
}: {
  api: CenterApi;
  onOpenExternal?: () => void;
}): React.JSX.Element {
  const [segment, setSegment] = useState<'webhooks' | 'releases'>('webhooks');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Shared device/bot directory for Webhook target picker
  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [bots, setBots] = useState<CenterBotRef[]>([]);

  // Webhooks state
  const [routes, setRoutes] = useState<WebhookRoute[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [selectedRouteFilter, setSelectedRouteFilter] = useState<string>('all');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [togglingRouteId, setTogglingRouteId] = useState<string | null>(null);

  // Webhook drawer state
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<WebhookRoute | null>(null);
  const [hookName, setHookName] = useState('');
  const [hookTargetKey, setHookTargetKey] = useState('');
  const [hookInstruction, setHookInstruction] = useState('');
  const [hookEnabled, setHookEnabled] = useState(true);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookError, setHookError] = useState('');
  const [revealedToken, setRevealedToken] = useState<{ url: string; token: string } | null>(null);

  // Releases state
  const [releases, setReleases] = useState<ClientReleaseRecord[]>([]);
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
  const [relError, setRelError] = useState('');
  const [relNeedsBrowser, setRelNeedsBrowser] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  }, [api, loadWebhookEventsForRoutes]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadAll()
      .catch(err => {
        if (active) setError(errorMessage(err, '加载触发与版本数据失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAll]);

  // 5s silent auto-refresh for Webhook events while Webhook segment is active
  useEffect(() => {
    if (segment !== 'webhooks' || routes.length === 0) return;
    const timer = window.setInterval(() => {
      void loadWebhookEventsForRoutes(routes);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadWebhookEventsForRoutes, routes, segment]);

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
      setHookError('请填写触发入口名称');
      return;
    }
    if (!target) {
      setHookError('请选择目标设备与智能体');
      return;
    }
    if (!hookInstruction.trim()) {
      setHookError('请填写触发指令提示词');
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
        setNotice(`已更新触发入口「${updated.name}」`);
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
        setNotice(`已创建触发入口「${receipt.route.name}」，请保存下方一次性密钥`);
      }
    } catch (err) {
      setHookError(errorMessage(err, '保存触发入口失败'));
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
      setError(errorMessage(err, '切换触发入口状态失败'));
    } finally {
      setTogglingRouteId(null);
    }
  };

  const handleRotateWebhookToken = async () => {
    if (!editingRoute) return;
    if (!window.confirm('轮换后旧密钥将立即失效，确认继续吗？')) return;
    setHookBusy(true);
    setHookError('');
    try {
      const receipt = await api.rotateWebhookToken(editingRoute.id);
      setRevealedToken({ url: receipt.route.url, token: receipt.token });
      setEditingRoute(receipt.route);
      setNotice('已生成新触发密钥');
    } catch (err) {
      setHookError(errorMessage(err, '轮换密钥失败'));
    } finally {
      setHookBusy(false);
    }
  };

  const handleDeleteWebhook = async () => {
    if (!editingRoute) return;
    if (!window.confirm(`确定删除触发入口「${editingRoute.name}」吗？`)) return;
    setHookBusy(true);
    setHookError('');
    try {
      await api.deleteWebhook(editingRoute.id);
      const remaining = routes.filter(r => r.id !== editingRoute.id);
      setRoutes(remaining);
      setHookModalOpen(false);
      await loadWebhookEventsForRoutes(remaining);
      setNotice(`已删除触发入口「${editingRoute.name}」`);
    } catch (err) {
      setHookError(errorMessage(err, '删除触发入口失败'));
    } finally {
      setHookBusy(false);
    }
  };

  // Release File Drop / Selection
  const handleFilesSelected = async (fileList: FileList | File[]) => {
    setRelError('');
    setRelNeedsBrowser(false);
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
          setRelError(`元数据文件 ${f.name} JSON 解析失败`);
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
          const sha = await computeSha256Hex(f);
          setRelSha256(sha);
        } catch (err) {
          setRelError(errorMessage(err, '计算 SHA-256 失败'));
        }
      }
    }
  };

  const handleUploadRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!releaseFile) {
      setRelError('请先拖入或选择安装包文件');
      return;
    }
    if (!relVersion.trim()) {
      setRelError('请填写版本号（如 1.2.3）');
      return;
    }
    if (!relSha256.trim()) {
      setRelError('SHA-256 尚未计算完成，请稍候重试');
      return;
    }
    const parsedCode = relVersionCode.trim() ? Number(relVersionCode.trim()) : undefined;
    if (relFormat === 'apk' && (!parsedCode || !Number.isSafeInteger(parsedCode) || parsedCode < 1)) {
      setRelError('Android APK 需要填写正整数 versionCode（可在下方高级元数据展开填写）');
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
    setRelNeedsBrowser(false);
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
          ? `版本 v${finalRecord.version} 已上传并发布`
          : `版本 v${finalRecord.version} 已保存为草稿`,
      );
    } catch (err) {
      if (err instanceof CenterApiError && err.code === 'UNSUPPORTED_FORM_DATA') {
        setRelNeedsBrowser(true);
      }
      setRelError(errorMessage(err, '上传版本失败'));
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
      setNotice(updated.published ? `已发布 v${updated.version}` : `已撤回发布 v${updated.version}`);
    } catch (err) {
      setError(errorMessage(err, '切换发布状态失败'));
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

  if (loading) {
    return <div className="ca-empty">正在加载触发与版本管理…</div>;
  }

  return (
    <div>
      {error && <CaNotice tone="danger">{error}</CaNotice>}
      {notice && (
        <CaNotice
          tone="ok"
          action={
            <button type="button" className="ca-btn ca-btn-ghost ca-btn-sm" onClick={() => setNotice('')}>
              关闭
            </button>
          }
        >
          {notice}
        </CaNotice>
      )}

      <div className="ca-toolbar">
        <CaSegmented
          value={segment}
          options={[
            { value: 'webhooks', label: '外部触发 (Webhook)' },
            { value: 'releases', label: '客户端版本' },
          ]}
          onChange={setSegment}
        />

        {segment === 'webhooks' && (
          <button type="button" className="ca-btn ca-btn-primary ca-btn-sm" onClick={openCreateWebhook}>
            <Plus size={14} />
            <span>新建触发入口</span>
          </button>
        )}
      </div>

      {segment === 'webhooks' ? (
        <div className="ca-form-stack">
          {/* Webhook 触发入口列表 */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">触发入口 ({routes.length})</h3>
            </div>
            <div className="ca-list">
              {routes.length === 0 ? (
                <div className="ca-empty">暂无 Webhook 触发入口，点击右上角「+ 新建触发入口」添加</div>
              ) : (
                routes.map(route => (
                  <div
                    key={route.id}
                    className="ca-row is-clickable"
                    onClick={() => openEditWebhook(route)}
                  >
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <Webhook size={14} />
                        <span>{route.name}</span>
                        <span className={`ca-pill ${route.enabled ? 'ca-pill-ok' : 'ca-pill-muted'}`}>
                          {route.enabled ? '已启用' : '已停用'}
                        </span>
                      </div>
                      <div className="ca-row-sub">
                        目标：{botDisplayMap.get(botKey(route.deviceId, route.botId)) || `${route.deviceId} / ${route.botId}`}
                      </div>
                    </div>
                    <div className="ca-row-actions" onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openEditWebhook(route)}
                      >
                        编辑
                      </button>
                      <CaSwitch
                        checked={route.enabled}
                        disabled={togglingRouteId === route.id}
                        label={`启用触发入口 ${route.name}`}
                        onChange={next => void handleToggleWebhookRow(route, next)}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 最近触发记录（每 5 秒静默自动刷新） */}
          <section className="ca-section">
            <div className="ca-section-head" style={{ flexWrap: 'wrap' }}>
              <h3 className="ca-section-title">最近触发记录（自动刷新）</h3>
              <div className="ca-inline-row">
                <select
                  className="ca-select"
                  style={{ width: 170, paddingTop: 4, paddingBottom: 4 }}
                  value={selectedRouteFilter}
                  onChange={e => setSelectedRouteFilter(e.target.value)}
                >
                  <option value="all">全部入口</option>
                  {routes.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-icon"
                  aria-label="刷新记录"
                  onClick={() => void loadWebhookEventsForRoutes(routes)}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>

            <div className="ca-list">
              {filteredEvents.length === 0 ? (
                <div className="ca-empty">暂无外部触发事件记录</div>
              ) : (
                filteredEvents.slice(0, 40).map(ev => {
                  const meta = eventStatusMeta(ev.status);
                  const expanded = expandedEventId === ev.id;
                  const targetName =
                    botDisplayMap.get(botKey(ev.deviceId, ev.botId)) || `${ev.deviceId} / ${ev.botId}`;
                  return (
                    <div
                      key={ev.id}
                      className="ca-row is-clickable"
                      style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}
                      onClick={() => setExpandedEventId(expanded ? null : ev.id)}
                    >
                      <div className="ca-inline-between" style={{ width: '100%' }}>
                        <div className="ca-row-title" style={{ fontSize: 13 }}>
                          <span className="ca-muted ca-num">{formatTime(ev.receivedAt)}</span>
                          <span>{ev.routeName}</span>
                          <span className="ca-muted">→ {targetName}</span>
                        </div>
                        <span className={`ca-pill ca-pill-${meta.tone}`}>{meta.label}</span>
                      </div>

                      {expanded && (
                        <div className="ca-cred-box" style={{ width: '100%' }}>
                          <div className="ca-muted ca-mono">requestId: {ev.requestId}</div>
                          <div className="ca-muted ca-mono">idempotencyKey: {ev.idempotencyKey}</div>
                          {ev.admission && (
                            <div className="ca-muted">
                              准入状态：{ev.admission.phase}
                              {ev.admission.error ? `（${ev.admission.error.message}）` : ''}
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
          {/* 单一文件拖放上传区 + 自动推导元数据 */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">上传客户端安装包</h3>
            </div>
            <form className="ca-section-body ca-form-stack" onSubmit={e => void handleUploadRelease(e)}>
              {relError && (
                <CaNotice
                  tone="danger"
                  action={
                    relNeedsBrowser && onOpenExternal ? (
                      <button type="button" className="ca-btn ca-btn-sm" onClick={onOpenExternal}>
                        <ExternalLink size={13} />
                        <span>在浏览器打开上传</span>
                      </button>
                    ) : undefined
                  }
                >
                  {relError}
                </CaNotice>
              )}

              <div
                className={`ca-dropzone ${dragging ? 'is-dragging' : ''}`}
                onClick={() => fileInputRef.current?.click()}
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
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  accept=".exe,.deb,.tar.gz,.apk,.json,.sig"
                  onChange={e => {
                    if (e.target.files) void handleFilesSelected(e.target.files);
                  }}
                />
                <Upload size={20} style={{ marginBottom: 6, color: 'var(--ca-text-muted)' }} />
                <div style={{ fontWeight: 500 }}>
                  {releaseFile
                    ? `${releaseFile.name}（${formatBytes(relSize || releaseFile.size)}）`
                    : '点击或拖入安装包（可同时拖入 CI release.json / .sig）'}
                </div>
                <div className="ca-muted" style={{ marginTop: 4 }}>
                  自动计算 SHA-256 与文件大小，并从文件名或 release.json 自动识别平台与版本号
                </div>
              </div>

              <div className="ca-grid-2">
                <div className="ca-field">
                  <label className="ca-field-label">
                    版本号 <span className="ca-req">*</span>
                  </label>
                  <input
                    type="text"
                    className="ca-input ca-mono"
                    placeholder="如 1.4.0"
                    value={relVersion}
                    onChange={e => setRelVersion(e.target.value)}
                  />
                </div>
                <div className="ca-field">
                  <label className="ca-field-label">目标平台与格式</label>
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
                    {(Object.keys(PLATFORM_COMBINATIONS) as ClientReleasePlatform[]).flatMap(p =>
                      PLATFORM_COMBINATIONS[p].map(combo => (
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
                <label className="ca-field-label">更新说明（可选）</label>
                <input
                  type="text"
                  className="ca-input"
                  placeholder="简述此版本修复或新增内容"
                  value={relNotes}
                  onChange={e => setRelNotes(e.target.value)}
                />
              </div>

              <CaDisclosure title="高级元数据（versionCode / sourceCommit / 签名 / SHA-256）">
                <div className="ca-form-stack">
                  <div className="ca-grid-2">
                    <div className="ca-field">
                      <label className="ca-field-label">Android versionCode（APK 必填）</label>
                      <input
                        type="number"
                        className="ca-input ca-num"
                        placeholder="如 10400"
                        value={relVersionCode}
                        onChange={e => setRelVersionCode(e.target.value)}
                      />
                    </div>
                    <div className="ca-field">
                      <label className="ca-field-label">源码提交 (sourceCommit)</label>
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
                      <label className="ca-field-label">更新签名 (.sig 内容，可选)</label>
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

              <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                <label className="ca-check-label">
                  <input
                    type="checkbox"
                    checked={relAutoPublish}
                    onChange={e => setRelAutoPublish(e.target.checked)}
                  />
                  <span>上传后立即发布给客户端检查更新</span>
                </label>
                <button type="submit" className="ca-btn ca-btn-primary ca-btn-sm" disabled={relBusy || !releaseFile}>
                  {relBusy ? '上传中…' : relAutoPublish ? '上传并发布' : '保存为草稿'}
                </button>
              </div>
            </form>
          </section>

          {/* 已上传版本列表 */}
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">版本历史 ({releases.length})</h3>
            </div>
            <div className="ca-list">
              {releases.length === 0 ? (
                <div className="ca-empty">尚未上传任何客户端安装包</div>
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
                          {rec.published ? '已发布' : '草稿'}
                        </span>
                      </div>
                      <div className="ca-row-sub ca-num">
                        {rec.filename} · {formatBytes(rec.size)} · SHA256:{rec.sha256.slice(0, 12)}…
                        {rec.notes ? ` · ${rec.notes}` : ''}
                      </div>
                    </div>
                    <div className="ca-row-actions">
                      <a href={rec.downloadUrl} download={rec.filename} className="ca-btn ca-btn-sm">
                        <Download size={13} />
                        <span>下载</span>
                      </a>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        disabled={relBusy}
                        onClick={() => void handleTogglePublishRelease(rec)}
                      >
                        {rec.published ? '撤回' : '发布'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* Webhook 创建 / 编辑抽屉（支持修改目标 deviceId / botId） */}
      <CaModal
        open={hookModalOpen}
        onOpenChange={setHookModalOpen}
        title={editingRoute ? `编辑触发入口 · ${editingRoute.name}` : '新建触发入口'}
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveWebhook(e)}>
          {hookError && <CaNotice tone="danger">{hookError}</CaNotice>}

          {revealedToken && (
            <div className="ca-cred-box">
              <div className="ca-field-label">触发地址与一次性密钥（关闭后不可再次明文查看）</div>
              <div className="ca-muted ca-mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                POST {revealedToken.url}
              </div>
              <div className="ca-muted ca-mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                Bearer {revealedToken.token}
              </div>
              <div className="ca-inline-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <CopyButton value={revealedToken.token} label="复制密钥" />
                <CopyButton
                  value={`curl -X POST "${revealedToken.url}" -H "Authorization: Bearer ${revealedToken.token}" -H "Content-Type: application/json" -d '{"payload":{"event":"ping"}}'`}
                  label="复制 curl 示例"
                />
              </div>
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label">
              入口名称 <span className="ca-req">*</span>
            </label>
            <input
              type="text"
              className="ca-input"
              required
              placeholder="例如：GitHub CI 告警"
              value={hookName}
              onChange={e => setHookName(e.target.value)}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label">
              目标智能体 <span className="ca-req">*</span>
            </label>
            <select
              className="ca-select"
              value={hookTargetKey}
              onChange={e => setHookTargetKey(e.target.value)}
            >
              {groupedBotOptions.length === 0 && <option value="">暂无可用智能体</option>}
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
              触发指令 <span className="ca-req">*</span>
            </label>
            <textarea
              rows={5}
              className="ca-textarea"
              required
              placeholder="收到外部 Webhook payload 后交给目标智能体执行的指令"
              value={hookInstruction}
              onChange={e => setHookInstruction(e.target.value)}
            />
          </div>

          <div className="ca-inline-between">
            <span className="ca-field-label">启用此触发入口</span>
            <CaSwitch checked={hookEnabled} onChange={setHookEnabled} />
          </div>

          {editingRoute && (
            <div className="ca-cred-box">
              <div className="ca-inline-between" style={{ flexWrap: 'wrap' }}>
                <span className="ca-muted ca-mono" style={{ wordBreak: 'break-all' }}>
                  {editingRoute.url}
                </span>
                <div className="ca-inline-row">
                  <CopyButton value={editingRoute.url} label="复制 URL" />
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    disabled={hookBusy}
                    onClick={() => void handleRotateWebhookToken()}
                  >
                    轮换密钥
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="ca-inline-between" style={{ paddingTop: 6 }}>
            <div>
              {editingRoute && (
                <button
                  type="button"
                  className="ca-btn ca-btn-danger ca-btn-sm"
                  disabled={hookBusy}
                  onClick={() => void handleDeleteWebhook()}
                >
                  <Trash2 size={13} />
                  <span>删除入口</span>
                </button>
              )}
            </div>
            <div className="ca-inline-row">
              <button type="button" className="ca-btn" onClick={() => setHookModalOpen(false)}>
                关闭
              </button>
              <button type="submit" className="ca-btn ca-btn-primary" disabled={hookBusy}>
                {hookBusy ? '保存中…' : editingRoute ? '保存修改' : '创建入口'}
              </button>
            </div>
          </div>
        </form>
      </CaModal>
    </div>
  );
}
