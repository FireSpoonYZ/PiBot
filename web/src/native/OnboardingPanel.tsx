// C7 Android 首启引导 UI：owner 密码一键配对 + 通知/后台/Shizuku 真实状态与动作。
// 密码只在本组件内存，提交即清；token 不离开原生。沿用 .hst-/.bs- 既有原语，少量 .ob- 补充样式。
// 配对结果只表示“已登记/已请求连接”，就绪与否始终由 CenterGate 的 center_status/broker 轮询判定。
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BatteryCharging, Bell, Server, ShieldCheck } from 'lucide-react';
import { useCenterConnection } from './CenterGate';
import { onboardingAction, onboardingStatus } from './tauri-host';
import { BotHost, type HostSnapshot, type OnboardingActionName, type OnboardingStatus, type PairCenterResult } from './index';
import { Badge, Disclosure, Row, Section, StatusLine } from '../bot-settings/primitives';
import { ErrorNotice, errorText, useText } from '../ui';
import './onboarding.css';

/** 手工令牌连接：沿用设置页原有表单（URL + 设备标识 + 客户端令牌 + 重连/清除）。 */
function ManualCenterConnect({ onDone }: { onDone?: () => void }) {
  const t = useText();
  const centerConn = useCenterConnection();
  return (
    <>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('中心地址', 'Center URL')}</span>
        <input
          className="hst-input"
          inputMode="url"
          disabled={centerConn.busy}
          value={centerConn.url}
          onChange={e => centerConn.setUrl(e.target.value)}
          placeholder="https://127.0.0.1:4318"
        />
      </label>

      <label className="hst-input-row">
        <span className="hst-input-label">{t('设备标识', 'Device ID')}</span>
        <input
          className="hst-input"
          disabled={centerConn.busy}
          value={centerConn.deviceId}
          onChange={e => centerConn.setDeviceId(e.target.value)}
          placeholder="android-client"
        />
      </label>

      <label className="hst-input-row">
        <span className="hst-input-label">{t('客户端令牌', 'Client Token')}</span>
        <input
          type="password"
          autoComplete="new-password"
          className="hst-input"
          disabled={centerConn.busy}
          value={centerConn.token}
          onChange={e => centerConn.setToken(e.target.value)}
          placeholder={
            centerConn.matchesSaved
              ? t('留空使用已保存令牌', 'Blank to use saved token')
              : t('输入中心访问令牌', 'Enter client token')
          }
        />
      </label>

      {centerConn.error && (
        <div className="hst-row-static">
          <ErrorNotice error={centerConn.error} compact onDismiss={() => centerConn.setError('')} />
        </div>
      )}

      <div className="hst-actions">
        {centerConn.saved?.url && (
          <button
            type="button"
            className="hst-btn"
            disabled={centerConn.busy}
            onClick={() => void centerConn.disconnect()}
          >
            {t('断开并清除凭据', 'Clear Saved')}
          </button>
        )}
        {centerConn.matchesSaved && !centerConn.token.trim() && (
          <button
            type="button"
            className="hst-btn"
            disabled={centerConn.busy}
            onClick={() =>
              void centerConn.connect().then(() => {
                onDone?.();
              })
            }
          >
            {t('用已存凭据重连', 'Reconnect Saved')}
          </button>
        )}
        <button
          type="button"
          className="hst-btn is-primary"
          disabled={
            centerConn.busy ||
            !centerConn.url.trim() ||
            !centerConn.deviceId.trim() ||
            (!centerConn.token.trim() && !centerConn.matchesSaved)
          }
          onClick={() =>
            void centerConn
              .connect()
              .then(() => {
                onDone?.();
              })
          }
        >
          {centerConn.preparing
            ? t('正在启动本机节点…', 'Starting Host…')
            : centerConn.busy
              ? t('连接中…', 'Connecting…')
              : t('连接中心', 'Connect Center')}
        </button>
      </div>
    </>
  );
}

/** owner 密码配对表单：成功后切换为结果视图，避免重复提交已登记设备。 */
function PairCenterForm({ onDone }: { onDone?: () => void }) {
  const t = useText();
  const centerConn = useCenterConnection();
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [force, setForce] = useState(false);
  const [suggestForce, setSuggestForce] = useState(false);
  const [result, setResult] = useState<PairCenterResult>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // 密码只经本次请求传给原生，立即从组件状态清除。
    const secret = password;
    setPassword('');
    void centerConn
      .pair(secret, { displayName: displayName.trim() || undefined, force })
      .then(
        done => {
          if (!done) return;
          setResult(done);
          setForce(false);
          // 已请求连接且无警告时交回上层收尾；等待连接/有警告时保留结果视图供用户处理。
          if (done.connectionRequested && !(done.warnings && done.warnings.length)) onDone?.();
        },
        failure => {
          // force 只在原生明确回报已有绑定（ALREADY_CONFIGURED）时建议，网络等普通失败不提示。
          const code = typeof failure === 'object' && failure !== null && 'code' in failure
            ? String((failure as { code: unknown }).code)
            : '';
          if (code === 'ALREADY_CONFIGURED') setSuggestForce(true);
        },
      );
  };

  if (result) {
    return (
      <>
        <div className="hst-row-static">
          <StatusLine tone={centerConn.ready ? 'success' : result.connectionRequested ? 'accent' : 'warning'}>
            {centerConn.ready
              ? t('已连接中心', 'Center connected')
              : result.connectionRequested
                ? t('已绑定设备，正在建立连接…', 'Device bound, connecting…')
                : t('已保存设备绑定，等待连接', 'Device bound, connection pending')}
          </StatusLine>
        </div>
        <div className="hst-device-row">
          <span className="hst-device-name">{result.displayName || result.deviceId}</span>
          {result.hostConfigured && <Badge tone="success">{t('已登记', 'Registered')}</Badge>}
        </div>
        {!result.hostConfigured && (
          <div className="hst-row-static">
            <span className="ob-note">{t('本机绑定未完成，可用已存凭据重试', 'Local binding incomplete — you can retry with saved credentials')}</span>
          </div>
        )}
        {result.warnings?.map((warning, index) => (
          <div className="hst-row-static" key={index}>
            <span className="ob-note">{`${warning.code}: ${warning.message}`}</span>
          </div>
        ))}
        {centerConn.error && (
          <div className="hst-row-static">
            <ErrorNotice error={centerConn.error} compact onDismiss={() => centerConn.setError('')} />
          </div>
        )}
        <div className="hst-actions">
          <button type="button" className="hst-btn is-ghost" onClick={() => setResult(undefined)}>
            {t('重新输入', 'Edit')}
          </button>
          {!result.hostConfigured && !centerConn.ready && (
            <button
              type="button"
              className="hst-btn"
              disabled={centerConn.busy}
              onClick={() =>
                // repair 不注册新设备也不需密码；结果回填为新的 PairCenterResult，warnings 随其更新。
                void centerConn.repair().then(
                  repaired => { if (repaired) setResult(repaired); },
                  () => { /* 错误已由 gate 置 centerConn.error 展示 */ },
                )
              }
            >
              {t('重试本机绑定', 'Retry local binding')}
            </button>
          )}
          {!centerConn.ready && (
            <button
              type="button"
              className="hst-btn"
              disabled={centerConn.busy || !centerConn.matchesSaved}
              onClick={() => void centerConn.connect()}
            >
              {t('重连（不重复登记）', 'Reconnect')}
            </button>
          )}
        </div>
      </>
    );
  }

  // force 只在本机已有保存绑定、或原生明确 ALREADY_CONFIGURED 时出现；它替换的是本机所存绑定。
  const showForce = Boolean(centerConn.saved?.url) || suggestForce;
  return (
    <form onSubmit={submit}>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('中心地址', 'Center URL')}</span>
        <input
          className="hst-input"
          inputMode="url"
          disabled={centerConn.busy}
          value={centerConn.url}
          onChange={e => centerConn.setUrl(e.target.value)}
          placeholder="https://center.example.com"
        />
      </label>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('所有者密码', 'Owner Password')}</span>
        <input
          type="password"
          autoComplete="off"
          className="hst-input"
          disabled={centerConn.busy}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={t('输入中心所有者密码', 'Enter center owner password')}
        />
      </label>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('设备名称', 'Device Name')}</span>
        <input
          className="hst-input"
          disabled={centerConn.busy}
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder={t('选填，例如：我的手机', 'Optional, e.g. My phone')}
        />
      </label>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('CA 证书', 'CA PEM')}</span>
        <input
          className="hst-input"
          disabled={centerConn.busy}
          value={centerConn.ca}
          onChange={e => centerConn.setCa(e.target.value)}
          placeholder={t('自签名证书 PEM（选填）', 'Optional self-signed PEM')}
        />
      </label>
      {showForce && (
        <label className="hst-row-static ob-check-row">
          <input
            type="checkbox"
            className="ob-check"
            disabled={centerConn.busy}
            checked={force}
            onChange={e => setForce(e.target.checked)}
          />
          <span>{t('替换本机已保存的绑定', 'Replace the binding saved on this device')}</span>
        </label>
      )}
      {centerConn.error && (
        <div className="hst-row-static">
          <ErrorNotice error={centerConn.error} compact onDismiss={() => centerConn.setError('')} />
        </div>
      )}
      <div className="hst-actions">
        <button
          type="submit"
          className="hst-btn is-primary"
          disabled={centerConn.busy || !centerConn.url.trim() || !password}
        >
          {centerConn.busy ? t('配对中…', 'Pairing…') : t('配对并连接', 'Pair & Connect')}
        </button>
      </div>
    </form>
  );
}

/**
 * 中心连接卡：无已存凭据时默认 owner 密码配对（手工令牌收进“高级”），
 * 有已存凭据时保持原有手工表单（自动重连不变），重新配对收进折叠项。
 */
export function OnboardingPanel({ onDone }: { onDone?: () => void }) {
  const t = useText();
  const centerConn = useCenterConnection();
  // 分支在挂载时锁定：配对成功后 savedConnection 更新不得卸载结果视图/丢失 warnings 与重连入口；
  // 重新进入设置时按最新 saved 重新选择。
  const [hasSaved] = useState(() => Boolean(centerConn.saved?.url));
  return hasSaved ? (
    <>
      <ManualCenterConnect onDone={onDone} />
      <Disclosure title={t('用所有者密码重新配对', 'Re-pair with owner password')}>
        <PairCenterForm onDone={onDone} />
      </Disclosure>
    </>
  ) : (
    <>
      <PairCenterForm onDone={onDone} />
      <Disclosure title={t('高级：手动令牌连接', 'Advanced: manual token')}>
        <ManualCenterConnect onDone={onDone} />
      </Disclosure>
    </>
  );
}

const HOST_PHASE_LABEL: Record<HostSnapshot['phase'], [string, string]> = {
  running: ['运行中', 'Running'],
  starting: ['启动中', 'Starting'],
  stopping: ['停止中', 'Stopping'],
  failed: ['失败', 'Failed'],
  stopped: ['已停止', 'Stopped'],
};

/** 通知/后台电池/Shizuku/本机 Host 真实状态区：按钮仅发起系统动作，回到应用后重查。 */
export function OnboardingPermissions() {
  const t = useText();
  const centerConn = useCenterConnection();
  const [status, setStatus] = useState<OnboardingStatus>();
  const [host, setHost] = useState<HostSnapshot>();
  const [statusFailed, setStatusFailed] = useState(false);
  const [actionError, setActionError] = useState('');
  // 最近一次 repair 回执：resolve 不代表完成，hostConfigured/connectionRequested/warnings 需展示。
  const [repairResult, setRepairResult] = useState<PairCenterResult>();
  // pending 为串行占用标记：取值为 OnboardingActionName 或 'repair'。
  const [pending, setPending] = useState<string | null>(null);
  // epoch 只隔离状态查询（后到的 refresh 作废旧回执）；动作完成与否由 mounted + actionSeq 判定。
  const epoch = useRef(0);
  const mounted = useRef(false);
  const actionSeq = useRef(0);
  const followUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    const issued = ++epoch.current;
    void onboardingStatus().then(
      next => {
        if (issued !== epoch.current) return;
        setStatus(next);
        setStatusFailed(false);
      },
      () => {
        // 刷新失败：即使已有旧 status 也标记为过期，不把旧值当最新成功展示。
        if (issued === epoch.current) setStatusFailed(true);
      },
    );
    void BotHost.snapshot()
      .then(next => {
        if (issued === epoch.current) setHost(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // StrictMode 重挂时 setup 会再次执行并恢复 true。
    mounted.current = true;
    refresh();
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    const onFocus = () => refresh();
    // 权限对话框/系统设置页不一定触发 visibilitychange，回前台 focus 兜底重查。
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      if (followUp.current) clearTimeout(followUp.current);
      // 查询代递增：在途 refresh 回执一律失效，不再 setState。
      epoch.current += 1;
    };
  }, [refresh]);

  const run = (action: OnboardingActionName) => {
    if (pending) return;
    // 动作回调只按 mounted + 动作序号归属：查询 refresh 推进 epoch 不影响动作的错误提示与补查。
    const seq = ++actionSeq.current;
    setPending(action);
    setActionError('');
    void onboardingAction(action).then(
      () => {
        if (!mounted.current || seq !== actionSeq.current) return;
        refresh();
        // requested 不代表已授权：权限对话框可能不产生任何 resume 事件，
        // 有界补查一次覆盖迟到的授权结果；cleanup 会取消该定时器。
        if (followUp.current) clearTimeout(followUp.current);
        followUp.current = setTimeout(() => {
          followUp.current = undefined;
          refresh();
        }, 1500);
      },
      error => {
        if (!mounted.current || seq !== actionSeq.current) return;
        setActionError(errorText(error) || t('权限操作失败，请重试', 'Permission action failed, please retry'));
      },
    ).finally(() => {
      if (mounted.current && seq === actionSeq.current) setPending(null);
    });
  };

  // 已存绑定的失败恢复入口：不自动重试、不把 requested 当就绪；错误走同一条 ErrorNotice。
  const repair = () => {
    if (pending) return;
    const seq = ++actionSeq.current;
    setPending('repair');
    setActionError('');
    setRepairResult(undefined);
    void centerConn.repair().then(
      result => {
        if (mounted.current && seq === actionSeq.current) {
          if (result) setRepairResult(result);
          refresh();
        }
      },
      error => {
        if (mounted.current && seq === actionSeq.current) {
          setActionError(errorText(error) || t('修复绑定失败，请重试', 'Binding repair failed, please retry'));
        }
      },
    ).finally(() => {
      if (mounted.current && seq === actionSeq.current) setPending(null);
    });
  };

  const shizuku: { tone: 'neutral' | 'warning' | 'success'; label: string; action?: OnboardingActionName; button?: string } | undefined = status
    ? !status.shizukuInstalled
      ? { tone: 'neutral', label: t('未安装', 'Not installed'), action: 'shizuku-manager', button: t('打开管理器', 'Open manager') }
      : !status.shizukuRunning
        ? { tone: 'warning', label: t('未运行', 'Not running'), action: 'shizuku-manager', button: t('去启动', 'Start') }
        : !status.shizukuGranted
          ? { tone: 'warning', label: t('未授权', 'Not granted'), action: 'shizuku-permission', button: t('授权', 'Grant') }
          : { tone: 'success', label: t('已授权', 'Granted') }
    : undefined;

  const hostLabel = host ? t(HOST_PHASE_LABEL[host.phase][0], HOST_PHASE_LABEL[host.phase][1]) : t('读取中…', 'Checking…');

  return (
    <Section
      title={t('通知与后台运行', 'Alerts & background')}
      action={
        <button type="button" className="bs-link" onClick={refresh}>
          {t('刷新', 'Refresh')}
        </button>
      }
      hint={t(
        '通知与电池优化影响消息提醒与后台连接；Shizuku 重启后需在管理器中重新启动，权限只影响对应功能，可先完成聊天连接再处理。',
        'Notifications and battery affect alerts and background connection; after a reboot Shizuku must be started in its manager again. Permissions only affect their own features — chat works without them.'
      )}
    >
      {actionError && (
        <div className="hst-row-static">
          <ErrorNotice error={actionError} compact onDismiss={() => setActionError('')} />
        </div>
      )}
      {statusFailed && status && (
        <div className="hst-row-static">
          <span className="ob-note">{t('上次查询失败，以下状态可能不是最新', 'Last check failed — status below may be stale')}</span>
        </div>
      )}
      {statusFailed && !status ? (
        <Row
          icon={<ShieldCheck />}
          title={t('无法读取权限状态', 'Cannot read permission status')}
          trailing={
            <button type="button" className="hst-btn" onClick={refresh}>
              {t('重试', 'Retry')}
            </button>
          }
        />
      ) : (
        <>
          <Row
            icon={<Bell />}
            title={t('通知', 'Notifications')}
            subtitle={status ? undefined : t('读取中…', 'Checking…')}
            trailing={
              status?.notificationsGranted ? (
                <Badge tone="success">{t('已开启', 'On')}</Badge>
              ) : (
                <button
                  type="button"
                  className="hst-btn"
                  disabled={!status || pending !== null}
                  onClick={() => run('notifications')}
                >
                  {t('开启', 'Enable')}
                </button>
              )
            }
          />
          <Row
            icon={<BatteryCharging />}
            title={t('后台运行', 'Background run')}
            subtitle={
              status && !status.batteryUnrestricted
                ? t('受系统电池优化限制', 'Restricted by battery optimization')
                : undefined
            }
            trailing={
              status?.batteryUnrestricted ? (
                <Badge tone="success">{t('不受限制', 'Unrestricted')}</Badge>
              ) : (
                <button
                  type="button"
                  className="hst-btn"
                  disabled={!status || pending !== null}
                  onClick={() => run('battery-settings')}
                >
                  {t('去设置', 'Open settings')}
                </button>
              )
            }
          />
          <Row
            icon={<ShieldCheck />}
            title="Shizuku"
            subtitle={
              status?.shizukuInstalled && !status.shizukuRunning
                ? t('需在 Shizuku 管理器中启动', 'Start it in the Shizuku manager')
                : undefined
            }
            trailing={
              shizuku && shizuku.action ? (
                <>
                  <Badge tone={shizuku.tone}>{shizuku.label}</Badge>
                  <button
                    type="button"
                    className="hst-btn"
                    disabled={pending !== null}
                    onClick={() => run(shizuku.action!)}
                  >
                    {shizuku.button}
                  </button>
                </>
              ) : (
                <Badge tone={shizuku?.tone ?? 'neutral'}>{shizuku?.label ?? t('读取中…', 'Checking…')}</Badge>
              )
            }
          />
          <Row
            icon={<Server />}
            title={t('本机节点', 'Local host')}
            subtitle={host?.deviceId ?? undefined}
            trailing={
              <>
                {host?.restartRequired && <Badge tone="warning">{t('需重启', 'Restart required')}</Badge>}
                <Badge tone={host?.phase === 'running' ? 'success' : host?.phase === 'failed' ? 'danger' : 'neutral'}>
                  {hostLabel}
                </Badge>
                {/* 客户端 ready 也可能 Host 保存失败：有已存绑定即可显式修复。 */}
                {centerConn.saved?.url && (
                  <button
                    type="button"
                    className="hst-btn"
                    disabled={pending !== null || centerConn.busy}
                    onClick={repair}
                  >
                    {t('修复绑定', 'Repair binding')}
                  </button>
                )}
              </>
            }
          />
          {repairResult && !repairResult.hostConfigured && (
            <div className="hst-row-static">
              <span className="ob-note">{t('本机绑定未完成，可用已存凭据重试', 'Local binding incomplete — you can retry with saved credentials')}</span>
            </div>
          )}
          {repairResult && repairResult.hostConfigured && !repairResult.connectionRequested && (
            <div className="hst-row-static">
              <span className="ob-note">{t('已保存设备绑定，等待连接', 'Device bound, connection pending')}</span>
            </div>
          )}
          {repairResult?.warnings?.map((warning, index) => (
            <div className="hst-row-static" key={index}>
              <span className="ob-note">{`${warning.code}: ${warning.message}`}</span>
            </div>
          ))}
        </>
      )}
    </Section>
  );
}
