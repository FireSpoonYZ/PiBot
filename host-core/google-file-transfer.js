// Host-side Google Workspace file and attachment transfer adapter.
// Files always belong to the Bot workspace (or Bot attachment store), never to the Center filesystem.
// - prepareGoogleFileCall(name, args, { cwd, dataRoot?, botId?, signal? }):
//     Validates canonical paths/symlinks/sizes on the Host, stages binary uploads (drive_upload,
//     gmail_draft) and optional file inputs into bounded transfer payloads, pre-validates download
//     destinations (drive_download, gmail_attachment, gmail_read --download), and strips Host-only
//     local paths without mutating the caller's args.
// - finishGoogleFileCall(name, result, { cwd, args, dataRoot?, botId?, signal? }):
//     Saves downloaded bytes privately on the Host with overwrite/symlink/escape protection and
//     SHA-256 deduplication (reusing host-core/attachments.js for JPEG/PNG images when dataRoot &
//     botId are available), and strips all base64 binary data so it never flows back to the model.

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  attachmentPath,
  botAttachmentDirectory,
  formatAttachmentRef,
  loadAttachmentMeta,
  parseAttachmentRef,
  uploadAttachment,
} from './attachments.js';
import { safeBotFileName } from './bot-file-protocol.js';

// Upstream Orca paired-request & download caps (stablyai/orca MIT):
export const PAIRED_REQUEST_PARAMS_MAX_BYTES = 782_208;
export const DRIVE_UPLOAD_MAX_BYTES = 583_584;
export const GMAIL_DRAFT_ATTACH_MAX_BYTES = 562_080;
export const TOOL_DOWNLOAD_MAX_BYTES = 2_900_000;
export const GMAIL_DRAFT_MAX_ATTACHMENTS = 20;
export const GOOGLE_DOWNLOAD_DIR_NAME = '.google-downloads';

const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const BAD_PATH_SEGMENT = /[<>:"/\\|?*\x00-\x1f]/;
const CONTROL_CHAR_RE = /[\x00-\x1f]/;
const READ_CHUNK_BYTES = 64 * 1024;

const FILE_TRANSFER_TOOLS = new Set([
  'drive_upload',
  'drive_download',
  'gmail_draft',
  'gmail_attachment',
  'gmail_read',
  'docs_create',
  'docs_append',
  'docs_replace',
  'docs_comment',
  'sheets_write',
  'sheets_append',
  'sheets_upsert',
]);

const TEXT_FILE_FIELD_MAP = {
  docs_create: { fileKey: 'bodyFile', targetKey: 'markdown', kind: 'text' },
  docs_append: { fileKey: 'bodyFile', targetKey: 'markdown', kind: 'text' },
  docs_comment: { fileKey: 'bodyFile', targetKey: 'text', kind: 'text' },
  gmail_draft: { fileKey: 'bodyFile', targetKey: 'body', kind: 'text' },
  docs_replace: { fileKey: 'pairsFile', targetKey: 'pairs', kind: 'json-array' },
  sheets_write: { fileKey: 'valuesFile', targetKey: 'values', kind: 'json-rows' },
  sheets_append: { fileKey: 'valuesFile', targetKey: 'values', kind: 'json-rows' },
  sheets_upsert: { fileKey: 'valuesFile', targetKey: 'values', kind: 'json-rows' },
};

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function formatSizeLimit(bytes) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
    : `${Math.floor(bytes / 1024)} KB`;
}

function normalizeForCompare(targetPath) {
  const normalized = resolve(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithinDir(baseReal, candidate, { allowEqual = false } = {}) {
  const base = normalizeForCompare(baseReal);
  const target = normalizeForCompare(candidate);
  const rel = relative(base, target);
  if (rel === '') return allowEqual;
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
  return true;
}

async function resolveWorkspaceRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || CONTROL_CHAR_RE.test(cwd)) {
    throw fail('INVALID_ARGUMENT', 'Bot workspace cwd must be a valid directory path.');
  }
  const rawCwd = resolve(cwd);
  let realCwd;
  try {
    realCwd = await realpath(rawCwd);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw fail('INVALID_ARGUMENT', 'Bot workspace cwd does not exist.');
    }
    throw err;
  }
  const info = await lstat(realCwd);
  if (!info.isDirectory()) {
    throw fail('INVALID_ARGUMENT', 'Bot workspace cwd is not a directory.');
  }
  return { rawCwd, realCwd };
}

function rebaseAbsoluteIntoReal(rawBase, realBase, rawInput) {
  if (!isAbsolute(rawInput)) return resolve(realBase, rawInput);
  const abs = resolve(rawInput);
  if (isWithinDir(realBase, abs, { allowEqual: false })) return abs;
  if (isWithinDir(rawBase, abs, { allowEqual: false })) {
    return join(realBase, relative(rawBase, abs));
  }
  return abs;
}

function validatePathSegment(segment) {
  if (
    typeof segment !== 'string' ||
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    !segment.isWellFormed() ||
    BAD_PATH_SEGMENT.test(segment) ||
    /[. ]$/.test(segment) ||
    RESERVED_WINDOWS_NAME.test(segment) ||
    Buffer.byteLength(segment, 'utf8') > 255
  ) {
    throw fail('INVALID_ARGUMENT', `Unsafe destination path segment: ${segment}`);
  }
}

function validateUploadDisplayName(name) {
  if (typeof name !== 'string' || name.trim() === '' || CONTROL_CHAR_RE.test(name)) {
    throw fail('INVALID_ARGUMENT', 'File name must be a non-empty string.');
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw fail('INVALID_ARGUMENT', 'File name must not contain path separators.');
  }
  return safeBotFileName(name.trim());
}

/**
 * Resolves a local file path or attachment://<sha256> reference strictly within the Bot's
 * canonical workspace (or the Bot's own attachment store when dataRoot & botId are provided).
 */
async function resolveReadableHostFile(rawPath, { rawCwd, realCwd, dataRoot, botId }) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '' || CONTROL_CHAR_RE.test(rawPath)) {
    throw fail('INVALID_ARGUMENT', 'File path must be a non-empty string without control characters.');
  }
  const attachmentId = parseAttachmentRef(rawPath);
  if (attachmentId !== null) {
    if (typeof dataRoot !== 'string' || !dataRoot || typeof botId !== 'string' || !botId) {
      throw fail('INVALID_ARGUMENT', 'attachment:// references require Host bot attachment context (dataRoot and botId).');
    }
    const meta = await loadAttachmentMeta(dataRoot, botId, attachmentId);
    const attDir = await realpath(botAttachmentDirectory(dataRoot, botId));
    const file = attachmentPath(dataRoot, botId, attachmentId);
    const linkInfo = await lstat(file);
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw fail('FORBIDDEN', 'Attachment target must be a regular non-symlink file.');
    }
    const realFile = await realpath(file);
    if (!isWithinDir(attDir, realFile, { allowEqual: false })) {
      throw fail('FORBIDDEN', 'Attachment path escapes Bot attachment directory.');
    }
    return {
      realPath: realFile,
      name: safeBotFileName(meta.name),
      source: 'attachment',
      cacheKey: `att:${attachmentId}`,
    };
  }

  let candidate = rebaseAbsoluteIntoReal(rawCwd, realCwd, rawPath);
  let allowedRoot = null;
  if (isWithinDir(realCwd, candidate, { allowEqual: false })) {
    allowedRoot = realCwd;
  } else if (typeof dataRoot === 'string' && dataRoot && typeof botId === 'string' && botId) {
    const botFilesDir = join(botAttachmentDirectory(dataRoot, botId), 'files');
    const realBotFilesDir = await realpath(botFilesDir).catch(() => null);
    if (realBotFilesDir) {
      const rebased = rebaseAbsoluteIntoReal(botFilesDir, realBotFilesDir, rawPath);
      if (isWithinDir(realBotFilesDir, rebased, { allowEqual: false })) {
        candidate = rebased;
        allowedRoot = realBotFilesDir;
      }
    }
  }
  if (!allowedRoot) {
    throw fail('FORBIDDEN', `File path escapes Bot workspace: ${rawPath}`);
  }

  let candidateInfo;
  try {
    candidateInfo = await lstat(candidate);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw fail('INVALID_ARGUMENT', `File does not exist: ${rawPath}`);
    }
    throw err;
  }
  if (candidateInfo.isDirectory()) {
    throw fail('INVALID_ARGUMENT', `Path is a directory, not a regular file: ${rawPath}`);
  }

  let realTarget;
  try {
    realTarget = await realpath(candidate);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw fail('INVALID_ARGUMENT', `File target does not exist: ${rawPath}`);
    }
    throw err;
  }
  if (!isWithinDir(allowedRoot, realTarget, { allowEqual: false })) {
    throw fail('FORBIDDEN', `Symbolic link target escapes allowed Bot directory: ${rawPath}`);
  }
  const targetInfo = await lstat(realTarget);
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw fail('INVALID_ARGUMENT', `Only regular files can be transferred: ${rawPath}`);
  }
  return {
    realPath: realTarget,
    name: safeBotFileName(basename(candidate)),
    source: allowedRoot === realCwd ? 'workspace' : 'bot-files',
    cacheKey: `file:${realTarget}`,
  };
}

/**
 * Reads a regular file via O_NOFOLLOW up to maxBytes without trusting stat.size against growth.
 */
async function readFileBounded(realPath, maxBytes, verb, signal) {
  signal?.throwIfAborted?.();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw fail('INVALID_ARGUMENT', `Size limit exceeded while preparing ${verb}.`);
  }
  let handle = null;
  try {
    handle = await open(realPath, constants.O_RDONLY | NOFOLLOW_FLAG);
    const info = await handle.stat();
    if (!info.isFile()) {
      throw fail('INVALID_ARGUMENT', 'Only regular files can be transferred.');
    }
    if (info.size > maxBytes) {
      throw fail('INVALID_ARGUMENT', `File is too large; ${verb} takes up to ${formatSizeLimit(maxBytes)}.`);
    }
    const chunks = [];
    let total = 0;
    const chunkSize = Math.min(READ_CHUNK_BYTES, Math.max(1, maxBytes + 1));
    const buf = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      signal?.throwIfAborted?.();
      const remainingPlusOne = maxBytes + 1 - total;
      const toRead = Math.min(buf.length, remainingPlusOne);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw fail('INVALID_ARGUMENT', `File is too large; ${verb} takes up to ${formatSizeLimit(maxBytes)}.`);
      }
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    const bytes = total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);
    return {
      bytes,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (err) {
    if (err?.code === 'ELOOP') {
      throw fail('FORBIDDEN', 'Refusing to follow symbolic link while reading file.');
    }
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function hashFileOnDisk(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function decodeCanonicalBase64(data, maxBytes) {
  if (typeof data !== 'string') {
    throw fail('BAD_RESPONSE', 'Downloaded file payload is missing base64 data.');
  }
  if (data.length === 0) return Buffer.alloc(0);
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw fail('BAD_RESPONSE', 'Downloaded file payload is not valid canonical base64.');
  }
  const maxEncoded = 4 * Math.ceil(maxBytes / 3);
  if (data.length > maxEncoded) {
    throw fail('BAD_RESPONSE', `Downloaded file exceeds the ${formatSizeLimit(maxBytes)} limit.`);
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > maxBytes) {
    throw fail('BAD_RESPONSE', `Downloaded file exceeds the ${formatSizeLimit(maxBytes)} limit.`);
  }
  if (bytes.toString('base64') !== data) {
    throw fail('BAD_RESPONSE', 'Downloaded file payload is not canonical base64.');
  }
  return bytes;
}

function sniffAttachmentImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

/**
 * Validates an explicit destination path inside realCwd, refusing escapes, symlinks,
 * reserved filenames, and existing targets (no silent overwrite).
 */
async function inspectExplicitWriteTarget(rawCwd, realCwd, rawOut) {
  if (typeof rawOut !== 'string' || rawOut.trim() === '' || CONTROL_CHAR_RE.test(rawOut)) {
    throw fail('INVALID_ARGUMENT', 'out path must be a non-empty string without control characters.');
  }
  if (rawOut.length > 1_024) {
    throw fail('INVALID_ARGUMENT', 'out path exceeds 1,024 characters.');
  }
  const candidate = rebaseAbsoluteIntoReal(rawCwd, realCwd, rawOut);
  if (!isWithinDir(realCwd, candidate, { allowEqual: false })) {
    throw fail('FORBIDDEN', `Destination path escapes Bot workspace: ${rawOut}`);
  }
  const rel = relative(realCwd, candidate);
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length === 0) {
    throw fail('INVALID_ARGUMENT', 'Destination path must name a file inside the workspace.');
  }
  for (const part of parts) {
    validatePathSegment(part);
  }
  let current = realCwd;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const isLast = i === parts.length - 1;
    let info;
    try {
      info = await lstat(current);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { candidate, parts };
      }
      throw err;
    }
    if (info.isSymbolicLink()) {
      throw fail('FORBIDDEN', 'Refusing to write through or onto a symbolic link.');
    }
    if (isLast) {
      throw fail('FILE_EXISTS', `Destination already exists: ${rawOut}; choose a new path without overwriting.`);
    }
    if (!info.isDirectory()) {
      throw fail('INVALID_ARGUMENT', `Parent component is not a directory: ${parts[i]}`);
    }
  }
  return { candidate, parts };
}

/**
 * Ensures a chain of subdirectories under realCwd exists without traversing any symlink.
 */
async function ensureSafeSubdirs(realCwd, dirParts, mode = 0o700) {
  let current = realCwd;
  for (const part of dirParts) {
    validatePathSegment(part);
    current = join(current, part);
    try {
      await mkdir(current, { mode });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw fail('FORBIDDEN', `Refusing to traverse symbolic link directory: ${part}`);
    }
    if (!info.isDirectory()) {
      throw fail('INVALID_ARGUMENT', `Path component is not a directory: ${part}`);
    }
  }
  const realDir = await realpath(current);
  if (!isWithinDir(realCwd, realDir, { allowEqual: true })) {
    throw fail('FORBIDDEN', 'Resolved destination directory escapes Bot workspace.');
  }
  return realDir;
}

/**
 * Stages bytes in a private 0o600 temp file and atomically places it at targetPath without overwriting.
 */
async function writeFileAtomicNoOverwrite(dir, targetPath, bytes) {
  const tmpPath = join(dir, `.pibot-google-${process.pid}-${randomUUID()}.part`);
  let handle = null;
  let tmpExists = false;
  try {
    handle = await open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW_FLAG, 0o600);
    tmpExists = true;
    await handle.writeFile(bytes);
    await handle.close();
    handle = null;
    try {
      await link(tmpPath, targetPath);
      await unlink(tmpPath).catch(() => {});
      tmpExists = false;
      return;
    } catch (err) {
      if (err?.code === 'EEXIST') {
        throw fail('FILE_EXISTS', 'Destination already exists; refusing to overwrite.');
      }
      if (!['EPERM', 'EXDEV', 'ENOTSUP', 'ENOSYS', 'EACCES'].includes(err?.code)) {
        throw err;
      }
      // Fallback for filesystems without hard-link support: O_CREAT | O_EXCL still prevents overwrite.
      let direct = null;
      let created = false;
      try {
        direct = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW_FLAG, 0o600);
        created = true;
        await direct.writeFile(bytes);
        await direct.close();
        direct = null;
      } catch (directErr) {
        if (direct) await direct.close().catch(() => {});
        if (created) await unlink(targetPath).catch(() => {});
        if (directErr?.code === 'EEXIST') {
          throw fail('FILE_EXISTS', 'Destination already exists; refusing to overwrite.');
        }
        throw directErr;
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (tmpExists) await unlink(tmpPath).catch(() => {});
  }
}

async function verifyExistingDedupFile(destPath, expectedSize, expectedSha256) {
  const info = await lstat(destPath);
  if (info.isSymbolicLink()) {
    throw fail('FORBIDDEN', 'Refusing to reuse a symbolic link in the download store.');
  }
  if (!info.isFile() || info.size !== expectedSize || (await hashFileOnDisk(destPath)) !== expectedSha256) {
    throw fail('REQUEST_CONFLICT', 'Existing downloaded file was modified; move or remove it before retrying.');
  }
}

async function saveDownloadedBytes({ rawCwd, realCwd, dataRoot, botId, rawOut, rawName, fallbackId, data, bytes, sha256 }) {
  const safeName = safeBotFileName(typeof rawName === 'string' && rawName.trim() ? rawName.trim() : (fallbackId || 'download'));

  // Mode 1: explicit out path inside Bot workspace (never overwrite).
  if (rawOut !== undefined) {
    const { parts } = await inspectExplicitWriteTarget(rawCwd, realCwd, rawOut);
    const parentDir = await ensureSafeSubdirs(realCwd, parts.slice(0, -1));
    const finalPath = join(parentDir, parts[parts.length - 1]);
    if (!isWithinDir(realCwd, finalPath, { allowEqual: false })) {
      throw fail('FORBIDDEN', 'Resolved destination path escapes Bot workspace.');
    }
    await writeFileAtomicNoOverwrite(parentDir, finalPath, bytes);
    return {
      name: safeName,
      savedTo: finalPath,
      relativePath: relative(realCwd, finalPath),
      sha256,
      size: bytes.length,
      deduplicated: false,
    };
  }

  // Mode 2a: valid JPEG/PNG image + Bot attachment store context -> reuse host-core/attachments.js
  // content-addressed storage and return structured attachment://<sha256> ref without exposing dataRoot.
  if (typeof dataRoot === 'string' && dataRoot && typeof botId === 'string' && botId) {
    const sniffedMime = sniffAttachmentImageMime(bytes);
    if (sniffedMime && bytes.length > 0 && bytes.length <= ATTACHMENT_LIMITS.maxImageBytes) {
      const existingAtt = await lstat(attachmentPath(dataRoot, botId, sha256)).catch(() => null);
      try {
        const meta = await uploadAttachment(dataRoot, botId, {
          name: safeName,
          mimeType: sniffedMime,
          data,
        });
        return {
          name: meta.name,
          attachmentRef: formatAttachmentRef(meta.id),
          mimeType: meta.mimeType,
          width: meta.width,
          height: meta.height,
          sha256: meta.id,
          size: meta.size,
          deduplicated: Boolean(existingAtt?.isFile()),
        };
      } catch {
        // Malformed image header or oversized dimensions fall through to workspace download store.
      }
    }
  }

  // Mode 2b: content-addressed private download directory inside Bot workspace with SHA-256 deduplication.
  const hashDir = await ensureSafeSubdirs(realCwd, [GOOGLE_DOWNLOAD_DIR_NAME, sha256], 0o700);
  const destPath = join(hashDir, safeName);
  const existing = await lstat(destPath).catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (existing) {
    await verifyExistingDedupFile(destPath, bytes.length, sha256);
    return {
      name: safeName,
      savedTo: destPath,
      relativePath: relative(realCwd, destPath),
      sha256,
      size: bytes.length,
      deduplicated: true,
    };
  }
  try {
    await writeFileAtomicNoOverwrite(hashDir, destPath, bytes);
    return {
      name: safeName,
      savedTo: destPath,
      relativePath: relative(realCwd, destPath),
      sha256,
      size: bytes.length,
      deduplicated: false,
    };
  } catch (err) {
    if (err?.code === 'FILE_EXISTS') {
      await verifyExistingDedupFile(destPath, bytes.length, sha256);
      return {
        name: safeName,
        savedTo: destPath,
        relativePath: relative(realCwd, destPath),
        sha256,
        size: bytes.length,
        deduplicated: true,
      };
    }
    throw err;
  }
}

function assertJsonPayloadWithinBudget(payload, message) {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PAIRED_REQUEST_PARAMS_MAX_BYTES) {
    throw fail(
      'INVALID_ARGUMENT',
      message ?? `Request payload exceeds the ${formatSizeLimit(PAIRED_REQUEST_PARAMS_MAX_BYTES)} transfer limit.`
    );
  }
}

async function stageOptionalTextOrJsonFile(name, prepared, ctx) {
  const spec = TEXT_FILE_FIELD_MAP[name];
  if (!spec || prepared[spec.fileKey] === undefined) return prepared;
  if (prepared[spec.targetKey] !== undefined) {
    throw fail('INVALID_ARGUMENT', `Pass either ${spec.targetKey} or ${spec.fileKey}, not both.`);
  }
  const resolved = await resolveReadableHostFile(prepared[spec.fileKey], ctx);
  const { bytes } = await readFileBounded(
    resolved.realPath,
    PAIRED_REQUEST_PARAMS_MAX_BYTES,
    `${name} ${spec.fileKey}`,
    ctx.signal
  );
  const text = bytes.toString('utf8');
  let value;
  if (spec.kind === 'text') {
    value = text;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail('INVALID_ARGUMENT', `${spec.fileKey} must contain valid JSON.`);
    }
    if (!Array.isArray(parsed)) {
      throw fail('INVALID_ARGUMENT', `${spec.fileKey} must contain a JSON array.`);
    }
    if (spec.kind === 'json-rows' && !parsed.every((row) => Array.isArray(row))) {
      throw fail('INVALID_ARGUMENT', `${spec.fileKey} must contain a JSON array of rows.`);
    }
    value = parsed;
  }
  const next = { ...prepared };
  delete next[spec.fileKey];
  next[spec.targetKey] = value;
  assertJsonPayloadWithinBudget(next);
  return next;
}

async function prepareDriveUpload(args, ctx) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw fail('INVALID_ARGUMENT', 'drive_upload arguments must be an object.');
  }
  if (args.data !== undefined) {
    throw fail('INVALID_ARGUMENT', 'Do not pass raw base64 data to drive_upload; pass a local workspace path.');
  }
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    throw fail('INVALID_ARGUMENT', 'drive_upload requires a local workspace path (or attachment://<sha256>).');
  }
  const resolved = await resolveReadableHostFile(args.path, ctx);
  const read = await readFileBounded(resolved.realPath, DRIVE_UPLOAD_MAX_BYTES, 'drive upload', ctx.signal);
  const displayName = args.name !== undefined ? validateUploadDisplayName(args.name) : resolved.name;
  const prepared = { ...args };
  delete prepared.path;
  prepared.name = displayName;
  prepared.data = read.bytes.toString('base64');
  assertJsonPayloadWithinBudget(
    prepared,
    `drive_upload payload exceeds ${formatSizeLimit(PAIRED_REQUEST_PARAMS_MAX_BYTES)}.`
  );
  return prepared;
}

function collectGmailAttachmentSpecs(args) {
  const entries = [];
  if (args.attach !== undefined) {
    const rawAttach = Array.isArray(args.attach) ? args.attach : [args.attach];
    for (const item of rawAttach) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw fail('INVALID_ARGUMENT', 'Each gmail_draft attach entry must be a file path string.');
      }
      entries.push({ path: item });
    }
  }
  if (args.attachments !== undefined) {
    if (!Array.isArray(args.attachments)) {
      throw fail('INVALID_ARGUMENT', 'gmail_draft attachments must be an array of file paths.');
    }
    for (const item of args.attachments) {
      if (typeof item === 'string') {
        entries.push({ path: item });
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw fail('INVALID_ARGUMENT', 'Each gmail_draft attachment must be a path string or { path, name? }.');
      }
      if (item.data !== undefined) {
        throw fail('INVALID_ARGUMENT', 'Do not pass raw base64 data in gmail_draft attachments; pass local file paths.');
      }
      if (typeof item.path !== 'string' || item.path.trim() === '') {
        throw fail('INVALID_ARGUMENT', 'Each gmail_draft attachment object must include a non-empty path.');
      }
      entries.push({ path: item.path, ...(item.name !== undefined ? { name: item.name } : {}) });
    }
  }
  return entries;
}

async function prepareGmailDraft(args, ctx) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw fail('INVALID_ARGUMENT', 'gmail_draft arguments must be an object.');
  }
  let prepared = await stageOptionalTextOrJsonFile('gmail_draft', { ...args }, ctx);
  const specs = collectGmailAttachmentSpecs(prepared);
  if (specs.length > GMAIL_DRAFT_MAX_ATTACHMENTS) {
    throw fail('INVALID_ARGUMENT', `gmail_draft supports at most ${GMAIL_DRAFT_MAX_ATTACHMENTS} attachments.`);
  }
  delete prepared.attach;
  if (specs.length === 0) {
    if (prepared.attachments !== undefined) prepared.attachments = [];
    return prepared;
  }

  let room = GMAIL_DRAFT_ATTACH_MAX_BYTES;
  const cache = new Map();
  const staged = [];
  for (const spec of specs) {
    const resolved = await resolveReadableHostFile(spec.path, ctx);
    let read = cache.get(resolved.cacheKey);
    if (!read) {
      read = await readFileBounded(
        resolved.realPath,
        room,
        'gmail draft attachments (share a Drive link for bigger files)',
        ctx.signal
      );
      cache.set(resolved.cacheKey, read);
    } else if (read.size > room) {
      throw fail(
        'INVALID_ARGUMENT',
        `Attachments exceed the ${formatSizeLimit(GMAIL_DRAFT_ATTACH_MAX_BYTES)} draft limit; share a Drive link instead.`
      );
    }
    room -= read.size;
    const displayName = spec.name !== undefined ? validateUploadDisplayName(spec.name) : resolved.name;
    staged.push({ name: displayName, data: read.bytes.toString('base64') });
  }
  prepared.attachments = staged;
  assertJsonPayloadWithinBudget(
    prepared,
    'The body and attachments together are too large for one draft; shorten the body or share the files as a Drive link.'
  );
  return prepared;
}

async function prepareDownloadCall(args, ctx) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw fail('INVALID_ARGUMENT', 'Download tool arguments must be an object.');
  }
  if (args.out !== undefined) {
    await inspectExplicitWriteTarget(ctx.rawCwd, ctx.realCwd, args.out);
  }
  if (!Object.prototype.hasOwnProperty.call(args, 'out')) {
    return { ...args };
  }
  const prepared = { ...args };
  delete prepared.out;
  return prepared;
}

function isMcpResultEnvelope(result) {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.content));
}

function isDownloadPayloadObject(value, { requireGmailAttachmentRef = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.data !== 'string' || typeof value.name !== 'string') return false;
  if (requireGmailAttachmentRef) {
    return typeof value.ref === 'string' && value.ref.startsWith('gmail:att:');
  }
  return true;
}

function extractDownloadPayload(result, { requireGmailAttachmentRef = false } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  if (!isMcpResultEnvelope(result)) {
    if (isDownloadPayloadObject(result, { requireGmailAttachmentRef })) {
      return { envelope: 'raw', payload: result };
    }
    return null;
  }
  if (isDownloadPayloadObject(result.structuredContent, { requireGmailAttachmentRef })) {
    return { envelope: 'mcp', payload: result.structuredContent };
  }
  for (const block of result.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      try {
        const parsed = JSON.parse(block.text);
        if (isDownloadPayloadObject(parsed, { requireGmailAttachmentRef })) {
          return { envelope: 'mcp', payload: parsed };
        }
      } catch {
        // Non-JSON text block; continue scanning.
      }
    }
  }
  return null;
}

export function isGoogleFileTransferTool(name) {
  return typeof name === 'string' && FILE_TRANSFER_TOOLS.has(name);
}

/**
 * Host pre-call hook invoked before sending a Google Workspace tool call to Center.
 * Never mutates the caller's args object so finishGoogleFileCall still receives original args.out.
 */
export async function prepareGoogleFileCall(name, args, options) {
  if (typeof name !== 'string' || !FILE_TRANSFER_TOOLS.has(name)) {
    return args;
  }
  options?.signal?.throwIfAborted?.();
  const { rawCwd, realCwd } = await resolveWorkspaceRoot(options?.cwd);
  const ctx = {
    rawCwd,
    realCwd,
    dataRoot: options?.dataRoot,
    botId: options?.botId,
    signal: options?.signal,
  };

  if (name === 'drive_upload') {
    return prepareDriveUpload(args, ctx);
  }
  if (name === 'gmail_draft') {
    return prepareGmailDraft(args, ctx);
  }
  if (name === 'drive_download' || name === 'gmail_attachment') {
    return prepareDownloadCall(args, ctx);
  }
  if (name === 'gmail_read') {
    if (args && typeof args === 'object' && !Array.isArray(args) && (args.download !== undefined || args.out !== undefined)) {
      return prepareDownloadCall(args, ctx);
    }
    return args;
  }
  if (TEXT_FILE_FIELD_MAP[name]) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    return stageOptionalTextOrJsonFile(name, { ...args }, ctx);
  }
  return args;
}

/**
 * Host post-call hook invoked after receiving a Google Workspace tool result from Center.
 * Writes downloaded bytes securely inside the Bot workspace / attachment store and removes all
 * base64 binary payloads so binary data never flows back to the model or chat history.
 */
export async function finishGoogleFileCall(name, result, options) {
  if (typeof name !== 'string') return result;
  const isStrictDownload = name === 'drive_download' || name === 'gmail_attachment';
  const isConditionalDownload = name === 'gmail_read';
  if (!isStrictDownload && !isConditionalDownload) {
    return result;
  }
  if (!result || typeof result !== 'object') {
    if (isStrictDownload) {
      throw fail('BAD_RESPONSE', `Download tool ${name} returned an invalid response.`);
    }
    return result;
  }
  if (result.isError === true) {
    return result;
  }

  const extracted = extractDownloadPayload(result, {
    requireGmailAttachmentRef: isConditionalDownload,
  });
  if (!extracted) {
    if (isStrictDownload) {
      throw fail('BAD_RESPONSE', `Download tool ${name} response did not contain a valid file payload.`);
    }
    return result;
  }

  options?.signal?.throwIfAborted?.();
  const { rawCwd, realCwd } = await resolveWorkspaceRoot(options?.cwd);
  const { payload, envelope } = extracted;
  const bytes = decodeCanonicalBase64(payload.data, TOOL_DOWNLOAD_MAX_BYTES);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const rawOut =
    options?.args && typeof options.args === 'object' && !Array.isArray(options.args)
      ? options.args.out
      : undefined;
  const fallbackId =
    (typeof payload.file?.id === 'string' && payload.file.id) ||
    (typeof payload.ref === 'string' && payload.ref.replaceAll(':', '-')) ||
    sha256.slice(0, 16);

  const saved = await saveDownloadedBytes({
    rawCwd,
    realCwd,
    dataRoot: options?.dataRoot,
    botId: options?.botId,
    rawOut,
    rawName: payload.name,
    fallbackId,
    data: payload.data,
    bytes,
    sha256,
  });

  const { data: _strippedData, ...metadataWithoutData } = payload;
  const sanitized = {
    ...metadataWithoutData,
    name: saved.name,
    sha256: saved.sha256,
    size: saved.size,
    deduplicated: saved.deduplicated,
    ...(saved.savedTo ? { savedTo: saved.savedTo, relativePath: saved.relativePath } : {}),
    ...(saved.attachmentRef ? { attachmentRef: saved.attachmentRef } : {}),
    ...(saved.mimeType && !metadataWithoutData.mimeType ? { mimeType: saved.mimeType } : {}),
    ...(saved.width !== undefined ? { width: saved.width, height: saved.height } : {}),
  };

  if (envelope === 'raw') {
    return sanitized;
  }
  const nextResult = {
    ...result,
    content: [{ type: 'text', text: JSON.stringify(sanitized) }],
    isError: false,
  };
  delete nextResult.data;
  if (Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
    nextResult.structuredContent = sanitized;
  }
  return nextResult;
}
