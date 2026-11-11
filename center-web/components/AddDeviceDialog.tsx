import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import type { CreatePairingCodeResponse, PairingCaState } from '@e-launcher/center-contract';
import { api, CenterApiError } from '../api';
import { QrCode } from './QrCode';
import { SheetModal } from './SheetModal';

interface MintedCode {
  data: CreatePairingCodeResponse;
  /** Local receipt time: the countdown must not depend on the browser clock matching the center's. */
  receivedAt: number;
}

const AUTO_CLOSE_MS = 2200;
const failure = (error: unknown, fallback: string) => (error instanceof CenterApiError && error.code === 'CENTER_OFFLINE' ? '无法连接中心' : fallback);
const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function AddDeviceDialog({ open, target, onClose, onPaired }: {
  open: boolean;
  /** Set to re-pair one existing device; the code is then good for that device only. */
  target?: { deviceId: string; name: string };
  onClose: () => void;
  onPaired: (deviceName: string) => void;
}) {
  const targetId = target?.deviceId;
  const [code, setCode] = useState<MintedCode>();
  const [generation, setGeneration] = useState(0);
  const [paired, setPaired] = useState<{ name: string }>();
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [ca, setCa] = useState<PairingCaState>();
  const [caDraft, setCaDraft] = useState('');
  const [caBusy, setCaBusy] = useState(false);
  const [caError, setCaError] = useState('');
  const codeBox = useRef<HTMLTextAreaElement>(null);
  const pairedHandler = useRef(onPaired);
  pairedHandler.current = onPaired;

  // Mint on open and on every regeneration. The cleanup voids whatever this run minted, so
  // closing, regenerating and unmounting all retire the old code without separate paths.
  useEffect(() => {
    setCode(undefined);
    setPaired(undefined);
    setError('');
    setCopied(false);
    if (!open) return;
    let live = true;
    let mintedId: string | undefined;
    api.createPairingCode(targetId).then(
      minted => {
        mintedId = minted.id;
        if (live) {
          setNow(Date.now());
          setCode({ data: minted, receivedAt: Date.now() });
        } else {
          void api.revokePairingCode(minted.id).catch(() => {});
        }
      },
      reason => { if (live) setError(failure(reason, '生成配对码失败，请重试')); },
    );
    return () => {
      live = false;
      if (mintedId) void api.revokePairingCode(mintedId).catch(() => {});
    };
  }, [open, generation, targetId]);

  // Watch for the device to redeem the code.
  const codeId = code?.data.id;
  useEffect(() => {
    if (!codeId || paired) return;
    let live = true;
    const timer = setInterval(() => {
      api.getPairingCode(codeId).then(state => {
        if (!live || state.status !== 'redeemed') return;
        const name = state.device?.name ?? state.device?.deviceId ?? '';
        setPaired({ name });
        pairedHandler.current(name);
      }, () => { /* transient: the next tick retries */ });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [codeId, paired]);

  useEffect(() => {
    if (!paired) return;
    const timer = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [paired, onClose]);

  useEffect(() => {
    if (!code || paired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code, paired]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setCaError('');
    api.getPairingCa().then(
      state => { if (live) setCa(state); },
      () => { if (live) setCaError('读取 CA 设置失败'); },
    );
    return () => { live = false; };
  }, [open]);

  const remaining = code ? code.data.ttlSeconds * 1000 - (now - code.receivedAt) : 0;
  const expired = Boolean(code) && remaining <= 0;

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.data.code);
    } catch {
      codeBox.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // A saved CA only reaches codes minted afterwards, so every change mints a fresh one.
  const saveCa = async (value: string | null) => {
    setCaBusy(true);
    setCaError('');
    try {
      setCa(await api.putPairingCa(value));
      setCaDraft('');
      setGeneration(current => current + 1);
    } catch (reason) {
      setCaError(
        value === null
          ? failure(reason, '清除失败，请重试')
          : failure(reason, '无法识别该证书：请粘贴完整的 PEM 内容（以 BEGIN CERTIFICATE 行开头，可包含多张）'),
      );
    } finally {
      setCaBusy(false);
    }
  };

  return (
    <SheetModal
      open={open}
      onOpenChange={isOpen => { if (!isOpen) onClose(); }}
      title={target ? '重新配对设备' : '添加设备'}
      description={
        target
          ? `在设备“${target.name}”的 PiBot 里粘贴下面的配对码；手机端请扫描二维码。该配对码只能用于此设备，用后即换新凭据，原凭据随即失效。`
          : '在新设备的 PiBot 里粘贴下面的配对码；手机端请扫描二维码。'
      }
      size="lg"
    >
      {error && <p className="inline-error" role="alert">{error}</p>}

      {paired ? (
        <p className="inline-notice" role="status">
          <Check size={15} aria-hidden="true" /> 已{target ? '重新配对' : '添加'}设备{paired.name ? `“${paired.name}”` : ''}，窗口即将关闭。
        </p>
      ) : code ? (
        <div className="pairing">
          <div className={`pairing-qr${expired ? ' is-expired' : ''}`}>
            <QrCode value={code.data.code} label="配对二维码" />
          </div>
          <div className="pairing-main">
            <label>
              配对码
              <textarea
                ref={codeBox}
                className="pairing-code"
                readOnly
                rows={5}
                value={code.data.code}
                onFocus={event => event.currentTarget.select()}
              />
            </label>
            <div className="action-row">
              <button type="button" className="button" disabled={expired} onClick={() => void copy()}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? '已复制' : '复制配对码'}
              </button>
              <button type="button" className="secondary-button" onClick={() => setGeneration(current => current + 1)}>
                <RefreshCw size={15} />
                重新生成
              </button>
            </div>
            <p className="secondary" role="status">
              {expired
                ? '配对码已过期，请重新生成。'
                : `仅可使用一次，${clock(remaining)} 后失效；关闭此窗口会使它立即作废。`}
            </p>
            <p className="secondary">
              {code.data.includesCa
                ? '已包含私有 CA 证书，设备无需另行导入。'
                : '未包含 CA 证书。中心使用公共证书（如 Let’s Encrypt）时无需设置；使用自签或私有 CA 时，请先在下方保存证书。'}
            </p>
          </div>
        </div>
      ) : !error ? (
        <p className="secondary" role="status">正在生成配对码…</p>
      ) : (
        <div className="action-row">
          <button type="button" className="secondary-button" onClick={() => setGeneration(current => current + 1)}>
            <RefreshCw size={15} />
            重试
          </button>
        </div>
      )}

      <details className="pairing-ca">
        <summary>私有 CA 证书{ca?.ca ? '（已设置）' : ''}</summary>
        <p className="secondary">
          仅在中心使用自签证书或私有 CA 时需要。保存一次后，之后生成的每个配对码都会自带它。
        </p>
        {caError && <p className="inline-error" role="alert">{caError}</p>}
        {ca && ca.certificates.length > 0 && (
          <ul className="pairing-ca-list">
            {ca.certificates.map(cert => {
              const lapsed = Date.parse(cert.validTo) < Date.now();
              return (
                <li key={cert.fingerprint256}>
                  <strong>{cert.subject}</strong>
                  <span className={lapsed ? 'pairing-ca-lapsed' : 'secondary'}>
                    {lapsed ? '已过期 ' : '有效期至 '}
                    {new Date(cert.validTo).toLocaleDateString('zh-CN')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <label>
          粘贴 PEM 证书
          <textarea
            className="pairing-code"
            rows={5}
            value={caDraft}
            disabled={caBusy}
            placeholder="-----BEGIN CERTIFICATE-----"
            onChange={event => setCaDraft(event.target.value)}
          />
        </label>
        <div className="action-row">
          <button
            type="button"
            className="button"
            disabled={caBusy || !caDraft.trim()}
            onClick={() => void saveCa(caDraft)}
          >
            保存证书
          </button>
          {ca?.ca && (
            <button type="button" className="quiet-button" disabled={caBusy} onClick={() => void saveCa(null)}>
              清除已保存证书
            </button>
          )}
        </div>
      </details>
    </SheetModal>
  );
}

export default AddDeviceDialog;
