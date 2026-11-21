// From stablyai/orca v1.4.267. Copyright (c) 2026 Lovecast Inc. See ./LICENSE.
import { assertJsonTextStructureWithinLimits } from "./json-text-structure-limit.js";
const BROWSER_SCREENCAST_KIND = 98;
const BROWSER_SCREENCAST_VERSION = 1;
const HEADER_BYTES = 16;
const BROWSER_SCREENCAST_MAX_METADATA_BYTES = 64 * 1024;
const BROWSER_SCREENCAST_METADATA_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 512,
  nestingDepth: 8
};
const METADATA_KEYS = [
  "offsetTop",
  "pageScaleFactor",
  "deviceWidth",
  "deviceHeight",
  "imageWidth",
  "imageHeight",
  "scrollOffsetX",
  "scrollOffsetY",
  "timestamp",
  "zoomFactor"
];
var BrowserScreencastOpcode = /* @__PURE__ */ ((BrowserScreencastOpcode2) => {
  BrowserScreencastOpcode2[BrowserScreencastOpcode2["Frame"] = 1] = "Frame";
  return BrowserScreencastOpcode2;
})(BrowserScreencastOpcode || {});
function formatToByte(format) {
  return format === "png" ? 2 : 1;
}
function byteToFormat(value) {
  if (value === 1) {
    return "jpeg";
  }
  if (value === 2) {
    return "png";
  }
  return null;
}
function encodeJson(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}
function decodeJson(bytes) {
  if (bytes.byteLength > BROWSER_SCREENCAST_MAX_METADATA_BYTES) {
    return null;
  }
  try {
    const content = new TextDecoder().decode(bytes);
    assertJsonTextStructureWithinLimits(content, BROWSER_SCREENCAST_METADATA_JSON_STRUCTURE_LIMITS);
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function decodeFrameMetadata(bytes) {
  const raw = decodeJson(bytes);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const input = raw;
  const metadata = {};
  for (const key of METADATA_KEYS) {
    const value = input[key];
    if (isFiniteNumber(value)) {
      metadata[key] = value;
    }
  }
  return metadata;
}
function encodeBrowserScreencastFrame(frame) {
  const metadata = encodeJson(frame.metadata);
  const out = new Uint8Array(HEADER_BYTES + metadata.byteLength + frame.image.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, BROWSER_SCREENCAST_KIND);
  view.setUint8(1, BROWSER_SCREENCAST_VERSION);
  view.setUint8(2, frame.opcode);
  view.setUint8(3, formatToByte(frame.format));
  view.setUint32(4, Math.max(0, Math.floor(frame.seq)) >>> 0, true);
  view.setUint32(8, metadata.byteLength, true);
  view.setUint32(12, 0, true);
  out.set(metadata, HEADER_BYTES);
  out.set(frame.image, HEADER_BYTES + metadata.byteLength);
  return out;
}
function readBrowserScreencastFrameSeq(bytes) {
  if (bytes.byteLength < HEADER_BYTES) {
    return null;
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
}
function decodeBrowserScreencastFrame(bytes) {
  if (bytes.byteLength < HEADER_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== BROWSER_SCREENCAST_KIND || view.getUint8(1) !== BROWSER_SCREENCAST_VERSION) {
    return null;
  }
  if (view.getUint8(2) !== 1 /* Frame */) {
    return null;
  }
  const format = byteToFormat(view.getUint8(3));
  if (!format) {
    return null;
  }
  const seq = view.getUint32(4, true);
  const metadataLength = view.getUint32(8, true);
  if (metadataLength > BROWSER_SCREENCAST_MAX_METADATA_BYTES) {
    return null;
  }
  if (view.getUint32(12, true) !== 0) {
    return null;
  }
  const payloadStart = HEADER_BYTES;
  const imageStart = payloadStart + metadataLength;
  if (imageStart > bytes.byteLength) {
    return null;
  }
  const metadata = decodeFrameMetadata(bytes.subarray(payloadStart, imageStart));
  if (!metadata) {
    return null;
  }
  return {
    opcode: 1 /* Frame */,
    seq,
    format,
    metadata,
    image: bytes.subarray(imageStart)
  };
}
export {
  BROWSER_SCREENCAST_MAX_METADATA_BYTES,
  BROWSER_SCREENCAST_METADATA_JSON_STRUCTURE_LIMITS,
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame,
  readBrowserScreencastFrameSeq
};
