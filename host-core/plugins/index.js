import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Load the entry of an activated native package, never an arbitrary host path. */
export async function loadNativePlugin({ installationId, version, entry, packageRoot, dataDir, host }) {
  const root = await realpath(packageRoot);
  const file = await realpath(resolve(root, entry));
  const withinRoot = relative(root, file);
  if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..' + sep) || isAbsolute(withinRoot)) {
    throw Object.assign(new Error('native plugin entry must be inside its package'), { code: 'INVALID_ARGUMENT' });
  }
  const module = await import(pathToFileURL(file).href);
  if (typeof module.createPlugin !== 'function') {
    throw Object.assign(new Error('native plugin entry must export createPlugin'), { code: 'INVALID_ARGUMENT' });
  }
  const plugin = await module.createPlugin({ installationId, version, packageRoot: root, dataDir, host });
  if (typeof plugin?.forBot !== 'function' || typeof plugin?.close !== 'function') {
    throw Object.assign(new Error('native plugin must provide forBot and close'), { code: 'INVALID_ARGUMENT' });
  }
  return plugin;
}
