import { defineDocFamily } from '@earendil-works/pi-durable';

// Contract A：一次生成任务的 Host 侧准备失败诊断，供 work 对账与 LIVE 投影消费。
// 会话作用域 + 家族键 String(generationTaskId)：不用任务作用域，任务终态回收后
// 诊断仍可读；generation 重启换 taskId 时保留旧诊断键，互不覆盖。
export const GenerationFailureState = defineDocFamily({
  kind: 'host.generation-failure',
  version: 1,
  scope: 'conversation',
  family: true,
  history: 'latest',
  fork: 'initial',
  initial: () => ({ failure: null }),
  checkpointWhen: () => false,
});
