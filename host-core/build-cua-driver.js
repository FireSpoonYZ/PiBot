#!/usr/bin/env node
// host-core/build-cua-driver.js: prepares the built-in Cua driver
// (cua-driver-rs) binaries for the current Windows/Linux x64 host.
//
// It downloads the pinned upstream release archive (hash-verified, cached),
// extracts it, checks the required file set and binary header, and atomically
// installs the result into the Host resource directory
// host-core/cua-driver/<platform-arch>/ that resolveCuaDriverPath() reads.
// .tar.gz archives are unpacked with the in-repo node-tar dependency; .zip
// archives go through Windows System32 tar.exe (Git Bash /usr/bin/tar cannot
// read .zip). No upstream installer, autostart, PATH lookup or use-time
// download: this script is the only prepare path.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { x as tarExtract } from 'tar';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(ROOT, 'desktop', 'build', 'cache');
const DOWNLOADS_DIR = path.join(CACHE_DIR, 'downloads');
const TMP_DIR = path.join(CACHE_DIR, 'tmp');
const CUA_ROOT = path.join(HERE, 'cua-driver');
const RELEASE_FILE = path.join(HERE, 'cua-driver-release.json');
const MANIFEST_FILE = path.join(CACHE_DIR, 'cua-driver-manifest.json');
const LICENSE_SOURCE = path.join(ROOT, 'licenses', 'cua', 'LICENSE-MIT.txt');

const CURL_FLAGS = [
  '--silent',
  '--show-error',
  '--fail',
  '--location',
  '--connect-timeout',
  '20',
  '--max-time',
  '300',
  '--max-filesize',
  '134217728',
];
const MAX_EXEC_OUTPUT_BYTES = 64 * 1024 * 1024;

const execFileAsync = promisify(execFile);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function fail(message) {
  return Object.assign(new Error(message), { code: 'CUA_DRIVER_BUILD_FAILED' });
}

function isRegularFile(filePath) {
  const stats = lstatSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile() && !stats.isSymbolicLink();
}

function assertStrictlyRegularFile(filePath, label) {
  const stats = lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) throw fail(label + ' is missing');
  if (stats.isSymbolicLink()) throw fail(label + ' must not be a symbolic link');
  if (!stats.isFile()) throw fail(label + ' must be a regular file');
  return stats;
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256OfFile(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function tempSibling(dir, base) {
  return path.join(dir, '.' + base + '.' + process.pid + '.' + Date.now() + '.tmp');
}

function curlCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const candidate = systemRoot ? path.join(systemRoot, 'System32', 'curl.exe') : null;
    if (candidate && isRegularFile(candidate)) return candidate;
  }
  return 'curl';
}

// Git Bash /usr/bin/tar cannot unpack .zip archives; the in-box System32
// tar.exe (bsdtar) is the only supported .zip extractor on Windows. .tar.gz
// is handled by node-tar instead.
function zipTarCommand() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw fail('SystemRoot is not set; cannot locate System32/tar.exe');
  const candidate = path.join(systemRoot, 'System32', 'tar.exe');
  if (!isRegularFile(candidate)) {
    throw fail('System32/tar.exe not found; PowerShell/WSL fallback is not supported');
  }
  return candidate;
}

async function runExec(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: MAX_EXEC_OUTPUT_BYTES,
      windowsHide: true,
      ...options,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw fail(command + ' output exceeded max buffer');
    }
    if (typeof err.code === 'number') {
      throw fail(command + ' exited with code ' + err.code + ': ' + String(err.stderr ?? '').trim());
    }
    throw fail(command + ' failed to start: ' + err.message);
  }
}

function assertBinaryHeader(buffer, platform, label) {
  if (platform === 'win32') {
    if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      throw fail(label + ' is not a Windows PE executable (MZ header missing)');
    }
    return;
  }
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x4c ||
    buffer[3] !== 0x46
  ) {
    throw fail(label + ' is not an ELF executable');
  }
  if (buffer.length < 20 || buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== 62) {
    throw fail(label + ' is not a 64-bit little-endian x86_64 ELF executable');
  }
}

function loadReleaseSpec() {
  try {
    return JSON.parse(readFileSync(RELEASE_FILE, 'utf8'));
  } catch (err) {
    throw fail('cannot read ' + RELEASE_FILE + ': ' + err.message);
  }
}

function currentSpec(spec) {
  const key = process.platform + '-' + process.arch;
  const target = spec.targets?.[key];
  if (!target) {
    throw fail('unsupported cua-driver platform/arch: ' + key + ' (expected win32-x64 or linux-x64)');
  }
  return { key, target };
}

async function downloadVerified(url, expectedSha256, fileName) {
  const target = path.join(DOWNLOADS_DIR, fileName);
  if (isRegularFile(target) && sha256OfFile(target) === expectedSha256) {
    return target;
  }
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const partial = tempSibling(DOWNLOADS_DIR, fileName);
  try {
    await runExec(curlCommand(), [...CURL_FLAGS, '--output', partial, url]);
    assertStrictlyRegularFile(partial, 'downloaded archive ' + fileName);
    const actual = sha256OfFile(partial);
    if (actual !== expectedSha256) {
      throw fail('SHA-256 mismatch for ' + url + ': expected ' + expectedSha256 + ', got ' + actual);
    }
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
  return target;
}

// Reject archive members that escape the destination or are unsafe: absolute
// paths, drive letters, '..'. Anything else is allowed to extract.
function isSafeMember(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split('/').some((p) => p === '..');
}

async function extractArchive(archivePath, format, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  if (format === 'zip') {
    // System32 tar.exe (bsdtar) lists and extracts .zip on Windows.
    const { stdout } = await runExec(zipTarCommand(), ['-tf', archivePath]);
    for (const member of stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (!isSafeMember(member)) {
        throw fail('archive contains an unsafe member path: ' + member);
      }
    }
    await runExec(zipTarCommand(), ['-xf', archivePath, '-C', extractDir]);
    return;
  }
  // .tar.gz via node-tar. filter() blocks path-escaping members and any
  // non-file/non-directory type (links, devices) before it is written.
  await tarExtract({
    file: archivePath,
    cwd: extractDir,
    filter: (entryPath, entry) => {
      if (!isSafeMember(entryPath)) {
        throw fail('archive contains an unsafe member path: ' + entryPath);
      }
      const type = entry && entry.type;
      if (type && !/^(File|OldFile|ContiguousFile|Directory)$/.test(String(type))) {
        throw fail('archive contains a non-regular member (' + type + '): ' + entryPath);
      }
      return true;
    },
  });
}

function topLevelFiles(extractDir) {
  const out = new Set();
  for (const entry of readdirSync(extractDir)) {
    const st = lstatSync(path.join(extractDir, entry));
    if (st.isSymbolicLink()) {
      throw fail('extracted cua-driver archive contains a symbolic link: ' + entry);
    }
    if (st.isFile()) out.add(entry);
  }
  return out;
}

function atomicReplaceDir(stageDir, finalDir) {
  mkdirSync(path.dirname(finalDir), { recursive: true });
  const backup = finalDir + '.old-' + process.pid + '-' + Date.now();
  rmSync(backup, { recursive: true, force: true });
  let moved = false;
  if (lstatSync(finalDir, { throwIfNoEntry: false }) !== undefined) {
    renameSync(finalDir, backup);
    moved = true;
  }
  try {
    renameSync(stageDir, finalDir);
  } catch (err) {
    if (moved) {
      try { renameSync(backup, finalDir); } catch {}
    }
    throw fail('failed to install ' + finalDir + ': ' + err.message);
  }
  rmSync(backup, { recursive: true, force: true });
}

function readManifest() {
  try {
    if (!isRegularFile(MANIFEST_FILE)) return null;
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const partial = tempSibling(CACHE_DIR, 'cua-driver-manifest.json');
  writeFileSync(partial, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(partial, MANIFEST_FILE);
}

function licenseText() {
  const buf = readFileSync(LICENSE_SOURCE);
  if (buf.toString('utf8').trim() === '') {
    throw fail('vendored Cua license is empty: ' + LICENSE_SOURCE);
  }
  return buf;
}

// Extract, verify and stage the driver tree into stageDir. The released
// archives are flat at the root (plus the Linux wayland-helper/ directory,
// which is not a runtime dependency and is not staged). Every required member
// must be present and a regular file; a partial or renamed archive fails here
// instead of producing a broken driver directory.
async function stageDriverTree(target, archivePath, stageDir) {
  const extractDir = path.join(TMP_DIR, 'cua-extract-' + process.pid + '-' + Date.now());
  try {
    await extractArchive(archivePath, target.archiveFormat, extractDir);
    const top = topLevelFiles(extractDir);
    for (const entry of target.entries) {
      if (!top.has(entry)) {
        throw fail('archive is missing required top-level member: ' + entry);
      }
    }
    mkdirSync(stageDir, { recursive: true });
    for (const entry of target.entries) {
      const src = path.join(extractDir, entry);
      assertStrictlyRegularFile(src, 'extracted ' + entry);
      writeFileSync(path.join(stageDir, entry), readFileSync(src));
    }
    const driverPath = path.join(stageDir, target.driverName);
    assertBinaryHeader(
      readFileSync(driverPath),
      target.archiveFormat === 'zip' ? 'win32' : 'linux',
      'cua-driver binary',
    );
    if (target.archiveFormat !== 'zip') {
      for (const entry of target.entries) {
        if (entry === 'cua_driver_abi.h') continue;
        chmodSync(path.join(stageDir, entry), 0o755);
      }
    }
    writeFileSync(path.join(stageDir, 'LICENSE'), licenseText());
    return { driverSha256: sha256OfFile(driverPath) };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

// The prepared tree is current only when every required file is present and
// the driver hash matches the recorded release+sha. This guards against a
// partial install that has the exe but is missing a required dll/helper.
function preparedTreeIsCurrent(destDir, target, manifestRec, release) {
  if (!manifestRec || manifestRec.release !== release || !manifestRec.driverSha256) {
    return false;
  }
  for (const entry of target.entries) {
    if (!isRegularFile(path.join(destDir, entry))) return false;
  }
  if (!isRegularFile(path.join(destDir, 'LICENSE'))) return false;
  return sha256OfFile(path.join(destDir, target.driverName)) === manifestRec.driverSha256;
}

/**
 * Prepare the Host cua-driver resource directory for the current platform
 * into host-core/cua-driver/<platform-arch>/. Downloads + verifies the pinned
 * archive on a cache miss; skips the download when the installed tree already
 * contains the full required file set at the recorded hash.
 * Returns { release, dir, status, sha256 }.
 */
export async function prepareCuaDriver() {
  const spec = loadReleaseSpec();
  const { key, target } = currentSpec(spec);
  const destDir = path.join(CUA_ROOT, key);
  const manifest = readManifest() ?? { version: 1 };
  if (preparedTreeIsCurrent(destDir, target, manifest[key], spec.release)) {
    return {
      release: spec.release,
      dir: destDir,
      status: 'cached',
      sha256: manifest[key].driverSha256,
    };
  }

  const archivePath = await downloadVerified(target.url, target.sha256, target.archiveName);
  mkdirSync(TMP_DIR, { recursive: true });
  const stageDir = tempSibling(path.dirname(destDir), path.basename(destDir));
  rmSync(stageDir, { recursive: true, force: true });
  let driverSha256;
  try {
    ({ driverSha256 } = await stageDriverTree(target, archivePath, stageDir));
    atomicReplaceDir(stageDir, destDir);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  manifest[key] = { release: spec.release, driverSha256 };
  writeManifest(manifest);
  return { release: spec.release, dir: destDir, status: 'installed', sha256: driverSha256 };
}

const USAGE =
  'usage: node host-core/build-cua-driver.js\n' +
  '\n' +
  'Prepares the pinned cua-driver-rs binaries for the current Windows/Linux x64\n' +
  'host into host-core/cua-driver/<platform-arch>/. Downloads and hash-verifies\n' +
  'the release archive on a cache miss, extracts it, validates the required\n' +
  'file set and binary header, then atomically installs the directory.\n';

async function main() {
  const arg = process.argv[2];
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (arg !== undefined) {
    throw invalid('unsupported argument: ' + arg);
  }
  const summary = await prepareCuaDriver();
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
