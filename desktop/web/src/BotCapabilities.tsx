// Bot 工具扩展面板（MCP & 插件，已过滤 skill）。
// 免密直连中心，不再弹出管理员密码框或暴露 revision / Center / Host 等底层黑话。
import { Plug, Save } from 'lucide-react';
import type {
  CenterBotCapabilityEntry,
  CenterCapabilityActivationStatus,
  CenterRuntimeApplyStatus,
} from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
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
    <section className="bot-cap" aria-label={t('工具扩展（MCP & 插件）', 'Tool extensions (MCP & Plugins)')} style={{ display: 'grid', gap: 10 }}>
      {showTitle ? <h4 className="bot-cap-title" style={{ margin: 0 }}>{t('工具扩展 (MCP & 插件)', 'Tool Extensions (MCP & Plugins)')}</h4> : null}

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
        onOpenCenterAdmin={onOpenCenterAdmin}
      />

      {runtime ? (
        <div className="bot-cap-runtime">
          <p className="metadata bot-cap-runtime-main" role="status">
            <span className={`bot-cap-dot ${runtime.online ? 'is-online' : 'is-offline'}`} aria-hidden="true" />
            {runtime.online ? t('目标设备在线，修改即时同步', 'Target device online — changes sync immediately') : t('目标设备当前离线，保存后将在上线时自动同步', 'Device offline — saved changes will sync when online')}
          </p>
        </div>
      ) : null}

      {!loaded ? <p className="bot-cap-loading" role="status">{t('正在读取工具扩展…', 'Loading tool extensions…')}</p> : null}

      {needLogin ? (
        <div className="bot-cap-empty" role="status" style={{ display: 'grid', gap: 8 }}>
          <p className="metadata" style={{ margin: 0 }}>
            {t('当前中心会话需要授权认证，请检查「设置 → 中心连接」状态或前往中心管理。', 'Center authorization required. Check Center Connection or open Center Admin.')}
          </p>
          {onOpenCenterAdmin && (
            <div>
              <button type="button" className="bot-cap-secondary" onClick={onOpenCenterAdmin}>
                {t('前往中心管理', 'Open Center Admin')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {error ? <p className="bot-cap-error" role="alert">{error}</p> : null}
      {notice ? <p className="bot-cap-notice" role="status">{notice}</p> : null}

      {loaded && !needLogin && toolEntries.length === 0 ? (
        <div className="metadata bot-cap-empty" style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plug size={16} aria-hidden="true" />
            {t('中心尚未安装可用的 MCP 或插件扩展。', 'No MCP or plugin extensions installed in the center yet.')}
          </span>
          {onOpenCenterAdmin && (
            <button type="button" className="bot-cap-secondary" onClick={onOpenCenterAdmin}>
              {t('去中心管理安装扩展 →', 'Install extensions in Center Admin →')}
            </button>
          )}
        </div>
      ) : null}

      {toolEntries.map((entry) => {
        const { installation, config } = entry;
        const draft = editor?.installationId === installation.installationId ? editor : null;
        const fields = flatFields(config.configSchema, entry.uiSchema);
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

        return (
          <section
            key={installation.installationId}
            className={`bot-cap-item${config.enabled ? ' is-enabled' : ''}`}
            role="group"
            aria-label={installation.displayName}
            style={{ display: 'grid', gap: 6 }}
          >
            <div className="bot-cap-item-head">
              <div className="bot-cap-item-title">
                <strong>{installation.displayName}</strong>
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

            <p className="metadata">{description || kindText(installation.kind)}</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <p className="bot-cap-item-status" style={{ margin: 0 }}>{availability}</p>
              {!globallyAvailable && onOpenCenterAdmin ? (
                <button type="button" className="bot-cap-secondary" onClick={onOpenCenterAdmin}>
                  {t('去中心管理启用 →', 'Enable in Center Admin →')}
                </button>
              ) : null}
            </div>

            {fields && fields.length > 0 && (
              draft === null ? (
                <button className="bot-cap-secondary bot-cap-configure" type="button" disabled={busy !== ''} onClick={() => openEditor(entry)}>
                  {t('调整扩展参数', 'Configure parameters')}
                </button>
              ) : (
                <div className="bot-cap-editor" style={{ display: 'grid', gap: 8 }}>
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
                  <div className="bot-cap-actions">
                    <button className="bot-cap-primary" type="button" disabled={busy !== ''} onClick={() => void saveEditor(entry)}>
                      <Save size={13} aria-hidden="true" />
                      {itemBusy ? t('保存中…', 'Saving…') : t('保存参数', 'Save parameters')}
                    </button>
                    <button className="bot-cap-secondary" type="button" disabled={busy !== ''} onClick={() => setEditor(null)}>
                      {t('取消', 'Cancel')}
                    </button>
                  </div>
                </div>
              )
            )}
          </section>
        );
      })}
    </section>
  );
}
