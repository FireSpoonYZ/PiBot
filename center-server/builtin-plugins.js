import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function initializeBuiltinPlugins({ dataRoot, store, packages }) {
  const directory = fileURLToPath(new URL('../build/builtin-plugins/', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const receiptFile = path.join(dataRoot, 'builtin-plugins.json');
  const initialized = await readFile(receiptFile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  async function complete(accepted) {
    await packages.idle();
    const operation = store.getOperation(accepted.operationId);
    if (operation.phase === 'failed') throw new Error('Built-in plugin initialization failed: ' + operation.installationId);
    return operation;
  }
  for (const item of manifest) {
    if (initialized[item.id]) continue;
    let installation = store.listInstallations().find(value => value.packageId === item.id && value.target === 'host');
    if (!installation) {
      const artifact = await packages.uploadArtifact([await readFile(path.join(directory, item.file))]);
      const operation = await complete(await packages.install({
        requestId: randomUUID(), kind: 'plugin', target: 'host',
        displayName: item.displayName, source: { type: 'artifact', artifactRef: artifact.artifactRef },
      }));
      installation = store.getInstallation(operation.installationId);
      if (item.enabled) await complete(await packages.enable(installation.installationId, { requestId: randomUUID() }));
    }
    // User choices, including uninstalling a bundled plugin, survive restarts.
    initialized[item.id] = item.version;
    await writeFile(receiptFile + '.tmp', JSON.stringify(initialized) + '\n', { mode: 0o600 });
    await rename(receiptFile + '.tmp', receiptFile);
  }
  // Bots that already existed when a new default capability (e.g. vault) shipped never ran initializeBotDefaults for it; the backfill is idempotent and keeps explicit disables.
  store.backfillDefaultBindings();
}
