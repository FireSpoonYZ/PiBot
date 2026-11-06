import { useEffect, useRef, useState } from 'react';
import { Download, Plus, RefreshCw, Rocket, Undo2 } from 'lucide-react';
import type {
  ClientReleaseArch,
  ClientReleaseFormat,
  ClientReleaseMetadata,
  ClientReleasePlatform,
  ClientReleaseRecord,
} from '@e-launcher/center-contract';
import { api } from '../api';
import { errorMessage } from '../components/ConfigOperation';
import { SheetModal } from '../components/SheetModal';

/** Only the platform/arch/format combinations the release pipeline produces. */
const COMBINATIONS: Record<ClientReleasePlatform, { arch: ClientReleaseArch; format: ClientReleaseFormat }[]> = {
  windows: [{ arch: 'x86_64', format: 'nsis' }],
  linux: [{ arch: 'x86_64', format: 'deb' }],
  android: [
    { arch: 'aarch64', format: 'apk' },
    { arch: 'x86_64', format: 'apk' },
  ],
};

const PLATFORM_LABEL: Record<ClientReleasePlatform, string> = {
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
};

const FORMAT_LABEL: Record<ClientReleaseFormat, string> = {
  nsis: 'NSIS 安装包',
  deb: 'DEB 安装包',
  apk: 'APK 安装包',
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function emptyMetadata(): ClientReleaseMetadata {
  return {
    version: '',
    platform: 'windows',
    arch: 'x86_64',
    format: 'nsis',
    size: 0,
    sha256: '',
    notes: '',
    sourceCommit: '',
  };
}

/** Parse a CI-exported release metadata JSON file into editable form state. */
async function readMetadataFile(file: File): Promise<ClientReleaseMetadata> {
  if (file.size > 128 * 1024) throw new Error('元数据 JSON 不能超过 128 KiB');
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('元数据不是有效的 JSON 文件');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('元数据必须是 JSON 对象');
  }
  const raw = parsed as Record<string, unknown>;
  const meta = emptyMetadata();
  meta.version = typeof raw.version === 'string' ? raw.version : '';
  if (!(['windows', 'linux', 'android'] as const).includes(raw.platform as ClientReleasePlatform) ||
      !(['x86_64', 'aarch64'] as const).includes(raw.arch as ClientReleaseArch) ||
      !(['nsis', 'deb', 'apk'] as const).includes(raw.format as ClientReleaseFormat)) {
    throw new Error('元数据包含未知的平台、架构或安装格式');
  }
  meta.platform = raw.platform as ClientReleasePlatform;
  meta.arch = raw.arch as ClientReleaseArch;
  meta.format = raw.format as ClientReleaseFormat;
  if (!COMBINATIONS[meta.platform].some(c => c.arch === meta.arch && c.format === meta.format)) {
    throw new Error('元数据的平台、架构和安装格式组合不受支持');
  }
  meta.size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0;
  meta.sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  meta.notes = typeof raw.notes === 'string' ? raw.notes : '';
  meta.sourceCommit = typeof raw.sourceCommit === 'string' ? raw.sourceCommit : '';
  meta.signature = meta.platform !== 'android' && typeof raw.signature === 'string' ? raw.signature : undefined;
  if (raw.versionCode !== undefined) {
    if (typeof raw.versionCode !== 'number' || !Number.isSafeInteger(raw.versionCode) || raw.versionCode < 1) {
      throw new Error('元数据 versionCode 必须为正安全整数');
    }
    meta.versionCode = raw.versionCode;
  }
  return meta;
}

export default function ClientReleases() {
  const [releases, setReleases] = useState<ClientReleaseRecord[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const [metadata, setMetadata] = useState<ClientReleaseMetadata>(emptyMetadata);
  const [metadataFile, setMetadataFile] = useState<File>();
  const [artifact, setArtifact] = useState<File>();
  const [signatureFile, setSignatureFile] = useState<File>();
  const [signatureText, setSignatureText] = useState('');
  const metadataImport = useRef(0);
  const signatureImport = useRef(0);
  const signatureInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const result = await api.listClientReleases();
      setReleases(result.releases);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const importMetadata = async (file: File | undefined) => {
    if (!file) return;
    const current = ++metadataImport.current;
    signatureImport.current += 1;
    setError('');
    setMetadata(emptyMetadata());
    setMetadataFile(undefined);
    setSignatureFile(undefined);
    setSignatureText('');
    if (signatureInput.current) signatureInput.current.value = '';
    const next = await readMetadataFile(file);
    if (current !== metadataImport.current) return;
    setMetadataFile(file);
    setMetadata(next);
  };

  const importSignature = async (file: File | undefined) => {
    const current = ++signatureImport.current;
    setError('');
    setSignatureFile(undefined);
    setSignatureText('');
    setMetadata(prev => ({ ...prev, signature: undefined }));
    if (!file) return;
    if (file.size > 64 * 1024) throw new Error('签名文件不能超过 64 KiB');
    const text = await file.text();
    if (current !== signatureImport.current) return;
    setSignatureFile(file);
    setSignatureText(text);
  };

  const setPlatform = (platform: ClientReleasePlatform) => {
    const combos = COMBINATIONS[platform];
    signatureImport.current += 1;
    setSignatureFile(undefined);
    setSignatureText('');
    if (signatureInput.current) signatureInput.current.value = '';
    setMetadata(prev => ({
      ...prev,
      platform,
      signature: undefined,
      arch: combos.some(c => c.arch === prev.arch) ? prev.arch : combos[0].arch,
      format: combos.some(c => c.format === prev.format) ? prev.format : combos[0].format,
    }));
  };

  const setArch = (arch: ClientReleaseArch) => {
    const combos = COMBINATIONS[metadata.platform].filter(c => c.arch === arch);
    setMetadata(prev => ({
      ...prev,
      arch,
      format: combos.some(c => c.format === prev.format) ? prev.format : combos[0]?.format ?? prev.format,
    }));
  };

  const validCombination = COMBINATIONS[metadata.platform].some(
    c => c.arch === metadata.arch && c.format === metadata.format,
  );
  const isAndroid = metadata.platform === 'android';
  const signature = (signatureText || metadata.signature || '').trim();
  const signatureReady = isAndroid || (signature.length > 0 && signature.length <= 64 * 1024);
  const sizeReady = Number.isSafeInteger(metadata.size) && metadata.size > 0;
  const versionCodeReady = metadata.versionCode !== undefined && Number.isSafeInteger(metadata.versionCode) && metadata.versionCode > 0;
  const shaReady = /^[0-9a-f]{64}$/i.test(metadata.sha256.trim());
  const commitReady = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(metadata.sourceCommit.trim());
  const metadataReady =
    metadata.version.trim() !== '' && shaReady && commitReady && sizeReady &&
    validCombination && signatureReady && (!isAndroid || versionCodeReady);
  const artifactReady = artifact !== undefined && artifact.size === metadata.size;
  const sizeMismatch = artifact !== undefined && metadata.size > 0 && artifact.size !== metadata.size;

  const submit = async () => {
    if (!artifact || !metadataReady || !artifactReady) return;
    const payload: ClientReleaseMetadata = {
      ...metadata,
      version: metadata.version.trim(),
      sha256: metadata.sha256.trim().toLowerCase(),
      sourceCommit: metadata.sourceCommit.trim(),
      notes: metadata.notes?.trim() ? metadata.notes.trim() : undefined,
      signature: isAndroid ? undefined : signature,
      versionCode: isAndroid ? metadata.versionCode : undefined,
    };
    await run(async () => {
      await api.createClientRelease(payload, artifact);
      setUploadOpen(false);
      setMetadata(emptyMetadata());
      setMetadataFile(undefined);
      setArtifact(undefined);
      setSignatureFile(undefined);
      setSignatureText('');
      setMessage('版本已保存为未发布草稿；核对无误后可发布');
      await load();
    });
  };

  const togglePublish = async (release: ClientReleaseRecord) => {
    await run(async () => {
      await api.publishClientRelease(release.id, { published: !release.published });
      setMessage(release.published ? `已撤回 ${release.version} 的发布` : `已发布 ${release.version}`);
      await load();
    });
  };

  const publishedCount = releases.filter(r => r.published).length;

  return (
    <main className="page config-page">
      <header className="page-header">
        <div className="page-title-group">
          <h1>客户端版本</h1>
          <p className="secondary">
            上传 CI 导出的安装包与元数据，核对后保存为草稿；管理员确认后发布，客户端即可查询下载。
          </p>
        </div>
        <button type="button" className="button secondary-button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} aria-hidden="true" />
          刷新列表
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => setUploadOpen(true)}>
          <Plus size={18} aria-hidden="true" />
          上传新版本
        </button>
      </header>

      {error && (
        <p className="inline-error config-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="inline-notice" role="status">
          {message}
        </p>
      )}

      <section className="card-group">
        <div className="card-header">
          <h2>已登记版本</h2>
          <span className="badge badge-neutral">
            {releases.length} 个记录 · {publishedCount} 个已发布
          </span>
        </div>
        {releases.length === 0 ? (
          <p className="empty-state secondary">暂无客户端版本。点击「上传新版本」导入 CI 构建产物。</p>
        ) : (
          <div className="card-grid">
            {releases.map(release => (
              <article key={release.id} className="resource-card resource-row">
                <div className="card-header">
                  <div>
                    <strong>v{release.version}</strong>{' '}
                    <span className="secondary">
                      {PLATFORM_LABEL[release.platform]} · {release.arch} · {FORMAT_LABEL[release.format]}
                      {release.platform === 'android' && release.versionCode !== undefined
                        ? ` · versionCode ${release.versionCode}`
                        : ''}
                    </span>
                  </div>
                  <div className="action-row">
                    <span className={`badge ${release.published ? 'badge-online' : 'badge-neutral'}`}>
                      {release.published ? '已发布' : '草稿'}
                    </span>
                  </div>
                </div>
                <p className="secondary">
                  {release.filename} · {formatSize(release.size)}
                  {release.publishedAt ? ` · 发布于 ${formatTime(release.publishedAt)}` : ''}
                </p>
                <p className="secondary" style={{ overflowWrap: 'anywhere' }}>
                  SHA-256：{release.sha256}
                  {' · '}源码：{release.sourceCommit}
                </p>
                {release.notes && <p className="secondary">{release.notes}</p>}
                <div className="action-row">
                  <a
                    className="quiet-button"
                    href={release.downloadUrl}
                    download={release.filename}
                    aria-label={`下载 ${release.filename}`}
                  >
                    <Download size={15} aria-hidden="true" />
                    下载安装包
                  </a>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={busy}
                    onClick={() => void togglePublish(release)}
                  >
                    {release.published ? (
                      <>
                        <Undo2 size={15} aria-hidden="true" />
                        撤回发布
                      </>
                    ) : (
                      <>
                        <Rocket size={15} aria-hidden="true" />
                        发布
                      </>
                    )}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <SheetModal
        open={uploadOpen}
        onOpenChange={open => {
          if (!open && !busy) setUploadOpen(false);
        }}
        title="上传客户端版本"
        description="先导入 CI 导出的元数据 JSON 核对，再选择对应安装包；大小必须与元数据一致，服务端会重新计算摘要核对。"
        size="lg"
      >
        <form
          className="form"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && <p className="inline-error" role="alert">{error}</p>}
          <label>
            发布元数据 JSON（CI 导出）
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={event => void importMetadata(event.target.files?.[0]).catch(e => setError(errorMessage(e)))}
            />
          </label>
          {metadataFile && <p className="secondary">已导入：{metadataFile.name}</p>}

          <div className="form-grid">
            <label>
              产品版本
              <input
                required
                value={metadata.version}
                disabled={busy}
                onChange={event => setMetadata({ ...metadata, version: event.target.value })}
                placeholder="例如 1.1.0"
              />
            </label>
            <label>
              平台
              <select
                value={metadata.platform}
                disabled={busy}
                onChange={event => setPlatform(event.target.value as ClientReleasePlatform)}
              >
                {(Object.keys(PLATFORM_LABEL) as ClientReleasePlatform[]).map(p => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              架构
              <select
                value={metadata.arch}
                disabled={busy}
                onChange={event => setArch(event.target.value as ClientReleaseArch)}
              >
                {COMBINATIONS[metadata.platform].map(c => (
                  <option key={c.arch} value={c.arch}>
                    {c.arch}
                  </option>
                ))}
              </select>
            </label>
            <label>
              安装格式
              <select
                value={metadata.format}
                disabled={busy}
                onChange={event =>
                  setMetadata({ ...metadata, format: event.target.value as ClientReleaseFormat })
                }
              >
                {COMBINATIONS[metadata.platform]
                  .filter(c => c.arch === metadata.arch)
                  .map(c => (
                    <option key={c.format} value={c.format}>
                      {FORMAT_LABEL[c.format]}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              文件大小（字节）
              <input
                required
                type="number"
                min={1}
                value={metadata.size || ''}
                disabled={busy}
                onChange={event =>
                  setMetadata({ ...metadata, size: Number(event.target.value) || 0 })
                }
              />
            </label>
            <label>
              SHA-256（十六进制）
              <input
                required
                value={metadata.sha256}
                disabled={busy}
                onChange={event => setMetadata({ ...metadata, sha256: event.target.value })}
                placeholder="64 位十六进制摘要"
              />
            </label>
            <label>
              源码提交
              <input
                required
                value={metadata.sourceCommit}
                disabled={busy}
                onChange={event => setMetadata({ ...metadata, sourceCommit: event.target.value })}
                placeholder="git commit SHA"
              />
            </label>
            {isAndroid && (
              <label>
                Android versionCode
                <input
                  required
                  type="number"
                  min={1}
                  value={metadata.versionCode ?? ''}
                  disabled={busy}
                  onChange={event =>
                    setMetadata({
                      ...metadata,
                      versionCode: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </label>
            )}
          </div>

          <label>
            更新说明（可选）
            <textarea
              rows={3}
              value={metadata.notes ?? ''}
              disabled={busy}
              onChange={event => setMetadata({ ...metadata, notes: event.target.value })}
            />
          </label>

          <label>
            安装包文件
            <input
              type="file"
              required
              disabled={busy}
              onChange={event => setArtifact(event.target.files?.[0])}
            />
          </label>
          {artifact && (
            <p className={sizeMismatch ? 'inline-error' : 'secondary'} role={sizeMismatch ? 'alert' : undefined}>
              所选文件 {artifact.name} · {formatSize(artifact.size)}
              {sizeMismatch
                ? `；与元数据大小 ${formatSize(metadata.size)} 不一致，无法上传`
                : metadata.size > 0
                  ? '；大小一致'
                  : ''}
            </p>
          )}

          {!isAndroid && (
            <>
              <label>
                更新签名 .sig 文本（桌面端必填；元数据已含签名时可不另选）
                <input
                  ref={signatureInput}
                  type="file"
                  accept=".sig,text/plain"
                  disabled={busy}
                  onChange={event => void importSignature(event.target.files?.[0]).catch(e => setError(errorMessage(e)))}
                />
              </label>
              {signatureFile && <p className="secondary">已导入签名：{signatureFile.name}</p>}
              {!signatureFile && metadata.signature && <p className="secondary">已使用元数据中的签名</p>}
              {!signatureReady && <p className="inline-error" role="alert">桌面版本需要不超过 64 KiB 的更新签名。</p>}
            </>
          )}

          {((metadata.sha256 && !shaReady) || (metadata.sourceCommit && !commitReady) ||
            (metadata.size !== 0 && !sizeReady) || (isAndroid && metadata.versionCode !== undefined && !versionCodeReady)) && (
            <p className="inline-error" role="alert">SHA-256 必须为 64 位十六进制，源码提交必须为 40 或 64 位十六进制；大小和 Android versionCode 必须为正安全整数。</p>
          )}

          {!validCombination && (
            <p className="inline-error" role="alert">
              当前平台/架构/格式组合不受支持；仅支持 Windows x86_64 NSIS、Linux x86_64 DEB、Android
              arm64-v8a/x86_64 APK。
            </p>
          )}

          <div className="action-row">
            <button
              type="submit"
              className="button"
              disabled={busy || !artifact || !metadataReady || !artifactReady}
            >
              {busy ? '上传中…' : '上传并保存草稿'}
            </button>
            <button
              type="button"
              className="button secondary-button"
              disabled={busy}
              onClick={() => setUploadOpen(false)}
            >
              取消
            </button>
          </div>
          <p className="secondary">
            上传后记录为未发布草稿；服务端会核对文件大小与 SHA-256，管理员确认无误后再发布。
          </p>
        </form>
      </SheetModal>
    </main>
  );
}
