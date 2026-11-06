import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRelayRegistry } from '../host-core/relay-registry.js';

const credentialId = 'center-internal-relay-client';
export function openHostBridge({ dataRoot, store, relay }) {
  const registry = openRelayRegistry({ dataRoot });
  const path = join(dataRoot, 'center-relay-client.json');
  let deviceId;
  try {
    try { deviceId = JSON.parse(readFileSync(path, 'utf8')).deviceId; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      deviceId = `center-${randomUUID()}`;
      writeFileSync(path, JSON.stringify({ deviceId }), { flag: 'wx', mode: 0o600 });
    }
    let credential = store.getCredential(credentialId);
    if (!credential) credential = store.putCredential(credentialId, { value: randomBytes(32).toString('base64url'), expectedRevision: null });
    const token = store.resolveCredential(credentialId);
    registry.register({ deviceId, token });
    return {
      deviceId,
      registry,
      listDevices() {
        const online = new Set(relay.getStatus().onlineDeviceIds);
        return registry.list().filter(d => d.deviceId !== deviceId && d.revokedAt === null).map(d => ({ deviceId: d.deviceId, name: d.displayName || d.deviceId, online: online.has(d.deviceId) }));
      },
      // In-process relay client call: reuses the relay's control route table,
      // method whitelist, target identity, call limits and timeouts — no
      // second WebSocket to the public link URL and no relaxed permissions.
      async call(target, method, params) {
        if (!relay.getStatus().onlineDeviceIds.includes(target)) throw Object.assign(new Error('Device offline'), { code: 'DEVICE_OFFLINE' });
        return relay.call(deviceId, target, method, params);
      },
      close() { registry.close(); },
    };
  } catch (error) { registry.close(); throw error; }
}
