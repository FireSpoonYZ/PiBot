import { createInitialState, createContentStore } from 'acp-kernel';

export const BC_KERNEL_VERSION = '0.0.101';
export const AUTO_FOLD_TARGET_MIN = 8192;
export const AUTO_FOLD_BACKOFF_MS = 10 * 60_000;
export const COMPRESS_FAILURE_PAUSE_THRESHOLD = 3;

// 会话级压缩状态快照：保持 host.bc-context v1 兼容；新增元数据字段在旧快照缺失时按默认值回退。
export const createContextState = (defineDoc) => defineDoc({
  kind: 'host.bc-context',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({
    kernelVersion: BC_KERNEL_VERSION,
    state: createInitialState(),
    contentStore: createContentStore(),
    prepared: null,
  }),
  checkpointWhen: () => true,
});
