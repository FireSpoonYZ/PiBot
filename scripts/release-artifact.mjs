#!/usr/bin/env node
// scripts/release-artifact.mjs — emit ONE center-import metadata JSON per
// release artifact. Output shape (single object, not an array):
//
//   { "version": "1.1.0",
//     "platform": "windows" | "linux" | "macos" | "android",
//     "arch": "x86_64" | "aarch64",
//     "format": "nsis" | "deb" | "app" | "apk",
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
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppBundleInfo } from '../center-server/app-bundle.js';

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

const PLATFORMS = new Set(['windows', 'linux', 'macos', 'android']);
const ARCHES = new Set(['x86_64', 'aarch64']);
// app = the macOS updater bundle (<Name>.app.tar.gz); the DMG is not imported.
const FORMATS = new Set(['nsis', 'deb', 'app', 'apk']);
const MACOS_BUNDLE = { name: 'PiBot.app', identifier: 'io.github.firespoonyz.pibot' };

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: release-artifact.mjs --version <v> --commit <sha> --notes <s> --platform <p> --arch <a> --format <f> --file <path> [--version-code <n>] [--out <file>]');
  process.exit(2);
}
if (!version || !commit || notes === undefined || !platform || !arch || !format || !file) {
  usage('missing required argument(s)');
}
if (!PLATFORMS.has(platform)) usage('platform must be windows|linux|macos|android');
if (!ARCHES.has(arch)) usage('arch must be x86_64|aarch64');
if (!FORMATS.has(format)) usage('format must be nsis|deb|app|apk');
if (typeof notes !== 'string' || notes.trim() === '') usage('notes must be a non-empty string');
const targets = { nsis: ['windows', 'x86_64'], deb: ['linux', 'x86_64'], app: ['macos', 'aarch64'], apk: ['android', arch] };
if (targets[format][0] !== platform || targets[format][1] !== arch) usage('unsupported platform/arch/format combination');
if (format !== 'apk' && versionCode !== undefined) usage('version-code is only valid for APK');
if (format === 'apk' && !/^[1-9]\d*$/.test(versionCode ?? '')) usage('APK requires version-code');

const abs = path.resolve(ROOT, file);
if (!existsSync(abs) || !statSync(abs).isFile()) usage('artifact file not found: ' + file);

// Read the actual package identity before publishing metadata.
if (format === 'apk') {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) usage('ANDROID_HOME is required to inspect APK metadata');
  const binary = process.platform === 'win32' ? 'aapt.exe' : 'aapt';
  const toolsDir = path.join(sdk, 'build-tools');
  const aapt = readdirSync(toolsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(v => path.join(toolsDir, v, binary)).find(existsSync);
  if (!aapt) usage('aapt is missing from Android SDK build-tools');
  const badging = execFileSync(aapt, ['dump', 'badging', abs], { encoding: 'utf8', windowsHide: true });
  const info = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  const abis = [...(badging.match(/^native-code: (.+)$/m)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (!info || info[1] !== 'com.example.launcherprobe' || info[2] !== String(versionCode) || info[3] !== version) usage('APK package/version does not match metadata');
  if (abis.length !== 1 || abis[0] !== (arch === 'aarch64' ? 'arm64-v8a' : 'x86_64')) usage('APK ABI does not match metadata');
} else if (format === 'deb') {
  const fields = execFileSync('dpkg-deb', ['--field', abs], { encoding: 'utf8' });
  if (!/^Package: e-launcher-desktop$/m.test(fields) || !/^Architecture: amd64$/m.test(fields)
      || fields.match(/^Version: (.+)$/m)?.[1] !== version) usage('DEB identity/version does not match metadata');
} else if (format === 'app') {
  const info = await readAppBundleInfo(abs);
  if (!info || info.bundleName !== MACOS_BUNDLE.name || info.identifier !== MACOS_BUNDLE.identifier
      || info.version !== version) usage('macOS app bundle identity/version does not match metadata');
}

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

if (format !== 'apk') {
  if (!entry.signature) usage('desktop metadata requires the signed updater artifact');
  const signatureText = entry.signature.startsWith('untrusted comment:')
    ? entry.signature : Buffer.from(entry.signature, 'base64').toString('utf8');
  const signedVersion = signatureText.match(/^trusted comment:.*\bversion:([^\s]+)/m)?.[1];
  if (signedVersion !== version) usage('updater signature version does not match metadata');
}
const json = JSON.stringify(entry, null, 2) + '\n';
if (out) {
  const outAbs = path.resolve(ROOT, out);
  writeFileSync(outAbs, json);
  console.log('wrote ' + outAbs);
} else {
  process.stdout.write(json);
}
