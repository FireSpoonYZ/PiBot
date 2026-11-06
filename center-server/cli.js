import { randomBytes, scryptSync } from 'node:crypto';
import { openCenterServer } from './server.js';

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  return value;
}

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
  // Plain HTTP only: TLS terminates at the user's reverse proxy. The public
  // WSS link URL is derived from CENTER_PUBLIC_URL inside openCenterServer.
  const server = await openCenterServer({
    dataRoot: env.CENTER_DATA_ROOT || '/data', encryptionKey: key('CENTER_ENCRYPTION_KEY_HEX'), sessionKey: key('CENTER_SESSION_KEY_HEX'), ownerPasswordHash: env.CENTER_OWNER_PASSWORD_HASH,
    publicUrl: env.CENTER_PUBLIC_URL, listenHost: env.CENTER_LISTEN_HOST || '0.0.0.0', port: Number(env.CENTER_PORT || 8080), trustProxy: parseTrustProxy(env.CENTER_TRUST_PROXY),
    webRoot: env.CENTER_WEB_ROOT || '/app/center-web/dist', npmPath: env.CENTER_NPM_PATH,
  });
  process.stdout.write(`Center listening at ${env.CENTER_PUBLIC_URL}\n`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(() => { process.stderr.write('Center startup failed\n'); process.exitCode = 1; });
