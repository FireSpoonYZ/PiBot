// 模块：主私聊图片附件的落盘、验证与读取。
// 存储：dataRoot/attachments/<botId>/<sha256> 为图片字节，<sha256>.json 为上传时
// 校验过的展示元数据（内容定址；同 id 重传覆盖 name）。并发/重试同 id 写同一文件，
// 首次写经临时文件 rename 原子提交，绝不留下半截图片。
// 边界：只接受 image/jpeg 与 image/png，解码后字节 <=16MiB、长边 <=16384、每条 <=16 张；
// name 为必填非空字符串、<=256 UTF-8 bytes，仅展示用，绝不参与路径。
// 生命周期：随 Bot 删除（含归档自动 purge）整目录清除；不做 TTL，旧会话永不改写。
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { decodeBase64, frameSize } from './shower-tools.js';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16384;
const MAX_IMAGES_PER_MESSAGE = 16;
const MAX_NAME_BYTES = 256;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ATTACHMENT_ID_RE = /^[0-9a-f]{64}$/;
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png']);

export const ATTACHMENT_LIMITS = {
  maxImageBytes: MAX_IMAGE_BYTES,
  maxImageDimension: MAX_IMAGE_DIMENSION,
  maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
};

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const invalidArgument = (message) => errWithCode(message, 'INVALID_ARGUMENT');

/** botId 只作目录名一段：拒绝分隔符/驱动器/父遍历，绝不把 caller 输入拼成任意路径。 */
export function botAttachmentDirectory(root, botId) {
  if (typeof botId !== 'string' || botId === '' || botId === '.' || botId === '..' ||
      botId.includes('/') || botId.includes('\\') || botId.includes(':')) {
    throw invalidArgument('botId is not a safe directory name');
  }
  const dir = resolve(root, 'attachments', botId);
  const base = resolve(root, 'attachments');
  if (dir !== base + sep + botId) throw invalidArgument('botId is not a safe directory name');
  return dir;
}

function assertBotAttachmentDir(root, botId) {
  const dir = botAttachmentDirectory(root, botId);
  return dir;
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw invalidArgument('attachment name must be a non-empty string');
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw invalidArgument('attachment name exceeds 256 UTF-8 bytes');
  }
  return name;
}

/** decode + canonicalize：先按 base64 上限拒绝超长输入，再校验 re-encode 严格相等。 */
function decodeCanonicalBase64(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw invalidArgument('attachment data is not canonical base64');
  }
  // 解码后上限 16MiB -> base64 上限 4*ceil(16MiB/3)；先挡掉明显超限输入再分配 Buffer。
  if (data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
    throw invalidArgument('attachment data exceeds the encoded size limit');
  }
  const bytes = decodeBase64(data);
  if (bytes.toString('base64') !== data) {
    throw invalidArgument('attachment data is not canonical base64');
  }
  return bytes;
}

/** 写 JSON 原子提交（tmp + rename）。 */
async function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(value));
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * 上传并落盘一张图。input = { name, mimeType, data(规范 base64) }。
 * 校验 name/base64/大小/真实图片头/尺寸；mimeType 只按文件头识别，不信声明。
 * 返回展示元数据（无 data）；同 id 重传覆盖 sidecar 中的 name，不影响 requestId 幂等。
 */
export async function uploadAttachment(root, botId, input) {
  const dir = assertBotAttachmentDir(root, botId);
  const name = validateName(input?.name);
  const mimeType = input?.mimeType;
  if (!ACCEPTED_MIME.has(mimeType)) {
    throw invalidArgument('attachment mimeType must be image/jpeg or image/png');
  }
  const bytes = decodeCanonicalBase64(input?.data);
  if (bytes.length === 0) throw invalidArgument('attachment data is empty');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw invalidArgument('attachment exceeds ' + MAX_IMAGE_BYTES + ' bytes');
  }
  let size;
  try {
    size = frameSize(bytes, mimeType);
  } catch {
    throw invalidArgument('attachment is not a valid ' + mimeType + ' image');
  }
  const { width, height } = size;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw invalidArgument('attachment image has invalid dimensions');
  }
  if (Math.max(width, height) > MAX_IMAGE_DIMENSION) {
    throw invalidArgument('attachment exceeds ' + MAX_IMAGE_DIMENSION + 'px on the long edge');
  }
  const id = createHash('sha256').update(bytes).digest('hex');
  const file = join(dir, id);
  const meta = { id, name, mimeType, size: bytes.length, width, height };
  await mkdir(dir, { recursive: true });
  // 内容定址：并发/重试写同一 id 结果相同；已存在即不重写图片，只更新 sidecar name。
  const existing = await stat(file).catch(() => null);
  if (!existing?.isFile()) {
    const tmp = join(dir, '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  }
  await writeJsonAtomic(join(dir, id + '.json'), meta);
  return meta;
}

export function attachmentPath(root, botId, attachmentId) {
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_RE.test(attachmentId)) {
    throw invalidArgument('attachmentId must be a 64-char lowercase hex string');
  }
  return join(botAttachmentDirectory(root, botId), attachmentId);
}

/** 读已落盘的 metadata + base64（提交时组装模型内容、getAttachment 对外方法共用）。 */
export async function loadAttachment(root, botId, attachmentId) {
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_RE.test(attachmentId)) {
    throw invalidArgument('attachmentId must be a 64-char lowercase hex string');
  }
  const dir = assertBotAttachmentDir(root, botId);
  const bytes = await readFile(join(dir, attachmentId)).catch((err) => {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw errWithCode('attachment not found: ' + attachmentId, 'ATTACHMENT_NOT_FOUND');
    }
    throw err;
  });
  const metaRaw = await readFile(join(dir, attachmentId + '.json'), 'utf8').catch((err) => {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw errWithCode('attachment metadata not found: ' + attachmentId, 'ATTACHMENT_NOT_FOUND');
    }
    throw err;
  });
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    throw errWithCode('attachment metadata is corrupt: ' + attachmentId, 'INVALID_STATE');
  }
  if (meta?.id !== attachmentId || typeof meta?.name !== 'string' ||
      !ACCEPTED_MIME.has(meta?.mimeType) || !Number.isSafeInteger(meta?.size) ||
      !Number.isSafeInteger(meta?.width) || !Number.isSafeInteger(meta?.height)) {
    throw errWithCode('attachment metadata is invalid: ' + attachmentId, 'INVALID_STATE');
  }
  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    width: meta.width,
    height: meta.height,
    data: bytes.toString('base64'),
  };
}

/** Bot 删除（含自动 purge）时整目录清除；rm 失败抛出让调用方可见，不静默吞错。 */
export async function removeBotAttachments(root, botId) {
  await rm(assertBotAttachmentDir(root, botId), { recursive: true, force: true });
}

/** 提交前校验：附件 id 列表形状（array<=16、全 64hex、无重复）。 */
export function normalizeAttachmentIds(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw invalidArgument('attachments must be an array of attachment ids');
  }
  if (attachments.length > MAX_IMAGES_PER_MESSAGE) {
    throw invalidArgument('a message accepts at most ' + MAX_IMAGES_PER_MESSAGE + ' attachments');
  }
  const ids = [];
  const seen = new Set();
  for (const raw of attachments) {
    if (typeof raw !== 'string' || !ATTACHMENT_ID_RE.test(raw)) {
      throw invalidArgument('attachments must contain only 64-char lowercase hex attachment ids');
    }
    if (seen.has(raw)) throw invalidArgument('duplicate attachment id: ' + raw);
    seen.add(raw);
    ids.push(raw);
  }
  return ids;
}
