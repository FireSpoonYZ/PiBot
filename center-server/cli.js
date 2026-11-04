import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openCenterServer } from './server.js';

async function main() {
  if (process.argv[2] === 'password-hash') {
    let password = '';
    for await (const chunk of process.stdin) password += chunk;
    password = password.replace(/\r?\n$/, '');
    if (!password) throw new Error('Password must not be empty');
    const salt = randomBytes(16);
    process.stdout.write(`scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}\n`);
    return;
  }
  if (process.argv.length !== 2) throw new Error('Unknown command');
  const env = process.env;
  function key(name) {
    if (!/^[0-9a-f]{64}$/i.test(env[name] || '')) throw new Error(`${name} must be 32 bytes in hex`);
    return Buffer.from(env[name], 'hex');
  }
  const https = { cert: readFileSync(env.CENTER_TLS_CERT_FILE, 'utf8'), key: readFileSync(env.CENTER_TLS_KEY_FILE, 'utf8') };
  if (!env.CENTER_LINK_URL || !env.CENTER_PUBLIC_URL) throw new Error('CENTER_LINK_URL and CENTER_PUBLIC_URL are required');
  const server = await openCenterServer({
    dataRoot: env.CENTER_DATA_ROOT || '/data', encryptionKey: key('CENTER_ENCRYPTION_KEY_HEX'), sessionKey: key('CENTER_SESSION_KEY_HEX'), ownerPasswordHash: env.CENTER_OWNER_PASSWORD_HASH,
    https, publicUrl: env.CENTER_PUBLIC_URL, listenHost: env.CENTER_LISTEN_HOST || '0.0.0.0', port: Number(env.CENTER_PORT || 8443), webRoot: env.CENTER_WEB_ROOT || '/app/center-web/dist', npmPath: env.CENTER_NPM_PATH,
    relay: { listenHost: env.CENTER_LISTEN_HOST || '0.0.0.0', port: Number(env.CENTER_RELAY_PORT || 8790), tls: https, linkUrl: env.CENTER_LINK_URL },
  });
  process.stdout.write(`Center listening at ${env.CENTER_PUBLIC_URL}\n`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(() => { process.stderr.write('Center startup failed\n'); process.exitCode = 1; });
