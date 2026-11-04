import { createInitialState, createContentStore } from 'acp-kernel';

export const BC_KERNEL_VERSION = '0.0.101';

// 会话级压缩状态快照：kernel 投影独立持久化，prepared 预留给重试幂等。
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
  checkpointWhen: () => false,
});
