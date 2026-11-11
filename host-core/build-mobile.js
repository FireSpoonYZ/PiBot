#!/usr/bin/env node
// host-core/build-mobile.js: product build entry for the Tauri Android UI process
// (:tauri_ui). It never generates a second application project: the existing Gradle
// APK consumes the pinned tauri SDK project, the Rust cdylib and the wry/tauri
// generated Kotlin from app/build/generated.
//
// Modes:
//   (default) : writes mobile/build/tauri-sdk.gradle from cargo metadata, builds
//               mobile/build/web, builds the Rust cdylib per launcher ABI with
//               explicit NDK argv, checks 16 KiB ELF alignment, and writes the
//               Android Rust third-party notices into the APK assets.
//   --web     : builds mobile/build/web only (vite.mobile.config.ts + tsc).
//   --sdk-path: metadata only. Resolves the tauri SDK project from the mobile Cargo
//               graph, writes mobile/build/tauri-sdk.gradle (applied by
//               settings.gradle) and prints the path. No web/Rust build.
//
//   node host-core/build-mobile.js [--sdk-path | --web | [--abis arm64-v8a,x86_64] [--ndk <dir>]]
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectCargoLicenseSections } from './build-desktop.js';
import { spawnNodeScript } from './desktop-tauri.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MOBILE_DIR = path.join(ROOT, 'mobile');
const MOBILE_SRC_TAURI = path.join(MOBILE_DIR, 'src-tauri');
const CARGO_TOML = path.join(MOBILE_SRC_TAURI, 'Cargo.toml');
const CARGO_TARGET_DIR = path.join(MOBILE_SRC_TAURI, 'target');
const MOBILE_BUILD = path.join(MOBILE_DIR, 'build');
const WEB_OUT = path.join(MOBILE_BUILD, 'web');
const GRADLE_INCLUDE = path.join(MOBILE_BUILD, 'tauri-sdk.gradle');
const VITE_CONFIG = path.join(ROOT, 'vite.mobile.config.ts');
const TS_CONFIG = path.join(MOBILE_DIR, 'web', 'tsconfig.json');
const KOTLIN_OUT = path.join(ROOT, 'app', 'build', 'generated', 'source', 'tauri');
const JNI_OUT = path.join(ROOT, 'app', 'build', 'generated', 'jniLibs', 'tauri');
const NOTICES_DIR = path.join(ROOT, 'app', 'build', 'generated', 'assets', 'tauri');
const NOTICES_OUT = path.join(NOTICES_DIR, 'THIRD_PARTY_NOTICES.txt');

const TAURI_VERSION = '2.12.5';
// Must match app/build.gradle namespace: wry/tauri codegen writes TauriActivity here.
const ANDROID_PACKAGE = 'com.example.launcherprobe';
const RUST_LIBRARY = 'e_launcher_mobile';
const NDK_VERSION = '28.2.13676358';
const MIN_SDK_API = 33;
const ELF_PAGE = 0x4000;
const MAX_EXEC_OUTPUT_BYTES = 64 * 1024 * 1024;
const HOST_TAG =
  process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const CLANG_BINARY = process.platform === 'win32' ? 'clang.exe' : 'clang';
const AR_BINARY = process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar';

const ABI_TARGETS = {
  'arm64-v8a': { triple: 'aarch64-linux-android', eMachine: 183 },
  x86_64: { triple: 'x86_64-linux-android', eMachine: 62 },
};

const execFileAsync = promisify(execFile);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function fail(message) {
  return Object.assign(new Error(message), { code: 'MOBILE_BUILD_FAILED' });
}

function isRegularFile(filePath) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile();
}

function toForward(filePath) {
  return filePath.replace(/\\/g, '/');
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
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
      throw fail(`${command} output exceeded max buffer`);
    }
    if (typeof err.code === 'number') {
      throw fail(`${command} exited with code ${err.code}: ${String(err.stderr ?? '').trim()}`);
    }
    throw fail(`${command} failed to start: ${err.message}`);
  }
}

function resolveAbis(raw) {
  const abis = (raw ?? 'arm64-v8a').split(',').map((abi) => abi.trim()).filter((abi) => abi !== '');
  if (abis.length === 0) throw invalid('--abis must list at least one ABI');
  for (const abi of abis) {
    if (!ABI_TARGETS[abi]) throw invalid(`unsupported ABI ${abi} (expected arm64-v8a or x86_64)`);
  }
  return abis;
}

function resolveNdk(explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null);
  if (sdk) candidates.push(path.join(sdk, 'ndk', NDK_VERSION));
  for (const candidate of candidates) {
    if (isRegularFile(path.join(candidate, 'toolchains', 'llvm', 'prebuilt', HOST_TAG, 'bin', CLANG_BINARY))) {
      return candidate;
    }
  }
  throw fail(
    `Android NDK ${NDK_VERSION} not found (looked at ${candidates.join(', ') || 'no path'}); ` +
      'set ANDROID_HOME or pass --ndk <dir>'
  );
}

function resolveBinScript(pkgName, relBin) {
  const candidate = path.join(ROOT, 'node_modules', ...pkgName.split('/'), ...relBin.split('/'));
  if (!isRegularFile(candidate)) {
    throw fail(`required tool ${pkgName} is missing at ${candidate}; run npm ci in the repository root first`);
  }
  return candidate;
}

// clang.exe in the NDK has no per-target driver on Windows, so the target API and
// sysroot are passed as explicit linker argv. Cargo can only carry flags without
// shell-style quoting through the encoded (U+001F separated) variable.
const CARGO_FLAG_SEPARATOR = '\u001f';

function quoteForCc(value) {
  return value.includes(' ') ? `"${value}"` : value;
}

function androidBuildEnv(abi, ndk) {
  const spec = ABI_TARGETS[abi];
  const prebuilt = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', HOST_TAG);
  const clang = path.join(prebuilt, 'bin', CLANG_BINARY);
  const sysroot = toForward(path.join(prebuilt, 'sysroot'));
  const ccTarget = `${spec.triple}${MIN_SDK_API}`;
  const envTriple = spec.triple.toUpperCase().replace(/-/g, '_');
  const ccTriple = spec.triple.replace(/-/g, '_');
  const env = {
    ...process.env,
    WRY_ANDROID_PACKAGE: ANDROID_PACKAGE,
    WRY_ANDROID_LIBRARY: RUST_LIBRARY,
    WRY_ANDROID_KOTLIN_FILES_OUT_DIR: KOTLIN_OUT,
    [`CARGO_TARGET_${envTriple}_LINKER`]: clang,
    CARGO_ENCODED_RUSTFLAGS: [
      `-Clink-arg=--target=${ccTarget}`,
      `-Clink-arg=--sysroot=${sysroot}`,
      '-Clink-arg=-Wl,-z,max-page-size=0x4000',
    ].join(CARGO_FLAG_SEPARATOR),
    [`CC_${ccTriple}`]: clang,
    // CFLAGS are parsed like shell words by cc, so only quote when a space exists.
    [`CFLAGS_${ccTriple}`]: `--target=${ccTarget} --sysroot=${quoteForCc(sysroot)}`,
    [`AR_${ccTriple}`]: path.join(prebuilt, 'bin', AR_BINARY),
  };
  // Packaging owns the SDK project path and the NDK target flags: a stale inherited
  // value would rewrite the repo Gradle files or re-add whitespace-split flags.
  delete env.TAURI_ANDROID_PROJECT_PATH;
  delete env.RUSTFLAGS;
  delete env[`CARGO_TARGET_${envTriple}_RUSTFLAGS`];
  return env;
}

function assertElfSharedLibrary(buffer, eMachine, label) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46 || buffer[4] !== 2 || buffer[5] !== 1) {
    throw fail(`${label} is not a 64-bit little-endian ELF file`);
  }
  if (buffer.readUInt16LE(16) !== 3) {
    throw fail(`${label} is not an ELF shared object (e_type ${buffer.readUInt16LE(16)})`);
  }
  if (buffer.readUInt16LE(18) !== eMachine) {
    throw fail(`${label} ELF machine ${buffer.readUInt16LE(18)} does not match ABI (expected ${eMachine})`);
  }
  const phoff = Number(buffer.readBigUInt64LE(32));
  const phentsize = buffer.readUInt16LE(54);
  const phnum = buffer.readUInt16LE(56);
  if (phnum === 0 || phentsize === 0) throw fail(`${label} has no ELF program headers`);
  // A truncated table must fail, never silently skip the remaining segments.
  if (phoff === 0 || phentsize < 56 || phoff + phnum * phentsize > buffer.length) {
    throw fail(
      `${label} has a truncated ELF program-header table (phoff ${phoff}, entsize ${phentsize}, count ${phnum})`
    );
  }
  let loadSegments = 0;
  for (let index = 0; index < phnum; index += 1) {
    const header = phoff + index * phentsize;
    if (buffer.readUInt32LE(header) !== 1) continue; // PT_LOAD
    loadSegments += 1;
    const align = Number(buffer.readBigUInt64LE(header + 48));
    if (align < ELF_PAGE) {
      throw fail(`${label} PT_LOAD alignment 0x${align.toString(16)} is below the required 16 KiB`);
    }
  }
  if (loadSegments === 0) throw fail(`${label} has no PT_LOAD segment`);
}

async function writeGradleInclude() {
  const args = ['metadata', '--format-version', '1', '--manifest-path', CARGO_TOML];
  if (isRegularFile(path.join(MOBILE_SRC_TAURI, 'Cargo.lock'))) args.push('--locked');
  const { stdout } = await runExec('cargo', args, { cwd: MOBILE_SRC_TAURI });
  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (err) {
    throw fail(`cargo metadata returned invalid JSON: ${err.message}`);
  }
  const tauriPkg = (metadata.packages ?? []).find(
    (pkg) => pkg.name === 'tauri' && pkg.version === TAURI_VERSION
  );
  if (!tauriPkg || typeof tauriPkg.manifest_path !== 'string' || tauriPkg.manifest_path === '') {
    throw fail(`mobile Cargo graph does not resolve tauri ${TAURI_VERSION}`);
  }
  const sdkDir = path.join(path.dirname(tauriPkg.manifest_path), 'mobile', 'android');
  if (!isRegularFile(path.join(sdkDir, 'build.gradle.kts'))) {
    throw fail(`tauri Android SDK project is missing at ${sdkDir}`);
  }
  const content =
    '// Generated by host-core/build-mobile.js from cargo metadata. Do not edit.\n' +
    "include ':tauri-android'\n" +
    `project(':tauri-android').projectDir = new File('${toForward(sdkDir)}')\n`;
  await mkdir(MOBILE_BUILD, { recursive: true });
  await writeFile(GRADLE_INCLUDE, content, 'utf8');
  return sdkDir;
}

async function buildWeb() {
  const tscBin = resolveBinScript('typescript', 'bin/tsc');
  const viteBin = resolveBinScript('vite', 'bin/vite.js');
  await spawnNodeScript(tscBin, ['-p', TS_CONFIG, '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
  await spawnNodeScript(viteBin, ['build', '--config', VITE_CONFIG, '--configLoader', 'runner'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (!isRegularFile(path.join(WEB_OUT, 'index.html'))) {
    throw fail(`mobile web build did not produce ${path.join(WEB_OUT, 'index.html')}`);
  }
  return WEB_OUT;
}

// `gradle clean` wipes app/build but leaves mobile/src-tauri/target, so cargo would
// not re-run the wry/tauri build scripts (and their Kotlin codegen) on its own.
const CODEGEN_KOTLIN = ['TauriActivity.kt', 'WryActivity.kt', 'Rust.kt'];

function missingCodegenKotlin() {
  return CODEGEN_KOTLIN.filter((name) => !isRegularFile(path.join(KOTLIN_OUT, name)));
}

async function invalidateStaleKotlinCodegen(abis) {
  if (missingCodegenKotlin().length === 0) return;
  for (const abi of abis) {
    const buildDir = path.join(CARGO_TARGET_DIR, ABI_TARGETS[abi].triple, 'release', 'build');
    const entries = await readdir(buildDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && /^(tauri|wry)-[0-9a-f]+$/.test(entry.name)) {
        await rm(path.join(buildDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

async function buildRustLibraries(abis, ndk) {
  await mkdir(KOTLIN_OUT, { recursive: true });
  await invalidateStaleKotlinCodegen(abis);
  const built = [];
  for (const abi of abis) {
    const spec = ABI_TARGETS[abi];
    await runExec(
      'cargo',
      ['build', '--manifest-path', CARGO_TOML, '--target', spec.triple, '--target-dir', CARGO_TARGET_DIR, '--release'],
      { cwd: MOBILE_SRC_TAURI, env: androidBuildEnv(abi, ndk), stdio: 'inherit' }
    );
    const artifact = path.join(CARGO_TARGET_DIR, spec.triple, 'release', `lib${RUST_LIBRARY}.so`);
    if (!isRegularFile(artifact)) throw fail(`Rust cdylib missing at ${artifact}`);
    const buffer = await readFile(artifact);
    assertElfSharedLibrary(buffer, spec.eMachine, `${abi} lib${RUST_LIBRARY}.so`);
    const target = path.join(JNI_OUT, abi, `lib${RUST_LIBRARY}.so`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buffer);
    built.push({ abi, triple: spec.triple, sha256: sha256Buffer(buffer) });
  }
  const missing = missingCodegenKotlin();
  if (missing.length > 0) {
    throw fail(
      `wry/tauri Kotlin codegen did not write ${missing.join(', ')} into ${KOTLIN_OUT}; ` +
        'WRY_ANDROID_KOTLIN_FILES_OUT_DIR was not honoured'
    );
  }
  return built;
}

// One notices block per crate: the header line plus its license texts.
function splitCargoLicenseBlocks(sections) {
  const blocks = [];
  for (const entry of sections) {
    if (blocks.length === 0 || entry.startsWith('## cargo: ')) blocks.push([]);
    blocks[blocks.length - 1].push(entry);
  }
  return blocks;
}

// Each chosen ABI is resolved on its own graph; identical crates are merged once
// instead of claiming both ABIs always resolve the same dependency set.
async function collectAndroidRustNotices(abis) {
  const blocks = new Map();
  const graphs = [];
  for (const abi of abis) {
    const triple = ABI_TARGETS[abi].triple;
    graphs.push(`${abi} (${triple})`);
    const sections = await collectCargoLicenseSections({
      cargoToml: CARGO_TOML,
      targetTriple: triple,
      metadataFile: path.join(MOBILE_BUILD, `cargo-metadata-${abi}.json`),
    });
    for (const block of splitCargoLicenseBlocks(sections)) {
      if (!blocks.has(block[0])) blocks.set(block[0], block);
    }
  }
  return { graphs, blocks: [...blocks.values()] };
}

async function writeNotices(abis) {
  const { graphs, blocks } = await collectAndroidRustNotices(abis);
  const header = ['# Third-Party Notices (e-Launcher Android Tauri UI)', `ABI graphs: ${graphs.join(', ')}`].join('\n');
  // web/src/gbot-ui 是源码级 MIT 适配（lenML/gbot-ui）：不在 npm/Cargo 图上，
  // 沿用 desktop 读 licenses 文件的方式直接把同一份文本附进 Android 产物。
  const gbotUiLicense = (await readFile(path.join(ROOT, 'licenses', 'gbot-ui-MIT.txt'), 'utf8')).trim();
  const projectNotices = await Promise.all(
    ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/Operit-LGPL-3.0.txt', 'licenses/GPL-3.0.txt',
      // zxing 的 jar/aar 不带许可证文件，AGP 的 META-INF/LICENSE 合并捞不到，随通知一并附上原文。
      'licenses/zxing-android-embedded-4.3.0-Apache-2.0.txt', 'licenses/zxing-core-3.4.1-LICENSE.txt']
      .map(async (file) => '## ' + file + '\n\n' + await readFile(path.join(ROOT, file), 'utf8'))
  );
  const content =
    [header, ...projectNotices, ...blocks.map((block) => block.join('\n\n---\n\n')), '## source: lenML/gbot-ui (MIT)', gbotUiLicense].join('\n\n---\n\n') + '\n';
  await mkdir(NOTICES_DIR, { recursive: true });
  await writeFile(NOTICES_OUT, content, 'utf8');
  return { outfile: NOTICES_OUT, sha256: sha256Buffer(Buffer.from(content, 'utf8')) };
}

async function prepareMobile(abis, ndk) {
  const sdkDir = await writeGradleInclude();
  const webDir = await buildWeb();
  const libraries = await buildRustLibraries(abis, ndk);
  const notices = await writeNotices(abis);
  return {
    done: true,
    tauriSdk: toForward(sdkDir),
    gradleInclude: toForward(GRADLE_INCLUDE),
    webDir: toForward(webDir),
    abis: libraries,
    kotlinDir: toForward(KOTLIN_OUT),
    notices: { outfile: toForward(notices.outfile), sha256: notices.sha256 },
  };
}

const USAGE =
  'usage: node host-core/build-mobile.js [--sdk-path | --web | [--abis arm64-v8a,x86_64] [--ndk <dir>]]\n' +
  '\n' +
  'options:\n' +
  '  --sdk-path     resolve the tauri SDK project from the mobile Cargo graph and write\n' +
  '                 mobile/build/tauri-sdk.gradle only (metadata only, no build)\n' +
  '  --abis <list>  launcher ABIs to build (default arm64-v8a; arm64-v8a,x86_64 for emulators)\n' +
  '  --ndk <dir>    Android NDK directory (default $ANDROID_HOME/ndk/' +
  NDK_VERSION +
  ')\n' +
  '  --web          build mobile/build/web only\n' +
  '  -h, --help     show this help\n';

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        'sdk-path': { type: 'boolean' },
        abis: { type: 'string' },
        ndk: { type: 'string' },
        web: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw invalid(err.message);
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values['sdk-path']) {
    const sdkPath = await writeGradleInclude();
    process.stdout.write(
      JSON.stringify({ sdkPath: toForward(sdkPath), gradleInclude: toForward(GRADLE_INCLUDE) }) + '\n'
    );
    return;
  }
  if (values.web) {
    const webDir = await buildWeb();
    process.stdout.write(JSON.stringify({ done: true, webDir: toForward(webDir) }) + '\n');
    return;
  }
  const abis = resolveAbis(values.abis);
  const ndk = resolveNdk(values.ndk);
  const summary = await prepareMobile(abis, ndk);
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
