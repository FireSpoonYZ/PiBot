// Bot 文件交接走现有有界控制通道；大文件按块传，消息中只记录接收端路径。
import { assertId, messageError } from './message-protocol.js';

export const BOT_FILE_CHUNK_BYTES = 256 * 1024;
export const BOT_FILE_MAX_COUNT = 4;
const HASH = /^[0-9a-f]{64}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]/;

const invalid = (message) => messageError('INVALID_ARGUMENT', message);

export function safeBotFileName(name) {
  let result = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!result) result = 'file';
  if (RESERVED_NAME.test(result)) result = '_' + result;
  // 为 Windows 路径和临时后缀留出空间；按 code point 截断，保留常见扩展名。
  if (Buffer.byteLength(result, 'utf8') > 180) {
    const dot = result.lastIndexOf('.');
    const ext = dot > 0 && result.length - dot <= 16 ? result.slice(dot) : '';
    let base = '';
    for (const ch of ext ? result.slice(0, dot) : result) {
      if (Buffer.byteLength(base + ch + ext, 'utf8') > 180) break;
      base += ch;
    }
    result = base + ext;
  }
  return result;
}

export function normalizeBotFileChunk(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('file chunk must be an object');
  for (const key of Object.keys(params)) {
    if (!['botId', 'id', 'name', 'size', 'offset', 'data'].includes(key)) throw invalid('unknown file chunk field: ' + key);
  }
  assertId(params.botId, 'botId');
  if (typeof params.id !== 'string' || !HASH.test(params.id)) throw invalid('file id must be a SHA-256');
  const name = params.name;
  if (typeof name !== 'string' || !name.isWellFormed() || !name || BAD_NAME.test(name) ||
      /[. ]$/.test(name) || RESERVED_NAME.test(name) || Buffer.byteLength(name, 'utf8') > 180) {
    throw invalid('file name must be a portable basename of at most 180 UTF-8 bytes');
  }
  if (!Number.isSafeInteger(params.size) || params.size < 0) {
    throw invalid('invalid file size');
  }
  if (!Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > params.size) throw invalid('invalid file offset');
  const data = params.data;
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(BOT_FILE_CHUNK_BYTES / 3) ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw invalid('file chunk must be canonical base64 of at most 256 KiB');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length > BOT_FILE_CHUNK_BYTES ||
      params.offset + bytes.length > params.size || (bytes.length === 0 && params.size !== 0)) {
    throw invalid('file chunk does not match its size or offset');
  }
  return { botId: params.botId, id: params.id, name, size: params.size, offset: params.offset, data };
}
