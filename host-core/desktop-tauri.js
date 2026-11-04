#!/usr/bin/env node
// host-core/desktop-tauri.js: fixed Node entry for Tauri CLI (dev / build / icon).
// Always runs with explicit argv and cwd=desktop (shell=false). For dev/build,
// runs desktop resource preparation first so icons, sidecar binary, bundled
// client script and third-party notices exist before Cargo/tauri-build runs.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareDesktop } from './build-desktop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const TAURI_CLI_VERSION = '2.12.4';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function fail(message) {
  return Object.assign(new Error(message), { code: 'DESKTOP_TAURI_FAILED' });
}

function isRegularFile(filePath) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile();
}

export function resolveTauriCliEntry(rootDir = ROOT) {
  const pkgPath = path.join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'package.json');
  if (!isRegularFile(pkgPath)) {
    throw fail(`@tauri-apps/cli is not installed at ${pkgPath}; run npm ci in repository root first`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    throw fail(`@tauri-apps/cli package.json is invalid: ${err.message}`);
  }
  if (pkg.name !== '@tauri-apps/cli' || pkg.version !== TAURI_CLI_VERSION) {
    throw fail(`@tauri-apps/cli version ${pkg.version ?? 'unknown'} does not match pinned ${TAURI_CLI_VERSION}`);
  }
  const pkgDir = path.dirname(pkgPath);
  const binField = typeof pkg.bin === 'string'
    ? pkg.bin
    : (pkg.bin?.tauri ?? Object.values(pkg.bin ?? {})[0]);
  if (typeof binField === 'string' && binField !== '') {
    const candidate = path.resolve(pkgDir, binField);
    if (isRegularFile(candidate)) return candidate;
  }
  for (const fallback of ['tauri.js', 'bin/tauri.js', 'index.js']) {
    const candidate = path.join(pkgDir, fallback);
    if (isRegularFile(candidate)) return candidate;
  }
  const req = createRequire(pathToFileURL(pkgPath).href);
  const resolved = req.resolve('@tauri-apps/cli');
  if (!isRegularFile(resolved)) {
    throw fail(`cannot resolve @tauri-apps/cli entry from ${pkgPath}`);
  }
  return resolved;
}

export function spawnNodeScript(scriptPath, args = [], options = {}) {
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) {
    throw invalid('scriptPath must be an absolute path');
  }
  const cwd = options.cwd ?? DESKTOP_DIR;
  if (!existsSync(cwd)) {
    throw fail(`working directory does not exist: ${cwd}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      shell: false,
      windowsHide: true,
    });
    const onSigint = () => { try { child.kill('SIGINT'); } catch {} };
    const onSigterm = () => { try { child.kill('SIGTERM'); } catch {} };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const cleanup = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
    child.on('error', (err) => {
      cleanup();
      reject(fail(`failed to start ${path.basename(scriptPath)}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (code === 0) {
        resolve({ code: 0, signal: null });
        return;
      }
      if (signal) {
        reject(fail(`${path.basename(scriptPath)} terminated by signal ${signal}`));
        return;
      }
      reject(fail(`${path.basename(scriptPath)} exited with code ${code ?? 1}`));
    });
  });
}

export async function runDesktopTauri(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw invalid('usage: node host-core/desktop-tauri.js <dev|build|icon> [...args]');
  }
  const subcommand = argv[0];
  if (subcommand === '-h' || subcommand === '--help') {
    process.stdout.write('usage: node host-core/desktop-tauri.js <dev|build|icon> [...args]\n');
    return;
  }
  if (subcommand !== 'dev' && subcommand !== 'build' && subcommand !== 'icon') {
    throw invalid(`unsupported desktop-tauri subcommand: ${subcommand}`);
  }
  if (subcommand === 'dev' || subcommand === 'build') {
    await prepareDesktop();
  }
  const cliEntry = resolveTauriCliEntry(ROOT);
  await spawnNodeScript(cliEntry, argv, { cwd: DESKTOP_DIR, stdio: 'inherit' });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDesktopTauri().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
