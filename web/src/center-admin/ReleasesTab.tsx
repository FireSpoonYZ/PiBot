import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { Download, RefreshCw, Upload } from 'lucide-react';
import { LabelStack } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  CaModal,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  platformLabel,
  useCaTabNotices,
} from './primitives';
import type {
  ClientReleaseArch,
  ClientReleaseFormat,
  ClientReleaseMetadata,
  ClientReleasePlatform,
  ClientReleaseRecord,
} from './types';

type TranslateFn = ReturnType<typeof useText>;

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SIGNATURE_LENGTH = 64 * 1024;
const MAX_NOTES_LENGTH = 32 * 1024;
const SEMVER_RE =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SOURCE_COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

type ReleaseFieldKey =
  | 'file'
  | 'version'
  | 'sourceCommit'
  | 'versionCode'
  | 'signature'
  | 'notes'
  | 'sha256';
type ReleaseFieldErrors = Partial<Record<ReleaseFieldKey, string>>;

const RELEASE_FIELD_ORDER: readonly ReleaseFieldKey[] = [
  'file',
  'version',
  'sourceCommit',
  'versionCode',
  'signature',
  'notes',
  'sha256',
];

const PLATFORMS: readonly ClientReleasePlatform[] = ['windows', 'linux', 'macos', 'android'];

const PLATFORM_SPECS: Record<
  ClientReleasePlatform,
  { arches: readonly ClientReleaseArch[]; formats: readonly ClientReleaseFormat[] }
> = {
  windows: { arches: ['x86_64'], formats: ['nsis'] },
  linux: { arches: ['x86_64'], formats: ['deb'] },
  macos: { arches: ['aarch64'], formats: ['app'] },
  android: { arches: ['aarch64', 'x86_64'], formats: ['apk'] },
};

function archLabel(arch: ClientReleaseArch, platform: ClientReleasePlatform, t: TranslateFn): string {
  if (platform === 'android' && arch === 'x86_64') {
    return t('x86_64（模拟器）', 'x86_64 (emulator)');
  }
  if (platform === 'android' && arch === 'aarch64') {
    return 'aarch64 (ARM64)';
  }
  if (platform === 'macos' && arch === 'aarch64') {
    return 'aarch64 (Apple Silicon)';
  }
  return arch;
}

function formatLabel(format: ClientReleaseFormat): string {
  switch (format) {
    case 'nsis':
      return 'nsis (.exe)';
    case 'deb':
      return 'deb (.deb)';
    case 'app':
      return 'app (.app.tar.gz)';
    case 'apk':
      return 'apk (.apk)';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function computeSha256Hex(file: File, t: TranslateFn): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(t('当前运行环境不支持 WebCrypto SHA-256 计算', 'Current runtime does not support WebCrypto SHA-256'));
  }
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function inferFromFilename(name: string): Partial<ClientReleaseMetadata> {
  const lower = name.toLowerCase();
  const verMatch = name.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  const version = verMatch ? verMatch[1] : undefined;

  if (lower.endsWith('.exe')) {
    return { version, platform: 'windows', arch: 'x86_64', format: 'nsis' };
  }
  if (lower.endsWith('.deb')) {
    return { version, platform: 'linux', arch: 'x86_64', format: 'deb' };
  }
  if (lower.endsWith('.app.tar.gz') || lower.endsWith('.tar.gz')) {
    return { version, platform: 'macos', arch: 'aarch64', format: 'app' };
  }
  if (lower.endsWith('.apk')) {
    const arch: ClientReleaseArch = lower.includes('x86_64') || lower.includes('x64') ? 'x86_64' : 'aarch64';
    return { version, platform: 'android', arch, format: 'apk' };
  }
  return { version };
}

interface ReleasesCacheData {
  releases: ClientReleaseRecord[];
}

export function ReleasesTab({
  api,
  active = true,
  cacheKey = 'default',
  onOpenExternal,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  onOpenExternal?: () => void;
}): React.JSX.Element {
  const t = useText();

  const initialCache = useMemo(
    () => readTabCache<ReleasesCacheData>(cacheKey, 'releases')?.data ?? null,
    [cacheKey],
  );
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');

  const [releases, setReleases] = useState<ClientReleaseRecord[]>(() => initialCache?.releases ?? []);
  const [platformFilter, setPlatformFilter] = useState<'all' | ClientReleasePlatform>('all');
  const [togglingReleaseId, setTogglingReleaseId] = useState<string | null>(null);

  // Upload modal state
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [releaseFile, setReleaseFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hashing, setHashing] = useState(false);
  const [relVersion, setRelVersion] = useState('');
  const [relPlatform, setRelPlatform] = useState<ClientReleasePlatform>('windows');
  const [relArch, setRelArch] = useState<ClientReleaseArch>('x86_64');
  const [relFormat, setRelFormat] = useState<ClientReleaseFormat>('nsis');
  const [relNotes, setRelNotes] = useState('');
  const [relSha256, setRelSha256] = useState('');
  const [relSize, setRelSize] = useState(0);
  const [relVersionCode, setRelVersionCode] = useState('');
  const [relSourceCommit, setRelSourceCommit] = useState('');
  const [relSignature, setRelSignature] = useState('');
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [relBusy, setRelBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadNeedsBrowser, setUploadNeedsBrowser] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ReleaseFieldErrors>({});
  const [shaDisclosureOpen, setShaDisclosureOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sigFileInputRef = useRef<HTMLInputElement | null>(null);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);
  const versionInputRef = useRef<HTMLInputElement | null>(null);
  const sourceCommitInputRef = useRef<HTMLInputElement | null>(null);
  const versionCodeInputRef = useRef<HTMLInputElement | null>(null);
  const signatureInputRef = useRef<HTMLTextAreaElement | null>(null);
  const notesInputRef = useRef<HTMLInputElement | null>(null);
  const sha256InputRef = useRef<HTMLInputElement | null>(null);

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);
  const hashGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('releases', active);

  const setError = useCallback(
    (msg: string) => {
      if (msg) showNotice('error', msg, { tone: 'danger' });
      else clearNotice('error');
    },
    [clearNotice, showNotice],
  );

  const setNotice = useCallback(
    (msg: string) => {
      if (msg) showNotice('notice', msg, { tone: 'ok' });
      else clearNotice('notice');
    },
    [clearNotice, showNotice],
  );

  const loadAll = useCallback(
    async (gen: number) => {
      const relRes = await api.listClientReleases();
      if (gen !== loadGenRef.current) return;
      setReleases(relRes.releases);
      hasLoadedRef.current = true;
      cacheKeyRef.current = cacheKey;
      setHasLoaded(true);
      setInitialError('');
      clearNotice('load-error');
    },
    [api, cacheKey, clearNotice],
  );

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll(gen);
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const reason = errorMessage(err, t('中心服务暂不可用', 'Center service unavailable'));
      const msg = t(`加载客户端发布列表失败：${reason}。请检查中心连接后重试。`, `Failed to load client releases: ${reason}. Check your center connection and retry.`);
      if (hasLoadedRef.current) {
        if (activeRef.current) {
          showNotice('load-error', msg, {
            tone: 'danger',
            action: {
              label: t('重试', 'Retry'),
              onClick: () => void runLoad(),
            },
          });
        }
      } else {
        setInitialError(msg);
      }
    } finally {
      if (gen === loadGenRef.current) setRefreshing(false);
    }
  }, [loadAll, showNotice]);

  useEffect(() => {
    void runLoad();
  }, [runLoad]);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive && active && (hasLoadedRef.current || initialError)) {
      void runLoad();
    }
  }, [active, initialError, runLoad]);

  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
      hashGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<ReleasesCacheData>(cacheKey, 'releases', { releases });
  }, [cacheKey, hasLoaded, releases]);

  const availablePlatforms = useMemo(() => {
    const set = new Set<ClientReleasePlatform>();
    for (const r of releases) set.add(r.platform);
    return PLATFORMS.filter(p => set.has(p));
  }, [releases]);

  const filteredReleases = useMemo(() => {
    if (platformFilter === 'all') return releases;
    return releases.filter(r => r.platform === platformFilter);
  }, [platformFilter, releases]);

  const clearFieldError = useCallback((field: ReleaseFieldKey) => {
    setFieldErrors(prev => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const focusField = (field: ReleaseFieldKey) => {
    const map: Record<ReleaseFieldKey, HTMLElement | null> = {
      file: dropzoneRef.current,
      version: versionInputRef.current,
      sourceCommit: sourceCommitInputRef.current,
      versionCode: versionCodeInputRef.current,
      signature: signatureInputRef.current,
      notes: notesInputRef.current,
      sha256: sha256InputRef.current,
    };
    const el = map[field];
    if (el) {
      el.focus();
      return;
    }
    if (field === 'sha256') {
      setShaDisclosureOpen(true);
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          sha256InputRef.current?.focus();
        });
      }
    }
  };

  const handlePlatformChange = (nextPlatform: ClientReleasePlatform) => {
    setRelPlatform(nextPlatform);
    const spec = PLATFORM_SPECS[nextPlatform];
    const nextArch = spec.arches.includes(relArch) ? relArch : spec.arches[0];
    const nextFormat = spec.formats.includes(relFormat) ? relFormat : spec.formats[0];
    setRelArch(nextArch);
    setRelFormat(nextFormat);
    if (nextFormat !== 'apk') {
      setRelVersionCode('');
      clearFieldError('versionCode');
    } else {
      setRelSignature('');
      clearFieldError('signature');
    }
  };

  const handleFormatChange = (nextFormat: ClientReleaseFormat) => {
    setRelFormat(nextFormat);
    if (nextFormat !== 'apk') {
      setRelVersionCode('');
      clearFieldError('versionCode');
    } else {
      setRelSignature('');
      clearFieldError('signature');
    }
  };

  const resetUploadForm = () => {
    hashGenRef.current += 1;
    setReleaseFile(null);
    setDragging(false);
    setHashing(false);
    setRelVersion('');
    setRelPlatform('windows');
    setRelArch('x86_64');
    setRelFormat('nsis');
    setRelNotes('');
    setRelSha256('');
    setRelSize(0);
    setRelVersionCode('');
    setRelSourceCommit('');
    setRelSignature('');
    setPublishImmediately(false);
    setUploadError('');
    setUploadNeedsBrowser(false);
    setFieldErrors({});
    setShaDisclosureOpen(false);
  };

  const openUploadModal = () => {
    setUploadError('');
    setUploadNeedsBrowser(false);
    setFieldErrors({});
    setUploadModalOpen(true);
  };

  const handleSigFileSelected = async (file: File | undefined) => {
    if (!file) return;
    const sigText = await file.text().catch(() => '');
    if (sigText.trim()) {
      setRelSignature(sigText.trim());
      clearFieldError('signature');
    }
  };

  const handleFilesSelected = async (fileList: FileList | File[]) => {
    setUploadError('');
    setUploadNeedsBrowser(false);
    const files = Array.from(fileList);
    if (files.length === 0) return;

    let effectiveFormat: ClientReleaseFormat = relFormat;

    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.json')) {
        try {
          const parsed = JSON.parse(await f.text()) as Record<string, unknown>;
          if (typeof parsed.version === 'string') {
            setRelVersion(parsed.version);
            clearFieldError('version');
          }
          let parsedPlatform: ClientReleasePlatform | undefined;
          if (
            parsed.platform === 'windows' ||
            parsed.platform === 'linux' ||
            parsed.platform === 'macos' ||
            parsed.platform === 'android'
          ) {
            parsedPlatform = parsed.platform;
            setRelPlatform(parsed.platform);
          }
          if (parsed.arch === 'x86_64' || parsed.arch === 'aarch64') setRelArch(parsed.arch);
          if (
            parsed.format === 'nsis' ||
            parsed.format === 'deb' ||
            parsed.format === 'app' ||
            parsed.format === 'apk'
          ) {
            effectiveFormat = parsed.format;
            setRelFormat(parsed.format);
          } else if (parsedPlatform) {
            effectiveFormat = PLATFORM_SPECS[parsedPlatform].formats[0];
            setRelFormat(effectiveFormat);
          }
          if (typeof parsed.notes === 'string') {
            setRelNotes(parsed.notes);
            clearFieldError('notes');
          }
          if (typeof parsed.sourceCommit === 'string') {
            setRelSourceCommit(parsed.sourceCommit);
            clearFieldError('sourceCommit');
          }
          if (effectiveFormat === 'apk') {
            setRelSignature('');
            clearFieldError('signature');
            if (typeof parsed.versionCode === 'number') {
              setRelVersionCode(String(parsed.versionCode));
              clearFieldError('versionCode');
            }
          } else {
            setRelVersionCode('');
            clearFieldError('versionCode');
            if (typeof parsed.signature === 'string') {
              setRelSignature(parsed.signature);
              clearFieldError('signature');
            }
          }
          if (typeof parsed.sha256 === 'string') {
            setRelSha256(parsed.sha256);
            clearFieldError('sha256');
          }
          if (typeof parsed.size === 'number') setRelSize(parsed.size);
        } catch {
          setUploadError(t(`无法解析元数据文件 ${f.name}：JSON 格式无效。请检查文件内容后重新拖入。`, `Failed to parse metadata file ${f.name}: invalid JSON. Check the file and drop it again.`));
        }
      } else if (lower.endsWith('.sig')) {
        const sigText = await f.text().catch(() => '');
        if (sigText.trim()) {
          setRelSignature(sigText.trim());
          clearFieldError('signature');
        }
      } else {
        const gen = ++hashGenRef.current;
        setReleaseFile(f);
        setRelSize(f.size);
        setRelSha256('');
        clearFieldError('file');
        const inferred = inferFromFilename(f.name);
        if (inferred.version) {
          setRelVersion(inferred.version);
          clearFieldError('version');
        }
        if (inferred.platform) setRelPlatform(inferred.platform);
        if (inferred.arch) setRelArch(inferred.arch);
        if (inferred.format) {
          effectiveFormat = inferred.format;
          setRelFormat(inferred.format);
          if (inferred.format !== 'apk') {
            setRelVersionCode('');
            clearFieldError('versionCode');
          } else {
            setRelSignature('');
            clearFieldError('signature');
          }
        }
        setHashing(true);
        try {
          const sha = await computeSha256Hex(f, t);
          if (gen === hashGenRef.current) {
            setRelSha256(sha);
            clearFieldError('sha256');
          }
        } catch (err) {
          if (gen === hashGenRef.current) {
            const reason = errorMessage(err, t('浏览器计算失败', 'Browser digest failed'));
            setShaDisclosureOpen(true);
            setUploadError(t(`自动计算 SHA-256 失败：${reason}。可在下方「SHA-256 校验值」中手动填入。`, `Failed to compute SHA-256: ${reason}. You can enter the SHA-256 manually below.`));
          }
        } finally {
          if (gen === hashGenRef.current) {
            setHashing(false);
          }
        }
      }
    }
  };

  const handleUploadRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError('');
    setUploadNeedsBrowser(false);

    const isApk = relFormat === 'apk';
    const trimmedVersion = relVersion.trim();
    const trimmedCommit = relSourceCommit.trim();
    const trimmedSignature = relSignature.trim();
    const trimmedNotes = relNotes.trim();
    const trimmedSha256 = relSha256.trim();
    const trimmedCode = relVersionCode.trim();
    const parsedCode = /^[1-9]\d*$/.test(trimmedCode) ? Number(trimmedCode) : NaN;
    const artifactSize = releaseFile ? relSize || releaseFile.size : 0;

    const nextErrors: ReleaseFieldErrors = {};

    if (!releaseFile) {
      nextErrors.file = t('请先选择或拖入安装包文件。', 'Choose or drop an artifact file first.');
    } else if (!Number.isSafeInteger(artifactSize) || artifactSize < 1 || artifactSize > MAX_ARTIFACT_BYTES) {
      nextErrors.file = t('安装包大小无效（须大于 0 且不超过 2 GiB）。', 'Artifact size must be greater than 0 and at most 2 GiB.');
    }

    if (!trimmedVersion) {
      nextErrors.version = t('请填写语义化版本号（如 1.4.0）。', 'Enter a semantic version (e.g. 1.4.0).');
    } else if (!SEMVER_RE.test(trimmedVersion)) {
      nextErrors.version = t('版本号必须符合语义化版本格式（如 1.4.0）。', 'Version must be a valid semver string (e.g. 1.4.0).');
    }

    if (!trimmedCommit) {
      nextErrors.sourceCommit = t('请填写 40 位或 64 位十六进制源码提交哈希。', 'Enter a 40- or 64-character hex source commit hash.');
    } else if (!SOURCE_COMMIT_RE.test(trimmedCommit)) {
      nextErrors.sourceCommit = t('源码提交哈希必须为 40 位或 64 位十六进制字符（0-9, a-f）。', 'Source commit must be a 40- or 64-character hexadecimal hash (0-9, a-f).');
    }

    if (isApk) {
      if (!trimmedCode || !Number.isSafeInteger(parsedCode) || parsedCode < 1) {
        nextErrors.versionCode = t('Android APK 必须填写正整数 versionCode（如 10400）。', 'Android APK requires a positive integer versionCode (e.g. 10400).');
      }
    } else {
      if (!trimmedSignature) {
        nextErrors.signature = t('桌面端安装包必须提供 .sig 更新签名（可拖入或选择 .sig 文件）。', 'Desktop releases require a .sig update signature before submitting.');
      } else if (trimmedSignature.length > MAX_SIGNATURE_LENGTH) {
        nextErrors.signature = t('更新签名内容不能超过 64 KiB。', 'Update signature cannot exceed 64 KiB.');
      }
    }

    if (trimmedNotes.length > MAX_NOTES_LENGTH) {
      nextErrors.notes = t('更新说明不能超过 32 KiB。', 'Release notes cannot exceed 32 KiB.');
    }

    if (hashing) {
      nextErrors.sha256 = t('SHA-256 校验值正在计算中，请稍候。', 'SHA-256 checksum is still computing. Please wait.');
    } else if (!trimmedSha256) {
      nextErrors.sha256 = t('缺少 SHA-256 校验值，请等待自动计算或手动填入。', 'SHA-256 checksum is required. Wait for hashing or enter it manually.');
    } else if (!SHA256_RE.test(trimmedSha256)) {
      nextErrors.sha256 = t('SHA-256 必须为 64 位十六进制字符串。', 'SHA-256 must be a 64-character hexadecimal string.');
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      if (nextErrors.sha256) {
        setShaDisclosureOpen(true);
      }
      const firstInvalid = RELEASE_FIELD_ORDER.find(key => Boolean(nextErrors[key]));
      if (firstInvalid) {
        focusField(firstInvalid);
      }
      return;
    }

    setFieldErrors({});
    const meta: ClientReleaseMetadata = {
      version: trimmedVersion,
      platform: relPlatform,
      arch: relArch,
      format: relFormat,
      size: artifactSize,
      sha256: trimmedSha256.toLowerCase(),
      sourceCommit: trimmedCommit.toLowerCase(),
      ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      ...(!isApk ? { signature: trimmedSignature } : {}),
      ...(isApk ? { versionCode: parsedCode } : {}),
    };

    setRelBusy(true);
    try {
      const created = await api.createClientRelease(meta, releaseFile!);
      let finalRecord = created;
      if (publishImmediately) {
        finalRecord = await api.publishClientRelease(created.id, { published: true });
      }
      setReleases(prev => [finalRecord, ...prev.filter(r => r.id !== finalRecord.id)]);
      const wasPublishedImmediately = publishImmediately;
      resetUploadForm();
      setUploadModalOpen(false);
      setNotice(
        wasPublishedImmediately
          ? t(`版本 v${finalRecord.version} 已上传并发布`, `Release v${finalRecord.version} uploaded and published`)
          : t(`版本 v${finalRecord.version} 已上传并保存为草稿`, `Release v${finalRecord.version} uploaded as draft`),
      );
    } catch (err) {
      const needsBrowser = err instanceof CenterApiError && err.code === 'UNSUPPORTED_FORM_DATA';
      const reason = errorMessage(err, t('上传请求失败', 'Upload request failed'));
      setUploadNeedsBrowser(needsBrowser);
      setUploadError(
        needsBrowser
          ? reason
          : t(`上传客户端安装包失败：${reason}。请检查文件元数据与中心连接后重试。`, `Failed to upload client package: ${reason}. Verify package metadata and center connection, then retry.`),
      );
    } finally {
      setRelBusy(false);
    }
  };

  const handleTogglePublishRelease = async (record: ClientReleaseRecord) => {
    setTogglingReleaseId(record.id);
    setError('');
    try {
      const updated = await api.publishClientRelease(record.id, { published: !record.published });
      setReleases(prev => prev.map(r => (r.id === updated.id ? updated : r)));
      setNotice(
        updated.published
          ? t(`已发布 v${updated.version}（${platformLabel(updated.platform, t)}）`, `Published v${updated.version} (${platformLabel(updated.platform, t)})`)
          : t(`已撤回发布 v${updated.version}（${platformLabel(updated.platform, t)}）`, `Unpublished v${updated.version} (${platformLabel(updated.platform, t)})`),
      );
    } catch (err) {
      const reason = errorMessage(err, t('请求失败', 'Request failed'));
      setError(t(`更新 v${record.version} 发布状态失败：${reason}。请稍后重试。`, `Failed to update publish status for v${record.version}: ${reason}. Please try again.`));
    } finally {
      setTogglingReleaseId(null);
    }
  };

  const currentPlatformSpec = PLATFORM_SPECS[relPlatform];
  const archOptions = currentPlatformSpec.arches.includes(relArch)
    ? currentPlatformSpec.arches
    : [...currentPlatformSpec.arches, relArch];
  const formatOptions = currentPlatformSpec.formats.includes(relFormat)
    ? currentPlatformSpec.formats
    : [...currentPlatformSpec.formats, relFormat];

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaSectionSkeleton rows={4} headWidth={156} trailingWidth={124} label={t('正在加载客户端发布…', 'Loading client releases…')} />
      </div>
    );
  }

  if (!hasLoaded && initialError) {
    return (
      <section className="ca-section">
        <div className="ca-section-body">
          <CaNotice
            tone="danger"
            action={
              <button type="button" className="ca-btn ca-btn-sm" onClick={() => void runLoad()}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重试加载', 'Retry')}</span>
              </button>
            }
          >
            {initialError}
          </CaNotice>
        </div>
      </section>
    );
  }

  return (
    <div className="ca-form-stack">
      <CaRefreshBar active={refreshing} />

      <section className="ca-section">
        <div className="ca-section-head">
          <h3 className="ca-section-title">
            {t(`客户端发布 (${releases.length})`, `Client Releases (${releases.length})`)}
          </h3>
          <div className="ca-inline-row">
            {availablePlatforms.length > 1 && (
              <select
                className="ca-select ca-select-compact"
                aria-label={t('按平台筛选版本', 'Filter releases by platform')}
                value={platformFilter}
                onChange={e => setPlatformFilter(e.target.value as 'all' | ClientReleasePlatform)}
              >
                <option value="all">{t('全部平台', 'All Platforms')}</option>
                {availablePlatforms.map(p => (
                  <option key={p} value={p}>
                    {platformLabel(p, t)}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ca-btn ca-btn-ghost ca-btn-icon"
              aria-label={t('刷新版本列表', 'Refresh releases')}
              title={t('刷新版本列表', 'Refresh releases')}
              disabled={refreshing}
              onClick={() => void runLoad()}
            >
              <RefreshCw size={14} className={refreshing ? 'ca-spin' : undefined} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              onClick={openUploadModal}
            >
              <Upload size={14} aria-hidden="true" />
              <span>{t('上传安装包', 'Upload Package')}</span>
            </button>
          </div>
        </div>

        <div className="ca-list">
          {filteredReleases.length === 0 ? (
            releases.length === 0 ? (
              <div className="ca-empty">
                <div className="ca-form-stack ca-center-stack">
                  <div>{t('尚未上传任何客户端安装包。上传并发布后，桌面端与移动端即可通过中心检查更新。', 'No client packages uploaded yet. Upload and publish a package so desktop and mobile clients can check for updates.')}</div>
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    onClick={openUploadModal}
                  >
                    <Upload size={14} aria-hidden="true" />
                    <span>{t('上传首个安装包', 'Upload First Package')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="ca-empty">
                <div className="ca-form-stack ca-center-stack">
                  <div>{t('当前筛选条件下暂无客户端版本。', 'No releases match the selected platform.')}</div>
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => setPlatformFilter('all')}
                  >
                    {t('显示全部平台', 'Show All Platforms')}
                  </button>
                </div>
              </div>
            )
          ) : (
            filteredReleases.map(rec => {
              const rowBusy = togglingReleaseId === rec.id;
              return (
                <div key={rec.id} className="ca-row">
                  <div className="ca-row-main">
                    <div className="ca-row-title">
                      <span
                        className={`ca-dot ${rec.published ? 'is-online' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="ca-num">
                        v{rec.version} · {platformLabel(rec.platform, t)} · {rec.arch}
                      </span>
                      <span className="ca-pill ca-pill-muted ca-mono">{rec.format}</span>
                      <span className={`ca-pill ${rec.published ? 'ca-pill-ok' : 'ca-pill-warn'}`}>
                        {rec.published ? t('已发布', 'Published') : t('草稿', 'Draft')}
                      </span>
                    </div>
                    <div className="ca-row-sub ca-num">
                      {rec.filename} · {formatBytes(rec.size)} · SHA256:{rec.sha256.slice(0, 12)}…
                      {rec.notes ? ` · ${rec.notes}` : ''}
                    </div>
                  </div>
                  <div className="ca-row-actions">
                    <a href={rec.downloadUrl} download={rec.filename} className="ca-btn ca-btn-sm">
                      <Download size={13} aria-hidden="true" />
                      <span>{t('下载', 'Download')}</span>
                    </a>
                    <button
                      type="button"
                      className="ca-btn ca-btn-sm"
                      disabled={rowBusy}
                      onClick={() => void handleTogglePublishRelease(rec)}
                    >
                      <LabelStack
                        active={
                          rowBusy
                            ? t('更新中…', 'Updating…')
                            : rec.published
                              ? t('撤回发布', 'Unpublish')
                              : t('发布版本', 'Publish')
                        }
                        labels={[
                          t('发布版本', 'Publish'),
                          t('撤回发布', 'Unpublish'),
                          t('更新中…', 'Updating…'),
                        ]}
                      />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <CaModal
        open={uploadModalOpen}
        onOpenChange={nextOpen => {
          if (!nextOpen && !relBusy) {
            setUploadError('');
            setUploadNeedsBrowser(false);
            setFieldErrors({});
            setUploadModalOpen(false);
          }
        }}
        title={t('上传客户端安装包', 'Upload Client Package')}
        description={t('拖入或选择安装包（支持同时拖入 CI release.json / .sig），系统会自动识别版本与平台并计算 SHA-256。', 'Drop or choose a package file (CI release.json / .sig supported). Version, platform, and SHA-256 are detected automatically.')}
        variant="modal"
        wide
      >
        <form className="ca-form-stack" noValidate onSubmit={e => void handleUploadRelease(e)}>
          {uploadError && (
            <CaNotice
              tone="danger"
              action={
                uploadNeedsBrowser && onOpenExternal ? (
                  <button type="button" className="ca-btn ca-btn-sm" onClick={onOpenExternal}>
                    {t('在浏览器打开上传', 'Open in browser to upload')}
                  </button>
                ) : undefined
              }
            >
              {uploadError}
            </CaNotice>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="ca-hidden"
            accept=".exe,.deb,.tar.gz,.apk,.json,.sig"
            onChange={e => {
              if (e.target.files) void handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
          />

          <input
            ref={sigFileInputRef}
            type="file"
            className="ca-hidden"
            accept=".sig,text/plain"
            onChange={e => {
              void handleSigFileSelected(e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          <div className="ca-field">
            <div
              ref={dropzoneRef}
              role="button"
              tabIndex={0}
              aria-invalid={Boolean(fieldErrors.file) || undefined}
              aria-describedby={fieldErrors.file ? 'ca-release-file-error' : undefined}
              className={`ca-dropzone ${dragging ? 'is-dragging' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={e => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.files.length > 0) void handleFilesSelected(e.dataTransfer.files);
              }}
            >
              <Upload size={20} aria-hidden="true" className="ca-dropzone-icon" />
              <div className="ca-dropzone-title ca-num">
                {releaseFile
                  ? `${releaseFile.name} (${formatBytes(relSize || releaseFile.size)})`
                  : t('点击或拖入安装包文件（.exe / .deb / .app.tar.gz / .apk）', 'Click or drop a package file (.exe / .deb / .app.tar.gz / .apk)')}
              </div>
              <div className="ca-muted ca-mt-1">
                {hashing
                  ? t('正在计算 SHA-256 校验值…', 'Computing SHA-256 checksum…')
                  : releaseFile
                    ? t('点击或拖入新文件以替换当前安装包（也可补充拖入 release.json / .sig）', 'Click or drop another file to replace (you can also drop release.json / .sig)')
                    : t('可同时拖入 release.json 与 .sig 自动填充发布与签名元数据', 'Drop release.json and .sig alongside the package to auto-fill metadata')}
              </div>
            </div>
            {fieldErrors.file && (
              <p id="ca-release-file-error" className="ca-error-text" role="alert">
                {fieldErrors.file}
              </p>
            )}
          </div>

          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-release-version">
                {t('版本号', 'Version')} <span className="ca-req">*</span>
              </label>
              <input
                id="ca-release-version"
                ref={versionInputRef}
                type="text"
                className="ca-input ca-mono ca-num"
                aria-invalid={Boolean(fieldErrors.version) || undefined}
                aria-describedby={fieldErrors.version ? 'ca-release-version-error' : undefined}
                placeholder={t('例如 1.4.0', 'e.g. 1.4.0')}
                value={relVersion}
                onChange={e => {
                  setRelVersion(e.target.value);
                  clearFieldError('version');
                }}
              />
              {fieldErrors.version && (
                <p id="ca-release-version-error" className="ca-error-text" role="alert">
                  {fieldErrors.version}
                </p>
              )}
            </div>

            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-release-platform">
                {t('平台', 'Platform')}
              </label>
              <select
                id="ca-release-platform"
                className="ca-select"
                value={relPlatform}
                onChange={e => handlePlatformChange(e.target.value as ClientReleasePlatform)}
              >
                {PLATFORMS.map(p => (
                  <option key={p} value={p}>
                    {platformLabel(p, t)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-release-arch">
                {t('架构', 'Architecture')}
              </label>
              <select
                id="ca-release-arch"
                className="ca-select ca-num"
                value={relArch}
                onChange={e => setRelArch(e.target.value as ClientReleaseArch)}
              >
                {archOptions.map(arch => (
                  <option key={arch} value={arch}>
                    {archLabel(arch, relPlatform, t)}
                  </option>
                ))}
              </select>
            </div>

            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-release-format">
                {t('封装格式', 'Format')}
              </label>
              <select
                id="ca-release-format"
                className="ca-select ca-mono"
                value={relFormat}
                onChange={e => handleFormatChange(e.target.value as ClientReleaseFormat)}
              >
                {formatOptions.map(fmt => (
                  <option key={fmt} value={fmt}>
                    {formatLabel(fmt)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {relFormat === 'apk' ? (
            <div className="ca-grid-2">
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-release-commit">
                  {t('源码提交 (sourceCommit)', 'Source Commit (sourceCommit)')} <span className="ca-req">*</span>
                </label>
                <input
                  id="ca-release-commit"
                  ref={sourceCommitInputRef}
                  type="text"
                  className="ca-input ca-mono"
                  aria-invalid={Boolean(fieldErrors.sourceCommit) || undefined}
                  aria-describedby={fieldErrors.sourceCommit ? 'ca-release-commit-error' : undefined}
                  placeholder={t('40 或 64 位十六进制 Git 提交哈希', '40- or 64-character hex Git commit hash')}
                  value={relSourceCommit}
                  onChange={e => {
                    setRelSourceCommit(e.target.value);
                    clearFieldError('sourceCommit');
                  }}
                />
                {fieldErrors.sourceCommit && (
                  <p id="ca-release-commit-error" className="ca-error-text" role="alert">
                    {fieldErrors.sourceCommit}
                  </p>
                )}
              </div>

              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-release-version-code">
                  {t('Android versionCode', 'Android versionCode')} <span className="ca-req">*</span>
                </label>
                <input
                  id="ca-release-version-code"
                  ref={versionCodeInputRef}
                  type="number"
                  min={1}
                  step={1}
                  className="ca-input ca-num"
                  aria-invalid={Boolean(fieldErrors.versionCode) || undefined}
                  aria-describedby={fieldErrors.versionCode ? 'ca-release-version-code-error' : undefined}
                  placeholder={t('例如 10400', 'e.g. 10400')}
                  value={relVersionCode}
                  onChange={e => {
                    setRelVersionCode(e.target.value);
                    clearFieldError('versionCode');
                  }}
                />
                {fieldErrors.versionCode && (
                  <p id="ca-release-version-code-error" className="ca-error-text" role="alert">
                    {fieldErrors.versionCode}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-release-commit">
                {t('源码提交 (sourceCommit)', 'Source Commit (sourceCommit)')} <span className="ca-req">*</span>
              </label>
              <input
                id="ca-release-commit"
                ref={sourceCommitInputRef}
                type="text"
                className="ca-input ca-mono"
                aria-invalid={Boolean(fieldErrors.sourceCommit) || undefined}
                aria-describedby={fieldErrors.sourceCommit ? 'ca-release-commit-error' : undefined}
                placeholder={t('40 或 64 位十六进制 Git 提交哈希', '40- or 64-character hex Git commit hash')}
                value={relSourceCommit}
                onChange={e => {
                  setRelSourceCommit(e.target.value);
                  clearFieldError('sourceCommit');
                }}
              />
              {fieldErrors.sourceCommit && (
                <p id="ca-release-commit-error" className="ca-error-text" role="alert">
                  {fieldErrors.sourceCommit}
                </p>
              )}
            </div>
          )}

          {relFormat !== 'apk' && (
            <div className="ca-field">
              <div className="ca-field-head">
                <label className="ca-field-label" htmlFor="ca-release-sig">
                  {t('更新签名 (.sig 内容)', 'Update Signature (.sig content)')} <span className="ca-req">*</span>
                </label>
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-sm"
                  onClick={() => sigFileInputRef.current?.click()}
                >
                  {t('选择 .sig 文件', 'Choose .sig file')}
                </button>
              </div>
              <textarea
                id="ca-release-sig"
                ref={signatureInputRef}
                rows={2}
                className="ca-textarea ca-mono"
                aria-invalid={Boolean(fieldErrors.signature) || undefined}
                aria-describedby={fieldErrors.signature ? 'ca-release-sig-error' : undefined}
                placeholder={t('拖入或选择 .sig 文件自动填充，或粘贴更新签名内容', 'Drop or choose a .sig file to auto-fill, or paste the signature content')}
                value={relSignature}
                onChange={e => {
                  setRelSignature(e.target.value);
                  clearFieldError('signature');
                }}
              />
              {fieldErrors.signature && (
                <p id="ca-release-sig-error" className="ca-error-text" role="alert">
                  {fieldErrors.signature}
                </p>
              )}
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-release-notes">
              {t('更新说明（可选）', 'Release Notes (optional)')}
            </label>
            <input
              id="ca-release-notes"
              ref={notesInputRef}
              type="text"
              className="ca-input"
              aria-invalid={Boolean(fieldErrors.notes) || undefined}
              aria-describedby={fieldErrors.notes ? 'ca-release-notes-error' : undefined}
              placeholder={t('简述此版本修复或新增内容', 'Briefly describe fixes or new features')}
              value={relNotes}
              onChange={e => {
                setRelNotes(e.target.value);
                clearFieldError('notes');
              }}
            />
            {fieldErrors.notes && (
              <p id="ca-release-notes-error" className="ca-error-text" role="alert">
                {fieldErrors.notes}
              </p>
            )}
          </div>

          <label className="ca-check-label">
            <input
              type="checkbox"
              checked={publishImmediately}
              onChange={e => setPublishImmediately(e.target.checked)}
            />
            <span>{t('上传后立即发布给客户端检查更新（默认保存为草稿）', 'Publish immediately for client update checks (saves as draft by default)')}</span>
          </label>

          <div className="ca-disclosure">
            <button
              type="button"
              className="ca-disclosure-btn"
              aria-expanded={shaDisclosureOpen}
              onClick={() => setShaDisclosureOpen(prev => !prev)}
            >
              <span>
                {shaDisclosureOpen ? '▾' : '▸'}{' '}
                {t('SHA-256 校验值（自动计算，可展开核对或修改）', 'SHA-256 checksum (auto-computed, expand to inspect or edit)')}
              </span>
            </button>
            {shaDisclosureOpen && (
              <div className="ca-disclosure-body smooth-expand-mount">
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor="ca-release-sha256">
                    SHA-256 <span className="ca-req">*</span>
                  </label>
                  <input
                    id="ca-release-sha256"
                    ref={sha256InputRef}
                    type="text"
                    className="ca-input ca-mono"
                    aria-invalid={Boolean(fieldErrors.sha256) || undefined}
                    aria-describedby={fieldErrors.sha256 ? 'ca-release-sha256-error' : undefined}
                    placeholder={t('选择安装包后自动计算', 'Computed automatically after selecting a package')}
                    value={relSha256}
                    onChange={e => {
                      setRelSha256(e.target.value);
                      clearFieldError('sha256');
                    }}
                  />
                  {fieldErrors.sha256 && (
                    <p id="ca-release-sha256-error" className="ca-error-text" role="alert">
                      {fieldErrors.sha256}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="ca-modal-footer">
            <button
              type="button"
              className="ca-btn"
              disabled={relBusy}
              onClick={() => {
                setUploadError('');
                setUploadNeedsBrowser(false);
                setFieldErrors({});
                setUploadModalOpen(false);
              }}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={relBusy || hashing}
            >
              <LabelStack
                active={
                  relBusy
                    ? t('上传中…', 'Uploading…')
                    : hashing
                      ? t('计算校验中…', 'Hashing…')
                      : publishImmediately
                        ? t('上传并发布', 'Upload & Publish')
                        : t('上传为草稿', 'Upload Draft')
                }
                labels={[
                  t('上传并发布', 'Upload & Publish'),
                  t('上传为草稿', 'Upload Draft'),
                  t('计算校验中…', 'Hashing…'),
                  t('上传中…', 'Uploading…'),
                ]}
              />
            </button>
          </div>
        </form>
      </CaModal>
    </div>
  );
}
