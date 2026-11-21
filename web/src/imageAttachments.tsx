// 图片附件前端共享层：本机/远端/桌面三端共用。
// - 浏览器侧选图（input type=file）+ canvas 归一化为 PNG/JPEG，最长边与文件大小遵守合同上限；
// - 预览/历史缩略图只存 ImageAttachment 元数据 + 内存 dataURL，绝不把 base64 写进草稿或 pending；
// - 获取已提交附件内容统一走 fetcher（本机 BotHost.call、远端 api.call），按 attachmentId 缓存。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ImageAttachment, ImageAttachmentData } from '../../host-core/index.js';
import { useText } from './ui';

export type { ImageAttachment, ImageAttachmentData };

/** 与合同一致的本地归一化上限；上传前再按服务端校验。 */
export const IMAGE_MAX_EDGE = 16384;
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 16;
/** 一次选图/每条消息的图片总字节上限（解码后）。 */
export const IMAGE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 上传文件名上限（UTF-8 字节），与 native 统一。 */
export const IMAGE_NAME_MAX_BYTES = 256;
const JPEG_QUALITY_STEPS = [0.85, 0.72, 0.58, 0.45, 0.34];
const MAX_SCALE_PASSES = 3;
// canvas 解码软像素预算：超大图自动缩放到预算内（内存保护，不对可缩放来源报错）。
const IMAGE_MAX_PIXELS = 32 * 1024 * 1024;

type ImageMime = ImageAttachment['mimeType'];
type TranslateFn = (zh: string, en: string) => string;

function defaultImageText(zh: string, en: string): string {
  const docLang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
  const lang = docLang || (typeof navigator !== 'undefined' ? navigator.language : '');
  return lang.toLowerCase().startsWith('en') ? en : zh;
}

/** 原生选图返回的单张图片（与 web/src/native BotHostImage 同形；这里避免反向依赖 native 入口）。 */
export interface PickedImageSource {
  name: string;
  mimeType: ImageMime;
  /** 纯 base64（无 data: 前缀）。 */
  data: string;
  size: number;
  width: number;
  height: number;
}

/** 会话内按需取图：返回完整附件（含 data）。 */
export type AttachmentFetcher = (attachmentId: string) => Promise<ImageAttachmentData>;

export class ImagePickError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImagePickError';
    this.code = code;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 保证文件名非空、≤256 UTF-8 bytes，并按输出 mime 归一扩展名（与 native 命名一致）。 */
export function attachmentFileName(rawName: string, mimeType: ImageMime): string {
  const ext = mimeType === 'image/png' ? '.png' : '.jpg';
  let base = (rawName || '').trim().replace(/[\\/]/g, '_');
  // 去掉既有图片扩展名再统一补目标扩展名，避免 photo.png.jpg。
  base = base.replace(/\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i, '');
  if (!base) base = 'image';
  while (utf8Bytes(base + ext) > IMAGE_NAME_MAX_BYTES && base.length > 0) {
    base = base.slice(0, Math.max(1, Math.floor(base.length * 0.8)));
  }
  if (!base) base = 'image';
  return base + ext;
}

function fileToBytes(file: File | Blob): Promise<Uint8Array> {
  return file.arrayBuffer().then((buf) => new Uint8Array(buf));
}

function bytesToBase64(bytes: Uint8Array): string {
  // 分块拼接避免参数上限；归一化后已 ≤16MiB，开销可控。
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function loadImage(blob: Blob, t: TranslateFn): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImagePickError('IMAGE_DECODE_FAILED', t('无法解码所选图片', 'Unable to decode the selected image')));
    };
    img.src = url;
  });
}

function drawToCanvas(img: CanvasImageSource, width: number, height: number, t: TranslateFn): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImagePickError('IMAGE_ENCODE_FAILED', t('当前环境不支持图片处理', 'Image processing is not supported in this environment'));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasBytes(canvas: HTMLCanvasElement, type: ImageMime, t: TranslateFn, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new ImagePickError('IMAGE_ENCODE_FAILED', t('图片压缩失败', 'Failed to compress image')));
          return;
        }
        fileToBytes(blob).then(resolve, () => reject(new ImagePickError('IMAGE_ENCODE_FAILED', t('图片压缩失败', 'Failed to compress image'))));
      },
      type,
      quality,
    );
  });
}

function hasAlphaFast(source: CanvasImageSource, width: number, height: number, t: TranslateFn): boolean {
  // 低分辨率采样判断是否存在透明像素；不透明则优先 JPEG 以换取体积。
  const probe = 64;
  const canvas = drawToCanvas(source, Math.min(probe, Math.max(1, Math.round(width))), Math.min(probe, Math.max(1, Math.round(height))), t);
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * 归一化到合同约束：最长边 ≤16384、文件 ≤16MiB、mime PNG/JPEG。
 * canvas 软像素预算 32Mi px：超预算来源自动缩放进预算（内存保护，不直接报超限）。
 * JPEG 逐步降质；仍超限则等比缩放后重试；仍超限抛 IMAGE_TOO_LARGE，调用方必须可见化且不静默丢弃草稿。
 */
export async function normalizeImageFile(
  file: File | Blob,
  name?: string,
  t: TranslateFn = defaultImageText,
): Promise<PickedImageSource> {
  const img = await loadImage(file, t);
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  if (!sourceW || !sourceH) throw new ImagePickError('IMAGE_DECODE_FAILED', t('无法读取图片尺寸', 'Unable to read image dimensions'));

  // 先按长边，再按 canvas 软像素预算取更严的缩放（防 16384² 级内存峰值）。
  let scale = Math.min(
    1,
    IMAGE_MAX_EDGE / Math.max(sourceW, sourceH),
    Math.sqrt(IMAGE_MAX_PIXELS / (sourceW * sourceH)),
  );
  const preferJpeg = (file.type === 'image/jpeg' || file.type === 'image/jpg' || file.type === 'image/webp' || file.type === '')
    && !hasAlphaFast(img, sourceW, sourceH, t);

  for (let pass = 0; pass <= MAX_SCALE_PASSES; pass += 1) {
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));
    const canvas = drawToCanvas(img, w, h, t);
    const mime: ImageMime = preferJpeg || file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    if (mime === 'image/jpeg') {
      for (const q of JPEG_QUALITY_STEPS) {
        const bytes = await canvasBytes(canvas, 'image/jpeg', t, q);
        if (bytes.length <= IMAGE_MAX_BYTES) {
          return { name: attachmentFileName(name ?? '', 'image/jpeg'), mimeType: 'image/jpeg', data: bytesToBase64(bytes), size: bytes.length, width: w, height: h };
        }
      }
    } else {
      const bytes = await canvasBytes(canvas, 'image/png', t);
      if (bytes.length <= IMAGE_MAX_BYTES) {
        return { name: attachmentFileName(name ?? '', 'image/png'), mimeType: 'image/png', data: bytesToBase64(bytes), size: bytes.length, width: w, height: h };
      }
    }
    scale *= 0.7;
  }
  throw new ImagePickError('IMAGE_TOO_LARGE', t('图片超出大小限制（16MiB）', 'Image exceeds the 16MiB size limit'));
}

/** 从剪贴板 DataTransfer 提取所有 image/* File（优先 files，空则回退 items.getAsFile()，不重复添加）。 */
export function extractPastedImageFiles(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return [];
  const fromFiles = Array.from(clipboardData.files ?? []).filter((file) => file.type.startsWith('image/'));
  if (fromFiles.length > 0) return fromFiles;
  const fromItems: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

/** 浏览器/桌面选图入口：多选、逐个归一化；任一张失败整体中止并抛错（不上传半成品）。
 *  onSettled 在选图完成（成功/取消）后调用，便于释放"选择中"锁。 */
export function pickImagesFromInput(options: {
  multiple?: boolean;
  onPicked: (files: File[]) => Promise<void>;
  onSettled?: () => void;
}): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (options.multiple !== false) input.multiple = true;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length === 0) {
      options.onSettled?.();
      return;
    }
    void options.onPicked(files).finally(() => options.onSettled?.());
  };
  input.addEventListener('cancel', () => options.onSettled?.());
  input.click();
}

/** 附件内容 SHA-256 的小写 hex（与 backend id 规则一致）；用于客户端重复选择去重。 */
export async function attachmentIdOf(dataBase64: string): Promise<string> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 会话内按需取图：attachmentId → dataURL 缓存；不落盘、不进 localStorage。 */
export function useAttachmentImageCache(fetcher: AttachmentFetcher | null, translate?: TranslateFn): {
  urlFor(attachmentId: string): string | null;
  ensure(attachmentId: string): void;
  errorFor(attachmentId: string): string | null;
} {
  const fallbackT = useText();
  const translateRef = useRef<TranslateFn>(translate ?? fallbackT);
  translateRef.current = translate ?? fallbackT;
  const cacheRef = useRef(new Map<string, { url: string | null; error: string | null; loading: boolean }>());
  const [, bump] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const ensure = useCallback((attachmentId: string) => {
    const t = translateRef.current;
    const cache = cacheRef.current;
    const cur = cache.get(attachmentId);
    if (!attachmentId || cur?.loading || cur?.url || cur?.error) return;
    cache.set(attachmentId, { url: null, error: null, loading: true });
    bump((v) => v + 1);
    const run = fetcherRef.current;
    if (!run) {
      cache.set(attachmentId, { url: null, error: t('无法读取附件', 'Unable to read attachment'), loading: false });
      bump((v) => v + 1);
      return;
    }
    void run(attachmentId).then(
      (full) => {
        if (cacheRef.current.get(attachmentId)?.loading !== true) return;
        const url = 'data:' + full.mimeType + ';base64,' + full.data;
        cache.set(attachmentId, { url, error: null, loading: false });
        bump((v) => v + 1);
      },
      (e) => {
        const message = e instanceof Error ? e.message : String(e);
        cache.set(attachmentId, { url: null, error: message || t('读取失败', 'Failed to load'), loading: false });
        bump((v) => v + 1);
      },
    );
  }, []);

  const urlFor = useCallback((attachmentId: string): string | null => {
    return cacheRef.current.get(attachmentId)?.url ?? null;
  }, []);

  const errorFor = useCallback((attachmentId: string): string | null => {
    return cacheRef.current.get(attachmentId)?.error ?? null;
  }, []);

  useEffect(() => () => {
    cacheRef.current.clear();
  }, []);

  return useMemo(() => ({ urlFor, ensure, errorFor }), [urlFor, ensure, errorFor]);
}

const SENT_IMAGE_MAX_HEIGHT = 'var(--sent-image-max-h, min(70vh, 600px))';
const SENT_IMAGE_FALLBACK_MAX_WIDTH = '320px';

function hasValidImageDimensions(width: unknown, height: unknown): boolean {
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

/**
 * 为已发送图片占位与加载后的 <img> 计算完全一致的容器尺寸约束：
 * - 有元数据时使用 aspect-ratio: width / height 与同一套 width / max-width / max-height
 *   （max-width 同时受 max-height * (width / height) 与原图宽度限制，保证竖图/小图加载前后尺寸完全一致）；
 * - 缺少元数据时回退到 4 / 3 占位比例。
 */
export function resolveSentAttachmentBoxStyle(
  width: number | undefined,
  height: number | undefined,
  options?: { forLoadedImage?: boolean },
): CSSProperties {
  if (hasValidImageDimensions(width, height)) {
    const w = Math.round(width as number);
    const h = Math.round(height as number);
    const ratio = Number((w / h).toFixed(6));
    return {
      aspectRatio: `${w} / ${h}`,
      width: '100%',
      maxWidth: `min(100%, ${w}px, calc(${SENT_IMAGE_MAX_HEIGHT} * ${ratio}))`,
      height: 'auto',
      maxHeight: SENT_IMAGE_MAX_HEIGHT,
      marginInline: 'auto',
      ...(options?.forLoadedImage ? { display: 'block', objectFit: 'contain' } : {}),
    };
  }
  if (options?.forLoadedImage) {
    return {
      display: 'block',
      width: 'auto',
      height: 'auto',
      maxWidth: '100%',
      maxHeight: SENT_IMAGE_MAX_HEIGHT,
      objectFit: 'contain',
      marginInline: 'auto',
    };
  }
  return {
    aspectRatio: '4 / 3',
    width: '100%',
    maxWidth: `min(100%, ${SENT_IMAGE_FALLBACK_MAX_WIDTH}, calc(${SENT_IMAGE_MAX_HEIGHT} * 1.333333))`,
    height: 'auto',
    maxHeight: SENT_IMAGE_MAX_HEIGHT,
    marginInline: 'auto',
  };
}

/** 缩略图：上传后/历史中的 ImageAttachment 元数据，点击放大；失败显示可读错误。 */
export function ImageAttachmentThumb({ attachment, fetcher, disabled, onRemove, sent = false, t }: {
  attachment: ImageAttachment;
  fetcher: AttachmentFetcher | null;
  disabled?: boolean;
  onRemove?: () => void;
  /** 消息流已发送附件：占位与加载后图片使用完全一致的 aspect-ratio / width / max-height 约束。 */
  sent?: boolean;
  t: (zh: string, en: string) => string;
}) {
  const cache = useAttachmentImageCache(fetcher, t);
  const [open, setOpen] = useState(false);
  const url = cache.urlFor(attachment.id);
  const error = cache.errorFor(attachment.id);

  useEffect(() => {
    cache.ensure(attachment.id);
  }, [cache, attachment.id]);

  const alt = attachment.name || t('图片附件', 'Image attachment');
  const validDims = hasValidImageDimensions(attachment.width, attachment.height);
  const placeholderStyle = sent
    ? resolveSentAttachmentBoxStyle(attachment.width, attachment.height)
    : undefined;
  const loadedImageStyle = sent
    ? resolveSentAttachmentBoxStyle(attachment.width, attachment.height, { forLoadedImage: true })
    : undefined;
  return (
    <span className="image-attachment" data-attachment-id={attachment.id}>
      <button
        type="button"
        className="image-attachment-open"
        data-loaded={url ? 'true' : undefined}
        onClick={() => url && setOpen(true)}
        aria-label={alt}
        title={url ? t('点击查看大图', 'Click to view full image') : alt}
      >
        {url ? (
          <img
            src={url}
            alt={alt}
            width={validDims ? attachment.width : undefined}
            height={validDims ? attachment.height : undefined}
            style={loadedImageStyle}
          />
        ) : error ? (
          <span className="image-attachment-error" role="status" style={placeholderStyle}>
            {t('图片读取失败', 'Failed to load image')}
          </span>
        ) : (
          <span className="image-attachment-loading" role="status" style={placeholderStyle}>
            {t('加载中…', 'Loading…')}
          </span>
        )}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="remove-attachment"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={t('移除', 'Remove')}
          title={t('移除', 'Remove')}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ) : null}
      <Dialog.Root open={open && Boolean(url)} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-attachment-viewer" />
          <Dialog.Content
            className="image-attachment-viewer-content"
            aria-describedby={undefined}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <Dialog.Title className="sr-only">{alt}</Dialog.Title>
            {url ? <img src={url} alt={alt} /> : null}
            <Dialog.Close asChild>
              <button
                type="button"
                className="image-attachment-viewer-close"
                aria-label={t('关闭', 'Close')}
                title={t('关闭', 'Close')}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}

/** 消息流中的附件区（sent）：只读、按需取图，不显示 base64。 */
export function SentAttachments({ attachments, fetcher }: {
  attachments: ImageAttachment[];
  fetcher: AttachmentFetcher | null;
}) {
  const t = useText();
  if (!attachments.length) return null;
  return (
    <div className="attachments sent" role="group" aria-label={t('附件', 'Attachments')}>
      {attachments.map((att) => (
        <ImageAttachmentThumb key={att.id} attachment={att} fetcher={fetcher} sent t={t} />
      ))}
    </div>
  );
}
