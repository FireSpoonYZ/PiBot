// host-core/codemode-presentations.js
// codemode 子调用 presentation 透传装饰器（不改 SDK）。
// SDK 的 CodemodeToolDetails.calls 终态行只有 {id,name,args,status,durationMs,error}，
// 嵌套调用一结算 live slot.details 即删，快速 todo 子调用丢专用卡；而同一次
// api.executeTool 返回的 NestedToolExecutionResult.details 带着子工具发布的完整
// presentation。本装饰器按 `c<VM call id>` key 捕获经白名单投影的 presentation，
// 合并进 result.details.calls 同 id 行：只加这一个有界字段，无捕获行不补造。

import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode';
import { projectToolPresentation, toolPresentationBytes } from './tool-presentation.js';
import { MAX_NESTED_CALLS, MAX_NESTED_CALLS_BYTES } from './tool-call-summary.js';

/** SDK callTool 只传 key `c<VM call id>`（call.id 为 1,2,...）；其他形状不猜 id。 */
function rowIdFromKey(key) {
  if (typeof key !== 'string' || key[0] !== 'c') return undefined;
  const id = Number(key.slice(1));
  return Number.isSafeInteger(id) && id >= 1 ? id : undefined;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** details.calls 中 id 精确相同的行补 presentation；无捕获或无 calls 时原样返回。 */
function mergeCalls(value, presentations) {
  if (presentations.size === 0 || !isObject(value) || !Array.isArray(value.calls)) {
    return value;
  }
  let calls = null;
  for (let i = 0; i < value.calls.length; i++) {
    const presentation = presentations.get(value.calls[i].id);
    if (presentation === undefined) continue;
    if (calls === null) calls = value.calls.slice();
    calls[i] = { ...value.calls[i], presentation };
  }
  return calls === null ? value : { ...value, calls };
}

/** 包装 codemode 工具的 execute；捕获表只活在本调用内，受 nestedCalls 同预算约束。 */
function wrapCodemodeExecute(execute) {
  return (args, api, context) => {
    const presentations = new Map();
    let presentationsBytes = 0;
    let presentationsTruncated = false;
    const wrappedApi = {
      ...api,
      executeTool: async (name, toolArgs, callContext, options) => {
        const result = await api.executeTool(name, toolArgs, callContext, options);
        const id = rowIdFromKey(options?.key);
        if (id === undefined) return result;
        const presentation = projectToolPresentation(result.details);
        if (presentation === null) return result;
        if (presentations.has(id)) {
          // 同 key 重捕获（safe-rerun 返回同一嵌套结果）：覆盖，不重复计预算。
          presentations.set(id, presentation);
          return result;
        }
        const bytes = toolPresentationBytes(presentation);
        if (presentations.size >= MAX_NESTED_CALLS ||
            presentationsBytes + bytes > MAX_NESTED_CALLS_BYTES) {
          presentationsTruncated = true;
          return result;
        }
        presentationsBytes += bytes;
        presentations.set(id, presentation);
        return result;
      },
    };
    return Promise.resolve(execute(args, wrappedApi, context)).then((result) => {
      let details = mergeCalls(result.details, presentations);
      if (presentationsTruncated && isObject(details)) {
        if (details === result.details) details = { ...details };
        details.nestedPresentationsTruncated = true;
      }
      return details === result.details ? result : { ...result, details };
    });
  };
}

/** 装饰 createCodemodeExtension 返回的扩展：仅替换 codemode 工具的 execute。 */
export function withCodemodePresentations(extension) {
  return {
    ...extension,
    tools: extension.tools.map((tool) =>
      tool.name === CODEMODE_TOOL_NAME
        ? { ...tool, execute: wrapCodemodeExecute(tool.execute) }
        : tool),
  };
}
