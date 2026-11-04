// 图片附件前端共享层：本机/远端/桌面三端共用。
// - 浏览器侧选图（input type=file）+ canvas 归一化为 PNG/JPEG，最长边与文件大小遵守合同上限；
// - 预览/历史缩略图只存 ImageAttachment 元数据 + 内存 dataURL，绝不把 base64 写进草稿或 pending；
// - 获取已提交附件内容统一走 fetcher（本机 BotHost.call、远端 api.call），按 attachmentId 缓存。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImagePickError('IMAGE_DECODE_FAILED', '无法解码所选图片'));
    };
    img.src = url;
  });
}

function drawToCanvas(img: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImagePickError('IMAGE_ENCODE_FAILED', '当前环境不支持图片处理');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasBytes(canvas: HTMLCanvasElement, type: ImageMime, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new ImagePickError('IMAGE_ENCODE_FAILED', '图片压缩失败'));
          return;
        }
        fileToBytes(blob).then(resolve, () => reject(new ImagePickError('IMAGE_ENCODE_FAILED', '图片压缩失败')));
      },
      type,
      quality,
    );
  });
}

function hasAlphaFast(source: CanvasImageSource, width: number, height: number): boolean {
  // 低分辨率采样判断是否存在透明像素；不透明则优先 JPEG 以换取体积。
  const probe = 64;
  const canvas = drawToCanvas(source, Math.min(probe, Math.max(1, Math.round(width))), Math.min(probe, Math.max(1, Math.round(height))));
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
export async function normalizeImageFile(file: File | Blob, name?: string): Promise<PickedImageSource> {
  const img = await loadImage(file);
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  if (!sourceW || !sourceH) throw new ImagePickError('IMAGE_DECODE_FAILED', '无法读取图片尺寸');

  // 先按长边，再按 canvas 软像素预算取更严的缩放（防 16384² 级内存峰值）。
  let scale = Math.min(
    1,
    IMAGE_MAX_EDGE / Math.max(sourceW, sourceH),
    Math.sqrt(IMAGE_MAX_PIXELS / (sourceW * sourceH)),
  );
  const preferJpeg = (file.type === 'image/jpeg' || file.type === 'image/jpg' || file.type === 'image/webp' || file.type === '')
    && !hasAlphaFast(img, sourceW, sourceH);

  for (let pass = 0; pass <= MAX_SCALE_PASSES; pass += 1) {
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));
    const canvas = drawToCanvas(img, w, h);
    const mime: ImageMime = preferJpeg || file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    if (mime === 'image/jpeg') {
      for (const q of JPEG_QUALITY_STEPS) {
        const bytes = await canvasBytes(canvas, 'image/jpeg', q);
        if (bytes.length <= IMAGE_MAX_BYTES) {
          return { name: attachmentFileName(name ?? '', 'image/jpeg'), mimeType: 'image/jpeg', data: bytesToBase64(bytes), size: bytes.length, width: w, height: h };
        }
      }
    } else {
      const bytes = await canvasBytes(canvas, 'image/png');
      if (bytes.length <= IMAGE_MAX_BYTES) {
        return { name: attachmentFileName(name ?? '', 'image/png'), mimeType: 'image/png', data: bytesToBase64(bytes), size: bytes.length, width: w, height: h };
      }
    }
    scale *= 0.7;
  }
  throw new ImagePickError('IMAGE_TOO_LARGE', '图片超出大小限制（16MiB）');
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
export function useAttachmentImageCache(fetcher: AttachmentFetcher | null): {
  urlFor(attachmentId: string): string | null;
  ensure(attachmentId: string): void;
  errorFor(attachmentId: string): string | null;
} {
  const cacheRef = useRef(new Map<string, { url: string | null; error: string | null; loading: boolean }>());
  const [, bump] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const ensure = useCallback((attachmentId: string) => {
    const cache = cacheRef.current;
    const cur = cache.get(attachmentId);
    if (!attachmentId || cur?.loading || cur?.url || cur?.error) return;
    cache.set(attachmentId, { url: null, error: null, loading: true });
    bump((v) => v + 1);
    const run = fetcherRef.current;
    if (!run) {
      cache.set(attachmentId, { url: null, error: '无法读取附件', loading: false });
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
        cache.set(attachmentId, { url: null, error: message || '读取失败', loading: false });
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

/** 缩略图：上传后/历史中的 ImageAttachment 元数据，点击放大；失败显示可读错误。 */
export function ImageAttachmentThumb({ attachment, fetcher, disabled, onRemove, t }: {
  attachment: ImageAttachment;
  fetcher: AttachmentFetcher | null;
  disabled?: boolean;
  onRemove?: () => void;
  t: (zh: string, en: string) => string;
}) {
  const cache = useAttachmentImageCache(fetcher);
  const [open, setOpen] = useState(false);
  const url = cache.urlFor(attachment.id);
  const error = cache.errorFor(attachment.id);

  useEffect(() => {
    cache.ensure(attachment.id);
  }, [cache, attachment.id]);

  const alt = attachment.name || t('图片附件', 'Image attachment');
  return (
    <span className="image-attachment" data-attachment-id={attachment.id}>
      <button
        type="button"
        className="image-attachment-open"
        onClick={() => url && setOpen(true)}
        aria-label={alt}
      >
        {url ? (
          <img src={url} alt={alt} width={attachment.width} height={attachment.height} />
        ) : error ? (
          <span className="image-attachment-error" role="status">
            {t('图片读取失败', 'Failed to load image')}
          </span>
        ) : (
          <span className="image-attachment-loading" role="status">
            {t('加载中…', 'Loading…')}
          </span>
        )}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="remove-attachment"
          disabled={disabled}
          onClick={onRemove}
          aria-label={t('移除', 'Remove')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
          >
            <Dialog.Title className="sr-only">{alt}</Dialog.Title>
            {url ? <img src={url} alt={alt} /> : null}
            <Dialog.Close asChild>
              <button type="button" className="image-attachment-viewer-close" aria-label={t('关闭', 'Close')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
        <ImageAttachmentThumb key={att.id} attachment={att} fetcher={fetcher} t={t} />
      ))}
    </div>
  );
}
