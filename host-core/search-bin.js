import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Pinned upstream versions of the bundled search binaries. */
const SEARCH_TOOLS = {
  rg: {
    version: '15.1.0',
    repo: 'BurntSushi/ripgrep',
    tag: '15.1.0',
    rootPrefix: 'ripgrep-15.1.0-',
  },
  fd: {
    version: '10.3.0',
    repo: 'sharkdp/fd',
    tag: 'v10.3.0',
    rootPrefix: 'fd-v10.3.0-',
  },
};

export const SEARCH_TOOL_VERSIONS = {
  rg: SEARCH_TOOLS.rg.version,
  fd: SEARCH_TOOLS.fd.version,
};

// Release triples: x64 => x86_64, arm64 => aarch64; win32/linux only.
const TRIPLES = {
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
};

/**
 * Asset metadata of the pinned release for a search tool on one platform/arch.
 * Only win32/linux and x64/arm64 are supported.
 */
export function getSearchToolAsset(name, platform = process.platform, arch = process.arch) {
  assertToolName(name);
  const triple = requireTriple(platform, arch);
  const tool = SEARCH_TOOLS[name];
  const binary = binaryName(name, platform);
  const root = `${tool.rootPrefix}${triple}`;
  const archiveName = platform === 'win32' ? `${root}.zip` : `${root}.tar.gz`;
  return {
    version: tool.version,
    url: `https://github.com/${tool.repo}/releases/download/${tool.tag}/${archiveName}`,
    archiveName,
    entryPath: `${root}/${binary}`,
    binaryName: binary,
    licenseEntry: `${root}/LICENSE-MIT`,
  };
}

/** Installed location of the pinned version: <dataRoot>/tools/<platform>-<arch>/<name>-<version>/<binary>. */
export function getSearchToolInstallPath(dataRoot, name, platform = process.platform, arch = process.arch) {
  assertToolName(name);
  assertDataRoot(dataRoot);
  requireTriple(platform, arch);
  return path.join(dataRoot, 'tools', `${platform}-${arch}`, `${name}-${SEARCH_TOOL_VERSIONS[name]}`, binaryName(name, platform));
}

/**
 * Resolve a search binary, in order: an explicit toolPaths entry, the pinned
 * install path, the Pi agent bin directory, then PATH. Returns the absolute
 * path of an existing executable file, or throws.
 */
export function resolveSearchBinary(name, { dataRoot, toolPaths } = {}) {
  assertToolName(name);
  const platform = process.platform;
  const arch = process.arch;

  const explicit = toolPaths?.[name];
  if (explicit !== undefined) {
    // null 是显式给出的非法值，报 INVALID_ARGUMENT，不当作未指定而回退。
    return resolveExplicit(name, explicit, platform);
  }

  if (isSupported(platform, arch) && typeof dataRoot === 'string' && dataRoot !== '') {
    const installed = getSearchToolInstallPath(dataRoot, name, platform, arch);
    if (isExecutableFile(installed, platform)) return installed;
  }

  for (const dir of piBinDirs()) {
    const candidate = path.join(dir, binaryName(name, platform));
    if (isExecutableFile(candidate, platform)) return candidate;
  }

  const found = findOnPath(name, platform);
  if (found !== undefined) return found;

  throw unavailable(name);
}

function resolveExplicit(name, value, platform) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidArgument(`toolPaths.${name} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw invalidArgument(`toolPaths.${name} must be an absolute path`);
  }
  if (!isExecutableFile(value, platform)) {
    throw toolUnavailable(`configured ${name} binary is not an executable file: ${value}`);
  }
  return value;
}

function findOnPath(name, platform) {
  const programNames = [binaryName(name, platform)];
  // fd is packaged as fdfind on Debian/Ubuntu.
  if (name === 'fd' && platform === 'linux') programNames.push('fdfind');
  const pathEnv = process.env.PATH ?? '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (entry === '') continue;
    const dir = path.resolve(entry);
    for (const program of programNames) {
      const candidate = path.join(dir, program);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

function piBinDirs() {
  const dirs = [];
  const agentDir = process.env.PI_AGENT_DIR;
  if (typeof agentDir === 'string' && agentDir.trim() !== '') {
    // PI_AGENT_DIR 可能是相对路径，path.resolve 保证返回绝对路径。
    dirs.push(path.resolve(agentDir, 'bin'));
  }
  dirs.push(path.join(os.homedir(), '.pi', 'agent', 'bin'));
  return dirs;
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
  return TRIPLES[platform]?.[arch] !== undefined;
}

function requireTriple(platform, arch) {
  const triple = TRIPLES[platform]?.[arch];
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

function toolUnavailable(message) {
  const err = new Error(message);
  err.code = 'TOOL_UNAVAILABLE';
  return err;
}

function unavailable(name) {
  return toolUnavailable(
    `${name} binary not found. Run the explicit prepare-tools command to install it, or configure toolPaths.${name}.`
  );
}
