import { BROWSER_MAX_FRAME_BASE64_BYTES } from './protocol.js';
import {
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame,
} from './vendor/orca/browser-screencast-protocol.js';

const MAGIC = 'PBS1';
const ID_OFFSET = MAGIC.length;
const ID_LENGTH = 36;
const REVISION_OFFSET = ID_OFFSET + ID_LENGTH;
const HEADER_LENGTH = REVISION_OFFSET + 8;
const MAX_IMAGE_BYTES = BROWSER_MAX_FRAME_BASE64_BYTES * 3 / 4;
const MAX_PACKET_BYTES = HEADER_LENGTH + 1024 + MAX_IMAGE_BYTES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BROWSER_STREAM_HIGH_WATER_BYTES = MAX_PACKET_BYTES * 3;

export function isBrowserStreamId(id) {
  return typeof id === 'string' && UUID.test(id);
}

export function isBrowserStreamSeq(seq) {
  return Number.isInteger(seq) && seq > 0 && seq <= 0xffffffff;
}

function validDimensions(width, height) {
  return [width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 16384);
}

// A Pi Bot envelope scopes the upstream Orca frame to a single Center route.
// Center replaces the Host route ID with the viewer's watch ID when forwarding.
export function encodeBrowserStreamPacket(streamId, frame) {
  if (!isBrowserStreamId(streamId) || !isBrowserStreamSeq(frame.seq) ||
      !Number.isSafeInteger(frame.revision) || frame.revision < 0 ||
      !validDimensions(frame.width, frame.height) ||
      (frame.mimeType !== 'image/jpeg' && frame.mimeType !== 'image/png')) return null;
  const image = Buffer.from(frame.data, 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) return null;
  const payload = encodeBrowserScreencastFrame({
    opcode: BrowserScreencastOpcode.Frame,
    seq: frame.seq,
    format: frame.mimeType === 'image/jpeg' ? 'jpeg' : 'png',
    metadata: { imageWidth: frame.width, imageHeight: frame.height },
    image,
  });
  const bytes = Buffer.allocUnsafe(HEADER_LENGTH + payload.length);
  bytes.write(MAGIC);
  bytes.write(streamId, ID_OFFSET, ID_LENGTH, 'ascii');
  bytes.writeBigUInt64LE(BigInt(frame.revision), REVISION_OFFSET);
  bytes.set(payload, HEADER_LENGTH);
  return bytes;
}

export function readBrowserStreamPacket(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PACKET_BYTES || bytes.length <= HEADER_LENGTH ||
      bytes.toString('latin1', 0, ID_OFFSET) !== MAGIC) return null;
  const streamId = bytes.toString('latin1', ID_OFFSET, REVISION_OFFSET);
  const revision = Number(bytes.readBigUInt64LE(REVISION_OFFSET));
  if (!isBrowserStreamId(streamId) || !Number.isSafeInteger(revision)) return null;
  const frame = decodeBrowserScreencastFrame(bytes.subarray(HEADER_LENGTH));
  if (!frame || !isBrowserStreamSeq(frame.seq) || !frame.image.length ||
      frame.image.length > MAX_IMAGE_BYTES ||
      !validDimensions(frame.metadata.imageWidth, frame.metadata.imageHeight)) return null;
  return {
    type: 'browser-frame',
    streamId,
    seq: frame.seq,
    revision,
    width: frame.metadata.imageWidth,
    height: frame.metadata.imageHeight,
    mimeType: frame.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    image: frame.image,
    bytes,
  };
}

export function addressBrowserStreamPacket(packet, watchId) {
  const bytes = Buffer.from(packet.bytes);
  bytes.write(watchId, ID_OFFSET, ID_LENGTH, 'ascii');
  return bytes;
}
