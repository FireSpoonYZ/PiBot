#!/usr/bin/env node
// host-core/build-shower-windows.js: build entry for the Windows Shower native host.
//
// Compiles host-core/native/windows/*.cs (Program, RdpHost, Wire, SessionAgent,
// SessionBootstrap and any sibling file, excluding InteropGenerator.cs itself) into
// native/windows/build/shower-windows.exe with the in-box .NET Framework 4.8
// Framework64 csc.exe as a C# 5 x64 console assembly.
//
// MSTSCLib interop for the mstscax.dll ActiveX control is generated at build time by
// InteropGenerator.cs into native/windows/build/MSTSCLib.dll; no generated interop
// binary is committed and no tlbimp, PowerShell, NuGet package or extra SDK is used.
// Both outputs are git-ignored build artifacts: the Node adapter spawns the fixed
// build path, and deployment copies the two files, it never rebuilds on the target.
//
// usage: node host-core/build-shower-windows.js
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NATIVE_DIR = path.join(HERE, 'native', 'windows');
const BUILD_DIR = path.join(NATIVE_DIR, 'build');
const GENERATOR_SOURCE = path.join(NATIVE_DIR, 'InteropGenerator.cs');
const GENERATOR_EXE = path.join(BUILD_DIR, 'InteropGenerator.exe');
const HOST_EXE = path.join(BUILD_DIR, 'shower-windows.exe');
const INTEROP_ASSEMBLY = path.join(BUILD_DIR, 'MSTSCLib.dll');
const INTEROP_SOURCE_NAME = 'InteropGenerator.cs';
// Everything the native host must provide; a missing file means the sibling sources
// of the same batch have not landed yet, so fail with the file name instead of a bare
// "no entry point" from csc.
const REQUIRED_SOURCES = ['Program.cs', 'RdpHost.cs', 'Wire.cs', 'SessionAgent.cs', 'SessionBootstrap.cs'];
const HOST_REFERENCES = [
  'System.dll',
  'System.Core.dll',
  'System.ServiceProcess.dll',
  'System.Security.dll',
  'System.Windows.Forms.dll',
  'System.Drawing.dll',
  'System.Web.Extensions.dll',
];
const CSC_FLAGS = ['/nologo', '/langversion:5', '/platform:x64', '/warn:4', '/optimize+'];
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const execFileAsync = promisify(execFile);

function fail(message) {
  return Object.assign(new Error(message), { code: 'SHOWER_WINDOWS_BUILD_FAILED' });
}

function display(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function requireFile(filePath, label) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (!stats || !stats.isFile()) throw fail(`${label} is missing: ${display(filePath)}`);
  return filePath;
}

function systemRoot() {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root) throw fail('SystemRoot/WINDIR is not set; cannot locate .NET Framework or mstscax.dll');
  return root;
}

function frameworkDir() {
  return path.join(systemRoot(), 'Microsoft.NET', 'Framework64', 'v4.0.30319');
}

function cscPath() {
  const csc = path.join(frameworkDir(), 'csc.exe');
  if (!existsSync(csc)) {
    throw fail(`in-box x64 C# 5 compiler not found: ${csc}; .NET Framework 4.8 is required (no PowerShell, NuGet or SDK fallback)`);
  }
  return csc;
}

function hostSources() {
  return readdirSync(NATIVE_DIR)
    .filter((name) => name.endsWith('.cs') && name !== INTEROP_SOURCE_NAME)
    .sort()
    .map((name) => path.join(NATIVE_DIR, name));
}

async function run(command, args, label) {
  try {
    return await execFileAsync(command, args, {
      cwd: NATIVE_DIR,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch (err) {
    if (typeof err.code === 'number') {
      const detail = [String(err.stdout ?? ''), String(err.stderr ?? '')].join('\n').trim();
      throw fail(`${label} failed (exit code ${err.code})${detail ? `: ${detail}` : ''}`);
    }
    throw fail(`${label} failed to start: ${err.message}`);
  }
}

async function buildInterop() {
  requireFile(GENERATOR_SOURCE, 'interop generator source');
  const typeLib = requireFile(
    path.join(systemRoot(), 'System32', 'mstscax.dll'),
    'system mstscax.dll (Remote Desktop Services ActiveX control)'
  );
  await run(
    cscPath(),
    [
      ...CSC_FLAGS,
      '/target:exe',
      `/out:${GENERATOR_EXE}`,
      `/r:${path.join(frameworkDir(), 'System.dll')}`,
      GENERATOR_SOURCE,
    ],
    'csc InteropGenerator.cs'
  );
  requireFile(GENERATOR_EXE, 'generated InteropGenerator.exe');
  const generated = await run(GENERATOR_EXE, [typeLib, BUILD_DIR], 'InteropGenerator.exe');
  // Conversion warnings describe dropped members; keep them in the build log.
  if (String(generated.stderr ?? '').trim() !== '') process.stderr.write(generated.stderr);
  return requireFile(INTEROP_ASSEMBLY, 'generated MSTSCLib interop assembly');
}

async function buildHost(sources) {
  // Never leave a stale executable behind for the adapter to spawn after a failed build.
  rmSync(HOST_EXE, { force: true });
  const references = [
    INTEROP_ASSEMBLY,
    ...HOST_REFERENCES.map((name) => path.join(frameworkDir(), name)),
  ];
  await run(
    cscPath(),
    [
      ...CSC_FLAGS,
      '/target:exe',
      `/out:${HOST_EXE}`,
      ...references.map((file) => `/r:${file}`),
      ...sources,
    ],
    'csc native/windows host'
  );
  return requireFile(HOST_EXE, 'built shower-windows.exe');
}

async function main() {
  if (process.platform !== 'win32') {
    throw fail('the Windows Shower host is built and run on Windows only; WSL or cross-compilation is not supported');
  }
  const missing = REQUIRED_SOURCES.filter((name) => !existsSync(path.join(NATIVE_DIR, name)));
  if (missing.length > 0) {
    throw fail(`native host sources are missing under ${display(NATIVE_DIR)}: ${missing.join(', ')}`);
  }
  const sources = hostSources();
  mkdirSync(BUILD_DIR, { recursive: true });
  const interop = await buildInterop();
  const exe = await buildHost(sources);
  process.stdout.write(
    JSON.stringify({
      done: true,
      exe: display(exe),
      interop: display(interop),
      sources: sources.map(display),
    }) + '\n'
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
