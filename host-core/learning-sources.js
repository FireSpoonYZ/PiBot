import { constants } from 'node:fs';
import { realpath, stat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { messageError } from './message-protocol.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PAGE_BYTES = 24 * 1024;
const invalid = (message) => messageError('INVALID_ARGUMENT', message);
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

function decodeUtf8Page(bytes, hasMore) {
  try {
    // Preserve BOM bytes so re-encoding the returned text gives the exact consumed byte count.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: hasMore });
  } catch {
    throw invalid('Learning source is not supported UTF-8 text, or offset is not on a character boundary');
  }
}

export async function declareLearningSources(values, cwd) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 16) throw invalid('sources must contain at most 16 paths or URLs');
  const sources = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw invalid('Invalid learning source');
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.username || url.password) throw invalid('Source URLs must not contain credentials');
      sources.push({ kind: 'url', value: url.href });
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw invalid('Only http(s) source URLs are supported');
      const root = await realpath(path.resolve(cwd, value));
      const info = await stat(root);
      if (!info.isFile() && !info.isDirectory()) throw invalid('Source must be a regular file or directory');
      sources.push({ kind: info.isDirectory() ? 'directory' : 'file', value: root });
    }
  }
  return sources;
}

export async function readLearningSource(sources, args, signal, readWeb) {
  signal.throwIfAborted();
  if (!args || !Number.isSafeInteger(args.source) || args.source < 0 || args.source >= sources.length ||
      Object.keys(args).some((key) => !['source', 'action', 'path', 'offset'].includes(key))) throw invalid('Invalid source request');
  const source = sources[args.source];
  if (source.kind === 'url') {
    if (args.action !== 'web' || args.path !== undefined || args.offset !== undefined) throw invalid('URL sources require web without path/offset');
    const result = await readWeb(source.value, signal);
    if (typeof result?.content !== 'string') throw messageError('INVALID_STATE', 'Webfox returned no extracted material');
    if (!result.content.isWellFormed()) throw invalid('Webfox content is not supported Unicode text');
    const bytes = Buffer.from(result.content, 'utf8');
    const hasMore = bytes.length > PAGE_BYTES;
    return { url: source.value, content: decodeUtf8Page(bytes.subarray(0, PAGE_BYTES), hasMore), truncated: result.truncated === true || hasMore };
  }
  if (!['list', 'read'].includes(args.action)) throw invalid('Local sources require list or read');
  const relative = args.path ?? '';
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0') ||
      path.isAbsolute(relative) || (source.kind === 'file' && relative !== '')) throw invalid('Invalid source-relative path');
  const candidate = path.resolve(source.value, relative);
  if (!within(source.value, candidate)) throw invalid('Path leaves the declared source');
  const resolved = await realpath(candidate);
  // Reject nested symlinks/junctions rather than following them into undeclared material.
  if (resolved !== candidate) throw invalid('Symlinks are not readable learning material');
  signal.throwIfAborted();
  if (args.action === 'list') {
    if (source.kind !== 'directory' || args.offset !== undefined) throw invalid('list requires a directory source and no offset');
    const entries = [];
    let bytes = 0;
    const directory = await opendir(resolved);
    try {
      if (await realpath(candidate) !== resolved) throw invalid('Source changed while opening');
      for (;;) {
        signal.throwIfAborted();
        const entry = await directory.read();
        if (!entry) return { entries, truncated: false };
        const item = { name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
        bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
        if (entries.length === 200 || bytes > PAGE_BYTES) return { entries, truncated: true };
        entries.push(item);
      }
    } finally { await directory.close(); }
  }
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_BYTES) throw invalid('Invalid byte offset');
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    const current = await stat(resolved);
    if (await realpath(candidate) !== resolved || info.dev !== current.dev || info.ino !== current.ino) throw invalid('Source changed while opening');
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw invalid('Learning text files must be regular files at most 2 MiB');
    signal.throwIfAborted();
    const buffer = Buffer.alloc(Math.min(PAGE_BYTES, Math.max(0, info.size - offset)));
    let bytesRead = 0;
    let eof = false;
    while (bytesRead < buffer.length) {
      signal.throwIfAborted();
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      signal.throwIfAborted();
      if (chunk.bytesRead === 0) { eof = true; break; }
      bytesRead += chunk.bytesRead;
    }
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw invalid('Binary learning sources are not supported');
    const hasMore = !eof && offset + bytesRead < info.size;
    const content = decodeUtf8Page(bytes, hasMore);
    // A partial trailing character is read again at nextOffset, never emitted or skipped.
    const nextOffset = hasMore ? offset + Buffer.byteLength(content, 'utf8') : null;
    return { path: relative, offset, content, nextOffset, truncated: hasMore };
  } finally { await file.close(); }
}
