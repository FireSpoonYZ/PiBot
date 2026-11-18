#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const version = process.argv[2];
const versionCode = Number(process.argv[3]);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !Number.isSafeInteger(versionCode) || versionCode < 1) {
  throw new Error('Usage: node scripts/set-release-version.mjs <version> <Android versionCode>');
}
for (const file of ['package.json', 'desktop/src-tauri/tauri.conf.json', 'mobile/src-tauri/tauri.conf.json']) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  value.version = version;
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = lock.packages[''].version = version;
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
for (const dir of ['desktop/src-tauri', 'desktop/host-launcher', 'mobile/src-tauri']) {
  const toml = readFileSync(dir + '/Cargo.toml', 'utf8');
  const name = toml.match(/^name = "([^"]+)"/m)[1];
  writeFileSync(dir + '/Cargo.toml', toml.replace(/^version = "[^"]+"/m, 'version = "' + version + '"'));
  const file = dir + '/Cargo.lock';
  const previous = readFileSync(file, 'utf8');
  writeFileSync(file, previous.replace(new RegExp('(name = "' + name + '"\\r?\\nversion = ")[^"]+'), '$1' + version));
}
writeFileSync('gradle.properties', readFileSync('gradle.properties', 'utf8').replace(/^android.versionCode=\d+/m, 'android.versionCode=' + versionCode));
console.log('Product version ' + version + ', Android versionCode ' + versionCode);
