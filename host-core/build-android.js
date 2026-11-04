#!/usr/bin/env node
// host-core/build-android.js: product build entry for the Android Host runtime.
// Bundles host-core/android-runtime.js with the root Vite esbuild dependency into app/build/generated/assets/botHost/bot-host/ and
// emits payload.json + third-party-licenses.txt for the APK.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, writeFile, copyFile, mkdir, readdir, access, stat, rm } from 'node:fs/promises';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP_BUILD = path.join(ROOT, 'app', 'build');
const OUT_DIR = path.join(APP_BUILD, 'generated', 'assets', 'botHost', 'bot-host');
// esbuild build graph stays out of the APK assets: ignored build subdir only.
const METAFILE_DIR = path.join(APP_BUILD, 'host-runtime');
const TOOL_CACHE = path.join(APP_BUILD, 'host-native-tools');
// File-name prefixes considered license/notice texts (case-insensitive); files
// only, so LICENSE-APACHE / LICENSE-MIT / COPYING variants are all captured.
const LICENSE_PREFIXES = ['license', 'copying', 'notice'];
// npm archives for the pinned @earendil-works packages (chord/pi-ai/pi-durable
// 1.3.0) omit LICENSE files; use the verified in-repo upstream MIT copies instead.
// @vectorize-io/hindsight-client 0.9.2 publishes dist/src/generated only, so its
// MIT text must also be kept in-repo (licenses/hindsight-client-0.9.2-MIT.txt).
// standardwebhooks 1.1.1 (arrives with the anthropic-messages API through
// @anthropic-ai/sdk) ships no license file either. Its npm manifest declares MIT,
// but the repository at the npm gitHead commit only carries the Apache-2.0 LICENSE
// text, vendored verbatim (provenance header included) in
// licenses/standardwebhooks-1.1.1-LICENSE.txt -- that text is NOT an MIT copy.
// `declared` is the manifest license to match, `license` the in-repo text file; a
// package@version outside this map still fails the missing-license check.
// The six @earendil-works packages are built from the pinned upstream main
// commit (scripts/pi-main.json, scripts/prepare-pi-main.mjs) and installed via
// file: tarballs from build/pi-main/; their installed version is the
// deterministic 1.4.0-main.35dfa757378b, not the npm 1.4.0 release.
const PI_MAIN_VERSION = '1.4.0-main.35dfa757378b';
const UPSTREAM_LICENSE_ALLOWLIST = new Map([
  ['@earendil-works/chord', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-v1.3.0-MIT.txt' }],
  ['@earendil-works/pi-ai', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-v1.3.0-MIT.txt' }],
  ['@earendil-works/pi-codemode', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-v1.3.0-MIT.txt' }],
  ['@earendil-works/pi-durable', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-v1.3.0-MIT.txt' }],
  ['@earendil-works/pi-mcp', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-v1.3.0-MIT.txt' }],
  ['@earendil-works/pi-telemetry', { version: PI_MAIN_VERSION, declared: 'MIT', license: 'pi-v1.3.0-MIT.txt' }],
  ['@vectorize-io/hindsight-client', { version: '0.9.2', declared: 'MIT', license: 'hindsight-client-0.9.2-MIT.txt' }],
  ['standardwebhooks', { version: '1.1.1', declared: 'MIT', license: 'standardwebhooks-1.1.1-LICENSE.txt' }],
]);
const DYNAMIC_ASSET_RE = /(?:require\s*\.\s*resolve|createRequire\s*\([^)]*\)\s*\.\s*resolve|new\s+URL)\s*\(\s*(['"])([^'"]+\.(?:wasm|node))\1/g;

async function readIfPresent(file) {
  try { return await readFile(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(file) {
  return sha256Buffer(await readFile(file));
}

function normalizeToAbsolute(absWorkingDir, filePath) {
  // esbuild metafile keys may use forward slashes even on Windows; normalize
  // both separators, then resolve relative keys against absWorkingDir.
  const normalized = filePath.replace(/\//g, path.sep).replace(/\\/g, path.sep);
  return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(absWorkingDir, normalized);
}

// Nearest NAMED/versioned package owner: walk up, skipping nameless nested
// package.json (e.g. ESM scope submodules), capped at the project root.
async function findPackageRoot(startDir) {
  let dir = startDir;
  while (dir && dir !== path.dirname(dir) && dir.startsWith(ROOT)) {
    const pkgFile = path.join(dir, 'package.json');
    const raw = await readIfPresent(pkgFile);
    if (raw) {
      try {
        const pkg = JSON.parse(raw.toString('utf8'));
        if (typeof pkg.name === 'string' && pkg.name !== '' &&
            typeof pkg.version === 'string' && pkg.version !== '') {
          return { root: dir, name: pkg.name, version: pkg.version, license: pkg.license ?? null };
        }
      } catch { /* skip malformed/nameless and keep walking */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

async function findLicenseFiles(pkgRoot) {
  const entries = await readdir(pkgRoot);
  const found = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (!LICENSE_PREFIXES.some((p) => lower.startsWith(p))) continue;
    const full = path.join(pkgRoot, entry);
    const info = await stat(full);
    if (info.isFile()) found.push(full);
  }
  return found;
}

// Included modules in the actual output bundle (bytesInOutput > 0), normalized.
// Resolve BOTH the metafile key and the requested outfile against absWorkingDir
// before comparing (esbuild may emit forward-slash relative keys). Empty/missing
// graph is a hard error, never a silent empty license success.
function includedBundleInputs(metafile, outfile, absWorkingDir) {
  const outputs = metafile.outputs ?? {};
  const keys = Object.keys(outputs);
  if (keys.length === 0) throw new Error('esbuild metafile has no outputs; bundle output missing: ' + outfile);
  const targetAbs = normalizeToAbsolute(absWorkingDir, outfile);
  const key = keys.find((k) => normalizeToAbsolute(absWorkingDir, k) === targetAbs);
  if (!key) throw new Error('esbuild metafile output not found: ' + outfile);
  const output = outputs[key];
  if (!output.inputs || Object.keys(output.inputs).length === 0) {
    throw new Error('esbuild output has no included inputs (empty graph): ' + outfile);
  }
  return Object.keys(output.inputs).filter((p) => output.inputs[p].bytesInOutput > 0);
}

// Static gate: if an included bundle module resolves a .wasm/.node asset at
// runtime, the bundle genuinely needs it and we cannot ship a guessed copy.
// Fail clearly instead of silently shipping a wrong path.
async function assertNoRequiredDynamicAssets(metafile, outfile, absWorkingDir) {
  const hits = [];
  for (const raw of includedBundleInputs(metafile, outfile, absWorkingDir)) {
    const inputPath = normalizeToAbsolute(absWorkingDir, raw);
    const text = await readIfPresent(inputPath);
    if (!text) continue;
    const source = text.toString('utf8');
    for (const match of source.matchAll(DYNAMIC_ASSET_RE)) {
      hits.push({ module: inputPath, reference: match[2] });
    }
  }
  if (hits.length > 0) {
    const lines = hits.map((h) => `${h.module} -> ${h.reference}`).join('; ');
    throw new Error('bundled code requires runtime dynamic asset(s) not shipped in payload: ' + lines);
  }
}

async function collectBundledPackages(metafile, outfile, absWorkingDir) {
  const roots = new Map();
  for (const raw of includedBundleInputs(metafile, outfile, absWorkingDir)) {
    const inputPath = normalizeToAbsolute(absWorkingDir, raw);
    const pkg = await findPackageRoot(path.dirname(inputPath));
    if (pkg && pkg.name !== '@e-launcher/host-core' && !roots.has(pkg.name)) {
      roots.set(pkg.name, pkg);
    }
  }
  return roots;
}

async function writePayloadFiles(metafile, outfile, absWorkingDir, toolNotices) {
  await mkdir(OUT_DIR, { recursive: true });
  const files = new Map();
  files.set('host-runtime.mjs', { path: 'host-runtime.mjs' });
  await copyFile(path.join(HERE, 'node_modules', 'quickjs-wasi', 'quickjs.wasm'), path.join(OUT_DIR, 'quickjs.wasm'));
  files.set('quickjs.wasm', { path: 'quickjs.wasm' });

  const roots = await collectBundledPackages(metafile, outfile, absWorkingDir);
  const sections = [];
  for (const pkg of [...roots.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const licenseFiles = await findLicenseFiles(pkg.root);
    sections.push(`# ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})`);
    if (licenseFiles.length === 0) {
      const upstream = UPSTREAM_LICENSE_ALLOWLIST.get(pkg.name);
      if (upstream && upstream.version === pkg.version && pkg.license === upstream.declared) {
        const upstreamPath = path.join(ROOT, 'licenses', upstream.license);
        const text = await readIfPresent(upstreamPath);
        if (!text) throw new Error(`in-repo upstream license missing: ${upstreamPath}`);
        sections.push(text.toString('utf8').trim());
      } else {
        throw new Error(`bundled package ${pkg.name}@${pkg.version} has no license file in ${pkg.root}; refusing metadata placeholder`);
      }
    } else {
      for (const licenseFile of licenseFiles) {
        sections.push((await readFile(licenseFile, 'utf8')).trim());
      }
    }
  }
  if (includedBundleInputs(metafile, outfile, absWorkingDir).some(
    (input) => normalizeToAbsolute(absWorkingDir, input) === path.join(ROOT, 'host-core', 'third-party', 'pi-skills.js')
  )) {
    sections.push('# Pi managed Skill adaptation (MIT; v1.3.0)');
    sections.push((await readFile(path.join(ROOT, 'licenses', 'pi-v1.3.0-MIT.txt'), 'utf8')).trim());
  }
  for (const notice of toolNotices) {
    sections.push(`# ${notice.title}`);
    sections.push(notice.text.trim());
  }
  const licenseText = sections.join('\n\n---\n\n') + '\n';
  await writeFile(path.join(OUT_DIR, 'third-party-licenses.txt'), licenseText, 'utf8');
  files.set('third-party-licenses.txt', { path: 'third-party-licenses.txt' });

  const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const entries = [];
  for (const file of sorted) {
    entries.push({ path: file.path, sha256: await sha256File(path.join(OUT_DIR, ...file.path.split('/'))) });
  }
  const digestInput = entries.map((e) => `${e.path}\0${e.sha256}\n`).join('');
  const manifest = { version: 1, sha256: sha256Buffer(Buffer.from(digestInput, 'utf8')), files: entries };
  await writeFile(path.join(OUT_DIR, 'payload.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

async function loadToolNotices() {
  const notices = [];
  for (const name of ['rg', 'fd']) {
    const file = path.join(TOOL_CACHE, 'licenses', `${name}-LICENSE-MIT.txt`);
    const text = await readIfPresent(file);
    if (text) {
      notices.push({ title: `${name} ${name === 'rg' ? '15.1.0' : '10.3.0'} (MIT)`, text: text.toString('utf8') });
    } else {
      throw new Error(`tool license cache missing for ${name}; run prepare-android-tools.js first`);
    }
  }
  return notices;
}

// Verify the actually installed host-core dependencies before bundling so the
// build never silently picks legacy/root node_modules. Read the installed
// package.json directly at HERE/node_modules/<name> (scoped names join
// correctly); do NOT use require.resolve — some dependencies (e.g. chord) are
// ESM/import-only without an exports main that resolve() can load. esbuild
// remains responsible for actual bundle resolution.
async function assertInstalledHostDependencies() {
  const hostPkg = JSON.parse(await readFile(path.join(HERE, 'package.json'), 'utf8'));
  const hostCoreNodeModules = path.join(HERE, 'node_modules');
  const deps = hostPkg.dependencies ?? {};
  for (const [name, expected] of Object.entries(deps)) {
    const pkgPath = path.join(hostCoreNodeModules, name, 'package.json');
    const raw = await readIfPresent(pkgPath);
    if (!raw) {
      throw new Error(`host-core dependency ${name} is not installed at ${pkgPath}; run installHostDependencies first`);
    }
    let pkg;
    try {
      pkg = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw new Error(`host-core dependency ${name} package.json is invalid: ${err.message}`);
    }
    if (pkg.name !== name) {
      throw new Error(`host-core dependency directory ${name} contains package named ${pkg.name ?? 'unknown'}`);
    }
    // file: deps pin a tarball path, not a semver. For the six pinned
    // @earendil-works packages the installed package.json version must equal
    // the deterministic PI_MAIN_VERSION; every other dependency keeps the
    // strict name+version match below.
    if (expected.startsWith('file:')) {
      if (pkg.version !== PI_MAIN_VERSION) {
        throw new Error(`host-core dependency ${name} installed version ${pkg.version ?? 'unknown'} does not match pinned ${PI_MAIN_VERSION}`);
      }
    } else if (pkg.version !== expected) {
      throw new Error(`host-core dependency ${name} installed version ${pkg.version ?? 'unknown'} does not match pinned ${expected}`);
    }
  }
}

async function main() {
  const requireRoot = createRequire(pathToFileURL(path.join(ROOT, 'package.json')).href);
  let esbuild;
  try {
    esbuild = requireRoot('esbuild');
  } catch (err) {
    throw new Error('esbuild not found in root node_modules; run npm ci first: ' + err.message);
  }
  const entry = path.join(HERE, 'android-runtime.js');
  await access(entry); // sibling lane supplies this entry; missing is a hard error
  await assertInstalledHostDependencies();
  await mkdir(OUT_DIR, { recursive: true });
  // Legacy metafile copied into the assets sourceSet is not part of the payload;
  // remove only that build graph file, never runtime/state.
  await rm(path.join(OUT_DIR, 'esbuild-metafile.json'), { force: true });
  const outfile = path.join(OUT_DIR, 'host-runtime.mjs');
  const metafilePath = path.join(METAFILE_DIR, 'esbuild-metafile.json');
  await mkdir(METAFILE_DIR, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    absWorkingDir: ROOT,
    // Only Node builtins and truly optional ws addons stay external; there is
    // no runtime node_modules in the APK payload.
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: 'import { createRequire as __bundleRequire } from "node:module"; import { fileURLToPath as __bundlePath } from "node:url"; import { dirname as __bundleDir } from "node:path"; const require = __bundleRequire(import.meta.url); const __filename = __bundlePath(import.meta.url); const __dirname = __bundleDir(__filename);'
    },
    metafile: true,
    outfile,
    logLevel: 'info',
  });
  const centerDir = path.join(ROOT, 'center-server') + path.sep;
  if (includedBundleInputs(result.metafile, outfile, ROOT).some((input) => normalizeToAbsolute(ROOT, input).startsWith(centerDir))) {
    throw new Error('center-server code or dependencies cannot be bundled into the Android Host');
  }
  await writeFile(metafilePath, JSON.stringify(result.metafile, null, 2), 'utf8');
  await assertNoRequiredDynamicAssets(result.metafile, outfile, ROOT);
  const toolNotices = await loadToolNotices();
  const manifest = await writePayloadFiles(result.metafile, outfile, ROOT, toolNotices);
  process.stdout.write(JSON.stringify({ done: true, outDir: OUT_DIR, payload: manifest }) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ error: { code: err?.code ?? 'INTERNAL', message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
