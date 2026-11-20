// 单 Bot 工具与插件配置页（默认 mode="tools" 过滤掉 skill，由 BotSkillsPage 专属承接）：
// 无密码墙、无内部版本/底层状态术语、无裸 JSON 框；开启开关时自动先触发全局启用。
import { useCallback, useId, useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, Plug } from 'lucide-react';
import type { JsonValue } from '../../../center-contract/index.js';
import type { CenterBotCapabilityEntry } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import {
  flatFields,
  useBotCapabilities,
  type Field,
} from '../../../desktop/web/src/useBotCapabilities';
import { openCenterManagement } from '../native';
import { GoogleCapabilitySection } from '../google/GoogleCapabilitySection';
import { isSharedGoogleCapabilityEntry } from '../google/googleCopy';
import type { GoogleSetupControlCall } from '../google/types';
import { ErrorNotice, errorText, useText } from '../ui';
import { centerAdminRequest, newRequestId, pollCenterOperation } from './centerAdminBroker';
import {
  Badge,
  Chips,
  EmptyState,
  LoadingState,
  Row,
  SearchField,
  Section,
  SettingsSheet,
  Switch,
  useSettingsSheetBack,
} from './primitives';
import './capabilities.css';

export interface CapabilitiesPageProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  botName?: string;
  mode?: 'tools' | 'all';
  hostPlatform?: string;
  isLocalAndroid?: boolean;
  callGoogleSetup?: GoogleSetupControlCall;
  onOpenBrowser?: () => void;
  onClose?: () => void;
  onOpenCenterAdmin?: (tab?: 'capabilities' | 'google') => void;
}

type KindFilter = 'all' | 'plugin' | 'mcp' | 'skill';

function kindLabel(kind: string, t: ReturnType<typeof useText>): string {
  switch (kind) {
    case 'plugin': return t('插件', 'Plugin');
    case 'mcp': return 'MCP';
    case 'skill': return t('技能', 'Skill');
    default: return kind;
  }
}

export function CapabilitiesPage({
  api,
  identity,
  deviceId,
  botId,
  botName,
  mode = 'tools',
  hostPlatform,
  isLocalAndroid,
  callGoogleSetup,
  onOpenBrowser,
  onClose,
  onOpenCenterAdmin,
}: CapabilitiesPageProps) {
  const t = useText();
  const fieldIdPrefix = useId();
  const state = useBotCapabilities({ api, identity, deviceId, botId, t });
  const { setEditor } = state;
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [enablingId, setEnablingId] = useState<string | null>(null);

  const openCenterProviders = () => {
    if (onOpenCenterAdmin) {
      onOpenCenterAdmin();
      return;
    }
    void openCenterManagement().catch(failure => state.setError(errorText(failure)));
  };

  const modeEntries = useMemo(() => {
    const withoutSharedGoogle = state.entries.filter(entry => !isSharedGoogleCapabilityEntry(entry));
    if (mode === 'all') return withoutSharedGoogle;
    return withoutSharedGoogle.filter(entry => entry.installation.kind !== 'skill');
  }, [state.entries, mode]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modeEntries.filter(entry => {
      if (kindFilter !== 'all' && entry.installation.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        entry.installation.displayName.toLowerCase().includes(q)
        || entry.installation.packageId.toLowerCase().includes(q)
      );
    });
  }, [modeEntries, kindFilter, query]);

  const editingEntry = useMemo(() => {
    if (!state.editor) return null;
    return modeEntries.find(e => e.installation.installationId === state.editor?.installationId) ?? null;
  }, [modeEntries, state.editor]);

  const handleBackFromEditor = useCallback(() => {
    setEditor(null);
  }, [setEditor]);

  const inOuterSheet = useSettingsSheetBack(!onClose && editingEntry ? handleBackFromEditor : null);
  const hasSheetBack = Boolean(onClose) || inOuterSheet;

  const handleToggle = async (entry: CenterBotCapabilityEntry, nextEnabled: boolean) => {
    const inst = entry.installation;
    const binding = entry.config;
    const currentRevision = binding?.revision ?? 0;
    const currentOverrides = binding?.overrides ?? {};

    if (!nextEnabled) {
      await state.save(entry, false, currentOverrides, currentRevision);
      return;
    }

    const globallyActive = inst.enabled && inst.activation?.status === 'enabled';
    if (globallyActive) {
      await state.save(entry, true, currentOverrides, currentRevision);
      return;
    }

    setEnablingId(inst.installationId);
    state.setError('');
    try {
      const op = await centerAdminRequest<{ operationId?: string }>(api, identity, {
        method: 'POST',
        path: `/api/installations/${encodeURIComponent(inst.installationId)}/enable`,
        body: { requestId: newRequestId() },
      });
      if (op?.operationId) {
        await pollCenterOperation(api, identity, op.operationId, { t });
      }
      await state.save(entry, true, currentOverrides, currentRevision);
    } catch (failure) {
      state.setError(errorText(failure));
    } finally {
      setEnablingId(null);
    }
  };

  const renderField = (entry: CenterBotCapabilityEntry, field: Field) => {
    const editor = state.editor;
    if (!editor) return null;
    const hasOverride = Object.prototype.hasOwnProperty.call(editor.overrides, field.key);
    const globalVal = entry.config?.globalConfig?.[field.key];
    const currentVal = hasOverride ? editor.overrides[field.key] : (globalVal ?? field.defaultValue);
    const label = field.title || field.key;
    const busy = state.busy === entry.installation.installationId;
    const fieldId = `${fieldIdPrefix}-${field.key.replace(/\s+/g, '_')}`;

    return (
      <div key={field.key} className="bs-cap-field">
        <div className="bs-cap-field-head">
          <div className="bs-cap-field-title">
            {field.kind === 'boolean' ? <span>{label}</span> : <label htmlFor={fieldId}>{label}</label>}
            {hasOverride ? <Badge tone="accent">{t('本 Bot 覆盖', 'Custom')}</Badge> : null}
          </div>
          {hasOverride ? (
            <button
              type="button"
              className="bs-btn is-ghost is-small"
              disabled={busy}
              onClick={() => state.setOverride(field.key, undefined)}
            >
              {t('恢复默认', 'Reset to default')}
            </button>
          ) : null}
        </div>
        {field.description ? <p className="bs-cap-field-desc">{field.description}</p> : null}

        {field.kind === 'boolean' ? (
          <Switch
            checked={Boolean(currentVal)}
            label={label}
            disabled={busy}
            onChange={next => state.setOverride(field.key, next)}
          />
        ) : field.kind === 'enum' && field.options ? (
          <select
            id={fieldId}
            className="bs-select"
            disabled={busy}
            value={typeof currentVal === 'string' ? currentVal : ''}
            onChange={e => state.setOverride(field.key, e.target.value)}
          >
            {field.options.map((opt, idx) => (
              <option key={opt} value={opt}>
                {field.optionNames?.[idx] ?? opt}
              </option>
            ))}
          </select>
        ) : field.kind === 'number' ? (
          <input
            id={fieldId}
            type="number"
            step="any"
            className="bs-input"
            disabled={busy}
            value={typeof currentVal === 'number' ? String(currentVal) : ''}
            onChange={e => {
              const raw = e.target.value.trim();
              if (!raw) {
                state.setOverride(field.key, undefined);
                return;
              }
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) state.setOverride(field.key, parsed as JsonValue);
            }}
          />
        ) : (
          <input
            id={fieldId}
            className="bs-input"
            disabled={busy}
            value={typeof currentVal === 'string' ? currentVal : ''}
            onChange={e => state.setOverride(field.key, e.target.value)}
          />
        )}
      </div>
    );
  };

  const renderEditor = (entry: CenterBotCapabilityEntry) => {
    const inst = entry.installation;
    const fields = flatFields(entry.config?.configSchema, entry.uiSchema);
    const busy = state.busy === inst.installationId;

    return (
      <div className="bs-cap-editor">
        <div className="bs-cap-editor-head">
          {!hasSheetBack ? (
            <button
              type="button"
              className="bs-btn is-ghost is-small"
              onClick={handleBackFromEditor}
            >
              ← {t('返回列表', 'Back')}
            </button>
          ) : null}
          <span className="bs-cap-editor-title">{inst.displayName}</span>
          <Badge>{kindLabel(inst.kind, t)}</Badge>
        </div>

        <div className="bs-card">
          <Row
            title={t('为本 Bot 启用', 'Enable for this Bot')}
            subtitle={state.editor?.enabled ? t('当前已启用', 'Enabled') : t('当前未启用', 'Disabled')}
            trailing={(
              <Switch
                checked={Boolean(state.editor?.enabled)}
                label={t('为本 Bot 启用', 'Enable for this Bot')}
                disabled={busy}
                onChange={next => {
                  state.setEditor(prev => prev ? { ...prev, enabled: next } : prev);
                }}
              />
            )}
          />
        </div>

        <Section title={t('参数设置', 'Parameters')} bare>
          {fields && fields.length > 0 ? (
            <div className="bs-cap-fields">
              {fields.map(field => renderField(entry, field))}
            </div>
          ) : (
            <div className="bs-auth-note">
              {t('该工具暂无需要单独调整的参数。', 'No per-Bot parameters required for this tool.')}
            </div>
          )}
        </Section>

        <div className="bs-cap-editor-actions">
          <button
            type="button"
            className="bs-btn is-primary"
            disabled={busy}
            onClick={() => void state.saveEditor(entry)}
          >
            {busy ? t('保存中...', 'Saving...') : t('保存设置', 'Save')}
          </button>
          <button
            type="button"
            className="bs-btn is-ghost"
            disabled={busy}
            onClick={() => state.setEditor(null)}
          >
            {t('取消', 'Cancel')}
          </button>
        </div>
      </div>
    );
  };

  const googleSection = (
    <GoogleCapabilitySection
      api={api}
      identity={identity}
      deviceId={deviceId}
      botId={botId}
      botName={botName}
      variant="mobile"
      hostPlatform={hostPlatform}
      isLocalAndroid={isLocalAndroid}
      callGoogleSetup={callGoogleSetup}
      onOpenBrowser={onOpenBrowser}
      onOpenCenterAdmin={onOpenCenterAdmin ? () => onOpenCenterAdmin('google') : openCenterProviders}
    />
  );

  const renderList = () => {
    if (!state.loaded && !state.error && !state.needLogin) {
      return (
        <>
          {googleSection}
          <LoadingState text={t('正在读取工具与插件...', 'Loading tools & plugins...')} />
        </>
      );
    }

    if (modeEntries.length === 0) {
      return (
        <>
          {googleSection}
          <EmptyState
            icon={<Plug aria-hidden="true" />}
            title={mode === 'tools' ? t('尚未安装可用工具或插件', 'No tools or plugins installed yet') : t('暂无可用能力', 'No capabilities installed yet')}
            hint={t('前往中心管理安装插件或 MCP 工具服务后，可在这里为当前 Bot 按需开启。', 'Install plugins or MCP tools in Center Management, then enable them here.')}
            action={(
              <button type="button" className="bs-btn is-primary is-small" onClick={openCenterProviders}>
                {t('去中心添加插件或 MCP 工具 →', 'Add plugins or MCP tools in Center →')}
              </button>
            )}
          />
        </>
      );
    }

    const filterOptions: Array<{ value: KindFilter; label: string }> = [
      { value: 'all', label: t('全部', 'All') },
      { value: 'plugin', label: t('插件', 'Plugins') },
      { value: 'mcp', label: 'MCP' },
      ...(mode === 'all' ? [{ value: 'skill' as const, label: t('技能', 'Skills') }] : []),
    ];

    return (
      <>
        {googleSection}
        <div className="bs-cap-toolbar">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t('搜索工具或插件名称', 'Search tools or plugins')}
          />
          <Chips<KindFilter>
            label={t('能力类型筛选', 'Capability filter')}
            value={kindFilter}
            onChange={setKindFilter}
            options={filterOptions}
          />
        </div>

        <div className="bs-card">
          {filteredEntries.map(entry => {
            const inst = entry.installation;
            const botEnabled = Boolean(entry.config?.enabled) && inst.enabled && inst.activation?.status === 'enabled';
            const working = state.busy === inst.installationId || enablingId === inst.installationId;
            const fields = flatFields(entry.config?.configSchema, entry.uiSchema);
            const hasParams = Boolean(fields && fields.length > 0);
            const capError = state.capabilityErrors.find(err => err.installationId === inst.installationId);

            return (
              <Row
                key={inst.installationId}
                title={inst.displayName}
                subtitle={
                  capError
                    ? t('当前配置或连接需要检查', 'Configuration needs attention')
                    : !inst.enabled || inst.activation?.status !== 'enabled'
                      ? t('开启后将自动启用该工具并授权给当前 Bot', 'Will auto-activate and enable for this Bot')
                      : botEnabled
                        ? t('已为本 Bot 启用', 'Enabled for this Bot')
                        : t('未启用', 'Disabled')
                }
                onClick={hasParams ? () => state.openEditor(entry) : undefined}
                trailing={(
                  <div className="bs-cap-row-meta" onClick={e => e.stopPropagation()}>
                    <Badge>{kindLabel(inst.kind, t)}</Badge>
                    <Switch
                      checked={botEnabled}
                      label={t(`为本 Bot 启用 ${inst.displayName}`, `Enable ${inst.displayName} for this Bot`)}
                      disabled={working}
                      onChange={next => void handleToggle(entry, next)}
                    />
                    {hasParams ? (
                      <button
                        type="button"
                        className="bs-btn is-ghost is-small"
                        aria-label={t(`配置 ${inst.displayName}`, `Configure ${inst.displayName}`)}
                        onClick={() => state.openEditor(entry)}
                      >
                        <ChevronRight aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                )}
              />
            );
          })}
        </div>

        <button type="button" className="bs-link" onClick={openCenterProviders}>
          {t('前往中心管理插件与 MCP 服务', 'Manage plugins & MCP in Center')}
          <ExternalLink aria-hidden="true" />
        </button>
      </>
    );
  };

  const body = (
    <>
      {state.needLogin ? (
        <div className="bs-auth-note">
          {t('当前中心授权已失效，请在设置中重新扫码绑定中心后重试。', 'Center authorization expired. Please re-bind with center QR code and retry.')}
        </div>
      ) : null}
      <ErrorNotice error={state.error} onDismiss={() => state.setError('')} />
      {state.notice ? <ErrorNotice error={state.notice} tone="success" compact onDismiss={() => state.setNotice('')} /> : null}
      {editingEntry ? renderEditor(editingEntry) : renderList()}
    </>
  );

  if (onClose) {
    return (
      <SettingsSheet
        title={mode === 'tools' ? t('工具与插件', 'Tools & Plugins') : t('能力与配置', 'Capabilities')}
        onClose={onClose}
        onBack={editingEntry ? handleBackFromEditor : undefined}
      >
        {body}
      </SettingsSheet>
    );
  }

  return <div className="bs-inline-panel">{body}</div>;
}
