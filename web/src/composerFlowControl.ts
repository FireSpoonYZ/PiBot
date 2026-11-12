import type {
  ImageAttachment,
  PendingRecord,
  QueuedTurnItem,
  TurnDeliveryMode,
} from '../../host-core/index.js';
import type { ChatTurn } from './chatTurnModel.ts';

export const HOST_ATTACHED_IMAGE_LINE_PREFIX =
  'Attached image on this Host (use this path to read or send the file): ';

const DEFAULT_MAX_ATTACHMENTS = 16;
const MAX_PREVIEW_CODEPOINTS = 80;

export interface UnifiedQueuedStripItem {
  requestId: string;
  preview: string;
  delivery: TurnDeliveryMode;
  attachmentCount: number;
  source: 'host' | 'outbox';
  outboxRecord?: Extract<PendingRecord, { kind: 'primary' }>;
}

/**
 * Strip Host-appended `Attached image on this Host ...` lines (and any blank
 * separator lines right before them) when hydrating an image-bearing historical
 * user message back into the bottom composer for editing.
 */
export function extractEditableUserText(rawText: string): string {
  if (typeof rawText !== 'string' || !rawText) return '';
  const lines = rawText.split('\n');
  let end = lines.length;
  let strippedAttachmentLine = false;
  while (end > 0) {
    const line = lines[end - 1].replace(/\r$/, '');
    if (line.startsWith(HOST_ATTACHED_IMAGE_LINE_PREFIX)) {
      strippedAttachmentLine = true;
      end -= 1;
      continue;
    }
    if (strippedAttachmentLine && line.trim() === '') {
      end -= 1;
      continue;
    }
    break;
  }
  return strippedAttachmentLine ? lines.slice(0, end).join('\n') : rawText;
}

/**
 * Only persisted primary-channel user messages are eligible for historical edit.
 * Optimistic bubbles (non-integer IDs), streaming turns, and room/dm/host turns
 * are never editable.
 */
export function isEditablePrimaryUserTurn(
  turn: Pick<ChatTurn, 'role' | 'entryId' | 'attribution' | 'isStreaming'> | null | undefined,
): boolean {
  if (!turn || turn.role !== 'user' || turn.isStreaming) return false;
  if (!Number.isSafeInteger(turn.entryId) || turn.entryId <= 0) return false;
  if (!turn.attribution) return true;
  return turn.attribution.kind === 'user' && turn.attribution.channel === 'primary';
}

/**
 * Merge withdrawn queued message texts ahead of any unsent draft currently in
 * the input box so the user never loses half-typed work.
 */
export function mergeWithdrawnIntoDraft(
  currentDraft: string,
  withdrawnTexts: readonly string[],
): string {
  const recalledParts = withdrawnTexts
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  if (recalledParts.length === 0) return currentDraft;
  const recalledBlock = recalledParts.join('\n\n');
  if (typeof currentDraft !== 'string' || currentDraft.trim().length === 0) {
    return recalledBlock;
  }
  return `${recalledBlock}\n\n${currentDraft}`;
}

/**
 * Prepend recalled attachment metadata ahead of existing composer attachments,
 * deduplicating by attachment ID and respecting maxCount.
 */
export function dedupeAttachmentMetas(
  existing: readonly ImageAttachment[],
  incoming: readonly ImageAttachment[],
  maxCount = DEFAULT_MAX_ATTACHMENTS,
): ImageAttachment[] {
  const seen = new Set<string>();
  const out: ImageAttachment[] = [];
  for (const list of [incoming, existing]) {
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= maxCount) return out;
    }
  }
  return out;
}

/**
 * Resolve already-uploaded Host attachment IDs back into `ImageAttachment`
 * metadata so recalled queued messages keep their thumbnails without re-upload.
 */
export async function resolveAttachmentMetasByIds(
  ids: readonly string[] | undefined,
  fetchAttachment:
    | ((attachmentId: string) => Promise<ImageAttachment | { attachment?: ImageAttachment }>)
    | null,
): Promise<ImageAttachment[]> {
  if (!ids || ids.length === 0 || !fetchAttachment) return [];
  const uniqueIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const settled = await Promise.allSettled(
    uniqueIds.map(async id => {
      const res = await fetchAttachment(id);
      const raw: ImageAttachment | undefined =
        res && 'attachment' in res && res.attachment ? res.attachment : (res as ImageAttachment);
      if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
      return {
        id: raw.id,
        name: raw.name,
        mimeType: raw.mimeType,
        size: raw.size,
        width: raw.width,
        height: raw.height,
      } satisfies ImageAttachment;
    }),
  );
  const resolved: ImageAttachment[] = [];
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value) {
      resolved.push(item.value);
    }
  }
  return resolved;
}

function summarizeSingleLinePreview(rawText: string, attachmentCount: number): string {
  const normalized = extractEditableUserText(rawText).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return attachmentCount > 0 ? `[图片 ×${attachmentCount}]` : '';
  }
  const codepoints = Array.from(normalized);
  if (codepoints.length <= MAX_PREVIEW_CODEPOINTS) return normalized;
  return `${codepoints.slice(0, MAX_PREVIEW_CODEPOINTS - 1).join('')}…`;
}

/**
 * Combine Host-published `live.queuedItems` with unsent client-side `pending`
 * primary outbox records into a single deduplicated strip list.
 */
export function mergeQueuedStripItems(
  hostItems: readonly QueuedTurnItem[] | null | undefined,
  outboxRecords?: readonly PendingRecord[] | null,
  botId?: string | null,
  targetDeviceId?: string | null,
): UnifiedQueuedStripItem[] {
  const result: UnifiedQueuedStripItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(hostItems)) {
    for (const item of hostItems) {
      if (!item || typeof item.requestId !== 'string' || !item.requestId || seen.has(item.requestId)) {
        continue;
      }
      seen.add(item.requestId);
      const attachmentCount =
        typeof item.attachmentCount === 'number' && item.attachmentCount > 0
          ? item.attachmentCount
          : 0;
      result.push({
        requestId: item.requestId,
        preview: item.preview || (attachmentCount > 0 ? `[图片 ×${attachmentCount}]` : ''),
        delivery: item.delivery === 'steer' ? 'steer' : 'followUp',
        attachmentCount,
        source: 'host',
      });
    }
  }
  if (Array.isArray(outboxRecords)) {
    for (const rec of outboxRecords) {
      if (rec.kind !== 'primary' || rec.state !== 'pending') continue;
      if (botId && rec.botId !== botId) continue;
      if (targetDeviceId && rec.targetDeviceId !== targetDeviceId) continue;
      if (seen.has(rec.requestId)) continue;
      seen.add(rec.requestId);
      const attachmentCount = Array.isArray(rec.attachments) ? rec.attachments.length : 0;
      result.push({
        requestId: rec.requestId,
        preview: summarizeSingleLinePreview(rec.text, attachmentCount),
        delivery: rec.delivery === 'steer' ? 'steer' : 'followUp',
        attachmentCount,
        source: 'outbox',
        outboxRecord: rec,
      });
    }
  }
  return result;
}
