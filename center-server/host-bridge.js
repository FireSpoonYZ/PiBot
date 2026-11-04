import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRelayRegistry } from '../host-core/relay-registry.js';
import { openRemoteControl } from '../host-core/remote-control-client.js';

const credentialId = 'center-internal-relay-client';
export function openHostBridge({ dataRoot, store, linkUrl, ca, relay }) {
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
      async call(target, method, params) {
        if (!relay.getStatus().onlineDeviceIds.includes(target)) throw Object.assign(new Error('Device offline'), { code: 'DEVICE_OFFLINE' });
        const client = await openRemoteControl({ deviceId, token, url: linkUrl, ca });
        try { return await client.call(target, method, params); }
        finally { await client.close(); }
      },
      close() { registry.close(); },
    };
  } catch (error) { registry.close(); throw error; }
}
