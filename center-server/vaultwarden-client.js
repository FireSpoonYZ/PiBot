// center-server/vaultwarden-client.js
// Adapter around the pinned official Bitwarden CLI (@bitwarden/cli@2026.10.1,
// statically verified at tag cli-v2026.10.1). bw serve exposes GET /status,
// POST /unlock {password}, POST /lock, POST /sync, GET /list/object/items and
// GET /object/item/:id — but no login/logout/config routes, so account
// operations run as short-lived child processes.
//
// Secret channels, never argv/env/files/logs: client_id/client_secret enter
// 'bw login --apikey' through its own stdin prompts (written to stderr; each
// fed exactly once), the master password enters bw serve as the POST /unlock
// JSON body, and no BW_SESSION is ever set — the unlocked key lives only in
// the serve process and dies with it. Child env is a whitelist (PATH, HOME,
// NODE_EXTRA_CA_CERTS for deploy-managed private CAs); no BW_* variable is
// ever inherited.
//
// The CLI still writes its own plaintext data.json (it contains the API
// clientSecret and token state), so its BITWARDENCLI_APPDATA_DIR is a random
// private 0700 directory under /dev/shm — tmpfs, memory only, wiped on close
// and gone with the container. The only thing persisted is that single
// data.json, re-encrypted here with the Center encryption key (AES-256-GCM,
// dedicated AAD, fresh nonce, atomic 0600 write) into
// <dataRoot>/bw-state.json after every state-changing command. The prompt
// texts, the 'fd+listening://3' scheme and the response envelope are coupled
// to this pinned version; upgrading @bitwarden/cli requires re-verifying
// them in its source. Linux-only: no /dev/shm means VAULT_UNSUPPORTED,
// never a silent fallback to a persistent temp dir.

import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';

const SERVE_HOST = '127.0.0.1';
const SERVE_PORT = 18087;
const CHILD_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 180_000; // login performs a full vault sync
const SERVE_READY_TIMEOUT_MS = 15_000;
const SERVE_PROBE_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CHILD_OUTPUT = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LOGIN_CIPHER_TYPE = 1;
const CONTROL_CHARS = /[\r\n\0]/;
const SHM_ROOT = '/dev/shm';
const SHM_PREFIX = 'pibot-bw-';
const STATE_FILE = 'bw-state.json';
const STATE_AAD = 'pibot-center/vaultwarden-cli-state/v1';
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const LEGACY_CLI_DIR = 'bw-cli';
const TMPFS_MAGIC = 0x01021994;

function vaultError(code, message) {
  return Object.assign(new Error(message), { code });
}

function boundedString(value, name, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw vaultError('VAULT_INVALID_ARGUMENT', name + ' must be a string of at most ' + max + ' characters');
  }
  return value;
}

/* stdin-fed values must never smuggle extra prompt answers or sequences. */
function secretLine(value, name) {
  boundedString(value, name, 1024);
  if (CONTROL_CHARS.test(value)) {
    throw vaultError('VAULT_INVALID_ARGUMENT', name + ' must not contain CR, LF or NUL');
  }
  return value;
}

/** Maps verified bw CLI/serve failure text to fixed codes; raw upstream
 *  messages are never propagated. */
function classifyUpstream(message) {
  const text = String(message || '');
  if (/not logged in|no active account|already logged in/i.test(text)) return 'VAULT_NEEDS_LOGIN';
  if (/vault is locked/i.test(text)) return 'VAULT_LOCKED';
  // 'Cryptography error, The decryption operation failed' is the observed
  // 2026.10.1 /unlock response for a wrong master password.
  if (/invalid master password|cryptography error|decryption operation failed/i.test(text)) return 'VAULT_UNLOCK_FAILED';
  if (/not found/i.test(text)) return 'VAULT_NOT_FOUND';
  return 'VAULT_UNAVAILABLE';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function openVaultwardenClient({ dataRoot, encryptionKey }) {
  if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) {
    throw new Error('A 32-byte vaultwarden state encryption key is required');
  }
  // Private copy: the caller's key is shared Center state and is never
  // mutated; close() zeroes only this copy.
  const stateKey = Buffer.alloc(encryptionKey.byteLength);
  stateKey.set(encryptionKey);
  // Once closed, the client must never resurrect a process, request or write.
  let closed = false;
  // The CLI's plaintext working state must live on tmpfs only. This adapter
  // targets the Linux center container where /dev/shm is a tmpfs mount by
  // default; there is deliberately no fallback to a persistent temp dir.
  let shmIsTmpfs = false;
  try {
    shmIsTmpfs = process.platform === 'linux' && statfsSync(SHM_ROOT).type === TMPFS_MAGIC && statSync(SHM_ROOT).isDirectory();
  } catch {
    shmIsTmpfs = false;
  }
  if (!shmIsTmpfs) {
    throw vaultError('VAULT_UNSUPPORTED', 'vaultwarden client requires a tmpfs /dev/shm');
  }
  const cliDataDir = mkdtempSync(join(SHM_ROOT, SHM_PREFIX));
  // The caller's vault subdirectory may not exist yet on first use.
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const statePath = join(dataRoot, STATE_FILE);

  /** AES-256-GCM envelope for the CLI data.json bytes, dedicated AAD. */
  function encryptState(plaintext) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', stateKey, nonce);
    cipher.setAAD(Buffer.from(STATE_AAD));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({ version: 1, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }) + '\n';
  }

  function decryptState(bytes) {
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { throw vaultError('VAULT_UNAVAILABLE', 'persisted vault state is unreadable'); }
    if (!isRecord(record) || record.version !== 1
      || typeof record.nonce !== 'string' || typeof record.tag !== 'string' || typeof record.ciphertext !== 'string') {
      throw vaultError('VAULT_UNAVAILABLE', 'persisted vault state is unreadable');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', stateKey, Buffer.from(record.nonce, 'base64url'));
      decipher.setAAD(Buffer.from(STATE_AAD));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]);
    } catch {
      throw vaultError('VAULT_UNAVAILABLE', 'persisted vault state is unreadable');
    }
  }

  /* Atomic private write: a crashed save leaves the previous ciphertext
   * intact; success is only reported after rename lands. */
  function writeStateFile(plaintext) {
    const tmp = statePath + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeFileSync(fd, encryptState(plaintext));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, statePath);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw vaultError('VAULT_UNAVAILABLE', 'could not persist vault state');
    }
    try {
      const dir = openSync(dataRoot, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* directory fsync is best-effort */ }
  }

  /* Snapshot the CLI data.json after a state-changing command. A file the
   * CLI is mid-writing can read torn; empty files (fresh lowdb) are valid,
   * and a non-JSON read is retried briefly before failing fixed. The read
   * buffer is zeroed when done — the live copy stays in shm. */
  async function saveCliState() {
    const dataFile = join(cliDataDir, 'data.json');
    if (!existsSync(dataFile)) return;
    let plaintext;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          plaintext = readFileSync(dataFile);
        } catch {
          throw vaultError('VAULT_UNAVAILABLE', 'could not read CLI state');
        }
        if (plaintext.byteLength === 0) break;
        try {
          JSON.parse(plaintext.toString('utf8'));
          break;
        } catch {
          if (attempt >= 5) throw vaultError('VAULT_UNAVAILABLE', 'CLI state file is unreadable');
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      if (plaintext.byteLength > MAX_STATE_BYTES) {
        throw vaultError('VAULT_UNAVAILABLE', 'CLI state exceeds the persisted size limit');
      }
      // A close() racing this save must not persist ciphertext made with a
      // zeroed key.
      assertOpen();
      writeStateFile(plaintext);
    } finally {
      plaintext?.fill(0);
    }
  }

  /* Restore the encrypted copy, or migrate the pre-shm layout once: the
   * legacy plaintext is only deleted after it has been encrypted or proven
   * to hold no state, and only the dedicated bw-cli directory is touched.
   * Restored bytes must be valid CLI JSON — an empty or corrupt file must
   * never be reported as a successful restore. Any failure cleans the
   * fresh shm dir and leaves the legacy file in place. */
  const legacyDir = join(dataRoot, LEGACY_CLI_DIR);
  const legacyFile = join(legacyDir, 'data.json');
  let restored = null;
  try {
    if (existsSync(statePath)) {
      try {
        restored = decryptState(readFileSync(statePath));
      } catch (error) {
        if (error?.code) throw error;
        throw vaultError('VAULT_UNAVAILABLE', 'persisted vault state is unreadable');
      }
      if (restored.byteLength === 0) {
        restored = null; // an empty snapshot carries no state at all
      } else {
        try {
          JSON.parse(restored.toString('utf8'));
        } catch {
          throw vaultError('VAULT_UNAVAILABLE', 'persisted vault state is unreadable');
        }
      }
    } else if (existsSync(legacyFile)) {
      let legacy;
      try {
        legacy = readFileSync(legacyFile);
      } catch {
        throw vaultError('VAULT_UNAVAILABLE', 'could not read legacy CLI state');
      }
      if (legacy.byteLength > MAX_STATE_BYTES) {
        throw vaultError('VAULT_UNAVAILABLE', 'legacy CLI state exceeds the persisted size limit');
      }
      if (legacy.byteLength > 0) {
        try {
          JSON.parse(legacy.toString('utf8'));
        } catch {
          throw vaultError('VAULT_UNAVAILABLE', 'legacy CLI state is unreadable');
        }
        writeStateFile(legacy); // encrypt before any plaintext is removed
        restored = legacy;
      }
    }
    if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true, force: true });
  } catch (error) {
    try { rmSync(cliDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
  if (restored !== null) {
    try {
      writeFileSync(join(cliDataDir, 'data.json'), restored, { mode: 0o600 });
    } finally {
      restored.fill(0);
    }
  }
  // Best-effort cleanup if the process exits without close(); named so a
  // successful close() can unregister it and reopens accumulate nothing.
  const sweepInMemoryState = () => { try { rmSync(cliDataDir, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once('exit', sweepInMemoryState);

  // Deploy-time override only; a .js path is launched through this Node so a
  // packaged binary is equally usable when pointed at an executable entry.
  const bwPath = process.env.PIBOT_BW_CLI || 'bw';
  if (process.env.PIBOT_BW_CLI !== undefined && !isAbsolute(bwPath)) {
    throw new Error('PIBOT_BW_CLI must be an absolute path');
  }
  const bwScript = bwPath.endsWith('.js');
  const closeSignal = new AbortController();
  // Every running child (serve, login, one-shot commands) so close() can
  // cancel sensitive in-flight work immediately instead of queueing behind it.
  const children = new Set();

  function assertOpen() {
    if (closed) throw vaultError('VAULT_UNAVAILABLE', 'vaultwarden client is closed');
  }

  // Minimal whitelist environment: nothing else is inherited, so no BW_*
  // variable (BW_CLIENTID/BW_CLIENTSECRET/BW_SESSION/…) can leak a secret
  // into a child. NODE_EXTRA_CA_CERTS is the documented, deploy-managed way
  // to trust a private CA for the CLI's own outbound HTTPS calls; TLS
  // verification itself is never weakened. BW_NOINTERACTION is set for
  // everything except 'bw login', whose stdin prompts are the private
  // credential channel.
  function cliEnv(interactive) {
    const env = {
      PATH: process.env.PATH,
      BITWARDENCLI_APPDATA_DIR: cliDataDir,
    };
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (process.env.NODE_EXTRA_CA_CERTS !== undefined) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    if (!interactive) env.BW_NOINTERACTION = 'true';
    return env;
  }

  function spawnArgs(args) {
    return bwScript ? [process.execPath, bwPath, ...args] : [bwPath, ...args];
  }

  function track(child) {
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  }

  function killChild(child) {
    try { child.stdin?.end(); } catch { /* not writable */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Short-lived CLI invocation. Output is bounded and never surfaced. */
  function runCli(args, timeoutMs = CHILD_TIMEOUT_MS) {
    assertOpen();
    return new Promise((resolve, reject) => {
      const [command, ...rest] = spawnArgs(args);
      const child = track(spawn(command, rest, { env: cliEnv(false), stdio: ['ignore', 'pipe', 'pipe'] }));
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const captured = stdout;
        stdout = stderr = '';
        if (error) reject(error);
        else resolve({ stdout: captured });
      };
      const timer = setTimeout(() => {
        killChild(child);
        finish(vaultError('VAULT_UNAVAILABLE', 'bw command timed out'));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { if (stdout.length < MAX_CHILD_OUTPUT) stdout += chunk; });
      child.stderr.on('data', (chunk) => { if (stderr.length < MAX_CHILD_OUTPUT) stderr += chunk; });
      child.on('error', () => finish(vaultError('VAULT_UNAVAILABLE', 'bw command failed to start')));
      child.on('close', (code) => {
        if (code === 0) finish();
        else finish(vaultError(classifyUpstream(stdout + '\n' + stderr), 'bw command failed'));
      });
    });
  }

  /* 'bw login --apikey' with credentials written only to its stdin prompts.
   * Each prompt is answered exactly once; on timeout, failure or early exit
   * the stdin pipe is closed and the process is terminated. */
  function runLogin(clientId, clientSecret) {
    assertOpen();
    return new Promise((resolve, reject) => {
      const [command, ...rest] = spawnArgs(['login', '--apikey']);
      const child = track(spawn(command, rest, { env: cliEnv(true), stdio: ['pipe', 'pipe', 'pipe'] }));
      let stderr = '';
      let stdout = '';
      let sentId = false;
      let sentSecret = false;
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* already closed */ }
        stdout = stderr = '';
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        killChild(child);
        finish(vaultError('VAULT_UNAVAILABLE', 'bw login timed out'));
      }, LOGIN_TIMEOUT_MS);
      // EPIPE arrives asynchronously when the child dies mid-prompt; the
      // close event settles the promise, so the stream error is swallowed.
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk) => { if (stdout.length < MAX_CHILD_OUTPUT) stdout += chunk; });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_CHILD_OUTPUT) stderr += chunk;
        // Prompt texts verified in login.command.ts: "client_id:" then
        // "client_secret:", written to stderr. Sequential writes keep each
        // line on its own prompt; a pre-buffered write could drop the
        // second line, and a repeated write could smuggle it into a later
        // prompt, so each is sent exactly once.
        if (!sentId && stderr.includes('client_id:')) {
          sentId = true;
          try { child.stdin.write(clientId + '\n'); } catch { /* child gone */ }
        }
        if (sentId && !sentSecret && stderr.includes('client_secret:')) {
          sentSecret = true;
          try {
            child.stdin.write(clientSecret + '\n');
            child.stdin.end();
          } catch { /* child gone */ }
        }
      });
      child.on('error', () => finish(vaultError('VAULT_UNAVAILABLE', 'bw login failed to start')));
      child.on('close', (code) => {
        if (code === 0) finish();
        else {
          const classified = classifyUpstream(stdout + '\n' + stderr);
          finish(vaultError(classified === 'VAULT_UNAVAILABLE' ? 'VAULT_NEEDS_LOGIN' : classified, 'bw login failed'));
        }
      });
    });
  }

  let serveChild = null;
  let serveOutput = '';

  function serveRunning() {
    return serveChild !== null && serveChild.exitCode === null && serveChild.signalCode === null;
  }

  async function requestServe(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    assertOpen();
    let response;
    try {
      response = await fetch('http://' + SERVE_HOST + ':' + SERVE_PORT + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Never follow redirects: a redirect could carry the unlock body to
        // a different endpoint.
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), closeSignal.signal]),
      });
    } catch {
      throw closed
        ? vaultError('VAULT_UNAVAILABLE', 'vaultwarden client is closed')
        : vaultError('VAULT_CONNECTION_FAILED', 'bw serve is unreachable');
    }
    let text;
    try {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch { /* best effort */ }
            throw vaultError('VAULT_UNAVAILABLE', 'bw serve response is too large');
          }
          chunks.push(value);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
      const total = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(total);
    } catch (error) {
      if (error?.code) throw error;
      throw vaultError('VAULT_UNAVAILABLE', 'bw serve response could not be read');
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw vaultError('VAULT_UNAVAILABLE', 'bw serve returned an unreadable response');
    }
    if (!isRecord(json)) throw vaultError('VAULT_UNAVAILABLE', 'bw serve returned a malformed response');
    if (json.success !== true || !response.ok) {
      throw vaultError(classifyUpstream(json.message), 'bw serve request failed');
    }
    return json.data;
  }

  async function ensureServe() {
    if (serveRunning()) return;
    assertOpen();
    // Bind the loopback port in this process first: an occupied port fails
    // here instead of letting requests reach a foreign serve instance.
    const listener = createServer();
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(SERVE_PORT, SERVE_HOST, resolve);
      });
    } catch {
      try { listener.close(); } catch { /* never bound */ }
      throw vaultError('VAULT_UNAVAILABLE', 'bw serve port 127.0.0.1:' + SERVE_PORT + ' is already in use');
    }
    // The child takes over the listening socket through the documented
    // stdio fd sharing (positive integer fd at index 3). Passing the fd
    // integer rather than the Server object is the supported mechanism.
    const fd = listener._handle?.fd;
    if (!Number.isInteger(fd) || fd < 0) {
      try { listener.close(); } catch { /* best effort */ }
      throw vaultError('VAULT_UNAVAILABLE', 'bw serve socket fd is unavailable');
    }
    const [command, ...rest] = spawnArgs(['serve', '--hostname', 'fd+listening://3', '--port', String(SERVE_PORT)]);
    const child = track(spawn(command, rest, { env: cliEnv(false), stdio: ['ignore', 'pipe', 'pipe', fd] }));
    // The parent must not keep a second acceptor on the same socket: the fd
    // is dup'ed into the child at spawn, so our listener is closed now and
    // only the child accepts connections.
    try { listener.close(); } catch { /* best effort */ }
    serveOutput = '';
    child.stdout.on('data', (chunk) => { if (serveOutput.length < MAX_CHILD_OUTPUT) serveOutput += chunk; });
    child.stderr.on('data', (chunk) => { if (serveOutput.length < MAX_CHILD_OUTPUT) serveOutput += chunk; });
    serveChild = child;
    child.on('error', () => { /* 'close' follows and performs the cleanup */ });
    // 'close' also covers spawn-time failures that never reach 'exit'; only
    // clear state that still belongs to this child so a stale death cannot
    // wipe a newer serve process.
    child.on('close', () => {
      if (serveChild === child) serveChild = null;
      serveOutput = '';
    });
    try {
      const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
      for (;;) {
        if (!serveRunning()) {
          const classified = classifyUpstream(serveOutput);
          throw vaultError(classified === 'VAULT_UNAVAILABLE' ? 'VAULT_NEEDS_LOGIN' : classified, 'bw serve failed to start');
        }
        try {
          await requestServe('/status', { timeoutMs: SERVE_PROBE_TIMEOUT_MS });
          if (!serveRunning()) throw vaultError('VAULT_NEEDS_LOGIN', 'bw serve exited during startup');
          return;
        } catch (error) {
          if (error.code === 'VAULT_CONNECTION_FAILED' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // A failed or timed-out start must not leave a half-running serve.
      await stopServe();
      throw error;
    }
  }

  async function stopServe() {
    const child = serveChild;
    serveChild = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('close', resolve));
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (!await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 3_000))])) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
    }
    serveOutput = '';
  }

  /* bw status template from serve, or from the 'bw status' CLI when serve is
   * not running (it works unauthenticated and prints only the template JSON). */
  async function statusTemplate() {
    if (serveRunning()) {
      try {
        const data = await requestServe('/status');
        return isRecord(data?.template) ? data.template : {};
      } catch (error) {
        // Report CLI state when the process died between check and request.
        if (serveRunning()) throw error;
      }
    }
    const { stdout } = await runCli(['status']);
    let template;
    try {
      template = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
    } catch {
      throw vaultError('VAULT_UNAVAILABLE', 'bw status returned an unreadable response');
    }
    return isRecord(template) ? template : {};
  }

  function mapStatus(template) {
    const status = template.status;
    return {
      authenticated: status === 'locked' || status === 'unlocked',
      locked: status !== 'unlocked',
      accountId: typeof template.userId === 'string' && template.userId !== '' ? template.userId : null,
      lastSyncAt: typeof template.lastSync === 'string' && template.lastSync !== '' ? template.lastSync : null,
    };
  }

  const status = async () => mapStatus(await statusTemplate());
  // Every state-changing operation ends by persisting the current CLI
  // data.json before reporting success; a save failure fails the op.
  const finishOp = async () => {
    await saveCliState();
    return status();
  };

  /* 'bw config server' without a value prints the persisted base URL
   * (config.command.ts getOrSetServer returns a StringResponse); the last
   * output line is used so stray diagnostics cannot skew the compare. */
  async function configuredServerUrl() {
    const { stdout } = await runCli(['config', 'server']);
    const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.length === 0 ? '' : lines[lines.length - 1];
  }

  function sameServerUrl(a, b) {
    try {
      return new URL(a).href.replace(/\/+$/, '') === new URL(b).href.replace(/\/+$/, '');
    } catch {
      return false;
    }
  }

  // All operations are serialized: serve process lifecycle, CLI invocations
  // and HTTP calls never interleave with each other. close() cancels
  // in-flight children/requests directly instead of queueing behind them.
  let tail = Promise.resolve();
  function enqueue(operation) {
    const next = tail.then(() => {
      assertOpen();
      return operation();
    });
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    async configure({ serverUrl }) {
      boundedString(serverUrl, 'serverUrl', 2048);
      let parsed;
      try { parsed = new URL(serverUrl); } catch { throw vaultError('VAULT_INVALID_ARGUMENT', 'serverUrl must be a valid URL'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw vaultError('VAULT_INVALID_ARGUMENT', 'serverUrl must be an https URL without credentials');
      }
      return enqueue(async () => {
        // Idempotent for the already-persisted URL: no logout, no restart —
        // callers may invoke this on every startup or adapter ensure.
        if (sameServerUrl(await configuredServerUrl(), parsed.href)) return status();
        const before = await status();
        await stopServe();
        // 'bw config server' refuses while an account is logged in; changing
        // the server always ends any previous account session and its grants.
        if (before.authenticated) await runCli(['logout']);
        await runCli(['config', 'server', parsed.href]);
        return finishOp();
      });
    },

    async login({ clientId, clientSecret }) {
      secretLine(clientId, 'clientId');
      secretLine(clientSecret, 'clientSecret');
      return enqueue(async () => {
        const before = await status();
        await stopServe();
        // 'bw login' exits if already authed; a previous account is dropped
        // first so a different account can replace it.
        if (before.authenticated) await runCli(['logout']);
        await runLogin(clientId, clientSecret);
        await saveCliState();
        await ensureServe();
        return finishOp();
      });
    },

    async unlock({ masterPassword }) {
      boundedString(masterPassword, 'masterPassword', 1024);
      return enqueue(async () => {
        await ensureServe();
        await requestServe('/unlock', { method: 'POST', body: { password: masterPassword } });
        return finishOp();
      });
    },

    async lock() {
      return enqueue(async () => {
        if (serveRunning()) {
          try {
            await requestServe('/lock', { method: 'POST' });
          } catch (error) {
            // A failed lock must still close the decrypted session: stopping
            // the serve process destroys the in-memory key material.
            await stopServe();
            throw error;
          }
        }
        return finishOp();
      });
    },

    async logout() {
      return enqueue(async () => {
        const before = await status();
        await stopServe();
        if (before.authenticated) await runCli(['logout']);
        return finishOp();
      });
    },

    async sync() {
      return enqueue(async () => {
        await ensureServe();
        await requestServe('/sync', { method: 'POST' });
        return finishOp();
      });
    },

    async listItems() {
      return enqueue(async () => {
        await ensureServe();
        const data = await requestServe('/list/object/items');
        if (!isRecord(data) || !Array.isArray(data.data)) {
          throw vaultError('VAULT_UNAVAILABLE', 'bw serve returned a malformed item list');
        }
        // Token refresh during reads can rewrite data.json; snapshot first
        // so a rotated token is persisted rather than lost at close.
        await saveCliState();
        // Only login-type, non-deleted, fillable entries; the raw upstream
        // cipher (including the password field) never leaves this boundary.
        return data.data
          .filter((item) => isRecord(item)
            && item.type === LOGIN_CIPHER_TYPE
            && item.deletedDate == null
            && isRecord(item.login)
            && typeof item.login.password === 'string'
            && item.login.password !== '')
          .map((item) => ({
            itemId: String(item.id),
            label: typeof item.name === 'string' ? item.name : '',
            username: typeof item.login.username === 'string' ? item.login.username : '',
          }));
      });
    },

    async getPassword({ itemId }) {
      boundedString(itemId, 'itemId', 128);
      return enqueue(async () => {
        await ensureServe();
        // GET /object/item/:id returns the CipherResponse as Response.data
        // ({object:'item',type,name,login:{username,password},deletedDate}).
        const item = await requestServe('/object/item/' + encodeURIComponent(itemId));
        if (!isRecord(item) || item.object !== 'item') {
          throw vaultError('VAULT_UNAVAILABLE', 'bw serve returned a malformed item');
        }
        if (item.type !== LOGIN_CIPHER_TYPE
          || item.deletedDate != null
          || !isRecord(item.login)
          || typeof item.login.password !== 'string'
          || item.login.password === '') {
          throw vaultError('VAULT_NOT_FOUND', 'Vault item is not a fillable login entry');
        }
        await saveCliState();
        return item.login.password;
      });
    },

    status,

    async close() {
      if (closed) return;
      closed = true;
      closeSignal.abort();
      // Kill every child this client started — an in-flight login must not
      // linger behind its 180s timeout after the caller asked for close.
      const running = [...children];
      for (const child of running) killChild(child);
      await stopServe();
      // Best-effort settle window for the remaining children.
      await Promise.allSettled(running.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', resolve);
        setTimeout(resolve, 2_000).unref();
      })));
      // Only after every child is dead: remove the in-memory CLI directory.
      try {
        rmSync(cliDataDir, { recursive: true, force: true });
        process.removeListener('exit', sweepInMemoryState);
      } catch {
        throw vaultError('VAULT_UNAVAILABLE', 'could not clear in-memory vault state');
      } finally {
        stateKey.fill(0); // only this adapter's private copy, never the Center's
      }
    },
  };
}
