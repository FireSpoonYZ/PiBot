#!/usr/bin/env node
// scripts/release-artifact.mjs — emit ONE center-import metadata JSON per
// release artifact. Output shape (single object, not an array):
//
//   { "version": "1.1.0",
//     "platform": "windows" | "linux" | "android",
//     "arch": "x86_64" | "aarch64",
//     "format": "nsis" | "deb" | "apk",
//     "size": <bytes>,
//     "sha256": "<hex>",
//     "signature": "<contents of sibling .sig>",   // only when present
//     "notes": "<string>",
//     "sourceCommit": "<sha>",
//     "versionCode": <int> }                        // android only
//
// sha256 is always computed by streaming the real artifact — sidecar .sha256
// files are never trusted. signature is the literal text of the sibling
// <file>.sig produced by tauri signer; absent for unsigned artifacts (debug,
// center image).
//
//   node scripts/release-artifact.mjs \
//     --version 1.1.0 --commit <sha> --notes "release notes" \
//     --platform windows --arch x86_64 --format nsis \
//     --file path/to/installer.exe [--version-code 2] [--out metadata.json]
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i === -1 ? undefined : process.argv[i + 1]; };

const version = arg('version');
const commit = arg('commit');
const notes = arg('notes');
const platform = arg('platform');
const arch = arg('arch');
const format = arg('format');
const file = arg('file');
const versionCode = arg('version-code') ?? arg('versionCode');
const out = arg('out');

const PLATFORMS = new Set(['windows', 'linux', 'android']);
const ARCHES = new Set(['x86_64', 'aarch64']);
const FORMATS = new Set(['nsis', 'deb', 'apk']);

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: release-artifact.mjs --version <v> --commit <sha> --notes <s> --platform <p> --arch <a> --format <f> --file <path> [--version-code <n>] [--out <file>]');
  process.exit(2);
}
if (!version || !commit || notes === undefined || !platform || !arch || !format || !file) {
  usage('missing required argument(s)');
}
if (!PLATFORMS.has(platform)) usage('platform must be windows|linux|android');
if (!ARCHES.has(arch)) usage('arch must be x86_64|aarch64');
if (!FORMATS.has(format)) usage('format must be nsis|deb|apk');
if (typeof notes !== 'string' || notes.trim() === '') usage('notes must be a non-empty string');

const abs = path.resolve(ROOT, file);
if (!existsSync(abs) || !statSync(abs).isFile()) usage('artifact file not found: ' + file);

const sha256 = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(abs).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

const entry = {
  version,
  platform,
  arch,
  format,
  size: statSync(abs).size,
  sha256,
  notes,
  sourceCommit: commit,
};

// Signature: literal text of the sibling <file>.sig (tauri updater signature).
const sigPath = abs + '.sig';
if (existsSync(sigPath)) {
  const sigText = readFileSync(sigPath, 'utf8').trim();
  if (sigText !== '') entry.signature = sigText;
}

if (versionCode !== undefined) {
  const n = Number(versionCode);
  if (!Number.isInteger(n) || n <= 0) usage('version-code must be a positive integer');
  entry.versionCode = n;
}

const json = JSON.stringify(entry, null, 2) + '\n';
if (out) {
  const outAbs = path.resolve(ROOT, out);
  writeFileSync(outAbs, json);
  console.log('wrote ' + outAbs);
} else {
  process.stdout.write(json);
}
