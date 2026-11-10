#!/usr/bin/env node
// scripts/build-center-deb.mjs — build self-contained Debian packages
// (pibot-center_<version>_amd64.deb and pibot-center_<version>_arm64.deb)
// mirroring the production Center layout in Dockerfile, with pinned Node.js
// 26.13.0, center-web dist, built-in plugins, @bitwarden/cli@2026.10.1, and
// systemd service integration.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '26.13.0';
const BW_CLI_VERSION = '2026.10.1';

const NODE_ARCH_TARGETS = {
  amd64: {
    debArch: 'amd64',
    nodeArch: 'linux-x64',
    sha256: '5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455',
  },
  arm64: {
    debArch: 'arm64',
    nodeArch: 'linux-arm64',
    sha256: '439e9c438acdf6a6ffe47418da709153d66c4bed812e30a473faacb107dd2791',
  },
};

const PRUNED_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts', '.map', '.tsbuildinfo'];

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function lf(text) {
  return text.replace(/\r\n/g, '\n');
}

function writeLf(filePath, content, mode = 0o644) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lf(content), { encoding: 'utf8', mode });
  chmodSync(filePath, mode);
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function copyCleanTree(src, dest, extraExclude = new Set()) {
  const excluded = new Set(['node_modules', '.git', 'build', ...extraExclude]);
  cpSync(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (!rel) return true;
      return !rel.split(path.sep).some((part) => excluded.has(part));
    },
  });
}

function pruneAndNormalizeModes(dirPath, insideNodeModules = false) {
  for (const entry of readdirSync(dirPath)) {
    const full = path.join(dirPath, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      chmodSync(full, 0o755);
      pruneAndNormalizeModes(full, insideNodeModules || entry === 'node_modules');
    } else if (st.isFile()) {
      if (insideNodeModules && PRUNED_SUFFIXES.some((s) => entry.endsWith(s))) {
        unlinkSync(full);
        continue;
      }
      chmodSync(full, st.mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function computeInstalledSizeKb(dirPath) {
  let totalBytes = 0;
  function walk(curr) {
    for (const entry of readdirSync(curr)) {
      const full = path.join(curr, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) totalBytes += st.size;
    }
  }
  walk(dirPath);
  return Math.max(1, Math.ceil(totalBytes / 1024));
}

function ensureNodeArchive(cacheDir, target) {
  mkdirSync(cacheDir, { recursive: true });
  const archiveName = `node-v${NODE_VERSION}-${target.nodeArch}.tar.gz`;
  const archivePath = path.join(cacheDir, archiveName);
  if (!existsSync(archivePath) || sha256File(archivePath) !== target.sha256) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
    console.log(`Downloading ${url} ...`);
    run('curl', [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--connect-timeout',
      '20',
      '--max-time',
      '300',
      '-o',
      archivePath,
      url,
    ]);
    const actual = sha256File(archivePath);
    if (actual !== target.sha256) {
      throw new Error(`SHA256 mismatch for ${archiveName}: expected ${target.sha256}, got ${actual}`);
    }
  }
  const extractDir = path.join(cacheDir, `extract-${target.debArch}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', archivePath, '-C', extractDir]);
  const unpackedRoot = path.join(extractDir, `node-v${NODE_VERSION}-${target.nodeArch}`);
  const nodeBin = path.join(unpackedRoot, 'bin', 'node');
  const nodeLicense = path.join(unpackedRoot, 'LICENSE');
  if (!existsSync(nodeBin) || !statSync(nodeBin).isFile()) {
    throw new Error(`Extracted Node binary missing at ${nodeBin}`);
  }
  return { nodeBin, nodeLicense };
}

function stageSharedPayload(workDir) {
  console.log('Building center-web frontend ...');
  run('npm', ['ci', '--prefix', path.join(ROOT, 'center-web'), '--no-audit', '--no-fund']);
  run('npm', ['run', '--prefix', path.join(ROOT, 'center-web'), 'build']);

  const appStage = path.join(workDir, 'app-stage');
  rmSync(appStage, { recursive: true, force: true });
  mkdirSync(appStage, { recursive: true });

  copyCleanTree(path.join(ROOT, 'center-contract'), path.join(appStage, 'center-contract'));
  mkdirSync(path.join(appStage, 'center-web'), { recursive: true });
  cpSync(path.join(ROOT, 'center-web', 'dist'), path.join(appStage, 'center-web', 'dist'), { recursive: true });
  copyCleanTree(path.join(ROOT, 'center-server'), path.join(appStage, 'center-server'), new Set(['linux']));
  copyCleanTree(path.join(ROOT, 'host-core'), path.join(appStage, 'host-core'), new Set(['native']));
  copyCleanTree(path.join(ROOT, 'plugins'), path.join(appStage, 'plugins'));

  console.log('Installing production dependencies for center-server and host-core ...');
  run('npm', ['ci', '--prefix', path.join(appStage, 'center-server'), '--omit=dev', '--no-audit', '--no-fund']);
  run('npm', ['ci', '--prefix', path.join(appStage, 'host-core'), '--omit=dev', '--no-audit', '--no-fund']);

  console.log('Preparing built-in plugin archives ...');
  mkdirSync(path.join(appStage, 'scripts'), { recursive: true });
  cpSync(
    path.join(ROOT, 'scripts', 'prepare-builtin-plugins.mjs'),
    path.join(appStage, 'scripts', 'prepare-builtin-plugins.mjs'),
  );
  run(process.execPath, [path.join(appStage, 'scripts', 'prepare-builtin-plugins.mjs')]);
  rmSync(path.join(appStage, 'scripts'), { recursive: true, force: true });
  rmSync(path.join(appStage, 'build', 'builtin-plugin-source'), { recursive: true, force: true });

  console.log(`Installing pinned @bitwarden/cli@${BW_CLI_VERSION} ...`);
  const bwDir = path.join(appStage, 'bitwarden-cli');
  mkdirSync(bwDir, { recursive: true });
  run('npm', ['init', '-y'], { cwd: bwDir, stdio: 'ignore' });
  run(
    'npm',
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `@bitwarden/cli@${BW_CLI_VERSION}`,
    ],
    { cwd: bwDir },
  );

  cpSync(path.join(ROOT, 'LICENSE'), path.join(appStage, 'LICENSE'));
  cpSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(appStage, 'THIRD_PARTY_NOTICES.md'));
  copyCleanTree(path.join(ROOT, 'licenses'), path.join(appStage, 'licenses'));

  chmodSync(appStage, 0o755);
  pruneAndNormalizeModes(appStage);
  return appStage;
}

function buildDebForArch({ version, target, appStage, cacheDir, workDir, outDir }) {
  const { nodeBin, nodeLicense } = ensureNodeArchive(cacheDir, target);
  const pkgRoot = path.join(workDir, `pkg-${target.debArch}`);
  rmSync(pkgRoot, { recursive: true, force: true });

  const installRoot = path.join(pkgRoot, 'usr', 'lib', 'pibot-center');
  mkdirSync(installRoot, { recursive: true, mode: 0o755 });
  cpSync(appStage, installRoot, { recursive: true, verbatimSymlinks: true });

  const binDir = path.join(installRoot, 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const destNode = path.join(binDir, 'node');
  cpSync(nodeBin, destNode);
  chmodSync(destNode, 0o755);

  writeLf(
    path.join(binDir, 'npm'),
    '#!/bin/sh\nexec "/usr/lib/pibot-center/bin/node" "/usr/lib/pibot-center/center-server/node_modules/npm/bin/npm-cli.js" "$@"\n',
    0o755,
  );
  writeLf(
    path.join(binDir, 'npx'),
    '#!/bin/sh\nexec "/usr/lib/pibot-center/bin/node" "/usr/lib/pibot-center/center-server/node_modules/npm/bin/npx-cli.js" "$@"\n',
    0o755,
  );

  cpSync(nodeLicense, path.join(installRoot, 'NODE-LICENSE.txt'));
  chmodSync(path.join(installRoot, 'NODE-LICENSE.txt'), 0o644);

  const linuxDir = path.join(ROOT, 'center-server', 'linux');
  writeLf(
    path.join(pkgRoot, 'usr', 'bin', 'pibot-center'),
    readFileSync(path.join(linuxDir, 'pibot-center'), 'utf8'),
    0o755,
  );
  writeLf(
    path.join(pkgRoot, 'usr', 'lib', 'systemd', 'system', 'pibot-center.service'),
    readFileSync(path.join(linuxDir, 'pibot-center.service'), 'utf8'),
    0o644,
  );
  writeLf(
    path.join(pkgRoot, 'etc', 'pibot-center', 'center.env'),
    readFileSync(path.join(linuxDir, 'center.env.default'), 'utf8'),
    0o640,
  );
  writeLf(
    path.join(pkgRoot, 'usr', 'share', 'doc', 'pibot-center', 'copyright'),
    readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')
      + '\n\nSee /usr/lib/pibot-center/THIRD_PARTY_NOTICES.md and /usr/lib/pibot-center/licenses/ for bundled third-party notices.\n',
    0o644,
  );

  // Ensure parent directories inside pkgRoot are 0755
  for (const rel of [
    'usr',
    'usr/bin',
    'usr/lib',
    'usr/lib/pibot-center',
    'usr/lib/pibot-center/bin',
    'usr/lib/systemd',
    'usr/lib/systemd/system',
    'usr/share',
    'usr/share/doc',
    'usr/share/doc/pibot-center',
    'etc',
    'etc/pibot-center',
  ]) {
    chmodSync(path.join(pkgRoot, rel), 0o755);
  }

  const installedSizeKb = computeInstalledSizeKb(pkgRoot);
  const debianDir = path.join(pkgRoot, 'DEBIAN');
  mkdirSync(debianDir, { recursive: true, mode: 0o755 });
  chmodSync(debianDir, 0o755);

  const control = [
    'Package: pibot-center',
    `Version: ${version}`,
    'Section: net',
    'Priority: optional',
    `Architecture: ${target.debArch}`,
    'Depends: adduser, ca-certificates, python3',
    `Installed-Size: ${installedSizeKb}`,
    'Maintainer: PiBot Maintainers <https://github.com/FireSpoonYZ/PiBot>',
    'Homepage: https://github.com/FireSpoonYZ/PiBot',
    'Description: PiBot self-hosted Center server and relay',
    ' Self-hosted control plane, web console, model/credential manager, Skill',
    ' learning service, and WebSocket relay (/v1/link) for multi-device PiBot',
    ' agents across Windows, Linux, and Android.',
    '',
  ].join('\n');

  writeLf(path.join(debianDir, 'control'), control, 0o644);
  writeLf(path.join(debianDir, 'conffiles'), '/etc/pibot-center/center.env\n', 0o644);
  writeLf(path.join(debianDir, 'postinst'), readFileSync(path.join(linuxDir, 'postinst'), 'utf8'), 0o755);
  writeLf(path.join(debianDir, 'prerm'), readFileSync(path.join(linuxDir, 'prerm'), 'utf8'), 0o755);
  writeLf(path.join(debianDir, 'postrm'), readFileSync(path.join(linuxDir, 'postrm'), 'utf8'), 0o755);

  const debFile = path.join(outDir, `pibot-center_${version}_${target.debArch}.deb`);
  rmSync(debFile, { force: true });
  console.log(`Packing ${debFile} ...`);
  run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', pkgRoot, debFile]);
  rmSync(pkgRoot, { recursive: true, force: true });

  const fields = execFileSync('dpkg-deb', ['--field', debFile], { encoding: 'utf8' });
  if (
    !/^Package: pibot-center$/m.test(fields) ||
    fields.match(/^Version: (.+)$/m)?.[1] !== version ||
    fields.match(/^Architecture: (.+)$/m)?.[1] !== target.debArch
  ) {
    throw new Error(`DEB metadata verification failed for ${debFile}:\n${fields}`);
  }
  return debFile;
}

async function smokeTestDeb(debFile, workDir) {
  console.log(`Running smoke test on ${debFile} ...`);
  const extractRoot = path.join(workDir, 'smoke-extract');
  const dataRoot = path.join(workDir, 'smoke-data');
  rmSync(extractRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

  run('dpkg-deb', ['-x', debFile, extractRoot]);
  const nodeBin = path.join(extractRoot, 'usr', 'lib', 'pibot-center', 'bin', 'node');
  const cliJs = path.join(extractRoot, 'usr', 'lib', 'pibot-center', 'center-server', 'cli.js');
  const webRoot = path.join(extractRoot, 'usr', 'lib', 'pibot-center', 'center-web', 'dist');
  const bwJs = path.join(
    extractRoot,
    'usr',
    'lib',
    'pibot-center',
    'bitwarden-cli',
    'node_modules',
    '@bitwarden',
    'cli',
    'build',
    'bw.js',
  );

  // Verify password-hash subcommand with bundled Node
  const hashOut = execFileSync(nodeBin, [cliJs, 'password-hash'], {
    input: 'correct-horse-battery-staple\n',
    encoding: 'utf8',
  }).trim();
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/i.test(hashOut)) {
    throw new Error(`Unexpected password-hash output: ${hashOut}`);
  }

  // Boot Center in setup mode on ephemeral localhost port and verify HTTP + WebSocket upgrade
  const port = 28080 + Math.floor(Math.random() * 2000);
  const child = spawn(nodeBin, [cliJs], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CENTER_DATA_ROOT: dataRoot,
      CENTER_LISTEN_HOST: '127.0.0.1',
      CENTER_PORT: String(port),
      CENTER_WEB_ROOT: webRoot,
      PIBOT_BW_CLI: bwJs,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString('utf8'); });
  child.stderr.on('data', (d) => { logs += d.toString('utf8'); });

  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          const body = await res.json();
          if (body.status === 'setup') {
            ready = true;
            break;
          }
        }
      } catch {
        // wait for server startup
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      throw new Error(`Center did not reach setup status on ${base}. Logs:\n${logs}`);
    }

    const indexRes = await fetch(`${base}/`);
    if (!indexRes.ok || !(indexRes.headers.get('content-type') || '').includes('text/html')) {
      throw new Error(`Center web root did not serve HTML: HTTP ${indexRes.status}`);
    }

    // Verify setup server stops cleanly on SIGTERM
    child.kill('SIGTERM');
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    if (exitCode !== 0) {
      throw new Error(`Center exited with non-zero code ${exitCode} on SIGTERM`);
    }

    // Also verify full ready mode + /v1/link WebSocket upgrade
    const encKey = randomBytes(32).toString('hex');
    const sessKey = randomBytes(32).toString('hex');
    const dataRootReady = path.join(workDir, 'smoke-data-ready');
    rmSync(dataRootReady, { recursive: true, force: true });
    mkdirSync(dataRootReady, { recursive: true, mode: 0o700 });

    const readyChild = spawn(nodeBin, [cliJs], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CENTER_DATA_ROOT: dataRootReady,
        CENTER_LISTEN_HOST: '127.0.0.1',
        CENTER_PORT: String(port),
        CENTER_WEB_ROOT: webRoot,
        CENTER_PUBLIC_URL: 'https://center.example.com',
        CENTER_ENCRYPTION_KEY_HEX: encKey,
        CENTER_SESSION_KEY_HEX: sessKey,
        CENTER_OWNER_PASSWORD_HASH: hashOut,
        PIBOT_BW_CLI: bwJs,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let readyLogs = '';
    readyChild.stdout.on('data', (d) => { readyLogs += d.toString('utf8'); });
    readyChild.stderr.on('data', (d) => { readyLogs += d.toString('utf8'); });

    try {
      let fullReady = false;
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) {
            const body = await res.json();
            if (body.status === 'ready') {
              fullReady = true;
              break;
            }
          }
        } catch {
          // wait for builtin plugin initialization
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!fullReady) {
        throw new Error(`Center did not reach ready status on ${base}. Logs:\n${readyLogs}`);
      }

      // Probe /v1/link WebSocket 101 upgrade
      const wsKey = randomBytes(16).toString('base64');
      const expectedAccept = createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      await new Promise((resolve, reject) => {
        const req = http.get(
          `${base}/v1/link`,
          {
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': wsKey,
              'Sec-WebSocket-Version': '13',
            },
          },
          (res) => {
            res.destroy();
            reject(new Error(`Expected 101 Switching Protocols, got HTTP ${res.statusCode}`));
          },
        );
        req.once('error', reject);
        req.once('upgrade', (res, socket) => {
          socket.destroy();
          if (res.statusCode === 101 && res.headers['sec-websocket-accept'] === expectedAccept) {
            resolve();
          } else {
            reject(new Error('Invalid WebSocket upgrade response headers'));
          }
        });
      });

      readyChild.kill('SIGTERM');
      const readyExit = await new Promise((resolve) => readyChild.once('exit', resolve));
      if (readyExit !== 0) {
        throw new Error(`Ready Center exited with non-zero code ${readyExit}`);
      }
    } finally {
      try { readyChild.kill('SIGKILL'); } catch { /* already exited */ }
      rmSync(dataRootReady, { recursive: true, force: true });
    }
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log('Smoke test passed (setup mode, ready mode, builtin plugins, and /v1/link WebSocket upgrade).');
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('build-center-deb.mjs must run on Linux with dpkg-deb installed');
  }
  const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const requestedVersion = argValue('--version') || pkgVersion;
  if (requestedVersion !== pkgVersion) {
    throw new Error(`Requested --version ${requestedVersion} does not match root package.json (${pkgVersion})`);
  }

  const archSpec = argValue('--arch') || 'amd64,arm64';
  const arches = archSpec.split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of arches) {
    if (!NODE_ARCH_TARGETS[a]) throw new Error(`Unsupported --arch '${a}' (expected amd64 or arm64)`);
  }

  // Place workDir outside repo 'build/' because prepare-builtin-plugins.mjs
  // filters out any path containing a 'build' directory segment.
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'pibot-center-deb-'));
  const cacheDir = path.join(ROOT, 'build', 'center-deb-cache');
  const outDir = path.join(ROOT, 'build', 'center-deb');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const built = {};
  try {
    const appStage = stageSharedPayload(workDir);
    for (const a of arches) {
      built[a] = buildDebForArch({
        version: pkgVersion,
        target: NODE_ARCH_TARGETS[a],
        appStage,
        cacheDir,
        workDir,
        outDir,
      });
    }

    if (process.argv.includes('--smoke-test')) {
      const hostDebArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      if (built[hostDebArch]) {
        await smokeTestDeb(built[hostDebArch], workDir);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log('Built Center DEB package(s):', Object.values(built).join(', '));
}

await main();
