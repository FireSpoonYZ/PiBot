#!/usr/bin/env node
// scripts/release-check.mjs — verify the single product version is consistent
// across every file that carries it, before a release tag is cut or artifacts
// are published. Exits non-zero on any mismatch or missing value.
//
//   node scripts/release-check.mjs            # check only
//   node scripts/release-check.mjs --json     # machine-readable result
//   node scripts/release-check.mjs --tag v1.1.0   # also verify tag matches version
//
// Android versionCode is an independent monotonic counter (gradle.properties
// android.versionCode or -P); it must be a positive integer and is reported,
// not compared to the product version.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const readText = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const PRODUCT_VERSION = readJson('package.json').version;
if (typeof PRODUCT_VERSION !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(PRODUCT_VERSION)) {
  console.error('root package.json version is not a valid semver: ' + PRODUCT_VERSION);
  process.exit(1);
}

const checks = [];
const check = (file, actual) => {
  checks.push({ file, expected: PRODUCT_VERSION, actual, ok: actual === PRODUCT_VERSION });
};
const cargoVersion = (rel) => {
  const m = readText(rel).match(/^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : undefined;
};

// Tauri configs carry a literal version (Tauri does not read package.json).
for (const rel of ['desktop/src-tauri/tauri.conf.json', 'mobile/src-tauri/tauri.conf.json']) {
  check(rel, readJson(rel).version);
}

// Every product Rust crate version must equal the product version — including
// crates owned by other lanes; this script only reads them, it does not edit.
for (const rel of [
  'desktop/src-tauri/Cargo.toml',
  'desktop/host-launcher/Cargo.toml',
  'mobile/src-tauri/Cargo.toml',
]) {
  check(rel, cargoVersion(rel));
}

// Android versionCode must be a positive integer (explicit monotonic counter).
const gradleProps = readText('gradle.properties');
const vcMatch = gradleProps.match(/^android\.versionCode\s*=\s*(\d+)\s*$/m);
const versionCode = vcMatch ? Number(vcMatch[1]) : NaN;
const versionCodeOk = Number.isInteger(versionCode) && versionCode > 0;
checks.push({
  file: 'gradle.properties android.versionCode',
  expected: 'positive integer',
  actual: vcMatch ? versionCode : '(missing)',
  ok: versionCodeOk,
});

// Optional: --tag vX.Y.Z must equal the product version (v-prefix allowed).
const tagIdx = process.argv.indexOf('--tag');
let tagCheck = null;
if (tagIdx !== -1) {
  const tag = process.argv[tagIdx + 1];
  const tagVersion = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : tag;
  tagCheck = { tag, expected: PRODUCT_VERSION, actual: tagVersion, ok: tagVersion === PRODUCT_VERSION };
  checks.push({ file: 'release tag', expected: PRODUCT_VERSION, actual: tagVersion, ok: tagCheck.ok });
}

const failed = checks.filter((c) => !c.ok);
const result = { productVersion: PRODUCT_VERSION, versionCode: versionCodeOk ? versionCode : null, checks, ok: failed.length === 0 };

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  for (const c of checks) {
    process.stdout.write((c.ok ? 'ok  ' : 'FAIL') + ' ' + c.file + ': ' + (c.actual ?? '(missing)') + ' (expected ' + c.expected + ')\n');
  }
  if (failed.length) {
    process.stderr.write('\n' + failed.length + ' check(s) failed; product version is ' + PRODUCT_VERSION + '\n');
  }
}
process.exit(failed.length ? 1 : 0);
