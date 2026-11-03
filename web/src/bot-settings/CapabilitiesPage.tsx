// 手机端「插件 / 技能 / MCP」页：列表（类型筛选 + 启用开关）→ 同一 sheet 内二级详情（逐项自定义 / JSON 覆写 + 保存栏）。
// 数据、轮询、登录、CAS 冲突处理全部复用桌面 useBotCapabilities，不另建业务状态。
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Layers, Plug, Puzzle, Server, Sparkles } from 'lucide-react';
import type {
  CenterBotCapabilityEntry,
  CenterCapabilityActivationStatus,
  CenterRuntimeApplyStatus,
  JsonValue,
} from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import {
  flatFields,
  globallyReady,
  initialOverride,
  timeText,
  useBotCapabilities,
  type Editor,
} from '../../../desktop/web/src/useBotCapabilities';
import { ErrorNotice, useText } from '../ui';
import {
  Chips,
  Disclosure,
  EmptyState,
  KeyValueList,
  LoadingState,
  LoginCard,
  Row,
  SaveBar,
  SearchField,
  Section,
  Segmented,
  SettingsSheet,
  StatusLine,
  Switch,
  type BadgeTone,
} from './primitives';
import './capabilities.css';

type Props = { api: DesktopPanelApi; identity: DesktopIdentity; deviceId: string; botId: string; onClose(): void };

const KIND_ORDER = ['plugin', 'skill', 'mcp'];
const SEARCH_THRESHOLD = 8;

/** 键顺序无关的 JSON 文本，用于判断草稿与远端是否一致。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function editorDirty(editor: Editor, entry: CenterBotCapabilityEntry): boolean {
  if (editor.enabled !== entry.config.enabled) return true;
  if (editor.text !== null) return editor.text !== JSON.stringify(entry.config.overrides, null, 2);
  return canonical(editor.overrides) !== canonical(entry.config.overrides);
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'plugin') return <Puzzle />;
  if (kind === 'skill') return <Sparkles />;
  if (kind === 'mcp') return <Server />;
  return <Layers />;
}

export function CapabilitiesPage({ api, identity, deviceId, botId, onClose }: Props) {
  const t = useText();
  const {
    entries,
    runtime,
    loaded,
    needLogin,
    editor,
    setEditor,
    busy,
    error,
    setError,
    notice,
    setNotice,
    login,
    save,
    openEditor,
    setOverride,
    saveEditor,
    adoptRemote,
    receipt,
    capabilityErrors,
  } = useBotCapabilities({ api, identity, deviceId, botId, t });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const baseId = useId();

  const detailEntry = detailId === null ? undefined : entries.find(item => item.installation.installationId === detailId);

  // 保存成功后 hook 会清空草稿：回到列表，让保存提示显示在列表上；条目消失时同样回到列表。
  useEffect(() => {
    if (detailId === null) return;
    if (editor === null || (loaded && detailEntry === undefined)) setDetailId(null);
  }, [detailId, editor, loaded, detailEntry]);

  const statusText = (status: CenterRuntimeApplyStatus): string =>
    status === 'pending' ? t('等待下发', 'Pending')
      : status === 'applying' ? t('应用中', 'Applying')
        : status === 'waiting-idle' ? t('等待空闲', 'Waiting for idle')
          : status === 'applied' ? t('已生效', 'Applied')
            : t('应用失败', 'Failed');
  const kindText = (kind: string): string =>
    kind === 'plugin' ? t('插件', 'Plugin') : kind === 'mcp' ? 'MCP' : kind === 'skill' ? t('技能', 'Skill') : kind;
  const targetText = (target: string): string => (target === 'center' ? t('中心', 'Center') : 'Host');
  const globalStateText = (entry: CenterBotCapabilityEntry): string => {
    if (!entry.installation.enabled) return t('全局未启用', 'Not enabled globally');
    const status: CenterCapabilityActivationStatus | undefined = entry.installation.activation?.status;
    if (status === 'enabled') return t('全局已启用', 'Enabled globally');
    if (status === 'enabling') return t('全局启用中', 'Enabling globally');
    if (status === 'failed') return t('全局启用失败', 'Global activation failed');
    if (status === 'disabled') return t('全局未生效', 'Inactive globally');
    return t('全局状态未确认', 'Global state unknown');
  };
  const json = (value: unknown): string => (value === undefined ? t('默认', 'default') : JSON.stringify(value));
  const notReadyMessage = t('该能力全局未启用（或启用未完成），不能为本 Bot 开启；请先在中心启用并等待生效。', 'The capability is not enabled globally yet; enable it in the center first.');

  const close = (): void => {
    setEditor(null);
    setDetailId(null);
  };
  const openDetail = (entry: CenterBotCapabilityEntry): void => {
    openEditor(entry);
    setDetailId(entry.installation.installationId);
  };

  const messages = (
    <>
      {error ? <ErrorNotice error={error} onDismiss={() => setError('')} /> : null}
      {notice ? <ErrorNotice error={notice} tone="success" compact onDismiss={() => setNotice('')} /> : null}
    </>
  );

  /* ---------------------------------------------------------------- */
  /* 详情                                                              */
  /* ---------------------------------------------------------------- */
  if (detailId !== null && detailEntry && editor && editor.installationId === detailId) {
    const entry = detailEntry;
    const { installation, config } = entry;
    const fields = flatFields(config.configSchema, entry.uiSchema);
    const ready = globallyReady(entry);
    const dirty = editorDirty(editor, entry);
    const disabled = busy !== '';
    return (
      <SettingsSheet
        title={installation.displayName}
        subtitle={`${kindText(installation.kind)} · ${targetText(installation.target)}`}
        onBack={close}
        onClose={onClose}
        footer={<SaveBar dirty={dirty} busy={disabled} onSave={() => void saveEditor(entry)} onReset={() => adoptRemote(entry)} />}
      >
        {error || notice ? <div className="bs-cap-messages">{messages}</div> : null}

        <section className="bs-section">
          <div className="bs-card">
            <Row
              title={t('为该 Bot 启用', 'Enable for this bot')}
              trailing={(
                <Switch
                  checked={editor.enabled}
                  disabled={disabled || (!editor.enabled && !config.enabled && !ready)}
                  label={t('为该 Bot 启用', 'Enable for this bot') + ' ' + installation.displayName}
                  onChange={next => setEditor(current => (current ? { ...current, enabled: next } : current))}
                />
              )}
            />
          </div>
          <div className="bs-cap-hints">
            <p className="bs-cap-hint">
              <span className={`bs-cap-dot${ready ? ' is-ready' : installation.activation?.error ? ' is-danger' : ''}`} aria-hidden="true" />
              {`${globalStateText(entry)} · ${t('更新于', 'Updated')} ${timeText(installation.activation?.updatedAt ?? null)}`}
            </p>
            {installation.activation?.error
              ? <ErrorNotice compact error={`${installation.activation.error.code}: ${installation.activation.error.message}`} />
              : null}
            {!ready && !config.enabled
              ? <p className="bs-cap-hint">{t('全局未生效：本 Bot 无法开启该能力，请先在中心启用并等待生效。', 'Not active globally: this bot cannot switch it on until the center enables it.')}</p>
              : null}
            {config.enabled && !ready
              ? <p className="bs-cap-hint">{t('当前不生效：本 Bot 偏好已保留，全局生效后会重新加载。', 'Currently inactive: the bot preference is kept and loads again once the global capability is active.')}</p>
              : null}
          </div>
        </section>

        {fields === null ? (
          <Section title={t('配置', 'Configuration')} bare hint={t('覆盖配置 JSON（整段覆写，数组整体替换）', 'Overrides JSON (whole-value; arrays replace)')}>
            <textarea
              className="bs-textarea bs-cap-json"
              rows={8}
              spellCheck={false}
              aria-label={t('覆盖配置 JSON（整段覆写，数组整体替换）', 'Overrides JSON (whole-value; arrays replace)')}
              value={editor.text ?? ''}
              disabled={disabled}
              onChange={event => {
                const text = event.target.value;
                setEditor(current => (current ? { ...current, text } : current));
              }}
            />
          </Section>
        ) : fields.length === 0 ? (
          <Section title={t('配置', 'Configuration')} bare>
            <div className="bs-cap-empty-small">
              <EmptyState title={t('该能力没有可配置项', 'No configurable fields')} />
            </div>
          </Section>
        ) : (
          <Section title={t('配置', 'Configuration')}>
            {fields.map((field, index) => {
              const overridden = field.key in editor.overrides;
              const value = editor.overrides[field.key];
              const label = field.title ? field.title + '（' + field.key + '）' : field.key;
              const effectiveGlobal = config.globalConfig[field.key] ?? (field.hasDefault ? field.defaultValue : undefined);
              const controlId = `${baseId}-field-${index}`;
              const describedBy = field.description ? controlId + '-desc' : undefined;
              let control: ReactNode = null;
              if (overridden) {
                if (field.kind === 'boolean') {
                  control = (
                    <Segmented
                      value={value === true ? 'true' : 'false'}
                      label={label}
                      disabled={disabled}
                      options={[
                        { value: 'true', label: t('开启', 'On') },
                        { value: 'false', label: t('关闭', 'Off') },
                      ]}
                      onChange={next => setOverride(field.key, next === 'true')}
                    />
                  );
                } else if (field.kind === 'enum') {
                  control = (
                    <select
                      id={controlId}
                      className="bs-select"
                      value={typeof value === 'string' ? value : ''}
                      disabled={disabled}
                      aria-label={label}
                      aria-describedby={describedBy}
                      onChange={event => setOverride(field.key, event.target.value)}
                    >
                      <option value="">—</option>
                      {(field.options ?? []).map((option, optionIndex) => (
                        <option key={option} value={option}>
                          {field.optionNames ? field.optionNames[optionIndex] : option}
                        </option>
                      ))}
                    </select>
                  );
                } else {
                  control = (
                    <input
                      id={controlId}
                      className="bs-input"
                      type={field.kind === 'number' ? 'number' : 'text'}
                      inputMode={field.kind === 'number' ? 'decimal' : undefined}
                      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                      disabled={disabled}
                      aria-label={label}
                      aria-describedby={describedBy}
                      onChange={event => setOverride(field.key, field.kind === 'number'
                        ? (event.target.value === '' ? undefined : Number(event.target.value))
                        : event.target.value)}
                    />
                  );
                }
              }
              return (
                <div className={`bs-cap-field${overridden ? ' is-custom' : ''}`} key={field.key}>
                  <div className="bs-cap-field-head">
                    <div className="bs-cap-field-titles">
                      <span className="bs-cap-field-title">{field.title ?? field.key}</span>
                      {field.title ? <span className="bs-cap-field-key">{field.key}</span> : null}
                    </div>
                    <span className="bs-cap-field-switch">
                      <span className="bs-cap-field-switch-text" aria-hidden="true">{t('自定义', 'Custom')}</span>
                      <Switch
                        checked={overridden}
                        disabled={disabled}
                        label={`${t('自定义', 'Custom')} ${label}`}
                        onChange={next => setOverride(field.key, next ? initialOverride(field, config.globalConfig[field.key] as JsonValue | undefined) : undefined)}
                      />
                    </span>
                  </div>
                  {field.description ? <p className="bs-cap-field-desc" id={controlId + '-desc'}>{field.description}</p> : null}
                  {overridden
                    ? <div className="bs-cap-field-control">{control}</div>
                    : <p className="bs-cap-field-inherit">{`${t('继承：', 'Inherited: ')}${json(effectiveGlobal)}`}</p>}
                </div>
              );
            })}
          </Section>
        )}

        <div className="bs-cap-detail-foot">
          <button type="button" className="bs-link" disabled={disabled} onClick={() => adoptRemote(entry)}>
            {t('放弃草稿，载入远端配置', 'Discard draft and load remote')}
          </button>
          <span className="bs-cap-rev">{`rev ${editor.revision}`}</span>
        </div>
      </SettingsSheet>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 列表                                                              */
  /* ---------------------------------------------------------------- */
  const kinds = [...new Set(entries.map(item => item.installation.kind as string))]
    .sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a);
      const ib = KIND_ORDER.indexOf(b);
      return (ia < 0 ? KIND_ORDER.length : ia) - (ib < 0 ? KIND_ORDER.length : ib) || a.localeCompare(b);
    });
  const activeFilter = kinds.length > 1 && kinds.includes(filter) ? filter : 'all';
  const needle = entries.length > SEARCH_THRESHOLD ? query.trim().toLowerCase() : '';
  const visible = entries.filter(item =>
    (activeFilter === 'all' || item.installation.kind === activeFilter)
    && (!needle || item.installation.displayName.toLowerCase().includes(needle)));
  const enabledEntries = visible.filter(item => item.config.enabled);
  const availableEntries = visible.filter(item => !item.config.enabled);

  const runtimeTone: BadgeTone = runtime
    ? (runtime.online ? (runtime.status === 'applied' ? 'success' : runtime.status === 'failed' ? 'danger' : 'accent') : 'neutral')
    : 'neutral';
  const nameOf = (installationId: string): string =>
    entries.find(item => item.installation.installationId === installationId)?.installation.displayName ?? installationId;

  const subtitleFor = (entry: CenterBotCapabilityEntry): ReactNode => {
    const { installation, config } = entry;
    const ready = globallyReady(entry);
    if (installation.activation?.error) return <span className="bs-cap-sub is-danger">{t('全局启用失败', 'Global activation failed')}</span>;
    if (config.enabled && !ready) return <span className="bs-cap-sub is-warning">{t('全局未生效，暂不加载', 'Inactive globally; not loaded')}</span>;
    if (!config.enabled && !ready) return globalStateText(entry);
    const overrideCount = Object.keys(config.overrides).length;
    if (overrideCount > 0) return `${kindText(installation.kind)} · ${t(`已自定义 ${overrideCount} 项`, `${overrideCount} customized`)}`;
    return `${kindText(installation.kind)} · ${targetText(installation.target)}`;
  };

  const renderRow = (entry: CenterBotCapabilityEntry) => {
    const { installation, config } = entry;
    const ready = globallyReady(entry);
    return (
      <Row
        key={installation.installationId}
        icon={<KindIcon kind={installation.kind} />}
        title={installation.displayName}
        subtitle={subtitleFor(entry)}
        muted={!config.enabled && !ready}
        chevron
        onClick={() => openDetail(entry)}
        trailing={(
          <Switch
            checked={config.enabled}
            disabled={busy !== '' || (!config.enabled && !ready)}
            label={t('为该 Bot 启用', 'Enable for this bot') + ' ' + installation.displayName}
            onChange={next => {
              // 不得用 Bot 开关打开全局；全局未生效时拒绝开启，但允许关闭。
              if (next && !globallyReady(entry)) {
                setError(notReadyMessage);
                return;
              }
              void save(entry, next, config.overrides, config.revision);
            }}
          />
        )}
      />
    );
  };

  return (
    <SettingsSheet title={t('插件 / 技能 / MCP', 'Plugins / Skills / MCP')} onClose={onClose}>
      {runtime ? (
        <div className="bs-cap-runtime">
          <StatusLine tone={runtimeTone}>
            {runtime.online
              ? `${t('设备在线', 'Device online')} · ${statusText(runtime.status)}`
              : t('设备离线', 'Device offline')}
          </StatusLine>
          {!runtime.online
            ? <p className="bs-cap-hint">{t('离线时仍可修改，设备上线后自动同步。', 'Changes still save while offline and sync when the device reconnects.')}</p>
            : null}
          {runtime.error ? <ErrorNotice compact error={`${runtime.error.code}: ${runtime.error.message}`} /> : null}
          {capabilityErrors.map(item => (
            <ErrorNotice compact key={item.installationId} error={`${nameOf(item.installationId)}: ${item.error.code}`} />
          ))}
          <Disclosure title={t('诊断详情', 'Diagnostics')}>
            <KeyValueList
              items={[
                { key: 'status', label: t('应用状态', 'Apply status'), value: statusText(runtime.status) },
                { key: 'desired', label: t('已下发版本', 'Desired revision'), value: runtime.desiredRevision ?? '—' },
                { key: 'applied', label: t('已应用版本', 'Applied revision'), value: runtime.appliedRevision ?? '—' },
                { key: 'updated', label: t('更新时间', 'Updated'), value: timeText(runtime.updatedAt) },
                { key: 'appliedAt', label: t('生效时间', 'Applied at'), value: timeText(runtime.appliedAt) },
                ...(receipt
                  ? [
                    { key: 'botStatus', label: t('该 Bot 状态', 'This bot'), value: statusText(receipt.status) },
                    { key: 'botApplied', label: t('该 Bot 已应用版本', 'This bot applied revision'), value: receipt.appliedRevision ?? '—' },
                  ]
                  : []),
              ]}
            />
          </Disclosure>
        </div>
      ) : null}

      {!loaded ? <LoadingState text={t('正在读取…', 'Loading…')} /> : null}

      {needLogin ? (
        <LoginCard
          busy={busy !== ''}
          onSubmit={password => void login(password)}
          message={t('管理该 Bot 的能力需要管理员身份', 'Managing this bot’s capabilities requires administrator sign-in')}
        />
      ) : null}

      {error || notice ? <div className="bs-cap-messages">{messages}</div> : null}

      {loaded && !needLogin && entries.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title={t('暂无可用能力', 'No capabilities available')}
          hint={t('在中心安装并启用插件、技能或 MCP 后会显示在这里。', 'Install and enable plugins, skills or MCP servers in the center to see them here.')}
        />
      ) : null}

      {entries.length > 0 && (kinds.length > 1 || entries.length > SEARCH_THRESHOLD) ? (
        <div className="bs-cap-filters">
          {kinds.length > 1 ? (
            <Chips
              value={activeFilter}
              label={t('按类型筛选', 'Filter by type')}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('全部', 'All'), hint: String(entries.length) },
                ...kinds.map(kind => ({
                  value: kind,
                  label: kindText(kind),
                  hint: String(entries.filter(item => item.installation.kind === kind).length),
                })),
              ]}
            />
          ) : null}
          {entries.length > SEARCH_THRESHOLD ? <SearchField value={query} onChange={setQuery} placeholder={t('搜索', 'Search')} /> : null}
        </div>
      ) : null}

      {enabledEntries.length > 0 ? <Section title={t('已启用', 'Enabled')}>{enabledEntries.map(renderRow)}</Section> : null}
      {availableEntries.length > 0 ? <Section title={t('未启用', 'Available')}>{availableEntries.map(renderRow)}</Section> : null}
      {entries.length > 0 && visible.length === 0 ? <EmptyState title={t('没有匹配的能力', 'No matching capabilities')} /> : null}
    </SettingsSheet>
  );
}
