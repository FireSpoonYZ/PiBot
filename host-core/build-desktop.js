#!/usr/bin/env node
// host-core/build-desktop.js: product prepare/build/dev entry for the Tauri 2
// Windows/Linux x64 desktop client.
//
// Modes:
//   (default) : prepares Node sidecar binary, bundles host-core/desktop-client-cli.js
//               into desktop/build/desktop-client.mjs, generates icons into
//               desktop/build/icons/, stages the bundled Host runtime into
//               desktop/build/host-runtime/ (host-core sources + production
//               node_modules incl. npm, Cua driver, Windows Shower native host),
//               builds the desktop/host-launcher sidecar (pibot-host), and
//               emits desktop/build/THIRD_PARTY_NOTICES.txt.
//   --web     : prepares desktop resources, then typechecks and builds the desktop
//               frontend (desktop/web -> desktop/build/web).
//   --dev     : prepares desktop resources, then launches Vite dev server on
//               http://127.0.0.1:1420 (strictPort).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTauriCliEntry, spawnNodeScript } from './desktop-tauri.js';
import { prepareSearchTools } from './prepare-tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const DESKTOP_BUILD = path.join(DESKTOP_DIR, 'build');
const BINARIES_DIR = path.join(DESKTOP_BUILD, 'binaries');
const ICONS_DIR = path.join(DESKTOP_BUILD, 'icons');
const METAFILE_DIR = path.join(DESKTOP_BUILD, 'metafile');
const CACHE_DIR = path.join(DESKTOP_BUILD, 'cache');
const DOWNLOADS_DIR = path.join(CACHE_DIR, 'downloads');
const TMP_DIR = path.join(CACHE_DIR, 'tmp');
const MANIFEST_FILE = path.join(CACHE_DIR, 'desktop-prepare-manifest.json');
const ICON_SOURCE = path.join(ROOT, 'assets', 'icon.png');
const BROKER_ENTRY = path.join(HERE, 'desktop-client-cli.js');
const BROKER_OUTFILE = path.join(DESKTOP_BUILD, 'desktop-client.mjs');
const NOTICES_OUTFILE = path.join(DESKTOP_BUILD, 'THIRD_PARTY_NOTICES.txt');
const CARGO_TOML = path.join(DESKTOP_DIR, 'src-tauri', 'Cargo.toml');
// Bundled Host (see desktop/README.md "内置 Host 与自启动"): Tauri maps
// desktop/build/host-runtime/ to the resource dir host-runtime/ and installs the
// pibot-host launcher next to the main binary via externalBin.
const HOST_RUNTIME_DIR = path.join(DESKTOP_BUILD, 'host-runtime');
// npm ci work tree mirroring the repo layout (<work>/host-core + <work>/build/pi-main)
// so the lockfile's relative file:../build/pi-main/*.tgz specs resolve unchanged.
const HOST_RUNTIME_DEPS_DIR = path.join(CACHE_DIR, 'host-runtime-deps');
const HOST_RUNTIME_LAYOUT_VERSION = 1;
const HOST_CORE_RUNTIME_SUBDIRS = ['capabilities', 'managed-install', 'plugins', 'third-party'];
// Builtin skill resources are runtime data the host loads at request time, so
// they stage under their own extension list (docs only, no code).
const HOST_CORE_BUILTIN_SKILLS_DIR = 'builtin-skills';
const BUILTIN_SKILLS_SOURCE_EXTENSIONS = ['.md'];
// Build/dev-only top-level host-core modules that the Host never loads.
const HOST_CORE_RUNTIME_EXCLUDED = new Set(['desktop-tauri.js', 'package-lock.json', 'prepare-android-tools.js', 'prepare-tools.js']);
const HOST_RUNTIME_SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];
// Type declarations / source maps / TS build info are never loaded by the Host;
// pruning them roughly halves the installer file count (AWS/Smithy dist-types).
const HOST_RUNTIME_PRUNED_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts', '.map', '.tsbuildinfo'];
const RELATIVE_IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*(['"])(\.{1,2}\/[^'"]+)\1|import\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\3\s*\)|import\s+(['"])(\.{1,2}\/[^'"]+)\5/g;
const SHOWER_WINDOWS_DIR_ENV = 'E_LAUNCHER_SHOWER_WINDOWS_DIR';
const SHOWER_WINDOWS_SOURCE_DIR = path.join(HERE, 'native', 'windows');
const SHOWER_WINDOWS_BUILD_DIR = path.join(SHOWER_WINDOWS_SOURCE_DIR, 'build');
const SHOWER_WINDOWS_FILES = ['shower-windows.exe', 'MSTSCLib.dll'];
const CUA_DRIVER_ENV = 'E_LAUNCHER_CUA_DRIVER';
const CUA_RELEASE_FILE = path.join(HERE, 'cua-driver-release.json');
const CUA_LICENSE_SOURCE = path.join(ROOT, 'licenses', 'cua', 'LICENSE-MIT.txt');
const HOST_LAUNCHER_DIR = path.join(DESKTOP_DIR, 'host-launcher');
const HOST_LAUNCHER_CARGO_TOML = path.join(HOST_LAUNCHER_DIR, 'Cargo.toml');
const HOST_LAUNCHER_BIN = 'pibot-host';

const NODE_VERSION = '26.13.0';
const TAURI_API_VERSION = '2.12.4';
const TAURI_CLI_VERSION = '2.12.4';
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
const LICENSE_PREFIXES = ['license', 'licence', 'copying', 'notice', 'unlicense', 'copyright'];

// Verified upstream license texts for Rust crates whose published archives omit
// license files (see licenses/desktop/README.md). Only exact package@version +
// license pairs are allowed; anything else still fails with a strict error.
const CARGO_LICENSE_FALLBACKS = new Map([
  ['alloc-stdlib@0.3.0', {
    license: 'BSD-3-Clause',
    files: ['licenses/desktop/alloc-stdlib-0.3.0-BSD-3-Clause.txt'],
  }],
  ['dlopen2@0.8.2', {
    license: 'MIT',
    files: ['licenses/desktop/dlopen2-MIT.txt'],
  }],
  ['dlopen2_derive@0.4.3', {
    license: 'MIT',
    files: ['licenses/desktop/dlopen2-MIT.txt'],
  }],
  ['libappindicator-sys@0.9.0', {
    license: 'Apache-2.0 OR MIT',
    files: [
      'licenses/desktop/libappindicator-sys-0.9.0-MIT.txt',
      'licenses/desktop/libappindicator-sys-0.9.0-Apache-2.0.txt',
    ],
  }],
  ['selectors@0.38.0', {
    license: 'MPL-2.0',
    files: ['licenses/desktop/selectors-0.38.0-MPL-2.0.txt'],
  }],
  ['tauri-plugin@2.7.2', {
    license: 'Apache-2.0 OR MIT',
    files: [
      'licenses/desktop/tauri-plugin-2.7.2-MIT.txt',
      'licenses/desktop/tauri-plugin-2.7.2-Apache-2.0.txt',
    ],
  }],
  ['webview2-com@0.39.1', {
    license: 'MIT',
    files: ['licenses/desktop/webview2-rs-MIT.txt'],
  }],
  ['webview2-com-sys@0.39.1', {
    license: 'MIT',
    files: ['licenses/desktop/webview2-rs-MIT.txt'],
  }],
  ['webview2-com-macros@0.8.1', {
    license: 'MIT',
    files: ['licenses/desktop/webview2-rs-MIT.txt'],
  }],
  // Android Rust graph (M18): the jni-sys-macros 0.4.1 crate archive carries no
  // license file. Both texts are vendored verbatim from the exact upstream commit
  // proven by the crate's .cargo_vcs_info and its Cargo.toml declaration
  // (jni-sys-macros/Cargo.toml at 64d77b7a5f119d7b55b4e2c169a4668067ff59e6).
  ['jni-sys-macros@0.4.1', {
    license: 'MIT OR Apache-2.0',
    provenance:
      'Provenance: jni-sys-macros 0.4.1, jni-rs/jni-sys commit ' +
      '64d77b7a5f119d7b55b4e2c169a4668067ff59e6 (LICENSE-MIT, LICENSE-APACHE; ' +
      'declared "MIT OR Apache-2.0"); texts vendored verbatim in licenses/android/.',
    files: [
      'licenses/android/jni-sys-macros-0.4.1-MIT.txt',
      'licenses/android/jni-sys-macros-0.4.1-Apache-2.0.txt',
    ],
  }],
  // Android Rust graph (M18): the ndk/ndk-sys/ndk-context crate archives carry no
  // license file either. Every entry stays exact package@version + declared license;
  // ndk and ndk-sys map explicitly to the shared rust-mobile/ndk root texts.
  ['ndk-context@0.1.1', {
    license: 'MIT OR Apache-2.0',
    provenance:
      'Provenance: ndk-context 0.1.1, rust-windowing/android-ndk-rs commit ' +
      '10f2ba388fca20f7349996ebae26ccda7a6fda5c, crate path "ndk-context"; version and ' +
      '"MIT OR Apache-2.0" declaration taken from the crate archive Cargo.toml.orig and ' +
      '.cargo_vcs_info (remote manifest retrieval failed), texts vendored verbatim in ' +
      'licenses/android/.',
    files: [
      'licenses/android/ndk-context-0.1.1-MIT.txt',
      'licenses/android/ndk-context-0.1.1-Apache-2.0.txt',
    ],
  }],
  ['ndk@0.9.0', {
    license: 'MIT OR Apache-2.0',
    provenance:
      'Provenance: ndk 0.9.0, rust-mobile/ndk commit ' +
      '49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25, crate path "ndk"; repository root ' +
      'LICENSE-MIT/LICENSE-APACHE at that commit, texts vendored verbatim in ' +
      'licenses/android/.',
    files: [
      'licenses/android/ndk-49bbbba16c58-MIT.txt',
      'licenses/android/ndk-49bbbba16c58-Apache-2.0.txt',
    ],
  }],
  ['ndk-sys@0.6.0+11769913', {
    license: 'MIT OR Apache-2.0',
    provenance:
      'Provenance: ndk-sys 0.6.0+11769913, rust-mobile/ndk commit ' +
      '49bbbba16c58ff63cb8a0ad0eca5a9fb7ecaec25, crate path "ndk-sys"; this workspace ' +
      'inherits the repository root declaration, so the entry maps explicitly to the same ' +
      'verified root LICENSE-MIT/LICENSE-APACHE texts as ndk 0.9.0 (no sibling or ' +
      'version-range fallback), texts vendored verbatim in licenses/android/.',
    files: [
      'licenses/android/ndk-49bbbba16c58-MIT.txt',
      'licenses/android/ndk-49bbbba16c58-Apache-2.0.txt',
    ],
  }],
]);
const DYNAMIC_ASSET_RE = /(?:require\s*\.\s*resolve|createRequire\s*\([^)]*\)\s*\.\s*resolve|new\s+URL)\s*\(\s*(['"])([^'"]+\.(?:wasm|node))\1/g;

// npm archives for the pinned @earendil-works packages omit LICENSE files;
// use the verified in-repo upstream MIT copies if any are ever bundled.
// @vectorize-io/hindsight-client 0.9.2 publishes dist/src/generated only, so its
// MIT text must also be kept in-repo (licenses/hindsight-client-0.9.2-MIT.txt).
// standardwebhooks 1.1.1 (arrives with the anthropic-messages API through
// @anthropic-ai/sdk) ships no license file either. Its npm manifest declares MIT,
// but the repository at the npm gitHead commit only carries the Apache-2.0 LICENSE
// text, vendored verbatim (provenance header included) in
// licenses/standardwebhooks-1.1.1-LICENSE.txt -- that text is NOT an MIT copy.
// `declared` is the manifest license to match, `license` the in-repo text file; a
// package@version outside this map still fails the missing-license check.
// Official Pi 1.5.0 packages; the exact upstream MIT text covers archives without a root license.
const PI_MAIN_VERSION = '1.5.0';
const UPSTREAM_LICENSE_ALLOWLIST = new Map([
  ['@earendil-works/pi-schema', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@earendil-works/chord', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@earendil-works/pi-ai', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@earendil-works/pi-codemode', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@earendil-works/pi-durable', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@earendil-works/pi-mcp', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@earendil-works/pi-telemetry', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-1.5.0-MIT.txt' }],
  ['@vectorize-io/hindsight-client', { version: '0.9.2', declared: 'MIT', license: 'hindsight-client-0.9.2-MIT.txt' }],
  ['standardwebhooks', { version: '1.1.1', declared: 'MIT', license: 'standardwebhooks-1.1.1-LICENSE.txt' }],
  // Desktop UI packages (consumed through UI_NPM_PACKAGES, not the broker
  // bundle): remark-math 6.0.0 and rehype-katex 7.0.1 publish no license file
  // in their npm archives. Both live in the remarkjs/remark-math monorepo and
  // share the same MIT text by Junyoung Choi, vendored verbatim in
  // licenses/desktop/ (provenance recorded in licenses/desktop/README.md).
  ['remark-math', { version: '6.0.0', declared: 'MIT', license: 'desktop/remark-math-6.0.0-MIT.txt' }],
  ['rehype-katex', { version: '7.0.1', declared: 'MIT', license: 'desktop/rehype-katex-7.0.1-MIT.txt' }],
  ['@aws-sdk/credential-provider-http', { version: '3.972.77', declared: 'Apache-2.0', license: 'desktop/aws-sdk-js-v3-Apache-2.0.txt' }],
  ['@aws-sdk/credential-provider-login', { version: '3.972.82', declared: 'Apache-2.0', license: 'desktop/aws-sdk-js-v3-Apache-2.0.txt' }],
  ['@aws-sdk/nested-clients', { version: '3.997.49', declared: 'Apache-2.0', license: 'desktop/aws-sdk-js-v3-Apache-2.0.txt' }],
  ['data-uri-to-buffer', { version: '4.0.1', declared: 'MIT', license: 'desktop/data-uri-to-buffer-4.0.1-MIT.txt' }],
  ['proxy-agent-negotiate', { version: '1.1.0', declared: 'MIT', license: 'desktop/proxy-agents-MIT.txt' }],
]);

// UI packages explicitly used by the desktop frontend; their full licenses are
// collected from the installed root node_modules (they are not part of the
// Node broker bundle, so the bundle metafile does not cover them). The list
// covers the shared Android-ported UI components (Markdown, ToolPresentation,
// ui.tsx, GrokBotAvatar, dialog.tsx) that the desktop shell renders.
// shortcut: remark-math@6.0.0 and rehype-katex@7.0.1 ship no license file in
// their npm archives, so their license texts come from UPSTREAM_LICENSE_ALLOWLIST.
const UI_NPM_PACKAGES = [
  'react',
  'react-dom',
  'scheduler',
  '@tauri-apps/api',
  'lucide-react',
  'react-markdown',
  'remark-gfm',
  'remark-math',
  'rehype-katex',
  'katex',
  '@radix-ui/react-dialog',
];

const NODE_TARGETS = {
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
    archiveName: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: 'dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a',
    binaryEntry: `node-v${NODE_VERSION}-win-x64/node.exe`,
    licenseEntry: `node-v${NODE_VERSION}-win-x64/LICENSE`,
    sidecarName: 'pibot-node-x86_64-pc-windows-msvc.exe',
    tarFlags: ['-xf'],
    platform: 'win32',
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`,
    archiveName: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    sha256: '5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455',
    binaryEntry: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    licenseEntry: `node-v${NODE_VERSION}-linux-x64/LICENSE`,
    sidecarName: 'pibot-node-x86_64-unknown-linux-gnu',
    tarFlags: ['-xzf'],
    platform: 'linux',
  },
};

const execFileAsync = promisify(execFile);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function fail(message) {
  return Object.assign(new Error(message), { code: 'DESKTOP_BUILD_FAILED' });
}

function isRegularFile(filePath) {
  const stats = lstatSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile() && !stats.isSymbolicLink();
}

function assertStrictlyRegularFile(filePath, label) {
  const stats = lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) throw fail(`${label} is missing`);
  if (stats.isSymbolicLink()) throw fail(`${label} must not be a symbolic link`);
  if (!stats.isFile()) throw fail(`${label} must be a regular file`);
  return stats;
}

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256OfFile(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function tempSibling(dir, base) {
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
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
    if (!isRegularFile(candidate)) {
      throw fail('System32/tar.exe not found; PowerShell/cmd/WSL fallback is not supported');
    }
    return candidate;
  }
  return 'tar';
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

function currentNodeTarget() {
  const key = `${process.platform}-${process.arch}`;
  const spec = NODE_TARGETS[key];
  if (!spec) {
    throw fail(`unsupported desktop build platform/arch: ${key} (expected win32-x64 or linux-x64)`);
  }
  return spec;
}

function assertBinaryHeader(buffer, platform, label) {
  if (platform === 'win32') {
    if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      throw fail(`${label} is not a Windows PE executable (MZ header missing)`);
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
    throw fail(`${label} is not an ELF executable`);
  }
  if (buffer.length < 20 || buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== 62) {
    throw fail(`${label} is not a 64-bit little-endian x86_64 ELF executable`);
  }
}

function assertExtractedTreeHasNoSymlinks(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current);
    for (const entry of entries) {
      const full = path.join(current, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw fail('extracted Node archive contains a symbolic link');
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (!st.isFile()) {
        throw fail('extracted Node archive contains a non-regular entry');
      }
    }
  }
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
    assertStrictlyRegularFile(partial, `downloaded archive ${fileName}`);
    const actual = sha256OfFile(partial);
    if (actual !== expectedSha256) {
      throw fail(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
    }
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
  return target;
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
  const partial = tempSibling(CACHE_DIR, 'desktop-prepare-manifest.json');
  writeFileSync(partial, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(partial, MANIFEST_FILE);
}

async function prepareNodeSidecar() {
  const spec = currentNodeTarget();
  const sidecarPath = path.join(BINARIES_DIR, spec.sidecarName);
  const cachedLicensePath = path.join(CACHE_DIR, `node-v${NODE_VERSION}-${spec.triple}-LICENSE.txt`);
  const manifest = readManifest() ?? { version: 1 };

  if (isRegularFile(sidecarPath) && isRegularFile(cachedLicensePath)) {
    const binHash = sha256OfFile(sidecarPath);
    const licHash = sha256OfFile(cachedLicensePath);
    const rec = manifest.node?.[spec.triple];
    if (
      rec &&
      rec.version === NODE_VERSION &&
      rec.archiveSha256 === spec.sha256 &&
      rec.binarySha256 === binHash &&
      rec.licenseSha256 === licHash
    ) {
      const licenseText = readFileSync(cachedLicensePath, 'utf8');
      if (licenseText.trim() !== '') {
        return {
          triple: spec.triple,
          version: NODE_VERSION,
          sidecarPath,
          binarySha256: binHash,
          licenseText,
          status: 'cached',
        };
      }
    }
  }

  const archivePath = await downloadVerified(spec.url, spec.sha256, spec.archiveName);
  mkdirSync(TMP_DIR, { recursive: true });
  const extractDir = path.join(TMP_DIR, `node-extract-${process.pid}-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  try {
    await runExec(tarCommand(), [
      ...spec.tarFlags,
      archivePath,
      '-C',
      extractDir,
      spec.binaryEntry,
      spec.licenseEntry,
    ]);
    assertExtractedTreeHasNoSymlinks(extractDir);

    const extractedBinary = path.join(extractDir, ...spec.binaryEntry.split('/'));
    const extractedLicense = path.join(extractDir, ...spec.licenseEntry.split('/'));
    assertStrictlyRegularFile(extractedBinary, 'extracted Node binary');
    assertStrictlyRegularFile(extractedLicense, 'extracted Node LICENSE');

    const binaryBuffer = readFileSync(extractedBinary);
    assertBinaryHeader(binaryBuffer, spec.platform, 'Node sidecar binary');
    const licenseBuffer = readFileSync(extractedLicense);
    const licenseText = licenseBuffer.toString('utf8');
    if (licenseText.trim() === '') {
      throw fail('extracted Node LICENSE is empty');
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    const tmpLicense = tempSibling(CACHE_DIR, path.basename(cachedLicensePath));
    writeFileSync(tmpLicense, licenseBuffer);
    renameSync(tmpLicense, cachedLicensePath);

    mkdirSync(BINARIES_DIR, { recursive: true });
    const tmpBinary = tempSibling(BINARIES_DIR, spec.sidecarName);
    writeFileSync(tmpBinary, binaryBuffer);
    if (process.platform !== 'win32') chmodSync(tmpBinary, 0o755);
    renameSync(tmpBinary, sidecarPath);

    const binHash = sha256Buffer(binaryBuffer);
    const licHash = sha256Buffer(licenseBuffer);
    manifest.version = 1;
    manifest.node ??= {};
    manifest.node[spec.triple] = {
      version: NODE_VERSION,
      archiveSha256: spec.sha256,
      binarySha256: binHash,
      licenseSha256: licHash,
    };
    writeManifest(manifest);

    return {
      triple: spec.triple,
      version: NODE_VERSION,
      sidecarPath,
      binarySha256: binHash,
      licenseText,
      status: 'installed',
    };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function prepareIcons() {
  assertStrictlyRegularFile(ICON_SOURCE, 'assets/icon.png');
  const sourceHash = sha256OfFile(ICON_SOURCE);
  const icoPath = path.join(ICONS_DIR, 'icon.ico');
  const pngPath = path.join(ICONS_DIR, 'icon.png');
  const manifest = readManifest() ?? { version: 1 };

  if (isRegularFile(icoPath) && isRegularFile(pngPath)) {
    const icoHash = sha256OfFile(icoPath);
    const pngHash = sha256OfFile(pngPath);
    const rec = manifest.icons;
    if (
      rec &&
      rec.sourceSha256 === sourceHash &&
      rec.icoSha256 === icoHash &&
      rec.pngSha256 === pngHash
    ) {
      return { icoPath, pngPath, status: 'cached' };
    }
  }

  mkdirSync(ICONS_DIR, { recursive: true });
  const cliEntry = resolveTauriCliEntry(ROOT);
  await spawnNodeScript(
    cliEntry,
    ['icon', ICON_SOURCE, '--output', ICONS_DIR],
    { cwd: DESKTOP_DIR, stdio: 'inherit' }
  );

  assertStrictlyRegularFile(icoPath, 'generated desktop/build/icons/icon.ico');
  assertStrictlyRegularFile(pngPath, 'generated desktop/build/icons/icon.png');
  if (statSync(icoPath).size === 0 || statSync(pngPath).size === 0) {
    throw fail('generated desktop icons must be non-empty');
  }

  const nextManifest = readManifest() ?? { version: 1 };
  nextManifest.icons = {
    sourceSha256: sourceHash,
    icoSha256: sha256OfFile(icoPath),
    pngSha256: sha256OfFile(pngPath),
  };
  writeManifest(nextManifest);
  return { icoPath, pngPath, status: 'generated' };
}

function loadEsbuild() {
  const candidates = [
    path.join(HERE, 'package.json'),
    path.join(ROOT, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (!isRegularFile(candidate)) continue;
    try {
      const req = createRequire(pathToFileURL(candidate).href);
      return req('esbuild');
    } catch {
      /* try next location */
    }
  }
  throw fail('esbuild not found; run npm ci in repository root / host-core first');
}

async function assertInstalledHostDependencies() {
  const hostPkg = JSON.parse(await readFile(path.join(HERE, 'package.json'), 'utf8'));
  const hostCoreNodeModules = path.join(HERE, 'node_modules');
  const deps = hostPkg.dependencies ?? {};
  for (const [name, expected] of Object.entries(deps)) {
    const pkgPath = path.join(hostCoreNodeModules, name, 'package.json');
    const raw = await readIfPresent(pkgPath);
    if (!raw) {
      throw fail(`host-core dependency ${name} is not installed at ${pkgPath}; run npm --prefix host-core ci first`);
    }
    let pkg;
    try {
      pkg = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw fail(`host-core dependency ${name} package.json is invalid: ${err.message}`);
    }
    // file: deps pin a tarball path, not a semver. For the six pinned
    // @earendil-works packages the installed package.json version must equal
    // the deterministic PI_MAIN_VERSION; every other dependency keeps the
    // strict name+version match below.
    const versionOk = expected.startsWith('file:') ? pkg.version === PI_MAIN_VERSION : pkg.version === expected;
    if (pkg.name !== name || !versionOk) {
      throw fail(`host-core dependency ${name} installed ${pkg.name ?? 'unknown'}@${pkg.version ?? 'unknown'} does not match pinned ${expected}`);
    }
  }
}

async function assertInstalledDesktopDependencies() {
  for (const [name, expected] of [
    ['@tauri-apps/api', TAURI_API_VERSION],
    ['@tauri-apps/cli', TAURI_CLI_VERSION],
  ]) {
    const pkgPath = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
    const raw = await readIfPresent(pkgPath);
    if (!raw) {
      throw fail(`desktop dependency ${name} is not installed at ${pkgPath}; run npm ci in repository root first`);
    }
    const pkg = JSON.parse(raw.toString('utf8'));
    if (pkg.name !== name || pkg.version !== expected) {
      throw fail(`desktop dependency ${name} installed ${pkg.name ?? 'unknown'}@${pkg.version ?? 'unknown'} does not match pinned ${expected}`);
    }
  }
}

function normalizeToAbsolute(absWorkingDir, filePath) {
  const normalized = filePath.replace(/\//g, path.sep).replace(/\\/g, path.sep);
  return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(absWorkingDir, normalized);
}

async function findPackageRoot(startDir) {
  let dir = startDir;
  while (dir && dir !== path.dirname(dir) && dir.startsWith(ROOT)) {
    const pkgFile = path.join(dir, 'package.json');
    const raw = await readIfPresent(pkgFile);
    if (raw) {
      try {
        const pkg = JSON.parse(raw.toString('utf8'));
        if (
          typeof pkg.name === 'string' &&
          pkg.name !== '' &&
          typeof pkg.version === 'string' &&
          pkg.version !== ''
        ) {
          return {
            root: dir,
            name: pkg.name,
            version: pkg.version,
            license: pkg.license ?? null,
          };
        }
      } catch {
        /* skip malformed/nameless package.json */
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

async function findLicenseFiles(pkgRoot) {
  const entries = (await readdir(pkgRoot)).sort();
  const found = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (LICENSE_PREFIXES.some((p) => lower.startsWith(p))) {
      const full = path.join(pkgRoot, entry);
      const info = lstatSync(full, { throwIfNoEntry: false });
      if (info && info.isFile() && !info.isSymbolicLink()) {
        found.push(full);
      }
    }
    if (lower === 'licenses' || lower === 'license') {
      const subDir = path.join(pkgRoot, entry);
      const subStat = lstatSync(subDir, { throwIfNoEntry: false });
      if (subStat && subStat.isDirectory() && !subStat.isSymbolicLink()) {
        for (const subEntry of (await readdir(subDir)).sort()) {
          const full = path.join(subDir, subEntry);
          const info = lstatSync(full, { throwIfNoEntry: false });
          if (info && info.isFile() && !info.isSymbolicLink()) {
            found.push(full);
          }
        }
      }
    }
  }
  return found;
}

function includedBundleInputs(metafile, outfile, absWorkingDir) {
  const outputs = metafile.outputs ?? {};
  const keys = Object.keys(outputs);
  if (keys.length === 0) {
    throw fail(`esbuild metafile has no outputs; bundle output missing: ${outfile}`);
  }
  const targetAbs = normalizeToAbsolute(absWorkingDir, outfile);
  const key = keys.find((k) => normalizeToAbsolute(absWorkingDir, k) === targetAbs);
  if (!key) {
    throw fail(`esbuild metafile output not found: ${outfile}`);
  }
  const output = outputs[key];
  if (!output.inputs || Object.keys(output.inputs).length === 0) {
    throw fail(`esbuild output has no included inputs: ${outfile}`);
  }
  return Object.keys(output.inputs).filter((p) => output.inputs[p].bytesInOutput > 0);
}

async function assertNoRequiredDynamicAssets(metafile, outfile, absWorkingDir) {
  const hits = [];
  for (const raw of includedBundleInputs(metafile, outfile, absWorkingDir)) {
    const inputPath = normalizeToAbsolute(absWorkingDir, raw);
    const text = await readIfPresent(inputPath);
    if (!text) continue;
    const source = text.toString('utf8');
    for (const match of source.matchAll(DYNAMIC_ASSET_RE)) {
      hits.push({ module: path.relative(ROOT, inputPath), reference: match[2] });
    }
  }
  if (hits.length > 0) {
    const lines = hits.map((h) => `${h.module} -> ${h.reference}`).join('; ');
    throw fail(`bundled desktop client requires runtime dynamic asset(s): ${lines}`);
  }
}

async function collectBundledNpmPackages(metafile, outfile, absWorkingDir) {
  const roots = new Map();
  for (const raw of includedBundleInputs(metafile, outfile, absWorkingDir)) {
    const inputPath = normalizeToAbsolute(absWorkingDir, raw);
    const pkg = await findPackageRoot(path.dirname(inputPath));
    if (
      pkg &&
      pkg.name !== '@e-launcher/host-core' &&
      pkg.name !== 'pibot' &&
      !roots.has(`${pkg.name}@${pkg.version}`)
    ) {
      roots.set(`${pkg.name}@${pkg.version}`, pkg);
    }
  }
  return roots;
}

async function bundleDesktopClient() {
  const esbuild = loadEsbuild();
  await access(BROKER_ENTRY);
  await assertInstalledHostDependencies();
  await assertInstalledDesktopDependencies();
  await mkdir(DESKTOP_BUILD, { recursive: true });
  await mkdir(METAFILE_DIR, { recursive: true });

  const metafilePath = path.join(METAFILE_DIR, 'desktop-client-metafile.json');
  const result = await esbuild.build({
    entryPoints: [BROKER_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    absWorkingDir: ROOT,
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: 'import { createRequire as __bundleRequire } from "node:module"; import { fileURLToPath as __bundlePath } from "node:url"; import { dirname as __bundleDir } from "node:path"; const require = __bundleRequire(import.meta.url); const __filename = __bundlePath(import.meta.url); const __dirname = __bundleDir(__filename);',
    },
    metafile: true,
    outfile: BROKER_OUTFILE,
    logLevel: 'info',
  });
  const centerDir = path.join(ROOT, 'center-server') + path.sep;
  if (includedBundleInputs(result.metafile, BROKER_OUTFILE, ROOT).some((input) => normalizeToAbsolute(ROOT, input).startsWith(centerDir))) {
    throw fail('center-server code or dependencies cannot be bundled into the desktop Host');
  }
  await writeFile(metafilePath, JSON.stringify(result.metafile, null, 2) + '\n', 'utf8');
  await assertNoRequiredDynamicAssets(result.metafile, BROKER_OUTFILE, ROOT);
  return { outfile: BROKER_OUTFILE, metafile: result.metafile };
}

async function collectNpmLicenseSections(metafile) {
  const roots = await collectBundledNpmPackages(metafile, BROKER_OUTFILE, ROOT);
  const sections = [];
  const sorted = [...roots.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );
  for (const pkg of sorted) {
    const licenseFiles = await findLicenseFiles(pkg.root);
    sections.push(`## npm: ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})`);
    if (licenseFiles.length === 0) {
      const upstream = UPSTREAM_LICENSE_ALLOWLIST.get(pkg.name);
      if (upstream && upstream.version === pkg.version && pkg.license === upstream.declared) {
        const upstreamPath = path.join(ROOT, 'licenses', upstream.license);
        const text = await readIfPresent(upstreamPath);
        if (!text) throw fail(`in-repo upstream license missing: ${upstreamPath}`);
        sections.push(text.toString('utf8').trim());
      } else {
        throw fail(`bundled npm package ${pkg.name}@${pkg.version} has no license file`);
      }
    } else {
      for (const file of licenseFiles) {
        sections.push((await readFile(file, 'utf8')).trim());
      }
    }
  }
  if (includedBundleInputs(metafile, BROKER_OUTFILE, ROOT).some(
    (input) => normalizeToAbsolute(ROOT, input) === path.join(HERE, 'third-party', 'pi-skills.js')
  )) {
    sections.push('## Pi managed Skill adaptation (MIT; v1.3.0)');
    sections.push((await readFile(path.join(ROOT, 'licenses', 'pi-v1.3.0-MIT.txt'), 'utf8')).trim());
  }
  return sections;
}

async function collectUiNpmLicenseSections() {
  const sections = [];
  for (const name of UI_NPM_PACKAGES) {
    const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
    const pkgPath = path.join(dir, 'package.json');
    const raw = await readIfPresent(pkgPath);
    if (!raw) {
      throw fail(`UI npm package ${name} is not installed at ${pkgPath}; run npm ci in repository root first`);
    }
    let pkg;
    try {
      pkg = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw fail(`UI npm package ${name} package.json is invalid: ${err.message}`);
    }
    const licenseFiles = await findLicenseFiles(dir);
    if (licenseFiles.length === 0) {
      const upstream = UPSTREAM_LICENSE_ALLOWLIST.get(name);
      if (upstream && upstream.version === pkg.version && pkg.license === upstream.declared) {
        const upstreamPath = path.join(ROOT, 'licenses', upstream.license);
        const text = await readIfPresent(upstreamPath);
        if (!text) throw fail(`in-repo upstream license missing: ${upstreamPath}`);
        sections.push(`## web: ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})`);
        sections.push(text.toString('utf8').trim());
        continue;
      }
      throw fail(`UI npm package ${name}@${pkg.version ?? 'unknown'} has no license file`);
    }
    sections.push(`## web: ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})`);
    for (const file of licenseFiles) {
      sections.push((await readFile(file, 'utf8')).trim());
    }
  }
  return sections;
}

// Also used by host-core/build-mobile.js for the Android Tauri UI notices, so the
// exact-version license fallbacks stay in one place.
export async function collectCargoLicenseSections({
  cargoToml = CARGO_TOML,
  targetTriple = currentNodeTarget().triple,
  metadataFile = path.join(METAFILE_DIR, 'cargo-metadata.json'),
} = {}) {
  if (!isRegularFile(cargoToml)) {
    throw fail(`${path.relative(ROOT, cargoToml)} is missing; native shell must be present before packaging`);
  }
  // --filter-platform prunes the resolve graph to the current build target so
  // platform-only dependencies (e.g. macOS) never enter the notices.
  const args = ['metadata', '--format-version', '1', '--manifest-path', cargoToml];
  if (targetTriple) {
    args.push('--filter-platform', targetTriple);
  }
  if (isRegularFile(path.join(path.dirname(cargoToml), 'Cargo.lock'))) {
    args.push('--locked');
  }
  const { stdout } = await runExec('cargo', args, { cwd: path.dirname(cargoToml) });
  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(metadataFile, stdout, 'utf8');

  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (err) {
    throw fail(`cargo metadata returned invalid JSON: ${err.message}`);
  }
  const workspaceMembers = new Set(metadata.workspace_members ?? []);
  const resolvedNodes = metadata.resolve?.nodes ?? [];
  if (resolvedNodes.length === 0) {
    throw fail('cargo metadata resolve graph is empty');
  }
  const byId = new Map((metadata.packages ?? []).map((pkg) => [pkg.id, pkg]));
  const seen = new Map();
  for (const node of resolvedNodes) {
    if (workspaceMembers.has(node.id)) continue;
    const pkg = byId.get(node.id);
    if (!pkg) {
      throw fail(`cargo resolve node ${node.id} has no matching package entry`);
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (!seen.has(key)) seen.set(key, pkg);
  }
  if (seen.size === 0) {
    throw fail('cargo metadata resolved zero third-party Rust dependencies');
  }

  const sections = [];
  const sorted = [...seen.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );

  for (const pkg of sorted) {
    if (typeof pkg.manifest_path !== 'string' || pkg.manifest_path === '') {
      throw fail(`cargo package ${pkg.name}@${pkg.version} has no manifest_path`);
    }
    const pkgDir = path.dirname(pkg.manifest_path);
    let licenseFiles = [];
    if (typeof pkg.license_file === 'string' && pkg.license_file !== '') {
      const explicitFile = path.resolve(pkgDir, pkg.license_file);
      if (isRegularFile(explicitFile)) {
        licenseFiles.push(explicitFile);
      }
    }
    const discovered = await findLicenseFiles(pkgDir);
    for (const file of discovered) {
      if (!licenseFiles.includes(file)) licenseFiles.push(file);
    }
    let fallbackProvenance = null;
    if (licenseFiles.length === 0) {
      const fallback = CARGO_LICENSE_FALLBACKS.get(`${pkg.name}@${pkg.version}`);
      if (fallback && fallback.license === (pkg.license ?? null)) {
        for (const relFile of fallback.files) {
          const file = path.resolve(ROOT, relFile);
          if (!isRegularFile(file)) {
            throw fail(`vendored license file missing for ${pkg.name}@${pkg.version}: ${relFile}`);
          }
          licenseFiles.push(file);
        }
        fallbackProvenance = fallback.provenance ?? null;
      }
    }
    if (licenseFiles.length === 0) {
      throw fail(`Rust dependency ${pkg.name}@${pkg.version} has no license file in crate archive`);
    }

    const headerLines = [`## cargo: ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})`];
    if (Array.isArray(pkg.authors) && pkg.authors.length > 0) {
      headerLines.push(`Authors: ${pkg.authors.join(', ')}`);
    }
    if (typeof pkg.repository === 'string' && pkg.repository !== '') {
      headerLines.push(`Repository: ${pkg.repository}`);
    } else if (typeof pkg.homepage === 'string' && pkg.homepage !== '') {
      headerLines.push(`Homepage: ${pkg.homepage}`);
    }
    if (fallbackProvenance) headerLines.push(fallbackProvenance);
    sections.push(headerLines.join('\n'));
    for (const file of licenseFiles) {
      sections.push((await readFile(file, 'utf8')).trim());
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Bundled Host runtime (desktop/build/host-runtime/) and the pibot-host
// launcher sidecar. Layout (relative to the Tauri resource dir host-runtime/):
//   host-core/                     runtime host-core modules + package.json
//   host-core/node_modules/        production deps for this platform (incl. npm)
//   host-core/cua-driver/<key>/    pinned cua-driver-rs files (cua-driver.js path)
//   tools/<platform>-<arch>/       pinned rg/fd binaries and licenses
//   plugins/<name>/                first-party plugin files host-core re-exports
//   native/shower-windows.exe      Windows only, + MSTSCLib.dll (launcher exports
//                                  E_LAUNCHER_SHOWER_WINDOWS_EXE)
// ---------------------------------------------------------------------------

function toPosixPath(relPath) {
  return relPath.split(path.sep).join('/');
}

function isInsideDir(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function hasRuntimeSourceExtension(name, extensions = HOST_RUNTIME_SOURCE_EXTENSIONS) {
  return extensions.some((ext) => name.endsWith(ext)) && !/\.(?:test|spec)\.[cm]?js$/.test(name);
}

function listRuntimeSourceTree(dir, out, extensions = HOST_RUNTIME_SOURCE_EXTENSIONS) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'test' || entry === 'tests' || entry === '__tests__') {
      continue;
    }
    const full = path.join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      throw fail(`host runtime source must not be a symbolic link: ${toPosixPath(path.relative(ROOT, full))}`);
    }
    if (st.isDirectory()) {
      listRuntimeSourceTree(full, out, extensions);
    } else if (st.isFile() && hasRuntimeSourceExtension(entry, extensions)) {
      out.push(full);
    }
  }
}

// Map<destination relative to host-runtime/ (POSIX), absolute source path>.
// Starts from every runtime host-core module (top-level *.js/*.mjs/*.cjs/*.json
// minus build-only scripts, plus the runtime subdirectories), then follows
// static/literal-dynamic relative imports so out-of-tree re-exports (e.g.
// host-core/hindsight-protocol.js -> ../plugins/hindsight/*) are staged at the
// same relative location. Imports leaving host-core/ must stay under plugins/.
function collectHostRuntimeSources() {
  const roots = [];
  for (const entry of readdirSync(HERE).sort()) {
    const full = path.join(HERE, entry);
    if (!isRegularFile(full)) continue;
    if (entry.startsWith('build-') || HOST_CORE_RUNTIME_EXCLUDED.has(entry)) continue;
    if (!hasRuntimeSourceExtension(entry)) continue;
    roots.push(full);
  }
  for (const sub of HOST_CORE_RUNTIME_SUBDIRS) {
    const dir = path.join(HERE, sub);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || st.isSymbolicLink()) {
      throw fail(`host-core/${sub}/ is missing; cannot stage the bundled Host runtime`);
    }
    listRuntimeSourceTree(dir, roots);
  }
  {
    const dir = path.join(HERE, HOST_CORE_BUILTIN_SKILLS_DIR);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || st.isSymbolicLink()) {
      throw fail(`host-core/${HOST_CORE_BUILTIN_SKILLS_DIR}/ is missing; cannot stage the bundled Host runtime`);
    }
    listRuntimeSourceTree(dir, roots, BUILTIN_SKILLS_SOURCE_EXTENSIONS);
  }
  for (const required of ['host-service-cli.js', 'package.json']) {
    if (!roots.includes(path.join(HERE, required))) {
      throw fail(`host-core/${required} is missing; cannot stage the bundled Host runtime`);
    }
  }

  const files = new Set(roots);
  const queue = roots.filter((file) => /\.[cm]?js$/.test(file));
  const pluginsDir = path.join(ROOT, 'plugins');
  const pluginRoots = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    const display = toPosixPath(path.relative(ROOT, file));
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      const spec = match[2] ?? match[4] ?? match[6];
      const target = path.resolve(path.dirname(file), spec.split(/[?#]/)[0]);
      if (!isRegularFile(target)) {
        throw fail(`host runtime module ${display} imports missing file ${spec}`);
      }
      if (!isInsideDir(HERE, target)) {
        if (!isInsideDir(pluginsDir, target)) {
          throw fail(`host runtime module ${display} imports ${spec} outside host-core/ and plugins/; it cannot be bundled`);
        }
        pluginRoots.add(path.join(pluginsDir, path.relative(pluginsDir, target).split(path.sep)[0]));
      } else if (isInsideDir(path.join(HERE, 'node_modules'), target)) {
        throw fail(`host runtime module ${display} imports node_modules by relative path: ${spec}`);
      }
      if (!files.has(target)) {
        files.add(target);
        if (/\.[cm]?js$/.test(target)) queue.push(target);
      }
    }
  }
  // Staged plugin files keep their package.json ("type": "module") and license.
  for (const pluginRoot of pluginRoots) {
    for (const entry of readdirSync(pluginRoot).sort()) {
      const lower = entry.toLowerCase();
      if (entry !== 'package.json' && !LICENSE_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
      const full = path.join(pluginRoot, entry);
      if (isRegularFile(full)) files.add(full);
    }
  }

  const sources = new Map();
  for (const file of [...files].sort()) {
    sources.set(toPosixPath(path.relative(ROOT, file)), file);
  }
  return sources;
}

function newestCsSourceMtimeMs() {
  let newest = 0;
  for (const name of readdirSync(SHOWER_WINDOWS_SOURCE_DIR)) {
    if (!name.endsWith('.cs')) continue;
    newest = Math.max(newest, statSync(path.join(SHOWER_WINDOWS_SOURCE_DIR, name)).mtimeMs);
  }
  return newest;
}

// Windows Shower native host: explicit prebuilt directory, else the outputs of
// host-core/build-shower-windows.js (rebuilt when missing or older than any
// native/windows/*.cs source).
async function resolveShowerWindowsDir() {
  const override = process.env[SHOWER_WINDOWS_DIR_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      throw fail(`${SHOWER_WINDOWS_DIR_ENV} must be an absolute directory path: ${override}`);
    }
    const dir = path.normalize(override);
    for (const name of SHOWER_WINDOWS_FILES) {
      assertStrictlyRegularFile(path.join(dir, name), `${SHOWER_WINDOWS_DIR_ENV}${path.sep}${name}`);
    }
    return { dir, status: 'override' };
  }
  const outputs = SHOWER_WINDOWS_FILES.map((name) => path.join(SHOWER_WINDOWS_BUILD_DIR, name));
  const upToDate =
    outputs.every((file) => isRegularFile(file)) &&
    Math.min(...outputs.map((file) => statSync(file).mtimeMs)) >= newestCsSourceMtimeMs();
  if (upToDate) return { dir: SHOWER_WINDOWS_BUILD_DIR, status: 'cached' };
  try {
    await runExec(process.execPath, [path.join(HERE, 'build-shower-windows.js')], { cwd: ROOT });
  } catch (err) {
    throw fail(
      `Windows Shower native host build failed (${err.message}); install .NET Framework 4.8 (Framework64 csc.exe) ` +
        `or set ${SHOWER_WINDOWS_DIR_ENV} to an absolute directory containing prebuilt ${SHOWER_WINDOWS_FILES.join(' and ')}`
    );
  }
  for (const file of outputs) {
    assertStrictlyRegularFile(file, `built ${toPosixPath(path.relative(ROOT, file))}`);
  }
  return { dir: SHOWER_WINDOWS_BUILD_DIR, status: 'built' };
}

// Pinned cua-driver-rs file set staged where host-core/cua-driver.js resolves it
// (host-core/cua-driver/<platform-arch>/). E_LAUNCHER_CUA_DRIVER points at a
// prebuilt driver binary whose directory holds the full release file set.
async function resolveCuaDriverFiles() {
  let releaseSpec;
  try {
    releaseSpec = JSON.parse(readFileSync(CUA_RELEASE_FILE, 'utf8'));
  } catch (err) {
    throw fail(`cannot read host-core/cua-driver-release.json: ${err.message}`);
  }
  const key = `${process.platform}-${process.arch}`;
  const target = releaseSpec.targets?.[key];
  if (!target || !Array.isArray(target.entries) || typeof target.driverName !== 'string') {
    throw fail(`host-core/cua-driver-release.json has no usable target for ${key}`);
  }
  let dir;
  let status;
  const override = process.env[CUA_DRIVER_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      throw fail(`${CUA_DRIVER_ENV} must be the absolute path of ${target.driverName}: ${override}`);
    }
    const driver = path.normalize(override);
    assertStrictlyRegularFile(driver, `${CUA_DRIVER_ENV} (${driver})`);
    if (path.basename(driver) !== target.driverName) {
      throw fail(`${CUA_DRIVER_ENV} must point at ${target.driverName}, got ${driver}`);
    }
    dir = path.dirname(driver);
    status = 'override';
  } else {
    try {
      const { prepareCuaDriver } = await import('./build-cua-driver.js');
      const prepared = await prepareCuaDriver();
      dir = prepared.dir;
      status = prepared.status;
    } catch (err) {
      throw fail(
        `Cua driver prepare failed (${err?.message ?? String(err)}); run node host-core/build-cua-driver.js ` +
          `or set ${CUA_DRIVER_ENV} to the absolute path of a prebuilt ${target.driverName} whose directory ` +
          `holds the full ${releaseSpec.release} file set (${target.entries.join(', ')})`
      );
    }
  }
  const files = [];
  for (const entry of target.entries) {
    const src = path.join(dir, entry);
    assertStrictlyRegularFile(src, `Cua driver file ${entry} in ${dir}`);
    files.push({ dest: `host-core/cua-driver/${key}/${entry}`, src, executable: !entry.endsWith('.h') });
  }
  assertBinaryHeader(readFileSync(path.join(dir, target.driverName)), process.platform, 'Cua driver binary');
  const license = isRegularFile(path.join(dir, 'LICENSE')) ? path.join(dir, 'LICENSE') : CUA_LICENSE_SOURCE;
  assertStrictlyRegularFile(license, 'Cua driver LICENSE');
  files.push({ dest: `host-core/cua-driver/${key}/LICENSE`, src: license, executable: false });
  return { release: releaseSpec.release, status, files, licensePath: license };
}

async function collectHostRuntimeNatives() {
  const cua = await resolveCuaDriverFiles();
  const searchCache = path.join(CACHE_DIR, 'search-tools');
  const { tools: searchTools } = await prepareSearchTools({ dataRoot: searchCache });
  const searchFiles = [];
  for (const tool of searchTools) {
    for (const src of [tool.path, ...tool.licensePaths]) {
      assertStrictlyRegularFile(src, `search tool file ${src}`);
      searchFiles.push({ dest: toPosixPath(path.relative(searchCache, src)), src, executable: src === tool.path });
    }
  }
  const files = [...cua.files, ...searchFiles];
  let shower = null;
  if (process.platform === 'win32') {
    shower = await resolveShowerWindowsDir();
    for (const name of SHOWER_WINDOWS_FILES) {
      const src = path.join(shower.dir, name);
      assertBinaryHeader(readFileSync(src), 'win32', `Windows Shower ${name}`);
      files.push({ dest: `native/${name}`, src, executable: true });
    }
  }
  return {
    files,
    searchFiles,
    searchTools,
    cua: { release: cua.release, status: cua.status, licensePath: cua.licensePath },
    shower: shower ? { status: shower.status } : null,
  };
}

function hostRuntimeDepsInfo() {
  const pkgPath = path.join(HERE, 'package.json');
  const lockPath = path.join(HERE, 'package-lock.json');
  assertStrictlyRegularFile(pkgPath, 'host-core/package.json');
  assertStrictlyRegularFile(lockPath, 'host-core/package-lock.json');
  const pkgRaw = readFileSync(pkgPath);
  const lockRaw = readFileSync(lockPath);
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw.toString('utf8'));
  } catch (err) {
    throw fail(`host-core/package.json is invalid: ${err.message}`);
  }
  const tarballs = [];
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    const rel = spec.slice('file:'.length);
    const src = path.resolve(HERE, rel);
    assertStrictlyRegularFile(src, `host-core dependency ${name} tarball ${rel}`);
    const dest = path.resolve(HOST_RUNTIME_DEPS_DIR, 'host-core', rel);
    if (!isInsideDir(HOST_RUNTIME_DEPS_DIR, dest)) {
      throw fail(`host-core dependency ${name} file: spec escapes the npm work tree: ${spec}`);
    }
    tarballs.push({ name, src, dest, sha256: sha256OfFile(src) });
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    layout: HOST_RUNTIME_LAYOUT_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pruned: HOST_RUNTIME_PRUNED_SUFFIXES,
  }));
  hash.update('\0package.json\0').update(pkgRaw);
  hash.update('\0package-lock.json\0').update(lockRaw);
  for (const tarball of tarballs) hash.update(`\0${tarball.name}\0${tarball.sha256}`);
  return { key: hash.digest('hex'), pkg, pkgRaw, lockRaw, tarballs };
}

function hostRuntimeDepsComplete(nodeModulesDir, pkg) {
  if (!isRegularFile(path.join(nodeModulesDir, 'npm', 'bin', 'npm-cli.js'))) return false;
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!isRegularFile(path.join(nodeModulesDir, ...name.split('/'), 'package.json'))) return false;
  }
  return true;
}

// Drops .bin shims and type/source-map files; any other symbolic link fails
// (Tauri resources and installers must only carry regular files).
function pruneHostRuntimeModules(nodeModulesDir) {
  let removed = 0;
  const stack = [nodeModulesDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = lstatSync(full);
      if (entry === '.bin') {
        rmSync(full, { recursive: true, force: true });
        continue;
      }
      if (st.isSymbolicLink()) {
        throw fail(`bundled Host node_modules contains a symbolic link: ${toPosixPath(path.relative(nodeModulesDir, full))}`);
      }
      if (st.isDirectory()) {
        // A TypeScript compiler package reads its lib*.d.ts at runtime; never prune it.
        if (entry !== 'typescript') stack.push(full);
        continue;
      }
      if (st.isFile() && HOST_RUNTIME_PRUNED_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

// npm ci --omit=dev for the CURRENT platform in a work tree mirroring the repo
// layout, using the pinned npm from host-core/node_modules (no shell, no PATH npm).
// Install scripts stay disabled, matching the documented host-core install.
async function installHostRuntimeDependencies(deps) {
  rmSync(HOST_RUNTIME_DEPS_DIR, { recursive: true, force: true });
  const workHostCore = path.join(HOST_RUNTIME_DEPS_DIR, 'host-core');
  mkdirSync(workHostCore, { recursive: true });
  writeFileSync(path.join(workHostCore, 'package.json'), deps.pkgRaw);
  writeFileSync(path.join(workHostCore, 'package-lock.json'), deps.lockRaw);
  for (const tarball of deps.tarballs) {
    mkdirSync(path.dirname(tarball.dest), { recursive: true });
    copyFileSync(tarball.src, tarball.dest);
  }
  const npmCli = path.join(HERE, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assertStrictlyRegularFile(npmCli, 'host-core/node_modules/npm/bin/npm-cli.js (run npm --prefix host-core ci first)');
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    // An outer `npm --prefix ... run` exports these; they must not redirect this install.
    if (/^npm_config_(?:prefix|global|location|omit|include|production|dry_run|package_lock_only|ignore_scripts|bin_links)$/i.test(name)) {
      delete env[name];
    }
  }
  await runExec(
    process.execPath,
    [
      npmCli,
      'ci',
      '--prefix',
      workHostCore,
      '--omit=dev',
      '--ignore-scripts',
      '--bin-links=false',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
    ],
    { cwd: workHostCore, env }
  );
  const nodeModules = path.join(workHostCore, 'node_modules');
  if (!hostRuntimeDepsComplete(nodeModules, deps.pkg)) {
    throw fail('npm ci for the bundled Host runtime finished without the expected production dependencies (incl. npm)');
  }
  pruneHostRuntimeModules(nodeModules);
  return nodeModules;
}

function cleanupHostRuntimeTemps() {
  for (const name of readdirSync(DESKTOP_BUILD)) {
    if (/^\.host-runtime(?:-old)?\..+\.tmp$/.test(name)) {
      rmSync(path.join(DESKTOP_BUILD, name), { recursive: true, force: true });
    }
  }
}

function copyStagedFile(stageDir, dest, src, executable) {
  const target = path.join(stageDir, ...dest.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(src, target);
  if (process.platform !== 'win32') chmodSync(target, executable ? 0o755 : 0o644);
}

// Stages desktop/build/host-runtime/. Reuses the previous tree when the content
// key (sources + natives + deps key) matches; reuses the installed node_modules
// when only sources/natives changed; otherwise runs npm ci. The tree is built in
// a sibling temp dir and swapped in, so removed sources never linger.
async function prepareHostRuntime() {
  await mkdir(DESKTOP_BUILD, { recursive: true });
  cleanupHostRuntimeTemps();
  const sources = collectHostRuntimeSources();
  const natives = await collectHostRuntimeNatives();
  const deps = hostRuntimeDepsInfo();

  const content = createHash('sha256');
  content.update(`deps\0${deps.key}`);
  for (const [dest, src] of sources) content.update(`\0src\0${dest}\0${sha256OfFile(src)}`);
  for (const file of natives.files) {
    content.update(`\0native\0${file.dest}\0${file.executable ? 1 : 0}\0${sha256OfFile(file.src)}`);
  }
  const contentKey = content.digest('hex');

  const installedModules = path.join(HOST_RUNTIME_DIR, 'host-core', 'node_modules');
  const rec = readManifest()?.hostRuntime;
  const summary = (status, depsStatus) => ({
    dir: HOST_RUNTIME_DIR,
    status,
    deps: depsStatus,
    sourceFiles: sources.size,
    nativeFiles: natives.files.length,
    searchTools: natives.searchTools,
    cua: natives.cua,
    shower: natives.shower,
  });
  const depsReusable = rec?.depsKey === deps.key && hostRuntimeDepsComplete(installedModules, deps.pkg);
  const searchFilesReusable = natives.searchFiles.every((file) => {
    const staged = path.join(HOST_RUNTIME_DIR, ...file.dest.split('/'));
    return isRegularFile(staged) && sha256OfFile(staged) === sha256OfFile(file.src) &&
      (!file.executable || process.platform === 'win32' || (statSync(staged).mode & 0o111) !== 0);
  });
  if (depsReusable && rec.contentKey === contentKey && searchFilesReusable) {
    return summary('cached', 'cached');
  }

  const stageDir = tempSibling(DESKTOP_BUILD, 'host-runtime');
  let backupDir = null;
  let depsStatus;
  try {
    mkdirSync(stageDir, { recursive: true });
    for (const [dest, src] of sources) copyStagedFile(stageDir, dest, src, false);
    for (const file of natives.files) copyStagedFile(stageDir, file.dest, file.src, file.executable);
    const stagedModules = path.join(stageDir, 'host-core', 'node_modules');
    if (depsReusable) {
      renameSync(installedModules, stagedModules);
      depsStatus = 'reused';
    } else {
      renameSync(await installHostRuntimeDependencies(deps), stagedModules);
      depsStatus = 'installed';
    }
    if (lstatSync(HOST_RUNTIME_DIR, { throwIfNoEntry: false }) !== undefined) {
      backupDir = tempSibling(DESKTOP_BUILD, 'host-runtime-old');
      try {
        renameSync(HOST_RUNTIME_DIR, backupDir);
      } catch (err) {
        backupDir = null;
        throw fail(
          `cannot replace ${HOST_RUNTIME_DIR} (${err.message}); stop any pibot-host / Host process ` +
            'or tauri dev session using it and retry'
        );
      }
    }
    try {
      renameSync(stageDir, HOST_RUNTIME_DIR);
    } catch (err) {
      if (backupDir) {
        try {
          renameSync(backupDir, HOST_RUNTIME_DIR);
          backupDir = null;
        } catch {
          /* restore failed; the stale backup is a regenerable build artifact and is removed below */
        }
      }
      throw fail(`failed to install ${HOST_RUNTIME_DIR}: ${err.message}`);
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    rmSync(HOST_RUNTIME_DEPS_DIR, { recursive: true, force: true });
  }

  const manifest = readManifest() ?? { version: 1 };
  manifest.version = 1;
  manifest.hostRuntime = { layout: HOST_RUNTIME_LAYOUT_VERSION, depsKey: deps.key, contentKey };
  writeManifest(manifest);
  return summary('staged', depsStatus);
}

// Builds desktop/host-launcher (binary pibot-host) in release mode and copies
// it to desktop/build/binaries/pibot-host-<target-triple>[.exe] for Tauri
// externalBin. The executable path comes from cargo's JSON artifact messages, so
// desktop/.cargo/config.toml target-dir or CARGO_TARGET_DIR are honoured.
async function prepareHostLauncher() {
  const spec = currentNodeTarget();
  if (!isRegularFile(HOST_LAUNCHER_CARGO_TOML)) {
    throw fail('desktop/host-launcher/Cargo.toml is missing; the pibot-host launcher crate must be present before packaging');
  }
  const args = [
    'build',
    '--release',
    '--manifest-path',
    HOST_LAUNCHER_CARGO_TOML,
    '--bin',
    HOST_LAUNCHER_BIN,
    '--message-format=json-render-diagnostics',
  ];
  if (isRegularFile(path.join(HOST_LAUNCHER_DIR, 'Cargo.lock'))) args.push('--locked');
  const { stdout } = await runExec('cargo', args, { cwd: HOST_LAUNCHER_DIR });
  let executable = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message.reason === 'compiler-artifact' &&
      message.target?.name === HOST_LAUNCHER_BIN &&
      Array.isArray(message.target?.kind) &&
      message.target.kind.includes('bin') &&
      typeof message.executable === 'string' &&
      message.executable !== ''
    ) {
      executable = message.executable;
    }
  }
  if (!executable) {
    throw fail(`cargo build did not report the ${HOST_LAUNCHER_BIN} executable (check the [[bin]] name in desktop/host-launcher/Cargo.toml)`);
  }
  assertStrictlyRegularFile(executable, `built ${HOST_LAUNCHER_BIN} executable`);
  const buffer = readFileSync(executable);
  assertBinaryHeader(buffer, spec.platform, `${HOST_LAUNCHER_BIN} launcher binary`);
  const sidecarName = `${HOST_LAUNCHER_BIN}-${spec.triple}${spec.platform === 'win32' ? '.exe' : ''}`;
  const sidecarPath = path.join(BINARIES_DIR, sidecarName);
  const binHash = sha256Buffer(buffer);
  let status = 'cached';
  if (!isRegularFile(sidecarPath) || sha256OfFile(sidecarPath) !== binHash) {
    mkdirSync(BINARIES_DIR, { recursive: true });
    const tmpBinary = tempSibling(BINARIES_DIR, sidecarName);
    try {
      writeFileSync(tmpBinary, buffer);
      if (process.platform !== 'win32') chmodSync(tmpBinary, 0o755);
      renameSync(tmpBinary, sidecarPath);
    } finally {
      rmSync(tmpBinary, { force: true });
    }
    status = 'installed';
  }
  return { triple: spec.triple, sidecarPath, sha256: binHash, status };
}

function npmPackageLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const names = pkg.licenses.map((item) => (typeof item === 'string' ? item : item?.type)).filter(Boolean);
    if (names.length > 0) return names.join(' OR ');
  }
  return null;
}

// Every npm package installed in host-runtime/host-core/node_modules (nested
// node_modules included, deduplicated by name@version) plus the Cua driver.
async function collectHostRuntimeLicenseSections(hostRuntimeInfo) {
  const modulesDir = path.join(HOST_RUNTIME_DIR, 'host-core', 'node_modules');
  const packages = new Map();
  const isRealDir = (dir) => {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
  };
  const visitModulesDir = async (dir) => {
    for (const entry of (await readdir(dir)).sort()) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (!isRealDir(full)) continue;
      if (entry.startsWith('@')) {
        for (const child of (await readdir(full)).sort()) {
          const childDir = path.join(full, child);
          if (isRealDir(childDir)) await visitPackage(childDir);
        }
      } else {
        await visitPackage(full);
      }
    }
  };
  const visitPackage = async (pkgDir) => {
    const raw = await readIfPresent(path.join(pkgDir, 'package.json'));
    let pkg = null;
    if (raw) {
      try {
        pkg = JSON.parse(raw.toString('utf8'));
      } catch {
        pkg = null;
      }
      if (pkg && typeof pkg.name === 'string' && pkg.name !== '' && typeof pkg.version === 'string' && pkg.version !== '') {
        const key = `${pkg.name}@${pkg.version}`;
        if (!packages.has(key)) {
          packages.set(key, { root: pkgDir, name: pkg.name, version: pkg.version, license: npmPackageLicense(pkg) });
        }
      }
    }
    // npm's own top-level LICENSE covers the npm application and its bundled
    // dependencies under npm/node_modules.
    if (pkg?.name === 'npm') return;
    const nested = path.join(pkgDir, 'node_modules');
    if (isRealDir(nested)) await visitModulesDir(nested);
  };
  if (!isRealDir(modulesDir)) {
    throw fail(`bundled Host node_modules is missing: ${modulesDir}`);
  }
  await visitModulesDir(modulesDir);

  const sections = ['# Bundled Host runtime (host-runtime/)'];
  const sorted = [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );
  for (const pkg of sorted) {
    const licenseFiles = await findLicenseFiles(pkg.root);
    sections.push(`## npm (host runtime): ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})`);
    if (licenseFiles.length === 0) {
      const upstream = UPSTREAM_LICENSE_ALLOWLIST.get(pkg.name);
      if (upstream && upstream.version === pkg.version && pkg.license === upstream.declared) {
        const upstreamPath = path.join(ROOT, 'licenses', upstream.license);
        const text = await readIfPresent(upstreamPath);
        if (!text) throw fail(`in-repo upstream license missing: ${upstreamPath}`);
        sections.push(text.toString('utf8').trim());
      } else {
        throw fail(`bundled Host runtime npm package ${pkg.name}@${pkg.version} has no license file`);
      }
    } else {
      for (const file of licenseFiles) {
        sections.push((await readFile(file, 'utf8')).trim());
      }
    }
  }
  sections.push(`## Cua driver ${hostRuntimeInfo.cua.release} (MIT)`);
  sections.push((await readFile(hostRuntimeInfo.cua.licensePath, 'utf8')).trim());
  for (const tool of hostRuntimeInfo.searchTools) {
    for (const licensePath of tool.licensePaths) {
      sections.push(`## ${tool.name} ${tool.version}: ${path.basename(licensePath)}`);
      sections.push((await readFile(licensePath, 'utf8')).trim());
    }
  }
  return sections;
}

async function writeThirdPartyNotices(nodeInfo, metafile, hostRuntimeInfo) {
  const npmSections = await collectNpmLicenseSections(metafile);
  const uiSections = await collectUiNpmLicenseSections();
  const cargoSections = await collectCargoLicenseSections();
  const hostRuntimeSections = await collectHostRuntimeLicenseSections(hostRuntimeInfo);
  const launcherCargoSections = await collectCargoLicenseSections({
    cargoToml: HOST_LAUNCHER_CARGO_TOML,
    metadataFile: path.join(METAFILE_DIR, 'host-launcher-cargo-metadata.json'),
  });
  // web/src/gbot-ui adapts lenML/gbot-ui sources (MIT) at source level: it is in
  // neither the npm nor the Cargo graph, so the vendored license text is appended
  // directly from licenses/ (same read mechanism as UPSTREAM_LICENSE_ALLOWLIST).
  const gbotUiLicense = (await readFile(path.join(ROOT, 'licenses', 'gbot-ui-MIT.txt'), 'utf8')).trim();

  const projectNotices = await Promise.all(
    ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/Operit-LGPL-3.0.txt', 'licenses/GPL-3.0.txt']
      .map(async (file) => '## ' + file + '\n\n' + await readFile(path.join(ROOT, file), 'utf8'))
  );
  const blocks = [
    '# Third-Party Notices (pibot Desktop Client)',
    ...projectNotices,
    `## Node.js v${nodeInfo.version} (${nodeInfo.triple})`,
    nodeInfo.licenseText.trim(),
    ...npmSections,
    ...uiSections,
    '## source: lenML/gbot-ui (MIT)',
    gbotUiLicense,
    ...cargoSections,
    ...hostRuntimeSections,
    '# pibot-host launcher (Rust dependencies)',
    ...launcherCargoSections,
  ];
  const content = blocks.join('\n\n---\n\n') + '\n';
  const tmpNotice = tempSibling(DESKTOP_BUILD, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(tmpNotice, content, 'utf8');
  renameSync(tmpNotice, NOTICES_OUTFILE);
  return { noticesPath: NOTICES_OUTFILE, sha256: sha256OfFile(NOTICES_OUTFILE) };
}

export async function prepareDesktop() {
  await mkdir(DESKTOP_BUILD, { recursive: true });
  const nodeInfo = await prepareNodeSidecar();
  const iconsInfo = await prepareIcons();
  if (process.platform === 'win32') {
    const shellIconName = `shell-icon-${sha256OfFile(iconsInfo.icoPath).slice(0, 16)}.ico`;
    for (const name of readdirSync(ICONS_DIR)) {
      if (/^shell-icon-[a-f0-9]{16}\.ico$/.test(name) && name !== shellIconName) {
        rmSync(path.join(ICONS_DIR, name));
      }
    }
    const shellIconPath = path.join(ICONS_DIR, shellIconName);
    if (!isRegularFile(shellIconPath)) writeFileSync(shellIconPath, readFileSync(iconsInfo.icoPath));
    writeFileSync(path.join(ICONS_DIR, 'shell-icon.nsh'), `!define E_LAUNCHER_SHELL_ICON "${shellIconName}"\n`);
  }
  const bundleInfo = await bundleDesktopClient();
  // After bundleDesktopClient: its host-core dependency check guarantees the
  // pinned npm (used for the staged npm ci) and node-tar (Cua prepare) exist.
  const hostRuntimeInfo = await prepareHostRuntime();
  const launcherInfo = await prepareHostLauncher();
  const noticesInfo = await writeThirdPartyNotices(nodeInfo, bundleInfo.metafile, hostRuntimeInfo);
  return {
    done: true,
    outDir: DESKTOP_BUILD,
    node: {
      version: nodeInfo.version,
      triple: nodeInfo.triple,
      status: nodeInfo.status,
      sha256: nodeInfo.binarySha256,
    },
    icons: { status: iconsInfo.status },
    bundle: {
      outfile: path.relative(ROOT, bundleInfo.outfile).replace(/\\/g, '/'),
      sha256: sha256OfFile(bundleInfo.outfile),
    },
    hostRuntime: {
      dir: path.relative(ROOT, hostRuntimeInfo.dir).replace(/\\/g, '/'),
      status: hostRuntimeInfo.status,
      deps: hostRuntimeInfo.deps,
      sourceFiles: hostRuntimeInfo.sourceFiles,
      nativeFiles: hostRuntimeInfo.nativeFiles,
      searchTools: hostRuntimeInfo.searchTools.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      cua: { release: hostRuntimeInfo.cua.release, status: hostRuntimeInfo.cua.status },
      shower: hostRuntimeInfo.shower,
    },
    hostLauncher: {
      sidecar: path.relative(ROOT, launcherInfo.sidecarPath).replace(/\\/g, '/'),
      status: launcherInfo.status,
      sha256: launcherInfo.sha256,
    },
    notices: {
      outfile: path.relative(ROOT, noticesInfo.noticesPath).replace(/\\/g, '/'),
      sha256: noticesInfo.sha256,
    },
  };
}

function resolveBinScript(pkgName, relBin) {
  const candidate = path.join(ROOT, 'node_modules', ...pkgName.split('/'), ...relBin.split('/'));
  if (!isRegularFile(candidate)) {
    throw fail(`required tool ${pkgName} is missing at ${candidate}; run npm ci in repository root first`);
  }
  return candidate;
}

async function buildDesktopWeb() {
  const prepared = await prepareDesktop();
  const tscBin = resolveBinScript('typescript', 'bin/tsc');
  const viteBin = resolveBinScript('vite', 'bin/vite.js');
  const tsconfigPath = path.join(DESKTOP_DIR, 'web', 'tsconfig.json');
  const viteConfigPath = path.join(ROOT, 'vite.desktop.config.ts');

  await spawnNodeScript(tscBin, ['-p', tsconfigPath, '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
  await spawnNodeScript(viteBin, ['build', '--config', viteConfigPath, '--configLoader', 'runner'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return prepared;
}

async function runDesktopDev() {
  await prepareDesktop();
  const viteBin = resolveBinScript('vite', 'bin/vite.js');
  const viteConfigPath = path.join(ROOT, 'vite.desktop.config.ts');
  await spawnNodeScript(
    viteBin,
    ['--config', viteConfigPath, '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '1420', '--strictPort'],
    { cwd: ROOT, stdio: 'inherit' }
  );
}

const USAGE =
  'usage: node host-core/build-desktop.js [--web | --dev]\n' +
  '\n' +
  'options:\n' +
  '  --web       prepare desktop assets, typecheck, and build desktop/web into desktop/build/web\n' +
  '  --dev       prepare desktop assets and start Vite dev server on http://127.0.0.1:1420\n' +
  '  -h, --help  show this help\n';

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        web: { type: 'boolean' },
        dev: { type: 'boolean' },
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
  if (values.web && values.dev) {
    throw invalid('choose at most one of --web and --dev');
  }
  if (values.web) {
    await buildDesktopWeb();
    return;
  }
  if (values.dev) {
    await runDesktopDev();
    return;
  }
  const summary = await prepareDesktop();
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
