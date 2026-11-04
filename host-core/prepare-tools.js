// host-core/prepare-tools.js
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getSearchToolAsset, getSearchToolInstallPath } from './search-bin.js';

/**
 * 搜索工具准备：仅在显式运行 prepareSearchTools / CLI 时下载固定版本 rg/fd，
 * 模型工具不触发下载。固定 asset 规格与安装路径复用 search-bin.js，不查询 latest。
 */
const SEARCH_TOOL_NAMES = ['rg', 'fd'];
const LICENSE_FILE_NAME = 'LICENSE-MIT';
// curl 固定参数：--fail --location --connect-timeout 20 --max-time 120 --max-filesize 67108864
const CURL_FLAGS = ['--silent', '--show-error', '--fail', '--location', '--connect-timeout', '20', '--max-time', '120', '--max-filesize', '67108864'];
const MAX_EXTRACT_OUTPUT_BYTES = 32 * 1024 * 1024;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function prepareFailed(message) {
  return Object.assign(new Error(message), { code: 'TOOL_PREPARE_FAILED' });
}

function isRegularFile(filePath) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile();
}

function curlCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot) {
      const candidate = path.join(systemRoot, 'System32', 'curl.exe');
      if (isRegularFile(candidate)) return candidate;
    }
  }
  return 'curl';
}

function tarCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw prepareFailed('SystemRoot is not set; cannot locate System32/tar.exe');
    const candidate = path.join(systemRoot, 'System32', 'tar.exe');
    if (!isRegularFile(candidate)) throw prepareFailed('System32/tar.exe not found; PowerShell fallback is not supported');
    return candidate;
  }
  return 'tar';
}

const execFileAsync = promisify(execFile);

async function runExec(command, args, options) {
  try {
    const result = await execFileAsync(command, args, options);
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw prepareFailed(command + ' output exceeded ' + MAX_EXTRACT_OUTPUT_BYTES + ' bytes');
    }
    if (typeof err.code === 'number') {
      const detail = String(err.stderr ?? '').trim();
      throw prepareFailed(command + ' exited with code ' + err.code + ': ' + detail);
    }
    throw prepareFailed(command + ' failed to start: ' + err.message);
  }
}

async function downloadArchive(url, archivePath) {
  // execFile 继承环境变量，curl 原生读取标准 http_proxy/https_proxy/no_proxy。
  await runExec(curlCommand(), [...CURL_FLAGS, '--output', archivePath, url], {
    maxBuffer: MAX_EXTRACT_OUTPUT_BYTES,
  });
}

// 只取指定 entry 到 stdout，不把归档解压到磁盘。
async function extractEntry(archivePath, entryPath) {
  const result = await runExec(tarCommand(), ['-xOf', archivePath, entryPath], {
    maxBuffer: MAX_EXTRACT_OUTPUT_BYTES,
    // execFile 默认 utf8；显式 'buffer' 让 stdout 返回 Buffer，供 assertBinaryHeader 按字节比对。
    encoding: 'buffer',
  });
  return result.stdout;
}

function assertBinaryHeader(buffer, platform, name) {
  if (platform === 'win32') {
    if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      throw prepareFailed(name + ' binary is not a Windows PE executable (MZ header missing)');
    }
    return;
  }
  if (buffer.length < 4 || buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw prepareFailed(name + ' binary is not an ELF executable');
  }
}

function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function tempSibling(dir, base) {
  return path.join(dir, '.' + base + '.' + randomBytes(4).toString('hex') + '.tmp');
}

/** 安装单个搜索工具；binary 与 LICENSE-MIT 均已存在时直接返回现成结果，不运行二进制自检。 */
async function installTool(dataRoot, name) {
  const asset = getSearchToolAsset(name);
  const installPath = getSearchToolInstallPath(dataRoot, name);
  const installDir = path.dirname(installPath);
  const licensePath = path.join(installDir, LICENSE_FILE_NAME);

  if (isRegularFile(installPath) && isRegularFile(licensePath)) {
    return { name, version: asset.version, path: installPath, sha256: sha256OfFile(installPath) };
  }

  mkdirSync(installDir, { recursive: true });

  // 下载归档放系统 tmp；最终写入用同目录临时文件 + rename，原子替换且失败保留旧文件。
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'prepare-tools-'));
  const tempPaths = [];
  try {
    const archivePath = path.join(tmpRoot, asset.archiveName);
    await downloadArchive(asset.url, archivePath);

    const licenseBuffer = await extractEntry(archivePath, asset.licenseEntry);
    if (licenseBuffer.length === 0) throw prepareFailed('empty ' + LICENSE_FILE_NAME + ' extracted for ' + name);

    const binaryBuffer = await extractEntry(archivePath, asset.entryPath);
    assertBinaryHeader(binaryBuffer, process.platform, name);

    // 先写许可证再写 binary：缺 binary 的目录不会被当成完成安装。
    const tmpLicense = tempSibling(installDir, name + '.LICENSE-MIT');
    writeFileSync(tmpLicense, licenseBuffer);
    tempPaths.push(tmpLicense);
    renameSync(tmpLicense, licensePath);

    const tmpBinary = tempSibling(installDir, name);
    writeFileSync(tmpBinary, binaryBuffer);
    // POSIX 先 chmod 755 再 rename：即使进程在 rename 后崩溃，已公布的 binary 也具备执行权限。
    if (process.platform !== 'win32') chmodSync(tmpBinary, 0o755);
    tempPaths.push(tmpBinary);
    renameSync(tmpBinary, installPath);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const p of tempPaths) rmSync(p, { force: true });
  }

  return { name, version: asset.version, path: installPath, sha256: sha256OfFile(installPath) };
}

/** 准备 rg/fd 固定版本到 dataRoot 下（仅当前平台），返回安装结果。 */
export async function prepareSearchTools({ dataRoot } = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw invalid('dataRoot must be a non-empty string');
  }
  if (!path.isAbsolute(dataRoot)) throw invalid('dataRoot must be an absolute path');
  const tools = [];
  for (const name of SEARCH_TOOL_NAMES) {
    tools.push(await installTool(dataRoot, name));
  }
  return { tools };
}

const USAGE = 'usage: node host-core/prepare-tools.js --data-root <dir>\n' +
  '\n' +
  'options:\n' +
  '  --data-root <dir>   verified absolute data directory (required, except --help)\n' +
  '  -h, --help          show this help\n';

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        'data-root': { type: 'string' },
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
  if (values['data-root'] === undefined) {
    throw invalid('missing required option --data-root');
  }
  const result = await prepareSearchTools({ dataRoot: values['data-root'] });
  process.stdout.write(JSON.stringify(result) + '\n');
}

// 仅被直接运行（node host-core/prepare-tools.js）时解析 CLI；被 import 时不解析、不写 stderr/exitCode、不下载。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
