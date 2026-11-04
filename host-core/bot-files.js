// 文件在发送前冻结；收件端完成 SHA-256 校验、原子落盘后才发布 DM/群消息。
// 原图原样传输，接收 Bot 用 read 读取图片或文件；归档清理复用 attachments/<botId>。
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { botAttachmentDirectory } from './attachments.js';
import { messageError } from './message-protocol.js';
import { BOT_FILE_CHUNK_BYTES, safeBotFileName } from './bot-file-protocol.js';

const missingStat = async (path) => stat(path).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

function filePath(root, botId, file) {
  return join(botAttachmentDirectory(root, botId), 'files', file.id, file.name);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function snapshotBotFiles(root, bot, paths, signal) {
  const files = [];
  const directory = join(botAttachmentDirectory(root, bot.botId), 'files');
  await mkdir(directory, { recursive: true });
  for (const input of paths) {
    signal?.throwIfAborted();
    const source = resolve(bot.cwd, input);
    const info = await stat(source);
    if (!info.isFile()) throw messageError('INVALID_ARGUMENT', 'only regular files can be sent: ' + input);
    let name = basename(source);
    // 已上传图片按内容哈希命名，交接时保留其原展示名称和扩展名。
    if (dirname(source) === botAttachmentDirectory(root, bot.botId) && /^[0-9a-f]{64}$/.test(name)) {
      const metadata = JSON.parse(await readFile(source + '.json', 'utf8'));
      name = metadata.name;
    }
    name = safeBotFileName(name);
    const temporary = join(directory, '.' + randomUUID() + '.part');
    let output;
    try {
      output = await open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      for await (const bytes of createReadStream(source, { highWaterMark: BOT_FILE_CHUNK_BYTES, signal })) {
        size += bytes.length;
        hash.update(bytes);
        await output.writeFile(bytes);
      }
      await output.close();
      output = null;
      signal?.throwIfAborted();
      const file = { id: hash.digest('hex'), name, size };
      const path = filePath(root, bot.botId, file);
      await mkdir(dirname(path), { recursive: true });
      await rename(temporary, path);
      files.push({ ...file, path });
    } finally {
      if (output) await output.close();
      await rm(temporary, { force: true });
    }
  }
  return files;
}

/** 调用方持有目标 Bot admission lane；同 Bot 写入和删除串行。输入在控制边界验证。 */
export async function putBotFileChunk(root, botId, input) {
  const path = filePath(root, botId, input);
  const receipt = (received, complete) => ({
    id: input.id, name: input.name, size: input.size, received, complete,
    ...(complete ? { path } : {}),
  });
  const existing = await missingStat(path);
  if (existing) {
    if (!existing.isFile() || existing.size !== input.size || await hashFile(path) !== input.id) {
      throw messageError('REQUEST_CONFLICT', 'received file was modified; move it out of the attachment store before resending');
    }
    return receipt(input.size, true);
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(botAttachmentDirectory(root, botId), 'files', '.incoming', input.id, input.name);
  await mkdir(dirname(temporary), { recursive: true });
  const handle = await open(temporary, 'a+', 0o600);
  let received;
  try {
    received = (await handle.stat()).size;
    if (received > input.size) throw messageError('REQUEST_CONFLICT', 'partial file size conflicts');
    // 接收端丢失部分文件时，从实际进度继续；旧请求重复到达不会覆盖后面的数据。
    if (input.offset > received) return receipt(received, false);
    const bytes = Buffer.from(input.data, 'base64');
    const overlap = Math.min(bytes.length, received - input.offset);
    if (overlap > 0) {
      const previous = Buffer.alloc(overlap);
      const read = await handle.read(previous, 0, overlap, input.offset);
      if (read.bytesRead !== overlap || !previous.equals(bytes.subarray(0, overlap))) {
        throw messageError('REQUEST_CONFLICT', 'repeated file chunk has different bytes');
      }
    }
    if (overlap < bytes.length) {
      await handle.writeFile(bytes.subarray(overlap));
      received += bytes.length - overlap;
    }
  } finally {
    await handle.close();
  }
  if (received !== input.size) return receipt(received, false);
  if (await hashFile(temporary) !== input.id) {
    await rm(temporary, { force: true });
    throw messageError('REQUEST_CONFLICT', 'file SHA-256 verification failed; resend the file');
  }
  await rename(temporary, path);
  return receipt(received, true);
}

/** 一次调用最多传一块，遵守既有 1 MiB RPC 上限；重放使用相同快照与内容 ID。 */
export async function deliverBotFile(file, target, collaboration, signal) {
  const handle = await open(file.path, 'r');
  try {
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const bytes = Buffer.alloc(Math.min(BOT_FILE_CHUNK_BYTES, file.size - offset));
      let read = 0;
      while (read < bytes.length) {
        const next = await handle.read(bytes, read, bytes.length - read, offset + read);
        if (!next.bytesRead) throw messageError('STORE_FAILED', 'outgoing file snapshot is incomplete');
        read += next.bytesRead;
      }
      const result = await collaboration.putBotFileChunk({
        ...target,
        input: { id: file.id, name: file.name, size: file.size, offset, data: bytes.toString('base64') },
        signal,
      });
      if (result?.id !== file.id || result?.name !== file.name || result?.size !== file.size ||
          !Number.isSafeInteger(result.received) || result.received < 0 || result.received > file.size ||
          typeof result.complete !== 'boolean') {
        throw messageError('BAD_RESPONSE', 'invalid file transfer receipt');
      }
      if (result.complete) {
        if (result.received !== file.size || typeof result.path !== 'string' || !result.path) {
          throw messageError('BAD_RESPONSE', 'completed file transfer has no local path');
        }
        return { id: file.id, name: file.name, size: file.size, path: result.path };
      }
      if (result.received === offset || result.received === file.size) {
        throw messageError('BAD_RESPONSE', 'file transfer made no progress');
      }
      offset = result.received;
    }
  } finally {
    await handle.close();
  }
}
