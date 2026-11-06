#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runNpm } from '../host-core/managed-install/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../host-core/package.json', import.meta.url));
const tar = require('tar');
const npmPath = path.join(path.dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js');
const output = path.join(root, 'build/builtin-plugins');
await mkdir(output, { recursive: true });
const plugins = [
  ['ask-user-question', '用户问卷', true],
  ['todo', '待办任务', true],
  ['billion-context', 'Billion Context', true],
  ['hindsight', 'Hindsight（需配置服务地址）', false],
  ['webfox', 'Webfox（需配置搜索服务）', false],
];
const manifest = [];
for (const [name, displayName, enabled] of plugins) {
  const stage = path.join(root, 'build/builtin-plugin-source', name);
  await rm(stage, { recursive: true, force: true });
  await cp(path.join(root, 'plugins', name), stage, {
    recursive: true,
    filter: source => !source.split(path.sep).some(part => ['node_modules', 'build', '.git'].includes(part)),
  });
  await runNpm(npmPath, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], stage);
  const capability = JSON.parse(await readFile(path.join(stage, 'capability.json'), 'utf8'));
  const file = name + '.tgz';
  await tar.create({ cwd: stage, file: path.join(output, file), gzip: true, portable: true }, await readdir(stage));
  manifest.push({ id: capability.id, version: capability.version, displayName, enabled, file });
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared ' + manifest.length + ' built-in plugin archives');
