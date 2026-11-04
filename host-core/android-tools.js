import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { DEFAULT_IMAGE_LIMITS } from '@earendil-works/pi-durable/tools';
import { resolveBotIdentity } from './bot-identity.js';

const MAX_TEXT_OUTPUT_BYTES = 50 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// ShowerController/服务端截图响应的已知非图片字段；决不回显 data 或任意额外字段。
const SHOWER_METADATA_KEYS = [
  'ok', 'action', 'displayId', 'width', 'height', 'dpi', 'idleTimeoutMs',
  'imageWidth', 'imageHeight', 'mimeType',
];

const SHOWER_KEYS = [
  'BACK', 'HOME', 'ENTER', 'TAB', 'ESCAPE', 'SPACE', 'DEL', 'FORWARD_DEL', 'A', 'COPY', 'CUT',
  'PASTE', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER',
  'PAGE_UP', 'PAGE_DOWN', 'MOVE_HOME', 'MOVE_END',
];
const SHOWER_MODIFIERS = ['SHIFT', 'ALT', 'CTRL', 'META'];
const COORDINATE = { type: 'integer', minimum: 0 };
const INTEGER_ACTION = (minimum, maximum) => ({ type: 'integer', minimum, maximum });

// codemode 只对声明了 structuredOutputSchema 的工具回传 structuredOutput（无 schema
// 时脚本只见拼接文本、图片被丢弃）；declare 后嵌套结果解析为 {content, isError}。
// 与 shower-tools/cua-tools 同一契约的本文件私有副本。
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

function errorOutput(code, message) {
  return { ...textOutput(JSON.stringify({ code, message })), isError: true };
}

/** 文本输出统一限制在 50 KiB；超限返回明确错误而不是发送截断/超大文本。 */
function checkedTextOutput(text, tooLargeCode, tooLargeMessage) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    return errorOutput(tooLargeCode, tooLargeMessage);
  }
  return textOutput(text);
}

/** 只使用持久会话归属解析身份；不采信模型参数里的任何归属。 */
function resolveIdentity(host, getHarness, api, context) {
  return resolveBotIdentity(host, getHarness(), api.conversationId, context);
}

/** 字符串参数必须为良构 UTF-16，防止未配对代理项进入原生 IPC。 */
function assertWellFormedStrings(value) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('字符串参数包含未配对的 UTF-16 代理项');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedStrings(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertWellFormedStrings(item);
  }
}

/** 可信 nativeBridge 调用：请求只带解析出的身份与任务 ID，取消经 signal 转发。 */
async function nativeCall(nativeBridge, tool, identity, args, api, context) {
  context.abortSignal?.throwIfAborted();
  assertWellFormedStrings(args);
  const result = await nativeBridge({
    tool,
    actor: {
      deviceId: identity.deviceId,
      botId: identity.botId,
      conversationId: identity.conversationId,
      scopeId: identity.scopeId,
      kind: identity.kind,
    },
    taskId: api.taskId,
    arguments: args,
  }, { signal: context.abortSignal });
  context.abortSignal?.throwIfAborted();
  return result;
}

/**
 * 当前模型的截图能力与内联图片上限：`DEFAULT_IMAGE_LIMITS` 被模型 `inputLimits.images.resize` 覆盖，
 * 与 pi-durable read 工具一致。模型解析错误直接向上抛，绝不吞掉或把未知模型当作支持视觉。
 */
async function screenshotModel(api, context) {
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
      // maxBytes 是 base64 编码后长度，不是解码后 PNG 字节数。
      maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
    },
  };
}

/** 解码并校验规范 base64 与 PNG 头（签名/IHDR 宽高），返回 PNG 宽高。 */
function decodePng(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new Error('Shower 截图响应无效');
  }
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    throw new Error('Shower 截图响应无效');
  }
  if (buffer.length < 24 || !PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
      || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Shower 截图响应无效');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 截图输出：文本块只含白名单元数据 JSON（不含 base64），图片块携带真实 PNG。 */
function screenshotResult(result, limits) {
  if (result.mimeType !== 'image/png') throw new Error('Shower 截图响应无效');
  const metadata = {};
  for (const key of SHOWER_METADATA_KEYS) {
    if (result[key] !== undefined) metadata[key] = result[key];
  }
  const png = decodePng(result.data);
  if (png.width !== metadata.imageWidth || png.height !== metadata.imageHeight) {
    throw new Error('Shower 截图响应无效');
  }
  if (metadata.imageWidth > limits.maxWidth || metadata.imageHeight > limits.maxHeight
      || result.data.length > limits.maxBytes) {
    return errorOutput('NATIVE_IMAGE_TOO_LARGE',
      `截图 ${metadata.imageWidth}×${metadata.imageHeight}（base64 长度 ${result.data.length}）`
      + `超过当前模型内联图片上限（≤${limits.maxWidth}×${limits.maxHeight}、`
      + `≤${Math.round(limits.maxBytes / 1024 / 1024)}MiB）；请用更小 maxWidth/maxHeight 重新截图`);
  }
  const text = JSON.stringify(metadata);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_OUTPUT_BYTES) {
    return errorOutput('RESPONSE_TOO_LARGE', '截图元数据文本超过 50 KiB');
  }
  return { output: [{ type: 'text', text }, { type: 'image', data: result.data, mimeType: result.mimeType }] };
}

/**
 * Android 宿主原生工具。仅在提供可信 nativeBridge 时返回定义；宿主负责只给主/工作代理安装。
 * replay：android_apps 只读可安全重放；android_shower/android_speak 每次都会产生副作用，不可重放。
 */
export function createAndroidTools({ host, getHarness, nativeBridge }) {
  if (typeof nativeBridge !== 'function') return [];

  return [
    defineTool({
      name: 'android_apps',
      description: '列出当前用户全部已安装应用（含系统应用和无 launcher 入口应用）：action=list 返回全部；'
        + 'action=search 按应用名或包名忽略大小写包含匹配（query 必填）。只返回 label 与 packageName，'
        + '供 android_shower 的 launch 使用。列表文本超过 50 KiB 时会返回错误，请改用 search 关键词缩小范围。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'search'] },
          query: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      replay: 'safe',
      async execute(args, api, context) {
        const identity = await resolveIdentity(host, getHarness, api, context);
        if (args.action === 'search') {
          const query = args.query;
          if (typeof query !== 'string' || !query.trim()) {
            return errorOutput('INVALID_ARGUMENT', 'query 必须是非空关键词');
          }
          args = { ...args, query: query.trim() };
        }
        const result = await nativeCall(nativeBridge, 'android_apps', identity, args, api, context);
        if (!Array.isArray(result)) throw new Error('Android 应用查询响应无效');
        const apps = [];
        for (const app of result) {
          if (!app || typeof app.label !== 'string' || typeof app.packageName !== 'string') {
            throw new Error('Android 应用查询响应无效');
          }
          apps.push({ label: app.label, packageName: app.packageName });
        }
        return checkedTextOutput(JSON.stringify({ count: apps.length, apps }),
          'APPS_LIST_TOO_LARGE', '应用列表文本超过 50 KiB；请改用 action=search 关键词缩小范围，不要返回全量列表');
      },
    }),
    defineTool({
      name: 'android_shower',
      description: '只操作宿主分配给当前 Bot 的 Operit Shower 虚拟屏，不操作手机主屏或其他 Bot 的屏幕；每个 Bot 一块屏，'
        + '主私聊、群与 DM 共用。先 create（默认主屏当前完整分辨率与密度，自动启动 Shower），再 launch；同一 Bot create 复用现有屏幕。'
        + '每次动作后用 screenshot 核实。屏幕跨回复保留，5 分钟无工具操作且用户未在 Bot 屏幕面板观看则自动回收。'
        + '用户可以接管屏幕：接管会中断当前对话，之后用户可能与你同时操作；接管后第一次非截图动作返回未执行错误，'
        + '必须先 screenshot 按当前画面重新定位，不要盲目重放动作；确定不再使用时 release，仅释放本 Bot 的屏幕。'
        + '最后一块屏幕关闭后 Shower 空闲 15 秒自动退出。同一应用不能同时被不同 Bot 的虚拟屏占用，launch 冲突会报错。tap/swipe 坐标始终使用 create 返回的虚拟屏尺寸；'
        + '截图按 maxWidth/maxHeight 等比缩小，返回同时给出虚拟尺寸和图片尺寸，不要把缩小后的图片坐标当虚拟坐标。'
        + '截图只在当前模型支持图片输入时执行；非视觉模型或不支持图片的模型会返回错误，必须先切换模型或不要截图。'
        + '失败会报错，不产生截图对象。text 通过系统剪贴板粘贴中文等 Unicode 文本并全选替换，空字符串或 clear 清空输入框；'
        + 'copy(text) 把文字写入系统剪贴板，paste 在光标处粘贴；key A 配合 CTRL 全选。剪贴板与主屏共享，'
        + 'text/copy 会覆盖；按键被系统接受不代表输入框已改变，必须截图确认。服务断开或屏幕空闲超时后先 create，'
        + '再 launch 并截图重新定位，不要盲目重放旧坐标或动作。'
        + '返回 {content:[{type:"text",text}|{type:"image",data,mimeType}], isError}；'
        + '在 codemode 中须显式 text(block.text)/image(block) 将各块传给模型，勿把图片 base64 打印成文本。',
      parameters: {
        type: 'object',
        anyOf: [
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create'] },
              width: INTEGER_ACTION(320, 4096),
              height: INTEGER_ACTION(320, 4096),
              dpi: INTEGER_ACTION(120, 640),
              bitrateKbps: INTEGER_ACTION(128, 12000),
            },
            required: ['action'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['launch'] },
              packageName: { type: 'string', minLength: 3, maxLength: 255 },
            },
            required: ['action', 'packageName'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['screenshot'] },
              maxWidth: INTEGER_ACTION(160, 1440),
              maxHeight: INTEGER_ACTION(160, 3200),
            },
            required: ['action'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { action: { type: 'string', enum: ['tap'] }, x: COORDINATE, y: COORDINATE },
            required: ['action', 'x', 'y'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['swipe'] },
              x1: COORDINATE, y1: COORDINATE, x2: COORDINATE, y2: COORDINATE,
              durationMs: INTEGER_ACTION(1, 10000),
            },
            required: ['action', 'x1', 'y1', 'x2', 'y2'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['key'] },
              key: { type: 'string', enum: SHOWER_KEYS },
              modifiers: { type: 'array', items: { type: 'string', enum: SHOWER_MODIFIERS }, uniqueItems: true, maxItems: 4 },
            },
            required: ['action', 'key'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['text'] },
              text: { type: 'string', maxLength: 1000 },
            },
            required: ['action', 'text'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['copy'] },
              text: { type: 'string', minLength: 1, maxLength: 1000 },
            },
            required: ['action', 'text'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { action: { type: 'string', enum: ['paste'] } },
            required: ['action'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { action: { type: 'string', enum: ['clear'] } },
            required: ['action'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { action: { type: 'string', enum: ['release'] } },
            required: ['action'],
            additionalProperties: false,
          },
        ],
      },
      structuredOutputSchema: TOOL_RESULT_SCHEMA,
      replay: 'unsafe',
      async execute(args, api, context) {
        const identity = await resolveIdentity(host, getHarness, api, context);
        if (args.action === 'screenshot') {
          // 先解决当前模型再发起原生截图：未知/非视觉模型直接返回明确错误。
          const shot = await screenshotModel(api, context);
          if (!shot.vision) {
            return errorOutput('MODEL_NO_VISION', '当前模型不支持图片输入，无法返回截图；请使用支持视觉的模型，或不使用 screenshot');
          }
          const result = await nativeCall(nativeBridge, 'android_shower', identity, args, api, context);
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('Shower 原生响应无效');
          }
          return toolResult(screenshotResult(result, shot.limits));
        }
        const result = await nativeCall(nativeBridge, 'android_shower', identity, args, api, context);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Shower 原生响应无效');
        }
        return toolResult(checkedTextOutput(JSON.stringify(result), 'RESPONSE_TOO_LARGE', 'Shower 原生响应文本超过 50 KiB；未发送完整内容'));
      },
    }),
    defineTool({
      name: 'android_speak',
      description: '让宿主设备朗读指定文本。文本交给系统 TTS 或已配置的远程引擎后立即返回 {accepted:true}，'
        + '表示已受理，不代表朗读完成。正在等待本调用被接受的取消会中断请求；一旦已被 SpeechOutput 接受，'
        + '播放由宿主负责，会话结束不保证停止已接受的播放；宿主进程关闭会停止其拥有的朗读。只读取文本，'
        + '不监听麦克风，也不开启唤醒。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 10000 },
        },
        required: ['text'],
        additionalProperties: false,
      },
      replay: 'unsafe',
      async execute(args, api, context) {
        const identity = await resolveIdentity(host, getHarness, api, context);
        const result = await nativeCall(nativeBridge, 'android_speak', identity, args, api, context);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('语音朗读原生响应无效');
        }
        return checkedTextOutput(JSON.stringify(result), 'RESPONSE_TOO_LARGE', '语音朗读原生响应文本超过 50 KiB；未发送完整内容');
      },
    }),
  ];
}
