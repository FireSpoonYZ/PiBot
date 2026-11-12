// C7 Android 首启引导 UI：owner 密码一键配对 + 通知/后台/Shizuku 真实状态与动作。
// 密码只在本组件内存，提交即清；token 不离开原生。沿用 .hst-/.bs- 既有原语，少量 .ob- 补充样式。
// 配对结果只表示“已登记/已请求连接”，就绪与否始终由 CenterGate 的 center_status/broker 轮询判定。
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BatteryCharging, Bell, ScanLine, Server, ShieldCheck } from 'lucide-react';
import { useCenterConnection } from './CenterGate';
import { onboardingAction, onboardingStatus, scanPairingCode } from './tauri-host';
import { BotHost, type HostSnapshot, type OnboardingActionName, type OnboardingStatus, type PairCenterResult } from './index';
import { Badge, Disclosure, Row, Section, StatusLine } from '../bot-settings/primitives';
import { readPaste as readPairingCode } from '../pairingCode';
import { ErrorNotice, errorText, useText } from '../ui';
import './onboarding.css';

/** 手机上的 loopback 是手机自己，不可能是中心：http 一律不收，与原生 PairingCode.parse 保持一致。 */
const readPaste = (text: string) => readPairingCode(text, { allowLoopbackHttp: false });

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
 * 配对码配对：扫描中心管理页「添加设备」里的二维码，或粘贴配对码；识别出完整的码就自动配对。
 * 地址、一次性密钥与私有 CA 都在码里，由原生解码——这里只持有用户粘贴/扫到的原文，成功即清除。
 * 失败在本表单里按原生给的说明展示（见 CenterGate.pairWithCode），不走通用归类。
 */
function PairCodeForm({ onDone }: { onDone?: () => void }) {
  const t = useText();
  const centerConn = useCenterConnection();
  const [text, setText] = useState('');
  const [force, setForce] = useState(false);
  const [suggestForce, setSuggestForce] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string }>();
  const [result, setResult] = useState<PairCenterResult>();
  const paste = readPaste(text);
  const working = centerConn.busy || scanning;
  // 本机已有绑定时（或原生刚报 ALREADY_CONFIGURED），替换必须由用户明确勾选：此时不自动提交。
  const showForce = Boolean(centerConn.saved?.url) || suggestForce;
  const mayAutoSubmit = !showForce || force;

  const submit = (code: string) => {
    setFailure(undefined);
    void centerConn.pairWithCode(code, { force }).then(
      done => {
        if (!done) return;
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
  };

  const onPaste = (value: string) => {
    setText(value);
    setFailure(undefined);
    if (readPaste(value).kind === 'code' && !working && mayAutoSubmit) submit(value);
  };

  const scan = () => {
    setFailure(undefined);
    setScanning(true);
    void scanPairingCode()
      .then(
        scanned => {
          if (!scanned.text) return; // 用户返回/取消：什么都不做
          setText(scanned.text);
          if (readPaste(scanned.text).kind !== 'code') return; // 提示行会说明这不是配对码
          if (mayAutoSubmit) submit(scanned.text);
        },
        error => setFailure(failureOf(error)),
      )
      .finally(() => setScanning(false));
  };

  if (result) {
    return <PairResultView result={result} onChange={setResult} onEdit={() => setResult(undefined)} />;
  }

  const hint = paste.kind === 'code'
    ? (mayAutoSubmit
      ? t(`将连接到 ${paste.centerHost}`, `Will connect to ${paste.centerHost}`)
      : t('本机已有绑定：勾选“替换本机已保存的绑定”后点击配对', 'This device is already bound: tick “Replace the binding saved on this device”, then pair'))
    : paste.kind === 'not-code'
      ? t('这不是配对码。请在中心管理页的「设备与 Bot」点击「添加设备」获取。', 'That is not a pairing code. Get one from “Add device” on the center’s Devices page.')
      : paste.kind === 'damaged'
        ? t('配对码不完整或已损坏，请重新复制完整的配对码。', 'The pairing code is incomplete or damaged. Copy the whole code again.')
        : paste.kind === 'unsupported'
          ? t('此配对码来自更新版本的中心，请先更新 pibot。', 'This pairing code comes from a newer center. Update pibot first.')
          : '';

  return (
    <>
      <div className="hst-row-static">
        <span className="ob-note">
          {t('在中心管理页的「设备与 Bot」点击「添加设备」，用本机扫描二维码；也可以复制配对码粘贴到下面。',
            'On the center’s Devices page click “Add device”, then scan the QR code with this phone, or paste the pairing code below.')}
        </span>
      </div>
      <div className="hst-actions">
        <button type="button" className="hst-btn is-primary" disabled={working} onClick={scan}>
          <ScanLine size={16} aria-hidden="true" />
          {scanning ? t('正在扫码…', 'Scanning…') : t('扫码配对', 'Scan to Pair')}
        </button>
      </div>
      <div className="hst-row-static">
        <textarea
          className="ob-code"
          rows={3}
          value={text}
          disabled={centerConn.busy}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder={t('或在这里粘贴配对码', 'Or paste the pairing code here')}
          onChange={event => onPaste(event.target.value)}
        />
      </div>
      {hint && (
        <div className="hst-row-static">
          <span className={`ob-note${paste.kind !== 'code' && paste.kind !== 'empty' ? ' is-warn' : ''}`}>{hint}</span>
        </div>
      )}
      {showForce && (
        <label className="hst-row-static ob-check-row">
          <input
            type="checkbox"
            className="ob-check"
            disabled={working}
            checked={force}
            onChange={event => setForce(event.target.checked)}
          />
          <span>{t('替换本机已保存的绑定', 'Replace the binding saved on this device')}</span>
        </label>
      )}
      {failure && (
        <div className="hst-row-static">
          <ErrorNotice
            tone="danger"
            title={failure.code === 'CAMERA_DENIED' ? t('无法扫码', 'Cannot scan') : t('配对失败', 'Pairing failed')}
            description={failureText(failure, t)}
            compact
            onDismiss={() => setFailure(undefined)}
          />
        </div>
      )}
      <div className="hst-actions">
        <button
          type="button"
          className="hst-btn is-primary"
          disabled={working || paste.kind !== 'code' || !mayAutoSubmit}
          onClick={() => submit(text)}
        >
          {centerConn.busy ? t('配对中…', 'Pairing…') : t('配对并连接', 'Pair & Connect')}
        </button>
      </div>
    </>
  );
}

/**
 * 原生/桥错误 → {code, message}：code 用于区分可恢复原因，message 是原生给出的可操作说明。
 * 桥层为日志把 message 拼成 `CODE: 说明`，对用户没有意义，这里去掉这个前缀。
 */
function failureOf(error: unknown): { code: string; message: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  let message = error instanceof Error && error.message
    ? error.message
    : typeof error === 'string' && error ? error : '配对失败，请检查配对码后重试。';
  if (code && message.startsWith(`${code}: `)) message = message.slice(code.length + 2);
  return { code, message };
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
      return t(
        '配对码已作废：中心的「添加设备」窗口被关闭了。复制或扫描后请保持该窗口打开，直到配对完成；需要的话重新生成',
        'The pairing code was voided because the “Add device” window on the center was closed. Keep that window open until pairing finishes, and generate a new code if needed.',
      );
    case 'PAIRING_CODE_DEVICE_MISMATCH':
      return t('这个配对码是为另一台设备生成的，不能用于本机。请在中心为本机重新生成', 'This pairing code was issued for a different device and cannot be used here. Generate one for this phone on the center.');
    case 'DEVICE_ALREADY_REGISTERED':
      return t(
        '中心上已有这台设备的记录，新配对码不能顶替它。请所有者在管理页「设备与 Bot」里点该设备的「重新配对」，使用生成的专属配对码',
        'The center already has a record for this device, and a new pairing code cannot replace it. The owner should click “Re-pair” on that device in the center’s Devices page and use the code it generates.',
      );
    case 'CENTER_CERT_UNTRUSTED':
      return t(
        '能连上中心，但本机不信任它的证书。中心使用自签或私有 CA 时，请所有者在管理页「添加设备」窗口保存私有 CA 后重新生成配对码；用所有者密码配对时，在 CA 证书栏填写它',
        'The center answered, but this phone does not trust its certificate. If the center uses a self-signed or private CA, the owner should save that CA in the center’s “Add device” window and generate a new pairing code; when pairing with the owner password, enter the CA in the CA PEM field.',
      );
    case 'CENTER_UNREACHABLE':
      return t('无法连接中心', 'Cannot reach the center');
    case 'CENTER_UNSUPPORTED':
      return t('该中心版本尚不支持配对码，请升级中心，或改用所有者密码配对', 'This center does not support pairing codes yet. Upgrade the center, or pair with the owner password.');
    case 'RATE_LIMITED':
      return t('中心请求过于频繁，请稍后重试', 'The center is receiving too many requests. Try again shortly.');
    case 'ALREADY_CONFIGURED':
      return t('设备已绑定中心，勾选“替换本机已保存的绑定”后再配对', 'This device is already bound to a center. Tick “Replace the binding saved on this device”, then pair.');
    default:
      return failure.message;
  }
}

/**
 * 中心连接卡：无已存凭据时默认配对码配对（旧版中心用的所有者密码、手工令牌收进折叠项），
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
      <Disclosure title={t('用配对码重新配对', 'Re-pair with a pairing code')}>
        <PairCodeForm onDone={onDone} />
      </Disclosure>
      <Disclosure title={t('用所有者密码重新配对', 'Re-pair with owner password')}>
        <PairCenterForm onDone={onDone} />
      </Disclosure>
    </>
  ) : (
    <>
      <PairCodeForm onDone={onDone} />
      <Disclosure title={t('其他连接方式：所有者密码（旧版中心）', 'Other ways: owner password (older centers)')}>
        <PairCenterForm onDone={onDone} />
      </Disclosure>
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
