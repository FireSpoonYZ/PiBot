import type { JsonObject, Provider, ProviderCheckRequest } from './types';

/** Matches center-server batchModelsSchema maxItems limit (200). */
export const BATCH_SAVE_CHUNK_SIZE = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build a provider discovery probe request that honors unsaved form edits
 * (baseUrl, api, custom JSON overrides, apiKey) without breaking built-in defaults.
 */
export function buildDiscoverRequest(
  provider: Pick<Provider, 'baseUrl' | 'api'>,
  options: {
    deviceId?: string;
    apiKey?: string;
    customJson?: string;
  } = {},
): ProviderCheckRequest {
  const req: ProviderCheckRequest = {};
  const deviceId = options.deviceId?.trim() ?? '';
  if (deviceId) req.deviceId = deviceId;

  const apiKey = options.apiKey?.trim() ?? '';
  if (apiKey) req.apiKey = apiKey;

  let parsedCustom: Record<string, unknown> | null = null;
  if (typeof options.customJson === 'string' && options.customJson.trim()) {
    try {
      const parsed = JSON.parse(options.customJson) as unknown;
      if (isPlainObject(parsed)) parsedCustom = parsed;
    } catch {
      // Ignore malformed draft JSON here; server-side stored settings remain fallback.
    }
  }

  const customBaseUrl =
    typeof parsedCustom?.baseUrl === 'string' ? parsedCustom.baseUrl.trim() : '';
  const formBaseUrl = provider.baseUrl.trim();
  const effectiveBaseUrl = customBaseUrl || formBaseUrl;
  if (effectiveBaseUrl) req.baseUrl = effectiveBaseUrl;

  const customApi =
    typeof parsedCustom?.api === 'string' ? parsedCustom.api.trim() : '';
  const formApi = provider.api.trim();
  const effectiveApi = customApi || formApi;
  if (effectiveApi) req.api = effectiveApi;

  if (parsedCustom && isPlainObject(parsedCustom.headers)) {
    req.headers = parsedCustom.headers as JsonObject;
  }

  return req;
}

export function chunkModelsForBatchSave<T>(
  models: readonly T[],
  chunkSize: number = BATCH_SAVE_CHUNK_SIZE,
): T[][] {
  if (models.length === 0) return [];
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : BATCH_SAVE_CHUNK_SIZE;
  const chunks: T[][] = [];
  for (let i = 0; i < models.length; i += size) {
    chunks.push(models.slice(i, i + size));
  }
  return chunks;
}

export async function saveModelsInChunks<T extends { id: string }>(
  models: readonly T[],
  saveBatch: (batch: T[]) => Promise<unknown>,
  chunkSize: number = BATCH_SAVE_CHUNK_SIZE,
): Promise<{ savedIds: string[]; failedError?: unknown }> {
  const chunks = chunkModelsForBatchSave(models, chunkSize);
  const savedIds: string[] = [];
  for (const batch of chunks) {
    try {
      await saveBatch(batch);
      for (const item of batch) savedIds.push(item.id);
    } catch (err) {
      return { savedIds, failedError: err };
    }
  }
  return { savedIds };
}

export function selectVisibleModelIds(
  currentSelected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const next = new Set(currentSelected);
  for (const id of visibleIds) next.add(id);
  return next;
}

export function deselectVisibleModelIds(
  currentSelected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const next = new Set(currentSelected);
  for (const id of visibleIds) next.delete(id);
  return next;
}

export function areAllVisibleSelected(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): boolean {
  if (visibleIds.length === 0) return false;
  for (const id of visibleIds) {
    if (!selected.has(id)) return false;
  }
  return true;
}
