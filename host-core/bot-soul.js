// Bot SOUL 文档：每 Bot 一份真实 UTF-8 文件 dataRoot/bots/<botId>/SOUL.md，
// 绝不写入共享 cwd。路径只由本模块按内部 botId 生成，不接受调用方拼路径。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 公开编辑上限（UTF-8 字节）。只在 setSoulText 的调用方边界生效。
export const SOUL_MAX_BYTES = 64 * 1024;

const BOTS_DIR = 'bots';
const SOUL_FILE = 'SOUL.md';
const SHA256_HEX = /^[0-9a-f]{64}$/;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 公开 DTO 的相对路径（固定用 '/'），只用于展示/核对，不用于读取。 */
function soulRelativePath(botId) {
  return `${BOTS_DIR}/${botId}/${SOUL_FILE}`;
}

// botId 由 store 随机生成或 host 校验过；这里再拒绝会改变目录层级的输入。
function soulPathOf(dataRoot, botId) {
  if (
    typeof botId !== 'string' || botId.trim() === '' ||
    botId === '.' || botId === '..' ||
    botId.includes('/') || botId.includes('\\') || botId.includes('\0')
  ) {
    throw errWithCode('botId must be a single path segment', 'INVALID_ARGUMENT');
  }
  return path.join(dataRoot, BOTS_DIR, botId, SOUL_FILE);
}

function toSoul(botId, buffer) {
  return {
    botId,
    path: soulRelativePath(botId),
    revision: createHash('sha256').update(buffer).digest('hex'),
    text: buffer.toString('utf8'),
  };
}

function assertSoulText(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) {
    throw errWithCode('text must be a well-formed UTF-16 string', 'INVALID_ARGUMENT');
  }
  if (Buffer.byteLength(text, 'utf8') > SOUL_MAX_BYTES) {
    throw errWithCode('text must be at most ' + SOUL_MAX_BYTES + ' UTF-8 bytes', 'INVALID_ARGUMENT');
  }
  return text;
}

function assertSoulRevision(revision) {
  if (typeof revision !== 'string' || !SHA256_HEX.test(revision)) {
    throw errWithCode('expectedRevision must be a SHA-256 hex digest', 'INVALID_ARGUMENT');
  }
  return revision;
}

/** 读现有文档；缺失返回 null，不创建。 */
function readSoul(dataRoot, botId) {
  const file = soulPathOf(dataRoot, botId);
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return toSoul(botId, buffer);
}

// 同目录临时文件 + rename 原子发布：失败时旧文档完整保留，临时文件清理后不留在数据目录。
function publish(dataRoot, botId, buffer) {
  const file = soulPathOf(dataRoot, botId);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${SOUL_FILE}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错误 */ }
    throw err;
  }
  return toSoul(botId, buffer);
}

/**
 * 缺失时用已持久化的 role 一次性补建（首次创建/遗留 Bot）；已有内容永不覆盖。
 * seed 不做公开输入校验：role 是注册表既有数据，超长或含代理项的旧角色也不得让创建永久失败。
 */
export function ensureSoul(dataRoot, botId, seedText) {
  const existing = readSoul(dataRoot, botId);
  if (existing) return existing;
  const seed = typeof seedText === 'string' ? seedText : '';
  return publish(dataRoot, botId, Buffer.from(seed, 'utf8'));
}

/**
 * CAS 写入：库内当前内容摘要必须等于 expectedRevision，否则 REQUEST_CONFLICT，不覆盖他人写入。
 * shortcut: 比较与发布都是同步 I/O，同进程内无交错窗口；多进程同时写同一 Bot 时后写者仍可能覆盖，
 * 需要跨进程互斥时再加文件锁。
 */
export function setSoulText(dataRoot, botId, expectedRevision, text) {
  assertSoulRevision(expectedRevision);
  const value = assertSoulText(text);
  const current = readSoul(dataRoot, botId);
  if (!current || current.revision !== expectedRevision) {
    throw errWithCode('SOUL revision does not match the current document', 'REQUEST_CONFLICT');
  }
  return publish(dataRoot, botId, Buffer.from(value, 'utf8'));
}
