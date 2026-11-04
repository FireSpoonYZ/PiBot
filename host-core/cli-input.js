// 共享 CLI 输入读取：有界普通文件 + 严格 UTF-8 + 单个纯 JSON 对象。
// 从 message-cli.js 提取，control-cli.js 与 message-cli.js 共用；不依赖任一可执行 CLI。
import { statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';

const MAX_INPUT_BYTES = 1024 * 1024;
// 图片上传 --input 允许单图 16MiB 解码（约 22.4MiB base64 + JSON 字段）的更大预算；
// 非图片/配置读取保持上方默认。
export const MAX_UPLOAD_INPUT_BYTES = 32 * 1024 * 1024;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

// 先 statSync 拒绝非普通文件（含 device/FIFO，避免阻塞打开），open 后 fstat 取真实大小，
// 大小超限直接拒绝，缓冲/读取最多 maxBytes+1，绝不无界 readFile。
export function readTextFile(file, label = 'input file', maxBytes = MAX_INPUT_BYTES) {
  let fd;
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      throw invalid(`${label} must be a regular file`);
    }
    fd = openSync(file, 'r');
    const real = fstatSync(fd);
    if (!real.isFile()) {
      throw invalid(`${label} must be a regular file`);
    }
    if (real.size > maxBytes) {
      throw invalid(`${label} exceeds ${Math.round(maxBytes / 1048576)}MiB`);
    }
    const buf = Buffer.allocUnsafe(real.size + 1);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead !== real.size) {
      throw invalid(`${label} changed while reading`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
    } catch {
      throw invalid(`${label} is not valid UTF-8`);
    }
  } catch (err) {
    if (err?.code === 'INVALID_ARGUMENT') throw err;
    throw invalid(`cannot read ${label}: ${err.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不掩盖原错误。
      }
    }
  }
}

export function readInputObject(file, maxBytes) {
  const text = readTextFile(file, '--input file', maxBytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('--input file must contain a single JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('--input file must contain a single JSON object');
  }
  return parsed;
}

export { invalid };
