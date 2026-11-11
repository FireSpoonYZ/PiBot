import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned upstream versions and release archive SHA-256 digests. */
const SEARCH_TOOLS = {
  rg: {
    version: '15.1.0',
    repo: 'BurntSushi/ripgrep',
    tagPrefix: '',
    prefix: 'ripgrep-',
    licenses: ['LICENSE-MIT', 'UNLICENSE', 'COPYING'],
    // https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0 (.sha256 assets)
    sha256: {
      'win32-x64': '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a',
      'linux-x64': '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599',
      'darwin-arm64': '378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715',
    },
  },
  fd: {
    version: '10.3.0',
    repo: 'sharkdp/fd',
    tagPrefix: 'v',
    prefix: 'fd-v',
    licenses: ['LICENSE-MIT', 'LICENSE-APACHE'],
    // https://api.github.com/repos/sharkdp/fd/releases/tags/v10.3.0 (asset digests)
    sha256: {
      'win32-x64': '318aa2a6fa664325933e81fda60d523fff29444129e91ebf0726b5b3bcd8b059',
      'linux-x64': '2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14',
      'darwin-arm64': '0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904',
    },
  },
};

export const SEARCH_TOOL_VERSIONS = {
  rg: SEARCH_TOOLS.rg.version,
  fd: SEARCH_TOOLS.fd.version,
};

const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'darwin-arm64': 'aarch64-apple-darwin',
};

/** Asset metadata for the pinned Windows/Linux x64 or macOS arm64 release. */
export function getSearchToolAsset(name, platform = process.platform, arch = process.arch) {
  assertToolName(name);
  const triple = requireTriple(platform, arch);
  const tool = SEARCH_TOOLS[name];
  const binary = binaryName(name, platform);
  const root = `${tool.prefix}${tool.version}-${triple}`;
  const archiveName = platform === 'win32' ? `${root}.zip` : `${root}.tar.gz`;
  return {
    version: tool.version,
    url: `https://github.com/${tool.repo}/releases/download/${tool.tagPrefix}${tool.version}/${archiveName}`,
    archiveName,
    sha256: tool.sha256[`${platform}-${arch}`],
    entryPath: `${root}/${binary}`,
    binaryName: binary,
    licenseEntry: `${root}/LICENSE-MIT`,
    licenseEntries: tool.licenses.map((license) => `${root}/${license}`),
  };
}

/** Pinned location: <root>/tools/<platform>-<arch>/<name>-<version>/<binary>. */
export function getSearchToolInstallPath(dataRoot, name, platform = process.platform, arch = process.arch) {
  assertToolName(name);
  assertDataRoot(dataRoot);
  requireTriple(platform, arch);
  return path.join(dataRoot, 'tools', `${platform}-${arch}`, `${name}-${SEARCH_TOOL_VERSIONS[name]}`, binaryName(name, platform));
}

/** Resolve only product-bundled binaries, never user configuration or PATH. */
export function resolveSearchBinary(name) {
  assertToolName(name);
  const platform = process.platform;
  const arch = process.arch;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let candidate;
  if (platform === 'android') {
    // Android bundles this module into bot-host/runtime/<payloadSha>/host-runtime.mjs.
    candidate = path.resolve(moduleDir, '..', '..', 'bin', name);
  } else if (isSupported(platform, arch)) {
    candidate = getSearchToolInstallPath(path.resolve(moduleDir, '..'), name, platform, arch);
  }
  if (candidate && isExecutableFile(candidate, platform)) return candidate;
  throw unavailable(name);
}

/** Existing executable file? ENOENT/ENOTDIR count as missing; other errors propagate. */
function isExecutableFile(filePath, platform) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw err;
  }
  if (!stat.isFile()) return false;
  if (platform === 'win32') {
    return filePath.toLowerCase().endsWith('.exe');
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'EACCES') return false;
    throw err;
  }
}

function binaryName(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

function isSupported(platform, arch) {
  return TRIPLES[`${platform}-${arch}`] !== undefined;
}

function requireTriple(platform, arch) {
  const triple = TRIPLES[`${platform}-${arch}`];
  if (triple === undefined) {
    throw invalidArgument(`unsupported platform/arch: ${platform}/${arch}`);
  }
  return triple;
}

function assertToolName(name) {
  if (name !== 'rg' && name !== 'fd') {
    throw invalidArgument(`unknown search tool: ${name}`);
  }
}

function assertDataRoot(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot === '') {
    throw invalidArgument('dataRoot must be a non-empty string');
  }
  if (!path.isAbsolute(dataRoot)) {
    throw invalidArgument('dataRoot must be an absolute path');
  }
}

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function unavailable(name) {
  const err = new Error(`bundled ${name} binary is missing or not executable`);
  err.code = 'TOOL_UNAVAILABLE';
  return err;
}
