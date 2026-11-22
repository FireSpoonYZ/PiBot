// C7 Android 首启引导 UI：owner 密码一键配对 + 通知/后台/Shizuku 真实状态与动作。
// 密码只在本组件内存，提交即清；token 不离开原生。沿用 .hst-/.bs- 既有原语，少量 .ob- 补充样式。
// 配对结果只表示“已登记/已请求连接”，就绪与否始终由 CenterGate 的 center_status/broker 轮询判定。
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { BatteryCharging, Bell, CheckCircle2, Loader2, ScanLine, Server, ShieldCheck } from 'lucide-react';
import { useCenterConnection } from './CenterGate';
import { mobileClientRequest, mobileHaptic, onboardingAction, onboardingStatus, scanPairingCode } from './tauri-host';
import { BotHost, type HostSnapshot, type OnboardingActionName, type OnboardingStatus, type PairCenterResult } from './index';
import { Badge, Disclosure, Row, Section, SettingsSheet, StatusLine } from '../bot-settings/primitives';
import { readScannedCode } from '../pairingCode';
import { ErrorNotice, errorText, splitErrorCode, useText } from '../ui';
import { useConnectionPhaseContext } from '../connection';
import { useNotice } from '../notice';
import { LabelStack, ReservedSlot, Skeleton } from '../layout';
import './onboarding.css';

type ScannedWebLogin = {
  kind: 'web-login';
  centerUrl: string;
  centerHost: string;
  challengeId: string;
  qrNonce: string;
};

/** 手机上的 loopback 是手机自己，不可能是中心：http 一律不收，与原生 PairingCode.parse 保持一致。 */
const readPaste = (text: string) => readScannedCode(text, { allowLoopbackHttp: false });

function normalizeCenterOrigin(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw.trim()).origin.toLowerCase();
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function hostOfUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw.trim()).host;
  } catch {
    return raw.trim();
  }
}

/** 网页端免密登录二维码确认卡：核对中心一致后调用 center_qr_login_approve。 */
function WebLoginConfirmView({
  login,
  onCancel,
  onDone,
}: {
  login: ScannedWebLogin;
  onCancel: () => void;
  onDone?: () => void;
}) {
  const t = useText();
  const centerConn = useCenterConnection();
  const { notify, dismiss } = useNotice();
  const [submitting, setSubmitting] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!error) {
      dismiss('onboarding:web-login-error');
      return;
    }
    notify({
      id: 'onboarding:web-login-error',
      tone: 'error',
      title: error,
    });
  }, [error, notify, dismiss]);

  useEffect(() => {
    return () => {
      dismiss('onboarding:web-login-error');
    };
  }, [dismiss]);

  const boundUrl = centerConn.status?.centerUrl || centerConn.saved?.url || '';
  const boundOrigin = normalizeCenterOrigin(boundUrl);
  const qrOrigin = normalizeCenterOrigin(login.centerUrl);
  const boundHost = hostOfUrl(boundUrl);
  const sameCenter = Boolean(boundOrigin && qrOrigin && boundOrigin === qrOrigin);
  const canApprove = Boolean(centerConn.ready && sameCenter);

  const approve = () => {
    if (!canApprove || submitting) return;
    setSubmitting(true);
    setError('');
    void mobileClientRequest('center_qr_login_approve', {
      challengeId: login.challengeId,
      qrNonce: login.qrNonce,
    })
      .then(
        () => {
          mobileHaptic('confirm');
          setApproved(true);
        },
        err => setError(errorText(err) || t('确认网页端登录失败，请重试', 'Failed to confirm web login')),
      )
      .finally(() => setSubmitting(false));
  };

  if (approved) {
    return (
      <>
        <div className="hst-row-static">
          <StatusLine tone="success">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{t('✓ 已确认网页端登录', '✓ Web login confirmed')}</span>
          </StatusLine>
        </div>
        <div className="hst-row-static">
          <span className="ob-note">
            {t(`电脑浏览器（${login.centerHost}）将自动进入中心管理。`, `Your browser (${login.centerHost}) will sign in shortly.`)}
          </span>
        </div>
        <div className="hst-actions">
          <button type="button" className="hst-btn is-primary" onClick={() => (onDone ?? onCancel)()}>
            {t('完成', 'Done')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="hst-row-static">
        <span className="bs-row-title">{t('确认在电脑浏览器登录中心管理？', 'Confirm login to Center Admin in your browser?')}</span>
      </div>
      <div className="hst-row-static">
        <span className="ob-note">{t(`目标中心：${login.centerHost}`, `Target center: ${login.centerHost}`)}</span>
      </div>
      {!boundOrigin && (
        <div className="hst-row-static">
          <ErrorNotice
            tone="warning"
            title={t('本机尚未绑定中心', 'This device is not bound yet')}
            description={t('请先扫码绑定该中心后，再使用扫一扫确认网页端登录。', 'Bind this device to the center first, then scan to approve web login.')}
            compact
          />
        </div>
      )}
      {boundOrigin && !sameCenter && (
        <div className="hst-row-static">
          <ErrorNotice
            tone="danger"
            title={t('中心地址不一致', 'Different center')}
            description={t(`此登录二维码属于其他中心（${login.centerHost}），与本机当前绑定的中心（${boundHost || boundOrigin}）不一致。`,
              `This QR code belongs to another center (${login.centerHost}), not your bound center (${boundHost || boundOrigin}).`)}
            compact
          />
        </div>
      )}
      {sameCenter && !centerConn.ready && (
        <div className="hst-row-static">
          <ErrorNotice
            tone="warning"
            title={t('中心连接未就绪', 'Center not connected')}
            description={t('当前与中心的连接尚未就绪，请等待重连后再确认登录。', 'Connection to the center is not ready yet. Wait for reconnect and try again.')}
            compact
          />
        </div>
      )}
      <div className="hst-actions">
        <button type="button" className="hst-btn" disabled={submitting} onClick={onCancel}>
          {t('取消', 'Cancel')}
        </button>
        <button type="button" className="hst-btn is-primary" disabled={!canApprove || submitting} onClick={approve}>
          <LabelStack
            active={submitting ? t('确认中…', 'Confirming…') : t('确认登录', 'Confirm Login')}
            labels={[t('确认中…', 'Confirming…'), t('确认登录', 'Confirm Login')]}
          />
        </button>
      </div>
    </>
  );
}

/** 中心连接状态提示：重连态改用 F2 状态与常驻固定槽，错误走 F1 NoticeLayer，绝不在按钮上方插入文档流横幅。 */
function CenterStatusNotice() {
  const t = useText();
  const centerConn = useCenterConnection();
  const connPhase = useConnectionPhaseContext();
  const { notify, dismiss } = useNotice();
  const isReconnecting = connPhase.phase === 'connecting';

  useEffect(() => {
    if (!centerConn.error) {
      dismiss('center:connection-error');
      return;
    }
    notify({
      id: 'center:connection-error',
      tone: 'error',
      title: centerConn.error,
      detail: centerConn.errorCode || undefined,
    });
  }, [centerConn.error, centerConn.errorCode, notify, dismiss]);

  return (
    <ReservedSlot
      minHeight={20}
      align="center"
      className="ob-conn-status-slot"
      role="status"
      aria-live="polite"
      contentKey={isReconnecting ? 'reconnecting' : 'idle'}
    >
      {isReconnecting ? (
        <span className="ob-status-text">
          <Loader2 size={13} className="ob-spin" aria-hidden="true" />
          <span>{t('正在重连…', 'Reconnecting…')}</span>
        </span>
      ) : null}
    </ReservedSlot>
  );
}

/** 配对/修复警告列表：标题仅展示 message，错误码收纳进 ErrorNotice 的 detail 折叠区。 */
function PairWarnings({ warnings }: { warnings?: PairCenterResult['warnings'] }) {
  if (!warnings?.length) return null;
  return (
    <>
      {warnings.map((warning, index) => {
        const parsed = splitErrorCode(warning);
        const title = parsed.message || parsed.code || '';
        if (!title) return null;
        return (
          <div className="hst-row-static" key={index}>
            <ErrorNotice
              tone="warning"
              title={title}
              detail={parsed.code && parsed.code !== title ? parsed.code : undefined}
              compact
            />
          </div>
        );
      })}
    </>
  );
}

/** 手工令牌连接：沿用设置页原有表单（URL + 设备标识 + 客户端令牌 + 重连/清除）。 */
function ManualCenterConnect({ onDone }: { onDone?: () => void }) {
  const t = useText();
  const centerConn = useCenterConnection();
  return (
    <>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('中心地址', 'Center URL')}</span>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="hst-input"
          disabled={centerConn.busy}
          value={centerConn.url}
          onChange={e => centerConn.setUrl(e.target.value)}
          placeholder="https://center.example.com"
        />
      </label>

      <label className="hst-input-row">
        <span className="hst-input-label">{t('设备标识', 'Device ID')}</span>
        <input
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
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

      <CenterStatusNotice />

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
          <LabelStack
            active={
              centerConn.preparing
                ? t('正在启动本机节点…', 'Starting Host…')
                : centerConn.busy
                  ? t('连接中…', 'Connecting…')
                  : t('连接中心', 'Connect Center')
            }
            labels={[
              t('正在启动本机节点…', 'Starting Host…'),
              t('连接中…', 'Connecting…'),
              t('连接中心', 'Connect Center'),
            ]}
          />
        </button>
      </div>
    </>
  );
}

/** 配对/修复结果视图：所有者密码与配对码两种配对方式共用。 */
function PairResultView({ result, onChange, onEdit }: {
  result: PairCenterResult;
  onChange: (next: PairCenterResult) => void;
  onEdit: () => void;
}) {
  const t = useText();
  const centerConn = useCenterConnection();
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
      <PairWarnings warnings={result.warnings} />
      <CenterStatusNotice />
      <div className="hst-actions">
        <button type="button" className="hst-btn is-ghost" onClick={onEdit}>
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
                repaired => { if (repaired) onChange(repaired); },
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
          mobileHaptic('confirm');
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
    return <PairResultView result={result} onChange={setResult} onEdit={() => setResult(undefined)} />;
  }

  // force 只在本机已有保存绑定、或原生明确 ALREADY_CONFIGURED 时出现；它替换的是本机所存绑定。
  const showForce = Boolean(centerConn.saved?.url) || suggestForce;
  return (
    <form onSubmit={submit}>
      <label className="hst-input-row">
        <span className="hst-input-label">{t('中心地址', 'Center URL')}</span>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="hst-input"
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
      <label className="hst-input-row ob-textarea-row">
        <span className="hst-input-label">{t('CA 证书', 'CA PEM')}</span>
        <textarea
          className="ob-pem"
          rows={4}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={centerConn.busy}
          value={centerConn.ca}
          onChange={e => centerConn.setCa(e.target.value)}
          placeholder={t('自签名证书 PEM（选填）', 'Optional self-signed PEM')}
        />
      </label>
      {showForce && (
        <label className="hst-row-static ob-check-row">
          <span className="ob-check-hit">
            <input
              type="checkbox"
              className="ob-check"
              disabled={centerConn.busy}
              checked={force}
              onChange={e => setForce(e.target.checked)}
            />
          </span>
          <span>{t('替换本机已保存的绑定', 'Replace the binding saved on this device')}</span>
        </label>
      )}
      <CenterStatusNotice />
      <div className="hst-actions">
        <button
          type="submit"
          className="hst-btn is-primary"
          disabled={centerConn.busy || !centerConn.url.trim() || !password}
        >
          <LabelStack
            active={centerConn.busy ? t('配对中…', 'Pairing…') : t('配对并连接', 'Pair & Connect')}
            labels={[t('配对中…', 'Pairing…'), t('配对并连接', 'Pair & Connect')]}
          />
        </button>
      </div>
    </form>
  );
}

/**
 * 配对码配对：扫描中心管理页「添加设备」里的二维码，或粘贴配对码；识别出完整的码就自动配对。
 * 地址、一次性密钥与私有 CA 都在码里，由原生解码——这里只持有用户粘贴/扫到的原文，成功即清除。
 * 失败在本表单里按原生给的说明展示（见 CenterGate.pairWithCode），不走通用归类。
 */
function PairCodeForm({
  onDone,
  initialCode,
  initialFailure,
}: {
  onDone?: () => void;
  initialCode?: string;
  initialFailure?: { code: string; message: string };
}) {
  const t = useText();
  const centerConn = useCenterConnection();
  const { notify, dismiss } = useNotice();
  const [text, setText] = useState(() => {
    if (!initialCode) return '';
    return readPaste(initialCode).kind === 'web-login' ? '' : initialCode;
  });
  const [webLogin, setWebLogin] = useState<ScannedWebLogin | null>(() => {
    if (!initialCode) return null;
    const parsed = readPaste(initialCode);
    return parsed.kind === 'web-login' ? parsed : null;
  });
  const [force, setForce] = useState(false);
  const [suggestForce, setSuggestForce] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | undefined>(initialFailure);
  const [result, setResult] = useState<PairCenterResult>();
  const autoSubmittedInitialRef = useRef(false);
  const paste = readPaste(text);
  const working = centerConn.busy || scanning;
  // 本机已有绑定时（或原生刚报 ALREADY_CONFIGURED），替换必须由用户明确勾选：此时不自动提交。
  const showForce = Boolean(centerConn.saved?.url) || suggestForce;
  const mayAutoSubmit = !showForce || force;

  const submit = useCallback((code: string) => {
    setFailure(undefined);
    void centerConn.pairWithCode(code, { force }).then(
      done => {
        if (!done) return;
        mobileHaptic('confirm');
        // 配对码用过即废，登记成功后不再保留在输入框里。
        setText('');
        setForce(false);
        setSuggestForce(false);
        setResult(done);
        // 已请求连接且无警告时交回上层收尾；等待连接/有警告时保留结果视图供用户处理。
        if (done.connectionRequested && !(done.warnings && done.warnings.length)) onDone?.();
      },
      error => {
        const info = failureOf(error);
        if (info.code === 'ALREADY_CONFIGURED') setSuggestForce(true);
        setFailure(info);
      },
    );
  }, [centerConn, force, onDone]);

  useEffect(() => {
    if (autoSubmittedInitialRef.current || !initialCode || webLogin) return;
    autoSubmittedInitialRef.current = true;
    const parsed = readPaste(initialCode);
    if (parsed.kind === 'code' && mayAutoSubmit && !working) {
      submit(initialCode);
    }
  }, [initialCode, webLogin, mayAutoSubmit, working, submit]);

  const onPaste = (value: string) => {
    const parsed = readPaste(value);
    if (parsed.kind === 'web-login') {
      setText('');
      setFailure(undefined);
      setWebLogin(parsed);
      return;
    }
    setWebLogin(null);
    setText(value);
    setFailure(undefined);
    if (parsed.kind === 'code' && !working && mayAutoSubmit) submit(value);
  };

  const scan = () => {
    setFailure(undefined);
    setScanning(true);
    void scanPairingCode()
      .then(
        scanned => {
          if (!scanned.text) return; // 用户返回/取消：什么都不做
          const parsed = readPaste(scanned.text);
          if (parsed.kind === 'web-login') {
            setText('');
            setWebLogin(parsed);
            return;
          }
          setWebLogin(null);
          setText(scanned.text);
          if (parsed.kind !== 'code') return; // 提示行会说明这不是配对码
          if (mayAutoSubmit) submit(scanned.text);
        },
        error => setFailure(failureOf(error)),
      )
      .finally(() => setScanning(false));
  };

  useEffect(() => {
    if (!failure) {
      dismiss('onboarding:pair-code-failure');
      return;
    }
    const titlePrefix = failure.code === 'CAMERA_DENIED'
      ? t('无法扫码', 'Cannot scan')
      : t('配对失败', 'Pairing failed');
    const desc = failureText(failure, t);
    notify({
      id: 'onboarding:pair-code-failure',
      tone: 'error',
      title: desc ? `${titlePrefix} — ${desc}` : titlePrefix,
      detail: failure.code || undefined,
      sticky: true,
    });
  }, [failure, t, notify, dismiss]);

  useEffect(() => {
    return () => {
      dismiss('onboarding:pair-code-failure');
    };
  }, [dismiss]);

  if (webLogin) {
    return (
      <WebLoginConfirmView
        login={webLogin}
        onCancel={() => {
          setWebLogin(null);
          setText('');
        }}
        onDone={() => {
          setWebLogin(null);
          setText('');
          onDone?.();
        }}
      />
    );
  }

  if (result) {
    return <PairResultView result={result} onChange={setResult} onEdit={() => setResult(undefined)} />;
  }

  const hint = paste.kind === 'code'
    ? (mayAutoSubmit
      ? t(`将连接到 ${paste.centerHost}`, `Will connect to ${paste.centerHost}`)
      : t('本机已有绑定：勾选“替换本机已保存的绑定”后点击配对', 'This device is already bound: tick “Replace the binding saved on this device”, then pair'))
    : paste.kind === 'not-code'
      ? t('这不是配对码或网页登录码。请在中心管理页获取配对码或登录二维码。', 'That is not a pairing or web-login code. Get one from Center Admin.')
      : paste.kind === 'damaged'
        ? t('配对码不完整或已损坏，请重新复制完整的配对码。', 'The pairing code is incomplete or damaged. Copy the whole code again.')
        : paste.kind === 'unsupported'
          ? t('此配对码来自更新版本的中心，请先更新 pibot。', 'This pairing code comes from a newer center. Update pibot first.')
          : '';

  const failureHelperText = failure
    ? (failure.code === 'CAMERA_DENIED' ? t('无法扫码', 'Cannot scan') : t('配对失败', 'Pairing failed'))
    : '';
  const helperText = hint || failureHelperText;
  const helperTone: 'neutral' | 'warn' | 'error' = hint
    ? (paste.kind !== 'code' && paste.kind !== 'empty' ? 'warn' : 'neutral')
    : failure
      ? 'error'
      : 'neutral';
  const helperKey = hint ? `hint:${paste.kind}:${mayAutoSubmit ? 'auto' : 'force'}` : failure ? `err:${failure.code}` : 'empty';

  return (
    <>
      <div className="hst-row-static">
        <span className="ob-note">
          {t('在中心管理页的「设备与 Bot」点击「添加设备」扫描二维码绑定，或扫描网页端登录二维码；也可粘贴配对码。',
            'Scan a device pairing QR from Center Admin → Devices, scan a web login QR, or paste a pairing code below.')}
        </span>
      </div>
      <div className="hst-actions">
        <button type="button" className="hst-btn is-primary" disabled={working} onClick={scan}>
          <ScanLine size={16} aria-hidden="true" />
          <LabelStack
            active={scanning ? t('正在扫码…', 'Scanning…') : t('扫码配对 / 登录', 'Scan QR')}
            labels={[t('正在扫码…', 'Scanning…'), t('扫码配对 / 登录', 'Scan QR')]}
          />
        </button>
      </div>
      <div className="hst-row-static ob-code-row">
        <textarea
          className="ob-code"
          rows={3}
          value={text}
          disabled={centerConn.busy}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={t('或在这里粘贴配对码', 'Or paste the pairing code here')}
          onChange={event => onPaste(event.target.value)}
        />
        <ReservedSlot
          minHeight={20}
          align="center"
          className="ob-helper-slot"
          role="status"
          aria-live="polite"
          contentKey={helperKey}
        >
          {helperText ? (
            <span className={`ob-note${helperTone === 'error' ? ' is-error' : helperTone === 'warn' ? ' is-warn' : ''}`}>
              {helperText}
            </span>
          ) : null}
        </ReservedSlot>
      </div>
      {showForce && (
        <label className="hst-row-static ob-check-row">
          <span className="ob-check-hit">
            <input
              type="checkbox"
              className="ob-check"
              disabled={working}
              checked={force}
              onChange={event => setForce(event.target.checked)}
            />
          </span>
          <span>{t('替换本机已保存的绑定', 'Replace the binding saved on this device')}</span>
        </label>
      )}
      <div className="hst-actions">
        <button
          type="button"
          className="hst-btn"
          disabled={working || paste.kind !== 'code' || !mayAutoSubmit}
          onClick={() => submit(text)}
        >
          <LabelStack
            active={centerConn.busy ? t('配对中…', 'Pairing…') : t('配对并连接', 'Pair & Connect')}
            labels={[t('配对中…', 'Pairing…'), t('配对并连接', 'Pair & Connect')]}
          />
        </button>
      </div>
    </>
  );
}

/**
 * 原生/桥错误 → {code, message}：code 用于区分可恢复原因，message 是原生给出的可操作说明。
 * 桥层为日志把 message 拼成 `CODE: 说明`，对用户没有意义，这里经 splitErrorCode 拆分。
 */
function failureOf(error: unknown): { code: string; message: string } {
  const parsed = splitErrorCode(error);
  return {
    code: parsed.code ?? '',
    message: parsed.message,
  };
}

type Translate = (zh: string, en: string) => string;

/**
 * 原生给的说明是中文：已知错误码按界面语言改用这里的文案，其余（带细节的 CENTER_ERROR、凭据/参数错误等）
 * 原样显示原生说明。码 → 文案与原生 CenterPairing / PairingCode 一一对应，改一处要改两处。
 */
function failureText(failure: { code: string; message: string }, t: Translate): string {
  switch (failure.code) {
    case 'CAMERA_DENIED':
      return t('没有相机权限。请在系统设置里允许相机，或直接粘贴配对码', 'No camera permission. Allow the camera in system settings, or paste the pairing code instead.');
    case 'NOT_A_PAIRING_CODE':
      return t('这不是配对码。请在中心管理页的「设备与 Bot」点击「添加设备」获取', 'That is not a pairing code. Get one from “Add device” on the center’s Devices page.');
    case 'INVALID_PAIRING_CODE':
      return t('配对码不完整或已损坏，请重新复制完整的配对码', 'The pairing code is incomplete or damaged. Copy the whole code again.');
    case 'UNSUPPORTED_PAIRING_CODE':
      return t('此配对码来自更新版本的中心，请先更新 pibot', 'This pairing code comes from a newer center. Update pibot first.');
    case 'PAIRING_CODE_INVALID':
      return t('配对码无效，请在中心重新生成', 'The pairing code is not valid. Generate a new one on the center.');
    case 'PAIRING_CODE_USED':
      return t('配对码已被使用，请在中心重新生成', 'The pairing code has already been used. Generate a new one on the center.');
    case 'PAIRING_CODE_EXPIRED':
      return t('配对码已过期（10 分钟有效），请在中心重新生成', 'The pairing code has expired (it is valid for 10 minutes). Generate a new one on the center.');
    case 'PAIRING_CODE_REVOKED':
      return t('配对码已作废：中心的「添加设备」窗口被关闭了。复制或扫描后请保持该窗口打开，直到配对完成；需要的话重新生成',
        'The pairing code was voided because the “Add device” window on the center was closed. Keep that window open until pairing finishes, and generate a new code if needed.');
    case 'PAIRING_CODE_DEVICE_MISMATCH':
      return t('这个配对码是为另一台设备生成的，不能用于本机。请在中心为本机重新生成', 'This pairing code was issued for a different device and cannot be used here. Generate one for this phone on the center.');
    case 'DEVICE_ALREADY_REGISTERED':
      return t('中心上已有这台设备的记录，新配对码不能顶替它。请所有者在管理页「设备与 Bot」里点该设备的「重新配对」，使用生成的专属配对码',
        'The center already has a record for this device, and a new pairing code cannot replace it. The owner should click “Re-pair” on that device in the center’s Devices page and use the code it generates.');
    case 'CENTER_CERT_UNTRUSTED':
      return t('能连上中心，但本机不信任它的证书。中心使用自签或私有 CA 时，请所有者在管理页「添加设备」窗口保存私有 CA 后重新生成配对码；用所有者密码配对时，在 CA 证书栏填写它',
        'The center answered, but this phone does not trust its certificate. If the center uses a self-signed or private CA, the owner should save that CA in the center’s “Add device” window and generate a new pairing code; when pairing with the owner password, enter the CA in the CA PEM field.');
    case 'CENTER_UNREACHABLE':
      return t('无法连接中心', 'Cannot reach the center');
    case 'CENTER_UNSUPPORTED':
      return t('该中心版本尚不支持配对码，请升级中心，或改用所有者密码配对', 'This center does not support pairing codes yet. Upgrade the center, or pair with the owner password.');
    case 'RATE_LIMITED':
      return t('中心请求过于频繁，请稍后重试', 'The center is receiving too many requests. Try again shortly.');
    case 'ALREADY_CONFIGURED':
      return t('设备已绑定中心，勾选“替换本机已保存的绑定”后再配对', 'This device is already bound to a center. Tick “Replace the binding saved on this device”, then pair.');
    default:
      return failure.message || t('配对失败，请检查配对码后重试。', 'Pairing failed. Check the pairing code and try again.');
  }
}

/**
 * 中心连接卡：无论是否曾保存过连接，始终以扫码/粘贴配对码为主视图；
 * 所有者密码配对与手动令牌连接统一收进折叠的高级连接方式。
 */
export function OnboardingPanel({ onDone }: { onDone?: () => void }) {
  const t = useText();
  return (
    <>
      <PairCodeForm onDone={onDone} />
      <Disclosure title={t('高级连接方式', 'Advanced connection options')}>
        <Section title={t('所有者密码配对', 'Owner password pairing')} bare>
          <PairCenterForm onDone={onDone} />
        </Section>
        <Section title={t('手动令牌连接', 'Manual token connection')} bare>
          <ManualCenterConnect onDone={onDone} />
        </Section>
      </Disclosure>
    </>
  );
}

/** 快捷扫码按钮：同时支持网页端登录确认码（pibotlogin1.）与设备配对码（pibot1.）。 */
export function QuickQrScanButton({
  className = 'hst-btn',
  disabled = false,
  onPaired,
}: {
  className?: string;
  disabled?: boolean;
  onPaired?: () => void;
}) {
  const t = useText();
  const [scanning, setScanning] = useState(false);
  const [modalState, setModalState] = useState<
    | { kind: 'web-login'; login: ScannedWebLogin }
    | { kind: 'pair-code'; code?: string; failure?: { code: string; message: string } }
    | null
  >(null);

  const startScan = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (scanning || disabled) return;
    setScanning(true);
    void scanPairingCode()
      .then(
        scanned => {
          if (!scanned.text) return;
          const parsed = readPaste(scanned.text);
          if (parsed.kind === 'web-login') {
            setModalState({ kind: 'web-login', login: parsed });
          } else {
            setModalState({ kind: 'pair-code', code: scanned.text });
          }
        },
        error => {
          setModalState({ kind: 'pair-code', failure: failureOf(error) });
        },
      )
      .finally(() => setScanning(false));
  };

  return (
    <>
      <button type="button" className={className} disabled={disabled || scanning} onClick={startScan}>
        <ScanLine size={15} aria-hidden="true" />
        <LabelStack
          active={scanning ? t('扫码中…', 'Scanning…') : t('扫一扫', 'Scan QR')}
          labels={[t('扫码中…', 'Scanning…'), t('扫一扫', 'Scan QR')]}
        />
      </button>
      {modalState && (
        <SettingsSheet
          title={modalState.kind === 'web-login' ? t('网页端登录确认', 'Web Login Confirmation') : t('扫码连接', 'Scan QR Code')}
          onClose={() => setModalState(null)}
        >
          <Section>
            {modalState.kind === 'web-login' ? (
              <WebLoginConfirmView
                login={modalState.login}
                onCancel={() => setModalState(null)}
                onDone={() => setModalState(null)}
              />
            ) : (
              <PairCodeForm
                initialCode={modalState.code}
                initialFailure={modalState.failure}
                onDone={() => {
                  setModalState(null);
                  onPaired?.();
                }}
              />
            )}
          </Section>
        </SettingsSheet>
      )}
    </>
  );
}

function hostPhaseLabel(phase: HostSnapshot['phase'], t: Translate): string {
  switch (phase) {
    case 'running':
      return t('运行中', 'Running');
    case 'starting':
      return t('启动中', 'Starting');
    case 'stopping':
      return t('停止中', 'Stopping');
    case 'failed':
      return t('失败', 'Failed');
    case 'stopped':
      return t('已停止', 'Stopped');
  }
}

/** 通知/后台电池/Shizuku/本机 Host 真实状态区：按钮仅发起系统动作，回到应用后重查。 */
export function OnboardingPermissions() {
  const t = useText();
  const centerConn = useCenterConnection();
  const { notify, dismiss } = useNotice();
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
        setActionError(
          errorText(error) ||
            t('无法打开系统权限设置，请稍后重试或在系统设置中手动开启。', 'Could not open system permission settings. Try again or enable it in OS settings.'),
        );
      },
    ).finally(() => {
      if (mounted.current && seq === actionSeq.current) setPending(null);
    });
  };

  // 已存绑定的失败恢复入口：不自动重试、不把 requested 当就绪；错误走同一条 Notice 通道。
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
          setActionError(
            errorText(error) ||
              t('修复本机节点绑定失败，请确认中心在线且凭据有效后重试。', 'Could not repair local host binding. Check that the center is reachable and credentials are valid, then retry.'),
          );
        }
      },
    ).finally(() => {
      if (mounted.current && seq === actionSeq.current) setPending(null);
    });
  };

  const shizuku:
    | {
        tone: 'neutral' | 'warning' | 'success';
        label: string;
        detail: string;
        action?: OnboardingActionName;
        button?: string;
      }
    | undefined = status
    ? !status.shizukuInstalled
      ? {
          tone: 'neutral',
          label: t('未安装', 'Not installed'),
          detail: t('可选增强能力；安装并启动 Shizuku 后可用于系统级操作', 'Optional; install and start Shizuku for system-level automation'),
          action: 'shizuku-manager',
          button: t('打开管理器', 'Open manager'),
        }
      : !status.shizukuRunning
        ? {
            tone: 'warning',
            label: t('未运行', 'Not running'),
            detail: t('重启手机后需在 Shizuku 管理器中重新启动服务', 'After a reboot, start the service again in Shizuku manager'),
            action: 'shizuku-manager',
            button: t('启动服务', 'Start service'),
          }
        : !status.shizukuGranted
          ? {
              tone: 'warning',
              label: t('未授权', 'Not granted'),
              detail: t('向 PiBot 授予 Shizuku 权限以启用对应功能', 'Grant Shizuku permission to PiBot to enable these features'),
              action: 'shizuku-permission',
              button: t('授予权限', 'Grant access'),
            }
          : {
              tone: 'success',
              label: t('已授权', 'Granted'),
              detail: t('Shizuku 服务正在运行并已授权', 'Shizuku service is running and authorized'),
            }
    : undefined;

  useEffect(() => {
    if (!actionError) {
      dismiss('onboarding:permissions-action-error');
      return;
    }
    notify({
      id: 'onboarding:permissions-action-error',
      tone: 'error',
      title: actionError,
    });
  }, [actionError, notify, dismiss]);

  useEffect(() => {
    if (!statusFailed || !status) {
      dismiss('onboarding:permissions-stale');
      return;
    }
    notify({
      id: 'onboarding:permissions-stale',
      tone: 'warning',
      title: t('权限状态刷新失败，当前显示上次结果，请重新检查。', 'Could not refresh permissions — showing previous status. Recheck to update.'),
      action: { label: t('重新检查', 'Recheck'), onClick: refresh },
    });
  }, [statusFailed, status, refresh, t, notify, dismiss]);

  useEffect(() => {
    return () => {
      dismiss('onboarding:permissions-action-error');
      dismiss('onboarding:permissions-stale');
    };
  }, [dismiss]);

  const hostPhaseLabels = [
    t('运行中', 'Running'),
    t('启动中', 'Starting'),
    t('停止中', 'Stopping'),
    t('失败', 'Failed'),
    t('已停止', 'Stopped'),
  ];

  const localHostSubtitle = !host
    ? <Skeleton variant="text" width={110} height={12} inline />
    : host.phase === 'failed'
      ? (host.deviceId
        ? t(`${host.deviceId} · 节点启动失败，请检查中心连接或修复绑定`, `${host.deviceId} · Failed to start; check center or repair binding`)
        : t('节点启动失败，请检查中心连接或修复绑定', 'Failed to start; check center or repair binding'))
      : host.restartRequired
        ? (host.deviceId
          ? t(`${host.deviceId} · 配置已更新，请重启客户端生效`, `${host.deviceId} · Restart client to apply updated config`)
          : t('配置已更新，请重启客户端生效', 'Restart client to apply updated config'))
        : (host.deviceId || t('未分配设备标识', 'No device ID assigned'));

  return (
    <Section
      title={t('本机权限与节点状态', 'Permissions & local host')}
      action={
        <button type="button" className="bs-link" onClick={refresh}>
          {t('刷新状态', 'Refresh status')}
        </button>
      }
      hint={t('各项权限只影响对应功能，未开启不影响普通对话；从系统设置返回后状态会自动更新。',
        'Permissions only affect their own features — chat still works without them. Status updates when you return from system settings.')}
    >
      {statusFailed && !status ? (
        <Row
          icon={<ShieldCheck />}
          title={t('无法读取本机权限状态', 'Could not read device permissions')}
          subtitle={t('系统权限服务暂时未响应，请点击重新检查，或前往系统设置核对应用权限。',
            'System permission service did not respond. Recheck now or verify permissions in OS settings.')}
          trailing={
            <span className="ob-perm-trailing is-compact">
              <button type="button" className="hst-btn" onClick={refresh}>
                {t('重新检查', 'Recheck')}
              </button>
            </span>
          }
        />
      ) : (
        <>
          <Row
            icon={<Bell />}
            title={
              <span className="hst-entry-label">
                <span>{t('通知', 'Notifications')}</span>
                {status ? (
                  <Badge tone={status.notificationsGranted ? 'success' : 'warning'}>
                    {status.notificationsGranted ? t('已开启', 'On') : t('未开启', 'Off')}
                  </Badge>
                ) : null}
              </span>
            }
            subtitle={
              <ReservedSlot minHeight={18} inline align="center" className="ob-perm-sub">
                {!status ? (
                  <Skeleton variant="text" width={96} height={12} inline />
                ) : status.notificationsGranted ? (
                  t('已允许发送消息与任务提醒', 'Message and task alerts are enabled')
                ) : (
                  t('开启后可及时接收消息与任务提醒', 'Enable to receive message and task alerts')
                )}
              </ReservedSlot>
            }
            trailing={
              !status ? (
                <span className="ob-perm-trailing is-compact">
                  <Skeleton variant="pill" width={64} height={24} />
                </span>
              ) : !status.notificationsGranted ? (
                <span className="ob-perm-trailing is-compact">
                  <button
                    type="button"
                    className="hst-btn"
                    disabled={pending !== null}
                    onClick={() => run('notifications')}
                  >
                    {t('开启通知', 'Enable alerts')}
                  </button>
                </span>
              ) : undefined
            }
          />
          <Row
            icon={<BatteryCharging />}
            title={
              <span className="hst-entry-label">
                <span>{t('后台运行', 'Background run')}</span>
                {status ? (
                  <Badge tone={status.batteryUnrestricted ? 'success' : 'warning'}>
                    {status.batteryUnrestricted ? t('不受限制', 'Unrestricted') : t('受限', 'Restricted')}
                  </Badge>
                ) : null}
              </span>
            }
            subtitle={
              <ReservedSlot minHeight={18} inline align="center" className="ob-perm-sub">
                {!status ? (
                  <Skeleton variant="text" width={110} height={12} inline />
                ) : status.batteryUnrestricted ? (
                  t('已豁免电池优化，后台连接可保持稳定', 'Exempt from battery optimization for steady background sync')
                ) : (
                  t('系统电池优化可能中断后台连接，请设为不受限制', 'Battery optimization may pause background sync; set to unrestricted')
                )}
              </ReservedSlot>
            }
            trailing={
              !status ? (
                <span className="ob-perm-trailing is-compact">
                  <Skeleton variant="pill" width={72} height={24} />
                </span>
              ) : !status.batteryUnrestricted ? (
                <span className="ob-perm-trailing is-compact">
                  <button
                    type="button"
                    className="hst-btn"
                    disabled={pending !== null}
                    onClick={() => run('battery-settings')}
                  >
                    {t('电池设置', 'Battery settings')}
                  </button>
                </span>
              ) : undefined
            }
          />
          <Row
            icon={<ShieldCheck />}
            title={
              <span className="hst-entry-label">
                <span>Shizuku</span>
                {shizuku ? <Badge tone={shizuku.tone}>{shizuku.label}</Badge> : null}
              </span>
            }
            subtitle={
              <ReservedSlot minHeight={18} inline align="center" className="ob-perm-sub">
                {!shizuku ? <Skeleton variant="text" width={110} height={12} inline /> : shizuku.detail}
              </ReservedSlot>
            }
            trailing={
              !shizuku ? (
                <span className="ob-perm-trailing is-compact">
                  <Skeleton variant="pill" width={64} height={24} />
                </span>
              ) : shizuku.action ? (
                <span className="ob-perm-trailing is-compact">
                  <button
                    type="button"
                    className="hst-btn"
                    disabled={pending !== null}
                    onClick={() => run(shizuku.action!)}
                  >
                    {shizuku.button}
                  </button>
                </span>
              ) : undefined
            }
          />
          <Row
            icon={<Server />}
            title={
              <span className="hst-entry-label">
                <span>{t('本机节点', 'Local host')}</span>
                {host ? (
                  host.phase === 'failed' ? (
                    <Badge tone="danger">{hostPhaseLabel(host.phase, t)}</Badge>
                  ) : host.restartRequired ? (
                    <Badge tone="warning">{t('需重启', 'Restart needed')}</Badge>
                  ) : (
                    <Badge tone={host.phase === 'running' ? 'success' : 'neutral'}>
                      <LabelStack active={hostPhaseLabel(host.phase, t)} labels={hostPhaseLabels} />
                    </Badge>
                  )
                ) : null}
              </span>
            }
            subtitle={
              <ReservedSlot minHeight={18} inline align="center" className="ob-perm-sub">
                {localHostSubtitle}
              </ReservedSlot>
            }
            trailing={
              !host ? (
                <span className="ob-perm-trailing is-compact">
                  <Skeleton variant="pill" width={64} height={24} />
                </span>
              ) : centerConn.hasSavedCenter ? (
                <span className="ob-perm-trailing is-compact">
                  {/* 客户端 ready 也可能 Host 保存失败：有已存绑定即可显式修复。 */}
                  <button
                    type="button"
                    className="hst-btn"
                    disabled={!centerConn.saved?.url || pending !== null || centerConn.busy}
                    onClick={repair}
                  >
                    <LabelStack
                      active={pending === 'repair' ? t('修复中…', 'Repairing…') : t('修复绑定', 'Repair binding')}
                      labels={[t('修复中…', 'Repairing…'), t('修复绑定', 'Repair binding')]}
                    />
                  </button>
                </span>
              ) : undefined
            }
          />
          {repairResult && !repairResult.hostConfigured && (
            <div className="hst-row-static">
              <span className="ob-note">
                {t('本机节点绑定尚未完成，请确认中心在线后再次点击「修复绑定」重试。',
                  'Local host binding is still incomplete. Verify the center is reachable, then tap Repair binding again.')}
              </span>
            </div>
          )}
          {repairResult && repairResult.hostConfigured && !repairResult.connectionRequested && (
            <div className="hst-row-static">
              <span className="ob-note">
                {t('已保存本机绑定，等待建立连接。可返回「中心连接」查看或手动重连。',
                  'Local binding saved; waiting to connect. Open Center connection to check or reconnect.')}
              </span>
            </div>
          )}
          <PairWarnings warnings={repairResult?.warnings} />
        </>
      )}
    </Section>
  );
}
