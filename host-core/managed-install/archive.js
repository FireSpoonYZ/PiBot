import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

export const MAX_ARTIFACT_SIZE = 100 * 1024 * 1024;
const MAX_UNPACKED_SIZE = 512 * 1024 * 1024;

export function digest(bytes) {
  return 'sha256-' + createHash('sha256').update(bytes).digest('base64');
}

// Only regular files and directories are needed by managed packages. Reject links rather
// than letting an archive redirect later writes outside the staging directory.
export async function extractArtifact(bytes, directory) {
  if (bytes.length > MAX_ARTIFACT_SIZE) throw new Error('Artifact exceeds size limit');
  const archive = directory + '.tgz';
  await mkdir(path.dirname(directory), { recursive: true });
  await writeFile(archive, bytes);
  try {
    const entries = [];
    let total = 0;
    await new Promise((resolve, reject) => {
      const stream = createReadStream(archive);
      const parser = tar.list({ strict: true, onReadEntry(entry) {
        const name = entry.path.replace(/\\/g, '/');
        const parts = name.split('/');
        if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.includes('..') || parts.includes('node_modules') ||
            !['File', 'Directory'].includes(entry.type)) {
          parser.abort(new Error('Unsafe archive entry'));
          return;
        }
        total += entry.size;
        if (total > MAX_UNPACKED_SIZE || entries.length >= 10000) {
          parser.abort(new Error('Unpacked artifact exceeds size limit'));
          return;
        }
        if (parts.some((part) => part && part !== '.')) entries.push(name.replace(/^\.\//, ''));
      } });
      parser.once('error', (err) => { stream.destroy(); reject(err); });
      parser.once('end', resolve);
      stream.once('error', reject);
      stream.pipe(parser);
    });
    if (!entries.length) throw new Error('Artifact is empty');
    const strip = entries.length && entries.every((name) => name === 'package' || name.startsWith('package/')) ? 1 : 0;
    await mkdir(directory, { recursive: true });
    await tar.extract({ file: archive, cwd: directory, strip, strict: true, preservePaths: false });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(archive, { force: true });
  }
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function containedPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..')) throw new Error('Invalid package path');
  const result = path.resolve(root, relative);
  if (result !== root && !result.startsWith(root + path.sep)) throw new Error('Invalid package path');
  return result;
}
