import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { browserError } from './desktop-policy.js';

const MAX_ENDPOINT_BYTES = 512;
const unsafe = () => browserError('BROWSER_UNSAFE_ENDPOINT', 'Cannot verify the private Chromium DevTools endpoint.');

// Inspect every ancestor: realpath alone would silently follow a profile junction.
export async function assertPrivateWindowsProfileDir(directory) {
  let current = directory;
  for (;;) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe();
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolved = await realpath(directory);
  if (resolved.toLowerCase() !== path.resolve(directory).toLowerCase()) throw unsafe();
}

export async function readWindowsDevToolsEndpoint(profilePath) {
  const filename = path.join(profilePath, 'DevToolsActivePort');
  await assertPrivateWindowsProfileDir(profilePath);
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_ENDPOINT_BYTES) throw unsafe();
  let handle;
  try { handle = await open(filename, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw unsafe();
    if (opened.dev !== info.dev || opened.ino !== info.ino) return null;
    const bytes = Buffer.alloc(MAX_ENDPOINT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await lstat(filename);
    await assertPrivateWindowsProfileDir(profilePath);
    if (after.isSymbolicLink() || after.nlink !== 1 || bytesRead > MAX_ENDPOINT_BYTES) throw unsafe();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return null;
    const contents = bytes.subarray(0, bytesRead).toString('utf8');
    const match = /^([1-9][0-9]{0,4})\r?\n(\/devtools\/browser\/[A-Za-z0-9_-]+)\r?\n?$/.exec(contents);
    if (!match || Number(match[1]) > 65535) return null; // Chromium may still be writing.
    return { url: `ws://127.0.0.1:${match[1]}${match[2]}`, contents, mtimeMs: opened.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle.close();
  }
}

// Windows command-line quoting, including escaped quotes, must not turn a nonce
// embedded inside another argument into an apparent standalone switch.
export function windowsCommandLineArgs(commandLine) {
  const args = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (char === '\\') {
      let count = 1;
      while (commandLine[i + 1] === '\\') { count++; i++; }
      if (commandLine[i + 1] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        i++;
        if (count % 2) value += '"';
        else quoted = !quoted;
      } else value += '\\'.repeat(count);
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) args.push(value);
      value = ''; started = false;
    } else { value += char; started = true; }
  }
  if (quoted) throw unsafe();
  if (started) args.push(value);
  return args;
}

async function readWindowsDevToolsProcess({ url, signal, timeoutMs }) {
  const port = Number(new URL(url).port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw unsafe();
  // Only the validated numeric port enters the script. No browser/profile paths
  // or command-line values are evaluated by PowerShell.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen
$owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1) { exit 2 }
Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [uint32]$owners[0]) | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const queryEnv = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: path.win32.join(systemRoot, 'System32'),
    PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  };
  const stdout = await new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: Math.max(1, timeoutMs), signal, maxBuffer: 64 * 1024, encoding: 'utf8', env: queryEnv,
    }, (error, output) => error ? reject(unsafe()) : resolve(output));
  });
  let owner;
  try { owner = JSON.parse(stdout.replace(/^\uFEFF/, '')); } catch { throw unsafe(); }
  if (typeof owner?.ExecutablePath !== 'string' || typeof owner?.CommandLine !== 'string') throw unsafe();
  return owner;
}

function normalizeWindowsPath(value) {
  return path.win32.normalize(value).toLowerCase();
}

export async function verifyWindowsDevToolsOwner({ url, executablePath, nonce, signal, timeoutMs }) {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw unsafe();
  const owner = await readWindowsDevToolsProcess({ url, signal, timeoutMs });
  if (normalizeWindowsPath(owner.ExecutablePath) !== normalizeWindowsPath(executablePath)
      || !windowsCommandLineArgs(owner.CommandLine).includes(`--pibot-launch-nonce=${nonce}`)) throw unsafe();
}

export async function isWindowsDevToolsProfileInUse({ url, executablePath, profilePath, nonce, signal, timeoutMs }) {
  try {
    const owner = await readWindowsDevToolsProcess({ url, signal, timeoutMs });
    if (normalizeWindowsPath(owner.ExecutablePath) !== normalizeWindowsPath(executablePath)) return false;
    const args = windowsCommandLineArgs(owner.CommandLine);
    const profileArgs = args.filter(arg => arg.startsWith('--user-data-dir='));
    return profileArgs.length === 1 &&
      normalizeWindowsPath(profileArgs[0].slice('--user-data-dir='.length)) === normalizeWindowsPath(profilePath) &&
      !args.includes(`--pibot-launch-nonce=${nonce}`);
  } catch {
    // An inconclusive ownership check leaves the regular startup wait in place.
    return false;
  }
}
