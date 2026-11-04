// host-core/cua-tools.js
// Host 内置 Cua 工具：与固定上游 cua-driver-rs 的 inventory 一对一注册为
// cua_<remoteName>，在已归属的 ready Shower 会话上透传 tools/call。cua 不创建屏、
// 不退回主桌面；环境仍由 shower status/create/launch/release 管理（上游自己的
// launch_app 等在会话内可用）。每次执行作用于可变的真实桌面，故 replay:'unsafe'
// 且串行执行；中止后不自动重放任何输入。
// inventory 来自 cua-driver.js 对固定二进制的只读 CLI metadata（describe），
// 与私有子会话内 MCP tools/list 同源；注册发生在 Harness 打开前的 registry 快照，
// codemode/工具搜索的渐进式发现直接生效，不需要包装器。
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { toLlmContent } from '@earendil-works/pi-mcp';
import {
  CUA_MAX_REQUEST_BYTES,
  CUA_MAX_STRUCTURED_METADATA_BYTES,
  CUA_MAX_TEXT_OUTPUT_BYTES,
  clampCuaObserveArguments,
  isCuaObserveTool,
  normalizeCuaResult,
  normalizeCuaToolArguments,
} from './cua-protocol.js';
import { loadCuaToolInventory } from './cua-driver.js';
import { SHOWER_MAX_FRAME_BASE64_BYTES } from './shower-protocol.js';
import {
  decodeBase64,
  errorOutput,
  frameSize,
  resolveIdentity,
  screenshotModel,
} from './shower-tools.js';

function utf8(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

// codemode 只对声明了 structuredOutputSchema 的工具回传 structuredOutput（无 schema
// 时脚本只见拼接文本、图片被丢弃）；declare 后嵌套结果解析为 {content, isError}。
const CUA_RESULT_SCHEMA = Type.Object({
  content: Type.Array(Type.Union([
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
    Type.Object({ type: Type.Literal('image'), data: Type.String(), mimeType: Type.String() }),
  ])),
  isError: Type.Boolean(),
});

/** output 直接供模型渲染保持不变；structuredOutput 复用同一批已限额/校验块，不透传未限额 raw MCP。 */
function cuaResult(bounded) {
  const isError = bounded.isError === true;
  return { ...bounded, isError, structuredOutput: { content: bounded.output ?? [], isError } };
}

function isImageBlock(block) {
  return block !== null && typeof block === 'object' && !Array.isArray(block) && block.type === 'image';
}

/**
 * toLlmContent 只透传 text/image；structuredContent 需要单独附带。
 * rawContentCount 记录 result.content 原始块数：为 0 时 toLlmContent 已把
 * structuredContent 序列化成 JSON 文本，不再重复追加。
 */
function boundedBlocks(result, limits, rawContentCount) {
  const blocks = toLlmContent(result);
  let textBytes = 0;
  let imageBytes = 0;
  const imageMax = Math.min(SHOWER_MAX_FRAME_BASE64_BYTES, limits?.maxBytes ?? SHOWER_MAX_FRAME_BASE64_BYTES);
  const output = [];
  for (const block of blocks) {
    if (block.type === 'image') {
      // 真实解码校验：非 PNG/JPEG、损坏或与 Shower 同尺寸的解析失败一律为无效响应。
      let size;
      try {
        size = frameSize(decodeBase64(block.data), block.mimeType);
      } catch {
        return errorOutput('SHOWER_BACKEND_FAILED', 'Cua 截图响应无效（非有效 PNG/JPEG base64）');
      }
      if (size.width <= 0 || size.height <= 0
          || size.width > limits.maxWidth || size.height > limits.maxHeight) {
        return errorOutput('SHOWER_FRAME_TOO_LARGE',
          'Cua 截图尺寸 ' + size.width + 'x' + size.height + ' 超过当前模型上限；'
          + '请用更小 max_image_dimension 重新观察后重试（同一动作不自动重放）');
      }
      imageBytes += block.data.length;
      if (block.data.length > imageMax || imageBytes > imageMax) {
        return errorOutput('SHOWER_FRAME_TOO_LARGE',
          'Cua 截图超过 ' + Math.round(imageMax / 1024) + 'KiB base64 上限；'
          + '请用更小 max_image_dimension 重新观察后重试（同一动作不自动重放）');
      }
      output.push({ type: 'image', data: block.data, mimeType: block.mimeType });
      continue;
    }
    textBytes += utf8(block.text);
    if (textBytes > CUA_MAX_TEXT_OUTPUT_BYTES) {
      return errorOutput('RESPONSE_TOO_LARGE', 'Cua 响应文本超过 50 KiB；请用 query/max_elements/max_depth 缩小读取范围后重试');
    }
    output.push({ type: 'text', text: block.text });
  }
  // structuredContent 含 capture_id/snapshot_id 等模型续读元数据；rawContentCount===0 时
  // toLlmContent 已输出其 JSON 文本，不重复追加。
  if (result.structuredContent !== undefined && rawContentCount > 0) {
    const metadata = JSON.stringify(result.structuredContent);
    if (utf8(metadata) > CUA_MAX_STRUCTURED_METADATA_BYTES) {
      return errorOutput('RESPONSE_TOO_LARGE', 'Cua structuredContent 超过 64 KiB 元数据上限');
    }
    if (textBytes + utf8(metadata) > CUA_MAX_TEXT_OUTPUT_BYTES) {
      return errorOutput('RESPONSE_TOO_LARGE', 'Cua 响应文本超过 50 KiB；请用 query/max_elements/max_depth 缩小读取范围后重试');
    }
    output.push({ type: 'text', text: metadata });
  }
  return { output, ...(result.isError === true ? { isError: true } : {}) };
}

/** 上游 content 是否带图：含真实 image 块或 base64 图片资源块才算含图观察。 */
function resultHasImage(result) {
  for (const block of result.content ?? []) {
    if (isImageBlock(block)) return true;
    if (block !== null && typeof block === 'object' && block.type === 'resource'
        && block.resource !== null && typeof block.resource === 'object'
        && typeof block.resource.mimeType === 'string' && block.resource.mimeType.startsWith('image/')
        && typeof block.resource.blob === 'string') return true;
  }
  return false;
}

// 附加在所有上游描述之后的 Shower 约束提示：不改 inputSchema、不注入会话字段。
const SESSION_HINT = '\n\n[Shower] 本工具作用于当前聊天已绑定的 ready Shower 图形会话；'
  + '先用 shower status/create 准备环境。归属由会话绑定解析，不要传 Host/Shower 的 sessionId；'
  + '上游自己的 session/screenshot_out_file 等 Driver 内部参数按其语义使用。'
  + '返回 {content:[{type:"text",text}|{type:"image",data,mimeType}], isError}；'
  + '在 codemode 中须显式 text(block.text)/image(block) 将各块传给模型，勿把图片 base64 打印成文本。';

/**
 * 与上游 inventory 一对一的内置 Cua 工具集（Windows 子会话 / Linux 私有 Xvnc；
 * Android 不注册）。异步工厂：启动时对固定 Driver 二进制跑一次只读 metadata
 * inventory（list-tools + describe），资源缺失或 metadata 不合法明确抛错，
 * 不悄悄返回空集、不退回包装器。
 */
export async function createCuaTools({ host, getHarness, manager }) {
  const inventory = await loadCuaToolInventory();
  return inventory.map((entry) => defineTool({
    name: 'cua_' + entry.name,
    description: entry.description + SESSION_HINT,
    parameters: entry.inputSchema,
    structuredOutputSchema: CUA_RESULT_SCHEMA,
    replay: 'unsafe',
    executionMode: 'sequential',
    async execute(args, api, context) {
      const identity = await resolveIdentity(host, getHarness, api, context);
      const options = { taskId: api.taskId, callId: api.callId, signal: context.abortSignal, source: 'agent' };
      const status = await manager.status(identity, options);
      const sessionId = typeof status?.sessionId === 'string' && status.sessionId !== '' ? status.sessionId : null;
      if (!sessionId) return cuaResult(errorOutput('SHOWER_SESSION_NOT_FOUND', '当前聊天没有图形环境会话；请先 shower create'));
      let input;
      try {
        input = normalizeCuaToolArguments(args ?? {}, CUA_MAX_REQUEST_BYTES);
      } catch (error) {
        return cuaResult(errorOutput(error?.code ?? 'INVALID_ARGUMENT', error?.message ?? 'invalid cua arguments'));
      }
      // 不发截图的观察不需要视觉模型：get_window_state 明确 include_screenshot:false
      // 是纯控件树读取；指定 screenshot_out_file 时图片写文件、结果只回文件信息。
      // 仅当观察会内联回图时才要求视觉模型并为缺省尺寸注入模型预算内默认值；
      // 上游允许的显式尺寸（0/大值）原样透传，过大结果由输出预算拒绝。
      const wantsImage = isCuaObserveTool(entry.name)
        && input.screenshot_out_file === undefined
        && !(entry.name === 'get_window_state' && input.include_screenshot === false);
      let limits = null;
      if (wantsImage) {
        const shot = await screenshotModel(api, context);
        if (!shot.vision) {
          return cuaResult(errorOutput('MODEL_NO_VISION', '当前模型不支持图片输入，无法返回截图；请切换视觉模型，'
            + '或 get_window_state 传 include_screenshot:false 只读控件树'));
        }
        limits = shot.limits;
        input = clampCuaObserveArguments(entry.name, input, Math.min(shot.limits.maxWidth, shot.limits.maxHeight));
      }
      const result = await manager.cua(
        identity,
        sessionId,
        { method: 'tools/call', params: { name: entry.name, arguments: input } },
        options,
      );
      const normalized = normalizeCuaResult(result);
      if (resultHasImage(normalized) && limits === null) {
        // 非观察工具也可能回图：非视觉模型在此挡住，图片绝不回传给看不到它的模型。
        const shot = await screenshotModel(api, context);
        if (!shot.vision) {
          return cuaResult(errorOutput('MODEL_NO_VISION', 'Cua 响应包含截图但当前模型不支持图片输入；结果未回传'));
        }
        limits = shot.limits;
      }
      return cuaResult(boundedBlocks(normalized, limits, normalized.content.length));
    },
  }));
}
