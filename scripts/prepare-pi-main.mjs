#!/usr/bin/env node
// scripts/prepare-pi-main.mjs: reproducible pinned build of the six upstream
// @earendil-works runtime packages for host-core and center-server.
// Pin lives in scripts/pi-main.json (upstream pi@main SHA + pinned model
// catalog revision). Fetches the exact commit into a user-level git cache,
// builds the six packages in upstream order, repacks them under deterministic
// version 1.4.0-main.35dfa757378b into build/pi-main/*.tgz + receipt.json.
// Consumers use file:../build/pi-main/ deps so sibling "1.4.0" ranges can't
// resolve back to the npm release. Run before npm install in host-core.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const M = JSON.parse(readFileSync(path.join(HERE, 'pi-main.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, 'build', 'pi-main');
const RECEIPT = path.join(OUT_DIR, 'receipt.json');
const CACHE_REPO = path.join(tmpdir(), 'e-launcher-pi-main-git');
// Distinct cache-adjacent build tree (not any caller-supplied path). Never
// deleted: an existing tree is verified and reused, only a missing one is
// created via git worktree add.
const WORKTREE = path.join(tmpdir(), 'e-launcher-pi-main-build-' + M.upstream.sha.slice(0, 12));
const SIX = new Set(M.packages.map((p) => p.name));
// Upstream build order; durable depends on ai, so ai must precede it.
const ORDER = [
  ['packages/telemetry', 'build'],
  ['packages/chord', 'build'],
  ['packages/codemode', 'build'],
  ['packages/mcp', 'build'],
  ['packages/ai', 'build:offline'],
  ['packages/durable', 'build'],
];

function fail(m) { const e = new Error(m); e.code = 'PI_MAIN_PREPARE'; return e; }
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const shellish = (c) => ['npm', 'npx', 'git', 'node'].includes(path.basename(c).toLowerCase());
function run(c, a, o = {}) {
  const r = spawnSync(c, a, { stdio: 'inherit', shell: process.platform === 'win32' && shellish(c), ...o });
  if (r.status !== 0) throw fail(c + ' ' + a.join(' ') + ' exit ' + (r.status ?? '?'));
}
function out(c, a, o = {}) {
  const r = spawnSync(c, a, { encoding: 'utf8', shell: process.platform === 'win32' && shellish(c), ...o });
  if (r.status !== 0) throw fail(c + ' ' + a.join(' ') + ': ' + (r.stderr || '').trim());
  return (r.stdout || '').trim();
}

// Fetch the pinned commit into a user-level git repo, then a detached worktree.
// Identity is enforced by rev-parse HEAD == sha AND git status --porcelain
// (tracked sources unmodified); we never trust a directory name. --source-dir
// must itself be a matching clean git checkout of the same SHA (a plain
// archive is rejected: no .git).
function verifyCheckout(dir) {
  if (!existsSync(path.join(dir, '.git'))) throw fail('not a git checkout (no .git): ' + dir);
  const head = out('git', ['-C', dir, 'rev-parse', 'HEAD']);
  if (head !== M.upstream.sha) throw fail('HEAD ' + head + ' != pinned ' + M.upstream.sha);
  const dirty = out('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw fail('tracked sources modified: ' + dirty);
  return head;
}
async function fetchSource() {
  // Reuse an existing build tree after verifying it is the pinned, unmodified
  // checkout; only create it when absent. Never rmSync or re-download a tree
  // that may be shared with other readers.
  if (existsSync(WORKTREE)) { verifyCheckout(WORKTREE); return WORKTREE; }
  mkdirSync(CACHE_REPO, { recursive: true });
  if (!existsSync(path.join(CACHE_REPO, 'HEAD'))) run('git', ['init', '--bare', CACHE_REPO]);
  run('git', ['-C', CACHE_REPO, 'fetch', '--depth', '1', M.upstream.repo, M.upstream.sha]);
  run('git', ['-C', CACHE_REPO, 'worktree', 'add', '--detach', WORKTREE, M.upstream.sha]);
  return WORKTREE;
}

// pi-ai's providers/data is git-ignored and absent in a fresh checkout, so
// build:offline would fail. Mirror the official Nix path: fetch the pinned
// typed catalog (revision == its sha256) then hydrate locally (deterministic,
// fixed 1970 manifest -> identical bytes for identical input, no refresh).
async function hydrateModelData(sourceDir) {
  const pin = M.modelCatalog;
  const res = await fetch(pin.url);
  if (!res.ok) throw fail('model catalog ' + pin.url + ' HTTP ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = 'sha256-' + sha256(bytes);
  if (digest !== pin.revision) throw fail('model catalog ' + digest + ' != pinned ' + pin.revision);
  const tmp = path.join(tmpdir(), 'pi-models-' + pin.revision.slice(7, 19) + '.json');
  writeFileSync(tmp, bytes);
  run('node', [path.join(sourceDir, 'packages/ai/scripts/hydrate-model-catalog.ts'), tmp], { cwd: sourceDir });
  const mp = path.join(sourceDir, 'packages/ai/src/providers/data/.manifest.json');
  return { revision: pin.revision, dataManifestSha256: sha256(readFileSync(mp)) };
}

function pack(pkg, pkgDir) {
  const st = mkdtempSync(path.join(tmpdir(), 'pi-main-pack-'));
  try {
    cpSync(pkgDir, st, { recursive: true });
    const pj = path.join(st, 'package.json');
    const m = JSON.parse(readFileSync(pj, 'utf8'));
    m.version = M.version;
    for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const d = m[sec];
      if (d) for (const n of Object.keys(d)) if (SIX.has(n)) d[n] = M.version;
    }
    writeFileSync(pj, JSON.stringify(m, null, 2) + '\n');
    out('npm', ['pack', '--pack-destination', st], { cwd: st });
    const tgz = readdirSync(st).find((e) => e.endsWith('.tgz'));
    if (!tgz) throw fail('npm pack produced no tarball for ' + pkg.name);
    cpSync(path.join(st, tgz), path.join(OUT_DIR, pkg.tarball));
    const bytes = readFileSync(path.join(OUT_DIR, pkg.tarball));
    return { sha256: sha256(bytes), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), bytes: bytes.length };
  } finally { rmSync(st, { recursive: true, force: true }); }
}

function parseArgs(argv) {
  const o = { sourceDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-dir') { const v = argv[++i]; if (!v) throw fail('--source-dir needs a path'); o.sourceDir = path.resolve(v); }
    else if (argv[i] === '--help' || argv[i] === '-h') { process.stdout.write('usage: node scripts/prepare-pi-main.mjs [--source-dir <git-checkout-of-pinned-sha>]\n'); process.exit(0); }
    else throw fail('unknown argument: ' + argv[i]);
  }
  return o;
}

// Fast path: if the existing receipt matches this pin and every declared
// tarball's recorded sha256 still matches the bytes on disk, the build is
// already reproducible -- return without rebuilding the upstream packages.
function upToDate() {
  if (!existsSync(RECEIPT)) return false;
  let r;
  try { r = JSON.parse(readFileSync(RECEIPT, 'utf8')); } catch { return false; }
  if (r.version !== M.version || r.upstream?.sha !== M.upstream.sha || r.modelData?.revision !== M.modelCatalog.revision) return false;
  for (const pkg of M.packages) {
    const rec = r.packages?.[pkg.name];
    const f = path.join(OUT_DIR, pkg.tarball);
    if (!rec || rec.tarball !== pkg.tarball || !existsSync(f)) return false;
    if (sha256(readFileSync(f)) !== rec.sha256) return false;
  }
  return true;
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.sourceDir && upToDate()) {
    process.stdout.write('pi-main tarballs already match pin ' + M.upstream.sha.slice(0, 12) + ' (build/pi-main/)\n');
    return;
  }
  const sourceDir = opts.sourceDir ?? await fetchSource();
  if (!existsSync(sourceDir)) throw fail('source directory not found: ' + sourceDir);
  const gitSha = verifyCheckout(sourceDir);
  if (!existsSync(path.join(sourceDir, 'node_modules', 'typescript'))) {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: sourceDir });
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const receipt = { upstream: { ...M.upstream, gitSha }, version: M.version, generatedAt: new Date().toISOString(), packages: {} };
  const modelData = await hydrateModelData(sourceDir);
  receipt.modelData = modelData;
  for (const [dir, script] of ORDER) {
    const pkg = M.packages.find((p) => p.dir === dir);
    run('npm', ['run', script], { cwd: path.join(sourceDir, dir) });
    receipt.packages[pkg.name] = { tarball: pkg.tarball, dir, buildScript: script, ...pack(pkg, path.join(sourceDir, dir)) };
    process.stdout.write('packed ' + pkg.name + ' -> build/pi-main/' + pkg.tarball + '\n');
  }
  writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write('receipt -> ' + path.relative(ROOT, RECEIPT) + '\n');
}
main().catch((e) => { process.stderr.write(JSON.stringify({ error: { code: e?.code ?? 'INTERNAL', message: e?.message ?? String(e) } }) + '\n'); process.exitCode = 1; });
