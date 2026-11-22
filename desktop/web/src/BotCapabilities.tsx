// Bot 工具扩展面板（MCP & 插件，已过滤 skill）。
// 免密直连中心，不再弹出管理员密码框或暴露 revision / Center / Host 等底层黑话。
import { ChevronDown, Plug, Save } from 'lucide-react';
import type {
  CenterBotCapabilityEntry,
  CenterCapabilityActivationStatus,
  CenterRuntimeApplyStatus,
} from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { ActionBar } from '../../../web/src/components/ui';
import { GoogleCapabilitySection } from '../../../web/src/google/GoogleCapabilitySection';
import { isSharedGoogleCapabilityEntry } from '../../../web/src/google/googleCopy';
import type { GoogleSetupControlCall } from '../../../web/src/google/types';
import { flatFields, globallyReady, initialOverride, isObject, useBotCapabilities } from './useBotCapabilities';
import './BotCapabilities.css';

type Props = {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  botName?: string;
  hostPlatform?: string;
  callGoogleSetup?: GoogleSetupControlCall;
  onOpenBrowser?: () => void;
  t?: (zh: string, en: string) => string;
  /** 外层已有同名标题时可隐藏面板自带标题。 */
  showTitle?: boolean;
  onAuthenticated?: () => void;
  /** 从未全局启用或全局设置跳转至设置 -> 中心管理 -> 扩展插件。 */
  onOpenCenterAdmin?: () => void;
  onOpenCenterGoogle?: () => void;
};

const identityText = (zh: string): string => zh;

export function BotCapabilities({
  api,
  identity,
  deviceId,
  botId,
  botName,
  hostPlatform,
  callGoogleSetup,
  onOpenBrowser,
  t = identityText,
  showTitle = true,
  onAuthenticated,
  onOpenCenterAdmin,
  onOpenCenterGoogle,
}: Props) {
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
    save,
    openEditor,
    setOverride,
    saveEditor,
    adoptRemote,
    receipt,
    capabilityErrors,
  } = useBotCapabilities({ api, identity, deviceId, botId, t, onAuthenticated, waitForFreshRuntime: true });

  // 技能已拆分至独立「技能」页签；中心共享 Google Workspace 由上方独立共享卡片呈现，不设逐 Bot 开关。
  const toolEntries = entries.filter(
    (entry) => entry.installation.kind !== 'skill' && !isSharedGoogleCapabilityEntry(entry),
  );

  const statusText = (status: CenterRuntimeApplyStatus): string =>
    status === 'applied' ? t('已生效', 'Applied')
      : status === 'failed' ? t('应用失败', 'Failed')
        : t('已保存，等待同步', 'Saved, syncing');

  const kindText = (kind: string): string =>
    kind === 'plugin' ? t('插件', 'Plugin') : kind === 'mcp' ? 'MCP' : kind;

  const globalStateText = (entry: CenterBotCapabilityEntry): string => {
    if (!entry.installation.enabled) return t('中心全局未开启', 'Disabled globally in Center');
    const status: CenterCapabilityActivationStatus | undefined = entry.installation.activation?.status;
    if (status === 'enabled') return t('全局已启用', 'Enabled globally');
    if (status === 'enabling') return t('全局正在启用中…', 'Enabling globally…');
    if (status === 'failed') return t('全局启用失败', 'Global activation failed');
    return t('中心全局未生效', 'Not active globally');
  };

  const jsonPreview = (value: unknown): string => (value === undefined ? t('默认', 'default') : JSON.stringify(value));

  return (
    <section
      className="bot-cap"
      aria-label={t('工具扩展（MCP & 插件）', 'Tool extensions (MCP & Plugins)')}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
    >
      {showTitle ? (
        <h4 className="bot-cap-title" style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>
          {t('工具扩展 (MCP & 插件)', 'Tool Extensions (MCP & Plugins)')}
        </h4>
      ) : null}

      <GoogleCapabilitySection
        api={api}
        identity={identity}
        deviceId={deviceId}
        botId={botId}
        botName={botName}
        variant="desktop"
        hostPlatform={hostPlatform}
        callGoogleSetup={callGoogleSetup}
        onOpenBrowser={onOpenBrowser}
        onOpenCenterAdmin={onOpenCenterGoogle}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          paddingTop: 'var(--space-3)',
          borderTop: '1px solid var(--line-subtle)',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '4px 10px',
            minWidth: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
            {t('MCP 与插件', 'MCP & Plugins')}
          </span>
          {runtime ? (
            <span
              className="metadata"
              role="status"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}
            >
              <span className={`bot-cap-dot ${runtime.online ? 'is-online' : 'is-offline'}`} aria-hidden="true" />
              {runtime.online
                ? t('设备在线 · 修改即时同步', 'Device online · syncs immediately')
                : t('设备离线 · 上线后自动同步', 'Device offline · syncs when online')}
            </span>
          ) : null}
        </div>

        {!loaded ? (
          <p className="bot-cap-loading" role="status">{t('正在读取工具扩展…', 'Loading tool extensions…')}</p>
        ) : null}

        {needLogin ? (
          <div className="bot-cap-empty" role="status" style={{ display: 'grid', gap: 8, justifyItems: 'start', textAlign: 'left' }}>
            <p className="metadata" style={{ margin: 0 }}>
              {t('当前中心会话需要授权认证，请检查「设置 → 中心连接」状态或前往中心管理完成登录。', 'Center authorization required. Check Center Connection or sign in via Center Admin.')}
            </p>
            {onOpenCenterAdmin && (
              <button type="button" className="bot-cap-secondary" onClick={onOpenCenterAdmin}>
                {t('前往中心管理', 'Open Center Admin')}
              </button>
            )}
          </div>
        ) : null}

        {error ? <p className="bot-cap-error" role="alert">{error}</p> : null}
        {notice ? <p className="bot-cap-notice" role="status">{notice}</p> : null}

        {loaded && !needLogin && toolEntries.length === 0 ? (
          <div className="metadata bot-cap-empty" style={{ display: 'grid', gap: 8, justifyItems: 'start', textAlign: 'left' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plug size={15} aria-hidden="true" />
              {t('中心尚未安装可用的 MCP 或插件扩展。', 'No MCP or plugin extensions installed in the center yet.')}
            </span>
            {onOpenCenterAdmin && (
              <button type="button" className="bot-cap-secondary" onClick={onOpenCenterAdmin}>
                {t('去中心管理安装扩展 →', 'Install extensions in Center Admin →')}
              </button>
            )}
          </div>
        ) : null}

        {toolEntries.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line-subtle)', minWidth: 0 }}>
            {toolEntries.map((entry) => {
              const { installation, config } = entry;
              const draft = editor?.installationId === installation.installationId ? editor : null;
              const fields = flatFields(config.configSchema, entry.uiSchema);
              const hasConfigurableFields = Boolean(fields && fields.length > 0);
              const itemBusy = busy === installation.installationId;
              const schema = config.configSchema;
              const description = isObject(schema) && typeof schema.description === 'string' ? schema.description.trim() : '';
              const applyError = capabilityErrors.find((item) => item.installationId === installation.installationId)?.error;
              const applyStatus = receipt?.status ?? runtime?.status;
              const globallyAvailable = globallyReady(entry);
              const availability = !globallyAvailable
                ? globalStateText(entry)
                : !config.enabled
                  ? t('此智能体未启用', 'Off for this agent')
                  : applyError
                    ? t(`应用失败：${applyError.message || applyError.code}`, `Apply failed: ${applyError.message || applyError.code}`)
                    : applyStatus ? statusText(applyStatus) : t('已保存，等待同步', 'Saved, awaiting sync');
              const dotClass = !globallyAvailable
                ? 'is-warn'
                : !config.enabled
                  ? 'is-idle'
                  : applyError
                    ? 'is-error'
                    : applyStatus === 'applied'
                      ? 'is-ok'
                      : 'is-accent';
              const statusColor = applyError
                ? 'var(--danger)'
                : !globallyAvailable
                  ? 'var(--warn)'
                  : 'var(--muted)';
              const hasRemoteRevisionChange = Boolean(draft && draft.revision !== config.revision);

              return (
                <section
                  key={installation.installationId}
                  className={`bot-cap-item${config.enabled ? ' is-enabled' : ''}`}
                  role="group"
                  aria-label={installation.displayName}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '12px 0',
                    border: 0,
                    borderBottom: '1px solid var(--line-subtle)',
                    borderRadius: 0,
                    background: 'transparent',
                    minWidth: 0,
                  }}
                >
                  <div className="bot-cap-item-head" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
                    <div
                      className="bot-cap-item-title"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}
                    >
                      <span className={`ui-status-dot ${dotClass}`} aria-hidden="true" />
                      <strong>{installation.displayName}</strong>
                      <span className="metadata">· {kindText(installation.kind)}</span>
                    </div>
                    <label className="bot-cap-toggle">
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        disabled={busy !== '' || (!config.enabled && !globallyAvailable)}
                        onChange={(event) => {
                          const next = event.target.checked;
                          if (next && !globallyAvailable) {
                            setError(t('该扩展尚未在中心全局启用，请先前往中心管理开启后再为本智能体启用。', 'This extension is not enabled globally yet. Enable it in Center Admin first.'));
                            return;
                          }
                          void save(entry, next, config.overrides, config.revision);
                        }}
                      />
                      <span className="bot-cap-toggle-text">{t('为此智能体启用', 'Enable for this agent')}</span>
                    </label>
                  </div>

                  {description ? <p className="metadata">{description}</p> : null}

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <p
                      className="bot-cap-item-status"
                      style={{ margin: 0, fontWeight: 500, fontSize: '0.8rem', color: statusColor }}
                    >
                      {availability}
                    </p>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {!globallyAvailable && onOpenCenterAdmin ? (
                        <button
                          type="button"
                          className="quiet-button"
                          style={{ minHeight: 28, padding: '2px 8px', fontSize: '0.8rem' }}
                          onClick={onOpenCenterAdmin}
                        >
                          {t('去中心管理启用 →', 'Enable in Center Admin →')}
                        </button>
                      ) : null}
                      {hasConfigurableFields ? (
                        <button
                          className="bot-cap-secondary bot-cap-configure"
                          style={{ marginTop: 0, minHeight: 28, padding: '0 10px', fontSize: '0.78rem' }}
                          type="button"
                          aria-expanded={draft !== null}
                          disabled={busy !== ''}
                          onClick={() => (draft !== null ? setEditor(null) : openEditor(entry))}
                        >
                          {draft !== null ? t('收起参数', 'Hide parameters') : t('配置参数', 'Configure parameters')}
                          <ChevronDown
                            size={13}
                            aria-hidden="true"
                            style={{
                              transition: 'transform var(--dur-fast) var(--ease-out)',
                              transform: draft !== null ? 'rotate(180deg)' : undefined,
                            }}
                          />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {hasConfigurableFields && fields && draft !== null ? (
                    <div
                      className="bot-cap-editor"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-3)',
                        marginTop: 4,
                        paddingTop: 'var(--space-3)',
                        borderTop: '1px solid var(--line-subtle)',
                      }}
                    >
                      {fields.map((field) => {
                        const overridden = field.key in draft.overrides;
                        const value = draft.overrides[field.key];
                        const label = field.title ?? field.key;
                        const effectiveGlobal = config.globalConfig[field.key] ?? (field.hasDefault ? field.defaultValue : undefined);
                        const controlId = 'bot-cap-override-' + field.key;
                        const describedBy = field.description ? controlId + '-desc' : undefined;
                        return (
                          <div className="bot-cap-override" key={field.key}>
                            <label className="bot-cap-override-head" htmlFor={controlId + '-override'}>
                              <input
                                id={controlId + '-override'}
                                type="checkbox"
                                checked={overridden}
                                disabled={busy !== ''}
                                aria-label={label}
                                aria-describedby={describedBy}
                                onChange={(event) => setOverride(field.key, event.target.checked ? initialOverride(field, config.globalConfig[field.key]) : undefined)}
                              />
                              <span className="bot-cap-override-label">{label}</span>
                              <span className={`bot-cap-inherit-badge${overridden ? ' is-override' : ''}`}>
                                {overridden ? t('自定义', 'custom') : t('跟随全局', 'global')}
                              </span>
                              <span className="bot-cap-override-default">{`(${jsonPreview(effectiveGlobal)})`}</span>
                            </label>
                            {field.description
                              ? <p className="metadata bot-cap-item-note" id={controlId + '-desc'}>{field.description}</p>
                              : null}
                            {!overridden ? null : field.kind === 'boolean' ? (
                              <select
                                id={controlId}
                                value={value === true ? 'true' : 'false'}
                                disabled={busy !== ''}
                                aria-label={label}
                                aria-describedby={describedBy}
                                onChange={(event) => setOverride(field.key, event.target.value === 'true')}
                              >
                                <option value="true">{t('启用', 'enabled')}</option>
                                <option value="false">{t('关闭', 'disabled')}</option>
                              </select>
                            ) : field.kind === 'enum' ? (
                              <select
                                id={controlId}
                                value={typeof value === 'string' ? value : ''}
                                disabled={busy !== ''}
                                aria-label={label}
                                aria-describedby={describedBy}
                                onChange={(event) => setOverride(field.key, event.target.value)}
                              >
                                <option value="">—</option>
                                {(field.options ?? []).map((option, index) => (
                                  <option key={option} value={option}>
                                    {field.optionNames ? field.optionNames[index] : option}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                id={controlId}
                                type={field.kind === 'number' ? 'number' : 'text'}
                                value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                                disabled={busy !== ''}
                                aria-label={label}
                                aria-describedby={describedBy}
                                onChange={(event) => setOverride(field.key, field.kind === 'number'
                                  ? (event.target.value === '' ? undefined : Number(event.target.value))
                                  : event.target.value)}
                              />
                            )}
                          </div>
                        );
                      })}
                      {hasRemoteRevisionChange ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                          <span className="metadata" style={{ color: 'var(--warn)' }}>
                            {t('远端参数已更新，保存前建议先采用远端最新配置。', 'Remote parameters changed; adopt remote values before saving.')}
                          </span>
                          <button
                            className="bot-cap-secondary"
                            type="button"
                            disabled={busy !== ''}
                            onClick={() => adoptRemote(entry)}
                          >
                            {t('采用远端配置', 'Adopt remote')}
                          </button>
                        </div>
                      ) : null}
                      <ActionBar align="end" className="bot-cap-actions" style={{ flexWrap: 'nowrap' }}>
                        <button
                          className="bot-cap-secondary"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => setEditor(null)}
                        >
                          {t('取消', 'Cancel')}
                        </button>
                        <button
                          className="bot-cap-primary"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => void saveEditor(entry)}
                        >
                          <Save size={13} aria-hidden="true" />
                          {itemBusy ? t('保存中…', 'Saving…') : t('保存参数', 'Save parameters')}
                        </button>
                      </ActionBar>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
