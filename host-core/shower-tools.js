import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { DEFAULT_IMAGE_LIMITS } from '@earendil-works/pi-durable/tools';
import { resolveBotIdentity } from './bot-identity.js';
import { normalizeShowerFrameLimits, SHOWER_MAX_FRAME_BASE64_BYTES } from './shower-protocol.js';

const MAX_TEXT_OUTPUT_BYTES = 50 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Frame 允许回显给模型的元数据白名单；决不回显 data 或任意额外字段。
const FRAME_METADATA_KEYS = [
  'sessionId', 'frameId', 'capturedAt', 'width', 'height', 'imageWidth', 'imageHeight', 'mimeType',
];
const KEYS = [
  'ENTER', 'TAB', 'ESCAPE', 'SPACE', 'BACKSPACE', 'DELETE', 'LEFT', 'RIGHT', 'UP', 'DOWN',
  'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  'BACK', 'ANDROID_HOME',
];
const MODIFIERS = ['CTRL', 'ALT', 'SHIFT', 'META'];
const COORDINATE = { type: 'integer', minimum: 0, maximum: 4096 };
const DIMENSION = { type: 'integer', minimum: 160, maximum: 4096 };
const NOTCHES = { type: 'integer', minimum: -20, maximum: 20 };

const INPUT_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['click'] },
        x: COORDINATE,
        y: COORDINATE,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'integer', enum: [1, 2] },
      },
      required: ['type', 'x', 'y'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['drag'] },
        x1: COORDINATE,
        y1: COORDINATE,
        x2: COORDINATE,
        y2: COORDINATE,
        durationMs: { type: 'integer', minimum: 50, maximum: 3000 },
      },
      required: ['type', 'x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['scroll'] },
        x: COORDINATE,
        y: COORDINATE,
        deltaX: NOTCHES,
        deltaY: NOTCHES,
      },
      required: ['type', 'x', 'y', 'deltaY'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['key'] },
        key: { type: 'string', enum: KEYS },
        modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS }, uniqueItems: true, maxItems: 4 },
      },
      required: ['type', 'key'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text'] },
        text: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      required: ['type', 'text'],
      additionalProperties: false,
    },
  ],
};

const LAUNCH_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['app'] },
        appId: { type: 'string', minLength: 1, maxLength: 255 },
      },
      required: ['kind', 'appId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['process'] },
        program: { type: 'string', minLength: 1, maxLength: 4096 },
        args: { type: 'array', items: { type: 'string' }, maxItems: 256 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      required: ['kind', 'program'],
      additionalProperties: false,
    },
  ],
};

// codemode 只对声明了 structuredOutputSchema 的工具回传 structuredOutput（无 schema
// 时脚本只见拼接文本、图片被丢弃）；declare 后嵌套结果解析为 {content, isError}。
// cua-tools 声明同一契约；android-tools 有自己的同形副本。
const TOOL_RESULT_SCHEMA = Type.Object({
  content: Type.Array(Type.Union([
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
    Type.Object({ type: Type.Literal('image'), data: Type.String(), mimeType: Type.String() }),
  ])),
  isError: Type.Boolean(),
});

/** 成功结果把同一批已限额/校验块附作 structuredOutput 供 codemode 嵌套调用；
    错误结果保持 {output,isError} 不附 structuredOutput：SDK 将其转为 error diagnostic 拒绝脚本调用，
    而不是让脚本 resolve 成功。 */
function toolResult(bounded) {
  if (bounded.isError === true) return bounded;
  return { ...bounded, structuredOutput: { content: bounded.output ?? [], isError: false } };
}

function textOutput(text) {
  return { output: [{ type: 'text', text }] };
}

/** cua-tools 同包复用。 */
export function errorOutput(code, message) {
  return { ...textOutput(JSON.stringify({ code, message })), isError: true };
}

/** 文本输出统一限制在 50 KiB；超限返回明确错误而不是发送截断/超大文本。cua-tools 同包复用。 */
export function checkedTextOutput(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    return errorOutput('RESPONSE_TOO_LARGE', 'Shower 响应文本超过 50 KiB；未发送完整内容');
  }
  return textOutput(text);
}

/** 只使用持久会话归属解析身份；不采信模型参数里的任何归属。cua-tools 同包复用。 */
export function resolveIdentity(host, getHarness, api, context) {
  return resolveBotIdentity(host, getHarness(), api.conversationId, context);
}

/**
 * 当前模型的截图能力与内联图片上限：`DEFAULT_IMAGE_LIMITS` 被模型 `inputLimits.images.resize` 覆盖，
 * 与 pi-durable read 工具及 android_shower 一致。模型解析错误直接向上抛，绝不把未知模型当作支持视觉。
 */
export async function screenshotModel(api, context) {
  const agent = await api.agent(context);
  const ref = agent?.model;
  if (!ref || typeof ref.provider !== 'string' || typeof ref.modelId !== 'string') {
    throw new Error('无法确定当前模型，不能返回截图');
  }
  const model = api.models?.getModel?.(ref.provider, ref.modelId);
  if (!model) throw new Error(`当前模型不可用：${ref.provider}/${ref.modelId}`);
  const resize = model.inputLimits?.images?.resize;
  return {
    vision: Array.isArray(model.input) && model.input.includes('image'),
    limits: {
      maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
      maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
      // maxBytes 是 base64 编码后长度，不是解码后图片字节数。
      maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
    },
  };
}

/** 请求的 FrameLimits 与模型内联图片上限取较小值：模型看不到的帧不回传。 */
function effectiveLimits(requested, modelLimits) {
  const limits = normalizeShowerFrameLimits(requested);
  return {
    maxWidth: Math.min(limits.maxWidth, modelLimits.maxWidth),
    maxHeight: Math.min(limits.maxHeight, modelLimits.maxHeight),
    maxBytes: Math.min(limits.maxBytes, modelLimits.maxBytes),
  };
}

/** cua-tools 同包复用，不复制解析器。 */
export function decodeBase64(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new Error('Shower 截图响应无效');
  }
  try {
    return Buffer.from(data, 'base64');
  } catch {
    throw new Error('Shower 截图响应无效');
  }
}

/** PNG 签名 + IHDR 宽高。 */
function pngSize(buffer) {
  if (buffer.length < 24 || !PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
      || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Shower 截图响应无效');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** JPEG SOI 之后第一个 SOF 段的宽高（不解码像素）。 */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Shower 截图响应无效');
  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('Shower 截图响应无效');
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) throw new Error('Shower 截图响应无效');
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOF: precision(1) height(2) width(2)
      if (length < 8) throw new Error('Shower 截图响应无效');
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('Shower 截图响应无效');
}

/** cua-tools 同包复用，不复制解析器。 */
export function frameSize(buffer, mimeType) {
  if (mimeType === 'image/png') return pngSize(buffer);
  if (mimeType === 'image/jpeg') return jpegSize(buffer);
  throw new Error('Shower 截图响应无效');
}

/** 截图输出：文本块只含白名单元数据 JSON（不含 base64），图片块携带真实帧。 */
function screenshotResult(frame, limits) {
  const buffer = decodeBase64(frame.data);
  const size = frameSize(buffer, frame.mimeType);
  const metadata = {};
  for (const key of FRAME_METADATA_KEYS) {
    if (frame[key] !== undefined) metadata[key] = frame[key];
  }
  if (size.width <= 0 || size.height <= 0 || size.width !== metadata.imageWidth || size.height !== metadata.imageHeight) {
    throw new Error('Shower 截图响应无效');
  }
  if (metadata.imageWidth > limits.maxWidth || metadata.imageHeight > limits.maxHeight
      || frame.data.length > limits.maxBytes) {
    return errorOutput('SHOWER_FRAME_TOO_LARGE',
      `截图 ${metadata.imageWidth}×${metadata.imageHeight}（base64 长度 ${frame.data.length}）`
      + `超过当前可用上限（≤${limits.maxWidth}×${limits.maxHeight}、≤${Math.round(limits.maxBytes / 1024)}KiB）；`
      + '请用更小 limits 重新截图');
  }
  const text = JSON.stringify(metadata);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    return errorOutput('RESPONSE_TOO_LARGE', '截图元数据文本超过 50 KiB');
  }
  return { output: [{ type: 'text', text }, { type: 'image', data: frame.data, mimeType: frame.mimeType }] };
}

/** 省略 sessionId 时从 manager.status 解析当前 actor 的会话；没有会话则明确报错。 */
async function resolveSessionId(manager, identity, args, options) {
  if (typeof args.sessionId === 'string' && args.sessionId !== '') return args.sessionId;
  const status = await manager.status(identity, options);
  return typeof status?.sessionId === 'string' && status.sessionId !== '' ? status.sessionId : null;
}

/**
 * 统一图形环境工具（Android 虚拟屏 / Windows 子会话 / Linux 私有 Xvnc）。
 * 每次执行都作用于可变的真实环境，故 replay:'unsafe' 且与其它工具串行执行；中止后不自动重放。
 */
export function createShowerTools({ host, getHarness, manager }) {
  return [
    defineTool({
      name: 'shower',
      description: '操作宿主为当前聊天分配的独立图形环境：Android 虚拟屏、Windows 子会话或 Linux 私有 Xvnc DISPLAY。'
        + '它绝不是手机/电脑的主桌面，也不能退回抓取主屏或向主桌面注入输入；AI 永远不进入主图形会话。'
        + 'action=status 只读会话状态与平台能力（launchKinds/inputKinds/keys）；create 创建或复用本聊天的环境'
        + '（尺寸在 options.width/options.height，缺省用平台默认）。create 可能返回 starting 或 authentication-required；'
        + '先查 status，只有 ready 才执行后续操作。需要认证时请用户在目标设备完成，不读取或代填密码，也不回退到主屏。'
        + 'launch 在环境内部启动程序；'
        + 'screenshot 返回当前画面；input 发送一次已标注类型的输入；release 显式释放本聊天的环境。'
        + '动作顺序：create → launch → 每次都先 screenshot 再 input。屏幕坐标使用 session 的源像素尺寸（width/height）；'
        + 'screenshot 会按 limits 等比缩小，同时返回源尺寸与图片尺寸（imageWidth/imageHeight），不要把图片坐标当源坐标。'
        + '画面必须在输入前读取：任何 input 之前先 screenshot，确认当前画面与坐标；不要凭想象或旧截图盲点。'
        + '用户手动接管时本聊天的工具与生成会被中止；接管结束后的新一轮必须先 screenshot 重新定位，'
        + '不要重放被中止的坐标或动作——本工具不会自动重放任何输入，部分执行只会报告未确认，不会重试。'
        + '关闭预览、AI 中止或开始新的一轮都不会销毁图形环境；只有 release（或宿主关闭）才会释放，'
        + '需要继续操作时不要随手 release。'
        + 'launch 必须与平台能力匹配：Android 只用 {kind:"app",appId}（包名），Windows/Linux 只用 '
        + '{kind:"process",program,args?,cwd?}（直接进程，无 shell）；平台不支持的种类会返回 SHOWER_UNSUPPORTED，'
        + '不做隐式转换。不支持的键名或输入类型同样报 SHOWER_UNSUPPORTED，不会静默近似。'
        + 'screenshot 只在当前模型支持图片输入时执行；非视觉模型会返回错误，此时应先切换模型或不截图。'
        + 'sessionId 省略时自动使用当前聊天的环境；不要传入其他会话的 sessionId。'
        + 'scroll 的 deltaX/deltaY 是整数滚轮格数（-20..20，正 Y 向下、正 X 向右），不是像素。'
        + '返回 {content:[{type:"text",text}|{type:"image",data,mimeType}], isError}；'
        + '在 codemode 中须显式 text(block.text)/image(block) 将各块传给模型，勿把图片 base64 打印成文本。'
        + '错误码：SHOWER_UNAVAILABLE/SHOWER_NOT_READY/SHOWER_BUSY/SHOWER_SESSION_NOT_FOUND/'
        + 'SHOWER_SESSION_MISMATCH/SHOWER_UNSUPPORTED/SHOWER_AUTH_REQUIRED/SHOWER_PERMISSION_REQUIRED/'
        + 'SHOWER_INPUT_FAILED/SHOWER_FRAME_TOO_LARGE/SHOWER_BACKEND_FAILED。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'create', 'launch', 'screenshot', 'input', 'release'] },
          sessionId: { type: 'string', minLength: 1, maxLength: 128 },
          options: {
            type: 'object',
            properties: { width: DIMENSION, height: DIMENSION },
            additionalProperties: false,
          },
          target: LAUNCH_SCHEMA,
          input: INPUT_SCHEMA,
          limits: {
            type: 'object',
            properties: {
              maxWidth: DIMENSION,
              maxHeight: DIMENSION,
              maxBytes: { type: 'integer', minimum: 1, maximum: SHOWER_MAX_FRAME_BASE64_BYTES },
            },
            additionalProperties: false,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      structuredOutputSchema: TOOL_RESULT_SCHEMA,
      replay: 'unsafe',
      executionMode: 'sequential',
      async execute(args, api, context) {
        const identity = await resolveIdentity(host, getHarness, api, context);
        // source 显式标注 agent，模型调用永不被当成人工接管输入。
        const options = { taskId: api.taskId, callId: api.callId, signal: context.abortSignal, source: 'agent' };
        switch (args.action) {
          case 'status':
            return toolResult(checkedTextOutput(JSON.stringify(await manager.status(identity, options))));
          case 'create':
            return toolResult(checkedTextOutput(JSON.stringify(await manager.ensure(identity, args.options ?? {}, options))));
          case 'release': {
            const sessionId = await resolveSessionId(manager, identity, args, options);
            if (!sessionId) return errorOutput('SHOWER_SESSION_NOT_FOUND', '当前聊天没有图形环境会话');
            return toolResult(checkedTextOutput(JSON.stringify(await manager.release(identity, sessionId, options))));
          }
          case 'launch': {
            if (!args.target || typeof args.target !== 'object') {
              return errorOutput('INVALID_ARGUMENT', 'launch 需要 target：{kind:"app",appId} 或 {kind:"process",program,args?,cwd?}');
            }
            const sessionId = await resolveSessionId(manager, identity, args, options);
            if (!sessionId) return errorOutput('SHOWER_SESSION_NOT_FOUND', '当前聊天没有图形环境会话；请先 create');
            return toolResult(checkedTextOutput(
              JSON.stringify(await manager.launch(identity, sessionId, args.target, options)),
            ));
          }
          case 'input': {
            if (!args.input || typeof args.input !== 'object') {
              return errorOutput('INVALID_ARGUMENT', 'input 需要带 type 的输入对象：click/drag/scroll/key/text');
            }
            const sessionId = await resolveSessionId(manager, identity, args, options);
            if (!sessionId) return errorOutput('SHOWER_SESSION_NOT_FOUND', '当前聊天没有图形环境会话；请先 create');
            return toolResult(checkedTextOutput(
              JSON.stringify(await manager.input(identity, sessionId, args.input, options)),
            ));
          }
          case 'screenshot': {
            // 先解决当前模型再发起截图：未知/非视觉模型直接返回明确错误。
            const shot = await screenshotModel(api, context);
            if (!shot.vision) {
              return errorOutput('MODEL_NO_VISION', '当前模型不支持图片输入，无法返回截图；请使用支持视觉的模型，或不使用 screenshot');
            }
            const limits = effectiveLimits(args.limits, shot.limits);
            const sessionId = await resolveSessionId(manager, identity, args, options);
            if (!sessionId) return errorOutput('SHOWER_SESSION_NOT_FOUND', '当前聊天没有图形环境会话；请先 create');
            const frame = await manager.frame(identity, sessionId, limits, options);
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
              throw new Error('Shower 截图响应无效');
            }
            return toolResult(screenshotResult(frame, limits));
          }
          default:
            return errorOutput('INVALID_ARGUMENT', 'action 必须是 status/create/launch/screenshot/input/release');
        }
      },
    }),
  ];
}
