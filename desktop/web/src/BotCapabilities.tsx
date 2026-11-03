// 手机与桌面共用的 Bot 能力面板（插件/MCP/技能）。
// 只经中心管理接口（owner 会话 + CAS 写入）读写，不经过目标 Host、不启用旧本地 getBotExtensions；
// 目标离线仍可在中心保存，但只有中心回执 applied 才显示“已生效”，不伪报。
// 桌面端视觉重构（Lane 6）：新增桌面专属样式以 .desktop-shell/.desktop-dialog 作用域，
// 不影响手机端样式（手机端已改用 web/src/bot-settings/CapabilitiesPage）；props/数据/CAS/显式发送语义不变。
// 数据逻辑（读取、轮询、登录、CAS 保存、草稿）在 useBotCapabilities 中，与手机端 CapabilitiesPage 共用。
import { useState } from 'react';
import { Plug, Lock, ChevronDown, Save, RotateCcw, Download, Layers } from 'lucide-react';
import type {
  CenterBotCapabilityEntry,
  CenterCapabilityActivationStatus,
  CenterRuntimeApplyStatus,
} from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { flatFields, globallyReady, initialOverride, timeText, useBotCapabilities } from './useBotCapabilities';
import './BotCapabilities.css';

type Props = {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  t?: (zh: string, en: string) => string;
  /** 外层已有同名标题时可隐藏面板自带标题（手机 Bot 设置标签页）。 */
  showTitle?: boolean;
  /** 中心管理员登录成功后通知外层，同一弹窗内的其它视图可同步会话状态。 */
  onAuthenticated?: () => void;
};

const identityText = (zh: string): string => zh;

export function BotCapabilities({ api, identity, deviceId, botId, t = identityText, showTitle = true, onAuthenticated }: Props) {
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
    login,
    save,
    openEditor,
    setOverride,
    saveEditor,
    adoptRemote,
    receipt,
    capabilityErrors,
  } = useBotCapabilities({ api, identity, deviceId, botId, t, onAuthenticated });
  const [password, setPassword] = useState('');
  /** 诊断区默认折叠；展开后显示底层 revision / 时间戳 / per-bot 回执。 */
  const [diagOpen, setDiagOpen] = useState(false);

  function submitLogin(): void {
    const secret = password;
    setPassword('');
    void login(secret);
  }

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
    if (!entry.installation.enabled) return t('全局已关闭', 'disabled globally');
    const status: CenterCapabilityActivationStatus | undefined = entry.installation.activation?.status;
    if (status === 'enabled') return t('全局已启用', 'enabled globally');
    if (status === 'enabling') return t('全局启用中', 'enabling globally');
    if (status === 'failed') return t('全局启用失败', 'global activation failed');
    if (status === 'disabled') return t('全局未生效', 'globally inactive');
    return t('全局状态未确认', 'global state unknown');
  };
  const json = (value: unknown): string => (value === undefined ? t('默认', 'default') : JSON.stringify(value));

  return (
    <section className="bot-cap" aria-label={t('Bot 能力', 'Bot capabilities')} style={{ display: 'grid', gap: 10 }}>
      {showTitle ? <h4 className="bot-cap-title" style={{ margin: 0 }}>{t('插件 / MCP / 技能', 'Plugins / MCP / skills')}</h4> : null}

      {runtime ? (
        <div className="bot-cap-runtime">
          <p className="metadata bot-cap-runtime-main" role="status">
            <span className={`bot-cap-dot ${runtime.online ? 'is-online' : 'is-offline'}`} aria-hidden="true" />
            {`${t('目标设备', 'Target')}: ${runtime.online ? t('在线', 'online') : t('离线', 'offline')} · ${t('应用状态', 'Status')}: ${statusText(runtime.status)}`}
          </p>
          {runtime.error ? <p className="bot-cap-error" role="alert">{`${runtime.error.code}: ${runtime.error.message}`}</p> : null}
          {capabilityErrors.map((item) => (
            <p className="bot-cap-error" role="alert" key={item.installationId}>{`${item.installationId}: ${item.error.code}`}</p>
          ))}
          {!runtime.online
            ? <p className="metadata bot-cap-runtime-detail">{t('目标离线：能力保存仍会写入中心，等设备上线后同步。', 'Target offline: saves still go to the center and sync when the device reconnects.')}</p>
            : null}
          {/* 诊断区折叠：主视图只保留在线态+应用状态摘要，revision/时间戳按需展开。 */}
          <button
            type="button"
            className="bot-cap-diag-toggle"
            aria-expanded={diagOpen}
            onClick={() => setDiagOpen((v) => !v)}
          >
            <ChevronDown size={13} className={`bot-cap-diag-chevron${diagOpen ? ' open' : ''}`} aria-hidden="true" />
            {diagOpen ? t('收起诊断详情', 'Hide diagnostics') : t('诊断详情', 'Diagnostics')}
          </button>
          {diagOpen ? (
            <div className="bot-cap-diag">
              <p className="metadata bot-cap-runtime-detail">
                {`${t('已下发', 'Desired')} revision ${runtime.desiredRevision ?? '—'} · ${t('已应用', 'Applied')} revision ${runtime.appliedRevision ?? '—'} · ${t('更新', 'Updated')} ${timeText(runtime.updatedAt)} · ${t('生效时间', 'Applied at')} ${timeText(runtime.appliedAt)}`}
              </p>
              {receipt ? (
                <p className="metadata bot-cap-runtime-detail">
                  {`${t('该 Bot', 'This bot')}: ${statusText(receipt.status)} · ${t('已应用', 'Applied')} revision ${receipt.appliedRevision ?? '—'}`}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!loaded ? <p className="bot-cap-loading" role="status">{t('正在读取中心能力…', 'Loading capabilities…')}</p> : null}

      {needLogin ? (
        <form className="bot-cap-login" onSubmit={(event) => { event.preventDefault(); submitLogin(); }}>
          <p className="bot-cap-login-head">
            <Lock size={14} aria-hidden="true" />
            {t('需要中心管理员身份才能管理该 Bot 的能力。', 'Center administrator sign-in is required to manage this bot’s capabilities.')}
          </p>
          <label className="bot-cap-field">
            <span className="bot-cap-field-label">{t('中心管理员密码', 'Center administrator password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="bot-cap-primary" type="submit" disabled={!password || busy !== ''}>{t('登录', 'Log in')}</button>
        </form>
      ) : null}

      {error ? <p className="bot-cap-error" role="alert">{error}</p> : null}
      {notice ? <p className="bot-cap-notice" role="status">{notice}</p> : null}

      {loaded && !needLogin && entries.length === 0
        ? (
          <p className="metadata bot-cap-empty">
            <Plug size={18} aria-hidden="true" />
            {t('中心暂无可用于该 Bot 的能力。', 'No capability is available for this bot.')}
          </p>
        )
        : null}

      {entries.map((entry) => {
        const { installation, config } = entry;
        const draft = editor?.installationId === installation.installationId ? editor : null;
        const fields = flatFields(config.configSchema, entry.uiSchema);
        const itemBusy = busy === installation.installationId;
        const overrideCount = Object.keys(config.overrides).length;
        return (
          <section
            key={installation.installationId}
            className={`bot-cap-item${config.enabled ? ' is-enabled' : ''}`}
            role="group"
            aria-label={installation.displayName}
            style={{ display: 'grid', gap: 6 }}
          >
            {/* 卡片头：名称 + 类型/目标徽章 + 为该 Bot 启用的 iOS 拨动开关 */}
            <div className="bot-cap-item-head">
              <div className="bot-cap-item-title">
                <Layers size={15} className="bot-cap-item-icon" aria-hidden="true" />
                <strong>{installation.displayName}</strong>
                <span className="bot-cap-item-tags">{`${kindText(installation.kind)} · ${targetText(installation.target)}`}</span>
              </div>
              <label className="bot-cap-toggle">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  disabled={busy !== '' || (!config.enabled && !globallyReady(entry))}
                  onChange={(event) => {
                    const next = event.target.checked;
                    // 不得用 Bot 开关打开全局；全局未生效时拒绝开启，但允许关闭。
                    if (next && !globallyReady(entry)) {
                      setError(t('该能力全局未启用（或启用未完成），不能为本 Bot 开启；请先在中心启用并等待生效。', 'The capability is not enabled globally yet; enable it in the center first.'));
                      return;
                    }
                    void save(entry, next, config.overrides, config.revision);
                  }}
                />
                <span className="bot-cap-toggle-text">{t('为该 Bot 启用', 'Enable for this bot')}</span>
              </label>
            </div>

            {/* 全局状态行 + 覆写摘要 */}
            <p className="metadata bot-cap-item-global">
              {`${globalStateText(entry)} · ${t('全局更新', 'global updated')} ${timeText(installation.activation?.updatedAt ?? null)}`}
            </p>
            {installation.activation?.error
              ? <p className="bot-cap-error" role="alert">{`${installation.activation.error.code}: ${installation.activation.error.message}`}</p>
              : null}
            {!globallyReady(entry) && !config.enabled
              ? <p className="metadata bot-cap-item-note">{t('全局未生效：本 Bot 无法开启该能力，请先在中心启用并等待生效。', 'Not active globally: this bot cannot switch it on until the center enables it.')}</p>
              : null}
            {config.enabled && !globallyReady(entry)
              ? <p className="metadata bot-cap-item-note">{t('当前不生效：本 Bot 偏好已保留，全局生效后会重新加载。', 'Currently inactive: the bot preference is kept and loads again once the global capability is active.')}</p>
              : null}
            <p className="metadata bot-cap-item-note bot-cap-override-summary">
              {overrideCount
                ? t(`已覆写本 Bot 配置（${overrideCount} 项）`, `${overrideCount} bot override(s) configured`)
                : t('继承全局配置', 'Inherits global config')}
            </p>

            {draft === null ? (
              <button className="bot-cap-secondary bot-cap-configure" type="button" disabled={busy !== ''} onClick={() => openEditor(entry)}>
                {t('配置本 Bot', 'Configure for this bot')}
              </button>
            ) : (
              <div className="bot-cap-editor" style={{ display: 'grid', gap: 6 }}>
                {/* 编辑/启用开关（含 CAS 基线提示） */}
                <div className="bot-cap-editor-top">
                  <label className="bot-cap-toggle">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      disabled={busy !== ''}
                      onChange={(event) => setEditor((current) => (current ? { ...current, enabled: event.target.checked } : current))}
                    />
                    <span>{t('为该 Bot 启用', 'Enable for this bot')}</span>
                  </label>
                  <span className="metadata bot-cap-rev">{`rev ${draft.revision}`}</span>
                </div>

                {fields === null ? (
                  <label className="bot-cap-field">
                    <span className="bot-cap-field-label">
                      {t('覆盖配置 JSON（整段覆写，数组整体替换）', 'Overrides JSON (whole-value; arrays replace)')}
                    </span>
                    <textarea
                      rows={6}
                      spellCheck={false}
                      value={draft.text ?? ''}
                      disabled={busy !== ''}
                      onChange={(event) => {
                        const text = event.target.value;
                        setEditor((current) => (current ? { ...current, text } : current));
                      }}
                    />
                  </label>
                ) : fields.length === 0 ? (
                  <p className="metadata bot-cap-item-note">{t('该能力没有可配置项。', 'This capability has no configurable field.')}</p>
                ) : fields.map((field) => {
                  const overridden = field.key in draft.overrides;
                  const value = draft.overrides[field.key];
                  const label = field.title ? field.title + '（' + field.key + '）' : field.key;
                  const effectiveGlobal = config.globalConfig[field.key] ?? (field.hasDefault ? field.defaultValue : undefined);
                  const controlId = 'bot-cap-override-' + field.key;
                  const describedBy = field.description ? controlId + '-desc' : undefined;
                  return (
                    <div className="bot-cap-override" key={field.key}>
                      {/* 字段继承开关：勾选 = 覆盖该字段，取消 = 继承全局 */}
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
                          {overridden ? t('覆写', 'override') : t('继承全局', 'inherit')}
                        </span>
                        <span className="bot-cap-override-default">{`(${json(effectiveGlobal)})`}</span>
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
                              {field.optionNames ? field.optionNames[index] + '（' + option + '）' : option}
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
                    {itemBusy ? t('保存中…', 'Saving…') : t('保存', 'Save')}
                  </button>
                  <button className="bot-cap-secondary" type="button" disabled={busy !== ''} onClick={() => setEditor(null)}>
                    {t('取消', 'Cancel')}
                  </button>
                  <button
                    className="bot-cap-secondary"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => {
                      // 显式采用远端：只有这个动作会替换草稿内容与 CAS 基线（逻辑见 useBotCapabilities.adoptRemote）。
                      adoptRemote(entry);
                    }}
                  >
                    <Download size={13} aria-hidden="true" />
                    {t('采用远端（丢弃草稿）', 'Adopt remote (discard draft)')}
                  </button>
                  <span className="metadata bot-cap-cas-hint">
                    <RotateCcw size={11} aria-hidden="true" />
                    {t(`基线 rev ${draft.revision}；保存时以 CAS 保护，冲突时不会覆盖远端。`, `Baseline rev ${draft.revision}; saved with CAS — conflicts never overwrite the remote.`)}
                  </span>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
