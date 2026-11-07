import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { requireOwner } from './auth.js';

// Per-request multipart limits for this route only; the global registration in
// server.js keeps its own (smaller) limits for every other upload endpoint.
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FIELD_BYTES = 128 * 1024;
const MAX_SIGNATURE_LENGTH = 64 * 1024;
const MAX_NOTES_LENGTH = 32 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;
const MAX_AR_MEMBERS = 256;

const invalid = (message, code = 'INVALID_ARGUMENT') => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw invalid(message, code); };

// Only the release lanes approved for this round can ever be stored or served.
const ALLOWED_COMBINATIONS = {
  nsis: { windows: ['x86_64'] },
  deb: { linux: ['x86_64'] },
  apk: { android: ['aarch64', 'x86_64'] },
};
const EXTENSIONS = { nsis: 'exe', deb: 'deb', apk: 'apk' };
const FORMATS = new Set(Object.keys(ALLOWED_COMBINATIONS));
const METADATA_FIELDS = new Set(['version', 'platform', 'arch', 'format', 'size', 'sha256', 'signature', 'notes', 'sourceCommit', 'versionCode']);

function parseMetadata(value) {
  let data = value;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { fail('INVALID_ARGUMENT', 'metadata must be a JSON object'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_ARGUMENT', 'metadata must be a JSON object');
  for (const key of Object.keys(data)) {
    if (!METADATA_FIELDS.has(key)) fail('INVALID_ARGUMENT', 'Unknown metadata field: ' + key);
  }
  const { platform, arch, format } = data;
  if (typeof format !== 'string' || !FORMATS.has(format)) fail('INVALID_ARGUMENT', 'Unsupported format');
  const archs = typeof platform === 'string' && Object.hasOwn(ALLOWED_COMBINATIONS[format], platform)
    ? ALLOWED_COMBINATIONS[format][platform]
    : undefined;
  if (!Array.isArray(archs) || !archs.includes(arch)) fail('INVALID_ARGUMENT', 'Unsupported platform/arch/format combination');
  const version = typeof data.version === 'string' ? semver.valid(data.version) : null;
  if (!version) fail('INVALID_ARGUMENT', 'version must be a valid semver');
  if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_ARTIFACT_BYTES) fail('INVALID_ARGUMENT', 'Invalid artifact size');
  if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(data.sha256)) fail('INVALID_ARGUMENT', 'Invalid sha256');
  const sha256 = data.sha256.toLowerCase();
  const desktop = format !== 'apk';
  let signature = null;
  if (data.signature !== undefined) {
    if (typeof data.signature !== 'string' || !data.signature.trim() || data.signature.length > MAX_SIGNATURE_LENGTH) {
      fail('INVALID_ARGUMENT', 'Invalid signature');
    }
    signature = data.signature;
  }
  if (desktop) {
    if (signature === null) fail('INVALID_ARGUMENT', 'signature is required');
    signature = normalizeTauriSignature(signature);
  }
  let versionCode = null;
  if (data.versionCode !== undefined) {
    if (!Number.isSafeInteger(data.versionCode) || data.versionCode < 1) fail('INVALID_ARGUMENT', 'Invalid versionCode');
    versionCode = data.versionCode;
  }
  if (format === 'apk' && versionCode === null) fail('INVALID_ARGUMENT', 'versionCode is required for apk');
  if (format !== 'apk' && versionCode !== null) fail('INVALID_ARGUMENT', 'versionCode is only valid for apk');
  let notes = '';
  if (data.notes !== undefined) {
    if (typeof data.notes !== 'string' || data.notes.length > MAX_NOTES_LENGTH) fail('INVALID_ARGUMENT', 'Invalid notes');
    notes = data.notes;
  }
  if (typeof data.sourceCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(data.sourceCommit)) {
    fail('INVALID_ARGUMENT', 'Invalid sourceCommit');
  }
  const sourceCommit = data.sourceCommit.toLowerCase();
  return { version, platform, arch, format, size: data.size, sha256, signature, notes, sourceCommit, versionCode };
}

// Tauri updater signatures are minisign .sig text, but the updater's dynamic
// endpoint contract base64-decodes the `signature` field before minisign parsing
// (updater.rs verify_signature -> base64_to_string -> Signature::decode). The
// center therefore accepts raw .sig text or its base64 form on upload and always
// stores/serves the canonical base64 encoding.
function normalizeTauriSignature(signature) {
  const text = signature.trim();
  let content = text;
  if (!content.startsWith('untrusted comment:')) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(content)) fail('INVALID_ARGUMENT', 'Invalid signature encoding');
    content = Buffer.from(content, 'base64').toString('utf8');
  }
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) {
    fail('INVALID_ARGUMENT', 'Invalid signature encoding');
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(lines[1])) fail('INVALID_ARGUMENT', 'Invalid signature encoding');
  return Buffer.from(content, 'utf8').toString('base64');
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function verifyNsis(handle, size) {
  if (size < 0x40) return false;
  const head = await readAt(handle, 0, 0x40);
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
  const peOffset = head.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 4 > size) return false;
  const pe = await readAt(handle, peOffset, 4);
  return pe.length === 4 && pe[0] === 0x50 && pe[1] === 0x45 && pe[2] === 0 && pe[3] === 0;
}

// .deb is an ar archive: debian-binary plus control.tar.* and data.tar.* members.
async function verifyDeb(handle, size) {
  const head = await readAt(handle, 0, 8);
  if (head.length < 8 || head.toString('latin1') !== '!<arch>\n') return false;
  let offset = 8;
  let binaryBody = null;
  let sawControl = false;
  let sawData = false;
  for (let i = 0; i < MAX_AR_MEMBERS; i++) {
    if (offset + 60 > size) break;
    const header = await readAt(handle, offset, 60);
    if (header.length < 60) break;
    if (header.toString('latin1', 58, 60) !== '\x60\n') break;
    let name = header.toString('latin1', 0, 16).replace(/[\s\0]+$/, '');
    if (name.endsWith('/')) name = name.slice(0, -1);
    const memberSize = Number.parseInt(header.toString('latin1', 48, 58).trim(), 10);
    if (!Number.isSafeInteger(memberSize) || memberSize < 0) break;
    // A member body must fit inside the file or the archive is truncated.
    if (offset + 60 + memberSize > size) break;
    if (name === 'debian-binary') binaryBody = { offset: offset + 60, size: memberSize };
    else if (/^control\.tar([./]|$)/.test(name)) sawControl = true;
    else if (/^data\.tar([./]|$)/.test(name)) sawData = true;
    offset += 60 + memberSize + (memberSize % 2);
  }
  if (binaryBody === null || !sawControl || !sawData) return false;
  // debian-binary is the format marker whose content is the literal '2.0'.
  const marker = await readAt(handle, binaryBody.offset, Math.min(binaryBody.size, 4));
  return marker.length >= 3 && marker.toString('latin1', 0, 3) === '2.0';
}

// .apk is a zip whose central directory must list AndroidManifest.xml.
async function verifyApk(handle, size) {
  const head = await readAt(handle, 0, 4);
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) return false;
  const tailLength = Math.min(size, 22 + 65535);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) return false;
  // The EOCD record plus its comment must end exactly at the file tail; a
  // PK\x05\x06 signature inside the comment is not a valid directory end.
  const commentLength = tail.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== tail.length) return false;
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0 || entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) return false;
  if (cdOffset + cdSize > size || cdSize > MAX_CENTRAL_DIRECTORY_BYTES) return false;
  const directory = await readAt(handle, cdOffset, cdSize);
  if (directory.length < cdSize) return false;
  let position = 0;
  for (let i = 0; i < entries; i++) {
    if (position + 46 > directory.length) return false;
    if (directory.readUInt32LE(position) !== 0x02014b50) return false;
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const nameStart = position + 46;
    if (nameStart + nameLength > directory.length) return false;
    if (nameLength === 19 && directory.toString('utf8', nameStart, nameStart + nameLength) === 'AndroidManifest.xml') return true;
    position = nameStart + nameLength + extraLength + commentLength;
  }
  return false;
}

async function verifyArtifact(format, filePath, size) {
  const handle = await open(filePath, 'r');
  try {
    if (format === 'nsis') return await verifyNsis(handle, size);
    if (format === 'deb') return await verifyDeb(handle, size);
    return await verifyApk(handle, size);
  } finally {
    await handle.close();
  }
}

async function saveArtifact(part, directory) {
  const temporary = join(directory, '.upload-' + randomUUID());
  const handle = await open(temporary, 'w');
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) fail('PAYLOAD_TOO_LARGE', 'Artifact exceeds 2 GiB limit');
      hash.update(chunk);
      // FileHandle.write may return a short count; loop until the whole chunk is on disk.
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    }
    if (part.file.truncated) fail('PAYLOAD_TOO_LARGE', 'Artifact exceeds 2 GiB limit');
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
  return { path: temporary, size, sha256: hash.digest('hex') };
}

function filenameFor(meta) {
  const version = meta.version.replace(/[^0-9A-Za-z.-]/g, '-');
  return 'pibot-' + version + '-' + meta.platform + '-' + meta.arch + '.' + EXTENSIONS[meta.format];
}

function publicRecord(record, base) {
  return {
    id: record.id,
    platform: record.platform,
    arch: record.arch,
    format: record.format,
    version: record.version,
    ...(record.versionCode != null ? { versionCode: record.versionCode } : {}),
    size: record.size,
    sha256: record.sha256,
    ...(record.signature != null ? { signature: record.signature } : {}),
    notes: record.notes ?? '',
    sourceCommit: record.sourceCommit,
    filename: record.filename,
    published: record.published === true,
    publishedAt: record.publishedAt ?? null,
    createdAt: record.createdAt,
    downloadUrl: new URL('/api/client-releases/' + record.id + '/download', base).toString(),
  };
}

export function registerClientReleaseRoutes(app, { store, dataRoot, registry, internalDeviceId, publicUrl }) {
  const directory = join(dataRoot, 'client-releases');
  mkdirSync(directory, { recursive: true });
  const base = new URL(publicUrl);
  const ownerRead = [requireOwner];
  const ownerWrite = [requireOwner, app.csrfProtection];

  function requestAccess(req) {
    if (req.session.get('owner') === true) return 'owner';
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    const deviceId = req.headers['x-device-id'];
    if (!token || typeof deviceId !== 'string' || deviceId === internalDeviceId) return null;
    return registry.authenticate(deviceId, token) ? 'device' : null;
  }

  app.get('/api/client-releases', { onRequest: ownerRead }, async () => ({
    releases: store.listClientReleases().map((record) => publicRecord(record, base)),
  }));

  app.post('/api/client-releases', { onRequest: ownerWrite }, async (req, reply) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) fail('INVALID_ARGUMENT', 'Expected multipart form data');
    const parts = req.parts({ limits: { fileSize: MAX_ARTIFACT_BYTES, files: 1, fields: 1, fieldSize: MAX_FIELD_BYTES } });
    let metadata;
    let metadataError = null;
    let artifact = null;
    let artifactError = null;
    let artifactSeen = false;
    let tmpPath = null;
    try {
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'metadata' && metadata === undefined && metadataError === null) {
            if (part.fieldnameTruncated || part.valueTruncated) {
              metadataError = invalid('metadata field too large', 'PAYLOAD_TOO_LARGE');
            } else {
              try {
                const parsed = parseMetadata(part.value);
                if (store.findClientRelease(parsed)) fail('REQUEST_CONFLICT', 'Client release already exists');
                metadata = parsed;
              } catch (err) {
                metadataError = err;
              }
            }
          } else {
            metadataError ??= invalid('Unexpected form field');
          }
          continue;
        }
        if (part.type === 'file') {
          const expected = part.fieldname === 'artifact' && !artifactSeen;
          artifactSeen = true;
          if (!expected || metadataError !== null) {
            part.file.resume();
            if (!expected) artifactError ??= invalid('Unexpected file field');
            continue;
          }
          try {
            artifact = await saveArtifact(part, directory);
            tmpPath = artifact.path;
          } catch (err) {
            artifactError = err;
            try { part.file.resume(); } catch { /* stream already closed */ }
          }
          continue;
        }
        if (part.file) part.file.resume();
        artifactError ??= invalid('Unexpected form part');
      }
      if (metadataError !== null) throw metadataError;
      if (artifactError !== null) throw artifactError;
      if (metadata === undefined) fail('INVALID_ARGUMENT', 'metadata field is required');
      if (artifact === null) fail('INVALID_ARGUMENT', 'artifact file is required');
      if (metadata.size !== artifact.size || metadata.sha256 !== artifact.sha256) {
        fail('VALIDATION_FAILED', 'Artifact size or sha256 does not match metadata');
      }
      const matches = await verifyArtifact(metadata.format, tmpPath, artifact.size);
      if (!matches) fail('VALIDATION_FAILED', 'Artifact content does not match declared format');
      const id = randomUUID();
      const finalPath = join(directory, id);
      await rename(tmpPath, finalPath);
      tmpPath = null;
      const record = {
        id,
        ...metadata,
        filename: filenameFor(metadata),
        published: false,
        publishedAt: null,
        createdAt: new Date().toISOString(),
      };
      try {
        store.createClientRelease(record);
      } catch (err) {
        await rm(finalPath, { force: true }).catch(() => {});
        throw err;
      }
      return reply.code(201).send(publicRecord(record, base));
    } catch (err) {
      if (tmpPath !== null) await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  });

  app.post('/api/client-releases/:id/publish', { onRequest: ownerWrite }, async (req) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.published !== 'boolean' || Object.keys(body).some((key) => key !== 'published')) {
      fail('INVALID_ARGUMENT', 'Expected {published: boolean}');
    }
    return publicRecord(store.setClientReleasePublished(req.params.id, body.published), base);
  });

  app.get('/api/client-releases/:id/download', async (req, reply) => {
    const access = requestAccess(req);
    if (access === null) fail('UNAUTHENTICATED', 'Authentication required');
    const record = store.getClientRelease(req.params.id);
    if (!record || (!record.published && access !== 'owner')) fail('NOT_FOUND', 'Client release not found');
    const filePath = join(directory, record.id);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      fail('NOT_FOUND', 'Release artifact missing');
    }
    reply.header('Content-Disposition', 'attachment; filename="' + record.filename + '"');
    reply.header('Content-Length', info.size);
    reply.type('application/octet-stream');
    return reply.send(createReadStream(filePath));
  });

  app.get('/api/client-updates/:platform/:arch/:format/:currentVersion', async (req, reply) => {
    if (requestAccess(req) === null) fail('UNAUTHENTICATED', 'Authentication required');
    const { platform, arch, format, currentVersion } = req.params;
    // The target must be one approved platform/arch/format combination, not just
    // three independently valid enum values.
    const archs = typeof format === 'string' && FORMATS.has(format) && typeof platform === 'string' && Object.hasOwn(ALLOWED_COMBINATIONS[format], platform)
      ? ALLOWED_COMBINATIONS[format][platform]
      : undefined;
    if (!Array.isArray(archs) || !archs.includes(arch)) fail('INVALID_ARGUMENT', 'Unsupported update target');
    // Installed apps may report a legacy two-part versionName like '1.0'; only
    // that exact shape is normalized — anything else must be real semver.
    let current = typeof currentVersion === 'string' ? semver.valid(currentVersion) : null;
    if (!current && currentVersion === '1.0') current = '1.0.0';
    if (!current) fail('INVALID_ARGUMENT', 'Invalid currentVersion');
    const isApk = format === 'apk';
    let versionCode = null;
    const rawVersionCode = req.query?.versionCode;
    if (isApk) {
      // APK updates must prove a strictly greater versionCode; a missing or
      // malformed value must not silently match against 0.
      if (typeof rawVersionCode !== 'string' || !/^\d+$/.test(rawVersionCode)) fail('INVALID_ARGUMENT', 'versionCode is required');
      versionCode = Number(rawVersionCode);
      if (!Number.isSafeInteger(versionCode) || versionCode < 1) fail('INVALID_ARGUMENT', 'Invalid versionCode');
    }
    // versionCode is only meaningful for apk; ignored for desktop formats.
    const candidates = store.listPublishedClientReleases({ platform, arch, format })
      .filter((record) => semver.gt(record.version, current) && (!isApk || (record.versionCode ?? 0) > versionCode));
    candidates.sort((a, b) => semver.rcompare(a.version, b.version));
    const best = candidates[0];
    if (!best) return reply.code(204).send();
    return {
      version: best.version,
      notes: best.notes ?? '',
      pub_date: best.publishedAt,
      url: new URL('/api/client-releases/' + best.id + '/download', base).toString(),
      ...(best.signature != null ? { signature: best.signature } : {}),
      id: best.id,
      platform: best.platform,
      arch: best.arch,
      format: best.format,
      size: best.size,
      sha256: best.sha256,
      ...(best.versionCode != null ? { versionCode: best.versionCode } : {}),
      sourceCommit: best.sourceCommit,
    };
  });
}
