import type { DesktopPickedImage } from './types';

export interface DataTransferItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

export interface DataTransferLike {
  readonly files?: ArrayLike<File> | Iterable<File> | null;
  readonly items?: ArrayLike<DataTransferItemLike> | Iterable<DataTransferItemLike> | null;
  getData?(format: string): string;
}

export interface PasteImageDecision {
  /** 有效的非零字节 DOM 图片文件（优先 files，空则回退 items.getAsFile()）。 */
  files: File[];
  /** 是否应阻止默认粘贴（仅 DOM 有有效图片且纯文本为空时为 true）。 */
  preventDefault: boolean;
  /** 是否应在桌面 Linux 上补读原生剪贴板图片。 */
  useNativeClipboardFallback: boolean;
}

/** 仅把 type 为 image/* 且 size > 0 的文件视为有效粘贴图片；零字节文件不算有效图片。 */
export function extractValidPastedImageFiles(
  clipboardData: DataTransferLike | null | undefined,
): File[] {
  if (!clipboardData) return [];
  const fromFiles = Array.from(clipboardData.files ?? []).filter(
    (file) => file.type.startsWith('image/') && file.size > 0,
  );
  if (fromFiles.length > 0) return fromFiles;
  const fromItems: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file && file.size > 0) fromItems.push(file);
  }
  return fromItems;
}

/** 桌面 Linux 判定（排除 Android WebView，因其 UA/platform 也含 Linux）。 */
export function isDesktopLinuxPlatform(
  nav: { platform?: string; userAgent?: string } | undefined = typeof navigator !== 'undefined'
    ? navigator
    : undefined,
): boolean {
  if (!nav) return false;
  const ua = (nav.userAgent ?? '').toLowerCase();
  const platform = (nav.platform ?? '').toLowerCase();
  if (ua.includes('android') || platform.includes('android')) return false;
  return platform.includes('linux') || ua.includes('linux');
}

/**
 * 粘贴事件决策：
 * - DOM 有有效非零字节图片：纯文本为空白时 preventDefault，有纯文本时放行文字粘贴并同时收图；
 * - DOM 无有效图片（含 types/files/items 全空或仅零字节图片）：绝不 preventDefault，
 *   仅在桌面 Linux 且纯文本为空（length === 0）时补读原生剪贴板图片。
 */
export function decideImagePasteAction(
  clipboardData: DataTransferLike | null | undefined,
  options: { isDesktopLinux: boolean; hasNativeClipboard: boolean },
): PasteImageDecision {
  const files = extractValidPastedImageFiles(clipboardData);
  const plainText = typeof clipboardData?.getData === 'function'
    ? (clipboardData.getData('text/plain') ?? '')
    : '';
  if (files.length > 0) {
    return {
      files,
      preventDefault: plainText.trim().length === 0,
      useNativeClipboardFallback: false,
    };
  }
  return {
    files: [],
    preventDefault: false,
    useNativeClipboardFallback:
      options.isDesktopLinux && options.hasNativeClipboard && plainText.length === 0,
  };
}

export function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 将桌面原生返回的 base64 图片转为 File，走同一 normalizeImageFile/上传管线，不携带客户端路径。 */
export function pickedImagesToFiles(images: readonly DesktopPickedImage[]): File[] {
  const files: File[] = [];
  for (const img of images) {
    if (!img || typeof img.data !== 'string' || img.data.length === 0) continue;
    const bytes = decodeBase64ToBytes(img.data);
    if (bytes.byteLength === 0) continue;
    const mimeType = typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType
      : 'image/png';
    const name = typeof img.name === 'string' && img.name.trim() ? img.name.trim() : 'image.png';
    files.push(new File([bytes], name, { type: mimeType }));
  }
  return files;
}
