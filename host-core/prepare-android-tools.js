#!/usr/bin/env node
// host-core/prepare-android-tools.js: prepares the packaged rg/fd native tools
// for the APK. All four artifacts (rg/fd x arm64/x86_64) are built from pinned
// Cargo source crates for the Android NDK targets (Linux-musl release binaries
// fail under the real app UID with exit 159). Outputs ELF executables under
// app/build/generated/jniLibs/hostTools/<abi>/libhost_rg.so|libhost_fd.so.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_ROOT = path.join(ROOT, 'app', 'build', 'generated', 'jniLibs', 'hostTools');
const CACHE = path.join(ROOT, 'app', 'build', 'host-native-tools');
const DOWNLOADS = path.join(CACHE, 'downloads');
const LICENSES = path.join(CACHE, 'licenses');
const SRC = path.join(CACHE, 'src');
const MANIFEST_FILE = path.join(CACHE, 'native-tools-manifest.json');
const CURL_FLAGS = ['--silent', '--show-error', '--fail', '--location', '--connect-timeout', '20', '--max-time', '300', '--max-filesize', '67108864'];
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_CARGO_OUTPUT_BYTES = 256 * 1024 * 1024;
const ABI_TRIPLES = { 'arm64-v8a': 'aarch64', 'x86_64': 'x86_64' };
const ELF_MACHINES = { 'arm64-v8a': 183, 'x86_64': 62 };
const NDK_HOST_DIRS = ['windows-x86_64', 'linux-x86_64', 'darwin-x86_64', 'darwin-arm64'];
const PAGE_SIZE_FLAG = '16384';

// Pinned Cargo source crates (crates.io), sha256 verified before any build.
const CRATES = {
  rg: {
    name: 'ripgrep',
    version: '15.1.0',
    url: 'https://static.crates.io/crates/ripgrep/ripgrep-15.1.0.crate',
    sha256: 'f388c4955f85477c28a8667355819844a06614b083c23517f0e86bd1d6d82b73',
    cargoFeatures: [],
    binary: 'rg',
    licenseFile: 'LICENSE-MIT',
  },
  fd: {
    name: 'fd-find',
    version: '10.3.0',
    url: 'https://static.crates.io/crates/fd-find/fd-find-10.3.0.crate',
    sha256: '2fbf004b5bbdefab92e76237e2022c77842cdef5d3213fe09fd804e0474785db',
    // Avoid jemalloc / shell completions extras.
    cargoFeatures: ['--no-default-features'],
    binary: 'fd',
    licenseFile: 'LICENSE-MIT',
  },
};

const execFileAsync = promisify(execFile);

function fail(message) {
  return Object.assign(new Error(message), { code: 'TOOL_PREPARE_FAILED' });
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

async function runExec(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, options);
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

function curlCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const candidate = systemRoot ? path.join(systemRoot, 'System32', 'curl.exe') : null;
    if (candidate && isRegularFile(candidate)) return candidate;
  }
  return 'curl';
}

function tarCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw fail('SystemRoot is not set; cannot locate System32/tar.exe');
    const candidate = path.join(systemRoot, 'System32', 'tar.exe');
    if (!isRegularFile(candidate)) throw fail('System32/tar.exe not found; PowerShell fallback is not supported');
    return candidate;
  }
  return 'tar';
}

function isRegularFile(filePath) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile();
}

function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha256OfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function tempSibling(dir, base) {
  return path.join(dir, '.' + base + '.' + process.pid + '.' + Date.now() + '.tmp');
}

function chmodExecutable(filePath) {
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

async function downloadVerified(url, sha256, fileName) {
  const target = path.join(DOWNLOADS, fileName);
  if (isRegularFile(target) && sha256OfFile(target) === sha256) return target;
  mkdirSync(DOWNLOADS, { recursive: true });
  const partial = target + '.part';
  await runExec(curlCommand(), [...CURL_FLAGS, '--output', partial, url], {
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const actual = sha256OfFile(partial);
  if (actual !== sha256) {
    rmSync(partial, { force: true });
    throw fail(`Checksum mismatch for ${url}: ${actual}`);
  }
  renameSync(partial, target);
  return target;
}

function assertElf(buffer, abi, name) {
  if (buffer.length < 20 || buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw fail(name + ' binary is not an ELF executable');
  }
  if (buffer[4] !== 2) throw fail(name + ' ELF is not 64-bit (class ' + buffer[4] + ')');
  if (buffer[5] !== 1) throw fail(name + ' ELF is not little-endian (data ' + buffer[5] + ')');
  const machine = buffer.readUInt16LE(18);
  if (machine !== ELF_MACHINES[abi]) {
    throw fail(name + ' ELF machine ' + machine + ' does not match ABI ' + abi);
  }
}

function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')); } catch { return null; }
}

function writeManifest(manifest) {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function licenseCachePresent() {
  return isRegularFile(path.join(LICENSES, 'rg-LICENSE-MIT.txt')) &&
    isRegularFile(path.join(LICENSES, 'fd-LICENSE-MIT.txt'));
}

function manifestMatches(manifest, toolName, abi, fileHash, cacheKey) {
  if (!manifest || manifest.version !== 1) return false;
  const entry = manifest.tools?.[toolName]?.abis?.[abi];
  if (!entry || entry.source !== 'cargo' || entry.version !== CRATES[toolName].version || entry.sha256 !== fileHash) return false;
  if (entry.cacheKey !== cacheKey) return false;
  return manifest.pins?.[toolName] === CRATES[toolName].sha256;
}

function updateManifest(manifest, toolName, abi, fileHash, cacheKey) {
  manifest.tools ??= {};
  manifest.tools[toolName] ??= { version: CRATES[toolName].version, abis: {} };
  manifest.tools[toolName].abis[abi] = { source: 'cargo', version: CRATES[toolName].version, sha256: fileHash, cacheKey };
  // Record the verified crate pin for this tool only after its binary has been
  // rebuilt/validated; legacy pins (rg-x86_64, fd-arm64-v8a, ..., rgCrate)
  // are left untouched as unrelated data.
  manifest.pins ??= {};
  manifest.pins[toolName] = CRATES[toolName].sha256;
  writeManifest(manifest);
}

function saveLicenseCache(toolName, licenseBuffer) {
  mkdirSync(LICENSES, { recursive: true });
  const target = path.join(LICENSES, `${toolName}-LICENSE-MIT.txt`);
  const partial = tempSibling(LICENSES, `${toolName}-LICENSE-MIT.txt`);
  writeFileSync(partial, licenseBuffer);
  renameSync(partial, target);
}

function findNdkClang(ndkDir) {
  for (const hostDir of NDK_HOST_DIRS) {
    const binDir = path.join(ndkDir, 'toolchains', 'llvm', 'prebuilt', hostDir, 'bin');
    const clang = path.join(binDir, process.platform === 'win32' ? 'clang.exe' : 'clang');
    if (isRegularFile(clang)) return { clang, sysroot: path.join(ndkDir, 'toolchains', 'llvm', 'prebuilt', hostDir, 'sysroot') };
  }
  return null;
}

function ndkIdentity(ndkDir) {
  const props = path.join(ndkDir, 'source.properties');
  if (!isRegularFile(props)) throw fail('invalid NDK: ' + ndkDir + ' lacks source.properties');
  return sha256OfFile(props);
}

async function requireRustTarget(target) {
  const rustup = await runExec('rustup', ['target', 'list', '--installed'], { maxBuffer: MAX_OUTPUT_BYTES });
  if (!String(rustup.stdout).split(/\r?\n/).some((line) => line.startsWith(target))) {
    throw fail(`Rust target ${target} is not installed; run: rustup target add ${target}`);
  }
}

function crateSrcDir(toolName) {
  const crate = CRATES[toolName];
  return path.join(SRC, `${crate.name}-${crate.version}`);
}

function crateMarkerFile(toolName) {
  return path.join(crateSrcDir(toolName), '.verified-sha256');
}

async function ensureCrateSourceVerified(toolName) {
  const crate = CRATES[toolName];
  const src = crateSrcDir(toolName);
  if (isRegularFile(path.join(src, 'Cargo.toml')) && isRegularFile(path.join(src, 'Cargo.lock'))) {
    let marker = null;
    try { marker = readFileSync(crateMarkerFile(toolName), 'utf8').trim(); } catch { /* re-extract below */ }
    if (marker === crate.sha256) return src;
  }
  const archivePath = await downloadVerified(crate.url, crate.sha256, path.basename(crate.url));
  const tmpRoot = path.join(SRC, `${crate.name}-${crate.version}.tmp.${process.pid}`);
  mkdirSync(tmpRoot, { recursive: true });
  try {
    await runExec(tarCommand(), ['-xzf', archivePath, '-C', tmpRoot], { maxBuffer: MAX_OUTPUT_BYTES });
    const extracted = path.join(tmpRoot, `${crate.name}-${crate.version}`);
    for (const name of ['Cargo.toml', 'Cargo.lock', crate.licenseFile]) {
      if (!isRegularFile(path.join(extracted, name))) throw fail(`verified ${crate.name} crate missing ${name}`);
    }
    mkdirSync(SRC, { recursive: true });
    rmSync(src, { recursive: true, force: true });
    renameSync(extracted, src);
    writeFileSync(crateMarkerFile(toolName), crate.sha256 + '\n');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  return src;
}

const CARGO_CONFIG_FILES = ['config', 'config.toml'];

// Cargo auto-discovers .cargo/config(.toml) from the invocation cwd up to the
// filesystem root, and reads CARGO_HOME/config(.toml). We must never inherit any
// user/project private Cargo configuration (credentials, registry redirects),
// so reject the build when any such file exists — without reading or recording
// its contents. The verified crate's OWN .cargo config is trusted: it is part
// of the pinned source archive covered by its fixed SHA256 (e.g. ripgrep
// ships .cargo/config.toml inside the crate), so the ancestor walk starts at
// path.dirname(src) and only rejects OUTER configurations.
function assertNoInheritedCargoConfig(src) {
  let dir = path.dirname(path.resolve(src));
  const seen = new Set();
  while (true) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const cargoDir = path.join(dir, '.cargo');
    for (const name of CARGO_CONFIG_FILES) {
      if (isRegularFile(path.join(cargoDir, name))) {
        throw fail(`refusing to inherit Cargo config at ${path.join(cargoDir, name)}`);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = path.join(CACHE, 'cargo-home');
  for (const name of CARGO_CONFIG_FILES) {
    const file = path.join(home, name);
    if (isRegularFile(file)) {
      throw fail(`refusing isolated CARGO_HOME config at ${file}`);
    }
  }
}

async function installCargoTool(manifest, toolName, abi, ndkDir) {
  const crate = CRATES[toolName];
  const rustTarget = ABI_TRIPLES[abi] + '-linux-android';
  const apiTarget = `${rustTarget}29`;
  const outDir = path.join(OUT_ROOT, abi);
  const outBinary = path.join(outDir, `libhost_${toolName}.so`);
  const existing = isRegularFile(outBinary) ? sha256OfFile(outBinary) : null;
  const identity = ndkIdentity(ndkDir);
  const cacheKey = sha256OfBuffer(Buffer.from(
    `${abi}|${crate.sha256}|${rustTarget}|${identity}|${PAGE_SIZE_FLAG}|${crate.cargoFeatures.join(',')}`, 'utf8'));
  if (existing && licenseCachePresent() && manifestMatches(manifest, toolName, abi, existing, cacheKey)) {
    return { name: toolName, abi, source: 'cargo', sha256: existing, status: 'cached' };
  }
  const ndk = findNdkClang(ndkDir);
  if (!ndk) throw fail(`NDK clang not found under ${ndkDir}/toolchains/llvm/prebuilt`);
  await requireRustTarget(rustTarget);
  const src = await ensureCrateSourceVerified(toolName);
  assertNoInheritedCargoConfig(src);
  mkdirSync(outDir, { recursive: true });
  const root = path.join(CACHE, `${toolName}-cargo-root`);
  const finalRustflags = [
    '-C', 'link-arg=--target=' + apiTarget,
    '-C', 'link-arg=--sysroot=' + ndk.sysroot,
    '-C', 'link-arg=-Wl,-z,max-page-size=' + PAGE_SIZE_FLAG,
    '-C', 'link-arg=-Wl,-z,common-page-size=' + PAGE_SIZE_FLAG,
  ];
  // CARGO_ENCODED_RUSTFLAGS: args joined by ASCII UNIT SEPARATOR U+001F, no
  // length prefix and no NUL (NUL would be rejected by Node before spawn).
  const encoded = finalRustflags.join('\u001f');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Drop inherited Cargo/rustc overrides (credentials, registry redirects,
    // wrappers, RUSTFLAGS) so private/personal config never leaks in.
    if (key === 'RUSTFLAGS' || key.startsWith('CARGO_') || key.startsWith('RUSTC_')) continue;
    env[key] = value;
  }
  Object.assign(env, {
    CARGO_HOME: path.join(CACHE, 'cargo-home'),
    CARGO_TARGET_DIR: path.join(CACHE, 'cargo-target'),
    CARGO_INCREMENTAL: '0',
    CARGO_NET_OFFLINE: 'false',
    CARGO_ENCODED_RUSTFLAGS: encoded,
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: ndk.clang,
    CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER: ndk.clang,
  });
  const installArgs = ['install', '--config', 'net.offline=false', '--path', src, '--locked', '--force', '--target', rustTarget, '--root', root, ...crate.cargoFeatures];
  await runExec('cargo', installArgs, {
    cwd: src,
    env,
    maxBuffer: MAX_CARGO_OUTPUT_BYTES,
  });
  const built = path.join(root, 'bin', crate.binary);
  if (!isRegularFile(built)) throw fail('cargo install succeeded but ' + crate.binary + ' binary missing at ' + built);
  const binary = readFileSync(built);
  assertElf(binary, abi, toolName);
  const partial = tempSibling(outDir, `libhost_${toolName}.so`);
  copyFileSync(built, partial); // copy, never move out of the Cargo install tree
  chmodExecutable(partial);
  renameSync(partial, outBinary);
  const license = readFileSync(path.join(src, crate.licenseFile));
  if (license.length === 0) throw fail(crate.name + ' ' + crate.licenseFile + ' is empty');
  saveLicenseCache(toolName, license);
  const hash = sha256OfFile(outBinary);
  updateManifest(manifest, toolName, abi, hash, cacheKey);
  return { name: toolName, abi, source: 'cargo', sha256: hash, status: 'installed' };
}

async function prepareAbi(manifest, abi, ndkDir) {
  const results = [];
  results.push(await installCargoTool(manifest, 'rg', abi, ndkDir));
  results.push(await installCargoTool(manifest, 'fd', abi, ndkDir));
  return results;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        abis: { type: 'string' },
        ndk: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw invalid(err.message);
  }
  if (values.help) {
    process.stdout.write('usage: node host-core/prepare-android-tools.js --abis <comma list> --ndk <ndk dir>\n');
    return;
  }
  const abis = (values.abis ?? 'arm64-v8a').split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const abi of abis) {
    if (!(abi in ABI_TRIPLES)) throw invalid('unsupported ABI: ' + abi);
    if (!seen.has(abi)) { seen.add(abi); unique.push(abi); }
  }
  if (unique.length === 0) return;
  if (typeof values.ndk !== 'string' || values.ndk.trim() === '') {
    throw invalid('--ndk absolute NDK directory is required');
  }
  if (!path.isAbsolute(values.ndk) || !existsSync(values.ndk)) {
    throw invalid('--ndk must be an existing absolute directory: ' + values.ndk);
  }
  let manifest = readManifest();
  if (!manifest) {
    manifest = { version: 1, pins: { rg: CRATES.rg.sha256, fd: CRATES.fd.sha256 } };
    writeManifest(manifest);
  }
  const results = [];
  for (const abi of unique) {
    results.push(...(await prepareAbi(manifest, abi, values.ndk)));
  }
  process.stdout.write(JSON.stringify({ done: true, outRoot: OUT_ROOT, tools: results }) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ error: { code: err?.code ?? 'INTERNAL', message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
