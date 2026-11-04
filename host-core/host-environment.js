// host-core/host-environment.js
import { statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isBashName(file) {
  const name = basename(file).toLowerCase();
  if (name === 'bash' || name === 'bash.exe') return true;
  // Android 系统 sh：仅精确 /system/bin/sh，不接受任意 sh.exe。
  return process.platform === 'android' && file === '/system/bin/sh';
}

function defaultBashCandidates() {
  if (process.platform === 'android') {
    return ['/system/bin/sh'];
  }
  if (process.platform === 'win32') {
    const candidates = [];
    for (const dir of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (!dir) continue;
      candidates.push(join(dir, 'Git', 'bin', 'bash.exe'));
      candidates.push(join(dir, 'Git', 'usr', 'bin', 'bash.exe'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    }
    return candidates;
  }
  return ['/bin/bash', '/usr/bin/bash'];
}

function resolveBash(bashPath) {
  const candidates = bashPath === undefined ? defaultBashCandidates() : [bashPath];
  for (const candidate of candidates) {
    let stats;
    try {
      stats = statSync(candidate, { throwIfNoEntry: false });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error; // 其他 I/O 错误不吞
    }
    if (stats === undefined) continue;
    if (stats.isDirectory()) {
      if (bashPath !== undefined) {
        throw errWithCode(`bashPath is a directory: ${bashPath}`, 'INVALID_ARGUMENT');
      }
      continue;
    }
    return candidate;
  }
  const message = process.platform === 'android'
    ? 'shell unavailable: no /system/bin/sh found'
    : process.platform === 'win32'
      ? 'bash unavailable: no Git Bash found in known Git install locations'
      : 'bash unavailable: no bash found in /bin or /usr/bin';
  throw errWithCode(message, 'BASH_UNAVAILABLE');
}

/**
 * NodeExecutionEnv-based host execution environment.
 *
 * Command strings run through the selected shell (Git Bash on Windows, bash on
 * Linux, /system/bin/sh on Android): `bash --noprofile --norc -c <command>`
 * when the selected executable is bash, `-c <command>` alone for /system/bin/sh.
 * The native shell discovery is not used because it searches PATH and does not
 * pass the profile flags. Anything
 * else -- argv arrays, file operations, id, cancellation, output, cleanup --
 * is delegated untouched to NodeExecutionEnv.
 */
class HostExecutionEnv extends NodeExecutionEnv {
  constructor({ cwd, bashPath }) {
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw errWithCode('cwd must be a non-empty string', 'INVALID_ARGUMENT');
    }
    if (bashPath !== undefined) {
      if (typeof bashPath !== 'string' || bashPath.length === 0 || !isAbsolute(bashPath) || !isBashName(bashPath)) {
        throw errWithCode('bashPath must be an absolute path to bash or bash.exe', 'INVALID_ARGUMENT');
      }
    }
    super({ cwd });
    this._bashPath = bashPath;
    this._bash = undefined;
  }

  async exec(command, options, context) {
    if (typeof command === 'string') {
      // bash 仅在真正执行命令字符串时定位，缺 bash 不影响 read/write 等文件工具。
      if (this._bash === undefined) {
        this._bash = resolveBash(this._bashPath);
      }
      // --noprofile/--norc 是 bash 专用参数；按实际选中可执行文件选择：/system/bin/sh 只用 -c，显式 bash 仍带 profile 标志。
      command = this._bash === '/system/bin/sh'
        ? [this._bash, '-c', command]
        : [this._bash, '--noprofile', '--norc', '-c', command];
    }
    return super.exec(command, options, context);
  }
}

export function createHostExecutionEnv(options = {}) {
  return new HostExecutionEnv(options);
}
