// host-core/cua-driver.js
// Locates the built-in Cua driver (cua-driver-rs) executable for the Host.
// The Linux/Windows Shower backends spawn it with ['mcp', '--direct'] inside
// the private graphical session they already own; this module only resolves
// the on-disk binary. It never consults PATH, never installs or downloads
// anything, and never targets the primary desktop — the session owner decides
// which display/desktop the driver attaches to.
//
// Resolution order (first hit wins):
//   1. E_LAUNCHER_CUA_DRIVER: absolute path to an existing cua-driver binary,
//      set only by a trusted operator/deployment. Not a model/client input.
//   2. The prepared Host resource directory host-core/cua-driver/<platform>/
//      next to this module, produced by host-core/build-cua-driver.js and
//      git-ignored. Deployments that copy host-core only need to bring that
//      directory (or point the env var at an installed driver).
// Missing files or an unsupported platform/arch throw an Error with code
// SHOWER_UNAVAILABLE naming the prepare command.
//
// The module also serves the one-shot tool inventory the Host needs at startup:
// the pinned driver binary answers the read-only CLI metadata commands
// 'list-tools' (one 'name: one-line summary' per line) and 'describe <name>'
// ('name: NAME' / blank / 'description:' / full text / blank / 'input_schema:' /
// JSON) without a graphical session — same source as the session driver's
// MCP tools/list. loadCuaToolInventory() execFiles the resolved binary with
// DO_NOT_TRACK=1, bounded output and a timeout; it never runs installer,
// update, autostart or 'mcp' commands, never scans PATH, and never touches a
// display or Shower session. Names, descriptions and schemas are used as-is;
// nothing is whitelisted or dropped.
import { execFile } from 'node:child_process';
import { accessSync, constants, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { messageError } from './message-protocol.js';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_ENV = 'E_LAUNCHER_CUA_DRIVER';

function targetKey() {
  const key = process.platform + '-' + process.arch;
  if (key !== 'win32-x64' && key !== 'linux-x64') {
    throw messageError(
      'SHOWER_UNAVAILABLE',
      'Cua driver 只提供 Windows/Linux x64；当前平台 ' + key + ' 不支持',
    );
  }
  return key;
}

function driverName() {
  return process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
}

function isRegularFile(filePath) {
  const stats = lstatSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile() && !stats.isSymbolicLink();
}

function unavailable(detail) {
  throw messageError(
    'SHOWER_UNAVAILABLE',
    '缺少 Cua driver（' + targetKey() + '）。' + detail +
      '；运行 node host-core/build-cua-driver.js 准备本机资源，' +
      '或把 ' + DRIVER_ENV + ' 设为已安装 cua-driver 可执行文件的绝对路径',
  );
}

/**
 * Synchronous absolute path to an existing cua-driver executable for the
 * current platform. Throws code SHOWER_UNAVAILABLE when absent, pointing the
 * operator at the prepare command. Callers (Shower backends) must treat the
 * result as read-only and spawn it only inside their owned private session.
 */
export function resolveCuaDriverPath() {
  const key = targetKey();
  const override = process.env[DRIVER_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      throw messageError(
        'SHOWER_UNAVAILABLE',
        DRIVER_ENV + ' 必须是绝对路径: ' + override,
      );
    }
    const resolved = path.normalize(override);
    if (!isRegularFile(resolved)) {
      throw messageError(
        'SHOWER_UNAVAILABLE',
        DRIVER_ENV + ' 指向的可执行文件不存在: ' + resolved,
      );
    }
    if (process.platform !== 'win32') {
      try {
        accessSync(resolved, constants.X_OK);
      } catch {
        throw messageError(
          'SHOWER_UNAVAILABLE',
          DRIVER_ENV + ' 指向的文件不可执行: ' + resolved,
        );
      }
    }
    return resolved;
  }

  const candidate = path.join(HERE, 'cua-driver', key, driverName());
  if (isRegularFile(candidate)) {
    const resolved = path.resolve(candidate);
    if (process.platform !== 'win32') {
      try {
        accessSync(resolved, constants.X_OK);
      } catch {
        unavailable('文件存在但不可执行: ' + resolved);
      }
    }
    return resolved;
  }
  unavailable('期望位置 ' + candidate);
}

// ---- Read-only CLI metadata inventory (fixed driver, no graphics session) ----

const METADATA_TIMEOUT_MS = 15_000;
const METADATA_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const METADATA_CONCURRENCY = 4;
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DESCRIBE_SCHEMA_MARKER = '\ninput_schema:\n';

function metadataError(detail) {
  return messageError(
    'SHOWER_UNAVAILABLE',
    'Cua driver metadata 不可用（' + targetKey() + '）：' + detail +
      '；运行 node host-core/build-cua-driver.js 重新准备本机资源',
  );
}

/** One bounded read-only metadata call against the resolved driver binary. */
async function runMetadata(driverPath, args) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(driverPath, args, {
      env: { ...process.env, DO_NOT_TRACK: '1' },
      windowsHide: true,
      timeout: METADATA_TIMEOUT_MS,
      maxBuffer: METADATA_MAX_BUFFER_BYTES,
      killSignal: 'SIGKILL',
    }));
  } catch (error) {
    throw metadataError(args[0] + ' 执行失败: ' + String(error?.message ?? error).slice(0, 300));
  }
  return stdout;
}

/**
 * Parse describe output: 'name: NAME' header, 'description:' body up to the
 * 'input_schema:' marker, then the JSON schema. Anything else is invalid.
 */
function parseDescribeOutput(name, stdout) {
  const marker = stdout.indexOf(DESCRIBE_SCHEMA_MARKER);
  if (marker < 0) throw metadataError('describe ' + name + ' 缺少 input_schema 段');
  const head = stdout.slice(0, marker);
  const schemaText = stdout.slice(marker + DESCRIBE_SCHEMA_MARKER.length).trim();
  const header = 'name: ' + name + '\n\ndescription:\n';
  if (!head.startsWith(header)) {
    throw metadataError('describe ' + name + ' 输出头不合法');
  }
  const description = head.slice(header.length);
  let inputSchema;
  try {
    inputSchema = JSON.parse(schemaText);
  } catch {
    throw metadataError('describe ' + name + ' 的 input_schema 不是合法 JSON');
  }
  if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)
      || inputSchema.type !== 'object') {
    throw metadataError('describe ' + name + ' 的 input_schema 不是 object schema');
  }
  return { name, description, inputSchema };
}

let inventoryPromise = null;

/**
 * Async one-shot inventory of every tool the pinned driver exposes, resolved
 * through the same path rules as session backends. Fails loudly on a missing
 * resource or malformed metadata — callers must not fall back to a wrapper.
 * The result is cached per Host process; a failed load is not cached so a
 * prepared resource can be picked up by a retry.
 */
export function loadCuaToolInventory() {
  if (!inventoryPromise) {
    inventoryPromise = (async () => {
      const driverPath = resolveCuaDriverPath();
      const list = await runMetadata(driverPath, ['list-tools']);
      const names = [];
      const seen = new Set();
      for (const line of list.split(/\r?\n/)) {
        const trimmed = line.trimEnd();
        if (trimmed === '') continue;
        const colon = trimmed.indexOf(':');
        if (colon < 1) throw metadataError('list-tools 行缺少 name 前缀: ' + trimmed.slice(0, 120));
        const name = trimmed.slice(0, colon);
        if (!NAME_PATTERN.test(name) || seen.has(name)) {
          throw metadataError('list-tools 返回了不合法或重复的工具名: ' + name.slice(0, 120));
        }
        seen.add(name);
        names.push(name);
      }
      if (names.length === 0) {
        throw metadataError('list-tools 返回了空清单');
      }
      const inventory = new Array(names.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < names.length) {
          const index = cursor;
          cursor += 1;
          const described = await runMetadata(driverPath, ['describe', names[index]]);
          inventory[index] = parseDescribeOutput(names[index], described);
        }
      };
      await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, names.length) }, () => worker()));
      return Object.freeze(inventory);
    })();
    // 失败不留缓存：资源补齐后同一进程重试可成功。
    inventoryPromise.catch(() => { inventoryPromise = null; });
  }
  return inventoryPromise;
}
