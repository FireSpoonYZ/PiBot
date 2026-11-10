// Reads the bundle identity of a macOS updater artifact (<Name>.app.tar.gz):
// the gzip-compressed tar the Tauri bundler writes with a single top-level
// <Name>.app/ directory. Only Node built-ins are used so release tooling can
// import this file without installing center-server dependencies.
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const BLOCK = 512;
const MAX_PLIST_BYTES = 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const INFO_PLIST_RE = /^(?:\.\/)?([^/]+\.app)\/Contents\/Info\.plist$/;

function field(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

function entrySize(block) {
  const raw = block.subarray(124, 136);
  if (raw[0] & 0x80) {
    // GNU base-256 encoding for large members.
    let size = 0;
    for (let i = 1; i < raw.length; i++) size = size * 256 + raw[i];
    return size;
  }
  const text = field(block, 124, 12).trim();
  if (!/^[0-7]*$/.test(text)) return -1;
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function checksumMatches(block) {
  const stored = field(block, 148, 8).trim();
  if (!/^[0-7]+$/.test(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === Number.parseInt(stored, 8);
}

function paxPath(data) {
  let path = null;
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    if (record.startsWith('path=')) path = record.slice(5);
    offset += length;
  }
  return path;
}

function plistString(xml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  if (!match) return null;
  return match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

/**
 * Returns {bundleName, identifier, version, bundleVersion, executable} from
 * <Name>.app/Contents/Info.plist (XML plist), or null when the file is not a
 * gzip tar, the tar headers are corrupt, or no Info.plist is found.
 */
export async function readAppBundleInfo(filePath) {
  const source = createReadStream(filePath);
  const stream = createGunzip();
  // pipe() does not forward source errors; without this a read error would hang.
  source.on('error', (err) => stream.destroy(err));
  source.pipe(stream);
  let buffer = Buffer.alloc(0);
  let pending = null; // { name, remaining, padding, capture: Buffer[] | null, kind }
  let nextName = null;
  let result = null;
  try {
    outer: for await (const chunk of stream) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (pending) {
          const take = Math.min(pending.remaining, buffer.length);
          if (pending.capture) pending.capture.push(buffer.subarray(0, take));
          buffer = buffer.subarray(take);
          pending.remaining -= take;
          if (pending.remaining > 0) continue outer;
          const skip = Math.min(pending.padding, buffer.length);
          buffer = buffer.subarray(skip);
          pending.padding -= skip;
          if (pending.padding > 0) continue outer;
          const done = pending;
          pending = null;
          if (done.kind === 'longname') nextName = Buffer.concat(done.capture).toString('utf8').replace(/\0+$/, '');
          else if (done.kind === 'pax') nextName = paxPath(Buffer.concat(done.capture)) ?? nextName;
          else if (done.kind === 'plist') {
            const xml = Buffer.concat(done.capture).toString('utf8');
            if (!xml.includes('<plist')) return null;
            result = {
              bundleName: done.bundleName,
              identifier: plistString(xml, 'CFBundleIdentifier'),
              version: plistString(xml, 'CFBundleShortVersionString'),
              bundleVersion: plistString(xml, 'CFBundleVersion'),
              executable: plistString(xml, 'CFBundleExecutable'),
            };
            break outer;
          }
          continue;
        }
        if (buffer.length < BLOCK) continue outer;
        const header = buffer.subarray(0, BLOCK);
        buffer = buffer.subarray(BLOCK);
        if (header.every((byte) => byte === 0)) break outer;
        if (!checksumMatches(header)) return null;
        const size = entrySize(header);
        if (size < 0) return null;
        const type = String.fromCharCode(header[156] || 0x30);
        // Only POSIX ustar ("ustar\0") has a name prefix; GNU headers ("ustar ")
        // reuse those bytes for timestamps and use ././@LongLink entries instead.
        const prefix = header.toString('latin1', 257, 263) === 'ustar\0' ? field(header, 345, 155) : '';
        const headerName = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === 'L' || type === 'x') {
          if (size > MAX_META_BYTES) return null;
          pending = { kind: type === 'L' ? 'longname' : 'pax', remaining: size, padding, capture: [] };
          continue;
        }
        const name = nextName ?? headerName;
        nextName = null;
        const match = type === '0' || type === '\0' ? INFO_PLIST_RE.exec(name) : null;
        if (match) {
          if (size > MAX_PLIST_BYTES) return null;
          pending = { kind: 'plist', bundleName: match[1], remaining: size, padding, capture: [] };
        } else {
          pending = { kind: 'skip', remaining: size, padding, capture: null };
        }
      }
    }
  } catch {
    return null;
  } finally {
    source.destroy();
    stream.destroy();
  }
  return result;
}
